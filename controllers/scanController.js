const pool = require('../config/pgPool');
const { renderHtml } = require('../utils/helpers');

const verifyTicket = async (req, res) => {
  const { ticketId } = req.params;
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  let client;
  try {
    client = await pool.connect();

    let ticket = null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId);

    const q = await client.query(`
      SELECT
        t.id, t.booking_ref, t.seat_number, t.price, t.status,
        t.checked_in_at, t.booked_at,
        u.full_name AS passenger_name,
        COALESCE(r.origin, rr.from_location, '') AS route_from,
        COALESCE(r.destination, rr.to_location, '') AS route_to,
        COALESCE(s1.departure_time, s2.time, '') AS dep_time,
        COALESCE(s1.schedule_date, s2.date, NOW()) AS dep_date,
        b.plate_number AS bus_plate
      FROM tickets t
      LEFT JOIN users u ON u.id = t.passenger_id
      LEFT JOIN schedules s1 ON s1.id = t.schedule_id
      LEFT JOIN bus_schedules s2 ON s2.schedule_id::text = t.schedule_id::text
      LEFT JOIN routes r ON r.id = s1.route_id
      LEFT JOIN rura_routes rr ON rr.id::text = s2.route_id::text
      LEFT JOIN buses b ON b.id = COALESCE(s1.bus_id, s2.bus_id)
      WHERE t.booking_ref = $1
        ${isUuid ? 'OR t.id::text = $1' : ''}
      LIMIT 1
    `, [ticketId]);

    ticket = q.rows[0] || null;

    if (!ticket) {
      if (wantsJson) {
        return res.status(404).json({ valid: false, status: 'NOT_FOUND', message: 'Ticket not found' });
      }
      return res.send(renderHtml('Invalid Ticket', '❌', '#fee2e2', {
        sub: 'No ticket found with this ID.',
        rows: [['Ticket ID', ticketId]]
      }));
    }

    const statusUp = (ticket.status || '').toUpperCase();
    const usedStatuses = ['CHECKED_IN', 'USED'];

    if (usedStatuses.includes(statusUp)) {
      const usedAt = ticket.checked_in_at ? new Date(ticket.checked_in_at).toLocaleString('en-RW') : 'Earlier';
      if (wantsJson) {
        return res.status(200).json({ 
          valid: false, 
          status: 'ALREADY_USED', 
          message: 'Ticket already used', 
          ticket: { 
            bookingRef: ticket.booking_ref, 
            passengerName: ticket.passenger_name 
          } 
        });
      }
      return res.send(renderHtml('Already Used', '⚠️', '#fef9c3', {
        sub: 'This ticket has already been scanned.',
        rows: [
          ['Passenger', ticket.passenger_name || '—'],
          ['Route', `${ticket.route_from} → ${ticket.route_to}`],
          ['Seat', String(ticket.seat_number || '—')],
          ['Scanned at', usedAt],
        ]
      }));
    }

    if (statusUp === 'CANCELLED') {
      if (wantsJson) {
        return res.status(200).json({ valid: false, status: 'CANCELLED', message: 'Ticket has been cancelled' });
      }
      return res.send(renderHtml('Ticket Cancelled', '🚫', '#fee2e2', {
        sub: 'This ticket has been cancelled.',
        rows: [['Passenger', ticket.passenger_name || '—'], ['Ticket ID', ticket.booking_ref || ticketId]]
      }));
    }

    if (statusUp === 'PENDING_PAYMENT') {
      if (wantsJson) {
        return res.status(200).json({ valid: false, status: 'PENDING_PAYMENT', message: 'Payment not completed' });
      }
      return res.send(renderHtml('Payment Pending', '⏳', '#fef9c3', {
        sub: 'Payment has not been completed for this ticket.',
        rows: [['Ticket ID', ticket.booking_ref || ticketId]]
      }));
    }

    const dateStr = ticket.dep_date ? String(ticket.dep_date).slice(0, 10) : '—';
    const timeStr = ticket.dep_time ? String(ticket.dep_time).slice(0, 5) : '—';

    if (wantsJson) {
      return res.status(200).json({
        valid: true,
        status: 'CONFIRMED',
        message: 'Ticket valid',
        ticket: {
          bookingRef: ticket.booking_ref,
          passengerName: ticket.passenger_name,
          seat: ticket.seat_number,
          route: `${ticket.route_from} → ${ticket.route_to}`,
          date: dateStr,
          time: timeStr,
          bus: ticket.bus_plate,
          price: ticket.price,
        }
      });
    }

    return res.send(renderHtml('Ticket Valid ✓', '✅', '#dcfce7', {
      sub: 'Ticket is valid. Driver must scan to check in passenger.',
      rows: [
        ['Passenger', ticket.passenger_name || '—'],
        ['Route', `${ticket.route_from} → ${ticket.route_to}`],
        ['Date', dateStr],
        ['Time', timeStr],
        ['Seat', String(ticket.seat_number || '—')],
        ['Bus', ticket.bus_plate || '—'],
        ['Price', ticket.price ? `${Number(ticket.price).toLocaleString()} RWF` : '—'],
        ['Ticket ID', ticket.booking_ref || ticketId],
      ]
    }));

  } catch (err) {
    console.error('[/scan] Error:', err.message || err);
    if (wantsJson) {
      return res.status(500).json({ valid: false, status: 'ERROR', message: 'Server error' });
    }
    return res.send(renderHtml('System Error', '❗', '#fee2e2', {
      sub: 'Could not validate ticket. Please try again.',
      rows: [['Ticket ID', ticketId]]
    }));
  } finally {
    if (client) client.release();
  }
};

module.exports = { verifyTicket };