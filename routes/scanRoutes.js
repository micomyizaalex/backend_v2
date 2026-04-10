const express = require('express');
const router = express.Router();
const { verifyTicket } = require('../controllers/scanController');

router.get('/:ticketId', verifyTicket);

module.exports = router;