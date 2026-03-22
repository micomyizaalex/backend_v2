const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notificationController');
const auth = require('../middleware/authenticate');

router.get('/', auth, ctrl.getUserNotifications);
router.get('/unread-count', auth, ctrl.getUnreadCount);
router.post('/', auth, ctrl.createNotification);
router.patch('/user/read-all', auth, ctrl.markAllAsRead);   // must be before /:id
router.patch('/:id/read', auth, ctrl.markAsRead);
router.delete('/:id', auth, ctrl.deleteNotification);

module.exports = router;
