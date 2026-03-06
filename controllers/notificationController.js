// controllers/notificationController.js
const NotificationService = require('../services/notificationService');

// GET /api/notifications — all for logged-in user
const getUserNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const notifications = await NotificationService.getForUser(req.userId, { limit, offset });
    res.json({ data: notifications, meta: { page, limit, count: notifications.length } });
  } catch (err) {
    console.error('getUserNotifications', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/notifications/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const count = await NotificationService.getUnreadCount(req.userId);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// PATCH /api/notifications/:id/read
const markAsRead = async (req, res) => {
  try {
    const n = await NotificationService.markAsRead(req.params.id);
    if (!n) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// PATCH /api/notifications/user/read-all
const markAllAsRead = async (req, res) => {
  try {
    const updatedCount = await NotificationService.markAllAsRead(req.userId);
    res.json({ message: 'All notifications marked as read', updatedCount });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// DELETE /api/notifications/:id
const deleteNotification = async (req, res) => {
  try {
    const ok = await NotificationService.delete(req.params.id);
    if (!ok) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// POST /api/notifications — internal/admin create
const createNotification = async (req, res) => {
  try {
    const { userId, title, message, type } = req.body;
    if (!userId || !title || !message) return res.status(400).json({ message: 'userId, title and message are required' });
    const n = await NotificationService.createNotification(userId, title, message, type || 'system');
    res.status(201).json({ message: 'Notification created', notification: n });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getUserNotifications, getUnreadCount, markAsRead, markAllAsRead, deleteNotification, createNotification };
