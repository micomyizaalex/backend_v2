const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const { requireRoles, requireCompany } = require('../middleware/authorize');
const controller = require('../controllers/companySelfController');
const sharedController = require('../controllers/sharedRouteController');

router.get('/', auth, controller.getCompany);
router.get('/dashboard-stats', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getDashboardStats);
router.get('/active-trips', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getActiveTrips);
router.get('/buses', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getBuses);
router.post('/buses', auth, requireRoles(['company_admin','admin']), requireCompany, controller.createBus);
router.patch('/buses/:id/status', auth, requireRoles(['company_admin','admin']), requireCompany, controller.patchBusStatus);
router.post('/buses/:id/assign-driver', auth, requireRoles(['company_admin','admin']), requireCompany, controller.assignBusDriver);
router.put('/buses/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.updateBus);
router.delete('/buses/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.deleteBus);
router.get('/schedules', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getSchedules);
router.post('/schedules', auth, requireRoles(['company_admin','admin']), requireCompany, controller.createSchedule);
router.put('/schedules/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.updateSchedule);
router.delete('/schedules/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.deleteSchedule);
router.patch('/schedules/:id/reopen', auth, requireRoles(['company_admin','admin']), requireCompany, controller.reopenScheduleTickets);
router.get('/schedules/:id/journals', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getScheduleJournals);
router.get('/tickets', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getTickets);
router.patch('/tickets/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.updateTicket);
router.get('/revenue', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getRevenue);
router.get('/drivers', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getDrivers);
router.get('/drivers/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.getDriver);
router.post('/drivers', auth, requireRoles(['company_admin','admin']), requireCompany, controller.createDriver);
router.put('/drivers/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.updateDriver);
router.delete('/drivers/:id', auth, requireRoles(['company_admin','admin']), requireCompany, controller.deleteDriver);

// Shared-route management (route_stops + bus_schedules + segment-aware booking)
router.get('/shared/routes', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.listSharedRoutes);
router.get('/shared/routes/:routeId/stops', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.getRouteStops);
router.put('/shared/routes/:routeId/stops', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.upsertRouteStops);
router.get('/shared/schedules', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.listSharedSchedules);
router.post('/shared/schedules', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.createSharedSchedule);
router.patch('/shared/schedules/:scheduleId/status', auth, requireRoles(['company_admin','admin']), requireCompany, sharedController.updateSharedScheduleStatus);

module.exports = router;
