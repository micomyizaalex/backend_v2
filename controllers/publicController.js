const { Schedule, Route, Bus, Company, Driver, Location, Ticket } = require('../models');
const { Op } = require('sequelize');
const pool = require('../config/pgPool');
const NotificationService = require('../services/notificationService');

/**
 * PUBLIC CONTROLLER - Schedule Search & Discovery
 * 
 * IMPORTANT: Driver Seat Handling
 * - All seat availability calculations exclude driver seats (is_driver = true)
 * - Only passenger seats (is_driver = false OR NULL) are counted as "available"
 * - Schedules with 0 passenger seats available are filtered out from search results
 * - This prevents showing "1 seat left" when only the driver seat remains
 */
const getLatestRuraPrice = async (fromLocation, toLocation, effectiveDate) => {
  if (!fromLocation || !toLocation) return null;

  const result = await pool.query(
    `
      SELECT price
      FROM rura_routes
      WHERE status = 'active'
        AND LOWER(TRIM(from_location)) = LOWER(TRIM($1))
        AND LOWER(TRIM(to_location)) = LOWER(TRIM($2))
        AND effective_date <= COALESCE($3::date, CURRENT_DATE)
      ORDER BY effective_date DESC, created_at DESC
      LIMIT 1
    `,
    [fromLocation, toLocation, effectiveDate || null]
  );

  if (!result.rows.length) return null;
  return parseFloat(result.rows[0].price);
};

/**
 * Query bus_schedules + rura_routes and return results in the same shape
 * used by the public search endpoints.
 * @param {string|null} fromPattern  SQL ILIKE pattern e.g. '%nyabugogo%', or null for "all"
 * @param {string|null} toPattern    SQL ILIKE pattern e.g. '%musanze%', or null for "all"
 * @param {string|null} travelDate   ISO date string 'YYYY-MM-DD', or null/'' for any date
 */
const searchBusSchedules = async (fromPattern, toPattern, travelDate) => {
  const where = [
    `COALESCE(bs.status, 'scheduled') IN ('scheduled', 'in_progress')`,
    `UPPER(b.status::text) = 'ACTIVE'`,
    `GREATEST(0, bs.capacity - COALESCE(bs.booked_seats, 0)) > 0`,
  ];
  const params = [];

  if (fromPattern) { params.push(fromPattern); where.push(`rr.from_location ILIKE $${params.length}`); }
  if (toPattern)   { params.push(toPattern);   where.push(`rr.to_location   ILIKE $${params.length}`); }
  if (travelDate)  { params.push(travelDate);  where.push(`bs.date::date     = $${params.length}::date`); }

  const query = `
    SELECT
      bs.schedule_id                                             AS id,
      rr.from_location,
      rr.to_location,
      bs.time                                                    AS departure_time,
      bs.date                                                    AS schedule_date,
      rr.price,
      bs.company_id,
      c.name                                                     AS company_name,
      b.plate_number                                             AS bus_plate_number,
      bs.capacity,
      COALESCE(bs.booked_seats, 0)                               AS booked_seats,
      GREATEST(0, bs.capacity - COALESCE(bs.booked_seats, 0))   AS available_seats
    FROM bus_schedules bs
    INNER JOIN rura_routes rr ON rr.id::text = bs.route_id
    INNER JOIN buses       b  ON b.id = bs.bus_id
    LEFT  JOIN companies   c  ON c.id::text = bs.company_id::text
    WHERE ${where.join(' AND ')}
    ORDER BY bs.date ASC, bs.time ASC
  `;

  try {
    const result = await pool.query(query, params);
    return result.rows.map(row => ({
      id: row.id,
      busId: null,
      routeFrom: row.from_location,
      routeTo: row.to_location,
      from_location: row.from_location,
      to_location: row.to_location,
      date: row.schedule_date ? String(row.schedule_date).slice(0, 10) : null,
      schedule_date: row.schedule_date ? String(row.schedule_date).slice(0, 10) : null,
      departureTime: row.departure_time ? String(row.departure_time).slice(0, 5) : null,
      departure_time: row.departure_time ? String(row.departure_time).slice(0, 5) : null,
      arrivalTime: null,
      arrival_time: null,
      price: parseFloat(row.price || 0),
      seatsAvailable: parseInt(row.available_seats, 10),
      availableSeats: parseInt(row.available_seats, 10),
      available_seats: parseInt(row.available_seats, 10),
      totalPassengerSeats: parseInt(row.capacity, 10),
      totalSeats: parseInt(row.capacity, 10),
      bookedSeats: parseInt(row.booked_seats, 10),
      status: 'scheduled',
      companyName: row.company_name || 'N/A',
      company_name: row.company_name || 'N/A',
      busPlateNumber: row.bus_plate_number || 'N/A',
      bus_plate_number: row.bus_plate_number || 'N/A',
      driverName: 'N/A',
      isSharedBus: true,
    }));
  } catch (err) {
    console.warn('searchBusSchedules fallback failed:', err.message);
    return [];
  }
};

// Get all available schedules for public booking
const getAvailableSchedules = async (req, res) => {
  try {
    const { from, to, bus_id: busId } = req.query;

    if (busId) {
      const result = await pool.query(
        `
          SELECT
            bs.schedule_id AS id,
            bs.bus_id,
            bs.route_id,
            bs.date,
            bs.time,
            bs.capacity,
            COALESCE(bs.available_seats, GREATEST(0, bs.capacity - COALESCE(bs.booked_seats, 0))) AS available_seats,
            COALESCE(bs.booked_seats, 0) AS booked_seats,
            COALESCE(bs.status, 'scheduled') AS status,
            rr.from_location,
            rr.to_location,
            b.plate_number,
            b.model,
            b.status AS bus_status
          FROM bus_schedules bs
          INNER JOIN buses b ON b.id = bs.bus_id
          LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
          WHERE bs.bus_id::text = $1::text
          ORDER BY bs.date ASC, bs.time ASC
        `,
        [busId]
      );

      return res.json({
        schedules: result.rows.map((schedule) => ({
          id: schedule.id,
          busId: schedule.bus_id,
          routeName: schedule.from_location && schedule.to_location ? `${schedule.from_location} → ${schedule.to_location}` : 'Unknown Route',
          routeFrom: schedule.from_location || 'N/A',
          routeTo: schedule.to_location || 'N/A',
          departureLocation: schedule.from_location || 'N/A',
          destination: schedule.to_location || 'N/A',
          date: schedule.date,
          tripDate: schedule.date,
          departureTime: schedule.time,
          arrivalTime: null,
          seatsAvailable: parseInt(schedule.available_seats, 10) || 0,
          totalSeats: parseInt(schedule.capacity, 10) || 0,
          seatCapacity: parseInt(schedule.capacity, 10) || 0,
          bookedSeats: parseInt(schedule.booked_seats, 10) || 0,
          status: schedule.status,
          busPlateNumber: schedule.plate_number || 'N/A',
          busName: schedule.model || schedule.plate_number || 'N/A',
          bus: {
            id: schedule.bus_id,
            plateNumber: schedule.plate_number,
            plate_number: schedule.plate_number,
            model: schedule.model,
            capacity: parseInt(schedule.capacity, 10) || 0,
            status: schedule.bus_status,
          },
        })),
      });
    }

    // Build where clause for schedules
    let scheduleWhere = {
      status: 'scheduled'
    };

    // Build include clause with Route
    const includeOptions = [
      {
        model: Route,
        attributes: ['id', 'origin', 'destination'],
        where: {},
        required: false
      },
      {
        model: Bus,
        attributes: ['id','plate_number','status'],
        where: { status: 'ACTIVE' },
        required: true
      }
    ];

    // Add route filtering if provided
    if (from || to) {
      if (from) {
        includeOptions[0].where.origin = {
          [Op.iLike]: `%${from}%`
        };
      }
      if (to) {
        includeOptions[0].where.destination = {
          [Op.iLike]: `%${to}%`
        };
      }
      includeOptions[0].required = true;
    }

    // Get schedules with available seats
    const schedules = await Schedule.findAll({
      where: scheduleWhere,
      include: includeOptions,
      attributes: [
        'id',
        'bus_id',
        'schedule_date',
        'departure_time',
        'arrival_time',
        'price_per_seat',
        'available_seats',
        'booked_seats',
        'status',
        'ticket_status'
      ]
    });

    // Calculate real passenger seat availability for each schedule
    const now = new Date();
    
    // For each schedule, calculate passenger seats excluding driver
    const schedulesWithRealAvailability = await Promise.all(
      schedules.map(async (s) => {
        // Count passenger seats (exclude driver seats)
        const passengerSeatCount = await pool.query(
          `SELECT COUNT(*) as count FROM seats 
           WHERE bus_id = $1 AND (is_driver = false OR is_driver IS NULL)`,
          [s.bus_id]
        );
        const totalPassengerSeats = parseInt(passengerSeatCount.rows[0]?.count || 0);
        
        // Count booked seats for this schedule
        const bookedCount = await pool.query(
          `SELECT COUNT(*) as count FROM tickets 
           WHERE schedule_id = $1 AND status IN ('CONFIRMED', 'CHECKED_IN')`,
          [s.id]
        );
        const bookedSeats = parseInt(bookedCount.rows[0]?.count || 0);
        
        // Calculate real availability
        const realAvailable = totalPassengerSeats - bookedSeats;
        
        return {
          ...s.toJSON(),
          realAvailableSeats: realAvailable,
          totalPassengerSeats: totalPassengerSeats
        };
      })
    );

    const schedulesWithFare = await Promise.all(
      schedulesWithRealAvailability.map(async (schedule) => {
        const ruraPrice = await getLatestRuraPrice(
          schedule.Route?.origin,
          schedule.Route?.destination,
          schedule.schedule_date
        );

        return {
          ...schedule,
          effectivePrice: ruraPrice !== null ? ruraPrice : parseFloat(schedule.price_per_seat || 0)
        };
      })
    );

    const mapped = schedulesWithFare
      .filter(s => s.realAvailableSeats > 0) // Only include schedules with real passenger seats available
      .filter(s => {
        // Exclude schedules where ticket sales are closed or departure time has passed
        if (s.ticket_status === 'CLOSED') return false;
        if (s.departure_time && new Date(s.departure_time) <= now) return false;
        return true;
      })
      .map(s => ({
        id: s.id,
        busId: s.bus_id,
        routeFrom: s.Route?.origin || 'N/A',
        routeTo: s.Route?.destination || 'N/A',
        date: s.schedule_date,
        departureTime: s.departure_time,
        arrivalTime: s.arrival_time,
        price: parseFloat(String(s.effectivePrice ?? s.price_per_seat ?? 0)),
        seatsAvailable: s.realAvailableSeats, // Real passenger seat count
        totalPassengerSeats: s.totalPassengerSeats,
        bookedSeats: s.totalPassengerSeats - s.realAvailableSeats,
        status: s.status,
        ticketStatus: s.ticket_status || 'OPEN',
        ticketReason: (s.ticket_status === 'CLOSED') ? 'manual' : null
      }));

    // Also include schedules from the newer bus_schedules + rura_routes tables
    const busSchedulesMapped = await searchBusSchedules(null, null, null);
    const combined = [...mapped, ...busSchedulesMapped];

    res.json({ schedules: combined });
  } catch (error) {
    console.error('Get schedules error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch schedules' });
  }
};

// Search schedules by route
const searchSchedules = async (req, res) => {
  try {
    const { from, to, date } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'From and to locations are required' });
    }

    const whereClause = {
      status: 'scheduled'
      // Note: available_seats filter removed - will calculate real availability below
    };

    // Add date filter if provided
    if (date) {
      whereClause.schedule_date = date;
    }

    const schedules = await Schedule.findAll({
      where: whereClause,
      include: [
          {
            model: Route,
            attributes: ['id', 'origin', 'destination'],
            required: true,
            where: {
              origin: {
                [Op.iLike]: `%${from}%`
              },
              destination: {
                [Op.iLike]: `%${to}%`
              }
            }
          },
          {
            model: Bus,
            attributes: ['id', 'plate_number', 'company_id', 'driver_id','status'],
            required: false,
            where: { status: 'ACTIVE' },
            include: [
              {
                model: Company,
                attributes: ['id', 'name'],
                required: false
              },
              {
                model: Driver,
                attributes: ['id', 'name'],
                required: false
              }
            ]
          }
        ],
      attributes: [
        'id',
        'bus_id',
        'route_id',
        'schedule_date',
        'departure_time',
        'arrival_time',
        'price_per_seat',
        'available_seats',
        'booked_seats',
        'status',
        'ticket_status'
      ]
    });

    const now = new Date();
    
    // Calculate real passenger seat availability for each schedule
    const schedulesWithRealAvailability = await Promise.all(
      schedules.map(async (s) => {
        // Count passenger seats (exclude driver seats)
        const passengerSeatCount = await pool.query(
          `SELECT COUNT(*) as count FROM seats 
           WHERE bus_id = $1 AND (is_driver = false OR is_driver IS NULL)`,
          [s.bus_id]
        );
        const totalPassengerSeats = parseInt(passengerSeatCount.rows[0]?.count || 0);
        
        // Count booked seats for this schedule
        const bookedCount = await pool.query(
          `SELECT COUNT(*) as count FROM tickets 
           WHERE schedule_id = $1 AND status IN ('CONFIRMED', 'CHECKED_IN')`,
          [s.id]
        );
        const bookedSeats = parseInt(bookedCount.rows[0]?.count || 0);
        
        // Calculate real availability
        const realAvailable = totalPassengerSeats - bookedSeats;
        
        return {
          ...s.toJSON(),
          realAvailableSeats: realAvailable,
          totalPassengerSeats: totalPassengerSeats,
          realBookedSeats: bookedSeats
        };
      })
    );

    const schedulesWithFare = await Promise.all(
      schedulesWithRealAvailability.map(async (schedule) => {
        const ruraPrice = await getLatestRuraPrice(
          schedule.Route?.origin,
          schedule.Route?.destination,
          schedule.schedule_date
        );

        return {
          ...schedule,
          effectivePrice: ruraPrice !== null ? ruraPrice : parseFloat(schedule.price_per_seat || 0)
        };
      })
    );

    const mapped = schedulesWithFare
      .filter(s => s.realAvailableSeats > 0) // Only show schedules with real passenger seats
      .filter(s => {
        if (s.ticket_status === 'CLOSED') return false;
        if (s.departure_time && new Date(s.departure_time) <= now) return false;
        return true;
      })
      .map(s => ({
      id: s.id,
      busId: s.bus_id,
      routeFrom: s.Route?.origin || 'N/A',
      routeTo: s.Route?.destination || 'N/A',
      date: s.schedule_date,
      departureTime: s.departure_time,
      arrivalTime: s.arrival_time,
      price: parseFloat(String(s.effectivePrice ?? s.price_per_seat ?? 0)),
      seatsAvailable: s.realAvailableSeats, // Real passenger seat count
      totalPassengerSeats: s.totalPassengerSeats,
      bookedSeats: s.realBookedSeats,
      status: s.status,
      companyName: s.Bus?.Company?.name || 'N/A',
      busPlateNumber: s.Bus?.plate_number || 'N/A',
      driverName: s.Bus?.Driver?.name || 'No driver assigned',
      driverId: s.Bus?.driver_id || null
    }));

    // Also search the newer bus_schedules + rura_routes tables
    const fromPat = from ? `%${from}%` : null;
    const toPat   = to   ? `%${to}%`   : null;
    const busSchedulesMapped = await searchBusSchedules(fromPat, toPat, date || null);
    const combined = [...mapped, ...busSchedulesMapped];

    res.json({ schedules: combined });
  } catch (error) {
    console.error('Search schedules error:', error);
    res.status(500).json({ error: error.message || 'Failed to search schedules' });
  }
};

// Get locations (bus tracking data)
const getLocations = async (req, res) => {
  try {
    // Get recent locations (last 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    
    const locations = await Location.findAll({
      where: {
        timestamp: {
          [Op.gte]: oneDayAgo
        }
      },
      include: [
        {
          model: Bus,
          attributes: ['id', 'plate_number', 'model'],
          required: false
        },
        {
          model: Driver,
          attributes: ['id', 'name'],
          required: false
        },
        {
          model: Schedule,
          attributes: ['id', 'schedule_date', 'departure_time'],
          required: false
        }
      ],
      order: [['timestamp', 'DESC']],
      limit: 100
    });

    const mapped = locations.map(l => ({
      id: l.id,
      busId: l.bus_id,
      busPlate: l.Bus?.plate_number || 'N/A',
      latitude: parseFloat(l.latitude),
      longitude: parseFloat(l.longitude),
      speed: l.speed ? parseFloat(l.speed) : 0,
      heading: l.heading ? parseFloat(l.heading) : 0,
      timestamp: l.timestamp,
      driverName: l.Driver?.name || 'N/A'
    }));

    res.json({ locations: mapped });
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch locations' });
  }
};

// Get single schedule details and bookability
const getScheduleById = async (req, res) => {
  try {
    const { id } = req.params;
    const schedule = await Schedule.findByPk(id, { include: [Route, Bus] });
    if (!schedule) {
      // Shared schedules can live in bus_schedules where the primary identifier is schedule_id.
      const sharedResult = await pool.query(
        `
          SELECT
            bs.schedule_id,
            bs.bus_id,
            bs.route_id,
            bs.date,
            bs.time,
            bs.capacity,
            COALESCE(bs.booked_seats, 0) AS booked_seats,
            COALESCE(bs.status, 'scheduled') AS status,
            rr.from_location,
            rr.to_location,
            rr.price,
            b.plate_number
          FROM bus_schedules bs
          LEFT JOIN rura_routes rr ON rr.id::text = bs.route_id::text
          LEFT JOIN buses b ON b.id = bs.bus_id
          WHERE bs.schedule_id::text = $1::text
          LIMIT 1
        `,
        [id]
      );

      const shared = sharedResult.rows[0];
      if (!shared) {
        return res.status(404).json({ error: 'Schedule not found' });
      }

      const capacity = parseInt(shared.capacity || 0, 10);
      const bookedSeats = parseInt(shared.booked_seats || 0, 10);
      const availableSeats = Math.max(capacity - bookedSeats, 0);

      return res.json({ schedule: {
        id: shared.schedule_id,
        routeId: shared.route_id,
        busId: shared.bus_id,
        date: shared.date ? String(shared.date).slice(0, 10) : null,
        schedule_date: shared.date ? String(shared.date).slice(0, 10) : null,
        departureTime: shared.time ? String(shared.time).slice(0, 8) : null,
        departure_time: shared.time ? String(shared.time).slice(0, 8) : null,
        arrivalTime: null,
        arrival_time: null,
        price: parseFloat(shared.price || 0),
        availableSeats,
        totalPassengerSeats: capacity,
        bookedSeats,
        status: shared.status,
        bookable: ['scheduled', 'in_progress'].includes(String(shared.status || '').toLowerCase()) && availableSeats > 0,
        routeFrom: shared.from_location || null,
        routeTo: shared.to_location || null,
        route_from: shared.from_location || null,
        route_to: shared.to_location || null,
        busPlate: shared.plate_number || null,
        bus_plate: shared.plate_number || null,
        busCapacity: capacity || null,
      }});
    }
    
    // Calculate real passenger seat availability (exclude driver seats)
    const passengerSeatCount = await pool.query(
      `SELECT COUNT(*) as count FROM seats 
       WHERE bus_id = $1 AND (is_driver = false OR is_driver IS NULL)`,
      [schedule.bus_id]
    );
    const totalPassengerSeats = parseInt(passengerSeatCount.rows[0]?.count || 0);
    
    // Count booked seats for this schedule
    const bookedCount = await pool.query(
      `SELECT COUNT(*) as count FROM tickets 
       WHERE schedule_id = $1 AND status IN ('CONFIRMED', 'CHECKED_IN')`,
      [schedule.id]
    );
    const bookedSeats = parseInt(bookedCount.rows[0]?.count || 0);
    const realAvailable = totalPassengerSeats - bookedSeats;
    
    const now = new Date();
    const ruraPrice = await getLatestRuraPrice(
      schedule.Route?.origin,
      schedule.Route?.destination,
      schedule.schedule_date
    );
    const effectivePrice = ruraPrice !== null ? ruraPrice : parseFloat(schedule.price_per_seat || 0);
    const bookable = schedule.status === 'scheduled' && schedule.ticket_status !== 'CLOSED' && (!(schedule.departure_time) || new Date(schedule.departure_time) > now) && realAvailable > 0;
    
    res.json({ schedule: {
      id: schedule.id,
      routeId: schedule.route_id,
      busId: schedule.bus_id,
      date: schedule.schedule_date,
      departureTime: schedule.departure_time,
      arrivalTime: schedule.arrival_time,
      price: effectivePrice,
      availableSeats: realAvailable, // Real passenger seat availability
      totalPassengerSeats: totalPassengerSeats,
      bookedSeats: bookedSeats,
      status: schedule.status,
      bookable,
      routeFrom: schedule.Route?.origin || null,
      routeTo: schedule.Route?.destination || null,
      busPlate: schedule.Bus?.plate_number || null,
      busCapacity: schedule.Bus?.capacity || null
    }});
  } catch (err) {
    console.error('getScheduleById error', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
};

// Get user tickets (requires authentication)
// Updated to include payment information using pg Pool
const getTickets = async (req, res) => {
  let client;
  
  try {
    const userId = req.userId; // From auth middleware
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    client = await pool.connect();

    // Query to get tickets with payment, schedule, passenger, and bus information
    const query = `
      SELECT 
        t.id,
        t.seat_number,
        t.booking_ref,
        t.price,
        t.status,
        t.booked_at,
        t.created_at,
        t.schedule_id,
        u.full_name as passenger_name,
        u.email as passenger_email,
        u.phone_number,
        p.payment_method,
        p.status as payment_status,
        p.transaction_ref,
        s.departure_time,
        s.arrival_time,
        s.schedule_date,
        r.origin as route_from,
        r.destination as route_to,
        b.plate_number as bus_plate,
        b.model as bus_model
      FROM tickets t
      INNER JOIN users u ON t.passenger_id = u.id
      LEFT JOIN payments p ON t.payment_id = p.id
      INNER JOIN schedules s ON t.schedule_id = s.id
      LEFT JOIN routes r ON s.route_id = r.id
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE t.passenger_id = $1
      ORDER BY t.created_at DESC
    `;

    const result = await client.query(query, [userId]);
    client.release();

    const tickets = result.rows.map(row => ({
      id: row.id,
      // seatNumber kept for compatibility, and `seat` used by frontend
      seatNumber: row.seat_number,
      seat: row.seat_number,
      bookingRef: row.booking_ref,
      // QR code fields - use ticket ID as the scannable code
      qrCode: row.id,
      qrData: row.id, // Driver will scan this ID to check-in
      // price numeric
      price: parseFloat(row.price || 0),
      // original status and a human-friendly label
      status: row.status,
      statusLabel: (row.status || '').toString().toUpperCase() === 'CONFIRMED' ? 'Confirmed' : (row.status || 'N/A'),
      paymentMethod: row.payment_method || 'N/A',
      paymentStatus: row.payment_status || 'N/A',
      transactionRef: row.transaction_ref,
      scanned: row.status === 'CHECKED_IN',
      createdAt: row.created_at || row.booked_at,
      scheduleId: row.schedule_id,
      passengerName: row.passenger_name || 'N/A',
      passengerEmail: row.passenger_email || 'N/A',
      // Provide both backend field names and frontend-friendly aliases
      routeFrom: row.route_from || 'N/A',
      routeTo: row.route_to || 'N/A',
      from: row.route_from || 'N/A',
      to: row.route_to || 'N/A',
      // Date and time fields (frontend expects `date` and `time`)
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      scheduleDate: row.schedule_date,
      date: row.schedule_date,
      time: row.departure_time,
      busPlate: row.bus_plate || 'N/A',
      busModel: row.bus_model || 'N/A',
      bus: row.bus_plate || row.bus_model || 'N/A',
      // Passenger details for display
      name: row.passenger_name || 'N/A',
      email: row.passenger_email || 'N/A',
      phone: row.phone_number || 'N/A'
    }));

    res.json({ tickets });
  } catch (error) {
    if (client) client.release();
    console.error('Get tickets error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch tickets' });
  }
};

/**
 * Search schedules using PostgreSQL Pool with parameterized queries
 * This endpoint uses direct SQL queries (not Sequelize) as required
 * 
 * Accepts 'from' and 'to' as query or body parameters
 * Returns schedules with available_seats > 0 matching the locations
 */
const searchSchedulesPg = async (req, res) => {
  let client;
  let fromLocation = '';
  let toLocation = '';
  let travelDate = '';
  
  try {
    // Extract from, to, and date from query params or body
    const from = req.query.from || (req.body && req.body.from);
    const to = req.query.to || (req.body && req.body.to);
    const date = req.query.date || (req.body && req.body.date);

    // Validate input
    if (!from || !to) {
      return res.status(400).json({ 
        error: 'Please enter both From and To',
        message: 'Both from and to locations are required'
      });
    }

    // Trim whitespace
    fromLocation = from.trim();
    toLocation = to.trim();
    travelDate = date ? date.trim() : '';

    // Check for empty strings after trimming
    if (!fromLocation || !toLocation) {
      return res.status(400).json({ 
        error: 'Please enter both From and To',
        message: 'Both from and to locations cannot be empty'
      });
    }

    // Validate pool is available
    if (!pool) {
      console.error('Pool is not initialized');
      return res.status(500).json({ 
        error: 'Database pool not initialized',
        message: 'Database connection pool is not available. Please check server configuration.'
      });
    }

    // Get a client from the pool
    try {
      client = await pool.connect();
    } catch (poolError) {
      console.error('Pool connection error:', poolError);
      console.error('Pool error details:', {
        code: poolError.code,
        message: poolError.message,
        stack: poolError.stack
      });
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Unable to connect to the database. Please check DATABASE_URL environment variable.',
        detail: poolError.message,
        ...(process.env.NODE_ENV === 'development' && { 
          code: poolError.code,
          hint: 'Make sure DATABASE_URL is set in your .env file'
        })
      });
    }

    // Parameterized SQL query using ILIKE for case-insensitive matching
    // Includes bus plate number, driver name, and travel date
    // Uses schedule.driver_id first, falls back to bus.driver_id if schedule driver is not assigned
    // Calculates REAL passenger seat availability by excluding driver seats
    // Build query dynamically based on whether date is provided
    let query = `
      SELECT 
        s.id,
        r.origin as from_location,
        r.destination as to_location,
        s.departure_time,
        s.schedule_date,
        s.arrival_time,
        COALESCE(
          (
            SELECT rr.price
            FROM rura_routes rr
            WHERE rr.status = 'active'
              AND LOWER(TRIM(rr.from_location)) = LOWER(TRIM(r.origin))
              AND LOWER(TRIM(rr.to_location)) = LOWER(TRIM(r.destination))
              AND rr.effective_date <= COALESCE(s.schedule_date::date, CURRENT_DATE)
            ORDER BY rr.effective_date DESC, rr.created_at DESC
            LIMIT 1
          ),
          s.price_per_seat
        ) as price,
        s.company_id,
        c.name as company_name,
        b.plate_number as bus_plate_number,
        COALESCE(sd.name, bd.name) as driver_name,
        -- Calculate passenger seats (exclude driver seats)
        COALESCE(
          (SELECT COUNT(*) FROM seats 
           WHERE bus_id = s.bus_id 
           AND (is_driver = false OR is_driver IS NULL)),
          0
        ) as total_passenger_seats,
        -- Calculate booked seats for this schedule
        COALESCE(
          (SELECT COUNT(*) FROM tickets 
           WHERE schedule_id = s.id 
           AND status IN ('CONFIRMED', 'CHECKED_IN')),
          0
        ) as booked_seats,
        -- Calculate available passenger seats
        -- Use seats table calculation if available, otherwise fall back to schedules.available_seats
        CASE 
          WHEN (SELECT COUNT(*) FROM seats WHERE bus_id = s.bus_id) > 0 THEN
            COALESCE(
              (SELECT COUNT(*) FROM seats 
               WHERE bus_id = s.bus_id 
               AND (is_driver = false OR is_driver IS NULL)),
              0
            ) - COALESCE(
              (SELECT COUNT(*) FROM tickets 
               WHERE schedule_id = s.id 
               AND status IN ('CONFIRMED', 'CHECKED_IN')),
              0
            )
          ELSE
            s.available_seats
        END as available_seats
      FROM schedules s
      INNER JOIN routes r ON s.route_id = r.id
      LEFT JOIN companies c ON s.company_id = c.id
      LEFT JOIN buses b ON s.bus_id = b.id
      LEFT JOIN drivers sd ON s.driver_id = sd.id
      LEFT JOIN drivers bd ON b.driver_id = bd.id
      WHERE 
        r.origin ILIKE $1
        AND r.destination ILIKE $2
        ${travelDate ? 'AND s.schedule_date = $3' : ''}
        AND s.status IN ('scheduled', 'in_progress')
        -- Only show schedules with at least 1 passenger seat available
        -- Use seats table calculation if available, otherwise fall back to schedules.available_seats
        AND (
          CASE 
            WHEN (SELECT COUNT(*) FROM seats WHERE bus_id = s.bus_id) > 0 THEN
              COALESCE(
                (SELECT COUNT(*) FROM seats 
                 WHERE bus_id = s.bus_id 
                 AND (is_driver = false OR is_driver IS NULL)),
                0
              ) - COALESCE(
                (SELECT COUNT(*) FROM tickets 
                 WHERE schedule_id = s.id 
                 AND status IN ('CONFIRMED', 'CHECKED_IN')),
                0
              )
            ELSE
              s.available_seats
          END
        ) > 0
      ORDER BY s.schedule_date ASC, s.departure_time ASC
    `;

    // Use parameterized query to prevent SQL injection
    // % wildcards for partial matching
    const fromPattern = `%${fromLocation}%`;
    const toPattern = `%${toLocation}%`;
    const queryParams = travelDate ? [fromPattern, toPattern, travelDate] : [fromPattern, toPattern];

    // Log search parameters (for debugging)
    console.log('🔍 Searching schedules:', { from: fromLocation, to: toLocation, date: travelDate || 'any date' });
    console.log('📋 Query filters passenger seats only (excludes driver seats)');

    const result = await client.query(query, queryParams);
    
    console.log(`✅ Found ${result.rows.length} old-table schedules for ${fromLocation} → ${toLocation}`);

    // Format the results from the old schedules table (may be empty)
    const schedules = result.rows.map(row => ({
      id: row.id,
      from_location: row.from_location,
      to_location: row.to_location,
      from: row.from_location, // Alias for frontend compatibility
      to: row.to_location, // Alias for frontend compatibility
      departure_time: row.departure_time,
      departureTime: row.departure_time, // Alias
      arrival_time: row.arrival_time,
      arrivalTime: row.arrival_time, // Alias
      schedule_date: row.schedule_date, // Travel date
      date: row.schedule_date, // Alias
      available_seats: parseInt(row.available_seats, 10), // Passenger seats only
      availableSeats: parseInt(row.available_seats, 10), // Alias
      total_passenger_seats: parseInt(row.total_passenger_seats, 10),
      totalSeats: parseInt(row.total_passenger_seats, 10), // Alias
      booked_seats: parseInt(row.booked_seats || 0, 10),
      price: parseFloat(row.price || 0),
      company_id: row.company_id,
      company_name: row.company_name || 'N/A',
      company: row.company_name || 'N/A', // Alias
      bus_plate_number: row.bus_plate_number || 'N/A',
      driver_name: row.driver_name || 'No driver assigned'
    }));

    // Also search the newer bus_schedules + rura_routes tables
    const busSchedulesMapped = await searchBusSchedules(
      fromLocation ? `%${fromLocation}%` : null,
      toLocation   ? `%${toLocation}%`   : null,
      travelDate   || null
    );
    const combined = [...schedules, ...busSchedulesMapped];

    res.json({
      schedules: combined,
      count: combined.length
    });

  } catch (error) {
    console.error('Database search error:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      detail: error.detail,
      hint: error.hint,
      from: fromLocation,
      to: toLocation,
      date: travelDate || 'any date'
    });
    
    // Handle database-specific errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Unable to connect to the database. Please try again later.'
      });
    }

    if (error.code === '42P01') {
      // Table doesn't exist
      return res.status(500).json({ 
        error: 'Database schema error',
        message: 'The schedules table or required columns may not exist. Please check the database schema.',
        detail: error.detail
      });
    }

    if (error.code === '42703') {
      // Column doesn't exist
      return res.status(500).json({ 
        error: 'Database schema error',
        message: 'A required column does not exist in the database. Please check the database schema.',
        detail: error.detail
      });
    }

    // Generic error response - ensure we always send a response
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to search schedules',
        message: error.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV === 'development' && { 
          detail: error.detail,
          code: error.code,
          stack: error.stack
        })
      });
    } else {
      // If headers already sent, log the error
      console.error('Response already sent, cannot send error response');
    }
  } finally {
    // Always release the client back to the pool
    if (client) {
      client.release();
    }
  }
};

/**
 * Test database connection endpoint (for debugging)
 */
const testDbConnection = async (req, res) => {
  let client;
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Pool not initialized' });
    }
    
    client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    client.release();
    
    res.json({
      success: true,
      message: 'Database connection successful',
      time: result.rows[0].current_time,
      version: result.rows[0].pg_version
    });
  } catch (error) {
    if (client) client.release();
    console.error('DB connection test error:', error);
    res.status(500).json({
      success: false,
      error: 'Database connection failed',
      message: error.message,
      code: error.code
    });
  }
};

/**
 * Get a single ticket by ID with full details
 * Only the ticket owner can view their ticket
 */
const getTicketById = async (req, res) => {
  let client;
  
  try {
    const userId = req.userId;
    const { ticketId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!ticketId) {
      return res.status(400).json({ error: 'Ticket ID is required' });
    }

    client = await pool.connect();

    // Query to get full ticket details with all joins
    const query = `
      SELECT 
        t.id,
        t.seat_number,
        t.booking_ref,
        t.price,
        t.status,
        t.booked_at,
        t.checked_in_at,
        t.created_at,
        t.schedule_id,
        u.id as passenger_id,
        u.full_name as passenger_name,
        u.email as passenger_email,
        u.phone_number as passenger_phone,
        p.payment_method,
        p.status as payment_status,
        p.transaction_ref,
        s.departure_time,
        s.arrival_time,
        s.schedule_date,
        r.origin as route_from,
        r.destination as route_to,
        b.plate_number as bus_plate,
        b.model as bus_model,
        c.name as company_name
      FROM tickets t
      INNER JOIN users u ON t.passenger_id = u.id
      LEFT JOIN payments p ON t.payment_id = p.id
      INNER JOIN schedules s ON t.schedule_id = s.id
      LEFT JOIN routes r ON s.route_id = r.id
      LEFT JOIN buses b ON s.bus_id = b.id
      LEFT JOIN companies c ON t.company_id = c.id
      WHERE t.id = $1 AND t.passenger_id = $2
    `;

    const result = await client.query(query, [ticketId, userId]);
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Ticket not found',
        message: 'Ticket not found or you do not have permission to view it'
      });
    }

    const row = result.rows[0];
    const ticket = {
      id: row.id,
      ticketId: row.id,
      seatNumber: row.seat_number,
      seat: row.seat_number,
      bookingRef: row.booking_ref,
      // QR code fields for scanning
      qrCode: row.id,
      qrData: row.id,
      price: parseFloat(row.price || 0),
      status: row.status,
      paymentMethod: row.payment_method || null,
      paymentStatus: row.payment_status || null,
      transactionRef: row.transaction_ref || null,
      scanned: !!row.checked_in_at,
      checkedInAt: row.checked_in_at,
      bookedAt: row.booked_at || row.created_at,
      createdAt: row.created_at,
      scheduleId: row.schedule_id,
      passengerId: row.passenger_id,
      passengerName: row.passenger_name,
      passengerEmail: row.passenger_email,
      passengerPhone: row.passenger_phone,
      name: row.passenger_name,
      email: row.passenger_email,
      phone: row.passenger_phone,
      routeFrom: row.route_from,
      routeTo: row.route_to,
      from: row.route_from,
      to: row.route_to,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      scheduleDate: row.schedule_date,
      travelDate: row.schedule_date,
      date: row.schedule_date,
      time: row.departure_time,
      busPlate: row.bus_plate,
      busPlateNumber: row.bus_plate,
      busModel: row.bus_model,
      bus: row.bus_plate || row.bus_model || 'N/A',
      companyName: row.company_name
    };

    res.json({ ticket });
  } catch (error) {
    if (client) client.release();
    console.error('Get ticket by ID error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch ticket' });
  }
};

/**
 * Scan ticket by QR code (for inspectors/drivers)
 * Can be accessed without authentication for scanning purposes
 * Returns full ticket details
 */
const scanTicket = async (req, res) => {
  let client;
  
  try {
    const { ticketId } = req.params;

    if (!ticketId) {
      return res.status(400).json({ error: 'Ticket ID is required' });
    }

    client = await pool.connect();

    // Query to get full ticket details for scanning
    const query = `
      SELECT 
        t.id,
        t.seat_number,
        t.booking_ref,
        t.price,
        t.status,
        t.booked_at,
        t.checked_in_at,
        t.created_at,
        t.schedule_id,
        u.id as passenger_id,
        u.full_name as passenger_name,
        u.email as passenger_email,
        u.phone_number as passenger_phone,
        p.payment_method,
        p.status as payment_status,
        p.transaction_ref,
        s.departure_time,
        s.arrival_time,
        s.schedule_date,
        r.origin as route_from,
        r.destination as route_to,
        b.plate_number as bus_plate,
        b.model as bus_model,
        c.name as company_name
      FROM tickets t
      INNER JOIN users u ON t.passenger_id = u.id
      LEFT JOIN payments p ON t.payment_id = p.id
      INNER JOIN schedules s ON t.schedule_id = s.id
      LEFT JOIN routes r ON s.route_id = r.id
      LEFT JOIN buses b ON s.bus_id = b.id
      LEFT JOIN companies c ON t.company_id = c.id
      WHERE t.id = $1 OR t.booking_ref = $1
    `;

    const result = await client.query(query, [ticketId]);
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Ticket not found',
        message: 'Invalid ticket ID or booking reference'
      });
    }

    const row = result.rows[0];
    const ticket = {
      id: row.id,
      ticketId: row.id,
      seatNumber: row.seat_number,
      bookingRef: row.booking_ref,
      price: parseFloat(row.price || 0),
      status: row.status,
      paymentMethod: row.payment_method || null,
      paymentStatus: row.payment_status || null,
      transactionRef: row.transaction_ref || null,
      scanned: !!row.checked_in_at,
      checkedInAt: row.checked_in_at,
      bookedAt: row.booked_at || row.created_at,
      createdAt: row.created_at,
      scheduleId: row.schedule_id,
      passengerId: row.passenger_id,
      passengerName: row.passenger_name,
      passengerEmail: row.passenger_email,
      passengerPhone: row.passenger_phone,
      routeFrom: row.route_from,
      routeTo: row.route_to,
      departureTime: row.departure_time,
      arrivalTime: row.arrival_time,
      scheduleDate: row.schedule_date,
      travelDate: row.schedule_date,
      busPlate: row.bus_plate,
      busPlateNumber: row.bus_plate,
      busModel: row.bus_model,
      companyName: row.company_name,
      isValid: row.status === 'CONFIRMED' || row.status === 'CHECKED_IN',
      isUsed: row.status === 'CHECKED_IN'
    };

    res.json({ ticket });
  } catch (error) {
    if (client) client.release();
    console.error('Scan ticket error:', error);
    res.status(500).json({ error: error.message || 'Failed to scan ticket' });
  }
};

// Cancel a ticket (user canceling their own ticket)
const cancelTicket = async (req, res) => {
  const { ticketId } = req.params;
  const userId = req.user?.id || req.userId;

  if (!userId) {
    return res.status(401).json({ 
      success: false,
      error: 'Unauthorized',
      message: 'User not authenticated'
    });
  }

  let client;
  try {
    client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Fetch ticket with trip details from either schedules or bus_schedules
      const ticketQuery = `
        SELECT t.*,
               COALESCE(
                 s.departure_time::text,
                 bs.time::text,
                 NULLIF(to_jsonb(t)->>'departure_time', ''),
                 NULLIF(to_jsonb(t)->>'trip_time', '')
               ) AS departure_time,
               COALESCE(
                 s.schedule_date::date,
                 bs.date::date,
                 CASE
                   WHEN NULLIF(to_jsonb(t)->>'trip_date', '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                   THEN (to_jsonb(t)->>'trip_date')::date
                   ELSE NULL
                 END,
                 CASE
                   WHEN NULLIF(to_jsonb(t)->>'schedule_date', '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                   THEN (to_jsonb(t)->>'schedule_date')::date
                   ELSE NULL
                 END
               ) AS schedule_date,
               s.available_seats,
               s.booked_seats,
               t.status as previous_status
        FROM tickets t
        LEFT JOIN schedules s ON t.schedule_id = s.id
        LEFT JOIN bus_schedules bs ON bs.schedule_id::text = t.schedule_id::text
        WHERE (t.id::text = $1 OR t.booking_ref = $1)
          AND t.passenger_id = $2
        LIMIT 1
      `;
      
      const ticketResult = await client.query(ticketQuery, [ticketId, userId]);

      if (ticketResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ 
          success: false,
          error: 'Ticket not found or you do not have permission to cancel this ticket',
          message: 'Ticket not found or you do not have permission to cancel this ticket'
        });
      }

      const ticket = ticketResult.rows[0];
      const resolvedTicketId = ticket.id;
      const previousStatus = ticket.previous_status;

      // Check if ticket is already cancelled or checked in
      if (previousStatus === 'CANCELLED') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ 
          success: false,
          error: 'Ticket is already cancelled',
          message: 'Ticket is already cancelled'
        });
      }

      if (previousStatus === 'CHECKED_IN') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ 
          success: false,
          error: 'Cannot cancel a checked-in ticket',
          message: 'Cannot cancel a checked-in ticket'
        });
      }

      if (String(previousStatus || '').toUpperCase() !== 'CONFIRMED') {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          success: false,
          error: `Only confirmed tickets can be cancelled. Current status: ${previousStatus || 'UNKNOWN'}`,
          message: `Only confirmed tickets can be cancelled. Current status: ${previousStatus || 'UNKNOWN'}`,
        });
      }

      // Check 15-minute cancellation window before departure
      const departureTime = ticket.departure_time;
      const scheduleDate = ticket.schedule_date;
      const now = new Date();
      const normalizedDate = scheduleDate ? String(scheduleDate).slice(0, 10) : '';
      const normalizedTime = departureTime ? String(departureTime).slice(0, 8) : '';

      const departureSource = normalizedDate
        ? `${normalizedDate}T${normalizedTime || '23:59:59'}`
        : departureTime;
      const departure = new Date(departureSource);

      if (!Number.isNaN(departure.getTime())) {
        const timeDiffMinutes = (departure.getTime() - now.getTime()) / (1000 * 60);

        if (timeDiffMinutes < 15) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({ 
            success: false,
            error: 'Ticket cannot be cancelled less than 15 minutes before departure',
            message: 'Ticket cannot be cancelled less than 15 minutes before departure',
            minutesRemaining: Math.round(timeDiffMinutes)
          });
        }
      }

      // Update ticket status to CANCELLED (strict confirmed -> cancelled transition)
      const cancelUpdate = await client.query(
        `UPDATE tickets
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
           AND UPPER(COALESCE(status::text, '')) = 'CONFIRMED'
         RETURNING id`,
        ['CANCELLED', resolvedTicketId]
      );

      if (!cancelUpdate.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(409).json({
          success: false,
          error: 'Ticket status changed before cancellation. Please refresh and try again.',
          message: 'Ticket status changed before cancellation. Please refresh and try again.',
        });
      }

      // Unlock the seat
      const seatNumber = ticket.seat_number;
      await client.query(
        'DELETE FROM seat_locks WHERE schedule_id = $1 AND seat_number = $2',
        [ticket.schedule_id, seatNumber]
      );

      // Update legacy schedules seat counts when ticket belongs to schedules.
      if (typeof ticket.available_seats === 'number' && typeof ticket.booked_seats === 'number') {
        const newAvailableSeats = ticket.available_seats + 1;
        const newBookedSeats = Math.max(ticket.booked_seats - 1, 0);

        await client.query(
          'UPDATE schedules SET available_seats = $1, booked_seats = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [newAvailableSeats, newBookedSeats, ticket.schedule_id]
        );
      }

      await client.query('COMMIT');
      client.release();

      (async () => {
        try {
          await NotificationService.createNotification(
            userId,
            'Ticket Cancelled',
            `Your ticket ${ticket.booking_ref || resolvedTicketId} was cancelled successfully.`,
            'ticket_cancelled',
            { relatedId: resolvedTicketId, relatedType: 'ticket' }
          );
        } catch (notifyErr) {
          console.error('Cancel ticket notification error:', notifyErr.message);
        }
      })();

      res.json({ 
        success: true,
        message: 'Ticket cancelled successfully',
        ticket: {
          id: resolvedTicketId,
          status: 'CANCELLED'
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (client) client.release();
    console.error('Cancel ticket error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to cancel ticket',
      message: error.message || 'Failed to cancel ticket'
    });
  }
};

module.exports = {
  getAvailableSchedules,
  searchSchedules,
  searchSchedulesPg, // New endpoint using pg Pool
  testDbConnection, // Test endpoint
  getLocations,
  getTickets,
  getTicketById, // Get single ticket by ID
  scanTicket, // Scan ticket by QR code
  getScheduleById,
  cancelTicket // Cancel user's own ticket
};
