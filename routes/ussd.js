/**
 * USSD Routes for SafariTix
 * Handles Africa's Talking USSD integration
 */

const express = require('express');
const router = express.Router();
const ussdController = require('../controllers/ussdController');

/**
 * POST /api/ussd
 * Main USSD endpoint for Africa's Talking
 * 
 * Expected request body:
 * {
 *   sessionId: string,    // Unique session identifier
 *   serviceCode: string,  // USSD code dialed (e.g., *384*123#)
 *   phoneNumber: string,  // User's phone number
 *   text: string          // User input sequence (e.g., "1*2*15")
 * }
 */
router.post('/', ussdController.handleUSSD);

module.exports = router;
