const express = require('express');
const router = express.Router();

const auth = require('../middleware/authenticate');
const complaintsController = require('../controllers/complaintsController');

router.post('/', auth, complaintsController.createComplaint);
router.get('/user', auth, complaintsController.getUserComplaints);
router.get('/', auth, complaintsController.getComplaints);
router.put('/:id', auth, complaintsController.updateComplaint);
router.post('/:id/reply', auth, complaintsController.addComplaintReply);

module.exports = router;
