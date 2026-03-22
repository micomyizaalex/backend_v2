/**
 * USSD Service Layer for SafariTix
 * Handles all database operations for USSD functionality
 * 
 * Features:
 * - Route and schedule queries
 * - Passenger management (auto-create from phone)
 * - Seat availability checking
 * - Booking with transaction safety
 * - Seat locking with expiration
 * - Ticket lookup and cancellation
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const User = require('../models/User');
const Route = require('../models/Route');
const Schedule = require('../models/Schedule');
const Ticket = require('../models/Ticket');
const SeatLock = require('../models/SeatLock');
const Bus = require('../models/Bus');
const Company = require('../models/Company');

// ==============================================================
// CONFIGURATION
// ==============================================================

const SEAT_LOCK_MINUTES = parseInt(process.env.SEAT_LOCK_MINUTES) || 7; // 7 minutes default
const MAX_SEATS_PER_BUS = 50; // Maximum seats in a bus

// ==============================================================
// PASSENGER (USER) MANAGEMENT
// ==============================================================

/**
 * Find or create a passenger (User) by phone number
 * Auto-creates commuter account if doesn't exist
 * @param {string} phoneNumber - Phone number in format +250788123456
 * @returns {Promise<Object>} User object
 */
async function findOrCreatePassenger(phoneNumber) {
  try {
    // Normalize phone number
    const normalizedPhone = phoneNumber.replace(/\s+/g, '');
    
    // Try to find existing user by phone
    let user = await User.findOne({
      where: { phone_number: normalizedPhone }
    });

    // If not found, create a new commuter account
    if (!user) {
      user = await User.create({
        phone_number: normalizedPhone,
        full_name: `Commuter ${normalizedPhone.slice(-4)}`, // e.g., "Commuter 3456"
        email: `${normalizedPhone.replace('+', '')}@ussd.safaritix.rw`, // Auto-generate email
        password: 'USSD_USER', // Placeholder password (they don't login via web)
        role: 'commuter'
      });
      
      console.log(`✅ New passenger created: ${user.id} (${phoneNumber})`);
    }

    return user;
  } catch (error) {
    console.error('❌ Error in findOrCreatePassenger:', error);
    throw new Error('Failed to process passenger information');
  }
}

// ==============================================================
// ROUTE & SCHEDULE QUERIES
// ==============================================================

/**
 * Get all active routes (distinct origin-destination pairs)
 * Only includes routes with future schedules (departure_time > NOW())
 * @returns {Promise<Array>} List of routes with available future schedules
 */
async function getActiveRoutes() {
  try {
    // Use raw SQL query for better time handling
    // Note: departure_time is stored as TIMESTAMPTZ, so we need to compare full timestamps
    const query = `
      SELECT DISTINCT r.id, r.origin, r.destination, r.name
      FROM routes r
      INNER JOIN schedules s ON r.id = s.route_id
      WHERE s.ticket_status = 'OPEN'
        AND s.available_seats > 0
        AND s.status = 'scheduled'
        AND (
          s.schedule_date > CURRENT_DATE 
          OR (
            s.schedule_date = CURRENT_DATE 
            AND s.departure_time > NOW()
          )
        )
      ORDER BY r.origin, r.destination
      LIMIT 20
    `;

    const [results] = await sequelize.query(query);
    return results;

  } catch (error) {
    console.error('❌ Error fetching routes:', error);
    console.error(error.stack);
    throw new Error('Failed to load routes');
  }
}

/**
 * Get available schedules for a specific route
 * Only returns schedules where departure_time > NOW()
 * Includes real-time seat availability from tickets table
 * @param {string} routeId - Route UUID
 * @returns {Promise<Array>} List of schedules with real-time availability
 */
async function getSchedulesForRoute(routeId) {
  try {
    // Use raw SQL for better time handling and real-time seat calculation
    const query = `
      SELECT 
        s.id,
        s.schedule_date,
        s.departure_time,
        s.arrival_time,
        s.price_per_seat,
        s.total_seats,
        s.available_seats,
        s.company_id,
        r.origin,
        r.destination,
        b.plate_number,
        b.model,
        b.capacity,
        (s.total_seats - COALESCE(
          (SELECT COUNT(*) FROM tickets t 
           WHERE t.schedule_id = s.id 
             AND t.status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN')),
          0
        )) as real_available_seats
      FROM schedules s
      INNER JOIN routes r ON s.route_id = r.id
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE s.route_id = $1
        AND s.ticket_status = 'OPEN'
        AND s.available_seats > 0
        AND s.status = 'scheduled'
        AND (
          s.schedule_date > CURRENT_DATE 
          OR (
            s.schedule_date = CURRENT_DATE 
            AND s.departure_time > NOW()
          )
        )
      ORDER BY s.schedule_date ASC, s.departure_time ASC
      LIMIT 10
    `;

    const [schedules] = await sequelize.query(query, {
      bind: [routeId]
    });

    return schedules;

  } catch (error) {
    console.error('❌ Error fetching schedules:', error);
    console.error(error.stack);
    throw new Error('Failed to load bus schedules');
  }
}

/**
 * Get available seats for a schedule
 * @param {string} scheduleId - Schedule UUID
 * @returns {Promise<Array>} Array of available seat numbers
 */
async function getAvailableSeats(scheduleId) {
  try {
    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule) {
      throw new Error('Schedule not found');
    }

    // Get all booked seats
    const bookedTickets = await Ticket.findAll({
      where: {
        schedule_id: scheduleId,
        status: { [Op.in]: ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'] }
      },
      attributes: ['seat_number']
    });

    // Get all locked seats (not expired)
    const lockedSeats = await SeatLock.findAll({
      where: {
        schedule_id: scheduleId,
        status: 'ACTIVE',
        expires_at: { [Op.gt]: new Date() }
      },
      attributes: ['seat_number']
    });

    // Create sets of unavailable seats
    const bookedSeatNumbers = new Set(bookedTickets.map(t => t.seat_number));
    const lockedSeatNumbers = new Set(lockedSeats.map(l => l.seat_number));

    // Generate available seats (1 to total_seats)
    const availableSeats = [];
    for (let i = 1; i <= schedule.total_seats; i++) {
      const seatNum = i.toString();
      if (!bookedSeatNumbers.has(seatNum) && !lockedSeatNumbers.has(seatNum)) {
        availableSeats.push(seatNum);
      }
    }

    return availableSeats;
  } catch (error) {
    console.error('❌ Error fetching available seats:', error);
    throw new Error('Failed to check seat availability');
  }
}

// ==============================================================
// SEAT LOCKING MECHANISM
// ==============================================================

/**
 * Create a temporary seat lock to prevent double booking
 * @param {string} scheduleId - Schedule UUID
 * @param {string} seatNumber - Seat number to lock
 * @param {string} passengerId - Passenger UUID
 * @param {string} companyId - Company UUID
 * @returns {Promise<Object>} SeatLock object
 */
async function createSeatLock(scheduleId, seatNumber, passengerId, companyId) {
  try {
    // Clean up expired locks first
    await cleanupExpiredLocks();

    // Check if seat is already locked or booked
    const existingLock = await SeatLock.findOne({
      where: {
        schedule_id: scheduleId,
        seat_number: seatNumber,
        status: 'ACTIVE',
        expires_at: { [Op.gt]: new Date() }
      }
    });

    if (existingLock) {
      throw new Error('Seat is currently being booked by another user');
    }

    // Check if seat is already booked
    const existingTicket = await Ticket.findOne({
      where: {
        schedule_id: scheduleId,
        seat_number: seatNumber,
        status: { [Op.in]: ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'] }
      }
    });

    if (existingTicket) {
      throw new Error('Seat already booked');
    }

    // Create lock
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + SEAT_LOCK_MINUTES);

    const lock = await SeatLock.create({
      schedule_id: scheduleId,
      company_id: companyId,
      seat_number: seatNumber,
      passenger_id: passengerId,
      expires_at: expiresAt,
      status: 'ACTIVE',
      meta: { source: 'USSD' }
    });

    return lock;
  } catch (error) {
    console.error('❌ Error creating seat lock:', error);
    throw error;
  }
}

/**
 * Cleanup expired seat locks
 */
async function cleanupExpiredLocks() {
  try {
    await SeatLock.update(
      { status: 'EXPIRED' },
      {
        where: {
          status: 'ACTIVE',
          expires_at: { [Op.lte]: new Date() }
        }
      }
    );
  } catch (error) {
    console.error('⚠️ Error cleaning up locks:', error);
  }
}

// ==============================================================
// BOOKING OPERATIONS
// ==============================================================

/**
 * Book a ticket (with transaction safety)
 * @param {Object} bookingData - { scheduleId, passengerId, seatNumber, lockId }
 * @returns {Promise<Object>} Created ticket with booking reference
 */
async function bookTicket(bookingData) {
  const { scheduleId, passengerId, seatNumber, lockId } = bookingData;
  
  // Use database transaction for atomic operations
  const transaction = await sequelize.transaction();

  try {
    // 1. Verify schedule has available seats
    const schedule = await Schedule.findByPk(scheduleId, { 
      include: [{ model: Route }],
      transaction 
    });
    
    if (!schedule) {
      throw new Error('Schedule not found');
    }

    if (schedule.available_seats <= 0) {
      throw new Error('No seats available');
    }

    if (schedule.ticket_status !== 'OPEN') {
      throw new Error('Booking is closed for this schedule');
    }

    // 2. Verify seat is not already booked
    const existingTicket = await Ticket.findOne({
      where: {
        schedule_id: scheduleId,
        seat_number: seatNumber,
        status: { [Op.in]: ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'] }
      },
      transaction
    });

    if (existingTicket) {
      throw new Error('Seat already booked');
    }

    // 3. Generate unique booking reference
    const bookingRef = generateBookingRef();

    // 4. Create ticket
    const ticket = await Ticket.create({
      passenger_id: passengerId,
      schedule_id: scheduleId,
      company_id: schedule.company_id,
      seat_number: seatNumber,
      booking_ref: bookingRef,
      price: schedule.price_per_seat,
      status: 'CONFIRMED', // For USSD, we confirm immediately (no payment gateway)
      lock_id: lockId,
      booked_at: new Date()
    }, { transaction });

    // 5. Update schedule seat counts
    await schedule.decrement('available_seats', { by: 1, transaction });
    await schedule.increment('booked_seats', { by: 1, transaction });

    // 6. Mark seat lock as consumed
    if (lockId) {
      await SeatLock.update(
        { status: 'CONSUMED', ticket_id: ticket.id },
        { where: { id: lockId }, transaction }
      );
    }

    // Commit transaction
    await transaction.commit();

    // Return ticket with schedule details
    return await Ticket.findByPk(ticket.id, {
      include: [{
        model: Schedule,
        include: [{ model: Route }]
      }]
    });

  } catch (error) {
    // Rollback on error
    await transaction.rollback();
    console.error('❌ Booking error:', error);
    throw error;
  }
}

/**
 * Generate unique booking reference (e.g., STX-ABC123)
 */
function generateBookingRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar chars
  let ref = 'STX-';
  for (let i = 0; i < 6; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

// ==============================================================
// TICKET LOOKUP & CANCELLATION
// ==============================================================

/**
 * Find ticket by booking reference and phone number
 * @param {string} bookingRef - Booking reference (e.g., STX-ABC123)
 * @param {string} phoneNumber - Phone number for verification
 * @returns {Promise<Object>} Ticket with schedule details
 */
async function findTicketByRef(bookingRef, phoneNumber) {
  try {
    const normalizedRef = bookingRef.toUpperCase().trim();
    const normalizedPhone = phoneNumber.replace(/\s+/g, '');

    const ticket = await Ticket.findOne({
      where: { booking_ref: normalizedRef },
      include: [
        {
          model: User,
          as: 'passenger',
          where: { phone_number: normalizedPhone },
          attributes: ['phone_number', 'full_name']
        },
        {
          model: Schedule,
          include: [
            { model: Route, attributes: ['origin', 'destination'] },
            { model: Bus, attributes: ['plate_number'] }
          ]
        }
      ]
    });

    return ticket;
  } catch (error) {
    console.error('❌ Error finding ticket:', error);
    throw new Error('Failed to lookup ticket');
  }
}

/**
 * Cancel a ticket and release the seat
 * @param {string} ticketId - Ticket UUID
 * @param {string} phoneNumber - Phone number for verification
 * @returns {Promise<Object>} Cancelled ticket
 */
async function cancelTicket(ticketId, phoneNumber) {
  const transaction = await sequelize.transaction();

  try {
    // 1. Find ticket with passenger verification
    const ticket = await Ticket.findOne({
      where: { id: ticketId },
      include: [{
        model: User,
        as: 'passenger',
        where: { phone_number: phoneNumber.replace(/\s+/g, '') }
      }],
      transaction
    });

    if (!ticket) {
      throw new Error('Ticket not found or unauthorized');
    }

    if (ticket.status === 'CANCELLED') {
      throw new Error('Ticket already cancelled');
    }

    if (ticket.status === 'CHECKED_IN') {
      throw new Error('Cannot cancel checked-in ticket');
    }

    // 2. Update ticket status
    ticket.status = 'CANCELLED';
    await ticket.save({ transaction });

    // 3. Release seat back to schedule
    const schedule = await Schedule.findByPk(ticket.schedule_id, { transaction });
    if (schedule) {
      await schedule.increment('available_seats', { by: 1, transaction });
      await schedule.decrement('booked_seats', { by: 1, transaction });
    }

    // 4. Release any associated seat lock
    if (ticket.lock_id) {
      await SeatLock.update(
        { status: 'RELEASED' },
        { where: { id: ticket.lock_id }, transaction }
      );
    }

    await transaction.commit();
    return ticket;

  } catch (error) {
    await transaction.rollback();
    console.error('❌ Cancellation error:', error);
    throw error;
  }
}

// ==============================================================
// EXPORTS
// ==============================================================

module.exports = {
  findOrCreatePassenger,
  getActiveRoutes,
  getSchedulesForRoute,
  getAvailableSeats,
  createSeatLock,
  cleanupExpiredLocks,
  bookTicket,
  findTicketByRef,
  cancelTicket,
  generateBookingRef,
  SEAT_LOCK_MINUTES
};
