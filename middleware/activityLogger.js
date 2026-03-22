const pool = require('../config/pgPool');

// Ensure the activity_logs table exists (idempotent, runs once at startup)
pool.query(`
  CREATE TABLE IF NOT EXISTS activity_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    action       VARCHAR(255) NOT NULL,
    method       VARCHAR(10),
    path         VARCHAR(500),
    status_code  INT,
    ip_address   VARCHAR(50),
    user_agent   TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).catch((err) => console.warn('activity_logs table init failed:', err.message));

/**
 * Activity logger middleware.
 * Logs every authenticated request to the activity_logs table after the response is sent.
 * Only writes when req.userId is set (i.e. after authenticate middleware).
 * Controllers can set req.customAction = "Human readable label" to override the default action.
 */
const activityLogger = (req, res, next) => {
  res.on('finish', () => {
    const userId = req.userId || null;
    if (!userId) return; // only log authenticated requests

    // Use human-readable label if set by controller, otherwise derive from method + path
    const action = req.customAction
      ? String(req.customAction).slice(0, 255)
      : `${req.method} ${req.route ? req.route.path : req.path}`.slice(0, 255);

    const ipRaw = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const ip    = ipRaw ? String(ipRaw).split(',')[0].trim().slice(0, 50) : null;
    const agent = req.headers['user-agent'] ? req.headers['user-agent'].slice(0, 500) : null;

    pool.query(
      `INSERT INTO activity_logs (user_id, action, method, path, status_code, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, action, req.method, req.originalUrl.slice(0, 500), res.statusCode, ip, agent]
    ).catch((err) => {
      console.warn('activityLogger write failed:', err.message);
    });
  });

  next();
};

module.exports = activityLogger;
