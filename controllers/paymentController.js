const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../config/pgPool');
const { sendETicketEmail } = require('../services/eTicketService');
const NotificationService = require('../services/notificationService');
const {
  initiateCollection,
  getCollectionStatus,
  extractWebhookEvent,
  normalizeStatus,
} = require('../services/paymentGatewayService');

const LOCK_DURATION_MINUTES = Math.min(
  10,
  Math.max(5, Number.parseInt(process.env.SEAT_LOCK_MINUTES || '7', 10) || 7)
);
const VALID_PAYMENT_METHODS = ['mobile_money', 'airtel_money', 'card_payment'];
const BOOKED_TICKET_STATES = ['CONFIRMED', 'CHECKED_IN'];
const SEGMENT_HOLD_STATES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];

let scheduleTableCache = null;
const tableColumnsCache = {};

// ---------------------------------------------------------------------------
// One-time migration: drop schedules FK on payments.schedule_id when the DB
// uses bus_schedules as the primary schedule table.  This runs lazily on the
// first booking request and is safe to run concurrently (idempotent DDL).
// ---------------------------------------------------------------------------
let _paymentsFkMigratePromise = null;

const _runPaymentsScheduleFkMigration = async () => {
  const client = await pool.connect();
  try {
    // Ensure production payment-flow columns exist on legacy databases.
    await client.query(`
      ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS booking_status VARCHAR(32) NOT NULL DEFAULT 'pending_payment',
      ADD COLUMN IF NOT EXISTS provider_name VARCHAR(64),
      ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS provider_status VARCHAR(64),
      ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'RWF',
      ADD COLUMN IF NOT EXISTS seat_lock_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS held_ticket_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS seat_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `).catch(() => {});

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference
      ON payments (provider_reference)
      WHERE provider_reference IS NOT NULL
    `).catch(() => {});

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_booking_status
      ON payments (booking_status)
    `).catch(() => {});

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_expires_at_pending
      ON payments (expires_at)
      WHERE booking_status = 'pending_payment'
    `).catch(() => {});

    // Only migrate when bus_schedules is the active schedule table
    const hasBusSchedules = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'bus_schedules' LIMIT 1`
    );
    if (!hasBusSchedules.rows.length) return; // schedules-based setup, FK is fine

    // Drop any FK that constrains payments.schedule_id → schedules(id)
    const existingFks = await client.query(
      `SELECT tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = rc.unique_constraint_name
       WHERE tc.table_name = 'payments'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND ccu.table_name = 'schedules'`
    );
    for (const row of existingFks.rows) {
      await client.query(
        `ALTER TABLE payments DROP CONSTRAINT IF EXISTS "${row.constraint_name}"`
      );
      console.log(`[paymentController] Dropped FK "${row.constraint_name}" on payments.schedule_id`);
    }

    // Make schedule_id nullable so it can store bus_schedules UUIDs without issues
    await client.query(
      `ALTER TABLE payments ALTER COLUMN schedule_id DROP NOT NULL`
    ).catch(() => {}); // already nullable or column absent — both fine
  } catch (err) {
    console.warn('[paymentController] payments FK migration warning:', err.message);
  } finally {
    client.release();
  }
};

const ensurePaymentsScheduleFk = () => {
  if (!_paymentsFkMigratePromise) {
    _paymentsFkMigratePromise = _runPaymentsScheduleFkMigration();
  }
  return _paymentsFkMigratePromise;
};

const generateUUID = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function replacer(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const buildBookingReference = () => `SAFARITIX_BOOKING_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const buildTicketBookingRef = () => `BK-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const readEnv = (...keys) => {
  for (const key of keys) {
    if (typeof process.env[key] === 'string' && process.env[key].trim()) {
      return process.env[key].trim();
    }
  }
  return '';
};

const shouldAutoConfirmPayment = () => {
  const raw = readEnv('AUTO_CONFIRM_PAYMENTS', 'FORCE_PAYMENT_SUCCESS');
  // Production-safe default: never auto-confirm unless explicitly enabled.
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
};

const normalizePhoneNumber = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('250')) return digits;
  if (digits.startsWith('0')) return `250${digits.slice(1)}`;
  if (digits.length === 9) return `250${digits}`;
  return digits;
};

const isSupportedRwandaMsisdn = (value) => /^2507\d{8}$/.test(String(value || ''));

const toIsoDateString = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const toInt = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
};

const normalizeStopName = (value) => (value || '').toString().trim().toLowerCase();

const getScheduleTableName = async (client) => {
  if (scheduleTableCache) return scheduleTableCache;
  const tableResult = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('bus_schedules', 'schedules')
      ORDER BY CASE WHEN table_name = 'bus_schedules' THEN 0 ELSE 1 END
      LIMIT 1
    `
  );
  scheduleTableCache = tableResult.rows[0]?.table_name || 'schedules';
  return scheduleTableCache;
};

const getTableColumns = async (client, tableName) => {
  if (tableColumnsCache[tableName]) return tableColumnsCache[tableName];
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName]
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  tableColumnsCache[tableName] = columns;
  return columns;
};

const resolvePaymentScheduleId = async (client, rawScheduleId, context = {}) => {
  if (!rawScheduleId) return null;

  // 1. Direct match in schedules (works when payments FK targets schedules)
  const direct = await client.query(
    `
      SELECT id
      FROM schedules
      WHERE id::text = $1::text
      LIMIT 1
    `,
    [rawScheduleId]
  ).catch(() => ({ rows: [] })); // handle if schedules table absent
  if (direct.rows.length > 0) return direct.rows[0].id;

  // 2. Fuzzy match by bus_id + trip_date (bus_schedules.route_id is a RURA integer
  //    stored as text — it won't match schedules.route_id which is a UUID, so we
  //    skip the route filter to avoid false negatives)
  const { busId, tripDate, departureTime } = context;
  const normalizedTripDate = toIsoDateString(tripDate);
  if (busId && normalizedTripDate) {
    const byAttributes = await client.query(
      `
        SELECT id
        FROM schedules
        WHERE bus_id::text = $1::text
          AND COALESCE(schedule_date::date, departure_time::date) = $2::date
        ORDER BY
          CASE
            WHEN $3::text IS NOT NULL AND departure_time::time = $3::time THEN 0
            ELSE 1
          END,
          created_at DESC
        LIMIT 1
      `,
      [busId, normalizedTripDate, departureTime || null]
    ).catch(() => ({ rows: [] }));
    if (byAttributes.rows[0]?.id) return byAttributes.rows[0].id;
  }

  // 3. No schedules row found. After ensurePaymentsScheduleFk() has run, the FK
  //    to schedules is dropped and schedule_id is nullable, so rawScheduleId
  //    (a bus_schedules UUID) can be stored directly.
  return rawScheduleId;
};

const parseJsonArrayField = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const getPaymentBookingStatus = (paymentRow) => {
  if (paymentRow && typeof paymentRow.booking_status === 'string') {
    return paymentRow.booking_status;
  }

  if (paymentRow && paymentRow.status === 'success') return 'paid';
  if (paymentRow && paymentRow.status === 'failed') return 'cancelled';
  return 'pending_payment';
};

const updatePaymentCompat = async (client, paymentId, fields = {}, metaPatch = null) => {
  const paymentColumns = await getTableColumns(client, 'payments');
  const sets = [];
  const params = [paymentId];

  const addSet = (column, value, cast = '') => {
    if (!paymentColumns.has(column) || typeof value === 'undefined') return;
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  addSet('status', fields.status);
  addSet('booking_status', fields.booking_status);
  addSet('provider_status', fields.provider_status);
  addSet('provider_name', fields.provider_name);
  addSet('provider_reference', fields.provider_reference);
  addSet('phone_or_card', fields.phone_or_card);
  addSet('payment_method', fields.payment_method);
  addSet('completed_at', fields.completed_at);
  addSet('failed_at', fields.failed_at);
  addSet('expires_at', fields.expires_at);

  if (metaPatch && paymentColumns.has('meta')) {
    params.push(JSON.stringify(metaPatch));
    sets.push(`meta = COALESCE(meta, '{}'::jsonb) || $${params.length}::jsonb`);
  }

  if (paymentColumns.has('updated_at')) {
    sets.push('updated_at = NOW()');
  }

  if (sets.length === 0) {
    const current = await client.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    return current.rows[0] || null;
  }

  const result = await client.query(
    `
      UPDATE payments
      SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING *
    `,
    params
  );

  return result.rows[0] || null;
};

const getStopsByRoute = async (client, routeId) => {
  try {
    const result = await client.query(
      `
        SELECT id, route_id, stop_name, sequence
        FROM route_stops
        WHERE route_id::text = $1
        ORDER BY sequence ASC
      `,
      [routeId]
    );
    return result.rows;
  } catch (error) {
    if (error && error.code === '42P01') return [];
    throw error;
  }
};

const findStopSequence = (stops, stopName) => {
  const normalized = normalizeStopName(stopName);
  const match = stops.find((item) => normalizeStopName(item.stop_name) === normalized);
  return match ? toInt(match.sequence, -1) : -1;
};

const overlapsSegment = (aFrom, aTo, bFrom, bTo) => aFrom < bTo && bFrom < aTo;

const parseSequence = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
};

const getSegmentFare = async (client, fromStop, toStop, effectiveDate) => {
  const normalizedEffectiveDate = toIsoDateString(effectiveDate);
  const result = await client.query(
    `
      SELECT price
      FROM rura_routes
      WHERE LOWER(TRIM(from_location)) = LOWER(TRIM($1))
        AND LOWER(TRIM(to_location)) = LOWER(TRIM($2))
        AND LOWER(COALESCE(status, 'active')) = 'active'
        AND effective_date <= COALESCE($3::date, CURRENT_DATE)
      ORDER BY effective_date DESC, created_at DESC
      LIMIT 1
    `,
    [fromStop, toStop, normalizedEffectiveDate]
  );

  if (!result.rows.length) return null;
  return Number(result.rows[0].price);
};

const getScheduleOccupancy = async (client, scheduleId, routeStops, fromStop, toStop) => {
  const fromSeq = findStopSequence(routeStops, fromStop);
  const toSeq = findStopSequence(routeStops, toStop);

  if (fromSeq < 0 || toSeq < 0 || fromSeq >= toSeq) {
    return { occupiedSeats: new Set(), fromSeq, toSeq };
  }

  const routeMinSeq = routeStops.length ? toInt(routeStops[0].sequence, 0) : 0;
  const routeMaxSeq = routeStops.length ? toInt(routeStops[routeStops.length - 1].sequence, 0) : 0;
  const ticketsColumns = await getTableColumns(client, 'tickets');
  const hasSequenceColumns = ticketsColumns.has('from_sequence') && ticketsColumns.has('to_sequence');

  if (hasSequenceColumns) {
    const occupied = await client.query(
      `
        SELECT DISTINCT seat_number
        FROM tickets
        WHERE schedule_id::text = $1::text
          AND COALESCE(status::text, 'CONFIRMED') = ANY($2::text[])
          AND from_sequence < $3
          AND to_sequence > $4
      `,
      [scheduleId, SEGMENT_HOLD_STATES, toSeq, fromSeq]
    );

    return {
      occupiedSeats: new Set(occupied.rows.map((row) => String(row.seat_number))),
      fromSeq,
      toSeq,
    };
  }

  const fromSequenceExpr = ticketsColumns.has('from_sequence') ? 'from_sequence' : 'NULL::integer AS from_sequence';
  const toSequenceExpr = ticketsColumns.has('to_sequence') ? 'to_sequence' : 'NULL::integer AS to_sequence';

  const ticketsResult = await client.query(
    `
      SELECT seat_number, from_stop, to_stop, ${fromSequenceExpr}, ${toSequenceExpr}, COALESCE(status::text, 'CONFIRMED') AS status
      FROM tickets
      WHERE schedule_id::text = $1::text
        AND COALESCE(status::text, 'CONFIRMED') = ANY($2::text[])
    `,
    [scheduleId, SEGMENT_HOLD_STATES]
  );

  const occupiedSeats = new Set();
  for (const ticket of ticketsResult.rows) {
    let ticketFrom = parseSequence(ticket.from_sequence);
    let ticketTo = parseSequence(ticket.to_sequence);
    if (ticketFrom === null) ticketFrom = findStopSequence(routeStops, ticket.from_stop);
    if (ticketTo === null) ticketTo = findStopSequence(routeStops, ticket.to_stop);

    if (ticketFrom === null || ticketFrom < 0) ticketFrom = routeMinSeq;
    if (ticketTo === null || ticketTo < 0) ticketTo = routeMaxSeq;
    if (ticketFrom >= ticketTo) continue;

    if (overlapsSegment(fromSeq, toSeq, ticketFrom, ticketTo)) {
      occupiedSeats.add(String(ticket.seat_number));
    }
  }

  return { occupiedSeats, fromSeq, toSeq };
};

const buildCallbackUrl = (req) => {
  const configured = readEnv('PAYMENT_WEBHOOK_URL', 'PUBLIC_BACKEND_URL', 'BACKEND_URL', 'APP_URL');
  if (configured) {
    const normalizedBase = configured
      .trim()
      .replace(/\/\$\d+/g, '')
      .replace(/\$\d+/g, '')
      .replace(/\/$/, '')
      .replace(/\/api$/, '');
    return `${normalizedBase}/api/payments/webhook`;
  }

  const host = req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${host}/api/payments/webhook`;
};

const generateTicketQrDataUrl = async ({ ticket, bookingId, userId, scheduleInfo, seats }) => {
  try {
    // Required QR payload schema:
    // {
    //   bookingId,
    //   userId,
    //   from,
    //   to,
    //   seats,
    //   date,
    //   bus
    // }
    //
    // We also include `ticketId` to keep compatibility with existing
    // ticket validation/scanning logic.
    const payload = {
      bookingId: bookingId || null,
      userId: userId || null,
      from: scheduleInfo?.origin || scheduleInfo?.from || null,
      to: scheduleInfo?.destination || scheduleInfo?.to || null,
      seats: Array.isArray(seats) ? seats.map((s) => String(s)) : [],
      date: scheduleInfo?.schedule_date || scheduleInfo?.scheduleDate || null,
      bus: scheduleInfo?.bus_plate || scheduleInfo?.busPlate || null,
      ticketId: ticket.id || ticket.ticket_id || null,
    };

    return await QRCode.toDataURL(JSON.stringify(payload), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    });
  } catch (error) {
    console.warn('[paymentController] QR generation failed:', error.message);
    return null;
  }
};

const getUserInfo = async (userId) => {
  const result = await pool.query(
    'SELECT id, full_name, email, phone_number FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
};

const getScheduleInfoForEmail = async (scheduleId, meta = {}) => {
  const schedulesResult = await pool.query(
    `
      SELECT
        r.origin,
        r.destination,
        s.schedule_date,
        s.departure_time,
        b.plate_number AS bus_plate,
        COALESCE(c.name, 'SafariTix Transport') AS company_name
      FROM schedules s
      LEFT JOIN routes r ON r.id = s.route_id
      LEFT JOIN buses b ON b.id = s.bus_id
      LEFT JOIN companies c ON c.id = s.company_id
      WHERE s.id::text = $1::text
      LIMIT 1
    `,
    [scheduleId]
  );

  if (schedulesResult.rows[0]) {
    return schedulesResult.rows[0];
  }

  const busSchedulesResult = await pool.query(
    `
      SELECT
        rr.from_location AS origin,
        rr.to_location AS destination,
        bs.date AS schedule_date,
        bs.time AS departure_time,
        b.plate_number AS bus_plate,
        COALESCE(c.name, 'SafariTix Transport') AS company_name
      FROM bus_schedules bs
      LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id
      LEFT JOIN buses b ON b.id = bs.bus_id
      LEFT JOIN companies c ON c.id = bs.company_id
      WHERE bs.schedule_id::text = $1::text
      LIMIT 1
    `,
    [scheduleId]
  ).catch(() => ({ rows: [] }));

  if (busSchedulesResult.rows[0]) {
    return busSchedulesResult.rows[0];
  }

  return {
    origin: meta.from_stop || 'N/A',
    destination: meta.to_stop || 'N/A',
    schedule_date: meta.trip_date || null,
    departure_time: meta.trip_time || meta.departure_time || null,
    bus_plate: null,
    company_name: 'SafariTix Transport',
  };
};

const sendSuccessfulPaymentEmail = async (paymentRow, tickets) => {
  try {
    if (!tickets.length) return;
    const user = await getUserInfo(paymentRow.user_id);
    if (!user || !user.email) return;

    const scheduleInfo = await getScheduleInfoForEmail(paymentRow.schedule_id, paymentRow.meta || {});
    await sendETicketEmail({
      userEmail: user.email,
      userName: user.full_name || 'Valued Customer',
      // Pass the raw ticket rows so eTicketService can build QR payload consistently.
      tickets,
      scheduleInfo,
      companyInfo: { name: scheduleInfo?.company_name || 'SafariTix Transport' },
      bookingId: paymentRow.id,
      userId: paymentRow.user_id,
    });
  } catch (error) {
    console.error('[paymentController] Failed to send payment success email:', error.message);
  }
};

// Sends MTN RequestToPay (or configured provider equivalent) and returns provider reference.
const sendPaymentRequest = async ({ amount, currency, phoneNumber, reference, description, paymentMethod, callbackUrl }) => {
  return initiateCollection({
    amount,
    currency,
    phoneNumber,
    reference,
    description,
    paymentMethod,
    callbackUrl,
  });
};

// Checks current provider payment status by provider reference ID.
const checkPaymentStatus = async ({ providerReference }) => {
  return getCollectionStatus({ providerReference });
};

const isProviderAuthFailure = (error) => {
  const status = Number(
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    error?.raw?.status
  );
  const message = String(error?.message || error?.raw?.message || '').toLowerCase();
  return status === 401 || message.includes('authentication failed') || message.includes('unauthorized');
};

// Finalizes held booking into confirmed ticket(s) only after successful payment.
const createTicketAfterPayment = async ({ client, paymentRow, providerPayload }) => {
  return finalizeSuccessfulPayment(client, paymentRow, providerPayload);
};

const notifyTicketBooked = async (paymentRow, tickets) => {
  if (!paymentRow?.user_id || !Array.isArray(tickets) || tickets.length === 0) return;

  const seatPreview = tickets
    .map((ticket) => String(ticket?.seat_number || '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');

  const firstRef = tickets[0]?.booking_ref || tickets[0]?.id || '';
  const seatsLabel = seatPreview ? ` Seats: ${seatPreview}.` : '';

  try {
    await NotificationService.createNotification(
      paymentRow.user_id,
      'Ticket Confirmed',
      `Your payment was successful and your ticket is confirmed.${seatsLabel} Ref: ${firstRef}`,
      'ticket_booked',
      {
        relatedId: paymentRow.id,
        relatedType: 'payment',
        data: {
          paymentId: paymentRow.id,
          ticketIds: tickets.map((ticket) => ticket.id),
        },
      }
    );
  } catch (err) {
    console.error('[paymentController] booking notification error:', err.message);
  }
};

const insertPaymentRecord = async (client, {
  userId,
  scheduleId,
  paymentMethod,
  amount,
  currency,
  transactionRef,
  seatLockIds,
  heldTicketIds,
  seatNumbers,
  expiresAt,
  meta,
}) => {
  const paymentId = generateUUID();
  const paymentColumns = await getTableColumns(client, 'payments');
  const resolvedScheduleId = await resolvePaymentScheduleId(client, scheduleId, {
    busId: meta?.bus_id,
    routeId: meta?.route_id,
    tripDate: meta?.trip_date,
    departureTime: meta?.departure_time || meta?.trip_time,
  });

  // Only hard-fail when: schedule_id column is required but we have no value at all.
  // After ensurePaymentsScheduleFk() runs, schedule_id is nullable so null is fine.
  // resolvePaymentScheduleId now returns rawScheduleId as a fallback, so this guard
  // is only hit when scheduleId itself was falsy.
  if (paymentColumns.has('schedule_id') && !resolvedScheduleId && scheduleId) {
    console.warn('[paymentController] schedule resolution returned null for scheduleId:', scheduleId);
  }

  const insertColumns = [];
  const insertValues = [];
  const params = [];
  const addColumn = (column, value, transform) => {
    if (!paymentColumns.has(column)) return;
    insertColumns.push(column);
    params.push(typeof transform === 'function' ? transform(value) : value);
    insertValues.push(`$${params.length}`);
  };

  addColumn('id', paymentId);
  addColumn('user_id', userId);
  addColumn('schedule_id', resolvedScheduleId);
  addColumn('payment_method', paymentMethod);
  addColumn('phone_or_card', '');
  addColumn('amount', amount);
  addColumn('currency', currency);
  addColumn('status', 'pending');
  addColumn('booking_status', 'pending_payment');
  addColumn('transaction_ref', transactionRef);
  addColumn('seat_lock_ids', seatLockIds || [], (v) => JSON.stringify(v));
  addColumn('held_ticket_ids', heldTicketIds || [], (v) => JSON.stringify(v));
  addColumn('seat_numbers', seatNumbers || [], (v) => JSON.stringify(v));
  addColumn('expires_at', expiresAt);
  addColumn('meta', meta || {}, (v) => JSON.stringify(v));
  addColumn('created_at', new Date());
  addColumn('updated_at', new Date());

  const result = await client.query(
    `
      INSERT INTO payments (${insertColumns.join(', ')})
      VALUES (${insertValues.join(', ')})
      RETURNING *
    `,
    params
  );
  return result.rows[0];
};

const createScheduleBookingHold = async ({ client, userId, scheduleId, seatNumbers, paymentMethod, priceOverride }) => {
  const scheduleResult = await client.query(
    `
      SELECT
        s.id,
        s.departure_time,
        s.ticket_status,
        s.available_seats,
        s.price_per_seat,
        s.company_id,
        s.status,
        s.bus_id,
        b.status AS bus_status,
        COALESCE(
          (
            SELECT rr.price
            FROM rura_routes rr
            LEFT JOIN routes r ON r.id = s.route_id
            WHERE rr.status = 'active'
              AND LOWER(TRIM(rr.from_location)) = LOWER(TRIM(r.origin))
              AND LOWER(TRIM(rr.to_location)) = LOWER(TRIM(r.destination))
              AND rr.effective_date <= COALESCE(s.schedule_date::date, CURRENT_DATE)
            ORDER BY rr.effective_date DESC, rr.created_at DESC
            LIMIT 1
          ),
          s.price_per_seat
        ) AS effective_price
      FROM schedules s
      LEFT JOIN buses b ON b.id = s.bus_id
      WHERE s.id = $1
      FOR UPDATE
    `,
    [scheduleId]
  );

  if (!scheduleResult.rows.length) {
    throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
  }

  const schedule = scheduleResult.rows[0];
  const now = new Date();

  if (schedule.status !== 'scheduled') {
    throw Object.assign(new Error('Schedule not available for booking'), { statusCode: 400 });
  }
  if (schedule.bus_status && String(schedule.bus_status).toUpperCase() !== 'ACTIVE') {
    throw Object.assign(new Error('Cannot book schedule on inactive bus'), { statusCode: 400 });
  }
  if (schedule.ticket_status === 'CLOSED') {
    throw Object.assign(new Error('Ticket sales closed for this schedule'), { statusCode: 400 });
  }
  if (schedule.departure_time && new Date(schedule.departure_time) <= now) {
    throw Object.assign(new Error('Ticket sales closed for this schedule'), { statusCode: 400 });
  }
  if (toInt(schedule.available_seats) < seatNumbers.length) {
    throw Object.assign(new Error(`Only ${schedule.available_seats} seat(s) available`), { statusCode: 400 });
  }

  const seatResult = await client.query(
    `
      SELECT seat_number, COALESCE(is_driver, false) AS is_driver
      FROM seats
      WHERE bus_id = $1
        AND seat_number = ANY($2::text[])
    `,
    [schedule.bus_id, seatNumbers]
  );

  if (seatResult.rows.length !== seatNumbers.length) {
    const found = new Set(seatResult.rows.map((row) => String(row.seat_number)));
    const missing = seatNumbers.filter((seat) => !found.has(String(seat)));
    throw Object.assign(new Error(`Invalid seat numbers: ${missing.join(', ')}`), { statusCode: 400 });
  }

  const driverSeats = seatResult.rows.filter((row) => row.is_driver).map((row) => String(row.seat_number));
  if (driverSeats.length > 0) {
    throw Object.assign(new Error(`Cannot book driver seats: ${driverSeats.join(', ')}`), { statusCode: 400 });
  }

  const bookedTickets = await client.query(
    `
      SELECT seat_number
      FROM tickets
      WHERE schedule_id = $1
        AND seat_number = ANY($2::text[])
        AND status = ANY($3::text[])
    `,
    [scheduleId, seatNumbers, BOOKED_TICKET_STATES]
  );
  if (bookedTickets.rows.length > 0) {
    throw Object.assign(new Error(`Seat already booked: ${bookedTickets.rows.map((row) => row.seat_number).join(', ')}`), { statusCode: 409 });
  }

  const activeLocks = await client.query(
    `
      SELECT id, seat_number, passenger_id, expires_at
      FROM seat_locks
      WHERE schedule_id = $1
        AND seat_number = ANY($2::text[])
        AND status = 'ACTIVE'
        AND expires_at > NOW()
      FOR UPDATE
    `,
    [scheduleId, seatNumbers]
  );

  const lockBySeat = new Map(activeLocks.rows.map((row) => [String(row.seat_number), row]));
  const otherUserLocks = activeLocks.rows.filter((row) => String(row.passenger_id) !== String(userId));
  if (otherUserLocks.length > 0) {
    throw Object.assign(new Error(`Seat temporarily locked: ${otherUserLocks.map((row) => row.seat_number).join(', ')}`), { statusCode: 409 });
  }

  const expiresAt = new Date(now.getTime() + LOCK_DURATION_MINUTES * 60000);
  const seatLockIds = [];
  const heldTicketIds = [];
  const pricePerSeat = Number(priceOverride || schedule.effective_price || 0);

  for (const seatNumber of seatNumbers) {
    const existingLock = lockBySeat.get(String(seatNumber));
    if (existingLock) {
      seatLockIds.push(existingLock.id);
      continue;
    }

    const lockId = generateUUID();
    await client.query(
      `
        INSERT INTO seat_locks (
          id, schedule_id, company_id, seat_number, passenger_id,
          ticket_id, expires_at, status, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          NULL, $6, 'ACTIVE', NOW(), NOW()
        )
      `,
      [
        lockId,
        scheduleId,
        schedule.company_id,
        String(seatNumber),
        userId,
        expiresAt,
      ]
    );

    seatLockIds.push(lockId);
  }

  const payment = await insertPaymentRecord(client, {
    userId,
    scheduleId,
    paymentMethod,
    amount: pricePerSeat * seatNumbers.length,
    currency: 'RWF',
    transactionRef: buildBookingReference(),
    seatLockIds,
    heldTicketIds,
    seatNumbers,
    expiresAt,
    meta: { flow: 'schedule' },
  });

  return payment;
};

const createSegmentBookingHold = async ({ client, userId, scheduleId, seatNumbers, paymentMethod, fromStop, toStop }) => {
  const scheduleTable = await getScheduleTableName(client);
  const scheduleResult = await client.query(
    scheduleTable === 'bus_schedules'
      ? `
          SELECT
            bs.schedule_id,
            bs.bus_id,
            bs.route_id,
            bs.company_id,
            bs.date,
            bs.time,
            bs.capacity,
            COALESCE(bs.status, 'scheduled') AS status,
            b.status AS bus_status,
            b.plate_number
          FROM bus_schedules bs
          INNER JOIN buses b ON b.id = bs.bus_id
          WHERE bs.schedule_id::text = $1::text
          FOR UPDATE
        `
      : `
          SELECT
            s.id AS schedule_id,
            s.bus_id,
            s.route_id,
            s.company_id,
            s.schedule_date AS date,
            s.departure_time AS time,
            COALESCE(s.total_seats, s.available_seats + s.booked_seats) AS capacity,
            COALESCE(s.status, 'scheduled') AS status,
            b.status AS bus_status,
            b.plate_number
          FROM schedules s
          INNER JOIN buses b ON b.id = s.bus_id
          WHERE s.id::text = $1::text
          FOR UPDATE
        `,
    [scheduleId]
  );

  if (!scheduleResult.rows.length) {
    throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
  }

  const schedule = scheduleResult.rows[0];
  if ((schedule.status || '').toLowerCase() === 'cancelled') {
    throw Object.assign(new Error('Schedule is cancelled'), { statusCode: 400 });
  }
  if ((schedule.bus_status || '').toLowerCase() !== 'active') {
    throw Object.assign(new Error('Assigned bus is not active'), { statusCode: 400 });
  }

  const routeStops = await getStopsByRoute(client, schedule.route_id);
  if (routeStops.length < 2) {
    throw Object.assign(new Error('Route stops are not configured'), { statusCode: 400 });
  }

  const occupancy = await getScheduleOccupancy(client, schedule.schedule_id, routeStops, fromStop, toStop);
  if (occupancy.fromSeq < 0 || occupancy.toSeq < 0 || occupancy.fromSeq >= occupancy.toSeq) {
    throw Object.assign(new Error('Invalid boarding segment'), { statusCode: 400 });
  }

  const capacity = toInt(schedule.capacity, 0);
  if (occupancy.occupiedSeats.size >= capacity) {
    throw Object.assign(new Error('No seats available for selected segment'), { statusCode: 400 });
  }

  const seatCatalog = await client.query(
    `
      SELECT seat_number, COALESCE(is_driver, false) AS is_driver
      FROM seats
      WHERE bus_id::text = $1::text
    `,
    [schedule.bus_id]
  );

  if (seatCatalog.rows.length === 0) {
    const invalidByCapacity = seatNumbers.filter((seat) => {
      const parsed = Number(seat);
      return !Number.isInteger(parsed) || parsed < 1 || parsed > capacity;
    });

    if (invalidByCapacity.length > 0) {
      throw Object.assign(new Error(`Invalid seat numbers: ${invalidByCapacity.join(', ')}`), { statusCode: 400 });
    }
  }

  const seatInventory = await client.query(
    `
      SELECT seat_number, COALESCE(is_driver, false) AS is_driver
      FROM seats
      WHERE bus_id::text = $1::text
        AND seat_number = ANY($2::text[])
    `,
    [schedule.bus_id, seatNumbers]
  );

  if (seatCatalog.rows.length > 0 && seatInventory.rows.length !== seatNumbers.length) {
    const found = new Set(seatInventory.rows.map((row) => String(row.seat_number)));
    const missing = seatNumbers.filter((seat) => !found.has(String(seat)));
    throw Object.assign(new Error(`Invalid seat numbers: ${missing.join(', ')}`), { statusCode: 400 });
  }

  const driverSeats = seatInventory.rows.filter((row) => row.is_driver).map((row) => String(row.seat_number));
  if (driverSeats.length > 0) {
    throw Object.assign(new Error(`Cannot book driver seats: ${driverSeats.join(', ')}`), { statusCode: 400 });
  }

  for (const seat of seatNumbers) {
    if (occupancy.occupiedSeats.has(String(seat))) {
      throw Object.assign(new Error(`Selected seat is not available for this segment: ${seat}`), { statusCode: 409 });
    }
  }

  const segPrice = await getSegmentFare(client, fromStop, toStop, schedule.date);
  if (segPrice === null) {
    throw Object.assign(new Error('No active RURA tariff found for the selected segment'), { statusCode: 400 });
  }

  const normalizedTripDate = toIsoDateString(schedule.date);
  const expiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60000);
  const seatLockIds = [];

  const activeLocks = await client.query(
    `
      SELECT id, seat_number, passenger_id
      FROM seat_locks
      WHERE schedule_id::text = $1::text
        AND seat_number = ANY($2::text[])
        AND status = 'ACTIVE'
        AND expires_at > NOW()
      FOR UPDATE
    `,
    [schedule.schedule_id, seatNumbers]
  );

  const lockBySeat = new Map(activeLocks.rows.map((row) => [String(row.seat_number), row]));
  const otherUserLocks = activeLocks.rows.filter((row) => String(row.passenger_id) !== String(userId));
  if (otherUserLocks.length > 0) {
    throw Object.assign(new Error(`Seat temporarily locked: ${otherUserLocks.map((row) => row.seat_number).join(', ')}`), { statusCode: 409 });
  }

  for (const seatNumber of seatNumbers) {
    const existingLock = lockBySeat.get(String(seatNumber));
    if (existingLock) {
      seatLockIds.push(existingLock.id);
      continue;
    }

    const lockId = generateUUID();
    await client.query(
      `
        INSERT INTO seat_locks (
          id, schedule_id, company_id, seat_number, passenger_id,
          ticket_id, expires_at, status, meta, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          NULL, $6, 'ACTIVE', $7::jsonb, NOW(), NOW()
        )
      `,
      [
        lockId,
        schedule.schedule_id,
        schedule.company_id || null,
        String(seatNumber),
        userId,
        expiresAt,
        JSON.stringify({
          flow: 'segment',
          from_stop: fromStop,
          to_stop: toStop,
          from_sequence: occupancy.fromSeq,
          to_sequence: occupancy.toSeq,
          route_id: schedule.route_id,
          trip_date: normalizedTripDate,
          price: segPrice,
        }),
      ]
    );

    seatLockIds.push(lockId);
  }

  const payment = await insertPaymentRecord(client, {
    userId,
    scheduleId: schedule.schedule_id,
    paymentMethod,
    amount: segPrice * seatNumbers.length,
    currency: 'RWF',
    transactionRef: buildBookingReference(),
    seatLockIds,
    heldTicketIds: [],
    seatNumbers,
    expiresAt,
    meta: {
      flow: 'segment',
      from_stop: fromStop,
      to_stop: toStop,
      from_sequence: occupancy.fromSeq,
      to_sequence: occupancy.toSeq,
      schedule_source: scheduleTable,
      bus_id: schedule.bus_id,
      route_id: schedule.route_id,
      trip_date: normalizedTripDate,
    },
  });

  return payment;
};

const finalizeSuccessfulPayment = async (client, paymentRow, providerPayload) => {
  if (getPaymentBookingStatus(paymentRow) === 'paid') {
    const tickets = await client.query(
      'SELECT * FROM tickets WHERE payment_id = $1 ORDER BY seat_number ASC',
      [paymentRow.id]
    );
    return { payment: paymentRow, tickets: tickets.rows };
  }

  const now = new Date();
  const seatLockIds = parseJsonArrayField(paymentRow.seat_lock_ids);
  const meta = paymentRow.meta || {};
  let tickets = [];

  // Some environments enforce a DB trigger that blocks ticket insert unless
  // the linked payment is already marked paid/success.
  // Mark payment successful first (inside the same transaction) so ticket
  // inserts satisfy that trigger, while still keeping atomic rollback safety.
  const preMarkedPayment = await updatePaymentCompat(
    client,
    paymentRow.id,
    {
      status: 'success',
      booking_status: 'paid',
      provider_status: 'success',
      completed_at: new Date(),
      failed_at: null,
    },
    {
      prefinalised_at: new Date().toISOString(),
    }
  );
  paymentRow = preMarkedPayment || paymentRow;

  const existingTickets = await client.query(
    'SELECT * FROM tickets WHERE payment_id = $1 ORDER BY seat_number ASC',
    [paymentRow.id]
  );
  if (existingTickets.rows.length > 0) {
    tickets = existingTickets.rows;
  } else {
    const lockRows = await client.query(
      `
        SELECT *
        FROM seat_locks
        WHERE id = ANY($1::uuid[])
        FOR UPDATE
      `,
      [seatLockIds]
    );
    if (lockRows.rows.length !== seatLockIds.length) {
      throw new Error('One or more seat locks could not be found during payment finalization');
    }

    const activeLocks = lockRows.rows.filter((row) => row.status === 'ACTIVE' && new Date(row.expires_at) > now);
    if (activeLocks.length !== seatLockIds.length) {
      const alreadyConsumed = lockRows.rows.every((row) => row.status === 'CONSUMED');
      if (!alreadyConsumed) {
        throw new Error('Seat lock expired before payment confirmation');
      }
      const consumedTickets = await client.query(
        'SELECT * FROM tickets WHERE payment_id = $1 ORDER BY seat_number ASC',
        [paymentRow.id]
      );
      tickets = consumedTickets.rows;
    } else {
      const ticketColumns = await getTableColumns(client, 'tickets');
      const seatCount = Math.max(1, activeLocks.length);
      const defaultPricePerSeat = Number(paymentRow.amount || 0) / seatCount;

      for (const lock of activeLocks) {
        const lockMeta = typeof lock.meta === 'object' && lock.meta !== null ? lock.meta : {};
        const insertColumns = [];
        const insertValues = [];
        const params = [];
        const addCol = (column, value) => {
          if (!ticketColumns.has(column)) return;
          insertColumns.push(column);
          params.push(value);
          insertValues.push(`$${params.length}`);
        };

        addCol('id', generateUUID());
        addCol('passenger_id', lock.passenger_id || paymentRow.user_id);
        addCol('schedule_id', lock.schedule_id || paymentRow.schedule_id);
        addCol('company_id', lock.company_id || null);
        addCol('route_id', lockMeta.route_id || meta.route_id || null);
        addCol('trip_date', lockMeta.trip_date || meta.trip_date || null);
        addCol('from_stop', lockMeta.from_stop || meta.from_stop || null);
        addCol('to_stop', lockMeta.to_stop || meta.to_stop || null);
        addCol('from_sequence', lockMeta.from_sequence || meta.from_sequence || null);
        addCol('to_sequence', lockMeta.to_sequence || meta.to_sequence || null);
        addCol('seat_number', String(lock.seat_number));
        addCol('price', Number(lockMeta.price || defaultPricePerSeat || 0));
        addCol('status', 'CONFIRMED');
        addCol('booking_ref', buildTicketBookingRef());
        addCol('payment_id', paymentRow.id);
        addCol('booked_at', new Date());
        addCol('created_at', new Date());
        addCol('updated_at', new Date());

        const inserted = await client.query(
          `
            INSERT INTO tickets (${insertColumns.join(', ')})
            VALUES (${insertValues.join(', ')})
            RETURNING *
          `,
          params
        );
        tickets.push(inserted.rows[0]);
      }

      await client.query(
        `
          UPDATE seat_locks
          SET status = 'CONSUMED', updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `,
        [seatLockIds]
      );

      if ((meta.schedule_source || 'schedules') === 'bus_schedules') {
        await client.query(
          `
            UPDATE bus_schedules
            SET booked_seats = COALESCE(booked_seats, 0) + $1,
                updated_at = NOW()
            WHERE schedule_id::text = $2::text
          `,
          [tickets.length, paymentRow.schedule_id]
        );
      } else {
        await client.query(
          `
            UPDATE schedules
            SET available_seats = GREATEST(COALESCE(available_seats, 0) - $1, 0),
                booked_seats = COALESCE(booked_seats, 0) + $1,
                updated_at = NOW()
            WHERE id::text = $2::text
          `,
          [tickets.length, paymentRow.schedule_id]
        );
      }
    }
  }

  let scheduleInfoForQr = null;
  let seatsForQr = tickets.map((t) => t.seat_number).filter(Boolean);
  try {
    scheduleInfoForQr = await getScheduleInfoForEmail(paymentRow.schedule_id, paymentRow.meta || {});
  } catch (e) {
    // QR generation should not break booking confirmation.
    scheduleInfoForQr = null;
  }

  for (const ticket of tickets) {
    if (!ticket.qr_code_url) {
      const qrCodeUrl = await generateTicketQrDataUrl({
        ticket,
        bookingId: paymentRow.id,
        userId: paymentRow.user_id,
        scheduleInfo: scheduleInfoForQr,
        seats: seatsForQr,
      });
      if (qrCodeUrl) {
        await client.query(
          'UPDATE tickets SET qr_code_url = $1, updated_at = NOW() WHERE id = $2',
          [qrCodeUrl, ticket.id]
        );
        ticket.qr_code_url = qrCodeUrl;
      }
    }
  }

  const paymentResult = await updatePaymentCompat(
    client,
    paymentRow.id,
    {
      status: 'success',
      booking_status: 'paid',
      provider_status: 'success',
      completed_at: new Date(),
      failed_at: null,
    },
    {
      last_provider_payload: providerPayload || null,
      finalised_at: new Date().toISOString(),
    }
  );

  await notifyTicketBooked(paymentRow, tickets);

  return { payment: paymentResult || paymentRow, tickets };
};

const finalizeFailedPayment = async (client, paymentRow, reason, providerPayload) => {
  if (getPaymentBookingStatus(paymentRow) === 'cancelled') {
    return { payment: paymentRow };
  }

  const seatLockIds = parseJsonArrayField(paymentRow.seat_lock_ids);
  const heldTicketIds = parseJsonArrayField(paymentRow.held_ticket_ids);

  if (seatLockIds.length > 0) {
    await client.query(
      `
        UPDATE seat_locks
        SET status = 'RELEASED',
            updated_at = NOW(),
            meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
        WHERE id = ANY($1::uuid[])
          AND status = 'ACTIVE'
      `,
      [
        seatLockIds,
        JSON.stringify({
          release_reason: reason || 'payment_failed',
          released_at: new Date().toISOString(),
        }),
      ]
    );
  }

  if (heldTicketIds.length > 0) {
    await client.query(
      `
        UPDATE tickets
        SET status = 'EXPIRED', updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND status = 'PENDING_PAYMENT'
      `,
      [heldTicketIds]
    );
  }

  const paymentResult = await updatePaymentCompat(
    client,
    paymentRow.id,
    {
      status: 'failed',
      booking_status: 'cancelled',
      provider_status: normalizeStatus(reason || 'failed'),
      failed_at: new Date(),
    },
    {
      failure_reason: reason || 'payment_failed',
      last_provider_payload: providerPayload || null,
    }
  );

  return { payment: paymentResult || paymentRow };
};

const serializePayment = (paymentRow) => ({
  id: paymentRow.id,
  booking_id: paymentRow.id,
  booking_reference: paymentRow.transaction_ref,
  amount: Number(paymentRow.amount || 0),
  currency: paymentRow.currency || 'RWF',
  payment_method: paymentRow.payment_method,
  status: paymentRow.status,
  booking_status: getPaymentBookingStatus(paymentRow),
  provider_reference: paymentRow.provider_reference || null,
  provider_status: paymentRow.provider_status || null,
  seat_numbers: parseJsonArrayField(paymentRow.seat_numbers),
  expires_at: paymentRow.expires_at || null,
  completed_at: paymentRow.completed_at || null,
  failed_at: paymentRow.failed_at || null,
});

const createBookingHold = async (req, res) => {
  // Ensure payments.schedule_id FK is compatible with the active schedule table
  // (runs once per process; safe to await here — it uses its own DB connection)
  await ensurePaymentsScheduleFk().catch((err) =>
    console.warn('[createBookingHold] FK migration skipped:', err.message)
  );

  let client;
  try {
    const userId = req.userId;
    const {
      scheduleId,
      selectedSeats,
      paymentMethod = 'mobile_money',
      amount,
      pricePerSeat,
      fromStop,
      toStop,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!scheduleId) {
      return res.status(400).json({ error: 'scheduleId is required' });
    }
    if (!Array.isArray(selectedSeats) || selectedSeats.length === 0) {
      return res.status(400).json({ error: 'selectedSeats must be a non-empty array' });
    }
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const seatNumbers = selectedSeats.map((seat) => String(seat).trim());

    client = await pool.connect();
    await client.query('BEGIN');

    try {
      let payment;
      if (fromStop && toStop) {
        payment = await createSegmentBookingHold({
          client,
          userId,
          scheduleId,
          seatNumbers,
          paymentMethod,
          fromStop,
          toStop,
        });
      } else {
        payment = await createScheduleBookingHold({
          client,
          userId,
          scheduleId,
          seatNumbers,
          paymentMethod,
          priceOverride: pricePerSeat,
        });
      }

      if (typeof amount !== 'undefined' && Number(amount) !== Number(payment.amount)) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Amount mismatch',
          message: `Expected RWF ${Number(payment.amount).toLocaleString()}, received RWF ${Number(amount).toLocaleString()}`,
        });
      }

      await client.query('COMMIT');
      client.release();

      return res.status(201).json({
        success: true,
        booking: serializePayment(payment),
        message: 'Seats reserved. Complete payment before the hold expires.',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (client) client.release();
    console.error('Create booking hold error:', error);
    return res.status(error.statusCode || 500).json({
      error: 'Failed to create booking hold',
      message: error.message || 'An unexpected error occurred',
    });
  }
};

function detectCardNotConfigured() {
  return !readEnv('CARD_PAYMENT_PROVIDER', 'CARD_PAYMENT_API_KEY', 'CARD_PAYMENT_API_ID');
}

const initiatePayment = async (req, res) => {
  let client;

  try {
    const userId = req.userId;
    const {
      booking_id,
      bookingId,
      phone_number,
      phoneNumber,
      phoneOrCard,
      payment_method,
      paymentMethod,
      amount,
      scheduleId,
    } = req.body;

    const resolvedBookingId = booking_id || bookingId || null;
    const resolvedPaymentMethod = payment_method || paymentMethod || null;
    const phoneInputSource =
      (typeof phone_number === 'string' && phone_number.trim()) ? 'phone_number' :
      (typeof phoneNumber === 'string' && phoneNumber.trim()) ? 'phoneNumber' :
      (typeof phoneOrCard === 'string' && phoneOrCard.trim()) ? 'phoneOrCard' :
      'none';
    const rawInputPhone =
      phoneInputSource === 'phone_number' ? phone_number :
      phoneInputSource === 'phoneNumber' ? phoneNumber :
      phoneInputSource === 'phoneOrCard' ? phoneOrCard :
      '';
    const resolvedPhone = normalizePhoneNumber(rawInputPhone);

    console.log('[initiatePayment] Incoming request:', {
      userId,
      resolvedBookingId,
      resolvedPaymentMethod,
      phoneInputSource,
      rawPhone: rawInputPhone || '(none)',
      normalizedPhone: resolvedPhone ? `***${resolvedPhone.slice(-4)}` : '(empty)',
      normalizedPhoneFull:
        process.env.NODE_ENV === 'production'
          ? undefined
          : (resolvedPhone || '(empty)'),
      amount,
    });

    if (resolvedBookingId) {
      if (!resolvedPaymentMethod || !VALID_PAYMENT_METHODS.includes(resolvedPaymentMethod)) {
        return res.status(400).json({ error: 'payment_method is required and must be valid' });
      }
      if (resolvedPaymentMethod !== 'card_payment' && phoneInputSource !== 'phone_number') {
        return res.status(400).json({
          error: 'phone_number is required',
          message: 'Provide phone_number from the payment form field.',
        });
      }
      if (!resolvedPhone) {
        return res.status(400).json({ error: 'phone_number is required' });
      }
      if (!isSupportedRwandaMsisdn(resolvedPhone)) {
        return res.status(400).json({
          error: 'phone_number format invalid',
          message: 'Use a valid Rwanda mobile number (07XXXXXXXX or 2507XXXXXXXX).',
        });
      }

      client = await pool.connect();
      await client.query('BEGIN');

      try {
        const paymentResult = await client.query(
          `
            SELECT *
            FROM payments
            WHERE id = $1 AND user_id = $2
            FOR UPDATE
          `,
          [resolvedBookingId, userId]
        );

        if (!paymentResult.rows.length) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(404).json({ error: 'Booking not found' });
        }

        const paymentRow = paymentResult.rows[0];
        const now = new Date();

        if (getPaymentBookingStatus(paymentRow) === 'paid') {
          await client.query('COMMIT');
          client.release();
          return res.json({ success: true, payment: serializePayment(paymentRow), message: 'Payment already completed' });
        }

        if (getPaymentBookingStatus(paymentRow) === 'cancelled') {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({ error: 'Booking has already been cancelled' });
        }

        if (paymentRow.expires_at && new Date(paymentRow.expires_at) <= now) {
          await finalizeFailedPayment(client, paymentRow, 'expired_before_payment', { source: 'initiate' });
          await client.query('COMMIT');
          client.release();
          return res.status(409).json({ error: 'Booking hold expired. Please select seats again.' });
        }

        if (Number(paymentRow.amount) !== Number(amount)) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({
            error: 'Amount mismatch',
            message: `Expected amount RWF ${Number(paymentRow.amount).toLocaleString()}`,
          });
        }

        // Auto-confirm mode: mark booking as paid immediately after user confirms payment.
        // This bypasses provider interactions and is useful for environments where
        // mobile money callbacks are unavailable or intentionally disabled.
        if (shouldAutoConfirmPayment()) {
          const finalised = await createTicketAfterPayment({
            client,
            paymentRow,
            providerPayload: {
              fallback_mode: 'auto_confirm_payment',
              at: new Date().toISOString(),
            },
          });

          await client.query('COMMIT');
          client.release();

          sendSuccessfulPaymentEmail(finalised.payment, finalised.tickets).catch(() => {});

          return res.status(200).json({
            success: true,
            payment: serializePayment(finalised.payment),
            tickets: finalised.tickets.map((ticket) => ({
              id: ticket.id,
              booking_ref: ticket.booking_ref,
              seat_number: ticket.seat_number,
              status: ticket.status,
            })),
            message: 'Ticket confirmed! A copy is being sent to your email.',
          });
        }

        if (resolvedPaymentMethod === 'card_payment' && detectCardNotConfigured()) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({ error: 'Card payments are not configured for production yet' });
        }

        if (paymentRow.provider_reference && paymentRow.status === 'pending') {
          await updatePaymentCompat(client, paymentRow.id, {
            phone_or_card: resolvedPhone,
            payment_method: resolvedPaymentMethod,
          });
          await client.query('COMMIT');
          client.release();
          return res.status(202).json({
            success: true,
            payment: serializePayment({ ...paymentRow, phone_or_card: resolvedPhone, payment_method: resolvedPaymentMethod }),
            message: 'Payment request already pending on provider',
          });
        }

        let providerResponse;
        try {
          providerResponse = await sendPaymentRequest({
            amount: Number(paymentRow.amount),
            currency: paymentRow.currency || 'RWF',
            phoneNumber: resolvedPhone,
            reference: paymentRow.transaction_ref,
            description: 'SafariTix Bus Ticket',
            paymentMethod: resolvedPaymentMethod,
            callbackUrl: buildCallbackUrl(req),
          });
        } catch (providerError) {
          if (!isProviderAuthFailure(providerError)) {
            throw providerError;
          }

          console.warn('[PaymentGateway] Provider auth failed:', providerError.message);
          await client.query('ROLLBACK');
          client.release();

          return res.status(502).json({
            error: 'Payment provider unavailable',
            message: 'Unable to initiate payment with provider. Please try again shortly.',
            details: providerError.message || 'Provider authentication failed',
            provider: 'mtn',
          });
        }

        console.log('[PaymentGateway] Provider response:', {
          provider: providerResponse.provider,
          providerReference: providerResponse.providerReference,
          acknowledged: providerResponse.acknowledged,
          status: providerResponse.status,
          bookingId: paymentRow.id,
          phone: `***${resolvedPhone.slice(-4)}`,
        });

        // Fail fast: if provider did not return a reference, user should not be
        // left waiting for a payment that was never created upstream.
        if (!providerResponse.providerReference || providerResponse.acknowledged !== true) {
          const failed = await finalizeFailedPayment(
            client,
            paymentRow,
            'provider_reference_missing',
            providerResponse.raw || { reason: 'provider_reference_missing' }
          );

          await client.query('COMMIT');
          client.release();

          return res.status(502).json({
            error: 'Payment initiation failed',
            message: 'Provider did not acknowledge payment request. Please try again.',
            payment: serializePayment(failed.payment),
          });
        }

        // ── Async / pending path ────────────────────────────────────────────────
        // Provider queued the payment (MTN MoMo sends a USSD push to the phone).
        // Save the provider reference and return 'pending'. The frontend will poll
        // GET /api/payments/:id/status until the webhook or poll confirms success.
        const updatedPayment = await updatePaymentCompat(
          client,
          paymentRow.id,
          {
            phone_or_card: resolvedPhone,
            payment_method: resolvedPaymentMethod,
            provider_name: providerResponse.provider,
            provider_reference: providerResponse.providerReference,
            provider_status: providerResponse.status,
            // Keep status as 'pending' — only move to 'success' after explicit status check finalization
            status: 'pending',
          },
          { provider_request: providerResponse.raw || null }
        );

        await client.query('COMMIT');
        client.release();

        console.log('[PaymentGateway] Payment queued on provider — awaiting confirmation. bookingId:', paymentRow.id);

        return res.status(202).json({
          success: true,
          payment: serializePayment(updatedPayment || paymentRow),
          message: 'Payment request sent. Check your phone to confirm the transaction.',
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    if (!scheduleId || !resolvedPaymentMethod || !resolvedPhone) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Either booking_id or scheduleId/paymentMethod/phoneOrCard are required',
      });
    }

    const fallbackAmount = Number(amount || 0);
    const payment = {
      id: generateUUID(),
      transaction_ref: buildBookingReference(),
      amount: fallbackAmount,
      payment_method: resolvedPaymentMethod,
      status: 'pending',
      booking_status: 'pending_payment',
    };

    return res.status(201).json({
      success: true,
      payment: {
        id: payment.id,
        transaction_ref: payment.transaction_ref,
        amount: payment.amount,
        payment_method: payment.payment_method,
        status: payment.status,
      },
      message: 'Legacy payment flow is deprecated. Use booking holds before initiating payment.',
    });
  } catch (error) {
    if (client) client.release();
    console.error('Initiate payment error:', error);
    return res.status(500).json({
      error: 'Failed to initiate payment',
      message: error.message || 'An unexpected error occurred',
    });
  }
};

const getPaymentStatus = async (req, res) => {
  await ensurePaymentsScheduleFk().catch((err) =>
    console.warn('[getPaymentStatus] FK/schema migration skipped:', err.message)
  );

  let client;
  try {
    const userId = req.userId;
    const { paymentId } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    try {
      const paymentResult = await client.query(
        `
          SELECT *
          FROM payments
          WHERE id = $1 AND user_id = $2
          FOR UPDATE
        `,
        [paymentId, userId]
      );

      if (!paymentResult.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Payment not found' });
      }

      let paymentRow = paymentResult.rows[0];
      let tickets = [];
      const now = new Date();

      console.log('[getPaymentStatus] Poll for bookingId:', paymentId, 'status:', paymentRow.status, 'booking_status:', getPaymentBookingStatus(paymentRow), 'provider_ref:', paymentRow.provider_reference || '(none)');

      if (getPaymentBookingStatus(paymentRow) === 'pending_payment' && paymentRow.expires_at && new Date(paymentRow.expires_at) <= now) {
        const failed = await finalizeFailedPayment(client, paymentRow, 'expired', { source: 'poll' });
        paymentRow = failed.payment;
      } else {
        const providerReference = paymentRow.provider_reference || null;
        if (paymentRow.status === 'pending' && providerReference) {
          const providerStatus = await checkPaymentStatus({ providerReference });

          console.log('[getPaymentStatus] Provider status for ref', providerReference, '→', providerStatus.status);

          if (providerStatus.status === 'success') {
            const finalised = await createTicketAfterPayment({
              client,
              paymentRow,
              providerPayload: providerStatus.raw,
            });
            paymentRow = finalised.payment;
            tickets = finalised.tickets;
            console.log('[getPaymentStatus] Finalized success — tickets:', tickets.length);
          } else if (providerStatus.status === 'failed') {
            const failed = await finalizeFailedPayment(client, paymentRow, 'provider_failed', providerStatus.raw);
            paymentRow = failed.payment;
            console.log('[getPaymentStatus] Finalized failure');
          } else {
            const updated = await updatePaymentCompat(
              client,
              paymentRow.id,
              { provider_status: providerStatus.status },
              { last_provider_payload: providerStatus.raw || null }
            );
            paymentRow = updated || paymentRow;
          }
        } else if (paymentRow.status === 'pending' && !providerReference) {
          const createdAt = paymentRow.created_at ? new Date(paymentRow.created_at) : null;
          const ageMs = createdAt ? Date.now() - createdAt.getTime() : 0;

          // If provider reference is still missing after a short grace period,
          // stop waiting and release the seat.
          if (ageMs > 60 * 1000) {
            const failed = await finalizeFailedPayment(
              client,
              paymentRow,
              'provider_reference_missing',
              { source: 'poll', reason: 'provider_reference_missing' }
            );
            paymentRow = failed.payment;
          }
        }
      }

      if (!tickets.length && getPaymentBookingStatus(paymentRow) === 'paid') {
        const ticketResult = await client.query(
          'SELECT * FROM tickets WHERE payment_id = $1 ORDER BY seat_number ASC',
          [paymentRow.id]
        );
        tickets = ticketResult.rows;
      }

      await client.query('COMMIT');
      client.release();

      if (getPaymentBookingStatus(paymentRow) === 'paid' && tickets.length > 0) {
        sendSuccessfulPaymentEmail(paymentRow, tickets).catch(() => {});
      }

      return res.json({
        success: true,
        payment: serializePayment(paymentRow),
        tickets: tickets.map((ticket) => ({
          id: ticket.id,
          booking_ref: ticket.booking_ref,
          seat_number: ticket.seat_number,
          status: ticket.status,
        })),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (client) client.release();
    console.error('Get payment status error:', error);
    return res.status(500).json({
      error: 'Failed to fetch payment status',
      message: error.message || 'An unexpected error occurred',
    });
  }
};

const cancelPayment = async (req, res) => {
  let client;
  try {
    const userId = req.userId;
    const { paymentId } = req.params;
    client = await pool.connect();
    await client.query('BEGIN');

    try {
      const paymentResult = await client.query(
        'SELECT * FROM payments WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [paymentId, userId]
      );
      if (!paymentResult.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Payment not found' });
      }

      const finalised = await finalizeFailedPayment(client, paymentResult.rows[0], 'cancelled_by_user', { source: 'manual_cancel' });
      await client.query('COMMIT');
      client.release();

      return res.json({
        success: true,
        payment: serializePayment(finalised.payment),
        message: 'Booking cancelled and seats released',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (client) client.release();
    console.error('Cancel payment error:', error);
    return res.status(500).json({ error: 'Failed to cancel payment', message: error.message || 'An unexpected error occurred' });
  }
};

const webhook = async (req, res) => {
  let client;
  try {
    const webhookSecret = readEnv('PAYMENT_WEBHOOK_SECRET');
    if (webhookSecret) {
      const suppliedSecret = req.get('x-payment-webhook-secret') || req.get('x-webhook-secret');
      if (suppliedSecret !== webhookSecret) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
    }

    const event = extractWebhookEvent(req.body || {});
    if (!event.providerReference && !event.externalReference) {
      return res.status(400).json({ error: 'Unable to resolve payment reference from webhook payload' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    try {
      const paymentColumns = await getTableColumns(client, 'payments');
      const paymentResult = paymentColumns.has('provider_reference')
        ? await client.query(
            `
              SELECT *
              FROM payments
              WHERE provider_reference = $1
                 OR transaction_ref = $2
              ORDER BY updated_at DESC
              LIMIT 1
              FOR UPDATE
            `,
            [event.providerReference || null, event.externalReference || null]
          )
        : await client.query(
            `
              SELECT *
              FROM payments
              WHERE transaction_ref = $1
              ORDER BY updated_at DESC
              LIMIT 1
              FOR UPDATE
            `,
            [event.externalReference || null]
          );

      if (!paymentResult.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Payment not found for webhook reference' });
      }

      let paymentRow = paymentResult.rows[0];
      let tickets = [];

      if (event.status === 'success') {
        const finalised = await finalizeSuccessfulPayment(client, paymentRow, event.raw);
        paymentRow = finalised.payment;
        tickets = finalised.tickets;
      } else if (event.status === 'failed') {
        const failed = await finalizeFailedPayment(client, paymentRow, 'webhook_failed', event.raw);
        paymentRow = failed.payment;
      } else {
        const updated = await updatePaymentCompat(
          client,
          paymentRow.id,
          { provider_status: event.status },
          { last_provider_payload: event.raw || null }
        );
        paymentRow = updated || paymentRow;
      }

      await client.query('COMMIT');
      client.release();

      if (getPaymentBookingStatus(paymentRow) === 'paid' && tickets.length > 0) {
        sendSuccessfulPaymentEmail(paymentRow, tickets).catch(() => {});
      }

      return res.json({ success: true, payment: serializePayment(paymentRow) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (client) client.release();
    console.error('Payment webhook error:', error);
    return res.status(500).json({ error: 'Failed to process webhook', message: error.message || 'An unexpected error occurred' });
  }
};

const expirePendingPayments = async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const paymentColumns = await getTableColumns(client, 'payments');
    if (!paymentColumns.has('expires_at')) {
      await client.query('COMMIT');
      return 0;
    }

    const pendingPredicate = paymentColumns.has('booking_status')
      ? "booking_status = 'pending_payment'"
      : "status = 'pending'";

    const expiredPayments = await client.query(
      `
        SELECT *
        FROM payments
        WHERE ${pendingPredicate}
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        FOR UPDATE
      `
    );

    for (const paymentRow of expiredPayments.rows) {
      await finalizeFailedPayment(client, paymentRow, 'expired', { source: 'background_cleanup' });
    }

    await client.query('COMMIT');
    return expiredPayments.rows.length;
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Expire pending payments error:', error.message || error);
    return 0;
  } finally {
    if (client) client.release();
  }
};

const confirmPayment = async (req, res) => {
  return res.status(410).json({
    error: 'Deprecated endpoint',
    message: 'Use provider webhook or GET /api/payments/:paymentId/status for payment confirmation.',
  });
};

// Demo endpoint: finalize a booking hold immediately (no external payment provider).
// POST /api/payments/demo-confirm
// body: { bookingId | booking_id | paymentId }
const demoConfirmPayment = async (req, res) => {
  let client;
  try {
    const userId = req.userId;
    const paymentId = req.body?.bookingId || req.body?.booking_id || req.body?.paymentId || req.body?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!paymentId) {
      return res.status(400).json({ error: 'bookingId is required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const paymentResult = await client.query(
      `
        SELECT *
        FROM payments
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `,
      [paymentId, userId]
    );

    if (!paymentResult.rows.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Booking not found' });
    }

    const paymentRow = paymentResult.rows[0];
    const now = new Date();

    if (paymentRow.expires_at && new Date(paymentRow.expires_at) <= now) {
      const failed = await finalizeFailedPayment(client, paymentRow, 'expired_before_payment', { source: 'demo_confirm' });
      await client.query('COMMIT');
      client.release();
      return res.status(409).json({
        error: 'Booking hold expired. Please select seats again.',
        payment: serializePayment(failed.payment),
      });
    }

    const finalised = await createTicketAfterPayment({
      client,
      paymentRow,
      providerPayload: { fallback_mode: 'demo_confirm_payment', at: now.toISOString() },
    });

    await client.query('COMMIT');
    client.release();

    // Send email (fire-and-forget so API remains responsive).
    sendSuccessfulPaymentEmail(finalised.payment, finalised.tickets).catch(() => {});

    let scheduleInfo = null;
    try {
      scheduleInfo = await getScheduleInfoForEmail(finalised.payment.schedule_id, finalised.payment.meta || {});
    } catch {
      scheduleInfo = null;
    }
    const seats = (finalised.tickets || []).map((t) => t.seat_number).filter(Boolean);

    return res.status(200).json({
      success: true,
      booking: {
        bookingId: finalised.payment.id,
        userId: finalised.payment.user_id,
        from: scheduleInfo?.origin || scheduleInfo?.from || null,
        to: scheduleInfo?.destination || scheduleInfo?.to || null,
        seats,
        date: scheduleInfo?.schedule_date || scheduleInfo?.scheduleDate || null,
        bus: scheduleInfo?.bus_plate || scheduleInfo?.busPlate || null,
        departureTime: scheduleInfo?.departure_time || scheduleInfo?.departureTime || null,
      },
      payment: serializePayment(finalised.payment),
      tickets: (finalised.tickets || []).map((ticket) => ({
        id: ticket.id,
        ticketId: ticket.id,
        booking_ref: ticket.booking_ref,
        bookingRef: ticket.booking_ref,
        seat_number: ticket.seat_number,
        seatNumber: ticket.seat_number,
        qr_code_url: ticket.qr_code_url,
        qrCodeUrl: ticket.qr_code_url,
      })),
      qrCodeUrl: finalised.tickets?.[0]?.qr_code_url || null,
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
    console.error('demoConfirmPayment error:', error);
    return res.status(500).json({
      error: 'Failed to confirm booking in demo mode',
      message: error?.message || 'An unexpected error occurred',
    });
  }
};

const failPayment = async (req, res) => {
  const paymentId = req.body.paymentId || req.body.booking_id || req.body.bookingId;
  if (!paymentId) {
    return res.status(400).json({ error: 'paymentId is required' });
  }
  req.params = { ...(req.params || {}), paymentId };
  return cancelPayment(req, res);
};

const bookTicket = async (req, res) => {
  return res.status(410).json({
    error: 'Deprecated endpoint',
    message: 'Tickets are created automatically after confirmed payment.',
  });
};

module.exports = {
  createBookingHold,
  initiatePayment,
  getPaymentStatus,
  cancelPayment,
  webhook,
  expirePendingPayments,
  sendPaymentRequest,
  checkPaymentStatus,
  createTicketAfterPayment,
  confirmPayment,
  failPayment,
  bookTicket,
  demoConfirmPayment,
};
