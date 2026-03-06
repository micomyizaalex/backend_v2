const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/authenticate');
const { isAdmin } = require('../middleware/authorize');
const companyController = require('../controllers/companyController');

// Dashboard stats
router.get('/stats', auth, isAdmin, adminController.getStats);

// Companies list (optional query ?filter=pending)
router.get('/companies', auth, isAdmin, adminController.getCompanies);

// Users list
router.get('/users', auth, isAdmin, adminController.getUsers);

// Buses list
router.get('/buses', auth, isAdmin, adminController.getBuses);

// Recent tickets
router.get('/tickets', auth, isAdmin, adminController.getRecentTickets);

// Revenue data (last 6 months)
router.get('/revenue', auth, isAdmin, adminController.getRevenueData);

// Admin approve/reject (proxy to companyController)
router.post('/companies/:id/approve', auth, isAdmin, companyController.approveCompany);
router.post('/companies/:id/reject', auth, isAdmin, companyController.rejectCompany);

// Activity logs
router.get('/activity-logs', auth, isAdmin, adminController.getActivityLogs);

module.exports = router;
