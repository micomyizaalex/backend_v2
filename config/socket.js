/**
 * Socket.IO Configuration and Setup
 * Handles real-time GPS tracking for buses
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./pgPool');

let io;

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
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      
      console.log(`✅ Socket authenticated: User ${decoded.id}, Role: ${decoded.role}`);
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

        // Verify driver owns this schedule
        const client = await pool.connect();
        const result = await client.query(
          `SELECT s.*, d.id as driver_id 
           FROM schedules s
           LEFT JOIN drivers d ON s.driver_id = d.id
           WHERE s.id = $1`,
          [scheduleId]
        );
        client.release();

        if (result.rows.length === 0) {
          socket.emit('error', { message: 'Schedule not found' });
          return;
        }

        const schedule = result.rows[0];

        // Verify this user is the driver for this schedule
        if (schedule.driver_id !== socket.userId && socket.userRole !== 'driver') {
          socket.emit('error', { message: 'Unauthorized: You are not the driver for this schedule' });
          return;
        }

        // Verify schedule is ACTIVE (either 'ACTIVE' or 'in_progress')
        if (schedule.status !== 'ACTIVE' && schedule.status !== 'in_progress') {
          socket.emit('error', { message: 'Schedule is not active' });
          return;
        }

        // Join the schedule room
        socket.join(`schedule:${scheduleId}`);
        socket.currentScheduleId = scheduleId;
        
        console.log(`✅ Driver joined schedule room: schedule:${scheduleId}`);
        socket.emit('driver:joinedSchedule', { scheduleId, message: 'Successfully joined schedule' });

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

        // Verify driver is authorized for this schedule
        const client = await pool.connect();
        const result = await client.query(
          `SELECT s.*, d.id as driver_id 
           FROM schedules s
           LEFT JOIN drivers d ON s.driver_id = d.id
           WHERE s.id = $1 AND (s.status = 'ACTIVE' OR s.status = 'in_progress')`,
          [scheduleId]
        );

        if (result.rows.length === 0) {
          client.release();
          socket.emit('error', { message: 'Schedule not found or not active' });
          return;
        }

        const schedule = result.rows[0];

        // Verify authorization
        if (schedule.driver_id !== socket.userId && socket.userRole !== 'driver') {
          client.release();
          socket.emit('error', { message: 'Unauthorized: Not the driver for this schedule' });
          return;
        }

        // Store/update location in database (optional - for history)
        await client.query(
          `INSERT INTO live_bus_locations (schedule_id, latitude, longitude, speed, heading, recorded_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (schedule_id) 
           DO UPDATE SET 
             latitude = $2, 
             longitude = $3, 
             speed = $4, 
             heading = $5, 
             recorded_at = NOW()`,
          [scheduleId, latitude, longitude, speed || null, heading || null]
        );
        client.release();

        // Broadcast to all clients tracking this schedule
        io.to(`schedule:${scheduleId}`).emit('bus:locationUpdate', {
          scheduleId,
          latitude,
          longitude,
          speed,
          heading,
          timestamp: new Date().toISOString(),
        });

        // Broadcast to company's room so company dashboard gets updates instantly
        if (schedule.company_id) {
          io.to(`company:${schedule.company_id}`).emit('bus:locationUpdate', {
            scheduleId,
            latitude,
            longitude,
            speed,
            heading,
            timestamp: new Date().toISOString(),
          });
        }

        console.log(`📡 Broadcasted location to room: schedule:${scheduleId}`);

      } catch (error) {
        console.error('Error in driver:locationUpdate:', error);
        socket.emit('error', { message: 'Failed to update location' });
      }
    });

    // Passenger joins schedule room to receive location updates
    socket.on('passenger:joinSchedule', async (data) => {
      try {
        const { scheduleId, ticketId } = data;
        console.log(`👤 Passenger ${socket.userId} attempting to track schedule ${scheduleId}`);

        // Verify passenger has a confirmed ticket for this schedule
        const client = await pool.connect();
        const result = await client.query(
          `SELECT t.*, s.status as schedule_status
           FROM tickets t
           INNER JOIN schedules s ON t.schedule_id = s.id
           WHERE t.id = $1 
             AND t.passenger_id = $2 
             AND t.status IN ('CONFIRMED', 'CHECKED_IN')
             AND t.schedule_id = $3`,
          [ticketId, socket.userId, scheduleId]
        );
        client.release();

        if (result.rows.length === 0) {
          socket.emit('error', { message: 'No valid ticket found for this schedule' });
          return;
        }

        const ticket = result.rows[0];

        // Only allow tracking if schedule is ACTIVE
        if (ticket.schedule_status !== 'in_progress' && ticket.schedule_status !== 'ACTIVE') {
          socket.emit('error', { message: 'Bus is not currently active for tracking' });
          return;
        }

        // Join the schedule room
        socket.join(`schedule:${scheduleId}`);
        socket.currentScheduleId = scheduleId;

        console.log(`✅ Passenger joined schedule room: schedule:${scheduleId}`);

        // Send current location if available
        const locationClient = await pool.connect();
        const locationResult = await locationClient.query(
          `SELECT latitude, longitude, speed, heading, recorded_at
           FROM live_bus_locations
           WHERE schedule_id = $1
           ORDER BY recorded_at DESC
           LIMIT 1`,
          [scheduleId]
        );
        locationClient.release();

        if (locationResult.rows.length > 0) {
          const currentLocation = locationResult.rows[0];
          socket.emit('bus:currentLocation', {
            scheduleId,
            latitude: parseFloat(currentLocation.latitude),
            longitude: parseFloat(currentLocation.longitude),
            speed: currentLocation.speed ? parseFloat(currentLocation.speed) : null,
            heading: currentLocation.heading ? parseFloat(currentLocation.heading) : null,
            timestamp: currentLocation.recorded_at,
          });
        }

        socket.emit('passenger:joinedSchedule', { 
          scheduleId, 
          message: 'Successfully joined tracking',
          hasCurrentLocation: locationResult.rows.length > 0
        });

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

        // Verify schedule belongs to admin's company
        const client = await pool.connect();
        const result = await client.query(
          `SELECT s.*, u.company_id as admin_company_id
           FROM schedules s
           INNER JOIN users u ON u.id = $1
           WHERE s.id = $2`,
          [socket.userId, scheduleId]
        );
        client.release();

        if (result.rows.length === 0) {
          socket.emit('error', { message: 'Schedule not found' });
          return;
        }

        const schedule = result.rows[0];

        // Verify admin's company owns this schedule
        if (schedule.company_id !== schedule.admin_company_id) {
          socket.emit('error', { message: 'Unauthorized: Schedule belongs to different company' });
          return;
        }

        // Join the schedule room
        socket.join(`schedule:${scheduleId}`);
        socket.currentScheduleId = scheduleId;

        console.log(`✅ Company Admin joined schedule room: schedule:${scheduleId}`);

        // Send current location if available
        const locationClient = await pool.connect();
        const locationResult = await locationClient.query(
          `SELECT latitude, longitude, speed, heading, recorded_at
           FROM live_bus_locations
           WHERE schedule_id = $1
           ORDER BY recorded_at DESC
           LIMIT 1`,
          [scheduleId]
        );
        locationClient.release();

        if (locationResult.rows.length > 0) {
          const currentLocation = locationResult.rows[0];
          socket.emit('bus:currentLocation', {
            scheduleId,
            latitude: parseFloat(currentLocation.latitude),
            longitude: parseFloat(currentLocation.longitude),
            speed: currentLocation.speed ? parseFloat(currentLocation.speed) : null,
            heading: currentLocation.heading ? parseFloat(currentLocation.heading) : null,
            timestamp: currentLocation.recorded_at,
          });
        }

        socket.emit('companyAdmin:joinedSchedule', { 
          scheduleId, 
          message: 'Successfully joined tracking',
          hasCurrentLocation: locationResult.rows.length > 0
        });

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

        // Verify schedule exists
        const client = await pool.connect();
        const result = await client.query(
          `SELECT id, status FROM schedules WHERE id = $1`,
          [scheduleId]
        );
        client.release();

        if (result.rows.length === 0) {
          socket.emit('error', { message: 'Schedule not found' });
          return;
        }

        // Join the schedule room (no further authorization needed for super admin)
        socket.join(`schedule:${scheduleId}`);
        socket.currentScheduleId = scheduleId;

        console.log(`✅ Super Admin joined schedule room: schedule:${scheduleId}`);

        // Send current location if available
        const locationClient = await pool.connect();
        const locationResult = await locationClient.query(
          `SELECT latitude, longitude, speed, heading, recorded_at
           FROM live_bus_locations
           WHERE schedule_id = $1
           ORDER BY recorded_at DESC
           LIMIT 1`,
          [scheduleId]
        );
        locationClient.release();

        if (locationResult.rows.length > 0) {
          const currentLocation = locationResult.rows[0];
          socket.emit('bus:currentLocation', {
            scheduleId,
            latitude: parseFloat(currentLocation.latitude),
            longitude: parseFloat(currentLocation.longitude),
            speed: currentLocation.speed ? parseFloat(currentLocation.speed) : null,
            heading: currentLocation.heading ? parseFloat(currentLocation.heading) : null,
            timestamp: currentLocation.recorded_at,
          });
        }

        socket.emit('admin:joinedSchedule', { 
          scheduleId, 
          message: 'Successfully joined tracking',
          hasCurrentLocation: locationResult.rows.length > 0
        });

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
