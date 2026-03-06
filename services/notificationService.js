// services/notificationService.js
const { Notification } = require('../models');

class NotificationService {

  /**
   * Create a notification.
   * @param {string} userId
   * @param {string} title
   * @param {string} message
   * @param {string} type - 'ticket_booked' | 'ticket_cancelled' | 'schedule_update' | 'payment_received' | 'system' | 'subscription_expiring' | 'company_approved'
   * @param {object} [extra] - optional { relatedId, relatedType, data }
   */
  static async createNotification(userId, title, message, type = 'system', extra = {}) {
    return Notification.create({
      user_id: userId,
      title,
      message,
      type,
      is_read: false,
      related_id: extra.relatedId || null,
      related_type: extra.relatedType || null,
      data: extra.data || null,
    });
  }

  // Legacy polymorphic-style notify (kept for compatibility)
  static async notify({ userId, notifiableId = null, notifiableModelName = null, type = 'system', title = '', message = '', data = null }) {
    return Notification.create({
      user_id: userId,
      type,
      title,
      notifiable_id: notifiableId,
      notifiable_type: notifiableModelName,
      message,
      data,
    });
  }

  static async getForUser(userId, { limit = 30, offset = 0 } = {}) {
    return Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit,
      offset,
    });
  }

  // Keep old name as alias
  static async getForUserWithNotifiable(userId, opts) {
    return NotificationService.getForUser(userId, opts);
  }

  static async getUnreadCount(userId) {
    return Notification.count({ where: { user_id: userId, is_read: false } });
  }

  static async markAsRead(notificationId) {
    const n = await Notification.findByPk(notificationId);
    if (!n) return null;
    n.is_read = true;
    await n.save();
    return n;
  }

  static async markAsUnread(notificationId) {
    const n = await Notification.findByPk(notificationId);
    if (!n) return null;
    n.is_read = false;
    await n.save();
    return n;
  }

  static async markAllAsRead(userId) {
    const [count] = await Notification.update(
      { is_read: true },
      { where: { user_id: userId, is_read: false } }
    );
    return count;
  }

  static async delete(notificationId) {
    const n = await Notification.findByPk(notificationId);
    if (!n) return null;
    await n.destroy();
    return true;
  }
}

module.exports = NotificationService;
