const pool = require('../config/pgPool');
const { User } = require('../models');
const { sendETicketEmail } = require('../services/eTicketService');
const NotificationService = require('../services/notificationService');
const QRCode = require('qrcode');

const isValidDate = (value) => {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const hasScheduleDeparturePassed = async (client, dateValue, timeValue) => {
  if (!dateValue || !timeValue) return false;

  const result = await client.query(
    `
      SELECT
        ($1::date + $2::time) <= (NOW() AT TIME ZONE 'Africa/Kigali') AS has_departed
    `,
    [dateValue, timeValue]
  );

  return Boolean(result.rows[0]?.has_departed);
};

const normalizeStopName = (value) => (value || '').toString().trim().toLowerCase();
const SEAT_HOLD_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];
let scheduleTableCache = null;   // reset to null so bus_schedules is detected after migration
const tableColumnsCache = {};

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
  const set = new Set(result.rows.map((row) => row.column_name));
  tableColumnsCache[tableName] = set;
  return set;
};

const routeStopsQuery = `
  SELECT
    id,
    route_id,
    stop_name,
    sequence
  FROM route_stops
  WHERE route_id::text = $1
  ORDER BY sequence ASC
`;

const getStopsByRoute = async (client, routeId) => {
  try {
    const result = await client.query(routeStopsQuery, [routeId]);
    return result.rows;
  } catch (error) {
    // route_stops table not migrated yet; keep routes functional
    if (error && error.code === '42P01') return [];
    throw error;
  }
};

const findStopSequence = (stops, stopName) => {
  const normalized = normalizeStopName(stopName);
  const match = stops.find((item) => normalizeStopName(item.stop_name) === normalized);
  return match ? toInt(match.sequence, -1) : -1;
};

const overlapsSegment = (aFrom, aTo, bFrom, bTo) => {
  if (aFrom < 0 || aTo < 0 || bFrom < 0 || bTo < 0) return false;
  return aFrom < bTo && bFrom < aTo;
};

const parseSequence = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
};

const getSegmentFare = async (client, fromStop, toStop, effectiveDate) => {
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
    [fromStop, toStop, effectiveDate || null]
  );

  if (!result.rows.length) return null;
  return Number(result.rows[0].price);
};

const ROUTE_COORDINATE_HINTS = {
  kigali: { lat: -1.9441, lng: 30.0619 },
  nyabugogo: { lat: -1.9423, lng: 30.0445 },
  muhanga: { lat: -2.0833, lng: 29.75 },
  huye: { lat: -2.5967, lng: 29.7333 },
  butare: { lat: -2.5967, lng: 29.7333 },
  rubavu: { lat: -1.6792, lng: 29.2586 },
  musanze: { lat: -1.4998, lng: 29.6349 },
};

const normalizePlaceName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const resolveRoutePoint = (name, fallback) => {
  const normalized = normalizePlaceName(name);
  if (!normalized) return fallback || null;

  const direct = ROUTE_COORDINATE_HINTS[normalized];
  if (direct) return direct;

  const partial = Object.entries(ROUTE_COORDINATE_HINTS).find(([key]) => normalized.includes(key));
  if (partial) return partial[1];

  return fallback || null;
};

const toRadians = (degrees) => (Number(degrees || 0) * Math.PI) / 180;

const calculateDistanceKm = (from, to) => {
  if (!from || !to) return null;
  const earthRadiusKm = 6371;
  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lng - from.lng);
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);

  const a =
    Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
    Math.cos(fromLat) * Math.cos(toLat) *
    Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
};

const buildGuestDemoLocation = ({ fromName, toName, scheduleDate, departureTime, scheduleId }) => {
  const fallbackStart = ROUTE_COORDINATE_HINTS.kigali;
  const fallbackEnd = ROUTE_COORDINATE_HINTS.nyabugogo;
  const fromPoint = resolveRoutePoint(fromName, fallbackStart);
  const toPoint = resolveRoutePoint(toName, fallbackEnd);
  const departureIso = scheduleDate
    ? `${String(scheduleDate).slice(0, 10)}T${String(departureTime || '08:00').slice(0, 5)}:00`
    : null;
  const departureTimestamp = departureIso ? new Date(departureIso).getTime() : Date.now() - 15 * 60 * 1000;
  const elapsedMs = Math.max(0, Date.now() - (Number.isFinite(departureTimestamp) ? departureTimestamp : Date.now()));
  const totalMs = 95 * 60 * 1000;
  const progress = Math.min(1, elapsedMs / totalMs);

  const lat = fromPoint.lat + (toPoint.lat - fromPoint.lat) * progress;
  const lng = fromPoint.lng + (toPoint.lng - fromPoint.lng) * progress;
  const remainingKm = calculateDistanceKm({ lat, lng }, toPoint);
  const etaMinutes = remainingKm !== null ? (remainingKm / 36) * 60 : null;

  return {
    scheduleId,
    latitude: lat,
    longitude: lng,
    speed: 36,
    heading: null,
    timestamp: new Date().toISOString(),
    source: 'demo_simulation',
    distanceRemainingKm: remainingKm,
    etaMinutes,
    currentLocationLabel: fromName && toName
      ? `Between ${fromName} and ${toName}`
      : 'On route',
  };
};

const getLatestGuestLocationForBooking = async (client, scheduleId, busId, routeFrom, routeTo, scheduleDate, departureTime) => {
  const result = await client.query(
    `
      SELECT
        latitude,
        longitude,
        speed,
        heading,
        recorded_at
      FROM live_bus_locations
      WHERE ($1::text IS NOT NULL AND schedule_id::text = $1::text)
         OR ($2::text IS NOT NULL AND bus_id::text = $2::text)
      ORDER BY recorded_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [scheduleId || null, busId || null]
  ).catch(() => ({ rows: [] }));

  const latest = result.rows[0] || null;
  if (latest) {
    const destination = resolveRoutePoint(routeTo, null);
    const currentPoint = {
      lat: parseFloat(latest.latitude),
      lng: parseFloat(latest.longitude),
    };
    const speed = latest.speed ? parseFloat(latest.speed) : null;
    const distanceRemainingKm = destination ? calculateDistanceKm(currentPoint, destination) : null;
    const etaMinutes = speed && speed > 0 && distanceRemainingKm !== null
      ? (distanceRemainingKm / speed) * 60
      : null;

    return {
      demo: false,
      location: {
        latitude: currentPoint.lat,
        longitude: currentPoint.lng,
        speed,
        heading: latest.heading ? parseFloat(latest.heading) : null,
        timestamp: latest.recorded_at,
        source: 'live_gps',
        currentLocationLabel: routeFrom && routeTo
          ? `Between ${routeFrom} and ${routeTo}`
          : 'On route',
      },
      calculations: {
        distanceRemainingKm,
        etaMinutes,
      },
    };
  }

  const simulated = buildGuestDemoLocation({
    fromName: routeFrom,
    toName: routeTo,
    scheduleDate,
    departureTime,
    scheduleId,
  });

  return {
    demo: true,
    location: {
      latitude: simulated.latitude,
      longitude: simulated.longitude,
      speed: simulated.speed,
      heading: simulated.heading,
      timestamp: simulated.timestamp,
      source: simulated.source,
      currentLocationLabel: simulated.currentLocationLabel,
    },
    calculations: {
      distanceRemainingKm: simulated.distanceRemainingKm,
      etaMinutes: simulated.etaMinutes,
    },
  };
};

const ensureMobilePassenger = async ({ email, passengerName, phoneNumber }) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    const err = new Error('email is required');
    err.statusCode = 400;
    throw err;
  }

  const normalizedName = String(passengerName || '').trim() || 'Mobile Passenger';
  const normalizedPhone = String(phoneNumber || '').trim() || null;

  let user = await User.findOne({ where: { email: normalizedEmail } });
  if (user) {
    const updates = {};
    if (normalizedPhone && !user.phone_number) updates.phone_number = normalizedPhone;
    if (normalizedName && (!user.full_name || user.full_name === user.email)) updates.full_name = normalizedName;
    if (Object.keys(updates).length > 0) {
      await user.update(updates);
    }
    return user;
  }

  const { randomUUID } = require('crypto');
  try {
    return await User.create({
      full_name: normalizedName,
      email: normalizedEmail,
      password: randomUUID(),
      phone_number: normalizedPhone,
      role: 'commuter',
      is_active: true,
      email_verified: true,
      company_verified: false,
      account_status: 'approved',
      must_change_password: false,
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      const existing = await User.findOne({ where: { email: normalizedEmail } });
      if (existing) return existing;
    }
    throw error;
  }
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
      [scheduleId, SEAT_HOLD_STATUSES, toSeq, fromSeq]
    );

    return {
      occupiedSeats: new Set(occupied.rows.map((row) => String(row.seat_number))),
      fromSeq,
      toSeq
    };
  }

  const ticketsResult = await client.query(
    `
      SELECT
        seat_number,
        from_stop,
        to_stop,
        COALESCE(status::text, 'CONFIRMED') AS status
      FROM tickets
      WHERE schedule_id::text = $1::text
        AND COALESCE(status::text, 'CONFIRMED') = ANY($2::text[])
    `,
    [scheduleId, SEAT_HOLD_STATUSES]
  );

  const occupiedSeats = new Set();
  for (const ticket of ticketsResult.rows) {
    let ticketFrom = parseSequence(ticket.from_sequence);
    let ticketTo = parseSequence(ticket.to_sequence);

    if (ticketFrom === null) ticketFrom = findStopSequence(routeStops, ticket.from_stop);
    if (ticketTo === null) ticketTo = findStopSequence(routeStops, ticket.to_stop);

    // Legacy tickets without explicit segment data block the full route.
    if (ticketFrom === null || ticketFrom < 0) ticketFrom = routeMinSeq;
    if (ticketTo === null || ticketTo < 0) ticketTo = routeMaxSeq;
    if (ticketFrom >= ticketTo) continue;

    if (overlapsSegment(fromSeq, toSeq, ticketFrom, ticketTo)) {
      occupiedSeats.add(String(ticket.seat_number));
    }
  }

  return { occupiedSeats, fromSeq, toSeq };
};

const listSharedRoutes = async (req, res) => {
  let client;
  try {
    const from = (req.query.from || '').toString().trim();
    const to = (req.query.to || '').toString().trim();
    const status = (req.query.status || '').toString().trim().toLowerCase();
    const effectiveDate = (req.query.effective_date || '').toString().trim();
    const companyId = (req.companyId || req.query.company_id || '').toString().trim();

    const where = [];
    const params = [];

    if (from) {
      params.push(`%${from}%`);
      where.push(`r.from_location ILIKE $${params.length}`);
    }
    if (to) {
      params.push(`%${to}%`);
      where.push(`r.to_location ILIKE $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`LOWER(r.status) = $${params.length}`);
    }
    if (effectiveDate) {
      if (!isValidDate(effectiveDate)) {
        return res.status(400).json({ success: false, message: 'Invalid effective_date filter' });
      }
      params.push(effectiveDate);
      where.push(`r.effective_date::date <= $${params.length}::date`);
    }
    if (companyId) {
      const ruraColumns = await getTableColumns(client || (client = await pool.connect()), 'rura_routes');
      if (ruraColumns.has('company_id')) {
        params.push(companyId);
        where.push(`(r.company_id::text = $${params.length} OR r.company_id IS NULL)`);
      }
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    if (!client) client = await pool.connect();
    const routesResult = await client.query(
      `
        SELECT
          r.id,
          r.from_location,
          r.to_location,
          r.price,
          r.effective_date,
          r.source_document,
          r.status,
          r.created_at
        FROM rura_routes r
        ${whereClause}
        ORDER BY r.from_location ASC, r.to_location ASC, r.effective_date DESC
      `,
      params
    );

    const rows = routesResult.rows.map(route => ({
      ...route,
      price: Number(route.price),
    }));

    res.json({ success: true, routes: rows });
  } catch (error) {
    console.error('listSharedRoutes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch shared routes' });
  } finally {
    if (client) client.release();
  }
};

const getRouteStops = async (req, res) => {
  let client;
  try {
    const { routeId } = req.params;
    client = await pool.connect();

    const stops = await getStopsByRoute(client, routeId);
    res.json({ success: true, stops });
  } catch (error) {
    console.error('getRouteStops error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch route stops' });
  } finally {
    if (client) client.release();
  }
};

const upsertRouteStops = async (req, res) => {
  let client;
  try {
    const { routeId } = req.params;
    const stops = Array.isArray(req.body.stops) ? req.body.stops : [];
    if (!stops.length) {
      return res.status(400).json({ success: false, message: 'At least one stop is required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // If migration not yet applied, return explicit actionable error.
    const tables = await client.query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'route_stops'
        LIMIT 1
      `
    );
    if (!tables.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'route_stops table does not exist. Run migration 20260304_shared_route_booking.sql first.'
      });
    }

    await client.query('DELETE FROM route_stops WHERE route_id::text = $1::text', [routeId]);

    for (const stop of stops) {
      const stopName = (stop.stop_name || stop.stopName || '').toString().trim();
      const sequence = toInt(stop.sequence, 0);
      if (!stopName || sequence <= 0) continue;
      await client.query(
        `
          INSERT INTO route_stops (route_id, stop_name, sequence)
          VALUES ($1, $2, $3)
        `,
        [routeId, stopName, sequence]
      );
    }

    await client.query('COMMIT');
    const result = await client.query(routeStopsQuery, [routeId]);
    res.json({ success: true, stops: result.rows });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('upsertRouteStops error:', error);
    res.status(500).json({ success: false, message: 'Failed to save route stops' });
  } finally {
    if (client) client.release();
  }
};

const createSharedSchedule = async (req, res) => {
  let client;
  try {
    const { bus_id, route_id, date, time, capacity } = req.body;
    if (!bus_id || !route_id || !date || !time) {
      return res.status(400).json({ success: false, message: 'bus_id, route_id, date and time are required' });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    client = await pool.connect();

    const busResult = await client.query('SELECT id, capacity, company_id, status FROM buses WHERE id::text = $1::text', [bus_id]);
    if (!busResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Bus not found' });
    }

    const bus = busResult.rows[0];
    const companyId = req.companyId || bus.company_id || null;

    if (companyId && bus.company_id && String(bus.company_id) !== String(companyId)) {
      return res.status(403).json({ success: false, message: 'Invalid bus for this company' });
    }

    if (String(bus.status || '').toUpperCase() !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'Cannot schedule an inactive bus' });
    }

    const routeResult = await client.query(
      `
        SELECT id, price, status
        FROM rura_routes
        WHERE id::text = $1::text
        LIMIT 1
      `,
      [route_id]
    );

    if (!routeResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    if (String(routeResult.rows[0].status || '').toLowerCase() !== 'active') {
      return res.status(400).json({ success: false, message: 'Only active routes can be scheduled' });
    }

    const scheduleCapacity = toInt(capacity, toInt(bus.capacity, 0));

    if (scheduleCapacity <= 0) {
      return res.status(400).json({ success: false, message: 'Schedule capacity must be greater than zero' });
    }

    const tableName = await getScheduleTableName(client);
    if (tableName === 'bus_schedules') {
      const inserted = await client.query(
        `
          INSERT INTO bus_schedules (bus_id, route_id, date, time, capacity, company_id, status)
          VALUES ($1, $2::text, $3::date, $4::time, $5, $6, COALESCE($7, 'scheduled'))
          RETURNING schedule_id, bus_id, route_id, date, time, capacity, company_id, status
        `,
        [bus_id, route_id, date, time, scheduleCapacity, companyId, req.body.status || 'scheduled']
      );
      return res.status(201).json({ success: true, schedule: inserted.rows[0] });
    }

    const inserted = await client.query(
      `
        INSERT INTO schedules (
          bus_id,
          route_id,
          company_id,
          schedule_date,
          departure_time,
          arrival_time,
          total_seats,
          available_seats,
          booked_seats,
          status,
          price_per_seat
        )
        VALUES (
          $1, $2, $3, $4::date, $5::time, $5::time,
          $6, $6, 0, COALESCE($7, 'scheduled'),
          COALESCE((SELECT price FROM rura_routes WHERE id::text = $2::text LIMIT 1), 0)
        )
        RETURNING id AS schedule_id, bus_id, route_id, schedule_date AS date, departure_time AS time, total_seats AS capacity, status
      `,
      [bus_id, route_id, companyId, date, time, scheduleCapacity, req.body.status || 'scheduled']
    );
    return res.status(201).json({ success: true, schedule: inserted.rows[0] });
  } catch (error) {
    console.error('createSharedSchedule error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create schedule' });
  } finally {
    if (client) client.release();
  }
};

const listSharedSchedules = async (req, res) => {
  let client;
  try {
    const date = (req.query.date || '').toString().trim();
    const routeId = (req.query.route_id || '').toString().trim();
    const busId = (req.query.bus_id || '').toString().trim();
    const status = (req.query.status || '').toString().trim().toLowerCase();
    const companyId = req.companyId || (req.query.company_id || '').toString().trim();

    const where = [];
    const params = [];

    if (date) {
      if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date filter' });
      params.push(date);
      where.push(`bs.date::date = $${params.length}::date`);
    }
    if (routeId) {
      params.push(routeId);
      where.push(`bs.route_id::text = $${params.length}::text`);
    }
    if (busId) {
      params.push(busId);
      where.push(`bs.bus_id::text = $${params.length}::text`);
    }
    if (status && status !== 'all') {
      params.push(status);
      where.push(`LOWER(COALESCE(bs.status, 'scheduled')) = $${params.length}`);
    }
    if (companyId) {
      params.push(companyId);
      where.push(`bs.company_id::text = $${params.length}::text`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    client = await pool.connect();
    const tableName = await getScheduleTableName(client);
    const effectiveWhere = whereClause;

    const query =
      tableName === 'bus_schedules'
        ? `
            SELECT
              bs.schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.date,
              bs.time,
              bs.capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.plate_number,
              b.status AS bus_status,
              rr.from_location,
              rr.to_location,
              rr.price,
              rr.effective_date
            FROM bus_schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
            ${effectiveWhere}
            ORDER BY bs.date ASC, bs.time ASC
          `
        : `
            SELECT
              bs.id AS schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.company_id,
              bs.schedule_date AS date,
              bs.departure_time AS time,
              COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.plate_number,
              b.status AS bus_status,
              rr.from_location,
              rr.to_location,
              rr.price,
              rr.effective_date
            FROM schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id::text
            ${effectiveWhere}
            ORDER BY bs.schedule_date ASC, bs.departure_time ASC
          `;

    const schedules = await client.query(query, params);

    res.json({ success: true, schedules: schedules.rows.map((row) => ({ ...row, price: Number(row.price) })) });
  } catch (error) {
    console.error('listSharedSchedules error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch schedules' });
  } finally {
    if (client) client.release();
  }
};

const searchSharedSchedules = async (req, res) => {
  let client;
  try {
    const routeId = (req.query.route_id || '').toString().trim();
    const date = (req.query.date || '').toString().trim();
    const fromStop = (req.query.from_stop || '').toString().trim();
    const toStop = (req.query.to_stop || '').toString().trim();

    if (!routeId || !date || !fromStop || !toStop) {
      return res.status(400).json({ success: false, message: 'route_id, date, from_stop and to_stop are required' });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    client = await pool.connect();
    const routeStops = await getStopsByRoute(client, routeId);
    if (routeStops.length < 2) {
      return res.status(400).json({ success: false, message: 'Route has insufficient stops configured' });
    }

    const fromSeq = findStopSequence(routeStops, fromStop);
    const toSeq = findStopSequence(routeStops, toStop);
    if (fromSeq < 0 || toSeq < 0 || fromSeq >= toSeq) {
      return res.status(400).json({ success: false, message: 'Invalid from_stop/to_stop segment' });
    }

    const tableName = await getScheduleTableName(client);
    const schedulesQuery =
      tableName === 'bus_schedules'
        ? `
            SELECT
              bs.schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.date,
              bs.time,
              bs.capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.plate_number,
              b.status AS bus_status,
              rr.from_location,
              rr.to_location,
              rr.price
            FROM bus_schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
            WHERE bs.route_id = $1::text
              AND bs.date::date = $2::date
              AND COALESCE(bs.status, 'scheduled') IN ('scheduled', 'in_progress')
          `
        : `
            SELECT
              bs.id AS schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.company_id,
              bs.schedule_date AS date,
              bs.departure_time AS time,
              COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.plate_number,
              b.status AS bus_status,
              rr.from_location,
              rr.to_location,
              rr.price
            FROM schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id::text
            WHERE bs.route_id::text = $1::text
              AND bs.schedule_date::date = $2::date
              AND COALESCE(bs.status, 'scheduled') IN ('scheduled', 'in_progress')
          `;

    const schedulesResult = await client.query(schedulesQuery, [routeId, date]);

    const directPrice = await getSegmentFare(client, fromStop, toStop, date);
    if (directPrice === null) {
      return res.status(400).json({
        success: false,
        message: 'No active RURA tariff found for the selected segment'
      });
    }

    const schedules = [];
    for (const schedule of schedulesResult.rows) {
      const occupancy = await getScheduleOccupancy(client, schedule.schedule_id, routeStops, fromStop, toStop);
      const capacity = toInt(schedule.capacity, 0);
      const occupiedCount = occupancy.occupiedSeats.size;
      const availableSeats = Math.max(capacity - occupiedCount, 0);

      const availableSeatNumbers = [];
      for (let seat = 1; seat <= capacity; seat += 1) {
        if (!occupancy.occupiedSeats.has(String(seat))) availableSeatNumbers.push(seat);
      }

      schedules.push({
        ...schedule,
        price: directPrice,
        full_route_price: Number(schedule.price),
        from_stop: fromStop,
        to_stop: toStop,
        available_seats: availableSeats,
        occupied_seats: occupiedCount,
        seat_options: availableSeatNumbers
      });
    }

    res.json({ success: true, schedules, stops: routeStops });
  } catch (error) {
    console.error('searchSharedSchedules error:', error);
    res.status(500).json({ success: false, message: 'Failed to search schedules' });
  } finally {
    if (client) client.release();
  }
};

// Returns all unique stop names from the route_stops table (used to populate search dropdowns)
const getAvailableStops = async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT DISTINCT stop_name FROM route_stops ORDER BY stop_name ASC`
    );
    res.json({ success: true, stops: result.rows.map((r) => r.stop_name) });
  } catch (error) {
    // If route_stops table doesn't exist yet, return empty list gracefully
    if (error && error.code === '42P01') {
      return res.json({ success: true, stops: [] });
    }
    console.error('getAvailableStops error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stops' });
  } finally {
    if (client) client.release();
  }
};

const searchTrips = async (req, res) => {
  let client;
  try {
    const from = (req.query.from || req.query.from_stop || '').toString().trim();
    const to = (req.query.to || req.query.to_stop || '').toString().trim();
    const date = (req.query.date || '').toString().trim();

    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to are required' });
    }
    if (date && !isValidDate(date)) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    client = await pool.connect();

    // Step 1: Find all routes where both stops exist with the correct ordering
    const matchingRoutes = await client.query(
      `
        SELECT
          rs_from.route_id,
          rs_from.stop_name AS from_stop,
          rs_to.stop_name   AS to_stop,
          rs_from.sequence  AS from_sequence,
          rs_to.sequence    AS to_sequence
        FROM route_stops rs_from
        INNER JOIN route_stops rs_to
          ON rs_to.route_id::text = rs_from.route_id::text
        WHERE LOWER(TRIM(rs_from.stop_name)) = LOWER(TRIM($1))
          AND LOWER(TRIM(rs_to.stop_name))   = LOWER(TRIM($2))
          AND rs_from.sequence < rs_to.sequence
      `,
      [from, to]
    );

    if (!matchingRoutes.rows.length) {
      return res.json({ success: true, trips: [] });
    }

    const tableName = await getScheduleTableName(client);
    const trips = [];

    for (const routeMatch of matchingRoutes.rows) {
      const routeStops = await getStopsByRoute(client, routeMatch.route_id);

      // Step 2: Build schedule query — include company name via LEFT JOIN
      const selectPart =
        tableName === 'bus_schedules'
          ? `
              SELECT
                bs.schedule_id,
                bs.bus_id,
                bs.route_id,
                bs.date,
                bs.time,
                bs.capacity,
                COALESCE(bs.status, 'scheduled') AS status,
                b.plate_number,
                b.status AS bus_status,
                rr.from_location,
                rr.to_location,
                rr.price AS route_price,
                c.name  AS company_name
              FROM bus_schedules bs
              INNER JOIN buses b       ON b.id = bs.bus_id
              INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
              LEFT  JOIN companies c   ON c.id::text = bs.company_id::text
            `
          : `
              SELECT
                bs.id AS schedule_id,
                bs.bus_id,
                bs.route_id,
                bs.schedule_date AS date,
                bs.departure_time AS time,
                COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
                COALESCE(bs.status, 'scheduled') AS status,
                b.plate_number,
                b.status AS bus_status,
                rr.from_location,
                rr.to_location,
                rr.price AS route_price,
                c.name   AS company_name
              FROM schedules bs
              INNER JOIN buses b        ON b.id = bs.bus_id
              INNER JOIN rura_routes rr ON rr.id::text = bs.route_id::text
              LEFT  JOIN companies c    ON c.id::text = bs.company_id::text
            `;

      const whereConditions = [
        `bs.route_id::text = $1::text`,
        `COALESCE(bs.status, 'scheduled') IN ('scheduled', 'in_progress')`,
        `UPPER(b.status::text) = 'ACTIVE'`,
      ];
      const queryParams = [routeMatch.route_id];

      const dateCol = tableName === 'bus_schedules' ? 'bs.date' : 'bs.schedule_date';
      const timeCol = tableName === 'bus_schedules' ? 'bs.time' : 'bs.departure_time';
      if (date) {
        queryParams.push(date);
        whereConditions.push(`${dateCol}::date = $${queryParams.length}::date`);
      } else {
        // Without a date filter, only show upcoming schedules
        whereConditions.push(`${dateCol}::date >= CURRENT_DATE`);
      }

      // Schedules are not bookable once departure time is reached.
      whereConditions.push(
        `(
          ${dateCol}::date > (NOW() AT TIME ZONE 'Africa/Kigali')::date
          OR (
            ${dateCol}::date = (NOW() AT TIME ZONE 'Africa/Kigali')::date
            AND ${timeCol}::time > (NOW() AT TIME ZONE 'Africa/Kigali')::time
          )
        )`
      );

      const orderCol = tableName === 'bus_schedules' ? 'bs.date, bs.time' : 'bs.schedule_date, bs.departure_time';
      const schedulesResult = await client.query(
        `${selectPart} WHERE ${whereConditions.join(' AND ')} ORDER BY ${orderCol} ASC`,
        queryParams
      );

      if (!schedulesResult.rows.length) continue;

      // Step 3: Determine segment price
      // Primary: direct RURA tariff for this exact from→to pair
      // Fallback: proportional slice of the full route price
      let segmentPrice = await getSegmentFare(client, routeMatch.from_stop, routeMatch.to_stop, date || null);
      if (segmentPrice === null && routeStops.length >= 2) {
        const routeBasePrice = Number(schedulesResult.rows[0].route_price) || 0;
        if (routeBasePrice > 0) {
          const totalSegments = routeStops.length - 1;
          const segmentsTraveled = routeMatch.to_sequence - routeMatch.from_sequence;
          segmentPrice = Math.round((routeBasePrice * segmentsTraveled) / totalSegments);
        }
      }

      // Step 4: Compute seat availability per schedule for this segment
      for (const schedule of schedulesResult.rows) {
        const occupancy = await getScheduleOccupancy(
          client,
          schedule.schedule_id,
          routeStops,
          routeMatch.from_stop,
          routeMatch.to_stop
        );
        const capacity = toInt(schedule.capacity, 0);
        const availableSeats = Math.max(capacity - occupancy.occupiedSeats.size, 0);
        if (availableSeats <= 0) continue;

        const seatOptions = [];
        for (let seat = 1; seat <= capacity; seat += 1) {
          if (!occupancy.occupiedSeats.has(String(seat))) seatOptions.push(seat);
        }

        const departureDate = schedule.date ? String(schedule.date).slice(0, 10) : null;
        const departureTime = schedule.time ? String(schedule.time).slice(0, 5) : null;

        trips.push({
          schedule_id: schedule.schedule_id,
          route_id: schedule.route_id,
          bus_id: schedule.bus_id,
          bus_plate: schedule.plate_number || 'N/A',
          company_name: schedule.company_name || 'N/A',
          departure_date: departureDate,
          departure_time: departureTime,
          status: schedule.status,
          pickup_stop: routeMatch.from_stop,
          dropoff_stop: routeMatch.to_stop,
          from_location: schedule.from_location,
          to_location: schedule.to_location,
          capacity,
          available_seats: availableSeats,
          seat_options: seatOptions,
          price: segmentPrice !== null ? segmentPrice : (Number(schedule.route_price) || 0),
        });
      }
    }

    trips.sort((a, b) => {
      const da = `${a.departure_date || ''} ${a.departure_time || ''}`;
      const db = `${b.departure_date || ''} ${b.departure_time || ''}`;
      return da.localeCompare(db);
    });

    res.json({ success: true, trips });
  } catch (error) {
    console.error('searchTrips error:', error);
    res.status(500).json({ success: false, message: 'Failed to search trips' });
  } finally {
    if (client) client.release();
  }
};

const getAvailableSeats = async (req, res) => {
  let client;
  try {
    const scheduleId = (req.query.schedule_id || req.query.scheduleId || '').toString().trim();
    const fromStop = (req.query.from || req.query.from_stop || '').toString().trim();
    const toStop = (req.query.to || req.query.to_stop || '').toString().trim();

    if (!scheduleId || !fromStop || !toStop) {
      return res.status(400).json({ success: false, message: 'schedule_id, from and to are required' });
    }

    client = await pool.connect();
    const scheduleTable = await getScheduleTableName(client);
    const scheduleResult = await client.query(
      scheduleTable === 'bus_schedules'
        ? `
            SELECT
              bs.schedule_id,
              bs.route_id,
              bs.capacity,
              COALESCE(bs.status, 'scheduled') AS status
            FROM bus_schedules bs
            WHERE bs.schedule_id::text = $1::text
          `
        : `
            SELECT
              bs.id AS schedule_id,
              bs.route_id,
              COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
              COALESCE(bs.status, 'scheduled') AS status
            FROM schedules bs
            WHERE bs.id::text = $1::text
          `,
      [scheduleId]
    );

    if (!scheduleResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    const schedule = scheduleResult.rows[0];
    const scheduleDeparted = await hasScheduleDeparturePassed(client, schedule.date, schedule.time);
    if (scheduleDeparted) {
      return res.status(400).json({ success: false, message: 'This trip has already departed' });
    }

    const routeStops = await getStopsByRoute(client, schedule.route_id);
    if (routeStops.length < 2) {
      return res.status(400).json({ success: false, message: 'Route stops are not configured' });
    }

    const occupancy = await getScheduleOccupancy(client, schedule.schedule_id, routeStops, fromStop, toStop);
    if (occupancy.fromSeq < 0 || occupancy.toSeq < 0 || occupancy.fromSeq >= occupancy.toSeq) {
      return res.status(400).json({ success: false, message: 'Dropoff must be after pickup on the same route' });
    }

    const capacity = toInt(schedule.capacity, 0);
    const seatNumbers = [];
    for (let seat = 1; seat <= capacity; seat += 1) {
      if (!occupancy.occupiedSeats.has(String(seat))) {
        seatNumbers.push(seat);
      }
    }

    res.json({
      success: true,
      schedule_id: schedule.schedule_id,
      from_stop: fromStop,
      to_stop: toStop,
      total_seats: capacity,
      available_seats: seatNumbers.length,
      seat_numbers: seatNumbers
    });
  } catch (error) {
    console.error('getAvailableSeats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available seats' });
  } finally {
    if (client) client.release();
  }
};

const bookTicket = async (req, res) => {
  const fromStop = (req.body.from_stop || req.body.from || req.body.pickup_stop || '').toString().trim();
  const toStop = (req.body.to_stop || req.body.to || req.body.dropoff_stop || '').toString().trim();
  req.body = {
    ...req.body,
    from_stop: fromStop,
    to_stop: toStop
  };
  return bookSharedTicket(req, res);
};

const bookSharedTicket = async (req, res) => {
  let client;
  try {
    const { schedule_id, from_stop, to_stop, seat_number, passenger_name } = req.body;
    if (!schedule_id || !from_stop || !to_stop) {
      return res.status(400).json({ success: false, message: 'schedule_id, from_stop and to_stop are required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

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
              b.plate_number,
              rr.price
            FROM bus_schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
            WHERE bs.schedule_id::text = $1::text
            FOR UPDATE
          `
        : `
            SELECT
              bs.id AS schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.schedule_date AS date,
              bs.departure_time AS time,
              COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.status AS bus_status,
              b.plate_number,
              rr.price
            FROM schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id::text
            WHERE bs.id::text = $1::text
            FOR UPDATE
          `,
      [schedule_id]
    );

    if (!scheduleResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    const schedule = scheduleResult.rows[0];
    const scheduleDeparted = await hasScheduleDeparturePassed(client, schedule.date, schedule.time);
    if (scheduleDeparted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'This trip has already departed' });
    }

    if ((schedule.status || '').toLowerCase() === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Schedule is cancelled' });
    }
    if ((schedule.bus_status || '').toLowerCase() !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Assigned bus is not active' });
    }

    const routeStops = await getStopsByRoute(client, schedule.route_id);
    if (routeStops.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Route stops are not configured' });
    }

    const occupancy = await getScheduleOccupancy(client, schedule.schedule_id, routeStops, from_stop, to_stop);
    if (occupancy.fromSeq < 0 || occupancy.toSeq < 0 || occupancy.fromSeq >= occupancy.toSeq) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid boarding segment' });
    }

    const capacity = toInt(schedule.capacity, 0);
    if (occupancy.occupiedSeats.size >= capacity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No seats available for selected segment' });
    }

    const seatInventory = await client.query(
      `
        SELECT seat_number, COALESCE(is_driver, false) AS is_driver
        FROM seats
        WHERE bus_id::text = $1::text
      `,
      [schedule.bus_id]
    );
    const seatMetaByNumber = new Map(
      seatInventory.rows.map((row) => [String(row.seat_number), Boolean(row.is_driver)])
    );

    let selectedSeat = seat_number ? String(seat_number) : null;
    if (selectedSeat) {
      const parsedSeat = Number(selectedSeat);
      if (!Number.isInteger(parsedSeat) || parsedSeat < 1 || parsedSeat > capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Selected seat_number is out of range' });
      }
    }

    if (selectedSeat && seatMetaByNumber.get(selectedSeat) === true) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Driver seat cannot be booked' });
    }

    if (selectedSeat && occupancy.occupiedSeats.has(selectedSeat)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Selected seat is not available for this segment' });
    }

    if (!selectedSeat) {
      for (let seat = 1; seat <= capacity; seat += 1) {
        const candidate = String(seat);
        if (!occupancy.occupiedSeats.has(candidate) && seatMetaByNumber.get(candidate) !== true) {
          selectedSeat = candidate;
          break;
        }
      }
    }

    if (!selectedSeat) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No passenger seats available for selected segment' });
    }

    const passengerId = req.userId || req.body.passenger_id || null;

    const segPrice = await getSegmentFare(client, from_stop, to_stop, schedule.date);
    if (segPrice === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No active RURA tariff found for the selected segment'
      });
    }

    const ticketColumns = await getTableColumns(client, 'tickets');
    const insertCols = [];
    const insertVals = [];
    const params = [];
    const add = (col, val) => {
      if (!ticketColumns.has(col)) return;
      insertCols.push(col);
      params.push(val);
      insertVals.push(`$${params.length}`);
    };

    // Always generate a UUID for 'id' — the column has no DB-level DEFAULT
    const { randomUUID } = require('crypto');
    add('id', randomUUID());
    add('schedule_id', schedule.schedule_id);
    add('passenger_id', passengerId);
    add('company_id', schedule.company_id || null);
    add('route_id', schedule.route_id);
    add('trip_date', schedule.date ? String(schedule.date).slice(0, 10) : null);
    add('from_stop', from_stop);
    add('to_stop', to_stop);
    add('from_sequence', occupancy.fromSeq);
    add('to_sequence', occupancy.toSeq);
    add('seat_number', selectedSeat);
    add('price', segPrice);
    add('passenger_name', passenger_name || null);
    add('status', 'CONFIRMED');
    add('booking_ref', `SHR-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    add('booked_at', new Date());
    add('created_at', new Date());
    add('updated_at', new Date());

    if (!insertCols.includes('schedule_id') || !insertCols.includes('seat_number')) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, message: 'Tickets schema missing required columns for shared booking' });
    }

    const returnCols = ['schedule_id', 'seat_number'];
    if (ticketColumns.has('id')) returnCols.unshift('id AS ticket_id');
    else if (ticketColumns.has('ticket_id')) returnCols.unshift('ticket_id');
    if (ticketColumns.has('booking_ref')) returnCols.push('booking_ref');
    if (ticketColumns.has('status')) returnCols.push('status');
    if (ticketColumns.has('price')) returnCols.push('price');
    if (ticketColumns.has('from_stop')) returnCols.push('from_stop');
    if (ticketColumns.has('to_stop')) returnCols.push('to_stop');

    const ticketIdResult = await client.query(
      `
        INSERT INTO tickets (${insertCols.join(', ')})
        VALUES (${insertVals.join(', ')})
        RETURNING ${returnCols.join(', ')}
      `,
      params
    );

    await client.query('COMMIT');

    // Update seat counts in bus_schedules (fire-and-forget style, non-blocking)
    (async () => {
      try {
        await pool.query(
          `UPDATE bus_schedules
           SET booked_seats = booked_seats + 1
           WHERE schedule_id::text = $1::text`,
          [schedule.schedule_id]
        );
      } catch (e) {
        console.error('Failed to update seat counts:', e.message);
      }
    })();

    // Send e-ticket email (fire-and-forget, does not block response)
    (async () => {
      try {
        const userResult = await pool.query(
          `SELECT email, COALESCE(full_name, email) AS name FROM users WHERE id::text = $1::text LIMIT 1`,
          [passengerId]
        );
        if (userResult.rows.length) {
          const u = userResult.rows[0];
          if (!u.email) return;
          const ticket = ticketIdResult.rows[0];
          const depDate = schedule.date ? String(schedule.date).slice(0, 10) : '';
          const depTime = schedule.time ? String(schedule.time).slice(0, 5) : '';
          await sendETicketEmail({
            userEmail: u.email,
            userName: u.name || 'Valued Customer',
            tickets: [{
              id: ticket.ticket_id || ticket.id,
              seat_number: ticket.seat_number,
              booking_ref: ticket.booking_ref,
              price: ticket.price
            }],
            scheduleInfo: {
              origin: from_stop,
              destination: to_stop,
              schedule_date: depDate,
              departure_time: depTime,
              bus_plate: schedule.plate_number || ''
            },
            companyInfo: { name: 'SafariTix Transport' }
          });
        }
      } catch (e) {
        console.error('Failed to send e-ticket email:', e.message);
      }
    })();

    // In-app notifications — commuter + driver (fire-and-forget)
    if (passengerId) {
      (async () => {
        try {
          const ticket = ticketIdResult.rows[0];
          const depDate = schedule.date ? String(schedule.date).slice(0, 10) : '';
          const depTime = schedule.time ? String(schedule.time).slice(0, 5) : '';
          const dateStr = depDate ? ` on ${depDate}${depTime ? ' ' + depTime : ''}` : '';

          // Commuter name
          const userRes = await pool.query(
            `SELECT full_name FROM users WHERE id::text = $1::text LIMIT 1`,
            [passengerId]
          );
          const commuterName = userRes.rows[0]?.full_name || passenger_name || 'Passenger';

          // Notify commuter
          await NotificationService.createNotification(
            passengerId,
            'Ticket Confirmed',
            `Your ticket from ${from_stop} to ${to_stop}${dateStr} is confirmed. Seat: ${ticket.seat_number || '—'}. Ref: ${ticket.booking_ref || ticket.ticket_id || ''}`,
            'ticket_booked',
            { relatedId: ticket.ticket_id || ticket.id, relatedType: 'ticket' }
          );

          // Notify driver
          const busRes = await pool.query(
            `SELECT driver_id FROM buses WHERE id::text = $1::text LIMIT 1`,
            [schedule.bus_id]
          );
          const driverId = busRes.rows[0]?.driver_id;
          if (driverId) {
            await NotificationService.createNotification(
              driverId,
              'New Passenger Booked',
              `${commuterName} booked seat ${ticket.seat_number || '—'} on your bus for ${from_stop} → ${to_stop}${dateStr}.`,
              'ticket_booked',
              { relatedId: ticket.ticket_id || ticket.id, relatedType: 'ticket' }
            );
          }
        } catch (e) {
          console.error('[bookSharedTicket] notification error:', e.message);
        }
      })();
    }

    res.status(201).json({ success: true, ticket: ticketIdResult.rows[0] });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('bookSharedTicket error:', error);

    // PostgreSQL exclusion constraint violation (seat overlap conflict).
    if (error && error.code === '23P01') {
      return res.status(409).json({
        success: false,
        message: 'Selected seat is no longer available for this segment. Please choose another seat.'
      });
    }

    // PostgreSQL unique violation (e.g., duplicate booking_ref).
    if (error && error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Booking conflict detected. Please retry the booking.'
      });
    }

    res.status(500).json({ success: false, message: 'Failed to book ticket' });
  } finally {
    if (client) client.release();
  }
};

const confirmMobilePayment = async (req, res) => {
  let client;
  try {
    const schedule_id = req.body.schedule_id || req.body.scheduleId;
    const from_stop = (req.body.from_stop || req.body.from || req.body.pickup_stop || '').toString().trim();
    const to_stop = (req.body.to_stop || req.body.to || req.body.dropoff_stop || '').toString().trim();
    const passenger_name = (req.body.passenger_name || req.body.passengerName || '').toString().trim();
    const email = (req.body.email || '').toString().trim();
    const phone = (req.body.phone || req.body.phone_number || '').toString().trim();
    const rawSeats = Array.isArray(req.body.seat_numbers)
      ? req.body.seat_numbers
      : Array.isArray(req.body.seats)
        ? req.body.seats
        : [];

    const selectedSeats = Array.from(new Set(rawSeats.map((seat) => String(seat).trim()).filter(Boolean)));

    if (!schedule_id || !from_stop || !to_stop) {
      return res.status(400).json({
        success: false,
        message: 'schedule_id, from_stop and to_stop are required',
      });
    }

    if (selectedSeats.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'seat_numbers must contain at least one seat',
      });
    }

    const passenger = await ensureMobilePassenger({
      email,
      passengerName: passenger_name,
      phoneNumber: phone,
    });

    client = await pool.connect();
    await client.query('BEGIN');

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
              b.plate_number,
              rr.price
            FROM bus_schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
            WHERE bs.schedule_id::text = $1::text
            FOR UPDATE
          `
        : `
            SELECT
              bs.id AS schedule_id,
              bs.bus_id,
              bs.route_id,
              bs.schedule_date AS date,
              bs.departure_time AS time,
              COALESCE(bs.total_seats, bs.available_seats + bs.booked_seats) AS capacity,
              COALESCE(bs.status, 'scheduled') AS status,
              b.status AS bus_status,
              b.plate_number,
              rr.price
            FROM schedules bs
            INNER JOIN buses b ON b.id = bs.bus_id
            INNER JOIN rura_routes rr ON rr.id::text = bs.route_id::text
            WHERE bs.id::text = $1::text
            FOR UPDATE
          `,
      [schedule_id]
    );

    if (!scheduleResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    const schedule = scheduleResult.rows[0];
    const scheduleDeparted = await hasScheduleDeparturePassed(client, schedule.date, schedule.time);
    if (scheduleDeparted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'This trip has already departed' });
    }

    if ((schedule.status || '').toLowerCase() === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Schedule is cancelled' });
    }
    if ((schedule.bus_status || '').toLowerCase() !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Assigned bus is not active' });
    }

    const routeStops = await getStopsByRoute(client, schedule.route_id);
    if (routeStops.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Route stops are not configured' });
    }

    const occupancy = await getScheduleOccupancy(client, schedule.schedule_id, routeStops, from_stop, to_stop);
    if (occupancy.fromSeq < 0 || occupancy.toSeq < 0 || occupancy.fromSeq >= occupancy.toSeq) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid boarding segment' });
    }

    const capacity = toInt(schedule.capacity, 0);
    if (occupancy.occupiedSeats.size >= capacity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No seats available for selected segment' });
    }

    const seatInventory = await client.query(
      `
        SELECT seat_number, COALESCE(is_driver, false) AS is_driver
        FROM seats
        WHERE bus_id::text = $1::text
      `,
      [schedule.bus_id]
    );
    const seatMetaByNumber = new Map(
      seatInventory.rows.map((row) => [String(row.seat_number), Boolean(row.is_driver)])
    );

    const segPrice = await getSegmentFare(client, from_stop, to_stop, schedule.date);
    if (segPrice === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No active RURA tariff found for the selected segment',
      });
    }

    const totalAmount = Number(segPrice) * selectedSeats.length;
    const paymentColumns = await getTableColumns(client, 'payments');
    const paymentRef = `MOB-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const { randomUUID } = require('crypto');
    const paymentCols = [];
    const paymentVals = [];
    const paymentParams = [];
    const addPaymentCol = (col, val) => {
      if (!paymentColumns.has(col)) return;
      paymentCols.push(col);
      paymentParams.push(val);
      paymentVals.push(`$${paymentParams.length}`);
    };

    addPaymentCol('id', randomUUID());
    addPaymentCol('user_id', passenger.id);
    addPaymentCol('schedule_id', schedule.schedule_id);
    addPaymentCol('payment_method', 'mobile_money');
    addPaymentCol('phone_or_card', phone || email);
    addPaymentCol('amount', totalAmount);
    addPaymentCol('status', 'success');
    addPaymentCol('booking_status', 'paid');
    addPaymentCol('transaction_ref', paymentRef);
    addPaymentCol('provider_name', 'mobile');
    addPaymentCol('provider_reference', paymentRef);
    addPaymentCol('provider_status', 'success');
    addPaymentCol('currency', 'RWF');
    addPaymentCol('seat_numbers', JSON.stringify(selectedSeats));
    addPaymentCol('meta', JSON.stringify({
      source: 'mobile_confirm_payment',
      from_stop,
      to_stop,
      passenger_name: passenger_name || passenger.full_name || 'Mobile Passenger',
      passenger_email: email,
      passenger_phone: phone || null,
      route_id: schedule.route_id,
      bus_id: schedule.bus_id,
      schedule_source: scheduleTable,
      trip_date: schedule.date ? String(schedule.date).slice(0, 10) : null,
    }));
    addPaymentCol('completed_at', new Date());
    addPaymentCol('created_at', new Date());
    addPaymentCol('updated_at', new Date());

    const paymentInsert = await client.query(
      `
        INSERT INTO payments (${paymentCols.join(', ')})
        VALUES (${paymentVals.join(', ')})
        RETURNING *
      `,
      paymentParams
    );
    const payment = paymentInsert.rows[0];

    const scheduleInfo = {
      origin: from_stop,
      destination: to_stop,
      schedule_date: schedule.date ? String(schedule.date).slice(0, 10) : null,
      departure_time: schedule.time ? String(schedule.time).slice(0, 5) : null,
      bus_plate: schedule.plate_number || null,
    };

    const bookedTickets = [];
    const occupiedSeats = new Set(occupancy.occupiedSeats);
    const ticketColumns = await getTableColumns(client, 'tickets');
    for (const rawSeat of selectedSeats) {
      const selectedSeat = String(rawSeat);
      const parsedSeat = Number(selectedSeat);

      if (!Number.isInteger(parsedSeat) || parsedSeat < 1 || parsedSeat > capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Seat ${selectedSeat} is out of range` });
      }

      if (seatMetaByNumber.get(selectedSeat) === true) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Seat ${selectedSeat} cannot be booked` });
      }

      if (occupiedSeats.has(selectedSeat)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: `Selected seat ${selectedSeat} is not available for this segment`,
        });
      }

      const insertCols = [];
      const insertVals = [];
      const params = [];
      const add = (col, val) => {
        if (!ticketColumns.has(col)) return;
        insertCols.push(col);
        params.push(val);
        insertVals.push(`$${params.length}`);
      };

      add('id', randomUUID());
      add('passenger_id', passenger.id);
      add('schedule_id', schedule.schedule_id);
      add('company_id', schedule.company_id || null);
      add('route_id', schedule.route_id);
      add('trip_date', schedule.date ? String(schedule.date).slice(0, 10) : null);
      add('from_stop', from_stop);
      add('to_stop', to_stop);
      add('from_sequence', occupancy.fromSeq);
      add('to_sequence', occupancy.toSeq);
      add('seat_number', selectedSeat);
      add('price', segPrice);
      add('passenger_name', passenger_name || passenger.full_name || 'Mobile Passenger');
      add('status', 'CONFIRMED');
      add('booking_ref', `MOB-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
      add('payment_id', payment.id);
      add('booked_at', new Date());
      add('created_at', new Date());
      add('updated_at', new Date());

      if (!insertCols.includes('passenger_id') || !insertCols.includes('schedule_id') || !insertCols.includes('seat_number') || !insertCols.includes('payment_id')) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, message: 'Tickets schema is missing required columns' });
      }

      const ticketResult = await client.query(
        `
          INSERT INTO tickets (${insertCols.join(', ')})
          VALUES (${insertVals.join(', ')})
          RETURNING *
        `,
        params
      );

      const ticket = ticketResult.rows[0];
      const ticketQrData = {
        bookingId: payment.id,
        bookingRef: payment.transaction_ref || payment.id,
        userId: passenger.id,
        ticketId: ticket.id,
        ticketNumber: ticket.booking_ref || ticket.id,
        from: from_stop,
        to: to_stop,
        seatNumber: ticket.seat_number,
        seatNumbers: selectedSeats.map((seat) => String(seat)),
        seats: selectedSeats.map((seat) => String(seat)),
        date: scheduleInfo.schedule_date,
        bus: scheduleInfo.bus_plate,
      };
      const ticketQrCodeUrl = await QRCode.toDataURL(JSON.stringify(ticketQrData), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
      });

      if (ticketColumns.has('qr_code_url')) {
        await client.query(
          'UPDATE tickets SET qr_code_url = $1, updated_at = NOW() WHERE id = $2',
          [ticketQrCodeUrl, ticket.id]
        );
      }

      ticket.qr_code_url = ticketQrCodeUrl;
      ticket.qr_data = ticketQrData;
      bookedTickets.push(ticket);
      occupiedSeats.add(selectedSeat);
    }

    await client.query('COMMIT');

    sendETicketEmail({
      userEmail: email,
      userName: passenger_name || passenger.full_name || 'Mobile Passenger',
      tickets: bookedTickets,
      scheduleInfo,
      companyInfo: { name: 'SafariTix Transport' },
      bookingId: payment.id,
      userId: passenger.id,
    }).catch((err) => {
      console.error('[confirmMobilePayment] e-ticket email error:', err.message);
    });

    return res.status(200).json({
      success: true,
      booking: {
        bookingId: payment.id,
        booking_ref: bookedTickets[0]?.booking_ref || null,
        from: from_stop,
        to: to_stop,
        seats: bookedTickets.map((ticket) => ticket.seat_number).filter(Boolean),
        departure_date: scheduleInfo.schedule_date,
        departure_time: scheduleInfo.departure_time,
        bus_plate: scheduleInfo.bus_plate,
        email,
        phone,
      },
      tickets: bookedTickets.map((ticket) => ({
        id: ticket.id,
        ticketId: ticket.id,
        booking_ref: ticket.booking_ref,
        bookingRef: ticket.booking_ref,
        seat_number: ticket.seat_number,
        seatNumber: ticket.seat_number,
        ticketNumber: ticket.booking_ref || ticket.id,
        bookingId: payment.id,
        bookingRef: payment.transaction_ref || payment.id,
        qrData: ticket.qr_data,
        qr_code_url: ticket.qr_code_url,
        qrCodeUrl: ticket.qr_code_url,
      })),
      qrData: bookedTickets[0]?.qr_data || null,
      qrCodeUrl: bookedTickets[0]?.qr_code_url || null,
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
    console.error('confirmMobilePayment error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: 'Failed to confirm mobile payment',
      message: error.message || 'An unexpected error occurred',
    });
  } finally {
    if (client) client.release();
  }
};

const getGuestTickets = async (req, res) => {
  let client;
  try {
    const email = String(req.query.email || req.body?.email || '').trim();
    const bookingId = String(req.query.bookingId || req.query.booking_id || req.body?.bookingId || req.body?.booking_id || '').trim();
    const bookingRef = String(req.query.bookingRef || req.query.booking_ref || req.body?.bookingRef || req.body?.booking_ref || '').trim();
    const bookingLookup = bookingId || bookingRef;

    if (!email || !bookingLookup) {
      return res.status(400).json({
        success: false,
        message: 'email and bookingId are required',
      });
    }

    client = await pool.connect();

    const bookingResult = await client.query(
      `
        SELECT
          p.id AS booking_id,
          p.transaction_ref,
          p.amount,
          p.booking_status,
          p.status AS payment_status,
          p.schedule_id,
          p.meta,
          u.id AS passenger_id,
          u.full_name AS passenger_name,
          u.email AS passenger_email,
          u.phone_number AS passenger_phone
        FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE (p.id::text = $1::text OR LOWER(COALESCE(p.transaction_ref, '')) = LOWER($1))
          AND LOWER(u.email) = LOWER($2)
        LIMIT 1
      `,
      [bookingLookup, email]
    );

    if (!bookingResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'No booking found for the provided email and booking ID',
      });
    }

    const booking = bookingResult.rows[0];
    const ticketResult = await client.query(
      `
        SELECT
          t.id,
          t.booking_ref,
          t.seat_number,
          t.price,
          t.status,
          t.qr_code_url,
          t.payment_id,
          t.schedule_id,
          COALESCE(r.origin, rr.from_location, t.from_stop, '') AS route_from,
          COALESCE(r.destination, rr.to_location, t.to_stop, '') AS route_to,
          COALESCE(s.schedule_date, bs.date) AS schedule_date,
          COALESCE(s.departure_time, bs.time) AS departure_time,
          b.id AS bus_id,
          b.plate_number AS bus_plate
        FROM tickets t
        LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses b ON b.id = COALESCE(s.bus_id, bs.bus_id)
        WHERE t.payment_id::text = $1::text
        ORDER BY
          CASE WHEN t.seat_number ~ '^[0-9]+$' THEN t.seat_number::int END ASC NULLS LAST,
          t.created_at ASC
      `,
      [booking.booking_id]
    );

    const tickets = ticketResult.rows.map((ticket) => {
      const qrData = {
        bookingId: booking.booking_id,
        bookingRef: booking.transaction_ref || booking.booking_id,
        userId: booking.passenger_id,
        ticketId: ticket.id,
        ticketNumber: ticket.booking_ref || ticket.id,
        from: ticket.route_from || null,
        to: ticket.route_to || null,
        seatNumber: ticket.seat_number || null,
        seatNumbers: ticket.seat_number ? [String(ticket.seat_number)] : [],
        seats: ticket.seat_number ? [String(ticket.seat_number)] : [],
        date: ticket.schedule_date ? String(ticket.schedule_date).slice(0, 10) : null,
        bus: ticket.bus_plate || null,
      };

      return {
        id: ticket.id,
        ticketId: ticket.id,
        bookingId: booking.booking_id,
        bookingRef: booking.transaction_ref || booking.booking_id,
        booking_ref: ticket.booking_ref,
        ticketNumber: ticket.booking_ref || ticket.id,
        seat_number: ticket.seat_number,
        seatNumber: ticket.seat_number,
        routeFrom: ticket.route_from || 'N/A',
        routeTo: ticket.route_to || 'N/A',
        departureDate: ticket.schedule_date ? String(ticket.schedule_date).slice(0, 10) : null,
        departureTime: ticket.departure_time ? String(ticket.departure_time).slice(0, 5) : null,
        busId: ticket.bus_id || null,
        busPlate: ticket.bus_plate || null,
        scheduleId: ticket.schedule_id || booking.schedule_id || null,
        qrData,
        qrCodeUrl: ticket.qr_code_url || null,
      };
    });

    return res.json({
      success: true,
      booking: {
        bookingId: booking.booking_id,
        bookingRef: booking.transaction_ref || booking.booking_id,
        email: booking.passenger_email,
        phone: booking.passenger_phone,
      },
      tickets,
    });
  } catch (error) {
    console.error('getGuestTickets error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch guest tickets',
    });
  } finally {
    if (client) client.release();
  }
};

const getGuestBookingLocation = async (req, res) => {
  let client;
  try {
    const email = String(req.query.email || req.body?.email || '').trim();
    const bookingId = String(req.params.bookingId || req.query.bookingId || req.query.booking_id || req.body?.bookingId || '').trim();
    const bookingRef = String(req.query.bookingRef || req.query.booking_ref || req.body?.bookingRef || req.body?.booking_ref || '').trim();
    const bookingLookup = bookingId || bookingRef;

    if (!email || !bookingLookup) {
      return res.status(400).json({
        success: false,
        message: 'email and bookingId are required',
      });
    }

    client = await pool.connect();
    const bookingResult = await client.query(
      `
        SELECT
          p.id AS booking_id,
          p.transaction_ref,
          p.schedule_id,
          u.id AS passenger_id,
          u.full_name AS passenger_name,
          u.email AS passenger_email
        FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE (p.id::text = $1::text OR LOWER(COALESCE(p.transaction_ref, '')) = LOWER($1))
          AND LOWER(u.email) = LOWER($2)
        LIMIT 1
      `,
      [bookingLookup, email]
    );

    if (!bookingResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    const ticketResult = await client.query(
      `
        SELECT
          t.id,
          t.booking_ref,
          t.seat_number,
          t.status,
          COALESCE(r.origin, rr.from_location, t.from_stop, '') AS route_from,
          COALESCE(r.destination, rr.to_location, t.to_stop, '') AS route_to,
          COALESCE(s.schedule_date, bs.date) AS schedule_date,
          COALESCE(s.departure_time, bs.time) AS departure_time,
          b.id AS bus_id,
          b.plate_number,
          COALESCE(s.schedule_id, bs.schedule_id) AS schedule_id
        FROM tickets t
        LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses b ON b.id = COALESCE(s.bus_id, bs.bus_id)
        WHERE t.payment_id::text = $1::text
        ORDER BY t.created_at ASC
        LIMIT 1
      `,
      [booking.booking_id]
    );

    const ticket = ticketResult.rows[0];
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found for booking' });
    }

    const tracking = await getLatestGuestLocationForBooking(
      client,
      ticket.schedule_id || booking.schedule_id || null,
      ticket.bus_id || null,
      ticket.route_from || null,
      ticket.route_to || null,
      ticket.schedule_date || null,
      ticket.departure_time || null
    );

    return res.json({
      success: true,
      booking: {
        bookingId: booking.booking_id,
        bookingRef: booking.transaction_ref || booking.booking_id,
        email: booking.passenger_email,
        name: booking.passenger_name,
        scheduleId: ticket.schedule_id || booking.schedule_id || null,
        busId: ticket.bus_id || null,
        busPlate: ticket.plate_number || null,
        from: ticket.route_from || 'N/A',
        to: ticket.route_to || 'N/A',
        seatNumber: ticket.seat_number || null,
      },
      ...tracking,
    });
  } catch (error) {
    console.error('getGuestBookingLocation error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch guest tracking location',
    });
  } finally {
    if (client) client.release();
  }
};

const updateSharedScheduleStatus = async (req, res) => {
  let client;
  try {
    const { scheduleId } = req.params;
    const status = (req.body.status || '').toString().trim().toLowerCase();
    if (!status) return res.status(400).json({ success: false, message: 'status is required' });

    client = await pool.connect();
    const tableName = await getScheduleTableName(client);
    const result = await client.query(
      tableName === 'bus_schedules'
        ? `
            UPDATE bus_schedules
            SET status = $1
            WHERE schedule_id::text = $2::text
            RETURNING schedule_id, status
          `
        : `
            UPDATE schedules
            SET status = $1
            WHERE id::text = $2::text
            RETURNING id AS schedule_id, status
          `,
      [status, scheduleId]
    );

    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Schedule not found' });
    res.json({ success: true, schedule: result.rows[0] });
  } catch (error) {
    console.error('updateSharedScheduleStatus error:', error);
    res.status(500).json({ success: false, message: 'Failed to update schedule status' });
  } finally {
    if (client) client.release();
  }
};

const getUserTickets = async (req, res) => {
  let client;
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    client = await pool.connect();
    const result = await client.query(
      `
        SELECT
          t.id            AS ticket_id,
          t.seat_number,
          t.booking_ref,
          t.price,
          t.status,
          t.from_stop,
          t.to_stop,
          t.created_at,
          t.booked_at,
          t.schedule_id,
          bs.date         AS schedule_date,
          bs.time         AS departure_time,
          b.plate_number  AS bus_plate,
          rr.from_location,
          rr.to_location
        FROM tickets t
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN buses b          ON b.id = bs.bus_id
        LEFT JOIN rura_routes rr   ON rr.id::text = bs.route_id
        WHERE t.passenger_id::text = $1::text
        ORDER BY t.created_at DESC, t.booked_at DESC
      `,
      [userId]
    );
    const tickets = result.rows.map((row) => ({
      id: row.ticket_id,
      ticket_id: row.ticket_id,
      schedule_id: row.schedule_id,
      scheduleId: row.schedule_id,
      seat_number: row.seat_number,
      booking_ref: row.booking_ref,
      price: row.price !== null ? Number(row.price) : null,
      status: row.status || 'CONFIRMED',
      from_stop: row.from_stop || row.from_location || 'N/A',
      to_stop: row.to_stop || row.to_location || 'N/A',
      schedule_date: row.schedule_date ? String(row.schedule_date).slice(0, 10) : null,
      departure_time: row.departure_time ? String(row.departure_time).slice(0, 5) : null,
      bus_plate: row.bus_plate || 'N/A',
      created_at: row.created_at || row.booked_at,
    }));
    res.json({ success: true, tickets });
  } catch (error) {
    console.error('getUserTickets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  listSharedRoutes,
  getRouteStops,
  upsertRouteStops,
  createSharedSchedule,
  listSharedSchedules,
  searchSharedSchedules,
  getAvailableStops,
  searchTrips,
  getAvailableSeats,
  bookTicket,
  bookSharedTicket,
  confirmMobilePayment,
  getGuestTickets,
  getGuestBookingLocation,
  getUserTickets,
  updateSharedScheduleStatus
};
