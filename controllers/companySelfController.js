const { Company, Bus, Schedule, Ticket, User, Driver, Route, DriverAssignment, Payment, sequelize } = require('../models');
const crypto = require('crypto');
const { Op } = require('sequelize');
const busService = require('../services/busService');

let scheduleTimeStorageMode = null; // "time" | "timestamp"

function normalizeClockTime(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${fieldName} is required`);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    const ss = String(value.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  const input = String(value).trim();
  const timeMatch = input.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (timeMatch) {
    const hh = timeMatch[1];
    const mm = timeMatch[2];
    const ss = timeMatch[3] || '00';
    return `${hh}:${mm}:${ss}`;
  }

  // Accept ISO-like datetime and extract time part
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) {
    const hh = String(parsed.getHours()).padStart(2, '0');
    const mm = String(parsed.getMinutes()).padStart(2, '0');
    const ss = String(parsed.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  throw new Error(`${fieldName} must be in HH:MM or HH:MM:SS format`);
}

function normalizeScheduleDate(value) {
  if (!value) throw new Error('date is required');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('date must be a valid date');
  }
  return parsed.toISOString().slice(0, 10);
}

async function getScheduleTimeStorageMode() {
  if (scheduleTimeStorageMode) return scheduleTimeStorageMode;

  const table = await sequelize.getQueryInterface().describeTable('schedules');
  const departureType = String(table?.departure_time?.type || '').toUpperCase();
  scheduleTimeStorageMode = departureType.includes('TIMESTAMP') ? 'timestamp' : 'time';
  return scheduleTimeStorageMode;
}

async function normalizeScheduleTimesForStorage(scheduleDate, departureTime, arrivalTime) {
  const dateOnly = normalizeScheduleDate(scheduleDate);
  const depClock = normalizeClockTime(departureTime, 'departureTime');
  const arrClock = normalizeClockTime(arrivalTime, 'arrivalTime');
  const mode = await getScheduleTimeStorageMode();

  if (mode === 'timestamp') {
    return {
      scheduleDate: dateOnly,
      departureTime: new Date(`${dateOnly}T${depClock}`),
      arrivalTime: new Date(`${dateOnly}T${arrClock}`)
    };
  }

  return {
    scheduleDate: dateOnly,
    departureTime: depClock,
    arrivalTime: arrClock
  };
}

// Get company for current user
const getCompany = async (req, res) => {
  try {
    // Resolve company id from req (set by requireCompany) or fallback to user/owner
    const resolveCompanyId = async (req) => {
      if (req.companyId) return req.companyId;
      const user = await User.findByPk(req.userId);
      if (user && user.company_id) return user.company_id;
      const c = await Company.findOne({ where: { owner_id: req.userId } });
      return c ? c.id : null;
    };

    const companyId = await resolveCompanyId(req);
    if (!companyId) return res.status(200).json({ company: null });

    const company = await Company.findByPk(companyId);

    // Map DB fields to frontend expected shape
    const mapped = {
      id: company.id,
      name: company.name,
      status: company.status,
      subscriptionStatus: company.subscription_status || 'inactive',
      subscriptionPaid: !!company.subscription_paid
    };

    res.json({ company: mapped });
  } catch (error) {
    console.error('createBus error:', error);
    res.status(400).json({ error: error.message });
  }
};

const getBuses = async (req, res) => {
  try {
    const companyId = req.companyId || (await User.findByPk(req.userId)).company_id;
    if (!companyId) return res.json({ buses: [] });
    const buses = await busService.listBuses(companyId) || [];
    console.log('getBuses: companyId=', companyId, 'raw buses count=', (buses && buses.length) || 0);
    const mapped = buses.map(b => ({
      id: b.id,
      plateNumber: b.plate_number,
      model: b.model,
      capacity: b.capacity,
      seatLayout: b.seat_layout,
      driverId: b.driver_id || null,
      driverName: (b.driver && (b.driver.full_name || b.driver.name)) || null,
      status: b.status.toLowerCase()
    }));
    console.log('getBuses: mapped count=', mapped.length);
    res.json({ buses: mapped });
  } catch (error) {
    console.error('assignBusDriver error:', error);
    res.status(400).json({ error: error.message });
  }
};

const createBus = async (req, res) => {
  try {
    console.log('createBus request payload:', req.body, 'userId:', req.userId);
    console.log('Driver ID received:', req.body.driver_id || req.body.driverId || null);
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const payload = {
      plate_number: req.body.plateNumber || req.body.plate_number,
      capacity: req.body.capacity,
      model: req.body.model,
      seat_layout: req.body.seatLayout || req.body.seat_layout,
      driver_id: req.body.driverId || req.body.driver_id || null
    };


      // Validate driver_id if provided to prevent foreign key violations
      if (payload.driver_id) {
        // Ensure driver exists in users table and has role 'driver'
        const driverUser = await User.findOne({ where: { id: payload.driver_id, role: 'driver' } });
        if (!driverUser || !driverUser.id) {
          return res.status(400).json({ error: 'Invalid driver selected' });
        }
        if (driverUser.company_id !== companyId) {
          return res.status(400).json({ error: 'Invalid driver selected' });
        }
      }

      const bus = await busService.createBus(companyId, payload, { assignedBy: userId });

    const mapped = {
      id: bus.id,
      plateNumber: bus.plate_number,
      model: bus.model,
      capacity: bus.capacity,
      seatLayout: bus.seat_layout,
      driverId: bus.driver_id || null,
      status: bus.status.toLowerCase()
    };

    res.status(201).json({ bus: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const assignBusDriver = async (req, res) => {
  try {
    const userId = req.userId;
      const companyId = req.companyId || (await User.findByPk(userId)).company_id;

    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const busId = req.params.id;
    const { driverId } = req.body;

    const payload = { driver_id: driverId || null };
    const bus = await busService.updateBus(companyId, busId, payload, { assignedBy: userId });

    const mapped = {
      id: bus.id,
      plateNumber: bus.plate_number,
      model: bus.model,
      capacity: bus.capacity,
      seatLayout: bus.seat_layout,
      driverId: bus.driver_id || null,
      status: bus.status.toLowerCase()
    };

    res.json({ bus: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateBus = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const busId = req.params.id;
    const payload = {
      plate_number: req.body.plateNumber || req.body.plate_number,
      capacity: req.body.capacity,
      model: req.body.model,
      seat_layout: req.body.seatLayout || req.body.seat_layout,
      driver_id: req.body.driverId !== undefined ? req.body.driverId : req.body.driver_id,
      status: req.body.status ? req.body.status.toUpperCase() : undefined
    };

    const bus = await busService.updateBus(companyId, busId, payload, { assignedBy: userId });
    if (!bus) return res.status(404).json({ error: 'Bus not found' });

    const mapped = {
      id: bus.id,
      plateNumber: bus.plate_number,
      model: bus.model,
      capacity: bus.capacity,
      seatLayout: bus.seat_layout,
      driverId: bus.driver_id || null,
      status: bus.status.toLowerCase()
    };

    res.json({ bus: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteBus = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const busId = req.params.id;
    const result = await busService.deleteBus(companyId, busId);
    res.json({ message: 'Bus deleted', busId: result.busId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getSchedules = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.json({ schedules: [] });

    const schedules = await Schedule.findAll({
      where: { company_id: companyId },
      include: [
        {
          model: Route,
          attributes: ['origin', 'destination'],
          required: false
        },
        {
          model: Bus,
          attributes: ['id','plate_number'],
          required: false
        }
      ]
    });

    // Collect bus IDs for bulk assignment lookup
    const busIds = schedules.map(s => s.bus_id).filter(Boolean);
    let assignmentMap = {};
    if (busIds.length > 0) {
      const DriverAssignment = require('../models').DriverAssignment || require('../models/DriverAssignment');
      // Load current assignments for these buses (unassigned_at IS NULL)
      const assignments = await DriverAssignment.findAll({ where: { bus_id: busIds, unassigned_at: null }, include: [{ model: require('../models').Driver, required: false }] });
      // Map bus_id -> assignment
      assignments.forEach(a => {
        if (a && a.bus_id) assignmentMap[a.bus_id] = a;
      });
    }

    // Collect user ids referenced by assignments (from Driver.user_id or assignment.driver_id if it points to users)
    const userIds = new Set();
    Object.values(assignmentMap).forEach(a => {
      if (!a) return;
      const drv = a.Driver;
      if (drv && drv.user_id) userIds.add(drv.user_id);
      // also consider assignment.driver_id might be canonical user id in some setups
      if (a.driver_id && a.driver_id.length === 36) userIds.add(a.driver_id);
    });

    const userIdArr = Array.from(userIds);
    let usersById = {};
    if (userIdArr.length > 0) {
      const users = await User.findAll({ where: { id: userIdArr }, attributes: ['id','full_name'] });
      users.forEach(u => { usersById[u.id] = u; });
    }

    const mapped = schedules.map(s => {
      const price = parseFloat(s.price_per_seat || s.price || 0);
      const bookedSeats = s.booked_seats || 0;
      const availableSeats = s.available_seats ?? s.seats_available ?? 0;
      const totalSeats = s.total_seats || (bookedSeats + availableSeats) || 0;

      // resolve driver name from current assignment for this schedule's bus
      let driverName = null;
      try {
        const assignment = s.bus_id ? assignmentMap[s.bus_id] : null;
        if (assignment) {
          // priority: canonical user joined via Driver.user_id -> User.full_name
          const drv = assignment.Driver;
          if (drv && drv.user_id && usersById[drv.user_id]) {
            driverName = usersById[drv.user_id].full_name;
          } else if (assignment.driver_id && usersById[assignment.driver_id]) {
            driverName = usersById[assignment.driver_id].full_name;
          } else if (drv && drv.name) {
            driverName = drv.name;
          }
        }
      } catch (e) {
        console.warn('Error resolving driver name for schedule', s.id, e);
      }

      return {
        id: s.id,
        routeFrom: s.Route?.origin || s.route_from || s.from || 'N/A',
        routeTo: s.Route?.destination || s.route_to || s.to || 'N/A',
        departureTime: s.departure_time || s.time || null,
        scheduleDate: s.schedule_date || s.date || null,
        arrivalTime: s.arrival_time || null,
        price,
        seatsAvailable: availableSeats,
        totalSeats,
        bookedSeats,
        busPlateNumber: s.Bus?.plate_number || null,
        driverName: driverName || null,
        status: s.status || 'scheduled',
        revenue: bookedSeats * price
      };
    });

    res.json({ schedules: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getTickets = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) {
      console.log('No company ID found for user:', userId);
      return res.json({ tickets: [] });
    }

    console.log('Fetching tickets for company:', companyId);

    const tickets = await Ticket.findAll({ 
      where: { company_id: companyId },
      include: [
        {
          model: User,
          as: 'passenger',
          attributes: ['id', 'full_name', 'email', 'phone_number'],
          required: false
        },
        {
          model: Schedule,
          attributes: ['id', 'schedule_date', 'departure_time', 'price_per_seat'],
          required: false,
          include: [
            {
              model: Route,
              attributes: ['id', 'origin', 'destination'],
              required: false
            },
            {
              model: Bus,
              attributes: ['id', 'plate_number', 'model'],
              required: false
            }
          ]
        }
      ],
      order: [['booked_at', 'DESC']]
    });

    console.log(`Found ${tickets.length} tickets for company ${companyId}`);

    const mapped = tickets.map(t => {
      const passenger = t.passenger;
      const schedule = t.Schedule;
      const route = schedule?.Route;
      const bus = schedule?.Bus;

      return {
        id: t.id,
        bookingRef: t.booking_ref,
        price: parseFloat(t.price || 0),
        paymentStatus: t.status === 'CONFIRMED' || t.status === 'CHECKED_IN' ? 'paid' : 'unpaid',
        seatNumber: t.seat_number,
        qrCode: t.qr_code_url || null,
        status: t.status,
        scanned: !!t.checked_in_at,
        bookedAt: t.booked_at,
        checkedInAt: t.checked_in_at,
        scheduleId: t.schedule_id,
        // Passenger info
        passengerName: passenger ? passenger.full_name : 'N/A',
        passengerEmail: passenger?.email || 'N/A',
        passengerPhone: passenger?.phone_number || 'N/A',
        // Schedule info
        scheduleDate: schedule?.schedule_date || null,
        departureTime: schedule?.departure_time || null,
        // Route info
        routeFrom: route?.origin || 'N/A',
        routeTo: route?.destination || 'N/A',
        // Bus info
        busPlateNumber: bus?.plate_number || 'N/A',
        busModel: bus?.model || 'N/A'
      };
    });

    console.log(`Returning ${mapped.length} mapped tickets`);
    res.json({ tickets: mapped });
  } catch (error) {
    console.error('getTickets error:', error);
    res.status(400).json({ error: error.message });
  }
};

const updateTicket = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;

    if (!companyId) {
      await transaction.rollback();
      return res.status(403).json({ error: 'No company associated with user' });
    }

    // Find ticket with schedule information
    const ticket = await Ticket.findByPk(id, { 
      include: [{
        model: Schedule,
        attributes: ['id', 'departure_time', 'schedule_date']
      }],
      transaction 
    });
    
    if (!ticket) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Verify ticket belongs to company
    if (ticket.company_id !== companyId) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Unauthorized to update this ticket' });
    }

    const previousStatus = ticket.status;

    // TIME-BASED CANCELLATION RULE: Check if cancelling and validate timing
    if (status === 'CANCELLED' && (previousStatus === 'CONFIRMED' || previousStatus === 'CHECKED_IN')) {
      const schedule = ticket.Schedule;
      
      if (!schedule) {
        await transaction.rollback();
        return res.status(400).json({ 
          success: false,
          error: 'Schedule not found for this ticket' 
        });
      }

      // Get departure time
      const departureTime = schedule.departure_time;
      
      if (!departureTime) {
        await transaction.rollback();
        return res.status(400).json({ 
          success: false,
          error: 'Departure time not set for this schedule' 
        });
      }

      // Calculate time difference
      const now = new Date();
      const departure = new Date(departureTime);
      const timeDiffMinutes = (departure.getTime() - now.getTime()) / (1000 * 60);

      console.log(`[updateTicket] Cancellation check: Departure in ${timeDiffMinutes.toFixed(2)} minutes`);
      
      // Block cancellation if less than 10 minutes before departure
      if (timeDiffMinutes < 10) {
        await transaction.rollback();
        return res.status(400).json({ 
          success: false,
          error: 'Ticket cannot be cancelled less than 10 minutes before departure',
          message: 'Ticket cannot be cancelled less than 10 minutes before departure',
          minutesRemaining: Math.round(timeDiffMinutes)
        });
      }

      console.log(`[updateTicket] ✅ Cancellation allowed: ${timeDiffMinutes.toFixed(2)} minutes before departure`);
    }

    // Update ticket status
    if (status) {
      ticket.status = status;
      
      // If marking as checked in, set checked_in_at timestamp
      if (status === 'CHECKED_IN' && !ticket.checked_in_at) {
        ticket.checked_in_at = new Date();
      }
      
      await ticket.save({ transaction });

      // If cancelling a CONFIRMED or CHECKED_IN ticket, free up the seat
      if (status === 'CANCELLED' && (previousStatus === 'CONFIRMED' || previousStatus === 'CHECKED_IN')) {
        const schedule = await Schedule.findByPk(ticket.schedule_id, { 
          transaction, 
          lock: transaction.LOCK.UPDATE
        });
        
        if (schedule) {
          // Increment available seats and decrement booked seats
          schedule.available_seats = parseInt(schedule.available_seats || 0) + 1;
          schedule.booked_seats = Math.max(0, parseInt(schedule.booked_seats || 0) - 1);
          await schedule.save({ transaction });
          
          console.log(`[updateTicket] ✅ Seat ${ticket.seat_number} on schedule ${ticket.schedule_id} is now AVAILABLE`);
          console.log(`[updateTicket] Schedule ${ticket.schedule_id}: ${schedule.available_seats} available, ${schedule.booked_seats} booked`);
        }
      }
    }

    await transaction.commit();

    res.json({ 
      success: true,
      message: status === 'CANCELLED' ? 'Ticket cancelled successfully' : 'Ticket updated successfully', 
      ticket: {
        id: ticket.id,
        status: ticket.status,
        checkedInAt: ticket.checked_in_at
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('updateTicket error:', error);
    res.status(400).json({ error: error.message });
  }
};

const getDrivers = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.json({ drivers: [] });

    // Prefer canonical User records where role='driver'
    const driverUsers = await User.findAll({ where: { company_id: companyId, role: 'driver' } });

    // Fetch legacy Driver rows for license lookups and include unmatched legacy drivers
    const legacyDrivers = await Driver.findAll({ where: { company_id: companyId } });

    // Fetch buses for company and group by driver_id (canonical user ids)
    const buses = await Bus.findAll({ where: { company_id: companyId }, attributes: ['id','plate_number','model','capacity','status','driver_id'] });
    const busesByDriver = {};
    buses.forEach(b => {
      if (!b.driver_id) return;
      busesByDriver[b.driver_id] = busesByDriver[b.driver_id] || [];
      busesByDriver[b.driver_id].push({ id: b.id, plate_number: b.plate_number, model: b.model, capacity: b.capacity, status: b.status });
    });

    // Helper: find legacy driver by phone/email/name
    const legacyMatchedIds = new Set();
    const findLegacyForUser = (user) => {
      if (!legacyDrivers || legacyDrivers.length === 0) return null;
      const phone = user.phone_number || null;
      const email = user.email || null;
      const name = (user.full_name || '').trim().toLowerCase();
      const match = legacyDrivers.find(ld => {
        if (phone && ld.phone && String(ld.phone).trim() === String(phone).trim()) return true;
        if (email && ld.email && String(ld.email).trim().toLowerCase() === String(email).trim().toLowerCase()) return true;
        if (name && ld.name && String(ld.name).trim().toLowerCase() === name) return true;
        return false;
      });
      if (match) legacyMatchedIds.add(match.id);
      return match;
    };

    const mapped = driverUsers.map(d => {
      const legacy = findLegacyForUser(d);
      return {
        id: d.id,
        name: d.full_name,
        email: d.email || null,
        phone: d.phone_number || null,
        license: legacy ? (legacy.license_number || null) : (d.license_number || null),
        available: d.is_active !== undefined ? d.is_active : true,
        buses: busesByDriver[d.id] || [],
        role: d.role || null,
        createdAt: d.created_at || d.createdAt || null,
        companyId: d.company_id || null
      };
    });

    // Include legacy-only drivers (not matched to canonical User)
    const unmatchedLegacy = (legacyDrivers || []).filter(ld => !legacyMatchedIds.has(ld.id));
    const legacyMapped = unmatchedLegacy.map(ld => ({
      id: `legacy-${ld.id}`,
      name: ld.name,
      email: ld.email || null,
      phone: ld.phone || null,
      license: ld.license_number || null,
      available: ld.is_active !== undefined ? ld.is_active : true,
      buses: [],
      role: 'legacy',
      createdAt: ld.created_at || ld.createdAt || null,
      companyId: ld.company_id || null
    }));

    res.json({ drivers: mapped.concat(legacyMapped) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Helper to accept frontend IDs like "legacy-<id>" and return normalized id
const parseDriverIdParam = (paramId) => {
  if (!paramId || typeof paramId !== 'string') return { isLegacy: false, id: paramId };
  if (paramId.startsWith('legacy-')) {
    return { isLegacy: true, id: paramId.slice('legacy-'.length) };
  }
  return { isLegacy: false, id: paramId };
};

const getDriver = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    // Normalize param (frontend may send legacy-<id> for legacy drivers)
    const { isLegacy, id: rawId } = parseDriverIdParam(req.params.id);

    if (!isLegacy) {
      // Try canonical User driver first
      const driverUser = await User.findByPk(rawId);
      if (driverUser && driverUser.role === 'driver' && driverUser.company_id === companyId) {
        return res.json({ driver: { id: driverUser.id, name: driverUser.full_name, license: null, phone: driverUser.phone_number, email: driverUser.email || null } });
      }
    }

    // Fallback to legacy Driver table (use rawId for lookup)
    const driver = await Driver.findByPk(rawId);
    if (!driver || driver.company_id !== companyId) return res.status(404).json({ error: 'Driver not found' });

    const mapped = {
      id: driver.id,
      name: driver.name,
      license: driver.license_number,
      phone: driver.phone,
      email: driver.email || null
    };
    res.json({ driver: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const createDriver = async (req, res) => {
  try {
    console.log('createDriver request payload:', req.body, 'userId:', req.userId);
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const { name, license, phone, email } = req.body;
    if (!name || !license) return res.status(400).json({ error: 'Name and license number are required' });

    // Create canonical User account for driver with generated password if email not provided
    const generatedEmail = email || `driver+${Date.now()}@local.invalid`;
    const generatedPassword = crypto.randomBytes(12).toString('hex');
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(generatedPassword, 10);

    // Create user with pre-hashed password and disable model hooks to avoid double-hashing
    const newUser = await User.create({
      email: generatedEmail,
      password: hashed,
      full_name: name,
      phone_number: phone || null,
      role: 'driver',
      company_id: companyId,
      email_verified: false,
      must_change_password: true
    }, { hooks: false });

    // Keep legacy Driver table in sync for compatibility
    const legacy = await Driver.create({ company_id: companyId, name, license_number: license, phone, is_active: true });

    console.log('createDriver: created user and legacy driver', newUser.id, legacy.id);

    // Send temporary password via email (and optional SMS)
    try {
      const { sendEmail, sendSMS } = require('../utils/mailer');
      const emailBody = `Hello ${name},\n\nAn account has been created for you on SafariTix. Use the temporary password below to log in and change your password immediately:\n\nTemporary password: ${generatedPassword}\n\nPlease change your password on first login.`;
      await sendEmail({ to: newUser.email, subject: 'Your SafariTix account', text: emailBody });
      if (phone) {
        await sendSMS({ to: phone, text: `SafariTix temporary password: ${generatedPassword}. Change it on first login.` });
      }
    } catch (e) {
      console.warn('Failed to send driver temporary credentials:', e && e.message ? e.message : e);
    }

    const mapped = {
      id: newUser.id,
      name: newUser.full_name,
      license,
      phone: newUser.phone_number || null,
      available: true,
      buses: []
    };

   res.status(201).json({
  driver: mapped,
  temporaryPassword: generatedPassword
});
  } catch (error) {
    console.error('createDriver error:', error);
    // Handle common Sequelize unique constraint for license numbers
    if (error && error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Driver with this license number already exists' });
    }
    res.status(400).json({ error: error.message });
  }
};

const updateDriver = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    // Normalize param to support legacy-<id>
    const { isLegacy, id: rawId } = parseDriverIdParam(req.params.id);

    if (!isLegacy) {
      // Try updating canonical User driver first
      const driverUser = await User.findByPk(rawId);
      if (driverUser && driverUser.role === 'driver' && driverUser.company_id === companyId) {
        const { name, phone, email } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        driverUser.full_name = name;
        driverUser.phone_number = phone || driverUser.phone_number;
        driverUser.email = email || driverUser.email;
        await driverUser.save();
        return res.json({ driver: { id: driverUser.id, name: driverUser.full_name, license: null, phone: driverUser.phone_number, email: driverUser.email } });
      }
    }

    // Fallback to legacy Driver
    const driver = await Driver.findByPk(rawId);
    if (!driver || driver.company_id !== companyId) return res.status(404).json({ error: 'Driver not found' });

    const { name, license, phone, email } = req.body;
    if (!name || !license) return res.status(400).json({ error: 'Name and license are required' });

    const existingLicense = await Driver.findOne({ where: { license_number: license, id: { [Op.ne]: rawId } } });
    if (existingLicense) return res.status(400).json({ error: 'License number already in use' });

    const existingPhone = phone ? await Driver.findOne({ where: { company_id: companyId, phone, id: { [Op.ne]: rawId } } }) : null;
    if (existingPhone) return res.status(400).json({ error: 'Phone number already in use for this company' });

    driver.name = name;
    driver.license_number = license;
    driver.phone = phone || null;
    driver.email = email || null;

    await driver.save();

    res.json({ driver: { id: driver.id, name: driver.name, license: driver.license_number, phone: driver.phone, email: driver.email } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteDriver = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    // Normalize param to support legacy-<id>
    const { isLegacy, id: rawId } = parseDriverIdParam(req.params.id);

    if (!isLegacy) {
      // Try canonical User driver first
      const driverUser = await User.findByPk(rawId);
      if (driverUser && driverUser.role === 'driver' && driverUser.company_id === companyId) {
        // Check active assignments both on buses and driver_assignments table
        const assignedBus = await Bus.findOne({ where: { driver_id: rawId } });
        const activeAssignment = await DriverAssignment.findOne({ where: { driver_id: rawId, unassigned_at: null } });
        if (assignedBus || activeAssignment) return res.status(400).json({ error: 'Cannot delete driver assigned to a bus or active assignment exists' });
        await driverUser.destroy();
        return res.json({ message: 'Driver deleted', driverId: rawId });
      }
    }

    // Fallback to legacy
    const driver = await Driver.findByPk(rawId);
    if (!driver || driver.company_id !== companyId) return res.status(404).json({ error: 'Driver not found' });
    // Check active assignments for legacy driver id
    const assignedBusLegacy = await Bus.findOne({ where: { driver_id: rawId } });
    const activeAssignmentLegacy = await DriverAssignment.findOne({ where: { driver_id: rawId, unassigned_at: null } });
    if (assignedBusLegacy || activeAssignmentLegacy) return res.status(400).json({ error: 'Cannot delete driver assigned to a bus or active assignment exists' });
    await Driver.destroy({ where: { id: rawId } });
    res.json({ message: 'Driver deleted', driverId: rawId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const createSchedule = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    
    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const { busId, routeFrom, routeTo, departureTime, arrivalTime, price, date, driverId } = req.body;

    if (!busId || !routeFrom || !routeTo || !departureTime || !arrivalTime || !price || !date) {
      return res.status(400).json({ error: 'Bus, route, times, price, and date are required' });
    }

    // Verify bus exists and belongs to this company
    const bus = await Bus.findByPk(busId);
    if (!bus || bus.company_id !== companyId) {
      return res.status(400).json({ error: 'Invalid bus for this company' });
    }

    // Reject scheduling on inactive buses
    if (bus.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Cannot schedule an INACTIVE bus' });
    }

    // Verify driver if provided (prefer canonical User)
    if (driverId) {
      const driverUser = await User.findByPk(driverId);
      if (driverUser) {
        if (driverUser.role !== 'driver' || driverUser.company_id !== companyId) {
          return res.status(400).json({ error: 'Invalid driver for this company' });
        }
      } else {
        const driver = await Driver.findByPk(driverId);
        if (!driver || driver.company_id !== companyId) {
          return res.status(400).json({ error: 'Invalid driver for this company' });
        }
      }
    }

    // Find or create route
    let route = await Route.findOne({
      where: {
        company_id: companyId,
        origin: routeFrom,
        destination: routeTo
      }
    });

    if (!route) {
      route = await Route.create({
        company_id: companyId,
        name: `${routeFrom} - ${routeTo}`,
        origin: routeFrom,
        destination: routeTo
      });
    }

    const normalizedTimes = await normalizeScheduleTimesForStorage(date, departureTime, arrivalTime);

    // Create schedule
    const schedule = await Schedule.create({
      bus_id: busId,
      route_id: route.id,
      driver_id: driverId || null,
      company_id: companyId,
      schedule_date: normalizedTimes.scheduleDate,
      departure_time: normalizedTimes.departureTime,
      arrival_time: normalizedTimes.arrivalTime,
      price_per_seat: parseFloat(price),
      available_seats: bus.capacity,
      status: 'scheduled',
      created_by: userId
    });

    const mapped = {
      id: schedule.id,
      busId: schedule.bus_id,
      routeFrom: route.origin,
      routeTo: route.destination,
      departureTime: schedule.departure_time,
      arrivalTime: schedule.arrival_time,
      date: schedule.schedule_date,
      price: parseFloat(schedule.price_per_seat),
      seatsAvailable: schedule.available_seats,
      totalSeats: bus.capacity,
      driverId: schedule.driver_id
    };

    res.status(201).json({ schedule: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateSchedule = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    
    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const scheduleId = req.params.id;
    const schedule = await Schedule.findByPk(scheduleId);

    if (!schedule || schedule.company_id !== companyId) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const { route_from, route_to, schedule_date, departure_time, arrival_time, bus_plate_number, price_per_seat, total_seats } = req.body;

    // Update schedule fields
    if (route_from) schedule.route_from = route_from;
    if (route_to) schedule.route_to = route_to;
    if (schedule_date || departure_time || arrival_time) {
      const normalizedTimes = await normalizeScheduleTimesForStorage(
        schedule_date || schedule.schedule_date,
        departure_time || schedule.departure_time,
        arrival_time || schedule.arrival_time
      );
      schedule.schedule_date = normalizedTimes.scheduleDate;
      schedule.departure_time = normalizedTimes.departureTime;
      schedule.arrival_time = normalizedTimes.arrivalTime;
    }
    if (price_per_seat) schedule.price_per_seat = parseFloat(price_per_seat);
    if (total_seats) schedule.total_seats = parseInt(total_seats);

    // Update bus if plate number provided
    if (bus_plate_number) {
      const bus = await Bus.findOne({ where: { plate_number: bus_plate_number, company_id: companyId } });
      if (bus) {
        schedule.bus_id = bus.id;
      }
    }

    await schedule.save();

    res.json({ message: 'Schedule updated successfully', schedule });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteSchedule = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    
    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const scheduleId = req.params.id;
    const schedule = await Schedule.findByPk(scheduleId);

    if (!schedule || schedule.company_id !== companyId) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Check if there are any bookings
    const bookingCount = schedule.booked_seats || 0;
    if (bookingCount > 0) {
      return res.status(400).json({ error: 'Cannot delete schedule with existing bookings' });
    }

    await schedule.destroy();

    res.json({ message: 'Schedule deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const reopenScheduleTickets = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const scheduleId = req.params.id;
    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule || schedule.company_id !== companyId) return res.status(404).json({ error: 'Schedule not found' });

    // Only admins can reopen (already enforced by route role guard)
    schedule.ticket_status = 'OPEN';
    await schedule.save();

    // Create schedule journal entry
    const ScheduleJournal = require('../models/ScheduleJournal');
    await ScheduleJournal.create({
      company_id: companyId,
      schedule_id: scheduleId,
      action: 'REOPEN_TICKET_SALES',
      performed_by: userId,
      note: req.body.note || null
    });

    res.json({ message: 'Ticket sales reopened', scheduleId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getScheduleJournals = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const scheduleId = req.params.id;
    const ScheduleJournal = require('../models/ScheduleJournal');
    const journals = await ScheduleJournal.findAll({ where: { schedule_id: scheduleId, company_id: companyId }, order: [['created_at','DESC']] });

    const mapped = journals.map(j => ({ id: j.id, action: j.action, performedBy: j.performed_by, note: j.note, createdAt: j.created_at }));
    res.json({ journals: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const patchBusStatus = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    const companyId = user?.company_id;

    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const busId = req.params.id;
    const { status } = req.body;

    const bus = await busService.setStatus(companyId, busId, status, { updatedBy: userId });
    if (!bus) return res.status(404).json({ error: 'Bus not found' });

    const mapped = {
      id: bus.id,
      plateNumber: bus.plate_number,
      model: bus.model,
      capacity: bus.capacity,
      seatLayout: bus.seat_layout,
      driverId: bus.driver_id || null,
      status: bus.status.toLowerCase()
    };

    res.json({ bus: mapped });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findByPk(userId);
    
    // Find company ID (same logic as getCompany)
    let companyId = user?.company_id;
    
    if (!companyId) {
      const company = await Company.findOne({ where: { owner_id: userId } });
      companyId = company?.id;
    }
    
    console.log('getDashboardStats for user:', userId, 'company:', companyId);
    
    if (!companyId) {
      console.log('No company found, returning empty stats');
      return res.json({
        balance: 0,
        sales: 0,
        totalProfit: 0,
        balanceGrowth: 0,
        salesGrowth: 0,
        weekData: [],
        recentSales: [],
        lastOrders: [],
        profitBreakdown: {}
      });
    }

    // Get all confirmed tickets for this company
    const allTickets = await Ticket.findAll({
      where: {
        company_id: companyId,
        status: { [Op.in]: ['CONFIRMED', 'CHECKED_IN'] }
      },
      include: [
        {
          model: User,
          as: 'passenger',
          attributes: ['id', 'full_name', 'email'],
          required: false
        },
        {
          model: Schedule,
          attributes: ['id', 'schedule_date', 'departure_time'],
          required: false,
          include: [
            {
              model: Route,
              attributes: ['origin', 'destination'],
              required: false
            }
          ]
        }
      ],
      order: [['booked_at', 'DESC']]
    });

    // Calculate total revenue
    const totalRevenue = allTickets.reduce((sum, ticket) => sum + parseFloat(ticket.price || 0), 0);
    
    // Get tickets from last 30 days for growth calculation
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const last30DaysTickets = allTickets.filter(t => new Date(t.booked_at) >= thirtyDaysAgo);
    const last30DaysRevenue = last30DaysTickets.reduce((sum, t) => sum + parseFloat(t.price || 0), 0);
    
    // Get tickets from previous 30 days for comparison
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    
    const previous30DaysTickets = allTickets.filter(t => {
      const bookedAt = new Date(t.booked_at);
      return bookedAt >= sixtyDaysAgo && bookedAt < thirtyDaysAgo;
    });
    const previous30DaysRevenue = previous30DaysTickets.reduce((sum, t) => sum + parseFloat(t.price || 0), 0);
    
    // Calculate growth percentages
    const revenueGrowth = previous30DaysRevenue > 0 
      ? ((last30DaysRevenue - previous30DaysRevenue) / previous30DaysRevenue * 100).toFixed(1)
      : 0;
    
    const salesCountGrowth = previous30DaysTickets.length > 0
      ? ((last30DaysTickets.length - previous30DaysTickets.length) / previous30DaysTickets.length * 100).toFixed(1)
      : 0;

    // Get last 7 days data for weekly chart
    const weekData = [];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      
      const dayTickets = allTickets.filter(t => {
        const bookedAt = new Date(t.booked_at);
        return bookedAt >= date && bookedAt < nextDate;
      });
      
      const dayRevenue = dayTickets.reduce((sum, t) => sum + parseFloat(t.price || 0), 0);
      
      weekData.push({
        day: days[date.getDay()],
        value: Math.round(dayRevenue)
      });
    }

    // Get recent sales (last 10 bookings)
    const recentSales = allTickets.slice(0, 10).map(ticket => {
      const timeDiff = Date.now() - new Date(ticket.booked_at).getTime();
      const minutesAgo = Math.floor(timeDiff / 60000);
      
      let timestamp;
      if (minutesAgo < 60) {
        timestamp = `${minutesAgo} Minutes Ago`;
      } else if (minutesAgo < 1440) {
        timestamp = `${Math.floor(minutesAgo / 60)} Hours Ago`;
      } else {
        timestamp = `${Math.floor(minutesAgo / 1440)} Days Ago`;
      }
      
      return {
        id: ticket.id,
        customerName: ticket.passenger?.full_name || 'Anonymous',
        customerAvatar: '👤',
        amount: parseFloat(ticket.price || 0),
        timestamp
      };
    });

    // Get top orders (highest value tickets)
    const topOrders = [...allTickets]
      .sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0))
      .slice(0, 5)
      .map(ticket => {
        const bookedDate = new Date(ticket.booked_at);
        const formattedDate = bookedDate.toLocaleDateString('en-GB', { 
          day: '2-digit', 
          month: 'short', 
          year: 'numeric' 
        });
        
        return {
          id: ticket.id,
          customerName: ticket.passenger?.full_name || 'Anonymous',
          customerAvatar: '👤',
          amount: parseFloat(ticket.price || 0),
          status: ticket.status === 'CHECKED_IN' ? 'completed' : 'completed',
          date: formattedDate
        };
      });

    // Calculate profit breakdown by route
    const routeRevenue = {};
    allTickets.forEach(ticket => {
      const route = ticket.Schedule?.Route;
      if (route) {
        const routeKey = `${route.origin} - ${route.destination}`;
        if (!routeRevenue[routeKey]) {
          routeRevenue[routeKey] = 0;
        }
        routeRevenue[routeKey] += parseFloat(ticket.price || 0);
      }
    });

    // Get top 3 routes by revenue
    const sortedRoutes = Object.entries(routeRevenue)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    const profitBreakdown = {};
    let topRoutesTotal = 0;
    
    sortedRoutes.forEach(([route, revenue], index) => {
      const percentage = totalRevenue > 0 ? (revenue / totalRevenue * 100).toFixed(0) : 0;
      profitBreakdown[route] = {
        amount: Math.round(revenue),
        percentage: parseInt(percentage)
      };
      topRoutesTotal += revenue;
    });

    // Add "Other" category for remaining routes
    const otherRevenue = totalRevenue - topRoutesTotal;
    if (otherRevenue > 0) {
      const percentage = totalRevenue > 0 ? (otherRevenue / totalRevenue * 100).toFixed(0) : 0;
      profitBreakdown['Other Routes'] = {
        amount: Math.round(otherRevenue),
        percentage: parseInt(percentage)
      };
    }

    // Get active trips count (schedules with status 'in_progress')
    const activeTripsCount = await Schedule.count({
      where: {
        company_id: companyId,
        status: 'in_progress'
      }
    });

    console.log('Active trips count:', activeTripsCount);

    const responseData = {
      balance: Math.round(totalRevenue),
      sales: Math.round(last30DaysRevenue),
      totalProfit: Math.round(totalRevenue),
      balanceGrowth: parseFloat(revenueGrowth),
      salesGrowth: parseFloat(salesCountGrowth),
      activeTrips: activeTripsCount,
      weekData,
      recentSales,
      lastOrders: topOrders,
      profitBreakdown
    };

    console.log('Returning dashboard stats:', JSON.stringify(responseData, null, 2));
    res.json(responseData);

  } catch (error) {
    console.error('getDashboardStats error:', error);
    res.status(400).json({ error: error.message });
  }
};

const getActiveTrips = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    
    if (!companyId) {
      return res.json({ activeTrips: [] });
    }

    // Fetch all schedules with status 'in_progress' for this company
    const activeSchedules = await Schedule.findAll({
      where: {
        company_id: companyId,
        status: 'in_progress'
      },
      include: [
        {
          model: Route,
          attributes: ['origin', 'destination'],
          required: false
        },
        {
          model: Bus,
          attributes: ['id', 'plate_number'],
          required: false
        }
      ],
      order: [['trip_start_time', 'DESC']]
    });

    // Get driver names for each schedule
    const busIds = activeSchedules.map(s => s.bus_id).filter(Boolean);
    let driversByBusId = {};
    
    if (busIds.length > 0) {
      const DriverAssignment = require('../models').DriverAssignment;
      const assignments = await DriverAssignment.findAll({
        where: {
          bus_id: busIds,
          company_id: companyId,
          unassigned_at: null
        },
        include: [{
          model: require('../models').Driver,
          required: false
        }]
      });

      // Get user info for drivers
      const userIds = new Set();
      assignments.forEach(a => {
        if (a.Driver && a.Driver.user_id) userIds.add(a.Driver.user_id);
        if (a.driver_id && a.driver_id.length === 36) userIds.add(a.driver_id);
      });

      const users = await User.findAll({
        where: { id: Array.from(userIds) },
        attributes: ['id', 'full_name']
      });
      
      const usersById = {};
      users.forEach(u => { usersById[u.id] = u; });

      // Map bus_id to driver name
      assignments.forEach(a => {
        if (!a.bus_id) return;
        const drv = a.Driver;
        let driverName = null;
        if (drv && drv.user_id && usersById[drv.user_id]) {
          driverName = usersById[drv.user_id].full_name;
        } else if (a.driver_id && usersById[a.driver_id]) {
          driverName = usersById[a.driver_id].full_name;
        } else if (drv && drv.name) {
          driverName = drv.name;
        }
        if (driverName) {
          driversByBusId[a.bus_id] = driverName;
        }
      });
    }

    const activeTrips = activeSchedules.map(schedule => {
      return {
        id: schedule.id,
        scheduleId: schedule.id,
        busPlate: schedule.Bus?.plate_number || 'Unknown',
        driverName: driversByBusId[schedule.bus_id] || null,
        routeFrom: schedule.Route?.origin || 'N/A',
        routeTo: schedule.Route?.destination || 'N/A',
        departureTime: schedule.departure_time,
        tripStartTime: schedule.trip_start_time,
        status: schedule.status
      };
    });

    console.log(`Returning ${activeTrips.length} active trips for company ${companyId}`);
    res.json({ activeTrips });

  } catch (error) {
    console.error('Error fetching active trips:', error);
    res.status(400).json({ error: error.message });
  }
};

const getRevenue = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = req.companyId || (await User.findByPk(userId)).company_id;
    if (!companyId) {
      return res.json({
        totalRevenue: 0,
        totalTickets: 0,
        todayRevenue: 0,
        todayTickets: 0,
        weekRevenue: 0,
        weekTickets: 0,
        monthRevenue: 0,
        monthTickets: 0,
        dailyRevenue: [],
        breakdownByRoute: []
      });
    }

    const { startDate, endDate } = req.query;

    // Build date filters
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        schedule_date: {
          [Op.between]: [startDate, endDate]
        }
      };
    }

    // Fetch all schedules for the company
    const schedules = await Schedule.findAll({
      where: {
        company_id: companyId,
        ...dateFilter
      },
      include: [
        {
          model: Route,
          attributes: ['id', 'origin', 'destination']
        },
        {
          model: Bus,
          attributes: ['id', 'plate_number']
        }
      ],
      order: [['schedule_date', 'DESC']]
    });

    // Calculate revenue from schedules (sold seats × price)
    let totalRevenue = 0;
    let totalTickets = 0;
    const dailyRevenueMap = new Map();
    const routeBreakdownMap = new Map();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const monthAgoStr = monthAgo.toISOString().split('T')[0];

    let todayRevenue = 0;
    let todayTickets = 0;
    let weekRevenue = 0;
    let weekTickets = 0;
    let monthRevenue = 0;
    let monthTickets = 0;

    schedules.forEach(s => {
      const totalSeats = s.total_seats || 0;
      const availableSeats = s.available_seats != null ? s.available_seats : totalSeats;
      const soldSeats = totalSeats - availableSeats;
      const price = parseFloat(s.price_per_seat || 0);
      const scheduleRevenue = soldSeats * price;

      totalRevenue += scheduleRevenue;
      totalTickets += soldSeats;

      const scheduleDate = s.schedule_date;
      if (scheduleDate) {
        // Daily revenue aggregation
        if (!dailyRevenueMap.has(scheduleDate)) {
          dailyRevenueMap.set(scheduleDate, { date: scheduleDate, revenue: 0, tickets: 0 });
        }
        const dayData = dailyRevenueMap.get(scheduleDate);
        dayData.revenue += scheduleRevenue;
        dayData.tickets += soldSeats;

        // Today's revenue
        if (scheduleDate === todayStr) {
          todayRevenue += scheduleRevenue;
          todayTickets += soldSeats;
        }

        // Week revenue
        if (scheduleDate >= weekAgoStr) {
          weekRevenue += scheduleRevenue;
          weekTickets += soldSeats;
        }

        // Month revenue
        if (scheduleDate >= monthAgoStr) {
          monthRevenue += scheduleRevenue;
          monthTickets += soldSeats;
        }
      }

      // Route breakdown
      const route = s.Route;
      const routeName = route ? `${route.origin} → ${route.destination}` : 'Unknown Route';
      const key = `${routeName}_${scheduleDate}_${s.departure_time}`;
      
      if (!routeBreakdownMap.has(key)) {
        routeBreakdownMap.set(key, {
          route: routeName,
          scheduleDate: scheduleDate || '—',
          departureTime: s.departure_time || '—',
          ticketsSold: 0,
          revenue: 0
        });
      }
      const routeData = routeBreakdownMap.get(key);
      routeData.ticketsSold += soldSeats;
      routeData.revenue += scheduleRevenue;
    });

    // Convert maps to arrays
    const dailyRevenue = Array.from(dailyRevenueMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30); // Last 30 days

    const breakdownByRoute = Array.from(routeBreakdownMap.values())
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      totalRevenue: Math.round(totalRevenue),
      totalTickets,
      todayRevenue: Math.round(todayRevenue),
      todayTickets,
      weekRevenue: Math.round(weekRevenue),
      weekTickets,
      monthRevenue: Math.round(monthRevenue),
      monthTickets,
      dailyRevenue,
      breakdownByRoute
    });

  } catch (error) {
    console.error('getRevenue error:', error);
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  getCompany,
  getBuses,
  createBus,
  assignBusDriver,
  getSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  getTickets,
  updateTicket,
  getDrivers,
  createDriver,
  getDriver,
  patchBusStatus,
  updateBus,
  updateDriver,
  deleteDriver,
  deleteBus,
  reopenScheduleTickets,
  getScheduleJournals,
  getDashboardStats,
  getActiveTrips,
  getRevenue
};


