const { sequelize, Seat, SeatLock, Ticket, Schedule, Bus, Route } = require('../models');
const { Op } = require('sequelize');
const pool = require('../config/pgPool');
const { sendETicketEmail } = require('../services/eTicketService');
const NotificationService = require('../services/notificationService');

const LOCK_DURATION_MINUTES = parseInt(process.env.SEAT_LOCK_MINUTES || '7', 10);

const getSeatsForSchedule = async (req, res) => {
  const { scheduleId } = req.params;
  try {
    const schedule = await Schedule.findByPk(scheduleId, { include: [Bus] });
    if (!schedule) return res.status(404).json({ message: 'Schedule not found' });

    // load seats for bus
    const seats = await Seat.findAll({ where: { bus_id: schedule.bus_id } });

    // load current locks and confirmed tickets for this schedule
    const now = new Date();
    const locks = await SeatLock.findAll({ where: { schedule_id: scheduleId } });
    const tickets = await Ticket.findAll({ where: { schedule_id: scheduleId } });

    // Enhanced logging for state verification
    console.log(`\n=== SEAT STATE CHECK =======================`);
    console.log(`Schedule: ${scheduleId}`);
    console.log(`Total seats on bus: ${seats.length}`);
    console.log(`Total tickets for schedule: ${tickets.length}`);
    console.log(`Active locks: ${locks.filter(l => l.status === 'ACTIVE' && new Date(l.expires_at) > now).length}`);
    
    // Count by ticket status
    const confirmedCount = tickets.filter(t => t.status === 'CONFIRMED').length;
    const checkedInCount = tickets.filter(t => t.status === 'CHECKED_IN').length;
    const cancelledCount = tickets.filter(t => t.status === 'CANCELLED').length;
    const pendingCount = tickets.filter(t => t.status === 'PENDING_PAYMENT').length;
    
    console.log(`Tickets: CONFIRMED=${confirmedCount}, CHECKED_IN=${checkedInCount}, CANCELLED=${cancelledCount}, PENDING=${pendingCount}`);

    // build a map of seat states - PRODUCTION GRADE STATE NORMALIZATION
    const seatMap = seats.map((s) => {
      const seatNum = String(s.seat_number).trim();
      const isDriver = s.is_driver || false;
      
      // Determine state with strict rules (AUTHORITATIVE SOURCE OF TRUTH)
      let state = 'AVAILABLE'; // Default state
      let lock_expires_at = null;
      
      // Rule 1: Driver seats
      if (isDriver) {
        state = 'DRIVER';
      } else {
        // Rule 2: Check for confirmed/checked-in tickets (BOOKED)
        const confirmed = tickets.find((t) => {
          const ticketSeatNum = String(t.seat_number).trim();
          return ticketSeatNum === seatNum && (t.status === 'CONFIRMED' || t.status === 'CHECKED_IN');
        });
        
        if (confirmed) {
          state = 'BOOKED';
          console.log(`✅ Seat ${seatNum}: BOOKED (ticket ${confirmed.id}, status: ${confirmed.status})`);
        } else {
          // Rule 3: Check for active locks (LOCKED)
          const activeLock = locks.find((l) => 
            String(l.seat_number).trim() === seatNum && 
            l.status === 'ACTIVE' && 
            new Date(l.expires_at) > now
          );
          
          if (activeLock) {
            state = 'LOCKED';
            lock_expires_at = activeLock.expires_at;
            console.log(`⏳ Seat ${seatNum}: LOCKED (expires: ${activeLock.expires_at})`);
          }
        }
      }

      // Return CLEAN, NORMALIZED seat object
      // State is ALWAYS uppercase: AVAILABLE, BOOKED, LOCKED, DRIVER
      return {
        seat_number: seatNum,
        state: state, // MANDATORY: Always present, always uppercase
        is_driver: isDriver,
        lock_expires_at: lock_expires_at
      };
    });

    // Summary - exclude driver seats from counts
    const driverSeats = seatMap.filter(s => s.state === 'DRIVER').length;
    const passengerSeats = seatMap.filter(s => s.state !== 'DRIVER');
    const availableSeats = passengerSeats.filter(s => s.state === 'AVAILABLE').length;
    const bookedSeats = passengerSeats.filter(s => s.state === 'BOOKED').length;
    const lockedSeats = passengerSeats.filter(s => s.state === 'LOCKED').length;
    
    console.log(`\nSeat State Summary:`);
    console.log(`  DRIVER: ${driverSeats} (excluded from passenger counts)`);
    console.log(`  AVAILABLE: ${availableSeats}`);
    console.log(`  BOOKED: ${bookedSeats}`);
    console.log(`  LOCKED: ${lockedSeats}`);
    console.log(`  Total Passenger Seats: ${passengerSeats.length}`);
    
    // List booked seat numbers
    const bookedSeatNumbers = seatMap
      .filter(s => s.state === 'BOOKED')
      .map(s => s.seat_number)
      .sort((a, b) => parseInt(a) - parseInt(b));
    if (bookedSeatNumbers.length > 0) {
      console.log(`  🔴 Booked seats: ${bookedSeatNumbers.join(', ')}`);
    }
    console.log(`==========================================\n`);

    // Return PRODUCTION-GRADE response
    // All states are uppercase strings: AVAILABLE, BOOKED, LOCKED, DRIVER
    res.json({ 
      seats: seatMap, // Array of {seat_number: string, state: string}
      summary: {
        total: passengerSeats.length,
        available: availableSeats,
        booked: bookedSeats,
        locked: lockedSeats,
        driver: driverSeats
      }
    });
  } catch (error) {
    console.error('❌ ERROR in getSeatsForSchedule:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Schedule ID:', scheduleId);
    res.status(500).json({ message: 'Failed to load seats', error: error.message });
  }
};

/**
 * Get booked seat numbers for a schedule
 * Returns only seats with CONFIRMED or CHECKED_IN tickets (PAID status)
 * 
 * ENDPOINT: GET /api/schedules/:scheduleId/booked-seats
 * 
 * RESPONSE:
 * {
 *   bookedSeats: [1, 4, 10, 15],
 *   count: 4,
 *   scheduleId: "uuid"
 * }
 */
const getBookedSeats = async (req, res) => {
  const { scheduleId } = req.params;
  
  try {
    console.log(`\n🔍 Fetching booked seats for schedule: ${scheduleId}`);
    
    // Validate schedule exists
    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule) {
      console.log(`❌ Schedule not found: ${scheduleId}`);
      return res.status(404).json({ 
        error: 'Schedule not found',
        message: `No schedule found with ID: ${scheduleId}`  
      });
    }
    
    // Query tickets with CONFIRMED or CHECKED_IN status only (PAID tickets)
    // PENDING_PAYMENT, CANCELLED, EXPIRED tickets do NOT lock seats
    const bookedTickets = await Ticket.findAll({
      where: {
        schedule_id: scheduleId,
        status: {
          [Op.in]: ['CONFIRMED', 'CHECKED_IN']
        }
      },
      attributes: ['seat_number', 'status', 'booking_ref'],
      order: [['seat_number', 'ASC']]
    });
    
    // Extract seat numbers and convert to integers for proper sorting
    const bookedSeatNumbers = bookedTickets
      .map(ticket => {
        const seatNum = String(ticket.seat_number).trim();
        const numericValue = parseInt(seatNum);
        return isNaN(numericValue) ? seatNum : numericValue;
      })
      .sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') {
          return a - b;
        }
        return String(a).localeCompare(String(b));
      });
    
    console.log(`✅ Found ${bookedSeatNumbers.length} booked seats`);
    if (bookedSeatNumbers.length > 0) {
      console.log(`   Seats: ${bookedSeatNumbers.join(', ')}`);
    }
    console.log(`   Ticket statuses:`);
    const statusCounts = {};
    bookedTickets.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    });
    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`     ${status}: ${count}`);
    });
    
    res.json({
      bookedSeats: bookedSeatNumbers,
      count: bookedSeatNumbers.length,
      scheduleId: scheduleId,
      details: bookedTickets.map(t => ({
        seatNumber: t.seat_number,
        status: t.status,
        bookingRef: t.booking_ref
      }))
    });
    
  } catch (error) {
    console.error('❌ ERROR in getBookedSeats:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Schedule ID:', scheduleId);
    res.status(500).json({ 
      error: 'Failed to fetch booked seats',
      message: error.message 
    });
  }
};

// Create lock + PENDING ticket atomically
const lockSeat = async (req, res) => {
  const { scheduleId } = req.params;
  const { seat_number, passenger_id, price } = req.body;

  if (!seat_number || !passenger_id) return res.status(400).json({ message: 'seat_number and passenger_id required' });

  const t = await sequelize.transaction({ isolationLevel: 'SERIALIZABLE' });
  try {
    const schedule = await Schedule.findByPk(scheduleId, { transaction: t });
    if (!schedule) {
      await t.rollback();
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // Check if seat is a driver seat
    const seat = await Seat.findOne({ 
      where: { 
        bus_id: schedule.bus_id, 
        seat_number 
      }, 
      transaction: t 
    });
    
    if (!seat) {
      await t.rollback();
      return res.status(404).json({ message: 'Seat not found' });
    }
    
    if (seat.is_driver) {
      await t.rollback();
      return res.status(400).json({ message: 'Cannot book driver seat' });
    }

    // Ensure schedule is available for booking
    const now = new Date();
    if (schedule.status !== 'scheduled') {
      await t.rollback();
      return res.status(400).json({ message: 'Schedule not available for booking' });
    }
    if (schedule.ticket_status === 'CLOSED') {
      await t.rollback();
      return res.status(400).json({ message: 'Ticket sales closed for this schedule' });
    }
    if (schedule.departure_time && new Date(schedule.departure_time) <= now) {
      await t.rollback();
      return res.status(400).json({ message: 'Ticket sales closed for this schedule' });
    }

    // double-check confirmed or checked-in ticket exists
    const existingConfirmed = await Ticket.findOne({ where: { schedule_id: scheduleId, seat_number, status: ['CONFIRMED', 'CHECKED_IN'] }, transaction: t, lock: t.LOCK.UPDATE });
    if (existingConfirmed) {
      await t.rollback();
      return res.status(409).json({ message: 'Seat already booked' });
    }

    const expiresAt = new Date(now.getTime() + LOCK_DURATION_MINUTES * 60000);

    // check active locks
    const activeLock = await SeatLock.findOne({ where: { schedule_id: scheduleId, seat_number, status: 'ACTIVE', expires_at: { [Op.gt]: now } }, transaction: t, lock: t.LOCK.UPDATE });
    if (activeLock) {
      await t.rollback();
      return res.status(409).json({ message: 'Seat is temporarily locked' });
    }

    // create ticket (PENDING_PAYMENT)
    const ticket = await Ticket.create({
      passenger_id,
      schedule_id: scheduleId,
      company_id: schedule.company_id,
      seat_number,
      price: price || 0,
      booking_ref: `BK-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      status: 'PENDING_PAYMENT',
    }, { transaction: t });

    // create seat lock
    const lock = await SeatLock.create({
      schedule_id: scheduleId,
      company_id: schedule.company_id,
      seat_number,
      passenger_id,
      ticket_id: ticket.id,
      expires_at: expiresAt,
      status: 'ACTIVE',
    }, { transaction: t });

    // link ticket -> lock
    ticket.lock_id = lock.id;
    await ticket.save({ transaction: t });

    await t.commit();

    res.status(201).json({ lock_id: lock.id, ticket_id: ticket.id, expires_at: expiresAt });
  } catch (error) {
    await t.rollback();
    console.error('lockSeat error', error);
    res.status(500).json({ message: 'Failed to lock seat' });
  }
};

const confirmLock = async (req, res) => {
  const { lockId } = req.params;
  const t = await sequelize.transaction();
  try {
    const lock = await SeatLock.findByPk(lockId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lock) { await t.rollback(); return res.status(404).json({ message: 'Lock not found' }); }
    if (lock.status !== 'ACTIVE') { await t.rollback(); return res.status(400).json({ message: 'Lock not active' }); }

    // mark ticket confirmed
    const ticket = await Ticket.findByPk(lock.ticket_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!ticket) { await t.rollback(); return res.status(404).json({ message: 'Ticket not found' }); }

    // update ticket status
    ticket.status = 'CONFIRMED';
    await ticket.save({ transaction: t });

    // decrement available seats on schedule and increment booked seats
    const schedule = await Schedule.findByPk(ticket.schedule_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!schedule) { await t.rollback(); return res.status(404).json({ message: 'Schedule not found' }); }
    if (parseInt(schedule.available_seats || 0) <= 0) { await t.rollback(); return res.status(400).json({ message: 'No seats available' }); }
    schedule.available_seats = parseInt(schedule.available_seats) - 1;
    schedule.booked_seats = (parseInt(schedule.booked_seats || 0) + 1);
    await schedule.save({ transaction: t });

    lock.status = 'CONSUMED';
    await lock.save({ transaction: t });

    await t.commit();

    res.json({ message: 'Seat confirmed', ticket_id: ticket.id });

    // Non-blocking: send e-ticket email + in-app notification
    const confirmedUserId = ticket.passenger_id;
    const confirmedScheduleId = ticket.schedule_id;
    const confirmedTicket = ticket;
    if (confirmedUserId) {
      (async () => {
        try {
          const userQuery = await pool.query(
            'SELECT email, full_name FROM users WHERE id = $1',
            [confirmedUserId]
          );
          if (userQuery.rows.length === 0) return;
          const usr = userQuery.rows[0];

          const scheduleDetailsQuery = await pool.query(`
            SELECT r.origin, r.destination, s.schedule_date, s.departure_time, b.plate_number as bus_plate, b.driver_id
            FROM schedules s
            LEFT JOIN routes r ON s.route_id = r.id
            LEFT JOIN buses b ON s.bus_id = b.id
            WHERE s.id = $1
          `, [confirmedScheduleId]);
          const scheduleInfo = scheduleDetailsQuery.rows[0] || null;

          // E-ticket email
          if (usr.email) {
            await sendETicketEmail({
              userEmail: usr.email,
              userName: usr.full_name || 'Valued Customer',
              tickets: [{
                id: confirmedTicket.id,
                seat_number: confirmedTicket.seat_number,
                booking_ref: confirmedTicket.booking_ref,
                price: parseFloat(confirmedTicket.price || 0)
              }],
              scheduleInfo,
              companyInfo: { name: 'SafariTix Transport' }
            }).catch(e => console.error('[confirmLock] email error:', e.message));
          }

          // In-app notification — commuter
          const route = scheduleInfo ? `${scheduleInfo.origin} → ${scheduleInfo.destination}` : 'your trip';
          const depDate = scheduleInfo?.schedule_date ? String(scheduleInfo.schedule_date).slice(0, 10) : '';
          const depTime = scheduleInfo?.departure_time ? String(scheduleInfo.departure_time).slice(0, 5) : '';
          const dateStr = depDate ? ` on ${depDate}${depTime ? ' ' + depTime : ''}` : '';
          await NotificationService.createNotification(
            confirmedUserId,
            'Ticket Confirmed',
            `Your ticket from ${route}${dateStr} is confirmed. Seat: ${confirmedTicket.seat_number || '—'}. Ref: ${confirmedTicket.booking_ref || confirmedTicket.id}`,
            'ticket_booked',
            { relatedId: confirmedTicket.id, relatedType: 'ticket' }
          );

          // In-app notification — driver
          const driverId = scheduleInfo?.driver_id;
          if (driverId) {
            await NotificationService.createNotification(
              driverId,
              'New Passenger Booked',
              `${usr.full_name || 'A passenger'} booked seat ${confirmedTicket.seat_number || '—'} on your bus for ${route}${dateStr}.`,
              'ticket_booked',
              { relatedId: confirmedTicket.id, relatedType: 'ticket' }
            );
          }
        } catch (err) {
          console.error('[confirmLock] post-confirm error:', err.message);
        }
      })();
    }
  } catch (error) {
    await t.rollback();
    console.error(error);
    res.status(500).json({ message: 'Failed to confirm lock' });
  }
};

const releaseLock = async (req, res) => {
  const { lockId } = req.params;
  const t = await sequelize.transaction();
  try {
    const lock = await SeatLock.findByPk(lockId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lock) { await t.rollback(); return res.status(404).json({ message: 'Lock not found' }); }
    if (lock.status !== 'ACTIVE') { await t.rollback(); return res.status(400).json({ message: 'Lock not active' }); }

    // expire ticket
    const ticket = await Ticket.findByPk(lock.ticket_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (ticket) {
      ticket.status = 'EXPIRED';
      await ticket.save({ transaction: t });
    }

    lock.status = 'RELEASED';
    await lock.save({ transaction: t });

    await t.commit();
    res.json({ message: 'Lock released' });
  } catch (error) {
    await t.rollback();
    console.error(error);
    res.status(500).json({ message: 'Failed to release lock' });
  }
};

// Direct booking: create CONFIRMED ticket and consume any user's active lock atomically
const bookSeat = async (req, res) => {
  const { scheduleId } = req.params;
  // authenticate middleware sets req.userId
  const passenger_id = req.userId || (req.user && req.user.id);
  const { seat_number, price } = req.body;

  if (!seat_number) return res.status(400).json({ message: 'seat_number required' });
  if (!passenger_id) return res.status(401).json({ message: 'Authentication required' });

  const t = await sequelize.transaction({ isolationLevel: 'SERIALIZABLE' });
  try {
    // lock only the schedule row to avoid FOR UPDATE on JOINs (Postgres error)
    const schedule = await Schedule.findByPk(scheduleId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!schedule) { await t.rollback(); return res.status(404).json({ message: 'Schedule not found' }); }

    const now = new Date();
    if (schedule.status !== 'scheduled') { await t.rollback(); return res.status(400).json({ message: 'Schedule not available for booking' }); }
    if (schedule.ticket_status === 'CLOSED') { await t.rollback(); return res.status(400).json({ message: 'Ticket sales closed for this schedule' }); }
    if (schedule.departure_time && new Date(schedule.departure_time) <= now) { await t.rollback(); return res.status(400).json({ message: 'Ticket sales closed for this schedule' }); }

    // check already confirmed or checked-in ticket
    const existingConfirmed = await Ticket.findOne({ where: { schedule_id: scheduleId, seat_number, status: ['CONFIRMED', 'CHECKED_IN'] }, transaction: t, lock: t.LOCK.UPDATE });
    if (existingConfirmed) { await t.rollback(); return res.status(409).json({ message: 'Seat already booked' }); }

    // check active lock
    const activeLock = await SeatLock.findOne({ where: { schedule_id: scheduleId, seat_number, status: 'ACTIVE', expires_at: { [Op.gt]: now } }, transaction: t, lock: t.LOCK.UPDATE });
    if (activeLock && activeLock.passenger_id !== passenger_id) { await t.rollback(); return res.status(409).json({ message: 'Seat is temporarily locked' }); }

    // create confirmed ticket
    const ticket = await Ticket.create({
      passenger_id,
      schedule_id: scheduleId,
      company_id: schedule.company_id,
      seat_number,
      price: price || 0,
      booking_ref: `BK-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      status: 'CONFIRMED',
      booked_at: new Date(),
    }, { transaction: t });

    // if there was an active lock belonging to this user, consume it and link to ticket
    if (activeLock && activeLock.passenger_id === passenger_id) {
      activeLock.status = 'CONSUMED';
      activeLock.ticket_id = ticket.id;
      await activeLock.save({ transaction: t });
      ticket.lock_id = activeLock.id;
      await ticket.save({ transaction: t });
    }

    // decrement available seats and increment booked
    if (parseInt(schedule.available_seats || 0) <= 0) { await t.rollback(); return res.status(400).json({ message: 'No seats available' }); }
    schedule.available_seats = parseInt(schedule.available_seats) - 1;
    schedule.booked_seats = (parseInt(schedule.booked_seats || 0) + 1);
    await schedule.save({ transaction: t });

    await t.commit();

    // Send ticket confirmation email (non-blocking)
    try {
      const userQuery = await pool.query(
        'SELECT email, full_name FROM users WHERE id = $1',
        [passenger_id]
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
        `, [scheduleId]);
        
        const scheduleInfo = scheduleDetailsQuery.rows.length > 0 ? scheduleDetailsQuery.rows[0] : null;
        
        // Send email
        sendETicketEmail({
          userEmail: user.email,
          userName: user.full_name || 'Valued Customer',
          tickets: [{
            id: ticket.id,
            seat_number: ticket.seat_number,
            booking_ref: ticket.booking_ref,
            price: parseFloat(ticket.price)
          }],
          scheduleInfo,
          companyInfo: { name: 'SafariTix Transport' }
        }).catch(err => {
          console.error('[bookSeat] Failed to send ticket confirmation email (non-blocking):', err);
        });
      }
    } catch (emailError) {
      console.error('[bookSeat] Error preparing ticket confirmation email (non-blocking):', emailError);
    }

    // reload ticket with associations for response
    const ticketWithSchedule = await Ticket.findByPk(ticket.id, { include: [{ model: Schedule, include: [Route] }, { model: SeatLock, as: 'lock' }] });

    res.status(201).json({ ticket: ticketWithSchedule });
  } catch (error) {
    await t.rollback();
    console.error('bookSeat error', error);
    const resp = { message: 'Failed to book seat' };
    if (process.env.NODE_ENV !== 'production') {
      resp.error = error && (error.message || String(error));
      resp.stack = error && error.stack;
    }
    res.status(500).json(resp);
  }
};

/**
 * PRODUCTION-READY COMPREHENSIVE SEAT BOOKING FUNCTION
 * 
 * This function handles complete seat booking with full concurrency safety.
 * It ensures that:
 * 1. Multiple users cannot book the same seat simultaneously
 * 2. Seats are properly locked during the booking process
 * 3. Database transactions maintain data consistency
 * 4. Proper error handling and validation
 * 
 * @route POST /api/seats/book-seats
 * @access Private (requires authentication)
 * 
 * @param {Object} req.body
 * @param {string} req.body.scheduleId - The schedule ID for the bus trip
 * @param {string} req.body.busId - The bus ID
 * @param {string[]} req.body.seatNumbers - Array of seat numbers to book (e.g., ["1", "5", "12"])
 * @param {number} req.body.pricePerSeat - Price per seat
 * @param {string} req.userId - User ID from authentication middleware
 * 
 * @returns {Object} Booking confirmation with ticket details and updated seat map
 */
const bookSeatsWithConcurrencySafety = async (req, res) => {
  // STEP 1: Extract and validate input parameters
  const { scheduleId, busId, seatNumbers, pricePerSeat } = req.body;
  const userId = req.userId || (req.user && req.user.id);

  // Input validation
  if (!scheduleId) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required field: scheduleId' 
    });
  }

  if (!busId) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required field: busId' 
    });
  }

  if (!seatNumbers || !Array.isArray(seatNumbers) || seatNumbers.length === 0) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required field: seatNumbers (must be a non-empty array)' 
    });
  }

  if (!userId) {
    return res.status(401).json({ 
      success: false,
      error: 'Authentication required. User ID not found.' 
    });
  }

  // Normalize seat numbers to prevent data type mismatches
  const normalizedSeatNumbers = seatNumbers.map(seat => String(seat).trim());

  // STEP 2: Initialize database transaction with SERIALIZABLE isolation level
  // This prevents phantom reads and ensures complete transaction isolation
  const transaction = await sequelize.transaction({ 
    isolationLevel: 'SERIALIZABLE' 
  });

  try {
    console.log(`[bookSeatsWithConcurrencySafety] User ${userId} attempting to book seats ${normalizedSeatNumbers.join(', ')} for schedule ${scheduleId}`);

    // STEP 3: Lock the schedule row for update to prevent concurrent modifications
    const schedule = await Schedule.findByPk(scheduleId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!schedule) {
      await transaction.rollback();
      return res.status(404).json({ 
        success: false,
        error: 'Schedule not found' 
      });
    }

    // STEP 4: Validate schedule availability and booking window
    const now = new Date();

    // Check if schedule is in valid status
    if (schedule.status !== 'scheduled') {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false,
        error: `Schedule is not available for booking. Current status: ${schedule.status}` 
      });
    }

    // Check if ticket sales are closed
    if (schedule.ticket_status === 'CLOSED') {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false,
        error: 'Ticket sales are closed for this schedule' 
      });
    }

    // Check if departure time has passed
    if (schedule.departure_time && new Date(schedule.departure_time) <= now) {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false,
        error: 'Ticket sales are closed. Departure time has passed.' 
      });
    }

    // Check if enough seats are available
    const availableSeats = parseInt(schedule.available_seats || 0);
    if (availableSeats < normalizedSeatNumbers.length) {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false,
        error: `Insufficient seats available. Requested: ${normalizedSeatNumbers.length}, Available: ${availableSeats}` 
      });
    }

    // STEP 5: Verify all requested seats exist in the bus
    const seatRecords = await Seat.findAll({
      where: {
        bus_id: busId,
        seat_number: normalizedSeatNumbers
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (seatRecords.length !== normalizedSeatNumbers.length) {
      await transaction.rollback();
      const foundSeats = seatRecords.map(s => s.seat_number);
      const missingSeats = normalizedSeatNumbers.filter(sn => !foundSeats.includes(sn));
      return res.status(400).json({ 
        success: false,
        error: `Invalid seat numbers: ${missingSeats.join(', ')} do not exist on this bus` 
      });
    }

    // STEP 6: Check for existing CONFIRMED or CHECKED_IN tickets (seat already booked)
    const existingTickets = await Ticket.findAll({
      where: {
        schedule_id: scheduleId,
        seat_number: normalizedSeatNumbers,
        status: ['CONFIRMED', 'CHECKED_IN']
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (existingTickets.length > 0) {
      await transaction.rollback();
      const occupiedSeats = existingTickets.map(t => t.seat_number).join(', ');
      return res.status(409).json({ 
        success: false,
        error: 'Seat not available',
        message: `The following seats are already occupied: ${occupiedSeats}`,
        occupiedSeats: existingTickets.map(t => t.seat_number)
      });
    }

    // STEP 7: Check for active locks by other users (seats temporarily reserved)
    const activeLocks = await SeatLock.findAll({
      where: {
        schedule_id: scheduleId,
        seat_number: normalizedSeatNumbers,
        status: 'ACTIVE',
        expires_at: { [Op.gt]: now }
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    // Filter locks that belong to other users
    const otherUsersLocks = activeLocks.filter(lock => lock.passenger_id !== userId);
    
    if (otherUsersLocks.length > 0) {
      await transaction.rollback();
      const lockedSeats = otherUsersLocks.map(l => l.seat_number).join(', ');
      return res.status(409).json({ 
        success: false,
        error: 'Seat not available',
        message: `The following seats are temporarily locked by another user: ${lockedSeats}`,
        lockedSeats: otherUsersLocks.map(l => l.seat_number)
      });
    }

    // STEP 8: Create CONFIRMED tickets for all requested seats
    const tickets = [];
    const lockExpiresAt = new Date(now.getTime() + LOCK_DURATION_MINUTES * 60000);

    for (const seatNumber of normalizedSeatNumbers) {
      // Generate unique booking reference
      const bookingRef = `BK-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // Create ticket with CONFIRMED status (atomically marking seat as OCCUPIED)
      const ticket = await Ticket.create({
        passenger_id: userId,
        schedule_id: scheduleId,
        company_id: schedule.company_id,
        seat_number: seatNumber,
        price: pricePerSeat || schedule.price_per_seat || 0,
        booking_ref: bookingRef,
        status: 'CONFIRMED',
        booked_at: now
      }, { transaction });

      // STEP 9: Create seat lock to prevent concurrent access
      // (This provides double protection alongside the CONFIRMED status)
      const lock = await SeatLock.create({
        schedule_id: scheduleId,
        company_id: schedule.company_id,
        seat_number: seatNumber,
        passenger_id: userId,
        ticket_id: ticket.id,
        expires_at: lockExpiresAt,
        status: 'CONFIRMED' // Lock is confirmed (not just ACTIVE)
      }, { transaction });

      // Link ticket to lock
      ticket.lock_id = lock.id;
      await ticket.save({ transaction });

      tickets.push(ticket);

      console.log(`[bookSeatsWithConcurrencySafety] Created ticket ${ticket.id} for seat ${seatNumber}`);
    }

    // STEP 10: Update schedule seat availability counts
    const bookedCount = normalizedSeatNumbers.length;
    schedule.available_seats = parseInt(schedule.available_seats) - bookedCount;
    schedule.booked_seats = (parseInt(schedule.booked_seats || 0)) + bookedCount;
    await schedule.save({ transaction });

    console.log(`[bookSeatsWithConcurrencySafety] Updated schedule ${scheduleId}: available=${schedule.available_seats}, booked=${schedule.booked_seats}`);

    // STEP 11: Commit transaction - all changes are atomic
    await transaction.commit();

    // STEP 12: Fetch updated seat map for this schedule
    const allSeats = await Seat.findAll({ where: { bus_id: busId } });
    const currentLocks = await SeatLock.findAll({ where: { schedule_id: scheduleId } });
    const currentTickets = await Ticket.findAll({ where: { schedule_id: scheduleId } });

    // Build updated seat map with current states
    const updatedSeatMap = allSeats.map(seat => {
      const seatNum = String(seat.seat_number).trim();
      const now = new Date();
      
      // Check if seat has confirmed/checked-in ticket
      const hasTicket = currentTickets.find(t => 
        String(t.seat_number).trim() === seatNum && 
        (t.status === 'CONFIRMED' || t.status === 'CHECKED_IN')
      );
      
      // Check if seat has active lock
      const hasLock = currentLocks.find(l => 
        String(l.seat_number).trim() === seatNum && 
        l.status === 'ACTIVE' && 
        new Date(l.expires_at) > now
      );

      let state = 'AVAILABLE';
      if (hasTicket) state = 'OCCUPIED'; // or 'BOOKED'
      else if (hasLock) state = 'LOCKED';

      return {
        seat_number: seatNum,
        state,
        bus_id: seat.bus_id
      };
    });

    // STEP 13: Send ticket confirmation email (non-blocking)
    console.log('[bookSeatsWithConcurrencySafety] 📧 Starting email notification process for user:', userId);
    try {
      const userQuery = await pool.query(
        'SELECT email, full_name FROM users WHERE id = $1',
        [userId]
      );
      
      console.log('[bookSeatsWithConcurrencySafety] User query result:', userQuery.rows.length > 0 ? `Found user: ${userQuery.rows[0].email}` : 'No user found');
      
      if (userQuery.rows.length > 0) {
        const user = userQuery.rows[0];
        
        if (!user.email) {
          console.log('[bookSeatsWithConcurrencySafety] ⚠️  User has no email address in profile');
        } else {
          console.log('[bookSeatsWithConcurrencySafety] 📨 Preparing to send email to:', user.email);
          
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
          `, [scheduleId]);
          
          const scheduleInfo = scheduleDetailsQuery.rows.length > 0 ? scheduleDetailsQuery.rows[0] : null;
          console.log('[bookSeatsWithConcurrencySafety] Schedule info:', scheduleInfo ? `${scheduleInfo.origin} → ${scheduleInfo.destination}` : 'No schedule details');
          
          // Send email (fire and forget - don't block the response)
          console.log('[bookSeatsWithConcurrencySafety] 🚀 Calling sendETicketEmail...');
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
          }).then(() => {
            console.log('[bookSeatsWithConcurrencySafety] ✅ Email sending completed successfully');
          }).catch(err => {
            console.error('[bookSeatsWithConcurrencySafety] ❌ Failed to send ticket confirmation email:', err.message);
          });
        }
      } else {
        console.log('[bookSeatsWithConcurrencySafety] ⚠️  User not found for email notification:', userId);
      }
    } catch (emailError) {
      // Log but don't fail the booking
      console.error('[bookSeatsWithConcurrencySafety] ❌ Error preparing ticket confirmation email (non-blocking):', emailError.message);
    }

    // STEP 14: Return success response with booking confirmation
    return res.status(201).json({
      success: true,
      message: 'Seats booked successfully',
      booking: {
        tickets: tickets.map(ticket => ({
          id: ticket.id,
          seat_number: ticket.seat_number,
          booking_ref: ticket.booking_ref,
          price: parseFloat(ticket.price),
          status: ticket.status,
          booked_at: ticket.booked_at
        })),
        totalPrice: tickets.reduce((sum, t) => sum + parseFloat(t.price), 0),
        scheduleId,
        busId,
        userId
      },
      schedule: {
        available_seats: schedule.available_seats,
        booked_seats: schedule.booked_seats
      },
      seatMap: updatedSeatMap
    });

  } catch (error) {
    // STEP 15: Rollback transaction on any error
    await transaction.rollback();
    
    console.error('[bookSeatsWithConcurrencySafety] Error:', error);

    // Handle specific database errors
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        error: 'Seat not available',
        message: 'One or more seats were just booked by another user. Please try again.'
      });
    }

    if (error.name === 'SequelizeTimeoutError') {
      return res.status(503).json({
        success: false,
        error: 'Service temporarily unavailable',
        message: 'High traffic. Please try again in a moment.'
      });
    }

    // Generic error response
    const response = {
      success: false,
      error: 'Failed to book seats',
      message: 'An unexpected error occurred during booking'
    };

    // Include detailed error info in development mode
    if (process.env.NODE_ENV !== 'production') {
      response.details = error.message;
      response.stack = error.stack;
    }

    return res.status(500).json(response);
  }
};

module.exports = { 
  getSeatsForSchedule,
  getBookedSeats, // NEW: Get only booked seat numbers
  lockSeat, 
  confirmLock, 
  releaseLock, 
  bookSeat,
  bookSeatsWithConcurrencySafety 
};
