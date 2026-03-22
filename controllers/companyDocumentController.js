// controllers/companyDocumentController.js
// Handles company verification document submission and retrieval.

const { User } = require('../models');
const pool = require('../config/pgPool');

// Maps multipart field names → logical document_type values stored in DB
const FIELD_TO_TYPE = {
  business_registration: 'business_registration_number',
  tax_id:                'tax_id',
  operating_license:     'operating_license',
  company_logo:          'company_logo',
  office_address_proof:  'office_address',
};

// POST /api/company/documents
// Company uploads verification documents after email verification.
const submitDocuments = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user || !user.company_id) {
      return res.status(403).json({ error: 'No company associated with your account' });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before submitting documents',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    const files = req.files;
    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No documents provided. Please attach at least one file.' });
    }

    const savedDocs = [];

    for (const [fieldName, fileArr] of Object.entries(files)) {
      const file = fileArr[0];
      const documentType = FIELD_TO_TYPE[fieldName] || fieldName;
      const fileUrl = `/uploads/documents/${file.filename}`;

      await pool.query(
        `INSERT INTO company_documents (company_id, document_type, file_url, verification_status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (company_id, document_type)
         DO UPDATE SET file_url = EXCLUDED.file_url,
                       verification_status = 'pending',
                       created_at = NOW()`,
        [user.company_id, documentType, fileUrl]
      );

      savedDocs.push({ documentType, fileUrl });
    }

    await pool.query(
      `UPDATE users
       SET company_verified = false,
           account_status = 'pending',
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    await pool.query(
      `UPDATE companies
       SET status = 'pending',
           is_approved = false,
           rejection_reason = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [user.company_id]
    );

    res.status(201).json({
      message: 'Documents submitted. Waiting for admin review.',
      documents: savedDocs,
    });
  } catch (err) {
    console.error('submitDocuments error:', err);
    res.status(500).json({ error: 'Failed to submit documents' });
  }
};

// GET /api/company/documents
// Returns documents submitted by the authenticated company.
const getMyDocuments = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user || !user.company_id) {
      return res.status(403).json({ error: 'No company associated with your account' });
    }

    const { rows } = await pool.query(
      'SELECT id, document_type, file_url, verification_status, notes, created_at FROM company_documents WHERE company_id = $1 ORDER BY created_at DESC',
      [user.company_id]
    );

    res.json({ documents: rows });
  } catch (err) {
    console.error('getMyDocuments error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
};

// GET /api/admin/company-verifications/:companyId/documents  (admin only)
const getDocumentsByCompany = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { rows } = await pool.query(
      'SELECT id, document_type, file_url, verification_status, notes, created_at FROM company_documents WHERE company_id = $1 ORDER BY created_at DESC',
      [companyId]
    );
    res.json({ documents: rows });
  } catch (err) {
    console.error('getDocumentsByCompany error:', err);
    res.status(500).json({ error: 'Failed to fetch company documents' });
  }
};

module.exports = { submitDocuments, getMyDocuments, getDocumentsByCompany };
