const pool = require('../config/pgPool');

// Allowed values for validation
const ALLOWED_STATUS = new Set(['active', 'inactive']);
const ALLOWED_SORT_COLUMNS = {
  from_location: 'from_location',
  to_location: 'to_location',
  price: 'price',
  effective_date: 'effective_date',
  status: 'status',
  created_at: 'created_at'
};

// Helper functions
const normalizeStatus = (value) => (value || '').toString().trim().toLowerCase();

const isPositivePrice = (value) => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0;
};

const hasValidDate = (value) => {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

// Duplicate check query
const duplicateQuery = `
  SELECT id
  FROM rura_routes
  WHERE LOWER(TRIM(from_location)) = LOWER(TRIM($1))
    AND LOWER(TRIM(to_location)) = LOWER(TRIM($2))
    AND effective_date::date = $3::date
    AND status = 'active'
    AND ($4::text IS NULL OR id::text <> $4::text)
  LIMIT 1
`;

/**
 * GET /api/rura_routes
 * List all routes with pagination, sorting, filtering, and search
 */
const listRoutes = async (req, res) => {
  let client;
  try {
    // Pagination parameters (increased default limit to 500 to show all data)
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const offset = (page - 1) * limit;

    // Filter parameters
    const search = (req.query.search || '').toString().trim();
    const fromLocation = (req.query.from_location || '').toString().trim();
    const toLocation = (req.query.to_location || '').toString().trim();
    const status = normalizeStatus(req.query.status);
    const effectiveDate = (req.query.effective_date || '').toString().trim();
    const effectiveFrom = (req.query.effective_from || '').toString().trim();
    const effectiveTo = (req.query.effective_to || '').toString().trim();

    // Sorting parameters
    const sortBy = ALLOWED_SORT_COLUMNS[req.query.sort_by] || 'created_at';
    const sortOrder = (req.query.sort_order || 'desc').toString().toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE clause
    const whereParts = [];
    const params = [];

    // Search across multiple fields
    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`(
        from_location ILIKE $${params.length}
        OR to_location ILIKE $${params.length}
        OR COALESCE(source_document, '') ILIKE $${params.length}
      )`);
    }

    // Filter by from_location (exact match – value comes from dropdown)
    if (fromLocation) {
      params.push(fromLocation);
      whereParts.push(`LOWER(TRIM(from_location)) = LOWER(TRIM($${params.length}))`);
    }

    // Filter by to_location (exact match – value comes from dropdown)
    if (toLocation) {
      params.push(toLocation);
      whereParts.push(`LOWER(TRIM(to_location)) = LOWER(TRIM($${params.length}))`);
    }

    // Filter by status
    if (status && status !== 'all') {
      if (!ALLOWED_STATUS.has(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status filter. Allowed values: active, inactive, all'
        });
      }
      params.push(status);
      whereParts.push(`status = $${params.length}`);
    }

    // Filter by exact effective_date
    if (effectiveDate) {
      if (!hasValidDate(effectiveDate)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid effective_date filter'
        });
      }
      params.push(effectiveDate);
      whereParts.push(`effective_date::date = $${params.length}::date`);
    }

    // Filter by effective_date range (from)
    if (effectiveFrom) {
      if (!hasValidDate(effectiveFrom)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid effective_from filter'
        });
      }
      params.push(effectiveFrom);
      whereParts.push(`effective_date::date >= $${params.length}::date`);
    }

    // Filter by effective_date range (to)
    if (effectiveTo) {
      if (!hasValidDate(effectiveTo)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid effective_to filter'
        });
      }
      params.push(effectiveTo);
      whereParts.push(`effective_date::date <= $${params.length}::date`);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    client = await pool.connect();

    // Count total records
    const countQuery = `SELECT COUNT(*)::int AS total FROM rura_routes ${whereClause}`;
    const countResult = await client.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;

    console.log(`[RURA Routes] Total routes in DB: ${total}, WHERE clause: "${whereClause}", Params:`, params);

    // Add pagination parameters
    params.push(limit);
    params.push(offset);

    // Fetch paginated data
    const listQuery = `
      SELECT
        id,
        from_location,
        to_location,
        price,
        effective_date,
        source_document,
        status,
        created_at
      FROM rura_routes
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}, id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const result = await client.query(listQuery, params);

    res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...row,
        price: Number(row.price)
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1)
      }
    });
  } catch (error) {
    console.error('listRoutes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch routes'
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * POST /api/rura_routes
 * Create a new route
 */
const createRoute = async (req, res) => {
  let client;
  try {
    // Extract and normalize inputs
    const from_location = (req.body.from_location || '').toString().trim();
    const to_location = (req.body.to_location || '').toString().trim();
    const price = req.body.price;
    const effective_date = req.body.effective_date;
    const source_document = (req.body.source_document || '').toString().trim();
    const status = normalizeStatus(req.body.status) || 'active';

    // Validate required fields
    if (!from_location || !to_location || !source_document || !effective_date) {
      return res.status(400).json({
        success: false,
        message: 'from_location, to_location, price, effective_date, and source_document are required'
      });
    }

    // Validate price
    if (!isPositivePrice(price)) {
      return res.status(400).json({
        success: false,
        message: 'Price must be a positive number'
      });
    }

    // Validate effective_date
    if (!hasValidDate(effective_date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid effective_date format'
      });
    }

    // Validate status
    if (!ALLOWED_STATUS.has(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Allowed values: active, inactive'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check for duplicates
    const duplicateResult = await client.query(duplicateQuery, [
      from_location,
      to_location,
      effective_date,
      null
    ]);

    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'A route with the same origin, destination, and effective date already exists'
      });
    }

    // Insert new route
    const insertQuery = `
      INSERT INTO rura_routes (
        from_location,
        to_location,
        price,
        effective_date,
        source_document,
        status,
        created_at
      ) VALUES ($1, $2, $3, $4::date, $5, $6, CURRENT_TIMESTAMP)
      RETURNING id, from_location, to_location, price, effective_date, source_document, status, created_at
    `;

    const insertResult = await client.query(insertQuery, [
      from_location,
      to_location,
      Number(price),
      effective_date,
      source_document,
      status
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Route created successfully',
      data: {
        ...insertResult.rows[0],
        price: Number(insertResult.rows[0].price)
      }
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('createRoute error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create route'
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * PUT /api/rura_routes/:id
 * Update an existing route
 */
const updateRoute = async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const price = req.body.price;
    const effective_date = req.body.effective_date;
    const status = normalizeStatus(req.body.status);

    // Validate route ID
    if (!id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Route ID is required' 
      });
    }

    // Validate price
    if (!isPositivePrice(price)) {
      return res.status(400).json({
        success: false,
        message: 'Price must be a positive number'
      });
    }

    // Validate effective_date
    if (!hasValidDate(effective_date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid effective_date format'
      });
    }

    // Validate status
    if (!ALLOWED_STATUS.has(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Allowed values: active, inactive'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if route exists
    const existingResult = await client.query(
      `SELECT id, from_location, to_location FROM rura_routes WHERE id::text = $1`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Route not found'
      });
    }

    const existing = existingResult.rows[0];

    // Check for duplicates (excluding current route)
    const duplicateResult = await client.query(duplicateQuery, [
      existing.from_location,
      existing.to_location,
      effective_date,
      id
    ]);

    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'A route with the same origin, destination, and effective date already exists'
      });
    }

    // Update route
    const updateQuery = `
      UPDATE rura_routes
      SET
        price = $1,
        effective_date = $2::date,
        status = $3
      WHERE id::text = $4
      RETURNING id, from_location, to_location, price, effective_date, source_document, status, created_at
    `;

    const updateResult = await client.query(updateQuery, [
      Number(price),
      effective_date,
      status,
      id
    ]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Route updated successfully',
      data: {
        ...updateResult.rows[0],
        price: Number(updateResult.rows[0].price)
      }
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('updateRoute error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update route'
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * DELETE /api/rura_routes/:id
 * Soft delete a route (set status to inactive)
 */
const deleteRoute = async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Route ID is required' 
      });
    }

    client = await pool.connect();

    const result = await client.query(
      `UPDATE rura_routes
       SET status = 'inactive'
       WHERE id::text = $1
       RETURNING id, from_location, to_location, price, effective_date, source_document, status, created_at`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Route not found'
      });
    }

    res.json({
      success: true,
      message: 'Route deleted successfully',
      data: {
        ...result.rows[0],
        price: Number(result.rows[0].price)
      }
    });
  } catch (error) {
    console.error('deleteRoute error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete route'
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * GET /api/rura_routes/:id/stops
 * Returns ordered stops for a single route (no company check required — stops are public route metadata)
 */
const getRouteStops = async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, route_id, stop_name, sequence FROM route_stops WHERE route_id::text = $1::text ORDER BY sequence ASC',
      [id]
    );
    res.json({ success: true, stops: result.rows });
  } catch (error) {
    console.error('getRouteStops error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stops' });
  } finally {
    if (client) client.release();
  }
};

/**
 * GET /api/rura_routes/locations
 * Returns DISTINCT from_location and to_location values for dropdown population
 */
const getLocations = async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const [fromResult, toResult] = await Promise.all([
      client.query('SELECT DISTINCT from_location FROM rura_routes ORDER BY from_location'),
      client.query('SELECT DISTINCT to_location FROM rura_routes ORDER BY to_location'),
    ]);
    res.json({
      success: true,
      fromLocations: fromResult.rows.map(r => r.from_location),
      toLocations: toResult.rows.map(r => r.to_location),
    });
  } catch (error) {
    console.error('getLocations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch locations' });
  } finally {
    if (client) client.release();
  }
};

/**
 * GET /api/rura_routes/stats
 * Returns total, active and inactive route counts
 */
const getStats = async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int         AS active,
        COUNT(*) FILTER (WHERE status = 'inactive')::int       AS inactive
      FROM rura_routes
    `);
    res.json({ success: true, ...result.rows[0] });
  } catch (error) {
    console.error('getStats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  listRoutes,
  createRoute,
  updateRoute,
  deleteRoute,
  getLocations,
  getStats,
  getRouteStops,
};
