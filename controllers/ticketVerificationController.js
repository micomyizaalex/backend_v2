const { Ticket, User, Schedule, Bus, Route } = require('../models');
const pool = require('../config/pgPool');

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

module.exports = {
  verifyTicket,
  checkInTicket
};
