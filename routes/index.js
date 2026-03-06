const express = require('express');
const router = express.Router();
const authRoutes = require('./auth');
const userRoutes = require('./users');
const companyRoutes = require('./companies');
const adminRoutes = require('./admin');
const companySelfRoutes = require('./company');
const notificationRoutes = require('./notifications');
const paymentRoutes = require('./payments');
const driverRoutes = require('./driver');
const busesRoutes = require('./buses');
const seatsRoutes = require('./seats');
const liveTrackingRoutes = require('./liveTracking');
const ussdRoutes = require('./ussd');
const ruraRoutesRoutes = require('./ruraRoutes');
const sharedRoutes = require('./shared');
const sharedRouteController = require('../controllers/sharedRouteController');
const ticketVerificationController = require('../controllers/ticketVerificationController');
const publicController = require('../controllers/publicController');
const auth = require('../middleware/authenticate');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/companies', companyRoutes);
router.use('/admin', adminRoutes);
router.use('/company', companySelfRoutes);
router.use('/notifications', notificationRoutes);
router.use('/payments', paymentRoutes);
router.use('/driver', driverRoutes);
router.use('/buses', busesRoutes);
router.use('/seats', seatsRoutes);
router.use('/tracking', liveTrackingRoutes);
router.use('/ussd', ussdRoutes);
router.use('/rura_routes', ruraRoutesRoutes);
router.use('/shared', sharedRoutes);

// Smart segmented booking APIs (From -> To -> Date)
router.get('/stops', sharedRouteController.getAvailableStops);
router.get('/search-trips', sharedRouteController.searchTrips);
router.get('/available-seats', sharedRouteController.getAvailableSeats);
router.post('/book-ticket', auth, sharedRouteController.bookTicket);
router.get('/my-tickets', auth, sharedRouteController.getUserTickets);

// Ticket verification endpoints (public for QR scanning)
router.get('/tickets/verify/:identifier', ticketVerificationController.verifyTicket);
router.post('/tickets/check-in/:ticketId', auth, ticketVerificationController.checkInTicket);

// Public endpoints (no authentication required)
router.get('/schedules', publicController.getAvailableSchedules);
router.get('/schedules/search', publicController.searchSchedules);
// New search endpoint using pg Pool with parameterized SQL queries (production-ready)
router.get('/schedules/search-pg', publicController.searchSchedulesPg);
router.post('/schedules/search-pg', publicController.searchSchedulesPg);
// Parameterized route must come AFTER specific routes to avoid matching issues
router.get('/schedules/:id', publicController.getScheduleById);
// Test database connection (for debugging)
router.get('/test-db', publicController.testDbConnection);
router.get('/tracking', publicController.getLocations);

// User endpoints (authentication required)
router.get('/tickets', auth, publicController.getTickets);
router.get('/tickets/:ticketId', auth, publicController.getTicketById);
router.patch('/tickets/:ticketId/cancel', auth, publicController.cancelTicket);

// Public ticket scanning (for inspectors/drivers)
router.get('/tickets/scan/:ticketId', publicController.scanTicket);

module.exports = router;
