const pool = require('../config/pgPool');

let liveLocationColumnCache = null;

function emitTrackingLocation(trip, storedLocation) {
  try {
    const { getIO } = require('../config/socket');
    const io = getIO();
    const payload = {
      scheduleId: trip.schedule_id,
      busId: trip.bus_id,
      companyId: trip.company_id,
      routeFrom: trip.route_from,
      routeTo: trip.route_to,
      busPlate: trip.plate_number,
      latitude: storedLocation ? parseFloat(storedLocation.latitude) : null,
      longitude: storedLocation ? parseFloat(storedLocation.longitude) : null,
      speed: storedLocation?.speed ? parseFloat(storedLocation.speed) : null,
      heading: storedLocation?.heading ? parseFloat(storedLocation.heading) : null,
      timestamp: storedLocation?.recorded_at || new Date().toISOString(),
    };

    io.to(`schedule:${trip.schedule_id}`).emit('bus:locationUpdate', payload);
    if (trip.company_id) {
      io.to(`company:${trip.company_id}`).emit('bus:locationUpdate', payload);
    }
  } catch (error) {
    console.warn('Tracking socket broadcast skipped:', error.message);
  }
}

async function getUserCompanyId(userId) {
  const result = await pool.query(
    `SELECT company_id FROM drivers WHERE user_id = $1
     UNION
     SELECT company_id FROM users WHERE id = $1 AND company_id IS NOT NULL
     LIMIT 1`,
    [userId]
  );

  return result.rows[0]?.company_id || null;
}

async function resolveAssignedBus(client, userId) {
  const assignmentResult = await client.query(
    `WITH driver_ids AS (
       SELECT $1::text AS id
       UNION
       SELECT d.id::text AS id
       FROM drivers d
       WHERE d.user_id::text = $1::text
     )
     SELECT b.id,
            b.company_id,
            b.plate_number,
            b.model,
            b.capacity,
            b.status
     FROM driver_assignments da
     INNER JOIN buses b ON b.id::text = da.bus_id::text
     WHERE da.unassigned_at IS NULL
       AND da.driver_id::text IN (SELECT id FROM driver_ids)
     ORDER BY da.assigned_at DESC NULLS LAST,
              da.created_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );

  if (assignmentResult.rows.length > 0) {
    return assignmentResult.rows[0];
  }

  const fallbackResult = await client.query(
    `WITH driver_ids AS (
       SELECT $1::text AS id
       UNION
       SELECT d.id::text AS id
       FROM drivers d
       WHERE d.user_id::text = $1::text
     )
     SELECT b.id,
            b.company_id,
            b.plate_number,
            b.model,
            b.capacity,
            b.status
     FROM buses b
     WHERE b.driver_id::text IN (SELECT id FROM driver_ids)
     ORDER BY b.updated_at DESC NULLS LAST,
              b.created_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );

  return fallbackResult.rows[0] || null;
}

async function getBusScheduleById(client, scheduleId) {
  const result = await client.query(
    `SELECT bs.schedule_id,
            bs.bus_id,
            bs.company_id,
            bs.route_id,
            bs.date,
            bs.time,
            bs.capacity,
            bs.available_seats,
            bs.booked_seats,
            bs.status,
            bs.created_at,
            bs.updated_at,
            b.plate_number,
            b.model,
            rr.from_location AS route_from,
            rr.to_location AS route_to
     FROM bus_schedules bs
    LEFT JOIN buses b ON b.id::text = bs.bus_id::text
    LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
     WHERE bs.schedule_id::text = $1::text
     LIMIT 1`,
    [scheduleId]
  );

  return result.rows[0] || null;
}

async function getCurrentBusScheduleForBus(client, busId, statuses) {
  const result = await client.query(
    `SELECT bs.schedule_id,
            bs.bus_id,
            bs.company_id,
            bs.route_id,
            bs.date,
            bs.time,
            bs.capacity,
            bs.available_seats,
            bs.booked_seats,
            bs.status,
            bs.created_at,
            bs.updated_at,
            b.plate_number,
            b.model,
            rr.from_location AS route_from,
            rr.to_location AS route_to
     FROM bus_schedules bs
     LEFT JOIN buses b ON b.id::text = bs.bus_id::text
     LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
     WHERE bs.bus_id::text = $1::text
       AND bs.status = ANY($2::text[])
     ORDER BY CASE
                WHEN bs.status = 'in_progress' THEN 0
                WHEN bs.date >= CURRENT_DATE THEN 1
                ELSE 2
              END,
              bs.date ASC NULLS LAST,
              bs.time ASC NULLS LAST,
              bs.updated_at DESC NULLS LAST
     LIMIT 1`,
    [busId, statuses]
  );

  return result.rows[0] || null;
}

async function storeLiveLocation(client, scheduleId, latitude, longitude, speed, heading) {
  const colMap = await getLiveLocationColumnMap(client);
  if (!colMap.hasScheduleId || !colMap.hasLatitude || !colMap.hasLongitude) {
    throw new Error('live_bus_locations is missing required schedule-based columns');
  }

  console.log('[tracking] GPS update received', {
    scheduleId,
    latitude,
    longitude,
    speed,
    heading,
    source: 'rest',
  });

  const columns = ['schedule_id', 'latitude', 'longitude', 'speed', 'heading', 'recorded_at'];
  const placeholders = ['$1', '$2', '$3', '$4', '$5', 'NOW()'];
  const values = [scheduleId, latitude, longitude, speed, heading];

  if (colMap.hasCreatedAt) {
    columns.push('created_at');
    placeholders.push('NOW()');
  }

  if (colMap.hasUpdatedAt) {
    columns.push('updated_at');
    placeholders.push('NOW()');
  }

  const timestampProjection = colMap.hasRecordedAt
    ? 'recorded_at'
    : (colMap.hasUpdatedAt ? 'updated_at AS recorded_at' : 'NOW() AS recorded_at');

  const result = await client.query(
    `INSERT INTO live_bus_locations (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING schedule_id,
               latitude,
               longitude,
               ${colMap.hasSpeed ? 'speed' : 'NULL::numeric AS speed'},
               ${colMap.hasHeading ? 'heading' : 'NULL::numeric AS heading'},
               ${timestampProjection}`,
    values
  );

  if (result.rows[0]) {
    console.log('[tracking] Location inserted', {
      scheduleId: result.rows[0].schedule_id,
      recordedAt: result.rows[0].recorded_at,
      source: 'rest',
    });
  }

  return result.rows[0] || null;
}

async function getLatestLocationForSchedule(client, schedule) {
  const colMap = await getLiveLocationColumnMap(client);

  if (!colMap.hasLatitude || !colMap.hasLongitude) {
    return null;
  }

  const whereClauses = [];
  const params = [];

  if (colMap.hasScheduleId && schedule.schedule_id) {
    params.push(schedule.schedule_id);
    whereClauses.push(`l.schedule_id::text = $${params.length}::text`);
  }

  if (colMap.hasBusId && schedule.bus_id) {
    params.push(schedule.bus_id);
    whereClauses.push(`l.bus_id::text = $${params.length}::text`);
  }

  if (whereClauses.length === 0) {
    return null;
  }

  const timestampCol = colMap.hasRecordedAt
    ? 'l.recorded_at'
    : (colMap.hasUpdatedAt ? 'l.updated_at' : 'NOW()');

  const selectScheduleId = colMap.hasScheduleId
    ? 'l.schedule_id'
    : `$${params.length + 1}::uuid AS schedule_id`;

  if (!colMap.hasScheduleId) {
    params.push(schedule.schedule_id);
  }

  console.log('[tracking] Map query executed', {
    scheduleId: schedule.schedule_id,
    mode: 'latest',
  });

  const result = await client.query(
    `SELECT ${selectScheduleId},
            l.latitude,
            l.longitude,
            ${colMap.hasSpeed ? 'l.speed' : 'NULL::numeric AS speed'},
            ${colMap.hasHeading ? 'l.heading' : 'NULL::numeric AS heading'},
            ${timestampCol} AS recorded_at
     FROM live_bus_locations l
     WHERE (${whereClauses.join(' OR ')})
     ORDER BY ${timestampCol} DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

async function updateTripStatus(client, userId, scheduleId, targetStatus) {
  const assignedBus = await resolveAssignedBus(client, userId);
  if (!assignedBus) {
    return { error: { status: 404, message: 'No bus assigned to you yet' } };
  }

  let trip = null;
  if (scheduleId) {
    trip = await getBusScheduleById(client, scheduleId);
  }

  if (!trip) {
    const fallbackStatuses = targetStatus === 'in_progress' ? ['scheduled'] : ['in_progress'];
    trip = await getCurrentBusScheduleForBus(client, assignedBus.id, fallbackStatuses);
  }

  if (!trip) {
    return { error: { status: 404, message: 'Trip not found for your assigned bus' } };
  }

  if (String(trip.bus_id) !== String(assignedBus.id)) {
    return { error: { status: 403, message: 'You can only manage trips for your assigned bus' } };
  }

  const allowedCurrentStatus = targetStatus === 'in_progress' ? 'scheduled' : 'in_progress';
  if (trip.status !== allowedCurrentStatus) {
    return {
      error: {
        status: 400,
        message: targetStatus === 'in_progress'
          ? 'Only scheduled trips can be started'
          : 'Only in-progress trips can be ended',
      },
    };
  }

  const updateResult = await client.query(
    `UPDATE bus_schedules
     SET status = $2,
         updated_at = NOW()
     WHERE schedule_id::text = $1::text
     RETURNING schedule_id, bus_id, company_id, status, date, time, updated_at`,
    [trip.schedule_id, targetStatus]
  );

  return { trip: updateResult.rows[0], assignedBus };
}

async function getLiveLocationColumnMap(client) {
  if (liveLocationColumnCache) return liveLocationColumnCache;

  const cols = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'live_bus_locations'`
  );

  const set = new Set(cols.rows.map(r => r.column_name));
  liveLocationColumnCache = {
    hasId: set.has('id'),
    hasScheduleId: set.has('schedule_id'),
    hasBusId: set.has('bus_id'),
    hasRecordedAt: set.has('recorded_at'),
    hasCreatedAt: set.has('created_at'),
    hasUpdatedAt: set.has('updated_at'),
    hasLatitude: set.has('latitude'),
    hasLongitude: set.has('longitude'),
    hasSpeed: set.has('speed'),
    hasHeading: set.has('heading'),
  };

  return liveLocationColumnCache;
}

/**
 * Driver updates their GPS location
 * POST /api/driver/location
 * Body: { bus_id, latitude, longitude, speed, heading }
 */
const updateDriverLocation = async (req, res) => {
  try {
    const userId = req.userId; // From auth middleware
    const { scheduleId, bus_id, latitude, longitude, speed, heading } = req.body;

    // Validate required fields
    if ((!scheduleId && !bus_id) || !latitude || !longitude) {
      return res.status(400).json({ error: 'scheduleId or bus_id, latitude, and longitude are required' });
    }

    // Validate coordinates
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const client = await pool.connect();
    try {
      const assignedBus = await resolveAssignedBus(client, userId);
      if (!assignedBus) {
        return res.status(404).json({ error: 'No bus assigned to you yet' });
      }

      let trip = scheduleId ? await getBusScheduleById(client, scheduleId) : null;
      if (!trip && bus_id) {
        trip = await getCurrentBusScheduleForBus(client, bus_id, ['in_progress']);
      }

      if (!trip) {
        return res.status(404).json({ error: 'No active trip found for location update' });
      }

      if (String(trip.bus_id) !== String(assignedBus.id)) {
        return res.status(403).json({ error: 'Trip does not belong to your assigned bus' });
      }

      if (trip.status !== 'in_progress') {
        return res.status(400).json({ error: 'Tracking is only available for in-progress trips' });
      }

      const storedLocation = await storeLiveLocation(
        client,
        trip.schedule_id,
        parseFloat(latitude),
        parseFloat(longitude),
        speed ? parseFloat(speed) : null,
        heading ? parseFloat(heading) : null
      );

      emitTrackingLocation(trip, storedLocation);

      res.json({
        success: true,
        location: {
          scheduleId: trip.schedule_id,
          bus_id: trip.bus_id,
          latitude: storedLocation ? parseFloat(storedLocation.latitude) : parseFloat(latitude),
          longitude: storedLocation ? parseFloat(storedLocation.longitude) : parseFloat(longitude),
          speed: storedLocation?.speed ? parseFloat(storedLocation.speed) : (speed ? parseFloat(speed) : null),
          heading: storedLocation?.heading ? parseFloat(storedLocation.heading) : (heading ? parseFloat(heading) : null),
          recorded_at: storedLocation?.recorded_at || new Date().toISOString(),
        },
        message: 'Location updated',
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error updating driver location:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Driver starts a trip
 * POST /api/driver/trip/start
 * Body: { bus_id, latitude, longitude }
 */
const startTrip = async (req, res) => {
  try {
    const userId = req.userId;
    const { scheduleId, bus_id, latitude, longitude } = req.body;

    if ((!scheduleId && !bus_id) || !latitude || !longitude) {
      return res.status(400).json({ error: 'scheduleId or bus_id, latitude, and longitude are required' });
    }

    const client = await pool.connect();
    try {
      const result = await updateTripStatus(client, userId, scheduleId || null, 'in_progress');
      if (result.error) {
        return res.status(result.error.status).json({ error: result.error.message });
      }

      const storedLocation = await storeLiveLocation(
        client,
        result.trip.schedule_id,
        parseFloat(latitude),
        parseFloat(longitude),
        0,
        null
      );

      const trip = await getBusScheduleById(client, result.trip.schedule_id);
      if (trip) {
        emitTrackingLocation(trip, storedLocation);
      }

      res.json({
        success: true,
        message: 'Trip started successfully',
        trip: {
          scheduleId: result.trip.schedule_id,
          bus_id: result.trip.bus_id,
          status: result.trip.status,
        },
        location: storedLocation
          ? {
              scheduleId: storedLocation.schedule_id,
              latitude: parseFloat(storedLocation.latitude),
              longitude: parseFloat(storedLocation.longitude),
              speed: storedLocation.speed ? parseFloat(storedLocation.speed) : null,
              heading: storedLocation.heading ? parseFloat(storedLocation.heading) : null,
              recorded_at: storedLocation.recorded_at,
            }
          : null,
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error starting trip:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Driver ends a trip
 * POST /api/driver/trip/end
 * Body: { bus_id }
 */
const endTrip = async (req, res) => {
  try {
    const userId = req.userId;
    const { scheduleId, bus_id } = req.body;

    if (!scheduleId && !bus_id) {
      return res.status(400).json({ error: 'scheduleId or bus_id is required' });
    }

    const client = await pool.connect();
    try {
      let scheduleToEnd = scheduleId || null;
      if (!scheduleToEnd && bus_id) {
        const trip = await getCurrentBusScheduleForBus(client, bus_id, ['in_progress']);
        scheduleToEnd = trip?.schedule_id || null;
      }

      const result = await updateTripStatus(client, userId, scheduleToEnd, 'completed');
      if (result.error) {
        return res.status(result.error.status).json({ error: result.error.message });
      }

      res.json({
        success: true,
        message: 'Trip ended successfully',
        trip: {
          scheduleId: result.trip.schedule_id,
          bus_id: result.trip.bus_id,
          status: result.trip.status,
        },
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error ending trip:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get all active bus locations for a company
 * GET /api/company/live-locations
 */
const getLiveLocations = async (req, res) => {
  try {
    const userId = req.userId;
    const companyId = await getUserCompanyId(userId);

    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const client = await pool.connect();
    try {
      const colMap = await getLiveLocationColumnMap(client);
      if (!colMap.hasScheduleId || !colMap.hasLatitude || !colMap.hasLongitude) {
        return res.json({ success: true, count: 0, locations: [] });
      }

      const timestampCol = colMap.hasRecordedAt
        ? 'l.recorded_at'
        : (colMap.hasUpdatedAt ? 'l.updated_at' : 'NOW()');

      const locations = await client.query(
        `SELECT DISTINCT ON (l.schedule_id)
                l.schedule_id,
                l.latitude,
                l.longitude,
                ${colMap.hasSpeed ? 'l.speed' : 'NULL::numeric AS speed'},
                ${colMap.hasHeading ? 'l.heading' : 'NULL::numeric AS heading'},
                ${timestampCol} AS recorded_at,
                bs.status AS trip_status,
                bs.date,
                bs.time,
                b.id AS bus_id,
                b.plate_number,
                b.model,
                b.capacity,
                b.status AS bus_status,
                COALESCE(u.full_name, d.name) AS driver_name,
                rr.from_location AS route_from,
                rr.to_location AS route_to
         FROM live_bus_locations l
         INNER JOIN bus_schedules bs ON bs.schedule_id::text = l.schedule_id::text
         LEFT JOIN buses b ON b.id::text = bs.bus_id::text
         LEFT JOIN users u ON u.id::text = b.driver_id::text
         LEFT JOIN drivers d ON d.id::text = b.driver_id::text OR d.user_id::text = b.driver_id::text
         LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
         WHERE bs.company_id::text = $1::text
           AND bs.status = 'in_progress'
         ORDER BY l.schedule_id, ${timestampCol} DESC`,
        [companyId]
      );

      console.log('[tracking] Map query executed', {
        companyId,
        count: locations.rows.length,
        mode: 'company-live-locations',
      });

      const mapped = locations.rows.map((loc) => ({
        scheduleId: loc.schedule_id,
        bus: {
          id: loc.bus_id,
          plateNumber: loc.plate_number,
          model: loc.model,
          capacity: loc.capacity,
          status: loc.bus_status,
        },
        route: {
          from: loc.route_from,
          to: loc.route_to,
        },
        driver: {
          name: loc.driver_name || null,
        },
        location: {
          latitude: parseFloat(loc.latitude),
          longitude: parseFloat(loc.longitude),
          speed: loc.speed ? parseFloat(loc.speed) : null,
          heading: loc.heading ? parseFloat(loc.heading) : null,
        },
        trip_status: loc.trip_status,
        date: loc.date,
        time: loc.time,
        updated_at: loc.recorded_at,
      }));

      res.json({
        success: true,
        count: mapped.length,
        locations: mapped,
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error fetching live locations:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get driver's current trip status
 * GET /api/driver/trip/status
 */
const getTripStatus = async (req, res) => {
  try {
    const userId = req.userId;
    const client = await pool.connect();
    try {
      const assignedBus = await resolveAssignedBus(client, userId);
      if (!assignedBus) {
        return res.json({
          success: true,
          hasActiveTrip: false,
          trip: null,
        });
      }

      const activeTrip = await getCurrentBusScheduleForBus(client, assignedBus.id, ['in_progress']);

      if (!activeTrip) {
        return res.json({
          success: true,
          hasActiveTrip: false,
          trip: null,
        });
      }

      res.json({
        success: true,
        hasActiveTrip: true,
        trip: {
          scheduleId: activeTrip.schedule_id,
          bus: {
            id: activeTrip.bus_id,
            plateNumber: activeTrip.plate_number,
            model: activeTrip.model,
          },
          route: {
            from: activeTrip.route_from,
            to: activeTrip.route_to,
          },
          trip_status: activeTrip.status,
          started_at: activeTrip.updated_at,
          last_update: activeTrip.updated_at,
        },
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error getting trip status:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get current location for a specific schedule
 * GET /api/tracking/schedule/:scheduleId/location
 * Accessible by: passengers with tickets, company admins, super admins
 */
const getScheduleLocation = async (req, res) => {
  try {
    const userId = req.userId;
    const userRole = req.userRole;
    const { scheduleId } = req.params;

    if (!scheduleId) {
      return res.status(400).json({ error: 'scheduleId is required' });
    }

    const scheduleLookupClient = await pool.connect();
    let schedule;
    try {
      schedule = await getBusScheduleById(scheduleLookupClient, scheduleId);
    } finally {
      scheduleLookupClient.release();
    }

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Authorization check based on role
    let authorized = false;

    if (userRole === 'admin') {
      // Super admin can access any schedule
      authorized = true;
    } else if (userRole === 'company_admin' || userRole === 'company') {
      // Company admin can access their company's schedules
      authorized = (await getUserCompanyId(userId)) === schedule.company_id;
    } else if (userRole === 'driver') {
      const driverClient = await pool.connect();
      try {
        const assignedBus = await resolveAssignedBus(driverClient, userId);
        authorized = Boolean(assignedBus && String(assignedBus.id) === String(schedule.bus_id));
      } finally {
        driverClient.release();
      }
    } else if (userRole === 'commuter') {
      // Commuter must have a confirmed ticket for this schedule
      const ticketClient = await pool.connect();
      try {
        const ticketResult = await ticketClient.query(
          `SELECT id FROM tickets 
           WHERE schedule_id::text = $1::text 
             AND passenger_id::text = $2::text 
             AND status IN ('CONFIRMED', 'CHECKED_IN')
           LIMIT 1`,
          [scheduleId, userId]
        );
        if (ticketResult.rows.length > 0) {
          authorized = true;
        }
      } finally {
        ticketClient.release();
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Unauthorized: You do not have access to this schedule' });
    }

    // Fetch schedule history ordered from oldest to newest so path survives refreshes.
    const client = await pool.connect();
    try {
      const colMap = await getLiveLocationColumnMap(client);

      if (!colMap.hasLatitude || !colMap.hasLongitude) {
        return res.json({
          success: true,
          hasLocation: false,
          message: 'Location storage is not configured correctly'
        });
      }

      const latestLocation = await getLatestLocationForSchedule(client, schedule);
      if (!latestLocation) {
        return res.json({
          success: true,
          hasLocation: false,
          message: 'No location data available yet'
        });
      }

      const whereClauses = [];
      const params = [];

      if (colMap.hasScheduleId) {
        params.push(schedule.schedule_id);
        whereClauses.push(`l.schedule_id::text = $${params.length}::text`);
      }

      if (colMap.hasBusId && schedule.bus_id) {
        params.push(schedule.bus_id);
        whereClauses.push(`l.bus_id::text = $${params.length}::text`);
      }

      if (whereClauses.length === 0) {
        return res.json({
          success: true,
          hasLocation: false,
          message: 'No compatible location key found'
        });
      }

      const timestampCol = colMap.hasRecordedAt
        ? 'l.recorded_at'
        : (colMap.hasUpdatedAt ? 'l.updated_at' : 'NOW()');

      const selectScheduleId = colMap.hasScheduleId
        ? 'l.schedule_id'
        : `$${params.length + 1}::uuid AS schedule_id`;
      if (!colMap.hasScheduleId) {
        params.push(schedule.schedule_id);
      }

      console.log('[tracking] Map query executed', {
        scheduleId: schedule.schedule_id,
        mode: 'history',
      });

      const locationResult = await client.query(
        `SELECT ${selectScheduleId},
                l.latitude,
                l.longitude,
                ${colMap.hasSpeed ? 'l.speed' : 'NULL::numeric AS speed'},
                ${colMap.hasHeading ? 'l.heading' : 'NULL::numeric AS heading'},
                ${timestampCol} AS recorded_at
         FROM live_bus_locations l
         WHERE (${whereClauses.join(' OR ')})
         ORDER BY ${timestampCol} ASC`,
        params
      );

      const history = locationResult.rows.map((row) => ({
        scheduleId: row.schedule_id,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude),
        speed: row.speed ? parseFloat(row.speed) : null,
        heading: row.heading ? parseFloat(row.heading) : null,
        timestamp: row.recorded_at,
      }));

      const location = {
        scheduleId: latestLocation.schedule_id,
        latitude: parseFloat(latestLocation.latitude),
        longitude: parseFloat(latestLocation.longitude),
        speed: latestLocation.speed ? parseFloat(latestLocation.speed) : null,
        heading: latestLocation.heading ? parseFloat(latestLocation.heading) : null,
        timestamp: latestLocation.recorded_at,
      };
      
      res.json({
        success: true,
        hasLocation: true,
        location: {
          scheduleId: location.scheduleId,
          latitude: location.latitude,
          longitude: location.longitude,
          speed: location.speed,
          heading: location.heading,
          timestamp: location.timestamp
        },
        history,
      });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error getting schedule location:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  updateDriverLocation,
  startTrip,
  endTrip,
  getLiveLocations,
  getTripStatus,
  getScheduleLocation
};
