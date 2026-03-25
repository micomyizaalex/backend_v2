const { Ticket, User, Schedule, Bus, Route } = require('../models');
const pool = require('../config/pgPool');
const QRCode = require('qrcode');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseQrPayload = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return { ticketId: null, tripId: null };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const bookingId = parsed.bookingId || parsed.booking_id || null;
      const userId = parsed.userId || parsed.user_id || null;
      const from = parsed.from || null;
      const to = parsed.to || null;
      const seats = Array.isArray(parsed.seats) ? parsed.seats : [];
      const date = parsed.date || null;
      const bus = parsed.bus || null;

      return {
        ticketId: parsed.ticketId || parsed.ticket_id || parsed.id || parsed.bookingRef || parsed.booking_ref || null,
        tripId: parsed.tripId || parsed.trip_id || parsed.scheduleId || parsed.schedule_id || null,
        booking: (bookingId || userId || from || to || seats.length || date || bus)
          ? { bookingId, userId, from, to, seats, date, bus }
          : null,
      };
    }
  } catch {
    // Non-JSON payloads fall through to URL/plain-text extraction.
  }

  const urlMatch = text.match(/\/scan\/([^/?#\s]+)/i);
  if (urlMatch) {
    return { ticketId: decodeURIComponent(urlMatch[1]), tripId: null };
  }

  return { ticketId: text, tripId: null };
};

const makeBookingRef = () => `BK-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const makeTicketId = () => (typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }));

const toSeatArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((seat) => String(seat).trim()).filter(Boolean);
};

const resolveScanDriverId = async (client, userId) => {
  if (!userId) return null;

  const legacyDriver = await client.query(
    `
      SELECT id
      FROM drivers
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  ).catch(() => ({ rows: [] }));

  if (legacyDriver.rows[0]?.id) {
    return legacyDriver.rows[0].id;
  }

  return userId;
};

const generateTicketQrDataUrl = async ({ ticketId, tripId, seatNumber, commuterId, bookingRef }) => {
  const payload = {
    ticket_id: ticketId,
    ticketId,
    trip_id: tripId,
    tripId,
    schedule_id: tripId,
    seat_number: seatNumber,
    seat: seatNumber,
    commuter_id: commuterId,
    commuterId,
    booking_ref: bookingRef,
    issued_at: new Date().toISOString(),
  };

  return QRCode.toDataURL(JSON.stringify(payload), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });
};

/**
 * Verify ticket by ID or booking reference
 * Used for QR code scanning at boarding
 * GET /api/tickets/verify/:identifier
 */
const verifyTicket = async (req, res) => {
  try {
    const { identifier } = req.params; // Can be ticket ID, booking ref, or QR payload
    
    console.log('[verifyTicket] Verifying:', identifier);
    
    // Try to parse QR data if it's JSON
    let searchCriteria = {};
    try {
      const qrData = JSON.parse(identifier);
      if (qrData.ticketId) {
        searchCriteria.id = qrData.ticketId;
      } else if (qrData.bookingRef) {
        searchCriteria.booking_ref = qrData.bookingRef;
      }
    } catch (e) {
      // Not JSON, treat as ticket ID or booking ref
      // Check if it's a UUID pattern or booking ref pattern
      if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        searchCriteria.id = identifier;
      } else {
        searchCriteria.booking_ref = identifier;
      }
    }
    
    // Query ticket with all details
    const client = await pool.connect();
    try {
      const ticketQuery = await client.query(`
        SELECT 
          t.id,
          t.booking_ref,
          t.seat_number,
          t.price,
          t.status,
          t.booked_at,
          t.checked_in_at,
          t.passenger_id,
          u.full_name as passenger_name,
          u.email as passenger_email,
          u.phone_number as passenger_phone,
          s.schedule_date,
          s.departure_time,
          s.arrival_time,
          r.origin,
          r.destination,
          r.name as route_name,
          b.plate_number as bus_number,
          b.seats_count as bus_capacity,
          c.name as company_name
        FROM tickets t
        INNER JOIN users u ON t.passenger_id = u.id
        INNER JOIN schedules s ON t.schedule_id = s.id
        INNER JOIN routes r ON s.route_id = r.id
        INNER JOIN buses b ON s.bus_id = b.id
        INNER JOIN companies c ON t.company_id = c.id
        WHERE ${searchCriteria.id ? 't.id = $1' : 't.booking_ref = $1'}
      `, [searchCriteria.id || searchCriteria.booking_ref]);
      
      if (ticketQuery.rows.length === 0) {
        return res.status(404).json({
          valid: false,
          status: 'NOT_FOUND',
          message: 'Ticket not found. Please check the ticket ID or booking reference.',
          timestamp: new Date().toISOString()
        });
      }
      
      const ticket = ticketQuery.rows[0];
      
      // Check ticket status
      if (ticket.status === 'CANCELLED') {
        return res.status(200).json({
          valid: false,
          status: 'CANCELLED',
          message: 'This ticket has been cancelled.',
          ticket: {
            bookingRef: ticket.booking_ref,
            passengerName: ticket.passenger_name,
            seatNumber: ticket.seat_number
          },
          timestamp: new Date().toISOString()
        });
      }
      
      if (ticket.status === 'PENDING_PAYMENT') {
        return res.status(200).json({
          valid: false,
          status: 'PENDING_PAYMENT',
          message: 'Payment is pending for this ticket.',
          ticket: {
            bookingRef: ticket.booking_ref,
            passengerName: ticket.passenger_name,
            seatNumber: ticket.seat_number
          },
          timestamp: new Date().toISOString()
        });
      }
      
      // Check if already checked in
      const alreadyCheckedIn = ticket.status === 'CHECKED_IN';
      
      // Valid ticket (CONFIRMED or CHECKED_IN)
      return res.status(200).json({
        valid: true,
        status: ticket.status,
        message: alreadyCheckedIn 
          ? 'Ticket already checked in.' 
          : 'Ticket is valid and ready for boarding.',
        ticket: {
          id: ticket.id,
          bookingRef: ticket.booking_ref,
          passengerName: ticket.passenger_name,
          passengerEmail: ticket.passenger_email,
          passengerPhone: ticket.passenger_phone,
          seatNumber: ticket.seat_number,
          price: parseFloat(ticket.price),
          bookedAt: ticket.booked_at,
          checkedInAt: ticket.checked_in_at,
          trip: {
            date: ticket.schedule_date,
            departureTime: ticket.departure_time,
            arrivalTime: ticket.arrival_time,
            origin: ticket.origin,
            destination: ticket.destination,
            routeName: ticket.route_name,
            busNumber: ticket.bus_number,
            busCapacity: ticket.bus_capacity
          },
          company: {
            name: ticket.company_name
          }
        },
        timestamp: new Date().toISOString()
      });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('[verifyTicket] Error:', error);
    return res.status(500).json({
      valid: false,
      status: 'ERROR',
      message: 'Failed to verify ticket. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * Check-in ticket (mark as boarded)
 * POST /api/tickets/check-in/:ticketId
 */
const checkInTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get ticket
      const ticketQuery = await client.query(
        'SELECT id, status, booking_ref, passenger_id FROM tickets WHERE id = $1 FOR UPDATE',
        [ticketId]
      );
      
      if (ticketQuery.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Ticket not found' });
      }
      
      const ticket = ticketQuery.rows[0];
      
      if (ticket.status !== 'CONFIRMED') {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Cannot check in ticket with status: ${ticket.status}`,
          currentStatus: ticket.status
        });
      }
      
      // Update ticket to CHECKED_IN
      await client.query(
        'UPDATE tickets SET status = $1, checked_in_at = NOW(), updated_at = NOW() WHERE id = $2',
        ['CHECKED_IN', ticketId]
      );
      
      await client.query('COMMIT');
      
      return res.status(200).json({
        success: true,
        message: 'Passenger checked in successfully',
        ticket: {
          id: ticket.id,
          bookingRef: ticket.booking_ref,
          status: 'CHECKED_IN',
          checkedInAt: new Date().toISOString()
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('[checkInTicket] Error:', error);
    return res.status(500).json({
      error: 'Failed to check in ticket',
      message: error.message
    });
  }
};

/**
 * Create confirmed ticket(s) without provider payment flow.
 * POST /api/tickets/create
 * body: { tripId, seats, userId? }
 */
const createTicket = async (req, res) => {
  let client;
  try {
    const userId = req.userId || req.body?.userId;
    const tripId = String(req.body?.tripId || req.body?.scheduleId || '').trim();
    const seatNumbers = toSeatArray(req.body?.seats || req.body?.selectedSeats);

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId is required' });
    }
    if (!seatNumbers.length) {
      return res.status(400).json({ success: false, message: 'At least one seat is required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const scheduleResult = await client.query(
      `
        SELECT
          COALESCE(s.id::text, bs.schedule_id::text) AS schedule_id,
          COALESCE(s.company_id::text, b.company_id::text) AS company_id,
          COALESCE(s.bus_id::text, bs.bus_id::text) AS bus_id,
          COALESCE(s.schedule_date::date, bs.date::date) AS schedule_date,
          COALESCE(s.departure_time::text, bs.time::text) AS departure_time,
          COALESCE(s.price_per_seat::numeric, rr.price::numeric, 0::numeric) AS price_per_seat,
          COALESCE(r.origin, rr.from_location) AS route_from,
          COALESCE(r.destination, rr.to_location) AS route_to,
          b.plate_number AS bus_plate
        FROM (
          SELECT $1::text AS trip_id
        ) x
        LEFT JOIN schedules s ON s.id::text = x.trip_id
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = x.trip_id
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses b ON b.id = COALESCE(s.bus_id, bs.bus_id)
        LIMIT 1
      `,
      [tripId]
    );

    const schedule = scheduleResult.rows[0];
    if (!schedule || !schedule.schedule_id || !schedule.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    const conflictResult = await client.query(
      `
        SELECT seat_number
        FROM tickets
        WHERE schedule_id::text = $1::text
          AND seat_number = ANY($2::text[])
          AND status::text = ANY($3::text[])
        FOR UPDATE
      `,
      [schedule.schedule_id, seatNumbers, ['CONFIRMED', 'CHECKED_IN']]
    );

    if (conflictResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Seat already booked: ${conflictResult.rows.map((r) => r.seat_number).join(', ')}`,
      });
    }

    const createdTickets = [];
    for (const seatNumber of seatNumbers) {
      const ticketId = makeTicketId();
      const bookingRef = makeBookingRef();
      const qrCodeUrl = await generateTicketQrDataUrl({
        ticketId,
        tripId: schedule.schedule_id,
        seatNumber,
        commuterId: userId,
        bookingRef,
      });

      const insertResult = await client.query(
        `
          INSERT INTO tickets (
            id, passenger_id, schedule_id, company_id,
            seat_number, booking_ref, qr_code_url, price,
            status, booked_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            'CONFIRMED', NOW(), NOW(), NOW()
          )
          RETURNING id, schedule_id, seat_number, booking_ref, qr_code_url, status, price, booked_at
        `,
        [
          ticketId,
          userId,
          schedule.schedule_id,
          schedule.company_id,
          seatNumber,
          bookingRef,
          qrCodeUrl,
          Number(schedule.price_per_seat || 0),
        ]
      );

      createdTickets.push({
        ticketId: insertResult.rows[0].id,
        tripId: String(insertResult.rows[0].schedule_id),
        commuterId: userId,
        seatNumber: insertResult.rows[0].seat_number,
        bookingRef: insertResult.rows[0].booking_ref,
        qrCodeUrl: insertResult.rows[0].qr_code_url,
        status: String(insertResult.rows[0].status || '').toLowerCase() === 'confirmed' ? 'confirmed' : insertResult.rows[0].status,
        price: Number(insertResult.rows[0].price || 0),
        bookedAt: insertResult.rows[0].booked_at,
        route: `${schedule.route_from || ''} → ${schedule.route_to || ''}`,
        date: schedule.schedule_date ? String(schedule.schedule_date).slice(0, 10) : null,
        time: schedule.departure_time ? String(schedule.departure_time).slice(0, 5) : null,
        bus: schedule.bus_plate || null,
      });
    }

    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      tickets: createdTickets,
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('[createTicket] Error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create ticket',
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * Validate ticket from QR payload and check-in once (race-safe).
 * POST /api/tickets/validate
 * body: { qrCodeData|qrCode, tripId|scheduleId }
 */
const validateTicket = async (req, res) => {
  let client;
  try {
    const { qrCodeData, qrCode, tripId, scheduleId } = req.body || {};
    const rawQr = qrCodeData || qrCode;

    const parsed = parseQrPayload(rawQr);
    const ticketIdentifier = parsed.ticketId;
    const qrTripId = parsed.tripId ? String(parsed.tripId).trim() : '';
    const bookingFromQr = parsed.booking || null;
    const currentTripId = String(tripId || scheduleId || '').trim();

    if (!ticketIdentifier) {
      return res.status(400).json({
        valid: false,
        reason: 'INVALID_QR',
        message: 'Invalid QR payload',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const byId = UUID_RE.test(String(ticketIdentifier));
    const ticketQuery = await client.query(
      `
        SELECT
          t.id,
          t.booking_ref,
          t.passenger_id,
          t.schedule_id,
          t.payment_id,
          t.seat_number,
          t.status,
          t.checked_in_at,
          t.price,
          u.full_name AS passenger_name,
          COALESCE(r.origin, rr.from_location) AS route_from,
          COALESCE(r.destination, rr.to_location) AS route_to,
          COALESCE(s.departure_time::text, bs.time::text) AS departure_time,
          COALESCE(s.schedule_date::date, bs.date::date) AS schedule_date,
          b.plate_number AS bus_plate
        FROM tickets t
        LEFT JOIN users u ON u.id = t.passenger_id
        LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses b ON b.id = COALESCE(s.bus_id, bs.bus_id)
        WHERE ${byId ? 't.id::text = $1' : 't.booking_ref = $1'}
        FOR UPDATE OF t
      `,
      [ticketIdentifier]
    );

    if (!ticketQuery.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        valid: false,
        reason: 'NOT_FOUND',
        message: 'Ticket not found',
      });
    }

    const ticket = ticketQuery.rows[0];
    const ticketTripId = String(ticket.schedule_id || '').trim();

    if (currentTripId && ticketTripId && ticketTripId !== currentTripId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        valid: false,
        reason: 'TRIP_MISMATCH',
        message: 'Ticket is for another trip',
        ticket: {
          id: ticket.id,
          bookingRef: ticket.booking_ref,
          seatNumber: ticket.seat_number,
        },
      });
    }

    if (qrTripId && ticketTripId && ticketTripId !== qrTripId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        valid: false,
        reason: 'TRIP_MISMATCH',
        message: 'Ticket is for another trip',
      });
    }

    if (ticket.status === 'CHECKED_IN' || ticket.status === 'USED') {
      await client.query('ROLLBACK');
      return res.status(200).json({
        valid: false,
        reason: 'ALREADY_USED',
        message: 'Ticket already used',
        ticket: {
          id: ticket.id,
          bookingRef: ticket.booking_ref,
          seatNumber: ticket.seat_number,
          passengerName: ticket.passenger_name,
        },
      });
    }

    // No-real-payment mode: treat pending tickets as active at first validation.
    if (ticket.status === 'PENDING_PAYMENT') {
      await client.query(
        `
          UPDATE tickets
          SET status = 'CONFIRMED', updated_at = NOW()
          WHERE id = $1
            AND status = 'PENDING_PAYMENT'
        `,
        [ticket.id]
      );
      ticket.status = 'CONFIRMED';
    }

    if (ticket.status !== 'CONFIRMED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        valid: false,
        reason: 'INVALID_STATUS',
        message: 'Ticket not active',
      });
    }

    const updateResult = await client.query(
      `
        UPDATE tickets
        SET status = 'CHECKED_IN', checked_in_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status = 'CONFIRMED'
        RETURNING checked_in_at
      `,
      [ticket.id]
    );

    if (!updateResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        valid: false,
        reason: 'ALREADY_USED',
        message: 'Ticket already used',
      });
    }

    const scanDriverId = await resolveScanDriverId(client, req.userId || null);
    if (scanDriverId) {
      await client.query(
        `
          INSERT INTO ticket_scan_logs (
            ticket_id,
            driver_id,
            schedule_id,
            passenger_id,
            scanned_at,
            scan_status,
            error_reason
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            NOW(),
            'SUCCESS',
            NULL
          )
        `,
        [ticket.id, scanDriverId, ticket.schedule_id, ticket.passenger_id]
      ).catch((logError) => {
        console.warn('[validateTicket] Failed to write scan log:', logError.message);
      });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      valid: true,
      reason: 'VALIDATED',
      message: 'Ticket validated',
      booking: bookingFromQr,
      ticket: {
        id: ticket.id,
        bookingRef: ticket.booking_ref,
        seatNumber: ticket.seat_number,
        passengerName: ticket.passenger_name,
        route: `${ticket.route_from || ''} → ${ticket.route_to || ''}`,
        date: ticket.schedule_date ? String(ticket.schedule_date).slice(0, 10) : null,
        time: ticket.departure_time ? String(ticket.departure_time).slice(0, 5) : null,
        bus: ticket.bus_plate || null,
        price: Number(ticket.price || 0),
        status: 'used',
      },
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('[validateTicket] Error:', error);
    return res.status(500).json({
      valid: false,
      reason: 'ERROR',
      message: 'Failed to validate ticket',
    });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  createTicket,
  verifyTicket,
  checkInTicket,
  validateTicket,
};
