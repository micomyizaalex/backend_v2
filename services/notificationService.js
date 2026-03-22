// services/notificationService.js
const sequelize = require('../config/database');
const { Notification } = require('../models');
const { User } = require('../models');

sequelize.query(`
  ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS user_role VARCHAR(50),
  ADD COLUMN IF NOT EXISTS link TEXT
`).catch((err) => console.warn('notifications schema init failed:', err.message));

sequelize.query(`
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = 'enum_notifications_type'
        AND e.enumlabel = 'subscription_upgrade_request'
    ) THEN
      RETURN;
    END IF;

    ALTER TYPE enum_notifications_type ADD VALUE 'subscription_upgrade_request';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END $$;
`).catch((err) => console.warn('notifications enum init failed:', err.message));

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
      user_role: extra.userRole || null,
      title,
      message,
      type,
      is_read: false,
      related_id: extra.relatedId || null,
      related_type: extra.relatedType || null,
      data: extra.data || null,
      link: extra.link || null,
    });
  }

  static async createNotificationForRole(userRole, title, message, type = 'system', extra = {}) {
    const recipients = await User.findAll({
      where: { role: userRole, is_active: true },
      attributes: ['id'],
    });

    if (!recipients.length) {
      return [];
    }

    return Promise.all(
      recipients.map((recipient) => NotificationService.createNotification(
        recipient.id,
        title,
        message,
        type,
        {
          ...extra,
          userRole,
        }
      ))
    );
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
