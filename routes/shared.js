const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const { requireRoles } = require('../middleware/authorize');
const sharedRouteController = require('../controllers/sharedRouteController');

// Public/shared discovery for commuter booking
router.get('/routes', sharedRouteController.listSharedRoutes);
router.get('/routes/:routeId/stops', sharedRouteController.getRouteStops);
router.get('/schedules/search', sharedRouteController.searchSharedSchedules);

// Company admin: manage stops for a route
router.put(
  '/routes/:routeId/stops',
  auth,
  requireRoles(['admin']),
  sharedRouteController.upsertRouteStops
);

// Authenticated booking
router.post('/tickets/book', auth, sharedRouteController.bookSharedTicket);

module.exports = router;
