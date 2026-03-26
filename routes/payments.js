const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const auth = require('../middleware/authenticate');
const { requireCompanyVerified } = require('../middleware/requireVerified');

// All payment routes require authentication
router.post('/booking-hold', auth, paymentController.createBookingHold);
router.post('/demo-confirm', auth, paymentController.demoConfirmPayment);
router.post('/initiate', auth, paymentController.initiatePayment);
router.get('/:paymentId/status', auth, paymentController.getPaymentStatus);
router.post('/:paymentId/cancel', auth, paymentController.cancelPayment);
router.post('/confirm', auth, paymentController.confirmPayment);
router.post('/fail', auth, paymentController.failPayment);
router.post('/book', auth, paymentController.bookTicket);

// Provider callbacks must not require commuter auth.
router.post('/webhook', paymentController.webhook);

// Subscription purchase — requires company to be fully verified first
router.post('/subscribe', auth, requireCompanyVerified, paymentController.initiatePayment);

// MTN Mobile Money payment routes - COMMENTED OUT (functions need to be restored)
// router.post('/mtn/initiate', auth, paymentController.initiateMTNPayment);
// router.get('/mtn/status/:referenceId', auth, paymentController.checkMTNPaymentStatus);
// router.post('/mtn/validate', auth, paymentController.validateMTNPhoneNumber);

module.exports = router;

