const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require("../middleware/authenticate")

// Public routes
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authController.logout);

// Password reset (public – no auth needed)
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Email verification
router.get('/verify-email', authController.verifyEmail);               // link in email
router.post('/send-verification', auth, authController.sendEmailVerification);
router.post('/resend-verification', authController.resendEmailVerification); // public, no auth needed

// Authenticated routes
router.get('/me', auth, authController.getMe);
router.put('/me', auth, authController.updateProfile);
router.post('/change-password', auth, authController.changePassword);

module.exports = router;
