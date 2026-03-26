const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { requireRoles } = require('../middleware/authorize');
const {
  updateDriverLocation,
  startTrip,
  endTrip,
  getLiveLocations,
  getTripStatus,
  getScheduleLocation,
  getBookingLocation
} = require('../controllers/liveTrackingController');

// Driver routes - require driver role
router.post('/driver/location', authenticate, requireRoles(['driver']), updateDriverLocation);
router.post('/driver/trip/start', authenticate, requireRoles(['driver']), startTrip);
router.post('/driver/trip/end', authenticate, requireRoles(['driver']), endTrip);
router.get('/driver/trip/status', authenticate, requireRoles(['driver']), getTripStatus);

// Company routes - require company_admin role  
router.get('/company/live-locations', authenticate, requireRoles(['company_admin', 'driver', 'admin']), getLiveLocations);

// Public tracking route - authorization checked in controller based on ticket/role
router.get('/schedule/:scheduleId/location', authenticate, getScheduleLocation);
router.get('/booking/:bookingId/location', authenticate, getBookingLocation);

module.exports = router;
