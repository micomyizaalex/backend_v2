const { Company, Bus, Ticket, User } = require('../models');
const { Sequelize } = require('sequelize');
const pgPool = require('../config/pgPool');

// Return admin dashboard stats with growth metrics
const getStats = async (req, res) => {
  try {
    const totalCompanies = await Company.count();
    const activeCompanies = await Company.count({ where: { status: 'approved' } });
    const totalBuses    = await Bus.count();
    const activeBuses   = await Bus.count({ where: { status: 'active' } });
    const totalTickets  = await Ticket.count();
    const totalUsers = await User.count({ where: { role: 'commuter' } });

    // Total revenue from all tickets
    const revenueResult = await Ticket.findAll({
      attributes: [[Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col('price')), 0), 'total']]
    });
    const totalRevenue = parseFloat(revenueResult[0].get('total')) || 0;

    // Tickets sold today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ticketsToday = await Ticket.count({
      where: {
        created_at: {
          [Sequelize.Op.gte]: today
        }
      }
    });

    res.json({
      totalCompanies,
      activeCompanies,
      totalBuses,
      activeBuses,
      totalTickets,
      totalRevenue,
      totalCommuters: totalUsers,
      ticketsToday,
      // Mock growth percentages (you can calculate real growth from historical data)
      growth: {
        commuters: 12.5,
        companies: 8.3,
        revenue: 23.7,
        buses: 5.2,
        tickets: 15.8
      }
    });
  } catch (error) {
    console.error('getStats error:', error);
    res.status(400).json({ error: error.message });
  }
};

// Return companies list (optionally filter pending)
const getCompanies = async (req, res) => {
  try {
    const { filter } = req.query;
    const conditions = filter === 'pending' ? `WHERE c.status = 'pending'` : '';

    const result = await pgPool.query(`
      SELECT
        c.id, c.name, c.email, c.phone_number AS phone,
        c.status, c.subscription_status, c.subscription_plan,
        c.owner_id, c.created_at, c.updated_at,
        COUNT(DISTINCT u.id) FILTER (WHERE u.role = 'driver') AS driver_count,
        COUNT(DISTINCT b.id) AS bus_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN buses b ON b.company_id = c.id
      ${conditions}
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    const mapped = result.rows.map(c => ({
      id:                 c.id,
      name:               c.name,
      email:              c.email || '',
      phone:              c.phone || '',
      status:             c.status,
      subscriptionStatus: c.subscription_status || 'inactive',
      subscriptionPlan:   c.subscription_plan   || 'Free Trial',
      ownerId:            c.owner_id,
      createdAt:          c.created_at,
      updatedAt:          c.updated_at,
      driverCount:        parseInt(c.driver_count, 10) || 0,
      busCount:           parseInt(c.bus_count,    10) || 0,
    }));

    res.json({ companies: mapped });
  } catch (error) {
    console.error('getCompanies error:', error);
    res.status(400).json({ error: error.message });
  }
};

// Get all users
const getUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'full_name', 'email', 'role', 'is_active', 'email_verified', 'created_at'],
      order: [['created_at', 'DESC']]
    });

    const mapped = users.map(u => ({
      id: u.id,
      name: u.full_name,
      email: u.email,
      role: u.role,
      status: u.is_active ? 'active' : 'suspended',
      emailVerified: u.email_verified,
      registered: u.created_at
    }));

    res.json({ users: mapped });
  } catch (error) {
    console.error('getUsers error:', error);
    res.status(400).json({ error: error.message });
  }
};

// Get all buses with company info
const getBuses = async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT
        b.id, b.plate_number, b.model, b.capacity, b.status,
        b.company_id, b.driver_id, b.created_at,
        c.name  AS company_name,
        u.full_name AS driver_name
      FROM buses b
      LEFT JOIN companies c ON c.id = b.company_id
      LEFT JOIN users     u ON u.id = b.driver_id
      ORDER BY b.created_at DESC
    `);

    const mapped = result.rows.map(b => ({
      id:          b.id,
      plateNumber: b.plate_number,
      model:       b.model,
      capacity:    b.capacity,
      status:      b.status,
      companyId:   b.company_id,
      companyName: b.company_name || 'N/A',
      driverId:    b.driver_id,
      driverName:  b.driver_name || '—',
      createdAt:   b.created_at,
    }));

    res.json({ buses: mapped });
  } catch (error) {
    console.error('getBuses error:', error);
    res.status(400).json({ error: error.message });
  }
};

// Get recent tickets with passenger and route info
const getRecentTickets = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const query = `
      SELECT 
        t.id,
        t.booking_ref,
        t.price,
        t.status,
        t.seat_number,
        t.created_at,
        t.company_id,
        t.from_stop,
        t.to_stop,
        u.full_name  AS passenger_name,
        u.email      AS passenger_email,
        COALESCE(r.origin,      t.from_stop) AS origin,
        COALESCE(r.destination, t.to_stop)   AS destination,
        c.name AS company_name
      FROM tickets t
      LEFT JOIN users     u ON t.passenger_id = u.id
      LEFT JOIN schedules s ON t.schedule_id::text = s.id::text
      LEFT JOIN routes    r ON s.route_id = r.id
      LEFT JOIN companies c ON t.company_id  = c.id
      ORDER BY t.created_at DESC
      LIMIT $1
    `;

    const result = await pgPool.query(query, [limit]);
    
    const mapped = result.rows.map(row => ({
      id: row.id,
      bookingReference: row.booking_ref,
      price: parseFloat(row.price),
      status: row.status,
      seatNumber: row.seat_number,
      passengerName: row.passenger_name || 'N/A',
      passengerEmail: row.passenger_email || '',
      route: `${row.origin || 'N/A'} → ${row.destination || 'N/A'}`,
      companyId: row.company_id,
      companyName: row.company_name || 'N/A',
      date: row.created_at
    }));

    res.json({ tickets: mapped });
  } catch (error) {
    console.error('getRecentTickets error:', error);
    res.status(400).json({ error: error.message });
  }
};

// Get revenue data by month (last 6 months)
const getRevenueData = async (req, res) => {
  try {
    const query = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
        COALESCE(SUM(price), 0) as revenue,
        COUNT(*) as tickets
      FROM tickets
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC
    `;

    const result = await pgPool.query(query);
    
    res.json({ revenueData: result.rows });
  } catch (error) {
    console.error('getRevenueData error:', error);
    res.status(400).json({ error: error.message });
  }
};

// GET /api/admin/activity-logs
const getActivityLogs = async (req, res) => {
  try {
    const page      = Math.max(parseInt(req.query.page,  10) || 1, 1);
    const limit     = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset    = (page - 1) * limit;
    const userId    = req.query.user_id   || null;
    const action    = req.query.action    || null;
    const method    = req.query.method    || null;
    const dateFrom  = req.query.date_from || null;
    const dateTo    = req.query.date_to   || null;

    const conditions = [];
    const params     = [];

    if (userId)   { params.push(userId);                            conditions.push(`al.user_id = $${params.length}`); }
    if (action)   { params.push(`%${action}%`);                     conditions.push(`al.action ILIKE $${params.length}`); }
    if (method)   { params.push(method.toUpperCase());               conditions.push(`al.method = $${params.length}`); }
    if (dateFrom) { params.push(dateFrom);                          conditions.push(`al.created_at >= $${params.length}::date`); }
    if (dateTo)   { params.push(dateTo);                            conditions.push(`al.created_at <  ($${params.length}::date + INTERVAL '1 day')`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);  const limitIdx  = params.length;
    params.push(offset); const offsetIdx = params.length;

    const rows = await pgPool.query(
      `SELECT
         al.id, al.user_id, al.action, al.method, al.path,
         al.status_code, al.ip_address, al.user_agent, al.created_at,
         u.full_name AS user_name, u.email AS user_email, u.role AS user_role
       FROM activity_logs al
       LEFT JOIN users u ON u.id = al.user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const countResult = await pgPool.query(
      `SELECT COUNT(*) FROM activity_logs al ${where}`,
      countParams
    );

    res.json({
      logs:  rows.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
    });
  } catch (error) {
    console.error('getActivityLogs error:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getStats,
  getCompanies,
  getUsers,
  getBuses,
  getRecentTickets,
  getRevenueData,
  getActivityLogs,
};
