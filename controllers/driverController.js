// Consolidated driver controller: exposes driver user endpoints, legacy driver endpoints, and location/ticket flows
const { User, Driver, Bus, Schedule, DriverLocation, Location } = require('../models');
const { Op } = require('sequelize');
const pool = require('../config/pgPool');

const OPERATIONAL_STATUS_VALUES = ['ASSIGNED', 'BOARDING', 'DEPARTED', 'ON_ROUTE', 'ARRIVING', 'COMPLETED'];

let operationalStatusColumnCache = null;
const tableColumnsCache = {};

async function getTableColumns(client, tableName) {
	if (tableColumnsCache[tableName]) {
		return tableColumnsCache[tableName];
	}

	const result = await client.query(
		`SELECT column_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		   AND table_name = $1`,
		[tableName]
	);

	const columns = new Set(result.rows.map((row) => row.column_name));
	tableColumnsCache[tableName] = columns;
	return columns;
}

const buildDriverIdCandidates = async (userId) => {
	const legacyDriver = await Driver.findOne({ where: { user_id: userId }, attributes: ['id'] });
	const candidates = [userId];
	if (legacyDriver?.id) candidates.push(legacyDriver.id);
	return candidates;
};

const resolveAssignedBus = async (userId) => {
	const user = await User.findByPk(userId, { attributes: ['id', 'company_id'] });
	if (!user) {
		return { error: { status: 404, body: { error: 'User not found' } } };
	}

	if (!user.company_id) {
		return { bus: null, user };
	}

	const driverIdCandidates = await buildDriverIdCandidates(userId);
	const DriverAssignment = require('../models').DriverAssignment;

	const assignment = await DriverAssignment.findOne({
		where: {
			driver_id: { [Op.in]: driverIdCandidates },
			unassigned_at: null,
			company_id: user.company_id,
		},
		attributes: ['bus_id', 'assigned_at'],
		order: [['assigned_at', 'DESC']],
	});

	let bus = null;
	if (assignment?.bus_id) {
		bus = await Bus.findOne({
			where: { id: assignment.bus_id, company_id: user.company_id },
			attributes: ['id', 'plate_number', 'model', 'capacity', 'status'],
		});
	}

	if (!bus) {
		bus = await Bus.findOne({
			where: { driver_id: { [Op.in]: driverIdCandidates }, company_id: user.company_id },
			attributes: ['id', 'plate_number', 'model', 'capacity', 'status'],
			order: [['updated_at', 'DESC']],
		});
	}

	return { bus, user };
};

const mapDriverSchedule = (schedule) => ({
	id: schedule.id,
	routeName: schedule.Route ? `${schedule.Route.origin} → ${schedule.Route.destination}` : 'Unknown Route',
	routeFrom: schedule.Route ? schedule.Route.origin : null,
	routeTo: schedule.Route ? schedule.Route.destination : null,
	departureLocation: schedule.Route ? schedule.Route.origin : null,
	destination: schedule.Route ? schedule.Route.destination : null,
	departureTime: schedule.departure_time,
	arrivalTime: schedule.arrival_time,
	tripDate: schedule.schedule_date,
	date: schedule.schedule_date,
	seatCapacity: schedule.total_seats || schedule.Bus?.capacity || 0,
	totalSeats: schedule.total_seats || schedule.Bus?.capacity || 0,
	seatsAvailable: schedule.available_seats,
	status: schedule.status,
	bus: schedule.Bus
		? { id: schedule.Bus.id, plateNumber: schedule.Bus.plate_number, model: schedule.Bus.model, capacity: schedule.Bus.capacity }
		: null,
	busName: schedule.Bus?.model || schedule.Bus?.plate_number || null,
	busPlateNumber: schedule.Bus?.plate_number || null,
});

const fetchAssignedDriverSchedules = async (userId) => {
	const assignment = await resolveAssignedBus(userId);
	if (assignment.error) {
		return assignment;
	}

	if (!assignment.user?.company_id) {
		return { schedules: [] };
	}

	const companyId = assignment.user.company_id;
	const driverIdCandidates = await buildDriverIdCandidates(userId);
 
	const client = await pool.connect();
	try {
		const assignmentsQuery = await client.query(
			`SELECT DISTINCT bus_id
			 FROM driver_assignments
			 WHERE driver_id = ANY($1::uuid[])
			   AND unassigned_at IS NULL
			   AND company_id = $2`,
			[driverIdCandidates, companyId]
		);

		let busIds = assignmentsQuery.rows.map((row) => row.bus_id).filter(Boolean);
		if ((!busIds || busIds.length === 0) && assignment.bus?.id) {
			busIds = [assignment.bus.id];
		}
		if (!busIds || busIds.length === 0) {
			return { schedules: [] };
		}

		const tripsQuery = await client.query(
			`SELECT trip.id,
			        trip.departure_time,
			        trip.arrival_time,
			        trip.schedule_date,
			        trip.available_seats,
			        trip.price_per_seat,
			        trip.status,
			        trip.bus_id,
			        trip.bus_plate,
			        trip.bus_model,
			        trip.bus_capacity,
			        trip.route_from,
			        trip.route_to,
			        trip.source
			 FROM (
			 	SELECT s.id::text AS id,
			 	       s.departure_time::text AS departure_time,
			 	       s.arrival_time::text AS arrival_time,
			 	       s.schedule_date::date AS schedule_date,
			 	       s.available_seats,
			 	       s.price_per_seat,
			 	       s.status::text AS status,
			 	       b.id::text AS bus_id,
			 	       b.plate_number AS bus_plate,
			 	       b.model AS bus_model,
			 	       b.capacity AS bus_capacity,
			 	       r.origin AS route_from,
			 	       r.destination AS route_to,
			 	       'schedules'::text AS source
			 	FROM schedules s
			 	LEFT JOIN buses b ON s.bus_id = b.id
			 	LEFT JOIN routes r ON s.route_id = r.id
			 	WHERE s.bus_id = ANY($1::uuid[])
			 	  AND s.company_id = $2

			 	UNION ALL

			 	SELECT bs.schedule_id::text AS id,
			 	       bs.time::text AS departure_time,
			 	       NULL::text AS arrival_time,
			 	       bs.date::date AS schedule_date,
			 	       COALESCE(bs.available_seats, GREATEST(0, bs.capacity - COALESCE(bs.booked_seats, 0))) AS available_seats,
			 	       NULL::numeric AS price_per_seat,
			 	       bs.status::text AS status,
			 	       b.id::text AS bus_id,
			 	       b.plate_number AS bus_plate,
			 	       b.model AS bus_model,
			 	       b.capacity AS bus_capacity,
			 	       rr.from_location AS route_from,
			 	       rr.to_location AS route_to,
			 	       'bus_schedules'::text AS source
			 	FROM bus_schedules bs
			 	LEFT JOIN buses b ON bs.bus_id = b.id
			 	LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
			 	WHERE bs.bus_id = ANY($1::uuid[])
			 	  AND COALESCE(bs.company_id::text, $2::text) = $2::text
			 ) trip
			 ORDER BY trip.schedule_date ASC, trip.departure_time ASC`,
			[busIds, companyId]
		);

		const mappedTrips = tripsQuery.rows.map((trip) => ({
			id: trip.id,
			routeName: trip.route_from && trip.route_to ? `${trip.route_from} → ${trip.route_to}` : 'Unknown Route',
			routeFrom: trip.route_from,
			routeTo: trip.route_to,
			departureLocation: trip.route_from,
			destination: trip.route_to,
			departureTime: trip.departure_time,
			arrivalTime: trip.arrival_time,
			tripDate: trip.schedule_date,
			date: trip.schedule_date,
			seatCapacity: trip.bus_capacity || 0,
			totalSeats: trip.bus_capacity || 0,
			seatsAvailable: trip.available_seats,
			price: trip.price_per_seat,
			status: trip.status,
			source: trip.source,
			bus: {
				id: trip.bus_id,
				plateNumber: trip.bus_plate,
				model: trip.bus_model,
				capacity: trip.bus_capacity,
			},
			busName: trip.bus_model || trip.bus_plate || null,
			busPlateNumber: trip.bus_plate || null,
		}));

		return { schedules: await attachOperationalStatusesToSchedules(mappedTrips) };
	} finally {
		client.release();
	}
};

function mapTicketRow(row) {
	return {
		id: row.id,
		qrCode: row.id,
		bookingRef: row.booking_ref,
		status: row.status,
		checkedInAt: row.checked_in_at,
		boardingTime: row.checked_in_at,
		price: row.price ? parseFloat(row.price) : null,
		seatNumber: row.seat_number,
		tripId: row.schedule_id,
		driverId: row.driver_id || null,
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

async function getOperationalStatusColumns(client) {
	if (operationalStatusColumnCache) {
		return operationalStatusColumnCache;
	}

	const result = await client.query(
		`SELECT table_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		   AND column_name = 'operational_status'
		   AND table_name = ANY($1::text[])`,
		[['schedules', 'bus_schedules']]
	);

	operationalStatusColumnCache = {
		schedules: false,
		bus_schedules: false,
	};

	for (const row of result.rows) {
		operationalStatusColumnCache[row.table_name] = true;
	}

	return operationalStatusColumnCache;
}

function normalizeOperationalStatus(baseStatus, operationalStatus) {
	const normalizedOperationalStatus = String(operationalStatus || '').toUpperCase();
	if (OPERATIONAL_STATUS_VALUES.includes(normalizedOperationalStatus)) {
		return normalizedOperationalStatus;
	}

	const normalizedBaseStatus = String(baseStatus || '').toLowerCase();
	if (normalizedBaseStatus === 'completed') {
		return 'COMPLETED';
	}

	if (normalizedBaseStatus === 'in_progress' || normalizedBaseStatus === 'active') {
		return 'ON_ROUTE';
	}

	return 'ASSIGNED';
}

function mapTicketBoardingStatus(ticketStatus) {
	return String(ticketStatus || '').toUpperCase() === 'CHECKED_IN' ? 'BOARDED' : 'BOOKED';
}

async function attachOperationalStatusesToSchedules(schedules) {
	if (!Array.isArray(schedules) || schedules.length === 0) {
		return schedules || [];
	}

	const scheduleIds = schedules.map((schedule) => schedule.id).filter(Boolean);
	if (scheduleIds.length === 0) {
		return schedules;
	}

	const client = await pool.connect();
	try {
		const columns = await getOperationalStatusColumns(client);
		if (!columns.schedules) {
			return schedules.map((schedule) => ({
				...schedule,
				operationalStatus: normalizeOperationalStatus(schedule.status, null),
			}));
		}

		const result = await client.query(
			`SELECT id::text AS id, operational_status
			 FROM schedules
			 WHERE id = ANY($1::uuid[])`,
			[scheduleIds]
		);

		const operationalStatusMap = new Map(result.rows.map((row) => [String(row.id), row.operational_status]));

		return schedules.map((schedule) => ({
			...schedule,
			operationalStatus: normalizeOperationalStatus(schedule.status, operationalStatusMap.get(String(schedule.id))),
		}));
	} finally {
		client.release();
	}
}

async function resolveDriverTripRecord(client, userId, scheduleId) {
	const assignmentResult = await resolveAssignedBus(userId);
	if (assignmentResult.error) {
		return { error: assignmentResult.error };
	}

	if (!assignmentResult.bus) {
		return { error: { status: 403, body: { error: 'Unauthorized: No bus assigned to this driver' } } };
	}

	const columns = await getOperationalStatusColumns(client);
	const scheduleResult = await client.query(
		`SELECT id::text AS schedule_id,
		        bus_id::text AS bus_id,
		        company_id::text AS company_id,
		        route_id::text AS route_id,
		        schedule_date::date AS departure_date,
		        departure_time::text AS departure_time,
		        status::text AS status,
		        ${columns.schedules ? 'operational_status::text AS operational_status' : 'NULL::text AS operational_status'},
		        'schedules'::text AS source
		 FROM schedules
		 WHERE id::text = $1::text
		 UNION ALL
		 SELECT schedule_id::text AS schedule_id,
		        bus_id::text AS bus_id,
		        company_id::text AS company_id,
		        route_id::text AS route_id,
		        date::date AS departure_date,
		        time::text AS departure_time,
		        status::text AS status,
		        ${columns.bus_schedules ? 'operational_status::text AS operational_status' : 'NULL::text AS operational_status'},
		        'bus_schedules'::text AS source
		 FROM bus_schedules
		 WHERE schedule_id::text = $1::text
		 LIMIT 1`,
		[scheduleId]
	);

	if (!scheduleResult.rows.length) {
		return { error: { status: 404, body: { error: 'Trip not found' } } };
	}

	const trip = scheduleResult.rows[0];
	if (String(trip.bus_id) !== String(assignmentResult.bus.id)) {
		return { error: { status: 403, body: { error: 'Unauthorized: This trip is not assigned to your bus' } } };
	}

	return {
		trip: {
			...trip,
			operational_status: normalizeOperationalStatus(trip.status, trip.operational_status),
		},
		assignedBus: assignmentResult.bus,
		columns,
	};
}

async function updateOperationalStatusForTrip(client, tripRecord, columns, nextOperationalStatus) {
	const normalizedStatus = String(nextOperationalStatus || '').toUpperCase();
	if (!OPERATIONAL_STATUS_VALUES.includes(normalizedStatus)) {
		throw new Error('Invalid operational trip status');
	}

	if (tripRecord.source === 'bus_schedules') {
		if (!columns.bus_schedules) {
			return normalizeOperationalStatus(tripRecord.status, normalizedStatus);
		}

		const result = await client.query(
			`UPDATE bus_schedules
			 SET operational_status = $2,
			     updated_at = NOW()
			 WHERE schedule_id::text = $1::text
			 RETURNING operational_status`,
			[tripRecord.schedule_id, normalizedStatus]
		);

		return normalizeOperationalStatus(tripRecord.status, result.rows[0]?.operational_status || normalizedStatus);
	}

	if (!columns.schedules) {
		return normalizeOperationalStatus(tripRecord.status, normalizedStatus);
	}

	const result = await client.query(
		`UPDATE schedules
		 SET operational_status = $2,
		     updated_at = NOW()
		 WHERE id::text = $1::text
		 RETURNING operational_status`,
		[tripRecord.schedule_id, normalizedStatus]
	);

	return normalizeOperationalStatus(tripRecord.status, result.rows[0]?.operational_status || normalizedStatus);
}

async function insertTicketScanLog(client, payload) {
	if (!payload?.driverId || !payload?.ticketId || !payload?.scheduleId || !payload?.passengerId) {
		return;
	}

	await client.query(
		`INSERT INTO ticket_scan_logs (ticket_id, driver_id, schedule_id, passenger_id, scanned_at, scan_status, error_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			payload.ticketId,
			payload.driverId,
			payload.scheduleId,
			payload.passengerId,
			payload.scannedAt || new Date(),
			payload.scanStatus || 'SUCCESS',
			payload.errorReason || null,
		]
	);
}

async function ensureLegacyDriverProfile(client, userId) {
	const existingDriver = await client.query(
		'READ SELECT id, user_id, company_id, name FROM drivers WHERE user_id = $1 LIMIT 1'.replace('READ ', ''),
		[userId]
	);

	if (existingDriver.rowCount > 0) {
		return existingDriver.rows[0];
	}

	const userResult = await client.query(
		'SELECT id, role, company_id, full_name, email FROM users WHERE id = $1 LIMIT 1',
		[userId]
	);

	if (userResult.rowCount === 0) {
		return null;
	}

	const user = userResult.rows[0];
	if (String(user.role || '').toLowerCase() !== 'driver' || !user.company_id) {
		return null;
	}

	const generatedLicense = `DRV-AUTO-${String(user.id).replace(/-/g, '').slice(0, 12).toUpperCase()}`;
	const inserted = await client.query(
		`INSERT INTO drivers (id, company_id, user_id, name, license_number, phone, email, is_active, created_at, updated_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, $5, TRUE, NOW(), NOW())
		 RETURNING id, user_id, company_id, name`,
		[user.company_id, user.id, user.full_name || 'Driver', generatedLicense, user.email || null]
	);

	return inserted.rows[0] || null;
}

async function getPassengerManifest(client, scheduleId, driverId = null) {
	const tripResult = await client.query(
		`SELECT id::text AS schedule_id,
		        bus_id::text AS bus_id,
		        schedule_date::date AS departure_date,
		        departure_time::text AS departure_time,
		        status::text AS status,
		        route_id::text AS route_id,
		        'schedules'::text AS source
		 FROM schedules
		 WHERE id::text = $1::text
		 UNION ALL
		 SELECT schedule_id::text AS schedule_id,
		        bus_id::text AS bus_id,
		        date::date AS departure_date,
		        time::text AS departure_time,
		        status::text AS status,
		        route_id::text AS route_id,
		        'bus_schedules'::text AS source
		 FROM bus_schedules
		 WHERE schedule_id::text = $1::text
		 LIMIT 1`,
		[scheduleId]
	);

	const trip = tripResult.rows[0] || null;
	const logJoinParams = driverId ? [scheduleId, driverId] : [scheduleId];
	const logDriverClause = driverId ? 'AND tsl.driver_id = $2::uuid' : '';

	const passengerResult = await client.query(
		`SELECT t.id,
		        t.booking_ref,
		        t.seat_number,
		        t.status,
		        t.checked_in_at,
		        t.schedule_id,
		        COALESCE(u.full_name, 'Passenger') AS passenger_name,
		        u.id AS passenger_id,
		        COALESCE(s.schedule_date::date, bs.date::date) AS departure_date,
		        COALESCE(r.origin, rr.from_location, t.from_stop) AS route_from,
		        COALESCE(r.destination, rr.to_location, t.to_stop) AS route_to,
		        b.plate_number AS bus_plate,
		        scan_log.driver_id AS scanned_by_driver_id,
		        scan_log.scanned_at AS scan_time,
		        scan_log.scan_status
		 FROM tickets t
		 LEFT JOIN users u ON u.id = t.passenger_id
		 LEFT JOIN schedules s ON s.id::text = t.schedule_id::text
		 LEFT JOIN routes r ON r.id = s.route_id
		 LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
		 LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
		 LEFT JOIN buses b ON b.id::text = COALESCE(s.bus_id::text, bs.bus_id::text)
		 LEFT JOIN LATERAL (
		 	SELECT tsl.driver_id, tsl.scanned_at, tsl.scan_status
		 	FROM ticket_scan_logs tsl
		 	WHERE tsl.ticket_id = t.id
		 	  AND tsl.schedule_id::text = $1::text
		 	  ${logDriverClause}
		 	ORDER BY tsl.scanned_at DESC
		 	LIMIT 1
		 ) scan_log ON TRUE
		 WHERE t.schedule_id::text = $1::text
		   AND UPPER(COALESCE(t.status::text, '')) NOT IN ('CANCELLED', 'EXPIRED')
		 ORDER BY CASE WHEN t.checked_in_at IS NULL THEN 0 ELSE 1 END,
		          t.seat_number ASC,
		          t.booked_at ASC NULLS LAST`,
		logJoinParams
	);

	const passengers = passengerResult.rows.map((row) => {
		const isCheckedIn = String(row.status || '').toUpperCase() === 'CHECKED_IN';
		const boardingTime = row.scan_time || row.checked_in_at;

		return ({
		id: row.id,
		passengerId: row.passenger_id,
		name: row.passenger_name,
		seatNumber: row.seat_number,
		ticketId: row.id,
		bookingRef: row.booking_ref,
		ticketStatus: isCheckedIn ? 'BOARDED' : 'BOOKED',
		bookingStatus: row.status,
		boardingTime,
		scanTime: row.scan_time,
		scanStatus: row.scan_status,
		scannedByDriverId: row.scanned_by_driver_id,
		routeFrom: row.route_from,
		routeTo: row.route_to,
		busPlate: row.bus_plate,
		time: boardingTime ? new Date(boardingTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
		});
	});
	const checkedInPassengers = passengers.filter((passenger) => passenger.ticketStatus === 'BOARDED');
	const pendingPassengers = passengers.filter((passenger) => passenger.ticketStatus !== 'BOARDED');

	return {
		trip: trip ? {
			id: trip.schedule_id,
			departureDate: trip.departure_date,
			departureTime: trip.departure_time,
			status: trip.status,
		} : null,
		passengers,
		checkedInPassengers,
		pendingPassengers,
		stats: {
			total: passengers.length,
			booked: pendingPassengers.length,
			boarded: checkedInPassengers.length,
		},
		meta: passengerResult.rows[0] ? {
			routeFrom: passengerResult.rows[0].route_from,
			routeTo: passengerResult.rows[0].route_to,
			busPlate: passengerResult.rows[0].bus_plate,
			departureDate: passengerResult.rows[0].departure_date,
		} : null,
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

const updateMyProfile = async (req, res) => {
	let client;
	try {
		const {
			fullName,
			phoneNumber,
			email,
			location,
		} = req.body || {};

		const hasAnyInput = [fullName, phoneNumber, email, location].some((value) => typeof value !== 'undefined');
		if (!hasAnyInput) {
			return res.status(400).json({ error: 'No profile fields provided' });
		}

		client = await pool.connect();
		await client.query('BEGIN');

		const warnings = [];
		const profile = await client.query(
			'SELECT id, full_name, email, phone_number, role FROM users WHERE id = $1 LIMIT 1',
			[req.userId]
		);

		if (profile.rowCount === 0) {
			await client.query('ROLLBACK');
			return res.status(404).json({ error: 'User not found' });
		}

		const userRow = profile.rows[0];
		if (String(userRow.role || '').toLowerCase() !== 'driver') {
			await client.query('ROLLBACK');
			return res.status(403).json({ error: 'Only drivers can update this profile' });
		}

		const usersColumns = await getTableColumns(client, 'users');
		const driversColumns = await getTableColumns(client, 'drivers');

		const userSets = [];
		const userParams = [req.userId];
		const pushUserField = (column, value) => {
			if (!usersColumns.has(column) || typeof value === 'undefined') return;
			userParams.push(value);
			userSets.push(`${column} = $${userParams.length}`);
		};

		pushUserField('full_name', typeof fullName === 'string' ? fullName.trim() : fullName);
		pushUserField('phone_number', typeof phoneNumber === 'string' ? phoneNumber.trim() : phoneNumber);
		pushUserField('email', typeof email === 'string' ? email.trim() : email);

		if (usersColumns.has('updated_at') && userSets.length > 0) {
			userSets.push('updated_at = NOW()');
		}

		if (userSets.length > 0) {
			await client.query(
				`UPDATE users SET ${userSets.join(', ')} WHERE id = $1`,
				userParams
			);
		}

		const driverRow = await ensureLegacyDriverProfile(client, req.userId);
		if (!driverRow?.id) {
			warnings.push('Driver profile row was not found.');
		} else {
			const driverSets = [];
			const driverParams = [driverRow.id];
			const pushDriverField = (column, value) => {
				if (!driversColumns.has(column) || typeof value === 'undefined') return;
				driverParams.push(value);
				driverSets.push(`${column} = $${driverParams.length}`);
			};

			pushDriverField('name', typeof fullName === 'string' ? fullName.trim() : fullName);
			pushDriverField('phone', typeof phoneNumber === 'string' ? phoneNumber.trim() : phoneNumber);
			pushDriverField('email', typeof email === 'string' ? email.trim() : email);

			if (typeof location !== 'undefined') {
				if (driversColumns.has('location')) {
					pushDriverField('location', typeof location === 'string' ? location.trim() : location);
				} else {
					warnings.push('Location column is not available in drivers table for this deployment.');
				}
			}

			if (driversColumns.has('updated_at') && driverSets.length > 0) {
				driverSets.push('updated_at = NOW()');
			}

			if (driverSets.length > 0) {
				await client.query(
					`UPDATE drivers SET ${driverSets.join(', ')} WHERE id = $1`,
					driverParams
				);
			}
		}

		const updatedUserResult = await client.query(
			'SELECT id, full_name, email, phone_number FROM users WHERE id = $1 LIMIT 1',
			[req.userId]
		);

		const updatedDriverResult = await client.query(
			`SELECT id, name, phone, email${driversColumns.has('location') ? ', location' : ''}
			 FROM drivers
			 WHERE user_id = $1
			 LIMIT 1`,
			[req.userId]
		);

		await client.query('COMMIT');

		const updatedUser = updatedUserResult.rows[0] || null;
		const updatedDriver = updatedDriverResult.rows[0] || null;

		return res.json({
			success: true,
			profile: {
				fullName: updatedUser?.full_name || updatedDriver?.name || null,
				phoneNumber: updatedUser?.phone_number || updatedDriver?.phone || null,
				email: updatedUser?.email || updatedDriver?.email || null,
				location: updatedDriver?.location || null,
			},
			warnings,
		});
	} catch (error) {
		if (client) {
			try { await client.query('ROLLBACK'); } catch {}
		}
		return res.status(500).json({ error: 'Failed to update driver profile', message: error.message });
	} finally {
		if (client) client.release();
	}
};

const getAssignedBus = async (req, res) => {
	try {
		const result = await resolveAssignedBus(req.userId);
		if (result.error) {
			return res.status(result.error.status).json(result.error.body);
		}

		const bus = result.bus;
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

		res.json({ schedules: await attachOperationalStatusesToSchedules(unique) });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

// Return all schedules for buses currently assigned to the logged-in driver
const getMyTrips = async (req, res) => {
	try {
		const result = await fetchAssignedDriverSchedules(req.userId);
		if (result.error) {
			return res.status(result.error.status).json(result.error.body);
		}

		res.json({ trips: result.schedules || [] });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

const getDriverSchedules = async (req, res) => {
	try {
		const result = await fetchAssignedDriverSchedules(req.userId);
		if (result.error) {
			return res.status(result.error.status).json(result.error.body);
		}

		res.json({ schedules: result.schedules || [] });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

// Aggregated dashboard data for driver: today's stats, upcoming trips, recent check-ins
const getDashboard = async (req, res) => {
	let client;
	try {
		client = await pool.connect();
		const debugMessages = [];

		const legacyDriver = await ensureLegacyDriverProfile(client, req.userId);

		let companyId;
		const driverIdCandidates = [req.userId];

		if (legacyDriver?.id) {
			companyId = legacyDriver.company_id;
			driverIdCandidates.push(legacyDriver.id);
		} else {
			debugMessages.push('No legacy driver profile linked to this user.');
			// Fallback to users table when no legacy driver row exists
			const userQuery = await client.query(
				'SELECT company_id FROM users WHERE id = $1',
				[req.userId]
			);
			if (userQuery.rowCount === 0) {
				debugMessages.push('User not found while loading dashboard context.');
				return res.json({
					assignedBus: null,
					completedTrips: 0,
					activeTrips: 0,
					passengers: 0,
					revenue: 0,
					stats: { completed: 0, active: 0, passengers: 0, revenue: 0 },
					upcoming: [],
					recentCheckins: [],
					debug: {
						driverUserId: req.userId,
						legacyDriverId: null,
						assignedBusId: null,
						messages: debugMessages,
					},
				});
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
			debugMessages.push('No active driver_assignments rows found; checking buses.driver_id fallback.');
			// Backward-compatible fallback: some deployments still rely on buses.driver_id
			const busesFallback = await client.query(
				`SELECT id
				 FROM buses
				 WHERE company_id = $1 AND driver_id = ANY($2::uuid[])`,
				[companyId, driverIdCandidates]
			);
			busIds = busesFallback.rows.map(r => r.id).filter(Boolean);
		}
		const assignedBusResult = await resolveAssignedBus(req.userId);
		const assignedBus = assignedBusResult?.bus || null;
		const primaryBusId = assignedBus?.id || busIds[0] || null;

		if (!primaryBusId) {
			debugMessages.push('No assigned bus resolved for this driver.');
			return res.json({
				assignedBus: null,
				completedTrips: 0,
				activeTrips: 0,
				passengers: 0,
				revenue: 0,
				stats: { completed: 0, active: 0, passengers: 0, revenue: 0 },
				upcoming: [],
				recentCheckins: [],
				debug: {
					driverUserId: req.userId,
					legacyDriverId: legacyDriver?.id || null,
					assignedBusId: null,
					messages: debugMessages,
				},
			});
		}

		const dashboardBusIds = [primaryBusId];
		const ticketColumns = await getTableColumns(client, 'tickets');
		const ticketScheduleJoin = ticketColumns.has('bus_schedule_id')
			? 'COALESCE(t.bus_schedule_id::text, t.schedule_id::text)'
			: 't.schedule_id::text';

		// Dashboard metrics for assigned bus only (bus_schedules-based):
		// completed/active trip counts + passenger/revenue totals from tickets.
		let statsRow = { completed: 0, active: 0, passengers: 0, revenue: 0, total_schedules: 0 };
		try {
			const statsQ = await client.query(
				`WITH bus_trips AS (
					SELECT
						bs.schedule_id::text AS schedule_id,
						LOWER(TRIM(COALESCE(bs.status::text, ''))) AS status
					FROM bus_schedules bs
					WHERE bs.bus_id::text = $1::text
					  AND COALESCE(bs.company_id::text, $2::text) = $2::text
				)
				SELECT
					COALESCE(COUNT(DISTINCT bt.schedule_id), 0) AS total_schedules,
					COALESCE(COUNT(DISTINCT CASE
						WHEN bt.status = 'completed' THEN bt.schedule_id
						ELSE NULL
					END), 0) AS completed,
					COALESCE(COUNT(DISTINCT CASE
						WHEN bt.status IN ('active', 'in_progress') THEN bt.schedule_id
						ELSE NULL
					END), 0) AS active,
					COALESCE(COUNT(CASE
						WHEN LOWER(TRIM(COALESCE(t.status::text, ''))) IN ('confirmed', 'active', 'checked_in') THEN t.id
						ELSE NULL
					END), 0) AS passengers,
					COALESCE(SUM(CASE
						WHEN LOWER(TRIM(COALESCE(t.status::text, ''))) IN ('confirmed', 'active', 'checked_in')
						THEN COALESCE(t.price, 0)
						ELSE 0
					END), 0) AS revenue
				FROM bus_trips bt
				LEFT JOIN tickets t
				  ON ${ticketScheduleJoin} = bt.schedule_id`,
				[primaryBusId, companyId]
			);

			statsRow = statsQ.rows[0] || statsRow;
		} catch (statsError) {
			debugMessages.push(`Metrics query failed: ${statsError.message}`);
		}

		if (Number(statsRow.total_schedules || 0) === 0) {
			debugMessages.push('No bus_schedules found for assigned bus.');
		}

		// Assigned trips from both legacy schedules and shared-route bus_schedules.
		const upcomingQ = await client.query(
			`SELECT trip.id,
			        trip.departure_time,
			        trip.arrival_time,
			        trip.schedule_date,
			        trip.available_seats,
			        trip.price_per_seat,
			        COALESCE(ticket_counts.booked_seats, 0) AS booked_seats,
			        trip.status,
			        trip.bus_id,
			        trip.bus_plate,
			        trip.bus_capacity,
			        trip.route_from,
			        trip.route_to,
			        trip.source
			 FROM (
			 	SELECT s.id::text AS id,
			 	       s.departure_time::text AS departure_time,
			 	       s.arrival_time::text AS arrival_time,
			 	       s.schedule_date::date AS schedule_date,
			 	       s.available_seats,
			 	       s.price_per_seat,
			 	       s.status::text AS status,
			 	       b.id::text AS bus_id,
			 	       b.plate_number AS bus_plate,
			 	       b.capacity AS bus_capacity,
			 	       r.origin AS route_from,
			 	       r.destination AS route_to,
			 	       'schedules'::text AS source
			 	FROM schedules s
			 	LEFT JOIN buses b ON s.bus_id = b.id
			 	LEFT JOIN routes r ON s.route_id = r.id
			 	WHERE s.bus_id = ANY($1::uuid[])
			 	  AND s.company_id = $2
			 	  AND LOWER(COALESCE(s.status::text, '')) IN ('scheduled', 'in_progress', 'active')

			 	UNION ALL

			 	SELECT bs.schedule_id::text AS id,
			 	       bs.time::text AS departure_time,
			 	       NULL::text AS arrival_time,
			 	       bs.date::date AS schedule_date,
			 	       COALESCE(bs.available_seats, GREATEST(0, bs.capacity - COALESCE(bs.booked_seats, 0))) AS available_seats,
			 	       NULL::numeric AS price_per_seat,
			 	       bs.status::text AS status,
			 	       b.id::text AS bus_id,
			 	       b.plate_number AS bus_plate,
			 	       b.capacity AS bus_capacity,
			 	       rr.from_location AS route_from,
			 	       rr.to_location AS route_to,
			 	       'bus_schedules'::text AS source
			 	FROM bus_schedules bs
			 	LEFT JOIN buses b ON bs.bus_id = b.id
			 	LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
			 	WHERE bs.bus_id = ANY($1::uuid[])
			 	  AND COALESCE(bs.company_id::text, $2::text) = $2::text
			 	  AND LOWER(COALESCE(bs.status::text, '')) IN ('scheduled', 'in_progress', 'active')
			 ) trip
			 LEFT JOIN LATERAL (
			 	SELECT COUNT(*)::integer AS booked_seats
			 	FROM tickets t
			 	WHERE t.schedule_id::text = trip.id
			 	  AND UPPER(COALESCE(t.status::text, '')) NOT IN ('CANCELLED', 'EXPIRED')
			 ) ticket_counts ON TRUE
			 ORDER BY trip.schedule_date ASC, trip.departure_time ASC
			 LIMIT 5`,
			[dashboardBusIds, companyId]
		);

		const upcoming = await attachOperationalStatusesToSchedules(upcomingQ.rows.map(r => ({
			id: r.id,
			routeFrom: r.route_from,
			routeTo: r.route_to,
			departureTime: r.departure_time,
			arrivalTime: r.arrival_time,
			date: r.schedule_date,
			seatsAvailable: r.available_seats,
			bookedSeats: Number(r.booked_seats || 0),
			soldSeats: Number(r.booked_seats || 0),
			passengers: Number(r.booked_seats || 0),
			totalSeats: r.bus_capacity,
			price: r.price_per_seat,
			status: r.status,
			source: r.source,
			bus: { id: r.bus_id, plateNumber: r.bus_plate, capacity: r.bus_capacity }
		})));

		const stats = {
			completed: parseInt(statsRow.completed || 0, 10),
			active: parseInt(statsRow.active || 0, 10),
			passengers: parseInt(statsRow.passengers || 0, 10),
			revenue: parseFloat(statsRow.revenue || 0)
		};

		const activeTrip = upcoming.find((trip) => String(trip.status || '').toLowerCase() === 'in_progress' && String(trip.source || '') === 'bus_schedules')
			|| upcoming.find((trip) => String(trip.status || '').toLowerCase() === 'in_progress')
			|| upcoming.find((trip) => ['BOARDING', 'DEPARTED', 'ON_ROUTE', 'ARRIVING'].includes(trip.operationalStatus))
			|| upcoming[0]
			|| null;

		let manifest = null;
		if (activeTrip?.id) {
			manifest = await getPassengerManifest(client, activeTrip.id, legacyDriver?.id || null);
		}

		let recentRows = [];
		if (activeTrip?.id && legacyDriver?.id) {
			const activeRecentQ = await client.query(
				`SELECT tsl.ticket_id AS id,
				        t.booking_ref,
				        t.seat_number,
				        t.status,
				        tsl.scanned_at AS checked_in_at,
				        u.full_name AS passenger_name,
				        tsl.schedule_id::text AS schedule_id,
				        COALESCE(r.origin, rr.from_location, t.from_stop) AS route_from,
				        COALESCE(r.destination, rr.to_location, t.to_stop) AS route_to,
				        b.plate_number AS bus_plate
				 FROM ticket_scan_logs tsl
				 INNER JOIN tickets t ON t.id = tsl.ticket_id
				 INNER JOIN users u ON u.id = t.passenger_id
				 LEFT JOIN schedules s ON s.id::text = tsl.schedule_id::text
				 LEFT JOIN routes r ON r.id = s.route_id
				 LEFT JOIN bus_schedules bs ON bs.schedule_id::text = tsl.schedule_id::text
				 LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
				 LEFT JOIN buses b ON b.id::text = COALESCE(s.bus_id::text, bs.bus_id::text)
				 WHERE tsl.driver_id = $1
				   AND tsl.schedule_id::text = $2::text
				   AND UPPER(COALESCE(t.status::text, '')) = 'CHECKED_IN'
				   AND LOWER(COALESCE(tsl.scan_status, 'valid')) NOT IN ('invalid', 'already_used')
				 ORDER BY tsl.scanned_at DESC`,
				[legacyDriver.id, activeTrip.id]
			);
			recentRows = activeRecentQ.rows;
		} else if (legacyDriver?.id) {
			const scanLogQ = await client.query(
				`SELECT tsl.ticket_id AS id,
				        t.booking_ref,
				        t.seat_number,
				        t.status,
				        tsl.scanned_at AS checked_in_at,
				        u.full_name AS passenger_name,
				        tsl.schedule_id::text AS schedule_id,
				        COALESCE(r.origin, rr.from_location, t.from_stop) AS route_from,
				        COALESCE(r.destination, rr.to_location, t.to_stop) AS route_to,
				        b.plate_number AS bus_plate
				 FROM ticket_scan_logs tsl
				 INNER JOIN tickets t ON t.id = tsl.ticket_id
				 INNER JOIN users u ON u.id = t.passenger_id
				 LEFT JOIN schedules s ON s.id::text = tsl.schedule_id::text
				 LEFT JOIN routes r ON r.id = s.route_id
				 LEFT JOIN bus_schedules bs ON bs.schedule_id::text = tsl.schedule_id::text
				 LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
				 LEFT JOIN buses b ON b.id::text = COALESCE(s.bus_id::text, bs.bus_id::text)
				 WHERE tsl.driver_id = $1
				   AND UPPER(COALESCE(t.status::text, '')) = 'CHECKED_IN'
				   AND LOWER(COALESCE(tsl.scan_status, 'valid')) NOT IN ('invalid', 'already_used')
				 ORDER BY tsl.scanned_at DESC`,
				[legacyDriver.id]
			);
			recentRows = scanLogQ.rows;
		}

		const recent = recentRows.map(r => ({ 
			id: r.id,
			bookingRef: r.booking_ref,
			name: r.passenger_name,
			seat: r.seat_number,
			checked: true,
			status: r.status,
			scheduleId: r.schedule_id,
			routeFrom: r.route_from,
			routeTo: r.route_to,
			checkedAt: r.checked_in_at,
			busPlate: r.bus_plate,
			time: r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
		}));

		const recentCheckins = manifest?.checkedInPassengers?.length
			? manifest.checkedInPassengers.map((passenger) => ({
				id: passenger.id,
				bookingRef: passenger.bookingRef,
				name: passenger.name,
				seat: passenger.seatNumber,
				checked: true,
				status: passenger.bookingStatus || passenger.scanStatus || 'CHECKED_IN',
				routeFrom: passenger.routeFrom,
				routeTo: passenger.routeTo,
				checkedAt: passenger.boardingTime,
				busPlate: passenger.busPlate,
				time: passenger.time,
			}))
			: recent;

		res.json({
			assignedBus: assignedBus
				? {
					busId: assignedBus.id,
					plateNumber: assignedBus.plate_number,
					model: assignedBus.model,
					capacity: assignedBus.capacity,
					status: assignedBus.status,
				}
				: null,
			completedTrips: stats.completed,
			activeTrips: stats.active,
			passengers: stats.passengers,
			revenue: stats.revenue,
			stats,
			upcoming,
			activeTrip,
			manifest,
			recentCheckins,
			operationalStatuses: OPERATIONAL_STATUS_VALUES,
			debug: {
				driverUserId: req.userId,
				legacyDriverId: legacyDriver?.id || null,
				assignedBusId: primaryBusId,
				messages: debugMessages,
			},
		});
	} catch (err) {
		console.error('Dashboard error:', err);
		res.status(500).json({ error: 'Failed to load dashboard', message: err.message });
	} finally {
		if (client) client.release();
	}
};

const getTripPassengers = async (req, res) => {
	let client;
	try {
		const scheduleId = String(req.params.scheduleId || req.query.scheduleId || '').trim();
		if (!scheduleId) {
			return res.status(400).json({ error: 'scheduleId is required' });
		}

		client = await pool.connect();
		const tripResult = await resolveDriverTripRecord(client, req.userId, scheduleId);
		if (tripResult.error) {
			return res.status(tripResult.error.status).json(tripResult.error.body);
		}

		const manifest = await getPassengerManifest(client, scheduleId, tripResult.assignedBus ? (await ensureLegacyDriverProfile(client, req.userId))?.id || null : null);
		return res.json({
			scheduleId,
			trip: {
				...manifest.trip,
				operationalStatus: tripResult.trip.operational_status,
				source: tripResult.trip.source,
			},
			passengers: manifest.passengers,
			checkedInPassengers: manifest.checkedInPassengers,
			pendingPassengers: manifest.pendingPassengers,
			stats: manifest.stats,
			meta: manifest.meta,
		});
	} catch (error) {
		console.error('Trip passengers error:', error);
		return res.status(500).json({ error: 'Failed to load trip passengers', message: error.message });
	} finally {
		if (client) {
			client.release();
		}
	}
};

const updateTripOperationalStatus = async (req, res) => {
	let client;
	try {
		const scheduleId = String(req.body?.scheduleId || '').trim();
		const operationalStatus = String(req.body?.operationalStatus || req.body?.status || '').trim().toUpperCase();

		if (!scheduleId) {
			return res.status(400).json({ error: 'scheduleId is required' });
		}

		if (!OPERATIONAL_STATUS_VALUES.includes(operationalStatus)) {
			return res.status(400).json({ error: 'Invalid operationalStatus', allowedValues: OPERATIONAL_STATUS_VALUES });
		}

		client = await pool.connect();
		await client.query('BEGIN');

		const tripResult = await resolveDriverTripRecord(client, req.userId, scheduleId);
		if (tripResult.error) {
			await client.query('ROLLBACK');
			return res.status(tripResult.error.status).json(tripResult.error.body);
		}

		const appliedStatus = await updateOperationalStatusForTrip(client, tripResult.trip, tripResult.columns, operationalStatus);
		await client.query('COMMIT');

		const io = req.app.get('io');
		if (io) {
			io.to(`schedule:${scheduleId}`).emit('trip:operationalStatus', {
				scheduleId,
				operationalStatus: appliedStatus,
				updatedBy: req.userId,
				updatedAt: new Date().toISOString(),
			});
		}

		return res.json({
			success: true,
			scheduleId,
			operationalStatus: appliedStatus,
			allowedValues: OPERATIONAL_STATUS_VALUES,
		});
	} catch (error) {
		if (client) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				// Ignore rollback errors.
			}
		}
		console.error('Update operational status error:', error);
		return res.status(500).json({ error: 'Failed to update trip status', message: error.message });
	} finally {
		if (client) {
			client.release();
		}
	}
};

const updateAssignedBusScheduleStatus = async (userId, scheduleId, targetStatus) => {
	const assignmentResult = await resolveAssignedBus(userId);
	if (assignmentResult.error) {
		return assignmentResult.error;
	}

	if (!assignmentResult.bus) {
		return { status: 403, body: { error: 'Unauthorized: No bus assigned to this driver' } };
	}

	const client = await pool.connect();
	try {
		const scheduleQuery = await client.query(
			`SELECT schedule_id, bus_id, route_id, date, time, capacity, status
			 FROM bus_schedules
			 WHERE schedule_id::text = $1::text
			 LIMIT 1`,
			[scheduleId]
		);

		if (!scheduleQuery.rows.length) {
			return null;
		}

		const schedule = scheduleQuery.rows[0];
		if (String(schedule.bus_id) !== String(assignmentResult.bus.id)) {
			return { status: 403, body: { error: 'Unauthorized: This trip is not assigned to your bus' } };
		}

		if (targetStatus === 'in_progress') {
			if (schedule.status === 'in_progress') {
				return { status: 400, body: { error: 'Trip already started', schedule } };
			}

			if (schedule.status === 'completed') {
				return { status: 400, body: { error: 'Trip already completed', schedule } };
			}
		}

		if (targetStatus === 'completed' && schedule.status !== 'in_progress') {
			return { status: 400, body: { error: 'Trip is not in progress', currentStatus: schedule.status } };
		}

		const updated = await client.query(
			`UPDATE bus_schedules
			 SET status = $1,
			     updated_at = NOW()
			 WHERE schedule_id::text = $2::text
			 RETURNING schedule_id, bus_id, route_id, date, time, capacity, status`,
			[targetStatus, scheduleId]
		);

		return {
			status: 200,
			body: {
				success: true,
				message: targetStatus === 'in_progress' ? 'Trip started successfully' : 'Trip ended successfully',
				schedule: updated.rows[0],
			},
		};
	} finally {
		client.release();
	}
};

const startTrip = async (req, res) => {
	try {
		const { scheduleId } = req.body;
		
		if (!scheduleId) {
			return res.status(400).json({ error: 'scheduleId is required' });
		}

		const busScheduleResult = await updateAssignedBusScheduleStatus(req.userId, scheduleId, 'in_progress');
		if (busScheduleResult) {
			return res.status(busScheduleResult.status).json(busScheduleResult.body);
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

		const busScheduleResult = await updateAssignedBusScheduleStatus(req.userId, scheduleId, 'completed');
		if (busScheduleResult) {
			return res.status(busScheduleResult.status).json(busScheduleResult.body);
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
		const { qrCode, ticketId, scheduleId } = req.body || {};
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
		const driver = await ensureLegacyDriverProfile(client, req.userId);
		if (!driver?.id) {
			return res.status(403).json({ error: 'Driver profile not found', valid: false, message: 'Driver profile missing' });
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
				 COALESCE(s1.departure_time::text, s2.time::text) AS departure_time,
				 s1.arrival_time::text AS arrival_time,
				 COALESCE(s1.schedule_date::date, s2.date::date) AS schedule_date,
				 COALESCE(s1.bus_id, s2.bus_id) AS bus_id,
				 COALESCE(s1.status::text, s2.status::text) AS trip_status,
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
		const requestedScheduleId = String(scheduleId || '').trim();
		if (requestedScheduleId && String(ticketRow.schedule_id) !== requestedScheduleId) {
			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'invalid',
				errorReason: 'SCHEDULE_MISMATCH',
			});
			await client.query('COMMIT');
			return res.status(400).json({
				valid: false,
				message: 'Ticket is for another trip ❌',
				ticket: mapTicketRow(ticketRow),
				reason: 'SCHEDULE_MISMATCH',
			});
		}

		// Validate company match
		if (ticketRow.company_id && ticketRow.company_id !== driver.company_id) {
			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'invalid',
				errorReason: 'COMPANY_MISMATCH',
			});
			await client.query('COMMIT');
			return res.status(403).json({ error: 'Ticket not in your company', valid: false, message: 'Not for this company ❌' });
		}

		// Validate trip is active or scheduled.
		// bus_schedules-based trips remain 'scheduled' until departure (no explicit start-trip flow),
		// so we allow 'scheduled' in addition to the legacy 'in_progress'/'ACTIVE' states.
		const allowedStatuses = ['in_progress', 'active', 'scheduled'];
		if (!allowedStatuses.includes(String(ticketRow.trip_status || '').toLowerCase())) {
			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'invalid',
				errorReason: 'TRIP_NOT_ACTIVE',
			});
			await client.query('COMMIT');
			return res.status(400).json({ 
				valid: false, 
				message: 'Trip not active ❌', 
				ticket: mapTicketRow(ticketRow),
				reason: 'TRIP_NOT_ACTIVE'
			});
		}

		// Check if ticket is cancelled or expired
		if (ticketRow.status === 'CANCELLED' || ticketRow.status === 'EXPIRED') {
			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'invalid',
				errorReason: 'TICKET_CANCELLED',
			});
			await client.query('COMMIT');
			return res.status(400).json({ 
				valid: false, 
				message: 'Ticket cancelled ❌', 
				ticket: mapTicketRow(ticketRow),
				reason: 'TICKET_CANCELLED'
			});
		}

		// Check if already checked in
		if (ticketRow.status === 'CHECKED_IN') {
			const lastValidScanResult = await client.query(
				`SELECT tsl.driver_id, d.name AS driver_name
				 FROM ticket_scan_logs tsl
				 LEFT JOIN drivers d ON d.id = tsl.driver_id
				 WHERE tsl.ticket_id = $1
				   AND LOWER(COALESCE(tsl.scan_status, '')) = 'valid'
				 ORDER BY tsl.scanned_at DESC
				 LIMIT 1`,
				[ticketRow.id]
			);

			const lastScanner = lastValidScanResult.rows[0] || null;
			const scannedBySameDriver = Boolean(lastScanner && String(lastScanner.driver_id) === String(driver.id));
			const alreadyUsedReason = scannedBySameDriver ? 'ALREADY_USED_SELF' : 'ALREADY_USED';
			const alreadyUsedMessage = scannedBySameDriver
				? 'Already scanned in this trip ⚠️'
				: 'Ticket already used ⚠️';

			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'already_used',
				errorReason: alreadyUsedReason,
			});
			await client.query('COMMIT');
			const alreadyScannedTicket = mapTicketRow(ticketRow);
			return res.status(200).json({ 
				valid: false, 
				message: alreadyUsedMessage,
				ticket: alreadyScannedTicket,
				reason: alreadyUsedReason,
				scanned_by_driver: lastScanner?.driver_name || null,
				passenger: {
					name: ticketRow.passenger_name,
					seat: ticketRow.seat_number,
					phone: ticketRow.passenger_phone,
					boardingStatus: 'BOARDED',
				}
			});
		}

		// Update ticket to CHECKED_IN
		const updateResult = await client.query(
			'UPDATE tickets SET status = $1, checked_in_at = NOW() WHERE id = $2 AND status = $3 RETURNING checked_in_at',
			['CHECKED_IN', ticketRow.id, 'CONFIRMED']
		);

		if (updateResult.rowCount === 0) {
			await insertTicketScanLog(client, {
				driverId: driver.id,
				ticketId: ticketRow.id,
				scheduleId: ticketRow.schedule_id,
				passengerId: ticketRow.passenger_id,
				scanStatus: 'already_used',
				errorReason: 'ALREADY_USED',
			});
			await client.query('COMMIT');
			return res.status(409).json({ 
				valid: false, 
				message: 'Ticket already used', 
				ticket: mapTicketRow(ticketRow),
				reason: 'ALREADY_USED'
			});
		}

		const checkedInAt = updateResult.rows[0].checked_in_at;

		// Create audit log entry only when a legacy driver id exists.
		await insertTicketScanLog(client, {
			driverId: driver.id,
			ticketId: ticketRow.id,
			scheduleId: ticketRow.schedule_id,
			passengerId: ticketRow.passenger_id,
			scannedAt: checkedInAt,
			scanStatus: 'valid',
		});

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
				boardingStatus: 'BOARDED',
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
	updateMyProfile,
	getAssignedBus,
	getTodaySchedule,
	getTripPassengers,
	updateTripOperationalStatus,
	startTrip,
	endTrip,
	postLocation,
	getDriverContext,
	scanTicket,
	shareLocation,
	getDriverSchedules,
	getMyTrips,
	getDashboard,
};
