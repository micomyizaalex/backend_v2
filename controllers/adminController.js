const { Company, Bus, Ticket, User } = require('../models');
const { Sequelize } = require('sequelize');
const pgPool = require('../config/pgPool');
const {
  DEFAULT_PLAN,
  normalizePlan,
  getPlanPermissions,
  defaultNextPaymentDate,
  isPlanUpgrade,
} = require('../utils/subscriptionPlans');

const VALID_USER_ROLES = new Set(['commuter', 'company_admin', 'driver', 'admin']);
const VALID_USER_STATUSES = new Set(['active', 'inactive']);
const VALID_COMPANY_STATUSES = new Set(['active', 'pending', 'suspended', 'rejected']);

const mapAdminUserRow = (row) => ({
  id: row.id,
  name: row.full_name || row.name,
  email: row.email,
  phone: row.phone_number || row.phone || null,
  role: row.role,
  status: row.account_status === 'deleted' ? 'deleted' : (row.is_active ? 'active' : 'inactive'),
  emailVerified: !!row.email_verified,
  registered: row.created_at || null,
  created_at: row.created_at || null,
  companyId: row.company_id || null,
  accountStatus: row.account_status || null,
});

const mapCompanyMemberRow = (row, fallbackPlan) => ({
  id: row.id,
  name: row.full_name || row.name || 'Unknown User',
  email: row.email || '',
  phone: row.phone_number || row.phone || null,
  role: row.role,
  status: row.account_status === 'deleted' ? 'deleted' : (row.is_active ? 'active' : 'inactive'),
  accountStatus: row.account_status || null,
  permissions: row.permissions || getPlanPermissions(fallbackPlan),
  registered: row.created_at || null,
});

const mapAdminCompanyRow = (row) => {
  const plan = normalizePlan(row.plan || row.subscription_plan) || DEFAULT_PLAN;
  const users = Array.isArray(row.users) ? row.users.map((user) => mapCompanyMemberRow(user, plan)) : [];

  return {
    id: row.id,
    company_id: row.id,
    name: row.name,
    email: row.email || '',
    phone: row.phone || '',
    phone_number: row.phone || '',
    status: row.status,
    isApproved: !!row.is_approved,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan,
    subscriptionPlan: plan,
    subscriptionStatus: row.subscription_status || 'inactive',
    nextPayment: row.next_payment || null,
    driverCount: parseInt(row.driver_count, 10) || 0,
    busCount: parseInt(row.bus_count, 10) || 0,
    usersCount: users.length,
    users,
    planPermissions: getPlanPermissions(plan),
  };
};

const buildAdminCompaniesQuery = ({ filter = null, companyId = null } = {}) => {
  const params = [];
  const conditions = [];

  if (filter === 'pending') {
    conditions.push(`c.status = 'pending'`);
  }

  if (companyId) {
    params.push(companyId);
    conditions.push(`c.id = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return {
    text: `
      SELECT
        c.id,
        c.name,
        COALESCE(c.email, owner.email) AS email,
        COALESCE(c.phone, owner.phone_number) AS phone,
        c.status,
        c.is_approved,
        c.owner_id,
        c.created_at,
        c.updated_at,
        c.subscription_status,
        COALESCE(c.plan, '${DEFAULT_PLAN}') AS plan,
        c.next_payment,
        COUNT(DISTINCT u.id) FILTER (WHERE u.role = 'driver') AS driver_count,
        COUNT(DISTINCT b.id) AS bus_count,
        COALESCE(
          JSONB_AGG(
            DISTINCT JSONB_BUILD_OBJECT(
              'id', u.id,
              'full_name', u.full_name,
              'email', u.email,
              'phone_number', u.phone_number,
              'role', u.role,
              'is_active', u.is_active,
              'account_status', u.account_status,
              'permissions', COALESCE(u.permissions, '{}'::jsonb),
              'created_at', u.created_at
            )
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'::jsonb
        ) AS users
      FROM companies c
      LEFT JOIN users owner ON owner.id = c.owner_id
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN buses b ON b.company_id = c.id
      ${whereClause}
      GROUP BY c.id, owner.id
      ORDER BY c.created_at DESC
    `,
    values: params,
  };
};

const parseNextPaymentDate = (value) => {
  if (!value) return defaultNextPaymentDate();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
};

const normalizeCompanyAdminStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'approved') return 'active';
  return normalized;
};

const deriveCompanyStateUpdate = (status) => {
  if (status === 'active') {
    return {
      companyStatus: 'approved',
      isApproved: true,
      subscriptionStatus: 'active',
      userAccountStatus: 'approved',
      userIsActive: true,
      ownerCompanyVerified: true,
    };
  }

  if (status === 'suspended') {
    return {
      companyStatus: 'suspended',
      isApproved: false,
      subscriptionStatus: 'inactive',
      userAccountStatus: 'inactive',
      userIsActive: false,
      ownerCompanyVerified: true,
    };
  }

  if (status === 'rejected') {
    return {
      companyStatus: 'rejected',
      isApproved: false,
      subscriptionStatus: 'inactive',
      userAccountStatus: 'rejected',
      userIsActive: true,
      ownerCompanyVerified: false,
    };
  }

  return {
    companyStatus: 'pending',
    isApproved: false,
    subscriptionStatus: 'pending_approval',
    userAccountStatus: 'pending',
    userIsActive: true,
    ownerCompanyVerified: false,
  };
};

const mapSubscriptionRequestRow = (row) => ({
  id: row.id,
  companyId: row.company_id,
  companyName: row.company_name,
  companyEmail: row.company_email,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name,
  currentPlan: normalizePlan(row.current_plan) || DEFAULT_PLAN,
  requestedPlan: normalizePlan(row.requested_plan) || DEFAULT_PLAN,
  status: row.status,
  notes: row.notes || null,
  reviewedAt: row.reviewed_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  nextPayment: row.next_payment || null,
});

const getCompanyPlanTarget = async (client, companyId) => {
  const companyResult = await client.query(
    `SELECT
       c.id,
       c.name,
       c.status,
       c.is_approved,
       COALESCE(c.plan, $2) AS current_plan,
       owner.company_verified,
       owner.account_status
     FROM companies c
     JOIN users owner ON owner.id = c.owner_id
     WHERE c.id = $1
     FOR UPDATE`,
    [companyId, DEFAULT_PLAN]
  );

  return companyResult.rows[0] || null;
};

const applyCompanyPlanUpdate = async (client, companyId, requestedPlan, nextPayment) => {
  const company = await getCompanyPlanTarget(client, companyId);

  if (!company) {
    throw new Error('Company not found');
  }

  if (!company.company_verified || company.account_status !== 'approved' || company.status !== 'approved' || !company.is_approved) {
    throw new Error('Only verified and approved companies can have an active subscription plan');
  }

  const permissions = JSON.stringify(getPlanPermissions(requestedPlan));

  await client.query(
    `UPDATE companies
     SET plan = $1,
         next_payment = $2,
         subscription_status = 'active',
         updated_at = NOW()
     WHERE id = $3`,
    [requestedPlan, nextPayment, companyId]
  );

  await client.query(
    `UPDATE users
     SET permissions = $1::jsonb,
         updated_at = NOW()
     WHERE company_id = $2`,
    [permissions, companyId]
  );

  const updatedResult = await client.query(buildAdminCompaniesQuery({ companyId }));

  return {
    company,
    updatedCompany: updatedResult.rows[0] ? mapAdminCompanyRow(updatedResult.rows[0]) : null,
  };
};

const toAbsoluteUploadUrl = (req, fileUrl) => {
  if (!fileUrl) return null;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `${req.protocol}://${req.get('host')}${fileUrl}`;
};

// Return admin dashboard stats with growth metrics
const getStats = async (req, res) => {
  try {
    const totalCompanies = await Company.count();
    const activeCompanies = await Company.count({ where: { status: 'approved' } });
    const totalBuses    = await Bus.count();
    const activeBuses   = await Bus.count({ where: { status: 'ACTIVE' } });
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
    const result = await pgPool.query(buildAdminCompaniesQuery({ filter }));
    const mapped = result.rows.map(mapAdminCompanyRow);

    res.json({ companies: mapped });
  } catch (error) {
    console.error('getCompanies error:', error);
    res.status(400).json({ error: error.message });
  }
};

const updateCompanyPlan = async (req, res) => {
  const client = await pgPool.connect();

  try {
    const { companyId } = req.params;
    const requestedPlan = normalizePlan(req.body.plan);
    const nextPayment = parseNextPaymentDate(req.body.nextPayment);

    if (!requestedPlan) {
      return res.status(400).json({ success: false, error: 'Plan must be Starter, Growth, or Enterprise' });
    }

    if (!nextPayment) {
      return res.status(400).json({ success: false, error: 'nextPayment must be a valid date' });
    }

    await client.query('BEGIN');

    const { company, updatedCompany } = await applyCompanyPlanUpdate(client, companyId, requestedPlan, nextPayment);
    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Company plan updated to ${requestedPlan}`,
      company: updatedCompany,
      transition: isPlanUpgrade(company.current_plan, requestedPlan) ? 'upgrade' : (company.current_plan === requestedPlan ? 'unchanged' : 'downgrade'),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('updateCompanyPlan error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
};

const updateCompany = async (req, res) => {
  const client = await pgPool.connect();

  try {
    const { companyId } = req.params;
    const requestedPlan = normalizePlan(req.body.plan);
    const requestedStatus = normalizeCompanyAdminStatus(req.body.status);
    const nextPayment = parseNextPaymentDate(req.body.nextPayment);

    if (!requestedPlan) {
      return res.status(400).json({ success: false, error: 'Plan must be Starter, Growth, or Enterprise' });
    }

    if (!requestedStatus || !VALID_COMPANY_STATUSES.has(requestedStatus)) {
      return res.status(400).json({ success: false, error: 'Status must be active, pending, suspended, or rejected' });
    }

    if (!nextPayment) {
      return res.status(400).json({ success: false, error: 'nextPayment must be a valid date' });
    }

    const stateUpdate = deriveCompanyStateUpdate(requestedStatus);
    const permissions = JSON.stringify(getPlanPermissions(requestedPlan));

    await client.query('BEGIN');

    const companyResult = await client.query(
      `SELECT c.id, c.owner_id
       FROM companies c
       WHERE c.id = $1
       FOR UPDATE`,
      [companyId]
    );

    const company = companyResult.rows[0];
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Company not found' });
    }

    await client.query(
      `UPDATE companies
       SET status = $1,
           is_approved = $2,
           plan = $3,
           next_payment = $4,
           subscription_status = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [
        stateUpdate.companyStatus,
        stateUpdate.isApproved,
        requestedPlan,
        nextPayment,
        stateUpdate.subscriptionStatus,
        companyId,
      ]
    );

    await client.query(
      `UPDATE users
       SET permissions = $1::jsonb,
           is_active = $2,
           account_status = $3,
           updated_at = NOW()
       WHERE company_id = $4`,
      [permissions, stateUpdate.userIsActive, stateUpdate.userAccountStatus, companyId]
    );

    await client.query(
      `UPDATE users
       SET permissions = $1::jsonb,
           is_active = $2,
           account_status = $3,
           company_verified = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [permissions, stateUpdate.userIsActive, stateUpdate.userAccountStatus, stateUpdate.ownerCompanyVerified, company.owner_id]
    );

    const updatedResult = await client.query(buildAdminCompaniesQuery({ companyId }));
    await client.query('COMMIT');

    const updatedCompany = updatedResult.rows[0] ? mapAdminCompanyRow(updatedResult.rows[0]) : null;

    res.json({
      success: true,
      message: 'Company updated successfully',
      company: updatedCompany,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('updateCompany error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
};

// Get all users
const getUsers = async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT
        id,
        full_name,
        email,
        phone_number,
        role,
        is_active,
        email_verified,
        company_id,
        account_status,
        created_at
      FROM users
      ORDER BY created_at DESC NULLS LAST, updated_at DESC
    `);

    const mapped = result.rows.map(mapAdminUserRow);

    res.json({ users: mapped });
  } catch (error) {
    console.error('getUsers error:', error);
    res.status(400).json({ error: error.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, role, status } = req.body;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const normalizedName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedRole = String(role || '').trim();
    const normalizedStatus = String(status || '').trim().toLowerCase();

    if (!normalizedName) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    if (!VALID_USER_ROLES.has(normalizedRole)) {
      return res.status(400).json({ success: false, error: 'Invalid role supplied' });
    }

    if (!VALID_USER_STATUSES.has(normalizedStatus)) {
      return res.status(400).json({ success: false, error: 'Status must be active or inactive' });
    }

    const duplicate = await User.findOne({ where: { email: normalizedEmail } });
    if (duplicate && duplicate.id !== user.id) {
      return res.status(409).json({ success: false, error: 'Email address is already in use' });
    }

    if ((normalizedRole === 'driver' || normalizedRole === 'company_admin') && !user.company_id) {
      return res.status(400).json({ success: false, error: `Cannot assign role ${normalizedRole} without a company` });
    }

    user.full_name = normalizedName;
    user.email = normalizedEmail;
    user.role = normalizedRole;
    user.is_active = normalizedStatus === 'active';

    if (user.account_status === 'deleted') {
      user.account_status = normalizedStatus === 'active' ? 'approved' : 'inactive';
    } else if (normalizedStatus === 'inactive') {
      user.account_status = user.account_status === 'approved' ? 'inactive' : user.account_status;
    } else if (normalizedStatus === 'active' && user.account_status === 'inactive') {
      user.account_status = 'approved';
    }

    await user.save();

    const refreshed = await pgPool.query(
      `SELECT
         id,
         full_name,
         email,
         phone_number,
         role,
         is_active,
         email_verified,
         company_id,
         account_status,
         created_at
       FROM users
       WHERE id = $1`,
      [user.id]
    );

    const updatedUser = refreshed.rows[0] ? mapAdminUserRow(refreshed.rows[0]) : null;

    res.json({
      success: true,
      message: 'User updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    console.error('updateUser error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.userId === userId) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    user.is_active = false;
    user.account_status = 'deleted';
    await user.save();

    res.json({ success: true, message: 'User deleted successfully', userId });
  } catch (error) {
    console.error('deleteUser error:', error);
    res.status(400).json({ success: false, error: error.message });
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

const getSubscriptionRequests = async (req, res) => {
  try {
    const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
    const params = [];
    const conditions = [];

    if (statusFilter !== 'all') {
      params.push(statusFilter);
      conditions.push(`sr.status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pgPool.query(
      `SELECT
         sr.id,
         sr.company_id,
         sr.requested_by,
         sr.current_plan,
         sr.requested_plan,
         sr.status,
         sr.notes,
         sr.reviewed_at,
         sr.created_at,
         sr.updated_at,
         c.name AS company_name,
         COALESCE(c.email, owner.email) AS company_email,
         c.next_payment,
         requester.full_name AS requested_by_name
       FROM subscription_requests sr
       JOIN companies c ON c.id = sr.company_id
       LEFT JOIN users owner ON owner.id = c.owner_id
       LEFT JOIN users requester ON requester.id = sr.requested_by
       ${whereClause}
       ORDER BY sr.created_at DESC`,
      params
    );

    res.json({ requests: result.rows.map(mapSubscriptionRequestRow) });
  } catch (error) {
    console.error('getSubscriptionRequests error:', error);
    res.status(400).json({ error: error.message });
  }
};

const approveSubscriptionRequest = async (req, res) => {
  const client = await pgPool.connect();

  try {
    const { requestId } = req.params;
    const nextPayment = parseNextPaymentDate(req.body.nextPayment);

    if (!nextPayment) {
      return res.status(400).json({ success: false, error: 'nextPayment must be a valid date' });
    }

    await client.query('BEGIN');

    const requestResult = await client.query(
      `SELECT *
       FROM subscription_requests
       WHERE id = $1
       FOR UPDATE`,
      [requestId]
    );

    const request = requestResult.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Subscription request not found' });
    }

    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Only pending requests can be approved' });
    }

    const requestedPlan = normalizePlan(request.requested_plan);
    if (!requestedPlan) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Requested plan is invalid' });
    }

    const { updatedCompany } = await applyCompanyPlanUpdate(client, request.company_id, requestedPlan, nextPayment);

    await client.query(
      `UPDATE subscription_requests
       SET status = 'approved',
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    const latestRequestResult = await client.query(
      `SELECT
         sr.id,
         sr.company_id,
         sr.requested_by,
         sr.current_plan,
         sr.requested_plan,
         sr.status,
         sr.notes,
         sr.reviewed_at,
         sr.created_at,
         sr.updated_at,
         c.name AS company_name,
         COALESCE(c.email, owner.email) AS company_email,
         c.next_payment,
         requester.full_name AS requested_by_name
       FROM subscription_requests sr
       JOIN companies c ON c.id = sr.company_id
       LEFT JOIN users owner ON owner.id = c.owner_id
       LEFT JOIN users requester ON requester.id = sr.requested_by
       WHERE sr.id = $1`,
      [requestId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Subscription request approved for ${requestedPlan}`,
      company: updatedCompany,
      request: mapSubscriptionRequestRow(latestRequestResult.rows[0]),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('approveSubscriptionRequest error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
};

// GET /api/admin/company-verifications
// Lists all companies pending admin review, with submitted documents.
const getCompanyVerifications = async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT
        c.id AS company_id,
        c.name AS company_name,
        COALESCE(c.email, u.email) AS email,
        COALESCE(c.phone, u.phone_number) AS phone_number,
        c.address,
        u.account_status,
        u.company_verified,
        c.rejection_reason,
        MAX(cd.created_at) AS last_document_submitted_at,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', cd.id,
              'document_type', cd.document_type,
              'file_url', cd.file_url,
              'verification_status', cd.verification_status,
              'notes', cd.notes,
              'created_at', cd.created_at
            ) ORDER BY cd.created_at DESC
          ) FILTER (WHERE cd.id IS NOT NULL),
          '[]'::json
        ) AS uploaded_documents
      FROM companies c
      JOIN users u ON u.id = c.owner_id
      JOIN company_documents cd ON cd.company_id = c.id
      WHERE u.company_verified = false
        AND u.account_status IN ('pending', 'rejected')
      GROUP BY c.id, u.id
      ORDER BY MAX(cd.created_at) DESC, c.created_at DESC
    `);

    const companies = result.rows.map((row) => ({
      ...row,
      uploaded_documents: (row.uploaded_documents || []).map((doc) => ({
        ...doc,
        url: toAbsoluteUploadUrl(req, doc.file_url),
      })),
    }));

    res.json({ success: true, companies });
  } catch (err) {
    console.error('getCompanyVerifications error:', err);
    res.status(500).json({ error: 'Failed to fetch pending verifications' });
  }
};

module.exports = {
  getStats,
  getCompanies,
  updateCompany,
  updateCompanyPlan,
  getUsers,
  getBuses,
  getRecentTickets,
  getRevenueData,
  getActivityLogs,
  getSubscriptionRequests,
  approveSubscriptionRequest,
  getCompanyVerifications,
  updateUser,
  deleteUser,
};
