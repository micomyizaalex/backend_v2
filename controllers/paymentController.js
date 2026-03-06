const { Payment, Schedule, Ticket, User } = require('../models');
const pool = require('../config/pgPool');
const { sendETicketEmail } = require('../services/eTicketService');

// Generate UUID v4 manually if uuid package is not available
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

/**
 * Initiate a payment for a schedule booking
 * Creates a PENDING payment record
 */
const initiatePayment = async (req, res) => {
  let client;
  
  try {
    const userId = req.userId;
    const { scheduleId, paymentMethod, phoneOrCard, numTickets = 1 } = req.body;

    // Validate input
    if (!scheduleId || !paymentMethod || !phoneOrCard) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'scheduleId, paymentMethod, and phoneOrCard are required'
      });
    }

    // Validate payment method
    const validMethods = ['mobile_money', 'airtel_money', 'card_payment'];
    if (!validMethods.includes(paymentMethod)) {
      return res.status(400).json({
        error: 'Invalid payment method',
        message: `Payment method must be one of: ${validMethods.join(', ')}`
      });
    }

    // Get database client
    client = await pool.connect();

    // Start transaction
    await client.query('BEGIN');

    try {
      // Get schedule details and check availability
      const scheduleQuery = `
        SELECT 
          s.id,
          s.departure_time,
          s.ticket_status,
          s.available_seats,
          s.price_per_seat,
          s.company_id,
          s.status,
          b.status as bus_status,
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
          ) as effective_price
        FROM schedules s
        LEFT JOIN buses b ON s.bus_id = b.id
        WHERE s.id = $1
        FOR UPDATE
      `;
      
      const scheduleResult = await client.query(scheduleQuery, [scheduleId]);
      
      if (scheduleResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({
          error: 'Schedule not found',
          message: 'The requested schedule does not exist'
        });
      }

      const schedule = scheduleResult.rows[0];

      // Check if schedule is available and bus is active
      if (schedule.status !== 'scheduled') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Schedule not available',
          message: 'This schedule is not available for booking'
        });
      }

      if (schedule.bus_status && schedule.bus_status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Cannot book schedule on INACTIVE bus' });
      }

      // Enforce ticket cutoff based on departure_time and ticket_status
      const now = new Date();
      if (schedule.ticket_status === 'CLOSED') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule', message: 'Ticket sales closed for this schedule' });
      }
      if (schedule.departure_time && new Date(schedule.departure_time) <= now) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule', message: 'Ticket sales closed for this schedule' });
      }

      // Check if enough seats are available
      if (parseInt(schedule.available_seats) < numTickets) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Insufficient seats',
          message: `Only ${schedule.available_seats} seat(s) available, but ${numTickets} requested`
        });
      }

      // Calculate total amount
      const pricePerSeat = parseFloat(schedule.effective_price);
      const totalAmount = pricePerSeat * numTickets;

      // Generate transaction reference
      const transactionRef = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // Create payment record
      const paymentQuery = `
        INSERT INTO payments (
          id, user_id, schedule_id, payment_method, 
          phone_or_card, amount, status, transaction_ref, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING *
      `;

      const paymentId = generateUUID();
      const paymentResult = await client.query(paymentQuery, [
        paymentId,
        userId,
        scheduleId,
        paymentMethod,
        phoneOrCard,
        totalAmount,
        'PENDING',
        transactionRef
      ]);

      await client.query('COMMIT');
      client.release();

      res.status(201).json({
        success: true,
        payment: {
          id: paymentResult.rows[0].id,
          transaction_ref: transactionRef,
          amount: totalAmount,
          payment_method: paymentMethod,
          status: 'PENDING'
        },
        message: 'Payment initiated successfully'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    if (client) {
      client.release();
    }
    console.error('Initiate payment error:', error);
    res.status(500).json({
      error: 'Failed to initiate payment',
      message: error.message || 'An unexpected error occurred'
    });
  }
};

/**
 * Confirm payment (simulate USSD confirmation)
 * Updates payment status to SUCCESS
 */
const confirmPayment = async (req, res) => {
  let client;
  
  try {
    const userId = req.userId;
    const { paymentId, ussdWorked = false } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        error: 'Missing payment ID',
        message: 'paymentId is required'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    try {
      // Get payment and verify ownership
      const paymentQuery = `
        SELECT 
          p.*,
          s.available_seats,
          s.price_per_seat,
          s.company_id,
          s.status as schedule_status,
          b.status as bus_status,
          s.bus_id,
          s.departure_time,
          s.ticket_status
        FROM payments p
        INNER JOIN schedules s ON p.schedule_id = s.id
        LEFT JOIN buses b ON s.bus_id = b.id
        WHERE p.id = $1 AND p.user_id = $2
        FOR UPDATE
      `;

      const paymentResult = await client.query(paymentQuery, [paymentId, userId]);

      if (paymentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({
          error: 'Payment not found',
          message: 'Payment not found or you do not have permission to access it'
        });
      }

      const payment = paymentResult.rows[0];

      // Check if payment is already confirmed
      if (payment.status === 'SUCCESS') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Payment already confirmed',
          message: 'This payment has already been confirmed'
        });
      }

      // Check if schedule is still available and bus active
      if (payment.schedule_status !== 'scheduled') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Schedule not available',
          message: 'The schedule is no longer available for booking'
        });
      }

      if (payment.bus_status && payment.bus_status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Cannot book ticket for INACTIVE bus' });
      }

      // Cutoff enforcement
      const now2 = new Date();
      if (payment.ticket_status === 'CLOSED') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule' });
      }
      if (payment.departure_time && new Date(payment.departure_time) <= now2) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule' });
      }

      // Update payment status to SUCCESS
      const updatePaymentQuery = `
        UPDATE payments
        SET status = 'SUCCESS', updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;

      await client.query(updatePaymentQuery, [paymentId]);

      await client.query('COMMIT');
      client.release();

      res.json({
        success: true,
        message: 'Payment confirmed successfully',
        payment: {
          id: payment.id,
          status: 'SUCCESS',
          transaction_ref: payment.transaction_ref
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    if (client) {
      client.release();
    }
    console.error('Confirm payment error:', error);
    res.status(500).json({
      error: 'Failed to confirm payment',
      message: error.message || 'An unexpected error occurred'
    });
  }
};

/**
 * Book ticket after successful payment
 * Creates ticket, decrements available seats, all in a transaction
 */
const bookTicket = async (req, res) => {
  let client;
  
  try {
    const userId = req.userId;
    const { paymentId, numTickets = 1 } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        error: 'Missing payment ID',
        message: 'paymentId is required'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    try {
      // Get payment with schedule details
      const paymentQuery = `
        SELECT 
          p.*,
          s.available_seats,
          s.booked_seats,
          s.price_per_seat,
          s.company_id,
          s.status as schedule_status,
          s.bus_id,
          b.status as bus_status,
          s.departure_time,
          s.ticket_status
        FROM payments p
        INNER JOIN schedules s ON p.schedule_id = s.id
        LEFT JOIN buses b ON s.bus_id = b.id
        WHERE p.id = $1 AND p.user_id = $2
        FOR UPDATE
      `;

      const paymentResult = await client.query(paymentQuery, [paymentId, userId]);

      if (paymentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({
          error: 'Payment not found',
          message: 'Payment not found or you do not have permission to access it'
        });
      }

      const payment = paymentResult.rows[0];

      // Verify payment is successful
      if (payment.status !== 'SUCCESS') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Payment not confirmed',
          message: 'Payment must be confirmed before booking ticket'
        });
      }

      // Check if tickets already exist for this payment (prevent double booking)
      const existingTicketsQuery = `
        SELECT COUNT(*) as count
        FROM tickets
        WHERE payment_id = $1
      `;
      const existingTicketsResult = await client.query(existingTicketsQuery, [paymentId]);
      
      if (parseInt(existingTicketsResult.rows[0].count) > 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Tickets already booked',
          message: 'Tickets for this payment have already been booked'
        });
      }

      // Check schedule availability and bus active
      if (payment.schedule_status !== 'scheduled') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Schedule not available',
          message: 'The schedule is no longer available for booking'
        });
      }

      if (payment.bus_status && payment.bus_status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Cannot book ticket for INACTIVE bus' });
      }

      // Enforce ticket cutoff
      const now3 = new Date();
      if (payment.ticket_status === 'CLOSED') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule' });
      }
      if (payment.departure_time && new Date(payment.departure_time) <= now3) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Ticket sales closed for this schedule' });
      }

      const currentAvailableSeats = parseInt(payment.available_seats);
      if (currentAvailableSeats < numTickets) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: 'Insufficient seats',
          message: `Only ${currentAvailableSeats} seat(s) available`
        });
      }

      // Find available seat numbers from seats table for the bus, excluding already confirmed tickets, active locks, and driver seats
      const availableSeatsQuery = `
        SELECT s.seat_number FROM seats s
        WHERE s.bus_id = $1
        AND (s.is_driver = false OR s.is_driver IS NULL)
        AND s.seat_number NOT IN (
          SELECT seat_number FROM tickets WHERE schedule_id = $2 AND status IN ('CONFIRMED','CHECKED_IN')
        )
        AND s.seat_number NOT IN (
          SELECT seat_number FROM seat_locks WHERE schedule_id = $2 AND status = 'ACTIVE' AND expires_at > NOW()
        )
        ORDER BY s.seat_number ASC
        LIMIT $3
      `;

      const availableResult = await client.query(availableSeatsQuery, [payment.bus_id, payment.schedule_id, numTickets]);
      const seatRows = availableResult.rows || [];
      if (seatRows.length < numTickets) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Insufficient available seats', message: 'Not enough available seats to fulfill request' });
      }

      const tickets = [];
      for (let i = 0; i < numTickets; i++) {
        const seatNumber = seatRows[i].seat_number;
        
        console.log(`[bookTicket] ✅ TICKET CREATED: Seat ${seatNumber} → Status: CONFIRMED`);
        
        const bookingRef = `BK-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const ticketId = generateUUID();
        const ticketQuery = `
          INSERT INTO tickets (
            id, passenger_id, schedule_id, company_id, payment_id,
            seat_number, booking_ref, price, status, booked_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED', NOW(), NOW(), NOW())
          RETURNING *
        `;

        const ticketResult = await client.query(ticketQuery, [
          ticketId,
          userId,
          payment.schedule_id,
          payment.company_id,
          paymentId,
          seatNumber,
          bookingRef,
          parseFloat(payment.amount) / numTickets
        ]);

        tickets.push(ticketResult.rows[0]);
      }

      // Update schedule: decrement available_seats, increment booked_seats
      const updateScheduleQuery = `
        UPDATE schedules
        SET 
          available_seats = available_seats - $1,
          booked_seats = COALESCE(booked_seats, 0) + $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING available_seats, booked_seats
      `;

      await client.query(updateScheduleQuery, [numTickets, payment.schedule_id]);

      await client.query('COMMIT');
      client.release();

      // Send ticket confirmation email to user
      try {
        // Get user information
        const userQuery = await pool.query(
          'SELECT email, full_name FROM users WHERE id = $1',
          [userId]
        );
        
        if (userQuery.rows.length > 0) {
          const user = userQuery.rows[0];
          
          // Get schedule details for email
          const scheduleDetailsQuery = await pool.query(`
            SELECT 
              r.origin, 
              r.destination, 
              s.schedule_date,
              s.departure_time,
              b.plate_number as bus_plate
            FROM schedules s
            LEFT JOIN routes r ON s.route_id = r.id
            LEFT JOIN buses b ON s.bus_id = b.id
            WHERE s.id = $1
          `, [payment.schedule_id]);
          
          const scheduleInfo = scheduleDetailsQuery.rows.length > 0 ? scheduleDetailsQuery.rows[0] : null;
          
          // Send email (non-blocking - we don't want to fail the booking if email fails)
          sendETicketEmail({
            userEmail: user.email,
            userName: user.full_name || 'Valued Customer',
            tickets: tickets.map(t => ({
              id: t.id,
              seat_number: t.seat_number,
              booking_ref: t.booking_ref,
              price: parseFloat(t.price)
            })),
            scheduleInfo,
            companyInfo: { name: 'SafariTix Transport' }
          }).catch(err => {
            console.error('Failed to send ticket confirmation email (non-blocking):', err);
          });
        }
      } catch (emailError) {
        // Log but don't fail the booking
        console.error('Error preparing ticket confirmation email (non-blocking):', emailError);
      }

      res.status(201).json({
        success: true,
        message: 'Tickets booked successfully',
        tickets: tickets.map(t => ({
          id: t.id,
          booking_ref: t.booking_ref,
          seat_number: t.seat_number,
          price: parseFloat(t.price),
          status: t.status,
          booked_at: t.booked_at
        })),
        count: tickets.length
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    if (client) {
      client.release();
    }
    console.error('Book ticket error:', error);
    res.status(500).json({
      error: 'Failed to book ticket',
      message: error.message || 'An unexpected error occurred'
    });
  }
};

module.exports = {
  initiatePayment,
  confirmPayment,
  bookTicket
};

