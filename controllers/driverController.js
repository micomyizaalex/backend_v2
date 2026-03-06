// Consolidated driver controller: exposes driver user endpoints, legacy driver endpoints, and location/ticket flows
const { User, Driver, Bus, Schedule, DriverLocation, Location } = require('../models');
const { Op } = require('sequelize');
const pool = require('../config/pgPool');

function mapTicketRow(row) {
	return {
		id: row.id,
		qrCode: row.id,
		bookingRef: row.booking_ref,
		status: row.status,
		checkedInAt: row.checked_in_at,
		price: row.price ? parseFloat(row.price) : null,
		seatNumber: row.seat_number,
		commuter: {
			id: row.passenger_id,
			name: row.passenger_name,
			email: row.passenger_email,
			phone: row.passenger_phone,
		},
		schedule: {
			id: row.schedule_id,
			routeFrom: row.route_from,
			routeTo: row.route_to,
			departureTime: row.departure_time,
			arrivalTime: row.arrival_time,
			date: row.schedule_date,
			busPlate: row.bus_plate,
		},
		bus: {
			id: row.bus_id,
			plateNumber: row.bus_plate,
		},
		companyId: row.company_id,
		isUsed: row.status === 'CHECKED_IN',
	};
}

// Basic driver endpoints (use canonical User as driver)
const getMe = async (req, res) => {
	try {
		const user = await User.findByPk(req.userId, { attributes: ['id','full_name','email','role','company_id','phone_number'] });
		if (!user) return res.status(404).json({ error: 'User not found' });
		res.json({ user });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

const getAssignedBus = async (req, res) => {
	try {
		const user = await User.findByPk(req.userId);
		const bus = await Bus.findOne({ where: { driver_id: req.userId, company_id: user.company_id } });
		if (!bus) return res.json({ bus: null });
		res.json({ bus: { id: bus.id, plate_number: bus.plate_number, model: bus.model, capacity: bus.capacity, status: bus.status } });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

const getTodaySchedule = async (req, res) => {
	try {
		const user = await User.findByPk(req.userId);
		if (!user) return res.status(404).json({ error: 'User not found' });
		const companyId = user.company_id;

		// Determine possible driver ids in assignments: canonical user id and legacy driver id (if linked)
		const legacyDriver = await Driver.findOne({ where: { user_id: req.userId } });
		const driverIdCandidates = [req.userId];
		if (legacyDriver && legacyDriver.id) driverIdCandidates.push(legacyDriver.id);

		// Find active assignments for this driver within the company
		const assignments = await require('../models').DriverAssignment.findAll({
			where: {
				driver_id: { [Op.in]: driverIdCandidates },
				unassigned_at: null,
				company_id: companyId
			},
			attributes: ['bus_id']
		});

		const busIds = assignments.map(a => a.bus_id).filter(Boolean);
		if (!busIds || busIds.length === 0) return res.json({ schedules: [] });

		// Build date window for today
		const today = new Date();
		today.setHours(0,0,0,0);
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate()+1);

		// Fetch schedules for assigned buses (today) with related bus and route info
		const schedules = await Schedule.findAll({
			where: {
				bus_id: { [Op.in]: busIds },
				company_id: companyId,
				schedule_date: { [Op.gte]: today, [Op.lt]: tomorrow },
				status: { [Op.in]: ['scheduled', 'in_progress'] }
			},
			include: [
				{ model: Bus, attributes: ['id','plate_number','model','capacity'] },
				{ model: require('../models').Route, attributes: ['id','origin','destination'] }
			],
			order: [['departure_time','ASC']],
		});

		// Map to clean JSON structure
		const mapped = schedules.map(s => ({
			id: s.id,
			bus: s.Bus ? { id: s.Bus.id, plateNumber: s.Bus.plate_number, model: s.Bus.model, capacity: s.Bus.capacity } : null,
			routeFrom: s.Route ? s.Route.origin : null,
			routeTo: s.Route ? s.Route.destination : null,
			departureTime: s.departure_time,
			arrivalTime: s.arrival_time,
			date: s.schedule_date,
			seatsAvailable: s.available_seats,
			totalSeats: s.Bus ? s.Bus.capacity : null,
			price: s.price_per_seat,
			status: s.status
		}));

		// Ensure uniqueness (just in case) by schedule id
		const unique = [];
		const seen = new Set();
		for (const it of mapped) {
			if (!seen.has(String(it.id))) { seen.add(String(it.id)); unique.push(it); }
		}

		res.json({ schedules: unique });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

// Return all schedules for buses currently assigned to the logged-in driver
const getMyTrips = async (req, res) => {
	try {
		const user = await User.findByPk(req.userId);
		if (!user) return res.status(404).json({ error: 'User not found' });
		const companyId = user.company_id;

		const legacyDriver = await Driver.findOne({ where: { user_id: req.userId } });
		const driverIdCandidates = [req.userId];
		if (legacyDriver && legacyDriver.id) driverIdCandidates.push(legacyDriver.id);

		const assignments = await require('../models').DriverAssignment.findAll({
			where: {
				driver_id: { [Op.in]: driverIdCandidates },
				unassigned_at: null,
				company_id: companyId
			},
			attributes: ['bus_id']
		});

		const busIds = assignments.map(a => a.bus_id).filter(Boolean);
		if (!busIds || busIds.length === 0) return res.json({ trips: [] });

		const schedules = await Schedule.findAll({
			where: {
				bus_id: { [Op.in]: busIds },
				company_id: companyId,
			},
			include: [
				{ model: Bus, attributes: ['id','plate_number','model','capacity'] },
				{ model: require('../models').Route, attributes: ['id','origin','destination'] }
			],
			order: [['schedule_date','ASC'], ['departure_time','ASC']],
		});

		const mapped = schedules.map(s => ({
			id: s.id,
			bus: s.Bus ? { id: s.Bus.id, plateNumber: s.Bus.plate_number, model: s.Bus.model, capacity: s.Bus.capacity } : null,
			routeFrom: s.Route ? s.Route.origin : null,
			routeTo: s.Route ? s.Route.destination : null,
			departureTime: s.departure_time,
			arrivalTime: s.arrival_time,
			date: s.schedule_date,
			seatsAvailable: s.available_seats,
			totalSeats: s.Bus ? s.Bus.capacity : null,
			price: s.price_per_seat,
			status: s.status
		}));

		res.json({ trips: mapped });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

// Aggregated dashboard data for driver: today's stats, upcoming trips, recent check-ins
const getDashboard = async (req, res) => {
	let client;
	try {
		client = await pool.connect();

		// Get driver profile (legacy drivers table)
		const driverQuery = await client.query(
			'SELECT id, company_id FROM drivers WHERE user_id = $1',
			[req.userId]
		);

		let companyId;
		const driverIdCandidates = [req.userId];

		if (driverQuery.rowCount > 0) {
			const driver = driverQuery.rows[0];
			companyId = driver.company_id;
			if (driver.id) driverIdCandidates.push(driver.id);
		} else {
			// Fallback to users table when no legacy driver row exists
			const userQuery = await client.query(
				'SELECT company_id FROM users WHERE id = $1',
				[req.userId]
			);
			if (userQuery.rowCount === 0) {
				return res.json({ stats: { completed: 0, active: 0, passengers: 0, revenue: 0 }, upcoming: [], recentCheckins: [] });
			}
			companyId = userQuery.rows[0].company_id;
		}
		const assignmentsQuery = await client.query(
			`SELECT DISTINCT bus_id 
			 FROM driver_assignments 
			 WHERE driver_id = ANY($1::uuid[]) AND unassigned_at IS NULL AND company_id = $2`,
			[driverIdCandidates, companyId]
		);

		let busIds = assignmentsQuery.rows.map(r => r.bus_id).filter(Boolean);
		if (!busIds || busIds.length === 0) {
			// Backward-compatible fallback: some deployments still rely on buses.driver_id
			const busesFallback = await client.query(
				`SELECT id
				 FROM buses
				 WHERE company_id = $1 AND driver_id = ANY($2::uuid[])`,
				[companyId, driverIdCandidates]
			);
			busIds = busesFallback.rows.map(r => r.id).filter(Boolean);
		}
		if (!busIds || busIds.length === 0) {
			return res.json({ stats: { completed: 0, active: 0, passengers: 0, revenue: 0 }, upcoming: [], recentCheckins: [] });
		}

		// Date window for today
		const today = new Date();
		today.setHours(0,0,0,0);
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate()+1);

		// Stats: completed and active schedules for today
		const statsQ = await client.query(
			`SELECT
				 SUM(CASE WHEN LOWER(COALESCE(s.status, '')) = 'completed' THEN 1 ELSE 0 END) AS completed,
				 SUM(CASE WHEN LOWER(COALESCE(s.status, '')) IN ('in_progress', 'active') THEN 1 ELSE 0 END) AS active
			 FROM schedules s
			 WHERE s.bus_id = ANY($1::uuid[]) AND s.company_id = $2 
			   AND s.schedule_date >= $3 AND s.schedule_date < $4`,
			[busIds, companyId, today, tomorrow]
		);

		const statsRow = statsQ.rows[0] || { completed: 0, active: 0 };

		// Tickets: passengers sold and revenue for today
		const ticketsQ = await client.query(
			`SELECT COUNT(*) AS passengers, 
			        COALESCE(SUM(CASE WHEN t.price IS NOT NULL THEN t.price ELSE 0 END), 0) AS revenue
			 FROM tickets t
			 INNER JOIN schedules s ON t.schedule_id = s.id
			 WHERE s.bus_id = ANY($1::uuid[]) AND s.company_id = $2 
			   AND s.schedule_date >= $3 AND s.schedule_date < $4
			   AND t.status IN ('CONFIRMED', 'CHECKED_IN')`,
			[busIds, companyId, today, tomorrow]
		);

		const ticketsRow = ticketsQ.rows[0] || { passengers: 0, revenue: 0 };

		// Upcoming trips (next 5 schedules from now)
		const upcomingQ = await client.query(
			`SELECT s.id, s.departure_time, s.arrival_time, s.schedule_date, 
			        s.available_seats, s.price_per_seat, s.status,
			        b.id AS bus_id, b.plate_number AS bus_plate, b.capacity AS bus_capacity,
			        r.origin AS route_from, r.destination AS route_to
			 FROM schedules s
			 LEFT JOIN buses b ON s.bus_id = b.id
			 LEFT JOIN routes r ON s.route_id = r.id
			 WHERE s.bus_id = ANY($1::uuid[]) AND s.company_id = $2 
			   AND LOWER(COALESCE(s.status, '')) IN ('scheduled', 'in_progress', 'active')
			 ORDER BY s.schedule_date ASC, s.departure_time ASC
			 LIMIT 5`,
			[busIds, companyId]
		);

		const upcoming = upcomingQ.rows.map(r => ({
			id: r.id,
			routeFrom: r.route_from,
			routeTo: r.route_to,
			departureTime: r.departure_time,
			arrivalTime: r.arrival_time,
			date: r.schedule_date,
			seatsAvailable: r.available_seats,
			totalSeats: r.bus_capacity,
			price: r.price_per_seat,
			status: r.status,
			bus: { id: r.bus_id, plateNumber: r.bus_plate, capacity: r.bus_capacity }
		}));

		// Recent check-ins (last 10) for assigned buses - ALL checked in tickets
		const recentQ = await client.query(
			`SELECT t.id, t.seat_number, t.checked_in_at, 
			        u.full_name AS passenger_name, 
			        s.id AS schedule_id, 
			        b.plate_number AS bus_plate
			 FROM tickets t
			 INNER JOIN users u ON t.passenger_id = u.id
			 INNER JOIN schedules s ON t.schedule_id = s.id
			 LEFT JOIN buses b ON s.bus_id = b.id
			 WHERE s.bus_id = ANY($1::uuid[]) AND s.company_id = $2 
			   AND t.status = 'CHECKED_IN'
			 ORDER BY t.checked_in_at DESC
			 LIMIT 10`,
			[busIds, companyId]
		);

		const recent = recentQ.rows.map(r => ({ 
			id: r.id, 
			name: r.passenger_name, 
			seat: r.seat_number, 
			checked: true,
			checkedAt: r.checked_in_at, 
			busPlate: r.bus_plate,
			time: new Date(r.checked_in_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
		}));

		const stats = {
			completed: parseInt(statsRow.completed || 0, 10),
			active: parseInt(statsRow.active || 0, 10),
			passengers: parseInt(ticketsRow.passengers || 0, 10),
			revenue: parseFloat(ticketsRow.revenue || 0)
		};

		res.json({ stats, upcoming, recentCheckins: recent });
	} catch (err) {
		console.error('Dashboard error:', err);
		res.status(500).json({ error: 'Failed to load dashboard', message: err.message });
	} finally {
		if (client) client.release();
	}
};

const startTrip = async (req, res) => {
	try {
		const { scheduleId } = req.body;
		
		if (!scheduleId) {
			return res.status(400).json({ error: 'scheduleId is required' });
		}
		
		const user = await User.findByPk(req.userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}
		
		const schedule = await Schedule.findByPk(scheduleId);
		
		if (!schedule) {
			return res.status(404).json({ error: 'Schedule not found' });
		}
		
		// Security: Verify driver belongs to same company
		if (schedule.company_id !== user.company_id) {
			return res.status(403).json({ error: 'Unauthorized: Schedule belongs to different company' });
		}
		
		// Verify driver is assigned to the bus for this schedule (via DriverAssignment)
		const legacyDriver = await Driver.findOne({ where: { user_id: req.userId } });
		const driverIdCandidates = [req.userId];
		if (legacyDriver && legacyDriver.id) driverIdCandidates.push(legacyDriver.id);
		
		const assignment = await require('../models').DriverAssignment.findOne({
			where: {
				driver_id: { [Op.in]: driverIdCandidates },
				bus_id: schedule.bus_id,
				unassigned_at: null,
				company_id: user.company_id
			}
		});
		
		if (!assignment) {
			return res.status(403).json({ error: 'Unauthorized: You are not assigned to the bus for this schedule' });
		}
		
		// Verify schedule hasn't already started or completed
		if (schedule.status === 'in_progress') {
			return res.status(400).json({ error: 'Trip already started', schedule });
		}
		
		if (schedule.status === 'completed') {
			return res.status(400).json({ error: 'Trip already completed', schedule });
		}
		
		// Update schedule to active status with start time
		const now = new Date();
		const client = await pool.connect();
		
		try {
			await client.query(
				`UPDATE schedules 
				 SET status = 'in_progress', 
				     trip_start_time = $1,
				     updated_at = $1
				 WHERE id = $2`,
				[now, scheduleId]
			);
			
			// Refresh schedule object
			await schedule.reload();
			
			console.log(`🚌 Trip started: Schedule ${scheduleId} by driver ${req.userId} at ${now.toISOString()}`);
			
			res.json({ 
				success: true,
				message: 'Trip started successfully', 
				schedule: {
					id: schedule.id,
					status: schedule.status,
					tripStartTime: now.toISOString(),
					routeId: schedule.route_id
				}
			});
		} finally {
			client.release();
		}
	} catch (err) {
		console.error('Error in startTrip:', err);
		res.status(500).json({ error: 'Failed to start trip', message: err.message });
	}
};

const endTrip = async (req, res) => {
	try {
		const { scheduleId } = req.body;
		
		if (!scheduleId) {
			return res.status(400).json({ error: 'scheduleId is required' });
		}
		
		const user = await User.findByPk(req.userId);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}
		
		const schedule = await Schedule.findByPk(scheduleId);
		
		if (!schedule) {
			return res.status(404).json({ error: 'Schedule not found' });
		}
		
		// Security: Verify driver belongs to same company
		if (schedule.company_id !== user.company_id) {
			return res.status(403).json({ error: 'Unauthorized: Schedule belongs to different company' });
		}
		
		// Verify driver is assigned to the bus for this schedule (via DriverAssignment)
		const legacyDriver = await Driver.findOne({ where: { user_id: req.userId } });
		const driverIdCandidates = [req.userId];
		if (legacyDriver && legacyDriver.id) driverIdCandidates.push(legacyDriver.id);
		
		const assignment = await require('../models').DriverAssignment.findOne({
			where: {
				driver_id: { [Op.in]: driverIdCandidates },
				bus_id: schedule.bus_id,
				unassigned_at: null,
				company_id: user.company_id
			}
		});
		
		if (!assignment) {
			return res.status(403).json({ error: 'Unauthorized: You are not assigned to the bus for this schedule' });
		}
		
		// Verify trip is actually in progress
		if (schedule.status !== 'in_progress') {
			return res.status(400).json({ 
				error: 'Trip is not in progress', 
				currentStatus: schedule.status 
			});
		}
		
		// Update schedule to completed with end time
		const now = new Date();
		const client = await pool.connect();
		
		try {
			await client.query(
				`UPDATE schedules 
				 SET status = 'completed', 
				     trip_end_time = $1,
				     updated_at = $1
				 WHERE id = $2`,
				[now, scheduleId]
			);
			
			// Refresh schedule object
			await schedule.reload();
			
			console.log(`✅ Trip ended: Schedule ${scheduleId} by driver ${req.userId} at ${now.toISOString()}`);
			
			res.json({ 
				success: true,
				message: 'Trip ended successfully', 
				schedule: {
					id: schedule.id,
					status: schedule.status,
					tripEndTime: now.toISOString(),
					routeId: schedule.route_id
				}
			});
		} finally {
			client.release();
		}
	} catch (err) {
		console.error('Error in endTrip:', err);
		res.status(500).json({ error: 'Failed to end trip', message: err.message });
	}
};

const postLocation = async (req, res) => {
	try {
		const { latitude, longitude } = req.body;
		if (typeof latitude !== 'number' || typeof longitude !== 'number') {
			return res.status(400).json({ error: 'Invalid coordinates' });
		}

		// Upsert latest location for driver
		let loc = await DriverLocation.findOne({ where: { driver_id: req.userId } });
		if (loc) {
			loc.latitude = latitude;
			loc.longitude = longitude;
			loc.updated_at = new Date();
			await loc.save();
		} else {
			loc = await DriverLocation.create({ driver_id: req.userId, latitude, longitude });
		}

		res.json({ message: 'Location saved', location: loc });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

// Legacy driver endpoints (use Driver table and raw SQL where necessary)
const getDriverContext = async (req, res) => {
	try {
		const driver = await Driver.findOne({ where: { user_id: req.userId } });

		if (!driver) {
			console.warn('getDriverContext: no legacy driver linked to user', { userId: req.userId });
			// Return empty structure to frontend instead of 404 so UI can gracefully handle canonical-only drivers
			return res.json({ driver: null, buses: [] });
		}

		const client = await pool.connect();
		try {
			const { rows } = await client.query(
				`SELECT 
					 b.id,
					 b.plate_number,
					 b.company_id,
					 s.id AS schedule_id,
					 s.departure_time,
					 s.schedule_date,
					 r.origin AS route_from,
					 r.destination AS route_to
				 FROM buses b
				 LEFT JOIN schedules s 
					 ON s.bus_id = b.id 
					AND s.status IN ('scheduled', 'in_progress')
				 LEFT JOIN routes r ON r.id = s.route_id
				 WHERE b.driver_id = $1
				 ORDER BY s.departure_time ASC NULLS LAST`,
				[req.userId]
			);

			const buses = rows.map((row) => ({
				id: row.id,
				plateNumber: row.plate_number,
				companyId: row.company_id,
				scheduleId: row.schedule_id,
				routeFrom: row.route_from,
				routeTo: row.route_to,
				departureTime: row.departure_time,
				scheduleDate: row.schedule_date,
			}));

			return res.json({
				driver: {
					id: driver.id,
					name: driver.name,
					companyId: driver.company_id,
				},
				buses,
			});
		} finally {
			client.release();
		}
	} catch (error) {
		return res.status(500).json({ error: 'Failed to load driver data', message: error.message });
	}
};

const scanTicket = async (req, res) => {
	let client;

	try {
		const { qrCode, ticketId } = req.body || {};
		const rawScanValue = (typeof qrCode === 'string' && qrCode.trim()) || (typeof ticketId === 'string' && ticketId.trim()) || '';

		if (!rawScanValue) {
			return res.status(400).json({ error: 'QR code is required', valid: false, message: 'QR code missing' });
		}

		let ticketIdentifier = rawScanValue;
		try {
			const parsed = JSON.parse(rawScanValue);
			if (parsed && typeof parsed === 'object' && typeof parsed.ticketId === 'string' && parsed.ticketId.trim()) {
				ticketIdentifier = parsed.ticketId.trim();
			}
		} catch (parseErr) {
			// Keep raw QR text as identifier when payload is not JSON.
		}

		client = await pool.connect();

		// Query legacy driver profile; fall back to canonical users table.
		const driverQuery = await client.query(
			'SELECT id, user_id, company_id, name FROM drivers WHERE user_id = $1',
			[req.userId]
		);

		let driver;
		if (driverQuery.rowCount > 0) {
			driver = driverQuery.rows[0];
		} else {
			const userQuery = await client.query(
				'SELECT id, role, company_id, full_name FROM users WHERE id = $1',
				[req.userId]
			);
			if (userQuery.rowCount === 0) {
				return res.status(403).json({ error: 'Driver profile not found', valid: false, message: 'Driver profile missing' });
			}
			const userRow = userQuery.rows[0];
			if (String(userRow.role || '').toLowerCase() !== 'driver') {
				return res.status(403).json({ error: 'Driver role required', valid: false, message: 'Driver role required' });
			}
			driver = {
				id: null,
				user_id: userRow.id,
				company_id: userRow.company_id,
				name: userRow.full_name || 'Driver',
			};
		}

		await client.query('BEGIN');

		// Try to match by UUID id or by booking reference.
		// Tickets may reference either the legacy `schedules` table or the shared-route
		// `bus_schedules` table, so we LEFT JOIN both and COALESCE the columns we need.
		const ticketResult = await client.query(
			`SELECT 
				 t.id,
				 t.seat_number,
				 t.booking_ref,
				 t.price,
				 t.status,
				 t.booked_at,
				 t.checked_in_at,
				 t.company_id,
				 t.schedule_id,
				 u.id AS passenger_id,
				 u.full_name AS passenger_name,
				 u.email AS passenger_email,
				 u.phone_number AS passenger_phone,
				 COALESCE(s1.departure_time, s2.time) AS departure_time,
				 s1.arrival_time,
				 COALESCE(s1.schedule_date, s2.date::date) AS schedule_date,
				 COALESCE(s1.bus_id, s2.bus_id) AS bus_id,
				 COALESCE(s1.status, s2.status) AS trip_status,
				 COALESCE(r1.origin, rr.from_location) AS route_from,
				 COALESCE(r1.destination, rr.to_location) AS route_to,
				 b.plate_number AS bus_plate
			 FROM tickets t
			 INNER JOIN users u ON t.passenger_id = u.id
			 LEFT JOIN schedules s1 ON s1.id = t.schedule_id
			 LEFT JOIN routes r1 ON r1.id = s1.route_id
			 LEFT JOIN bus_schedules s2 ON s2.schedule_id::text = t.schedule_id::text
			 LEFT JOIN rura_routes rr ON rr.id::text = s2.route_id::text
			 LEFT JOIN buses b ON b.id = COALESCE(s1.bus_id, s2.bus_id)
			 WHERE t.id::text = $1 OR t.booking_ref = $1
			 FOR UPDATE OF t`,
			[ticketIdentifier]
		);

		if (ticketResult.rowCount === 0) {
			await client.query('ROLLBACK');
			return res.status(404).json({ error: 'Ticket not found', valid: false, message: 'Invalid ticket ❌' });
		}

		const ticketRow = ticketResult.rows[0];

		// Validate company match
		if (ticketRow.company_id && ticketRow.company_id !== driver.company_id) {
			await client.query('ROLLBACK');
			return res.status(403).json({ error: 'Ticket not in your company', valid: false, message: 'Not for this company ❌' });
		}

		// Validate trip is active or scheduled.
		// bus_schedules-based trips remain 'scheduled' until departure (no explicit start-trip flow),
		// so we allow 'scheduled' in addition to the legacy 'in_progress'/'ACTIVE' states.
		const allowedStatuses = ['in_progress', 'active', 'scheduled'];
		if (!allowedStatuses.includes(String(ticketRow.trip_status || '').toLowerCase())) {
			await client.query('ROLLBACK');
			return res.status(400).json({ 
				valid: false, 
				message: 'Trip not active ❌', 
				ticket: mapTicketRow(ticketRow),
				reason: 'TRIP_NOT_ACTIVE'
			});
		}

		// Check if ticket is cancelled or expired
		if (ticketRow.status === 'CANCELLED' || ticketRow.status === 'EXPIRED') {
			await client.query('ROLLBACK');
			return res.status(400).json({ 
				valid: false, 
				message: 'Ticket cancelled ❌', 
				ticket: mapTicketRow(ticketRow),
				reason: 'TICKET_CANCELLED'
			});
		}

		// Check if already checked in
		if (ticketRow.status === 'CHECKED_IN') {
			await client.query('COMMIT');
			const alreadyScannedTicket = mapTicketRow(ticketRow);
			return res.status(200).json({ 
				valid: false, 
				message: 'Already scanned ⚠️', 
				ticket: alreadyScannedTicket,
				reason: 'ALREADY_USED'
			});
		}

		// Update ticket to CHECKED_IN
		const updateResult = await client.query(
			'UPDATE tickets SET status = $1, checked_in_at = NOW() WHERE id = $2 AND status = $3 RETURNING checked_in_at',
			['CHECKED_IN', ticketRow.id, 'CONFIRMED']
		);

		if (updateResult.rowCount === 0) {
			await client.query('ROLLBACK');
			return res.status(409).json({ 
				valid: false, 
				message: 'Ticket already used', 
				ticket: mapTicketRow(ticketRow),
				reason: 'ALREADY_USED'
			});
		}

		const checkedInAt = updateResult.rows[0].checked_in_at;

		// Create audit log entry only when a legacy driver id exists.
		if (driver.id) {
			await client.query(
				`INSERT INTO ticket_scan_logs (ticket_id, driver_id, schedule_id, passenger_id, scanned_at, scan_status)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[ticketRow.id, driver.id, ticketRow.schedule_id, ticketRow.passenger_id, checkedInAt, 'SUCCESS']
			);
		}

		await client.query('COMMIT');

		const scannedTicket = mapTicketRow({ 
			...ticketRow, 
			status: 'CHECKED_IN', 
			checked_in_at: checkedInAt 
		});

		// Broadcast real-time updates via Socket.IO
		const io = req.app.get('io');
		if (io) {
			// Notify admin dashboard (company room)
			io.to(`company:${driver.company_id}`).emit('ticket:scanned', {
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				busId: ticketRow.bus_id,
				passengerName: ticketRow.passenger_name,
				seatNumber: ticketRow.seat_number,
				driverName: driver.name,
				scannedAt: checkedInAt,
				busPlate: ticketRow.bus_plate,
			});

			// Notify commuter (passenger)
			io.to(`user:${ticketRow.passenger_id}`).emit('ticket:statusUpdate', {
				ticketId: ticketRow.id,
				status: 'CHECKED_IN',
				scannedAt: checkedInAt,
				driverName: driver.name,
				busPlate: ticketRow.bus_plate,
				message: '✅ You have been checked in!'
			});

			// Notify schedule room (for trip tracking)
			io.to(`schedule:${ticketRow.schedule_id}`).emit('passenger:checkedIn', {
				ticketId: ticketRow.id,
				passengerName: ticketRow.passenger_name,
				seatNumber: ticketRow.seat_number,
				scannedAt: checkedInAt,
			});
		}

		return res.json({ 
			valid: true, 
			message: `✅ ${ticketRow.passenger_name} checked in`, 
			ticket: scannedTicket,
			passenger: {
				name: ticketRow.passenger_name,
				seat: ticketRow.seat_number,
				phone: ticketRow.passenger_phone,
			}
		});
	} catch (error) {
		if (client) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				// Ignore rollback errors
			}
		}
		console.error('Scan ticket error:', error);
		return res.status(500).json({ error: 'Failed to scan ticket', valid: false, message: error.message });
	} finally {
		if (client) {
			client.release();
		}
	}
};

const shareLocation = async (req, res) => {
	try {
		const { busId, lat, lng, speed, heading, accuracy } = req.body || {};

		if (!busId || lat === undefined || lng === undefined) {
			return res.status(400).json({ error: 'busId, lat, and lng are required' });
		}

		const latitude = Number(lat);
		const longitude = Number(lng);

		if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
			return res.status(400).json({ error: 'Invalid coordinates' });
		}

		// Query driver profile using PostgreSQL
		const client = await pool.connect();
		try {
			const driverQuery = await client.query(
				'SELECT id, company_id FROM drivers WHERE user_id = $1',
				[req.userId]
			);

			if (driverQuery.rowCount === 0) {
				return res.status(403).json({ error: 'Driver profile not found' });
			}

			const driver = driverQuery.rows[0];

			const bus = await Bus.findByPk(busId);
			if (!bus) {
				return res.status(404).json({ error: 'Bus not found' });
			}

			if (bus.company_id !== driver.company_id || (bus.driver_id && bus.driver_id !== driver.id)) {
				return res.status(403).json({ error: 'You are not assigned to this bus' });
			}
		} finally {
			client.release();
		}

		const schedule = await Schedule.findOne({
			where: {
				bus_id: busId,
				status: { [Op.in]: ['scheduled', 'in_progress'] },
			},
			order: [['departure_time', 'ASC']],
		});

		await Location.create({
			bus_id: busId,
			driver_id: driver.id,
			schedule_id: schedule ? schedule.id : null,
			latitude,
			longitude,
			speed: speed !== undefined ? speed : null,
			heading: heading !== undefined ? heading : null,
			accuracy: accuracy !== undefined ? accuracy : null,
			timestamp: new Date(),
		});

		return res.json({ success: true });
	} catch (error) {
		return res.status(500).json({ error: 'Failed to update location', message: error.message });
	}
};

module.exports = {
	getMe,
	getAssignedBus,
	getTodaySchedule,
	startTrip,
	endTrip,
	postLocation,
	getDriverContext,
	scanTicket,
	shareLocation,
	getMyTrips,
	getDashboard,
};
