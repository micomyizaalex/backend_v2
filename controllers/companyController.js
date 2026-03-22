const { Company } = require('../models');
const pgPool = require('../config/pgPool');
const NotificationService = require('../services/notificationService');

const ensureAdminRequest = (req, res) => {
  if (req.userRole !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }

  return true;
};

const getVerificationTarget = async (client, companyId) => {
  const result = await client.query(
    `SELECT
       c.id,
       c.name,
       c.owner_id,
       c.status,
       c.rejection_reason,
       c.is_approved,
       u.company_verified,
       u.account_status,
       u.is_active,
       (
         SELECT COUNT(*)::int
         FROM company_documents cd
         WHERE cd.company_id = c.id
       ) AS document_count
     FROM companies c
     JOIN users u ON u.id = c.owner_id
     WHERE c.id = $1
     FOR UPDATE OF c, u`,
    [companyId]
  );

  return result.rows[0] || null;
};

const createVerificationResponse = (company, overrides = {}) => ({
  company_id: company.id,
  company_name: company.name,
  account_status: overrides.account_status || company.account_status,
  company_verified: typeof overrides.company_verified === 'boolean'
    ? overrides.company_verified
    : company.company_verified,
  rejection_reason: overrides.rejection_reason ?? company.rejection_reason ?? null,
});

// Get companies with pending status
const getPendingCompanies = async (req, res) => {
  try {
    const companies = await Company.findAll({ where: { status: 'pending' } });
    res.json(companies);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Approve a company
const approveCompany = async (req, res) => {
  if (!ensureAdminRequest(req, res)) return;

  let client;
  let committed = false;
  try {
    client = await pgPool.connect();
    await client.query('BEGIN');

    const company = await getVerificationTarget(client, req.params.id);
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Company not found' });
    }

    if (company.company_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Only unverified companies can be approved' });
    }

    if (company.document_count < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Company has not submitted verification documents' });
    }

    await client.query(
      `UPDATE companies
       SET status = 'approved',
           is_approved = true,
           approval_date = NOW(),
           approved_by = $2,
           rejection_reason = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [company.id, req.userId]
    );

    await client.query(
      `UPDATE users
       SET is_active = true,
           company_verified = true,
           account_status = 'approved',
           updated_at = NOW()
       WHERE id = $1`,
      [company.owner_id]
    );

    await client.query(
      `UPDATE company_documents
       SET verification_status = 'approved',
           notes = NULL
       WHERE company_id = $1`,
      [company.id]
    );

    await client.query('COMMIT');
    committed = true;

    try {
      await NotificationService.createNotification(
        company.owner_id,
        'Company Approved',
        'Your company has been approved.',
        'company_approved',
        {
          relatedId: company.id,
          relatedType: 'company',
          data: { status: 'approved' },
        }
      );
    } catch (notificationError) {
      console.error('approveCompany notification error:', notificationError);
    }

    res.json({
      success: true,
      message: 'Company approved successfully',
      company: createVerificationResponse(company, {
        account_status: 'approved',
        company_verified: true,
        rejection_reason: null,
      }),
    });
  } catch (error) {
    if (client && !committed) {
      await client.query('ROLLBACK');
    }
    console.error('approveCompany error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client?.release();
  }
};

// Reject a company
const rejectCompany = async (req, res) => {
  if (!ensureAdminRequest(req, res)) return;

  let client;
  let committed = false;
  try {
    const { reason } = req.body;
    client = await pgPool.connect();
    await client.query('BEGIN');

    const company = await getVerificationTarget(client, req.params.id);
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Company not found' });
    }

    if (company.company_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Only unverified companies can be rejected' });
    }

    if (company.document_count < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Company has not submitted verification documents' });
    }

    await client.query(
      `UPDATE companies
       SET status = 'rejected',
           is_approved = false,
           approval_date = NOW(),
           approved_by = $2,
           rejection_reason = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [company.id, req.userId, reason || null]
    );

    await client.query(
      `UPDATE users
       SET is_active = true,
           company_verified = false,
           account_status = 'rejected',
           updated_at = NOW()
       WHERE id = $1`,
      [company.owner_id]
    );

    await client.query(
      `UPDATE company_documents
       SET verification_status = 'rejected',
           notes = COALESCE($2, notes)
       WHERE company_id = $1`,
      [company.id, reason || null]
    );

    await client.query('COMMIT');
    committed = true;

    try {
      await NotificationService.createNotification(
        company.owner_id,
        'Verification Rejected',
        'Your verification was rejected. Please resubmit documents.',
        'system',
        {
          relatedId: company.id,
          relatedType: 'company',
          data: { status: 'rejected', reason: reason || null },
        }
      );
    } catch (notificationError) {
      console.error('rejectCompany notification error:', notificationError);
    }

    res.json({
      success: true,
      message: 'Company rejected successfully',
      company: createVerificationResponse(company, {
        account_status: 'rejected',
        company_verified: false,
        rejection_reason: reason || null,
      }),
    });
  } catch (error) {
    if (client && !committed) {
      await client.query('ROLLBACK');
    }
    console.error('rejectCompany error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client?.release();
  }
};

module.exports = {
  getPendingCompanies,
  approveCompany,
  rejectCompany
};

