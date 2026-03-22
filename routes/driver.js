const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { requireRoles } = require('../middleware/authorize');
const ctrl = require('../controllers/driverController');

// Canonical driver (User) endpoints
router.get('/me', authenticate, requireRoles(['driver']), ctrl.getMe);
router.get('/bus', authenticate, requireRoles(['driver']), ctrl.getAssignedBus);
router.get('/today-schedule', authenticate, requireRoles(['driver']), ctrl.getTodaySchedule);
router.get('/schedules', authenticate, requireRoles(['driver']), ctrl.getDriverSchedules);
router.get('/my-trips', authenticate, requireRoles(['driver']), ctrl.getMyTrips);
router.get('/dashboard', authenticate, requireRoles(['driver']), ctrl.getDashboard);
router.get('/trips/:scheduleId/passengers', authenticate, requireRoles(['driver']), ctrl.getTripPassengers);
router.post('/trip-status', authenticate, requireRoles(['driver']), ctrl.updateTripOperationalStatus);
router.post('/start-trip', authenticate, requireRoles(['driver']), ctrl.startTrip);
router.post('/end-trip', authenticate, requireRoles(['driver']), ctrl.endTrip);
router.post('/location', authenticate, requireRoles(['driver']), ctrl.postLocation);

// Legacy driver endpoints (use Driver table/raw SQL)
router.get('/context', authenticate, requireRoles(['driver']), ctrl.getDriverContext);
router.post('/scan', authenticate, requireRoles(['driver']), ctrl.scanTicket);
router.post('/share-location', authenticate, requireRoles(['driver']), ctrl.shareLocation);

module.exports = router;