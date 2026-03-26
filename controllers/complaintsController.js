const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize, User, Company } = require('../models');
const NotificationService = require('../services/notificationService');

const VALID_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED']);
const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

sequelize.query(`
  CREATE TABLE IF NOT EXISTS complaints (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    trip_id TEXT,
    category VARCHAR(80) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
    priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`).catch((err) => console.warn('complaints table init failed:', err.message));

sequelize.query(`
  CREATE TABLE IF NOT EXISTS complaint_replies (
    id UUID PRIMARY KEY,
    complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    responder_id UUID REFERENCES users(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`).catch((err) => console.warn('complaint_replies table init failed:', err.message));

sequelize.query(`
  CREATE INDEX IF NOT EXISTS idx_complaints_company_created
  ON complaints(company_id, created_at DESC)
`).catch((err) => console.warn('complaints index init failed:', err.message));

sequelize.query(`
  CREATE INDEX IF NOT EXISTS idx_complaints_user_created
  ON complaints(user_id, created_at DESC)
`).catch((err) => console.warn('complaints user index init failed:', err.message));

const toStatus = (value) => String(value || '').trim().toUpperCase();
const toPriority = (value) => String(value || '').trim().toUpperCase();

async function resolveCompanyIdByUser(userId) {
  const user = await User.findByPk(userId);
  if (!user) return null;
  if (user.company_id) return user.company_id;
  const company = await Company.findOne({ where: { owner_id: userId }, attributes: ['id'] });
  return company?.id || null;
}

async function resolveCompanyIdByTrip(tripId) {
  if (!tripId) return null;
  const rows = await sequelize.query(
    `
      SELECT s.company_id::text AS company_id
      FROM schedules s
      WHERE s.id::text = :tripId
      UNION ALL
      SELECT bs.company_id::text AS company_id
      FROM bus_schedules bs
      WHERE bs.schedule_id::text = :tripId
      LIMIT 1
    `,
    {
      replacements: { tripId: String(tripId) },
      type: QueryTypes.SELECT,
    }
  );

  return rows?.[0]?.company_id || null;
}

async function notifyComplaintUpdate(userId, complaintId, title, message) {
  if (!userId) return;
  try {
    await NotificationService.createNotification(userId, title, message, 'system', {
      relatedId: complaintId,
      relatedType: 'complaint',
      link: '/dashboard/commuter',
      data: { complaintId },
    });
  } catch (err) {
    console.error('Complaint notification failed:', err.message);
  }
}

const createComplaint = async (req, res) => {
  try {
    const userId = req.userId;
    const category = String(req.body.category || '').trim();
    const description = String(req.body.description || '').trim();
    const tripId = req.body.trip_id ? String(req.body.trip_id).trim() : null;

    if (!category) return res.status(400).json({ error: 'category is required' });
    if (!description) return res.status(400).json({ error: 'description is required' });

    const priority = toPriority(req.body.priority || 'MEDIUM');
    if (!VALID_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: 'priority must be LOW, MEDIUM or HIGH' });
    }

    let companyId = req.body.company_id ? String(req.body.company_id).trim() : null;
    if (!companyId && tripId) {
      companyId = await resolveCompanyIdByTrip(tripId);
    }

    const id = crypto.randomUUID();
    await sequelize.query(
      `
        INSERT INTO complaints (
          id, user_id, company_id, trip_id, category, description, status, priority, created_at, updated_at
        ) VALUES (
          :id, :userId, :companyId, :tripId, :category, :description, 'OPEN', :priority, NOW(), NOW()
        )
      `,
      {
        replacements: {
          id,
          userId,
          companyId,
          tripId,
          category,
          description,
          priority,
        },
        type: QueryTypes.INSERT,
      }
    );

    await notifyComplaintUpdate(
      userId,
      id,
      'Complaint Submitted',
      'Your complaint has been received. We will update you soon.'
    );

    const [complaint] = await sequelize.query(
      `
        SELECT
          c.id,
          c.user_id,
          c.company_id,
          c.trip_id,
          c.category,
          c.description,
          c.status,
          c.priority,
          c.created_at,
          c.updated_at,
          COALESCE(u.full_name, u.email, u.phone_number, 'Unknown user') AS user_name,
          co.name AS company_name,
          0::int AS reply_count,
          NULL::text AS latest_reply,
          NULL::timestamp AS latest_reply_at
        FROM complaints c
        LEFT JOIN users u ON u.id = c.user_id
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = :id
      `,
      {
        replacements: { id },
        type: QueryTypes.SELECT,
      }
    );

    res.status(201).json({ success: true, complaint });
  } catch (error) {
    console.error('createComplaint error:', error);
    res.status(500).json({ error: 'Failed to create complaint' });
  }
};

const getComplaints = async (req, res) => {
  try {
    const role = String(req.userRole || '').toLowerCase();
    if (!['admin', 'company_admin', 'company'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const isAdmin = role === 'admin';
    const companyId = isAdmin ? null : await resolveCompanyIdByUser(req.userId);
    if (!isAdmin && !companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const where = [];
    const replacements = {};

    if (isAdmin) {
      if (req.query.company_id) {
        where.push('c.company_id::text = :companyId');
        replacements.companyId = String(req.query.company_id);
      }
    } else {
      where.push('c.company_id::text = :companyId');
      replacements.companyId = String(companyId);
    }

    if (req.query.status) {
      const status = toStatus(req.query.status);
      if (VALID_STATUSES.has(status)) {
        where.push('c.status = :status');
        replacements.status = status;
      }
    }

    if (req.query.start_date) {
      where.push('c.created_at::date >= :startDate');
      replacements.startDate = String(req.query.start_date);
    }

    if (req.query.end_date) {
      where.push('c.created_at::date <= :endDate');
      replacements.endDate = String(req.query.end_date);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const complaints = await sequelize.query(
      `
        SELECT
          c.id,
          c.user_id,
          c.company_id,
          c.trip_id,
          c.category,
          c.description,
          c.status,
          c.priority,
          c.created_at,
          c.updated_at,
          COALESCE(u.full_name, u.email, u.phone_number, 'Unknown user') AS user_name,
          co.name AS company_name,
          (
            SELECT COUNT(*)::int
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
          ) AS reply_count,
          (
            SELECT cr.message
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
            ORDER BY cr.created_at DESC
            LIMIT 1
          ) AS latest_reply,
          (
            SELECT cr.created_at
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
            ORDER BY cr.created_at DESC
            LIMIT 1
          ) AS latest_reply_at
        FROM complaints c
        LEFT JOIN users u ON u.id = c.user_id
        LEFT JOIN companies co ON co.id = c.company_id
        ${whereSql}
        ORDER BY c.created_at DESC
      `,
      {
        replacements,
        type: QueryTypes.SELECT,
      }
    );

    res.json({ success: true, complaints });
  } catch (error) {
    console.error('getComplaints error:', error);
    res.status(500).json({ error: 'Failed to fetch complaints' });
  }
};

const getUserComplaints = async (req, res) => {
  try {
    const complaints = await sequelize.query(
      `
        SELECT
          c.id,
          c.user_id,
          c.company_id,
          c.trip_id,
          c.category,
          c.description,
          c.status,
          c.priority,
          c.created_at,
          c.updated_at,
          co.name AS company_name,
          (
            SELECT COUNT(*)::int
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
          ) AS reply_count,
          (
            SELECT cr.message
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
            ORDER BY cr.created_at DESC
            LIMIT 1
          ) AS latest_reply,
          (
            SELECT cr.created_at
            FROM complaint_replies cr
            WHERE cr.complaint_id = c.id
            ORDER BY cr.created_at DESC
            LIMIT 1
          ) AS latest_reply_at
        FROM complaints c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.user_id = :userId
        ORDER BY c.created_at DESC
      `,
      {
        replacements: { userId: req.userId },
        type: QueryTypes.SELECT,
      }
    );

    res.json({ success: true, complaints });
  } catch (error) {
    console.error('getUserComplaints error:', error);
    res.status(500).json({ error: 'Failed to fetch user complaints' });
  }
};

const updateComplaint = async (req, res) => {
  try {
    const role = String(req.userRole || '').toLowerCase();
    if (!['admin', 'company_admin', 'company'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const complaintId = String(req.params.id);
    const status = req.body.status ? toStatus(req.body.status) : null;
    const priority = req.body.priority ? toPriority(req.body.priority) : null;

    if (!status && !priority) {
      return res.status(400).json({ error: 'Provide status or priority to update' });
    }

    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status must be OPEN, IN_PROGRESS or RESOLVED' });
    }

    if (priority && !VALID_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: 'priority must be LOW, MEDIUM or HIGH' });
    }

    const [existing] = await sequelize.query(
      `SELECT * FROM complaints WHERE id::text = :id LIMIT 1`,
      {
        replacements: { id: complaintId },
        type: QueryTypes.SELECT,
      }
    );

    if (!existing) return res.status(404).json({ error: 'Complaint not found' });

    if (role !== 'admin') {
      const companyId = await resolveCompanyIdByUser(req.userId);
      if (!companyId || String(existing.company_id || '') !== String(companyId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const nextStatus = status || existing.status;
    const nextPriority = priority || existing.priority;

    const [updated] = await sequelize.query(
      `
        UPDATE complaints
        SET status = :status,
            priority = :priority,
            updated_at = NOW()
        WHERE id::text = :id
        RETURNING *
      `,
      {
        replacements: {
          id: complaintId,
          status: nextStatus,
          priority: nextPriority,
        },
        type: QueryTypes.UPDATE,
      }
    );

    if (status && status !== existing.status) {
      await notifyComplaintUpdate(
        existing.user_id,
        complaintId,
        'Complaint Status Updated',
        `Your complaint is now ${status.replace('_', ' ')}.`
      );
    }

    res.json({ success: true, complaint: updated });
  } catch (error) {
    console.error('updateComplaint error:', error);
    res.status(500).json({ error: 'Failed to update complaint' });
  }
};

const addComplaintReply = async (req, res) => {
  try {
    const role = String(req.userRole || '').toLowerCase();
    if (!['admin', 'company_admin', 'company'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const complaintId = String(req.params.id);
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });

    const [complaint] = await sequelize.query(
      `SELECT * FROM complaints WHERE id::text = :id LIMIT 1`,
      {
        replacements: { id: complaintId },
        type: QueryTypes.SELECT,
      }
    );

    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    if (role !== 'admin') {
      const companyId = await resolveCompanyIdByUser(req.userId);
      if (!companyId || String(complaint.company_id || '') !== String(companyId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const replyId = crypto.randomUUID();
    await sequelize.query(
      `
        INSERT INTO complaint_replies (id, complaint_id, responder_id, message, created_at)
        VALUES (:id, :complaintId, :responderId, :message, NOW())
      `,
      {
        replacements: {
          id: replyId,
          complaintId,
          responderId: req.userId,
          message,
        },
        type: QueryTypes.INSERT,
      }
    );

    const [reply] = await sequelize.query(
      `
        SELECT cr.id, cr.complaint_id, cr.responder_id, cr.message, cr.created_at,
               COALESCE(u.full_name, u.email, u.phone_number, 'Support Team') AS responder_name
        FROM complaint_replies cr
        LEFT JOIN users u ON u.id = cr.responder_id
        WHERE cr.id = :replyId
        LIMIT 1
      `,
      {
        replacements: { replyId },
        type: QueryTypes.SELECT,
      }
    );

    await notifyComplaintUpdate(
      complaint.user_id,
      complaintId,
      'New Response to Your Complaint',
      'Support has added a response to your complaint.'
    );

    res.status(201).json({ success: true, reply });
  } catch (error) {
    console.error('addComplaintReply error:', error);
    res.status(500).json({ error: 'Failed to add complaint reply' });
  }
};

module.exports = {
  createComplaint,
  getComplaints,
  getUserComplaints,
  updateComplaint,
  addComplaintReply,
};
