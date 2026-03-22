const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const { requireRoles, requireCompany } = require('../middleware/authorize');
const { requireCompanyVerified } = require('../middleware/requireVerified');
const { requireCompanyPlanFeature } = require('../middleware/requirePlanFeature');
const controller = require('../controllers/companySelfController');
const sharedController = require('../controllers/sharedRouteController');
const docController = require('../controllers/companyDocumentController');
const { uploadDocuments } = require('../middleware/upload');

// Company verification documents (accessible before full approval)
router.post('/documents', auth, requireRoles(['company_admin']), uploadDocuments, docController.submitDocuments);
router.get('/documents', auth, requireRoles(['company_admin']), docController.getMyDocuments);

// Read-only info (accessible while pending)
router.get('/', auth, controller.getCompany);
router.get('/subscription-request', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getSubscriptionRequest);
router.post('/subscription-request', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.createSubscriptionRequest);
router.get('/dashboard-stats', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getDashboardStats);
router.get('/active-trips',    auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getActiveTrips);
router.get('/tickets',         auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getTickets);
router.get('/revenue',         auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyPlanFeature('revenueReports'), controller.getRevenue);

// Settings (allowed while pending so they can update info before approval)
router.put('/settings', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.updateCompany);

// ─── Operations requiring company to be fully verified ────────────────────────

// Buses
router.get('/buses',                  auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getBuses);
router.post('/buses',                 auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.createBus);
router.patch('/buses/:id/status',     auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.patchBusStatus);
router.post('/buses/:id/assign-driver', auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.assignBusDriver);
router.put('/buses/:id',              auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.updateBus);
router.delete('/buses/:id',           auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.deleteBus);

// Schedules
router.get('/schedules',              auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getSchedules);
router.post('/schedules',             auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.createSchedule);
router.put('/schedules/:id',          auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.updateSchedule);
router.delete('/schedules/:id',       auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.deleteSchedule);
router.patch('/schedules/:id/reopen', auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.reopenScheduleTickets);
router.get('/schedules/:id/journals', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getScheduleJournals);
router.patch('/tickets/:id',          auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.updateTicket);

// Drivers
router.get('/drivers',     auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getDrivers);
router.get('/drivers/:id', auth, requireRoles(['company_admin', 'admin']), requireCompany, controller.getDriver);
router.post('/drivers',    auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.createDriver);
router.put('/drivers/:id', auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.updateDriver);
router.delete('/drivers/:id', auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, controller.deleteDriver);

// Shared-route management (requires verification)
router.get('/shared/routes',                         auth, requireRoles(['company_admin', 'admin']), requireCompany, sharedController.listSharedRoutes);
router.get('/shared/routes/:routeId/stops',          auth, requireRoles(['company_admin', 'admin']), requireCompany, sharedController.getRouteStops);
router.put('/shared/routes/:routeId/stops',          auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, sharedController.upsertRouteStops);
router.get('/shared/schedules',                      auth, requireRoles(['company_admin', 'admin']), requireCompany, sharedController.listSharedSchedules);
router.post('/shared/schedules',                     auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyPlanFeature('advancedSchedules'), requireCompanyVerified, sharedController.createSharedSchedule);
router.patch('/shared/schedules/:scheduleId/status', auth, requireRoles(['company_admin', 'admin']), requireCompany, requireCompanyVerified, sharedController.updateSharedScheduleStatus);

module.exports = router;

