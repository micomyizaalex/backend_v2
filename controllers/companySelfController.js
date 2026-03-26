const { Company, Bus, Schedule, Ticket, User, Driver, Route, DriverAssignment, Payment, sequelize } = require('../models');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { QueryTypes } = require('sequelize');
const busService = require('../services/busService');
const NotificationService = require('../services/notificationService');
const { DEFAULT_PLAN, getPlanPermissions, normalizePlan, hasPlanFeature, isPlanUpgrade } = require('../utils/subscriptionPlans');

let scheduleTimeStorageMode = null; // "time" | "timestamp"

sequelize.query(`
  CREATE TABLE IF NOT EXISTS subscription_requests (
    id UUID PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    current_plan VARCHAR(50) NOT NULL,
    requested_plan VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    notes TEXT,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`).catch((err) => console.warn('subscription_requests table init failed:', err.message));

sequelize.query(`
  CREATE INDEX IF NOT EXISTS idx_subscription_requests_company_created
  ON subscription_requests(company_id, created_at DESC)
`).catch((err) => console.warn('subscription_requests index init failed:', err.message));

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

async function getCompanyPlanContext(companyId) {
  const company = await Company.findByPk(companyId);
  const plan = normalizePlan(company?.plan || company?.subscription_plan) || DEFAULT_PLAN;
  return {
    company,
    plan,
    permissions: getPlanPermissions(plan),
  };
}

async function resolveCompanyId(req) {
  if (req.companyId) return req.companyId;
  const user = await User.findByPk(req.userId);
  if (user && user.company_id) return user.company_id;
  const company = await Company.findOne({ where: { owner_id: req.userId } });
  return company ? company.id : null;
}

const mapSubscriptionRequestRow = (row) => {
  if (!row) return null;

  return {
    id: row.id,
    companyId: row.company_id,
    requestedBy: row.requested_by,
    currentPlan: normalizePlan(row.current_plan) || DEFAULT_PLAN,
    requestedPlan: normalizePlan(row.requested_plan) || DEFAULT_PLAN,
    status: row.status,
    notes: row.notes || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

async function getLatestSubscriptionRequest(companyId) {
  const [rows] = await sequelize.query(
    `SELECT *
     FROM subscription_requests
     WHERE company_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    {
      bind: [companyId],
    }
  );

  return mapSubscriptionRequestRow(rows[0] || null);
}

// Get company for current user
const getCompany = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    if (!companyId) return res.status(200).json({ company: null });

    const company = await Company.findByPk(companyId);
    const owner = await User.findByPk(company.owner_id);
    const latestSubscriptionRequest = await getLatestSubscriptionRequest(companyId);

    // Map DB fields to frontend expected shape
    const mapped = {
      id: company.id,
      name: company.name,
      email: company.email || owner?.email || '',
      phone: company.phone || owner?.phone_number || '',
      address: company.address || '',
      status: company.status,
      accountStatus: owner?.account_status || company.status,
      account_status: owner?.account_status || company.status,
      companyVerified: !!owner?.company_verified,
      company_verified: !!owner?.company_verified,
      is_approved: !!company.is_approved,
      rejection_reason: company.rejection_reason || null,
      subscriptionStatus: company.subscription_status || 'inactive',
      subscriptionPaid: !!company.subscription_paid,
      plan: normalizePlan(company.plan || company.subscription_plan) || DEFAULT_PLAN,
      subscriptionPlan: normalizePlan(company.plan || company.subscription_plan) || DEFAULT_PLAN,
      nextPayment: company.next_payment || null,
      planPermissions: getPlanPermissions(company.plan || company.subscription_plan || DEFAULT_PLAN),
      latestSubscriptionRequest,
    };

    res.json({ company: mapped });
  } catch (error) {
    console.error('createBus error:', error);
    res.status(400).json({ error: error.message });
  }
};

const getSubscriptionRequest = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    if (!companyId) {
      return res.status(200).json({ request: null });
    }

    const latestRequest = await getLatestSubscriptionRequest(companyId);
    res.json({ request: latestRequest });
  } catch (error) {
    console.error('getSubscriptionRequest error:', error);
    res.status(400).json({ error: error.message });
  }
};

const createSubscriptionRequest = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    if (!companyId) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const requestedPlan = normalizePlan(req.body.requested_plan);
    if (!requestedPlan) {
      return res.status(400).json({ error: 'requested_plan must be Starter, Growth, or Enterprise' });
    }

    const company = await Company.findByPk(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const currentPlan = normalizePlan(company.plan || company.subscription_plan) || DEFAULT_PLAN;
    if (!isPlanUpgrade(currentPlan, requestedPlan)) {
      return res.status(400).json({ error: 'Only plan upgrades can be requested from this page' });
    }

    const [pendingRows] = await sequelize.query(
      `SELECT id
       FROM subscription_requests
       WHERE company_id = $1
         AND status = 'pending'
         AND requested_plan = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      {
        bind: [companyId, requestedPlan],
      }
    );

    if (pendingRows[0]) {
      return res.status(409).json({ error: 'A pending request for this plan already exists' });
    }

    const requestId = crypto.randomUUID();
    await sequelize.query(
      `INSERT INTO subscription_requests (
         id,
         company_id,
         requested_by,
         current_plan,
         requested_plan,
         status,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())`,
      {
        bind: [requestId, companyId, req.userId, currentPlan, requestedPlan],
      }
    );

    const latestRequest = await getLatestSubscriptionRequest(companyId);

    try {
      await NotificationService.createNotificationForRole(
        'admin',
        'Subscription Upgrade Request',
        `${company.name} requested upgrade from ${currentPlan} to ${requestedPlan}`,
        'subscription_upgrade_request',
        {
          link: '/dashboard/admin/subscription-requests',
          relatedId: latestRequest?.id || requestId,
          relatedType: 'subscription_request',
          data: {
            companyId,
            companyName: company.name,
            currentPlan,
            requestedPlan,
          },
        }
      );
    } catch (notificationError) {
      console.error('createSubscriptionRequest notification error:', notificationError);
    }

    res.status(201).json({
      success: true,
      message: `Upgrade request submitted for ${requestedPlan}`,
      request: latestRequest,
    });
  } catch (error) {
    console.error('createSubscriptionRequest error:', error);
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
    const currentUser = await User.findByPk(req.userId);
    const companyId = req.companyId || currentUser?.company_id;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    const { permissions, plan } = await getCompanyPlanContext(companyId);
    if (permissions.limits.maxBuses !== null) {
      const existingBusCount = await Bus.count({ where: { company_id: companyId } });
      if (existingBusCount >= permissions.limits.maxBuses) {
        return res.status(403).json({
          error: `The ${plan} plan allows up to ${permissions.limits.maxBuses} buses`,
          code: 'PLAN_BUS_LIMIT_REACHED',
          subscriptionPlan: plan,
          permissions,
        });
      }
    }
    const userId = req.userId;

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

    const ticketsTable = await sequelize.getQueryInterface().describeTable('tickets');
    const hasTripDateColumn = Boolean(ticketsTable?.trip_date);
    const hasFromStopColumn = Boolean(ticketsTable?.from_stop);
    const hasToStopColumn = Boolean(ticketsTable?.to_stop);
    const hasPassengerNameColumn = Boolean(ticketsTable?.passenger_name);
    const busSchedulesCheck = await sequelize.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'bus_schedules'
        ) AS exists
      `,
      { type: QueryTypes.SELECT }
    );
    const hasBusSchedulesTable = Boolean(busSchedulesCheck?.[0]?.exists);

    const sharedScheduleSelect = hasBusSchedulesTable
      ? `
          bs.date AS bs_date,
          bs.time AS bs_time,
          rr.from_location AS rr_from_location,
          rr.to_location AS rr_to_location,
          bb.plate_number AS bs_bus_plate_number,
          bb.model AS bs_bus_model,
          bs.company_id AS bs_company_id
        `
      : `
          NULL::date AS bs_date,
          NULL::time AS bs_time,
          NULL::text AS rr_from_location,
          NULL::text AS rr_to_location,
          NULL::text AS bs_bus_plate_number,
          NULL::text AS bs_bus_model,
          NULL::uuid AS bs_company_id
        `;

    const sharedScheduleJoin = hasBusSchedulesTable
      ? `
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses bb ON bb.id = bs.bus_id
      `
      : '';

    const companyOwnershipFilter = hasBusSchedulesTable
      ? `(t.company_id = :companyId OR s.company_id = :companyId OR bs.company_id::text = CAST(:companyId AS text))`
      : `(t.company_id = :companyId OR s.company_id = :companyId)`;

    const passengerNameExpr = hasPassengerNameColumn ? 't.passenger_name' : 'NULL::text';

    const ticketRows = await sequelize.query(
      `
        SELECT
          t.id,
          t.booking_ref,
          t.price,
          t.status,
          t.seat_number,
          t.qr_code_url,
          t.booked_at,
          t.checked_in_at,
          t.schedule_id,
          ${hasTripDateColumn ? 't.trip_date' : 'NULL::date AS trip_date'},
          ${hasFromStopColumn ? 't.from_stop' : 'NULL::text AS from_stop'},
          ${hasToStopColumn ? 't.to_stop' : 'NULL::text AS to_stop'},
          COALESCE(NULLIF(TRIM(u.full_name), ''), u.email, u.phone_number, ${passengerNameExpr}, 'N/A') AS passenger_name,
          u.email AS passenger_email,
          u.phone_number AS passenger_phone,
          s.schedule_date,
          s.departure_time,
          r.origin AS route_from,
          r.destination AS route_to,
          b.plate_number AS bus_plate_number,
          b.model AS bus_model,
          ${sharedScheduleSelect}
        FROM tickets t
        LEFT JOIN users u ON u.id = t.passenger_id
        LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN buses b ON b.id = s.bus_id
        ${sharedScheduleJoin}
        WHERE ${companyOwnershipFilter}
        ORDER BY t.booked_at DESC
      `,
      {
        replacements: { companyId },
        type: QueryTypes.SELECT,
      }
    );

    console.log(`Found ${ticketRows.length} tickets for company ${companyId}`);

    const mapped = ticketRows.map((t) => ({
      id: t.id,
      bookingRef: t.booking_ref,
      booking_ref: t.booking_ref,
      price: parseFloat(t.price || 0),
      paymentStatus: t.status === 'CONFIRMED' || t.status === 'CHECKED_IN' ? 'paid' : 'unpaid',
      seatNumber: t.seat_number,
      seat_number: t.seat_number,
      qrCode: t.qr_code_url || null,
      status: t.status,
      scanned: !!t.checked_in_at,
      bookedAt: t.booked_at,
      checkedInAt: t.checked_in_at,
      scheduleId: t.schedule_id,
      schedule_id: t.schedule_id,
      // Passenger info
      passengerName: t.passenger_name || 'N/A',
      passenger_name: t.passenger_name || 'N/A',
      passengerEmail: t.passenger_email || 'N/A',
      passengerPhone: t.passenger_phone || 'N/A',
      // Schedule info
      scheduleDate: t.schedule_date || t.bs_date || t.trip_date || null,
      departureTime: t.departure_time || t.bs_time || null,
      created_at: t.booked_at,
      createdAt: t.booked_at,
      // Route info
      routeFrom: t.route_from || t.rr_from_location || t.from_stop || 'N/A',
      from_stop: t.from_stop || t.route_from || t.rr_from_location || null,
      routeTo: t.route_to || t.rr_to_location || t.to_stop || 'N/A',
      to_stop: t.to_stop || t.route_to || t.rr_to_location || null,
      // Bus info
      busPlateNumber: t.bus_plate_number || t.bs_bus_plate_number || 'N/A',
      busModel: t.bus_model || t.bs_bus_model || 'N/A'
    }));

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
    const companyId = await resolveCompanyId(req);
    
    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const { permissions, plan } = await getCompanyPlanContext(companyId);

    const { busId, routeFrom, routeTo, departureTime, arrivalTime, date, driverId } = req.body;

    if (!busId || !routeFrom || !routeTo || !departureTime || !arrivalTime || !date) {
      return res.status(400).json({ error: 'Bus, route, times, and date are required' });
    }

    const routeCount = await Route.count({ where: { company_id: companyId } });
    if (!hasPlanFeature(plan, 'unlimitedRoutes') && permissions.limits.maxRoutes !== null) {
      const routeExists = await Route.findOne({ where: { company_id: companyId, origin: routeFrom, destination: routeTo } });
      if (!routeExists && routeCount >= permissions.limits.maxRoutes) {
        return res.status(403).json({
          error: `The ${plan} plan allows up to ${permissions.limits.maxRoutes} routes`,
          code: 'PLAN_ROUTE_LIMIT_REACHED',
          subscriptionPlan: plan,
          permissions,
        });
      }
    }

    if (!hasPlanFeature(plan, 'advancedSchedules')) {
      const activeScheduleCount = await Schedule.count({
        where: {
          company_id: companyId,
          schedule_date: { [Op.gte]: new Date().toISOString().slice(0, 10) },
          status: { [Op.in]: ['scheduled', 'in_progress'] },
        },
      });

      if (permissions.limits.maxActiveSchedules !== null && activeScheduleCount >= permissions.limits.maxActiveSchedules) {
        return res.status(403).json({
          error: `The ${plan} plan allows up to ${permissions.limits.maxActiveSchedules} active schedules`,
          code: 'PLAN_SCHEDULE_LIMIT_REACHED',
          subscriptionPlan: plan,
          permissions,
        });
      }
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

    // Look up RURA-regulated price (companies cannot set prices manually)
    const { QueryTypes } = require('sequelize');
    const ruaResult = await sequelize.query(
      `SELECT price FROM rura_routes
       WHERE LOWER(from_location) = LOWER(:from) AND LOWER(to_location) = LOWER(:to)
       AND LOWER(status) = 'active'
       ORDER BY effective_date DESC LIMIT 1`,
      { replacements: { from: routeFrom, to: routeTo }, type: QueryTypes.SELECT }
    );
    if (!ruaResult.length) {
      return res.status(400).json({ error: `No active RURA route found for ${routeFrom} → ${routeTo}. Price cannot be set manually.` });
    }
    const ruraPrice = parseFloat(ruaResult[0].price);

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
      price_per_seat: ruraPrice,
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
    const companyId = await resolveCompanyId(req);
    
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
    // price_per_seat is read-only — always sourced from rura_routes, never from request body
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

    const planContext = companyId ? await getCompanyPlanContext(companyId) : null;
    
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
        profitBreakdown: {},
        subscriptionPlan: DEFAULT_PLAN,
        planPermissions: getPlanPermissions(DEFAULT_PLAN),
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
      profitBreakdown,
      subscriptionPlan: planContext?.plan || DEFAULT_PLAN,
      planPermissions: planContext?.permissions || getPlanPermissions(DEFAULT_PLAN),
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
    const { permissions, plan } = await getCompanyPlanContext(companyId);

    if (!hasPlanFeature(plan, 'revenueReports')) {
      return res.status(403).json({
        error: 'Revenue reports are only available on the Enterprise plan',
        code: 'PLAN_FEATURE_BLOCKED',
        feature: 'revenueReports',
        subscriptionPlan: plan,
        permissions,
      });
    }

    const ticketsTable = await sequelize.getQueryInterface().describeTable('tickets');
    const hasTripDateColumn = Boolean(ticketsTable?.trip_date);
    const hasFromStopColumn = Boolean(ticketsTable?.from_stop);
    const hasToStopColumn = Boolean(ticketsTable?.to_stop);

    const busSchedulesCheck = await sequelize.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'bus_schedules'
        ) AS exists
      `,
      { type: QueryTypes.SELECT }
    );
    const hasBusSchedulesTable = Boolean(busSchedulesCheck?.[0]?.exists);
    const busSchedulesTable = hasBusSchedulesTable
      ? await sequelize.getQueryInterface().describeTable('bus_schedules')
      : null;
    const hasBusSchedulesDriverId = Boolean(busSchedulesTable?.driver_id);

    const tripDateExpr = hasTripDateColumn ? 't.trip_date' : 'NULL::date';
    const fromStopExpr = hasFromStopColumn ? 't.from_stop' : 'NULL::text';
    const toStopExpr = hasToStopColumn ? 't.to_stop' : 'NULL::text';
    const sharedDriverNameExpr = hasBusSchedulesTable
      ? (hasBusSchedulesDriverId ? 'COALESCE(sbd.name, bbd.name)' : 'bbd.name')
      : 'NULL::text';
    const driverCoalesceExpr = hasBusSchedulesTable
      ? (hasBusSchedulesDriverId
        ? 'COALESCE(sd.name, bd.name, sbd.name, bbd.name, \'Unassigned\')'
        : 'COALESCE(sd.name, bd.name, bbd.name, \'Unassigned\')')
      : 'COALESCE(sd.name, bd.name, \'Unassigned\')';

    const sharedScheduleSelect = hasBusSchedulesTable
      ? `
          bs.date AS bs_date,
          bs.time AS bs_time,
          bs.capacity AS bs_capacity,
          bs.status AS bs_status,
          rr.from_location AS rr_from_location,
          rr.to_location AS rr_to_location,
          bb.plate_number AS bs_bus_plate,
          ${sharedDriverNameExpr} AS bs_driver_name,
          bs.company_id AS bs_company_id
        `
      : `
          NULL::date AS bs_date,
          NULL::time AS bs_time,
          NULL::integer AS bs_capacity,
          NULL::text AS bs_status,
          NULL::text AS rr_from_location,
          NULL::text AS rr_to_location,
          NULL::text AS bs_bus_plate,
          NULL::text AS bs_driver_name,
          NULL::uuid AS bs_company_id
        `;

    const sharedScheduleJoin = hasBusSchedulesTable
      ? `
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
        LEFT JOIN buses bb ON bb.id = bs.bus_id
        ${hasBusSchedulesDriverId ? 'LEFT JOIN drivers sbd ON sbd.id = bs.driver_id' : ''}
        LEFT JOIN drivers bbd ON bbd.id = bb.driver_id
      `
      : '';

    const ownershipFilter = hasBusSchedulesTable
      ? `(t.company_id = :companyId OR s.company_id = :companyId OR bs.company_id::text = CAST(:companyId AS text))`
      : `(t.company_id = :companyId OR s.company_id = :companyId)`;

    const ticketRows = await sequelize.query(
      `
        SELECT
          t.id,
          t.status,
          t.price,
          t.schedule_id,
          t.booked_at,
          ${tripDateExpr} AS trip_date,
          ${fromStopExpr} AS from_stop,
          ${toStopExpr} AS to_stop,
          COALESCE(s.schedule_date, ${hasBusSchedulesTable ? 'bs.date' : 'NULL::date'}, ${tripDateExpr}, DATE(t.booked_at))::date AS effective_date,
          COALESCE(s.departure_time::text, ${hasBusSchedulesTable ? 'bs.time::text' : 'NULL::text'}) AS departure_time,
          COALESCE(r.origin, ${hasBusSchedulesTable ? 'rr.from_location' : 'NULL::text'}, ${fromStopExpr}, 'N/A') AS route_from,
          COALESCE(r.destination, ${hasBusSchedulesTable ? 'rr.to_location' : 'NULL::text'}, ${toStopExpr}, 'N/A') AS route_to,
          COALESCE(b.plate_number, ${hasBusSchedulesTable ? 'bb.plate_number' : 'NULL::text'}, 'N/A') AS bus_plate,
          ${driverCoalesceExpr} AS driver_name,
          COALESCE(s.total_seats, ${hasBusSchedulesTable ? 'bs.capacity' : 'NULL::integer'}, 0) AS capacity,
          COALESCE(s.status::text, ${hasBusSchedulesTable ? 'bs.status::text' : 'NULL::text'}, 'scheduled') AS schedule_status,
          ${sharedScheduleSelect}
        FROM tickets t
        LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
        LEFT JOIN routes r ON r.id = s.route_id
        LEFT JOIN buses b ON b.id = s.bus_id
        LEFT JOIN drivers sd ON sd.id = s.driver_id
        LEFT JOIN drivers bd ON bd.id = b.driver_id
        ${sharedScheduleJoin}
        WHERE ${ownershipFilter}
          ${startDate ? `AND COALESCE(s.schedule_date, ${hasBusSchedulesTable ? 'bs.date' : 'NULL::date'}, ${tripDateExpr}, DATE(t.booked_at))::date >= :startDate` : ''}
          ${endDate ? `AND COALESCE(s.schedule_date, ${hasBusSchedulesTable ? 'bs.date' : 'NULL::date'}, ${tripDateExpr}, DATE(t.booked_at))::date <= :endDate` : ''}
        ORDER BY COALESCE(s.schedule_date, ${hasBusSchedulesTable ? 'bs.date' : 'NULL::date'}, ${tripDateExpr}, DATE(t.booked_at)) DESC, t.booked_at DESC
      `,
      {
        replacements: { companyId, startDate: startDate || null, endDate: endDate || null },
        type: QueryTypes.SELECT,
      }
    );

    const isCountableTicket = (statusValue) => {
      const status = String(statusValue || '').toUpperCase();
      return status !== 'CANCELLED' && status !== 'EXPIRED';
    };

    const toDateString = (value) => {
      if (!value) return null;
      const text = String(value);
      return text.length >= 10 ? text.slice(0, 10) : null;
    };

    const activeTickets = ticketRows.filter((row) => isCountableTicket(row.status));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const monthAgo = new Date(today);
    monthAgo.setDate(monthAgo.getDate() - 29);
    const monthAgoStr = monthAgo.toISOString().slice(0, 10);

    const totalRevenue = activeTickets.reduce((sum, row) => sum + Number(row.price || 0), 0);
    const totalTickets = activeTickets.length;

    const todayTicketsList = activeTickets.filter((row) => toDateString(row.effective_date) === todayStr);
    const weekTicketsList = activeTickets.filter((row) => {
      const date = toDateString(row.effective_date);
      return date && date >= weekAgoStr;
    });
    const monthTicketsList = activeTickets.filter((row) => {
      const date = toDateString(row.effective_date);
      return date && date >= monthAgoStr;
    });

    const todayRevenue = todayTicketsList.reduce((sum, row) => sum + Number(row.price || 0), 0);
    const weekRevenue = weekTicketsList.reduce((sum, row) => sum + Number(row.price || 0), 0);
    const monthRevenue = monthTicketsList.reduce((sum, row) => sum + Number(row.price || 0), 0);

    const dailyMap = new Map();
    const routeBreakdownMap = new Map();
    const topRoutesMap = new Map();
    const busPerformanceMap = new Map();
    const driverPerformanceMap = new Map();
    const peakHourMap = new Map();
    const peakDayMap = new Map();
    const occupancyMap = new Map();

    activeTickets.forEach((row) => {
      const date = toDateString(row.effective_date) || todayStr;
      const route = `${row.route_from || 'N/A'} → ${row.route_to || 'N/A'}`;
      const departureTime = row.departure_time ? String(row.departure_time).slice(0, 5) : '—';
      const revenue = Number(row.price || 0);
      const scheduleId = String(row.schedule_id || 'unknown');
      const busPlate = row.bus_plate || 'N/A';
      const driverName = row.driver_name || 'Unassigned';
      const capacity = Number(row.capacity || 0);

      if (!dailyMap.has(date)) dailyMap.set(date, { date, revenue: 0, tickets: 0 });
      const daily = dailyMap.get(date);
      daily.revenue += revenue;
      daily.tickets += 1;

      const breakdownKey = `${route}_${date}_${departureTime}`;
      if (!routeBreakdownMap.has(breakdownKey)) {
        routeBreakdownMap.set(breakdownKey, {
          route,
          scheduleDate: date,
          departureTime,
          ticketsSold: 0,
          revenue: 0,
        });
      }
      const breakdown = routeBreakdownMap.get(breakdownKey);
      breakdown.ticketsSold += 1;
      breakdown.revenue += revenue;

      if (!topRoutesMap.has(route)) {
        topRoutesMap.set(route, { route, ticketsSold: 0, revenue: 0 });
      }
      const topRoute = topRoutesMap.get(route);
      topRoute.ticketsSold += 1;
      topRoute.revenue += revenue;

      if (!busPerformanceMap.has(busPlate)) {
        busPerformanceMap.set(busPlate, {
          busPlate,
          totalTripsSet: new Set(),
          passengersCarried: 0,
          revenueGenerated: 0,
        });
      }
      const busPerf = busPerformanceMap.get(busPlate);
      busPerf.totalTripsSet.add(scheduleId);
      busPerf.passengersCarried += 1;
      busPerf.revenueGenerated += revenue;

      if (!driverPerformanceMap.has(driverName)) {
        driverPerformanceMap.set(driverName, {
          driverName,
          completedTripsSet: new Set(),
          passengersHandled: 0,
        });
      }
      const driverPerf = driverPerformanceMap.get(driverName);
      if (String(row.schedule_status || '').toLowerCase() === 'completed') {
        driverPerf.completedTripsSet.add(scheduleId);
      }
      driverPerf.passengersHandled += 1;

      const hour = departureTime !== '—' ? departureTime.slice(0, 2) : String(new Date(row.booked_at).getHours()).padStart(2, '0');
      peakHourMap.set(hour, (peakHourMap.get(hour) || 0) + 1);

      const dayName = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
      peakDayMap.set(dayName, (peakDayMap.get(dayName) || 0) + 1);

      if (!occupancyMap.has(scheduleId)) {
        occupancyMap.set(scheduleId, { capacity: Math.max(capacity, 0), sold: 0 });
      }
      const occupancy = occupancyMap.get(scheduleId);
      occupancy.sold += 1;
      if (capacity > occupancy.capacity) occupancy.capacity = capacity;
    });

    const totalCapacity = Array.from(occupancyMap.values()).reduce((sum, entry) => sum + Number(entry.capacity || 0), 0);
    const totalSoldForOccupancy = Array.from(occupancyMap.values()).reduce((sum, entry) => sum + Number(entry.sold || 0), 0);
    const occupancyRate = totalCapacity > 0 ? (totalSoldForOccupancy / totalCapacity) * 100 : 0;

    const averageTicketPrice = totalTickets > 0 ? totalRevenue / totalTickets : 0;

    const previousPeriodMetrics = (() => {
      const dateBuckets = activeTickets.map((row) => toDateString(row.effective_date)).filter(Boolean);
      if (!dateBuckets.length) return { revenuePct: null, ticketsPct: null };

      const toDate = (value) => new Date(`${value}T00:00:00`);
      const selectedStart = startDate ? toDate(startDate) : new Date(`${weekAgoStr}T00:00:00`);
      const selectedEnd = endDate ? toDate(endDate) : new Date(`${todayStr}T00:00:00`);
      const periodDays = Math.max(1, Math.floor((selectedEnd.getTime() - selectedStart.getTime()) / (24 * 3600 * 1000)) + 1);
      const prevEnd = new Date(selectedStart);
      prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setDate(prevStart.getDate() - (periodDays - 1));

      const currentStartStr = selectedStart.toISOString().slice(0, 10);
      const currentEndStr = selectedEnd.toISOString().slice(0, 10);
      const prevStartStr = prevStart.toISOString().slice(0, 10);
      const prevEndStr = prevEnd.toISOString().slice(0, 10);

      const inRange = (date, start, end) => date && date >= start && date <= end;

      const currentRows = activeTickets.filter((row) => inRange(toDateString(row.effective_date), currentStartStr, currentEndStr));
      const previousRows = activeTickets.filter((row) => inRange(toDateString(row.effective_date), prevStartStr, prevEndStr));

      const currentRevenue = currentRows.reduce((sum, row) => sum + Number(row.price || 0), 0);
      const previousRevenue = previousRows.reduce((sum, row) => sum + Number(row.price || 0), 0);
      const currentTickets = currentRows.length;
      const previousTickets = previousRows.length;

      const pct = (current, previous) => {
        if (!previous) return null;
        return ((current - previous) / previous) * 100;
      };

      return {
        revenuePct: pct(currentRevenue, previousRevenue),
        ticketsPct: pct(currentTickets, previousTickets),
      };
    })();

    const dailyRevenue = Array.from(dailyMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    const breakdownByRoute = Array.from(routeBreakdownMap.values())
      .sort((a, b) => b.revenue - a.revenue);

    const topRoutes = Array.from(topRoutesMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const busPerformance = Array.from(busPerformanceMap.values())
      .map((item) => ({
        busPlate: item.busPlate,
        totalTrips: item.totalTripsSet.size,
        passengersCarried: item.passengersCarried,
        revenueGenerated: Math.round(item.revenueGenerated),
      }))
      .sort((a, b) => b.revenueGenerated - a.revenueGenerated);

    const driverPerformance = Array.from(driverPerformanceMap.values())
      .map((item) => ({
        driverName: item.driverName,
        tripsCompleted: item.completedTripsSet.size,
        passengersHandled: item.passengersHandled,
      }))
      .sort((a, b) => b.passengersHandled - a.passengersHandled);

    const peakTimes = {
      hours: Array.from(peakHourMap.entries())
        .map(([hour, tickets]) => ({ hour: `${hour}:00`, tickets }))
        .sort((a, b) => b.tickets - a.tickets),
      days: Array.from(peakDayMap.entries())
        .map(([day, tickets]) => ({ day, tickets }))
        .sort((a, b) => b.tickets - a.tickets),
    };

    res.json({
      totalRevenue: Math.round(totalRevenue),
      totalTickets,
      todayRevenue: Math.round(todayRevenue),
      todayTickets: todayTicketsList.length,
      weekRevenue: Math.round(weekRevenue),
      weekTickets: weekTicketsList.length,
      monthRevenue: Math.round(monthRevenue),
      monthTickets: monthTicketsList.length,
      averageTicketPrice: Math.round(averageTicketPrice),
      occupancyRate: Number(occupancyRate.toFixed(2)),
      previousPeriodChange: {
        revenuePct: previousPeriodMetrics.revenuePct,
        ticketsPct: previousPeriodMetrics.ticketsPct,
      },
      dailyRevenue,
      breakdownByRoute,
      topRoutes,
      busPerformance,
      driverPerformance,
      peakTimes,
      selectedRange: {
        startDate: startDate || null,
        endDate: endDate || null,
      },
      subscriptionPlan: plan,
      planPermissions: permissions,
    });

  } catch (error) {
    console.error('getRevenue error:', error);
    res.status(400).json({ error: error.message });
  }
};

// ─── PUT /api/company/settings ────────────────────────────────────────────────
const updateCompany = async (req, res) => {
  try {
    const companyId = req.companyId || (await User.findByPk(req.userId))?.company_id;
    if (!companyId) return res.status(404).json({ error: 'Company not found' });

    const company = await Company.findByPk(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { name, email, phone, address } = req.body;

    if (name && name.trim()) company.name = name.trim();
    if (typeof email !== 'undefined') company.email = email || null;
    if (typeof phone !== 'undefined') company.phone = phone || null;
    if (typeof address !== 'undefined') company.address = address || null;

    await company.save();

    res.json({
      message: 'Company settings updated',
      company: {
        id: company.id,
        name: company.name,
        email: company.email || null,
        phone: company.phone || null,
        address: company.address || null,
        status: company.status,
        subscriptionStatus: company.subscription_status || 'inactive',
        plan: normalizePlan(company.plan || company.subscription_plan) || DEFAULT_PLAN,
        nextPayment: company.next_payment || null,
        planPermissions: getPlanPermissions(company.plan || company.subscription_plan || DEFAULT_PLAN),
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  getCompany,
  getSubscriptionRequest,
  createSubscriptionRequest,
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
  getRevenue,
  updateCompany
};


