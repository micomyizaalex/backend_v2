const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/authenticate');
const { isAdmin } = require('../middleware/authorize');
const companyController = require('../controllers/companyController');
const docController = require('../controllers/companyDocumentController');

// Dashboard stats
router.get('/stats', auth, isAdmin, adminController.getStats);

// Companies list (optional query ?filter=pending)
router.get('/companies', auth, isAdmin, adminController.getCompanies);
router.put('/companies/:companyId', auth, isAdmin, adminController.updateCompany);
router.put('/companies/:companyId/plan', auth, isAdmin, adminController.updateCompanyPlan);
router.get('/subscription-requests', auth, isAdmin, adminController.getSubscriptionRequests);
router.put('/subscription-requests/:requestId/approve', auth, isAdmin, adminController.approveSubscriptionRequest);

// Users list
router.get('/users', auth, isAdmin, adminController.getUsers);
router.put('/users/:userId', auth, isAdmin, adminController.updateUser);
router.delete('/users/:userId', auth, isAdmin, adminController.deleteUser);

// Buses list
router.get('/buses', auth, isAdmin, adminController.getBuses);

// Recent tickets
router.get('/tickets', auth, isAdmin, adminController.getRecentTickets);

// Revenue data (last 6 months)
router.get('/revenue', auth, isAdmin, adminController.getRevenueData);

// Admin approve/reject (proxy to companyController)
router.post('/companies/:id/approve', auth, isAdmin, companyController.approveCompany);
router.post('/companies/:id/reject', auth, isAdmin, companyController.rejectCompany);

// ─── Company verification endpoints ──────────────────────────────────────────
// GET /api/admin/company-verifications  → list pending companies
router.get('/company-verifications', auth, isAdmin, adminController.getCompanyVerifications);

// GET /api/admin/company-verifications/:companyId/documents
router.get('/company-verifications/:companyId/documents', auth, isAdmin, docController.getDocumentsByCompany);

// PUT /api/admin/company-verifications/:companyId/approve
router.put('/company-verifications/:companyId/approve', auth, isAdmin, (req, res, next) => {
  req.params.id = req.params.companyId;
  next();
}, companyController.approveCompany);

// PUT /api/admin/company-verifications/:companyId/reject
router.put('/company-verifications/:companyId/reject', auth, isAdmin, (req, res, next) => {
  req.params.id = req.params.companyId;
  next();
}, companyController.rejectCompany);

// Activity logs
router.get('/activity-logs', auth, isAdmin, adminController.getActivityLogs);

module.exports = router;

