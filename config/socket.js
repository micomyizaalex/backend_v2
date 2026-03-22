/**
 * Socket.IO Configuration and Setup
 * Handles real-time GPS tracking for buses
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./pgPool');

let io;

async function resolveAssignedBus(client, userId) {
  const assignmentResult = await client.query(
    `WITH driver_ids AS (
       SELECT $1::text AS id
       UNION
       SELECT d.id::text AS id
       FROM drivers d
       WHERE d.user_id::text = $1::text
     )
     SELECT b.id, b.company_id, b.plate_number, b.model, b.capacity, b.status
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
     SELECT b.id, b.company_id, b.plate_number, b.model, b.capacity, b.status
     FROM buses b
     WHERE b.driver_id::text IN (SELECT id FROM driver_ids)
     ORDER BY b.updated_at DESC NULLS LAST,
              b.created_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );

  return fallbackResult.rows[0] || null;
}

async function getBusSchedule(client, scheduleId) {
  const result = await client.query(
    `SELECT bs.schedule_id,
            bs.bus_id,
            bs.company_id,
            bs.route_id,
            bs.status,
            bs.date,
            bs.time,
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

async function getLatestScheduleLocation(client, scheduleId) {
  const result = await client.query(
    `SELECT latitude, longitude, speed, heading, recorded_at
     FROM live_bus_locations
     WHERE schedule_id::text = $1::text
     ORDER BY recorded_at DESC NULLS LAST, updated_at DESC NULLS LAST
     LIMIT 1`,
    [scheduleId]
  );

  return result.rows[0] || null;
}

async function emitCurrentLocation(socket, client, scheduleId) {
  console.log('[tracking] Map query executed', {
    scheduleId,
    mode: 'socket-current-location',
  });

  const currentLocation = await getLatestScheduleLocation(client, scheduleId);
  if (!currentLocation) {
    return false;
  }

  socket.emit('bus:currentLocation', {
    scheduleId,
    latitude: parseFloat(currentLocation.latitude),
    longitude: parseFloat(currentLocation.longitude),
    speed: currentLocation.speed ? parseFloat(currentLocation.speed) : null,
    heading: currentLocation.heading ? parseFloat(currentLocation.heading) : null,
    timestamp: currentLocation.recorded_at,
  });

  return true;
}

async function persistLiveLocationSample(client, scheduleId, latitude, longitude, speed, heading) {
  console.log('[tracking] GPS update received', {
    scheduleId,
    latitude,
    longitude,
    speed,
    heading,
    source: 'socket',
  });

  const result = await client.query(
    `INSERT INTO live_bus_locations (schedule_id, latitude, longitude, speed, heading, recorded_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
     RETURNING schedule_id, latitude, longitude, speed, heading, recorded_at`,
    [scheduleId, latitude, longitude, speed || null, heading || null]
  );

  if (result.rows[0]) {
    console.log('[tracking] Location inserted', {
      scheduleId: result.rows[0].schedule_id,
      recordedAt: result.rows[0].recorded_at,
      source: 'socket',
    });
  }

  return result.rows[0] || null;
}

/**
 * Initialize Socket.IO server
 * @param {Object} server - HTTP server instance
 */
function initializeSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    },
  });

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      socket.userId = decoded.userId || decoded.id;
      socket.userRole = decoded.role;
      
      console.log(`✅ Socket authenticated: User ${socket.userId}, Role: ${decoded.role}`);
      next();
    } catch (error) {
      console.error('Socket authentication failed:', error.message);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // Connection handler
  io.on('connection', async (socket) => {
    console.log(`🔌 New socket connection: ${socket.id} (User: ${socket.userId})`);

    // Automatically join user to their personal room for real-time updates
    socket.join(`user:${socket.userId}`);
    console.log(`👤 User ${socket.userId} joined personal room: user:${socket.userId}`);

    // If user is a company admin or driver, join their company room
    try {
      const client = await pool.connect();
      
      // Check if user has a company (driver, company owner, or company admin user)
      const companyQuery = await client.query(
        `SELECT company_id FROM drivers WHERE user_id = $1
         UNION
         SELECT id as company_id FROM companies WHERE owner_id = $1
         UNION
         SELECT company_id FROM users WHERE id = $1 AND company_id IS NOT NULL`,
        [socket.userId]
      );
      
      if (companyQuery.rowCount > 0) {
        const companyId = companyQuery.rows[0].company_id;
        socket.join(`company:${companyId}`);
        socket.companyId = companyId;
        console.log(`🏢 User ${socket.userId} joined company room: company:${companyId}`);
      }
      
      client.release();
    } catch (error) {
      console.error('Error setting up user rooms:', error);
    }

    // Driver joins schedule room to broadcast location
    socket.on('driver:joinSchedule', async (data) => {
      try {
        const { scheduleId } = data;
        console.log(`🚌 Driver ${socket.userId} attempting to join schedule ${scheduleId}`);

        const client = await pool.connect();
        try {
          const schedule = await getBusSchedule(client, scheduleId);
          if (!schedule) {
            socket.emit('error', { message: 'Trip not found' });
            return;
          }

          const assignedBus = await resolveAssignedBus(client, socket.userId);
          if (!assignedBus || String(assignedBus.id) !== String(schedule.bus_id)) {
            socket.emit('error', { message: 'Unauthorized: You are not assigned to this bus' });
            return;
          }

          if (schedule.status !== 'in_progress') {
            socket.emit('error', { message: 'Trip is not active for tracking' });
            return;
          }

          socket.join(`schedule:${scheduleId}`);
          socket.currentScheduleId = scheduleId;
          socket.currentCompanyId = schedule.company_id;

          console.log(`✅ Driver joined schedule room: schedule:${scheduleId}`);
          socket.emit('driver:joinedSchedule', { scheduleId, message: 'Successfully joined schedule' });
        } finally {
          client.release();
        }

      } catch (error) {
        console.error('Error in driver:joinSchedule:', error);
        socket.emit('error', { message: 'Failed to join schedule' });
      }
    });

    // Driver broadcasts live GPS location
    socket.on('driver:locationUpdate', async (data) => {
      try {
        const { scheduleId, latitude, longitude, speed, heading } = data;

        // Validate data
        if (!scheduleId || !latitude || !longitude) {
          socket.emit('error', { message: 'Invalid location data' });
          return;
        }

        console.log(`📍 Location update from driver ${socket.userId} for schedule ${scheduleId}: [${latitude}, ${longitude}]`);

        const client = await pool.connect();
        try {
          const schedule = await getBusSchedule(client, scheduleId);
          if (!schedule || schedule.status !== 'in_progress') {
            socket.emit('error', { message: 'Trip not found or not active' });
            return;
          }

          const assignedBus = await resolveAssignedBus(client, socket.userId);
          if (!assignedBus || String(assignedBus.id) !== String(schedule.bus_id)) {
            socket.emit('error', { message: 'Unauthorized: Not the driver assigned to this bus' });
            return;
          }

          const storedLocation = await persistLiveLocationSample(client, scheduleId, latitude, longitude, speed, heading);

          io.to(`schedule:${scheduleId}`).emit('bus:locationUpdate', {
            scheduleId,
            latitude: storedLocation ? parseFloat(storedLocation.latitude) : latitude,
            longitude: storedLocation ? parseFloat(storedLocation.longitude) : longitude,
            speed: storedLocation?.speed ? parseFloat(storedLocation.speed) : (speed ?? null),
            heading: storedLocation?.heading ? parseFloat(storedLocation.heading) : (heading ?? null),
            timestamp: storedLocation?.recorded_at || new Date().toISOString(),
          });

          if (schedule.company_id) {
            io.to(`company:${schedule.company_id}`).emit('bus:locationUpdate', {
              scheduleId,
              latitude: storedLocation ? parseFloat(storedLocation.latitude) : latitude,
              longitude: storedLocation ? parseFloat(storedLocation.longitude) : longitude,
              speed: storedLocation?.speed ? parseFloat(storedLocation.speed) : (speed ?? null),
              heading: storedLocation?.heading ? parseFloat(storedLocation.heading) : (heading ?? null),
              timestamp: storedLocation?.recorded_at || new Date().toISOString(),
            });
          }

          console.log(`📡 Broadcasted location to room: schedule:${scheduleId}`);
        } finally {
          client.release();
        }

      } catch (error) {
        console.error('Error in driver:locationUpdate:', error);
        socket.emit('error', { message: error?.message || 'Failed to update location' });
      }
    });

    // Passenger joins schedule room to receive location updates
    socket.on('passenger:joinSchedule', async (data) => {
      try {
        const { scheduleId, ticketId } = data;
        console.log(`👤 Passenger ${socket.userId} attempting to track schedule ${scheduleId}`);

        const client = await pool.connect();
        try {
          const result = await client.query(
            `SELECT t.id, bs.status AS schedule_status
             FROM tickets t
             INNER JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
             WHERE t.id::text = $1::text
               AND t.passenger_id::text = $2::text
               AND t.status IN ('CONFIRMED', 'CHECKED_IN')
               AND t.schedule_id::text = $3::text`,
            [ticketId, socket.userId, scheduleId]
          );

          if (result.rows.length === 0) {
            socket.emit('error', { message: 'No valid ticket found for this schedule' });
            return;
          }

          const ticket = result.rows[0];
          if (ticket.schedule_status !== 'in_progress') {
            socket.emit('error', { message: 'Bus is not currently active for tracking' });
            return;
          }

          socket.join(`schedule:${scheduleId}`);
          socket.currentScheduleId = scheduleId;

          console.log(`✅ Passenger joined schedule room: schedule:${scheduleId}`);

          const hasCurrentLocation = await emitCurrentLocation(socket, client, scheduleId);

          socket.emit('passenger:joinedSchedule', {
            scheduleId,
            message: 'Successfully joined tracking',
            hasCurrentLocation,
          });
        } finally {
          client.release();
        }

      } catch (error) {
        console.error('Error in passenger:joinSchedule:', error);
        socket.emit('error', { message: 'Failed to join tracking' });
      }
    });

    // Company Admin joins schedule room to track their company's buses
    socket.on('companyAdmin:joinSchedule', async (data) => {
      try {
        const { scheduleId } = data;
        console.log(`🏢 Company Admin ${socket.userId} attempting to track schedule ${scheduleId}`);

        // Verify user is company_admin role
        if (socket.userRole !== 'company_admin' && socket.userRole !== 'company') {
          socket.emit('error', { message: 'Unauthorized: Company admin access required' });
          return;
        }

        const client = await pool.connect();
        try {
          const result = await client.query(
            `SELECT bs.schedule_id, bs.company_id, u.company_id AS admin_company_id, bs.status
             FROM bus_schedules bs
             INNER JOIN users u ON u.id::text = $1::text
             WHERE bs.schedule_id::text = $2::text`,
            [socket.userId, scheduleId]
          );

          if (result.rows.length === 0) {
            socket.emit('error', { message: 'Trip not found' });
            return;
          }

          const schedule = result.rows[0];
          if (String(schedule.company_id) !== String(schedule.admin_company_id)) {
            socket.emit('error', { message: 'Unauthorized: Trip belongs to different company' });
            return;
          }

          socket.join(`schedule:${scheduleId}`);
          socket.currentScheduleId = scheduleId;

          console.log(`✅ Company Admin joined schedule room: schedule:${scheduleId}`);

          const hasCurrentLocation = await emitCurrentLocation(socket, client, scheduleId);

          socket.emit('companyAdmin:joinedSchedule', {
            scheduleId,
            message: 'Successfully joined tracking',
            hasCurrentLocation,
          });
        } finally {
          client.release();
        }

      } catch (error) {
        console.error('Error in companyAdmin:joinSchedule:', error);
        socket.emit('error', { message: 'Failed to join tracking' });
      }
    });

    // Super Admin joins schedule room (can track any schedule)
    socket.on('admin:joinSchedule', async (data) => {
      try {
        const { scheduleId } = data;
        console.log(`🔐 Super Admin ${socket.userId} attempting to track schedule ${scheduleId}`);

        // Verify user is super admin
        if (socket.userRole !== 'admin') {
          socket.emit('error', { message: 'Unauthorized: Super admin access required' });
          return;
        }

        const client = await pool.connect();
        try {
          const schedule = await getBusSchedule(client, scheduleId);
          if (!schedule) {
            socket.emit('error', { message: 'Trip not found' });
            return;
          }

          socket.join(`schedule:${scheduleId}`);
          socket.currentScheduleId = scheduleId;

          console.log(`✅ Super Admin joined schedule room: schedule:${scheduleId}`);

          const hasCurrentLocation = await emitCurrentLocation(socket, client, scheduleId);

          socket.emit('admin:joinedSchedule', {
            scheduleId,
            message: 'Successfully joined tracking',
            hasCurrentLocation,
          });
        } finally {
          client.release();
        }

      } catch (error) {
        console.error('Error in admin:joinSchedule:', error);
        socket.emit('error', { message: 'Failed to join tracking' });
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.id} (User: ${socket.userId})`);
      if (socket.currentScheduleId) {
        socket.leave(`schedule:${socket.currentScheduleId}`);
      }
    });
  });

  console.log('✅ Socket.IO initialized successfully');
  return io;
}

/**
 * Get Socket.IO instance
 * @returns {Object} Socket.IO instance
 */
function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocket first.');
  }
  return io;
}

module.exports = {
  initializeSocket,
  getIO,
};
