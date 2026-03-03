const { LiveBusLocation, Bus, Driver, Route, Schedule, Company, User } = require('../models');
const { Op } = require('sequelize');
const pool = require('../config/pgPool');

let liveLocationColumnCache = null;

async function getLiveLocationColumnMap(client) {
  if (liveLocationColumnCache) return liveLocationColumnCache;

  const cols = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'live_bus_locations'`
  );

  const set = new Set(cols.rows.map(r => r.column_name));
  liveLocationColumnCache = {
    hasScheduleId: set.has('schedule_id'),
    hasBusId: set.has('bus_id'),
    hasRecordedAt: set.has('recorded_at'),
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
    const { bus_id, latitude, longitude, speed, heading } = req.body;

    // Validate required fields
    if (!bus_id || !latitude || !longitude) {
      return res.status(400).json({ error: 'bus_id, latitude, and longitude are required' });
    }

    // Validate coordinates
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // Find driver by user_id
    const driver = await Driver.findOne({ where: { user_id: userId } });
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    // Verify bus exists and belongs to driver's company
    const bus = await Bus.findByPk(bus_id);
    if (!bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    if (bus.company_id !== driver.company_id) {
      return res.status(403).json({ error: 'Bus does not belong to your company' });
    }

    // UPSERT location (update if exists, insert if not)
    const [location, created] = await LiveBusLocation.upsert({
      bus_id,
      driver_id: driver.id,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      speed: speed ? parseFloat(speed) : 0,
      heading: heading ? parseFloat(heading) : null,
      is_active: true,
      trip_status: 'active',
      updated_at: new Date()
    }, {
      returning: true
    });

    res.json({
      success: true,
      location: {
        id: location.id,
        bus_id: location.bus_id,
        latitude: location.latitude,
        longitude: location.longitude,
        speed: location.speed,
        updated_at: location.updated_at
      },
      message: created ? 'Location tracking started' : 'Location updated'
    });

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
    const { bus_id, latitude, longitude } = req.body;

    if (!bus_id || !latitude || !longitude) {
      return res.status(400).json({ error: 'bus_id, latitude, and longitude are required' });
    }

    const driver = await Driver.findOne({ where: { user_id: userId } });
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const bus = await Bus.findByPk(bus_id);
    if (!bus || bus.company_id !== driver.company_id) {
      return res.status(404).json({ error: 'Bus not found or unauthorized' });
    }

    // Create or update location
    const [location, created] = await LiveBusLocation.upsert({
      bus_id,
      driver_id: driver.id,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      speed: 0,
      is_active: true,
      trip_status: 'active',
      updated_at: new Date()
    }, {
      returning: true
    });

    res.json({
      success: true,
      message: 'Trip started successfully',
      location: {
        id: location.id,
        bus_id: location.bus_id,
        trip_status: location.trip_status
      }
    });

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
    const { bus_id } = req.body;

    if (!bus_id) {
      return res.status(400).json({ error: 'bus_id is required' });
    }

    const driver = await Driver.findOne({ where: { user_id: userId } });
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    // Update location to ended status
    const location = await LiveBusLocation.findOne({ where: { bus_id, driver_id: driver.id } });
    
    if (!location) {
      return res.status(404).json({ error: 'Active trip not found' });
    }

    await location.update({
      is_active: false,
      trip_status: 'ended',
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Trip ended successfully'
    });

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
    
    // Get user's company
    const driver = await Driver.findOne({ where: { user_id: userId } });
    const user = await User.findByPk(userId);
    const companyId = driver?.company_id || user?.company_id;

    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    // Get all active locations for company's buses
    const locations = await LiveBusLocation.findAll({
      where: {
        is_active: true,
        trip_status: 'active'
      },
      include: [
        {
          model: Bus,
          as: 'bus',
          where: { company_id: companyId },
          attributes: ['id', 'plate_number', 'model', 'capacity', 'status']
        },
        {
          model: Driver,
          as: 'driver',
          attributes: ['id', 'name', 'phone', 'license_number']
        }
      ],
      order: [['updated_at', 'DESC']]
    });

    const mapped = locations.map(loc => ({
      id: loc.id,
      bus: {
        id: loc.bus.id,
        plateNumber: loc.bus.plate_number,
        model: loc.bus.model,
        capacity: loc.bus.capacity,
        status: loc.bus.status
      },
      driver: {
        id: loc.driver.id,
        name: loc.driver.name,
        phone: loc.driver.phone
      },
      location: {
        latitude: parseFloat(loc.latitude),
        longitude: parseFloat(loc.longitude),
        speed: parseFloat(loc.speed || 0),
        heading: loc.heading ? parseFloat(loc.heading) : null
      },
      trip_status: loc.trip_status,
      updated_at: loc.updated_at
    }));

    res.json({
      success: true,
      count: mapped.length,
      locations: mapped
    });

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
    
    const driver = await Driver.findOne({ where: { user_id: userId } });
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const activeTrip = await LiveBusLocation.findOne({
      where: {
        driver_id: driver.id,
        is_active: true
      },
      include: [
        {
          model: Bus,
          as: 'bus',
          attributes: ['id', 'plate_number', 'model']
        }
      ]
    });

    if (!activeTrip) {
      return res.json({
        success: true,
        hasActiveTrip: false,
        trip: null
      });
    }

    res.json({
      success: true,
      hasActiveTrip: true,
      trip: {
        id: activeTrip.id,
        bus: {
          id: activeTrip.bus.id,
          plateNumber: activeTrip.bus.plate_number,
          model: activeTrip.bus.model
        },
        trip_status: activeTrip.trip_status,
        started_at: activeTrip.created_at,
        last_update: activeTrip.updated_at
      }
    });

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

    // Verify schedule exists
    const schedule = await Schedule.findByPk(scheduleId, {
      attributes: ['id', 'company_id', 'bus_id', 'status', 'schedule_date', 'departure_time']
    });

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
      const user = await User.findByPk(userId, { attributes: ['company_id'] });
      if (user && user.company_id === schedule.company_id) {
        authorized = true;
      }
    } else if (userRole === 'commuter') {
      // Commuter must have a confirmed ticket for this schedule
      const pool = require('../config/pgPool');
      const client = await pool.connect();
      try {
        const ticketResult = await client.query(
          `SELECT id FROM tickets 
           WHERE schedule_id = $1 
             AND passenger_id = $2 
             AND status IN ('CONFIRMED', 'CHECKED_IN')
           LIMIT 1`,
          [scheduleId, userId]
        );
        if (ticketResult.rows.length > 0) {
          authorized = true;
        }
      } finally {
        client.release();
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Unauthorized: You do not have access to this schedule' });
    }

    // Fetch latest location (supports both schedule-based and bus-based live location schemas)
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

      const whereClauses = [];
      const params = [];

      if (colMap.hasScheduleId) {
        params.push(scheduleId);
        whereClauses.push(`l.schedule_id = $${params.length}`);
      }

      if (colMap.hasBusId && schedule.bus_id) {
        params.push(schedule.bus_id);
        whereClauses.push(`l.bus_id = $${params.length}`);
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
        params.push(scheduleId);
      }

      const locationResult = await client.query(
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

      if (locationResult.rows.length === 0) {
        return res.json({
          success: true,
          hasLocation: false,
          message: 'No location data available yet'
        });
      }

      const location = locationResult.rows[0];
      
      res.json({
        success: true,
        hasLocation: true,
        location: {
          scheduleId: location.schedule_id,
          latitude: parseFloat(location.latitude),
          longitude: parseFloat(location.longitude),
          speed: location.speed ? parseFloat(location.speed) : null,
          heading: location.heading ? parseFloat(location.heading) : null,
          timestamp: location.recorded_at
        }
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
