const express = require('express');
const router = express.Router();
const seatController = require('../controllers/seatController');
const auth = require('../middleware/authenticate');

// NEW: Get only booked seat numbers (seats with PAID/CONFIRMED tickets)
// IMPORTANT: This must be BEFORE /schedules/:scheduleId to avoid route conflict
router.get('/schedules/:scheduleId/booked-seats', seatController.getBookedSeats);

// Public read access for available seats for a schedule
router.get('/schedules/:scheduleId', seatController.getSeatsForSchedule);

// Lock a seat (requires auth in production - allow public for testing)
router.post('/schedules/:scheduleId/lock', auth, seatController.lockSeat);

// Confirm lock after successful payment
router.post('/locks/:lockId/confirm', auth, seatController.confirmLock);

// Release lock (e.g., timeout or user cancel)
router.post('/locks/:lockId/release', auth, seatController.releaseLock);

// Release lock immediately when payment fails/cancels
router.post('/locks/:lockId/payment-failed', auth, seatController.releaseLockAfterPaymentFailure);

// Directly book a seat (create CONFIRMED ticket + consume any lock) - requires auth
router.post('/schedules/:scheduleId/book', auth, seatController.bookSeat);

// PRODUCTION-READY: Book multiple seats with full concurrency safety
router.post('/book-seats', auth, seatController.bookSeatsWithConcurrencySafety);

module.exports = router;
