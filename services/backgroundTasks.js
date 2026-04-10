const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const paymentController = require('../controllers/paymentController');

let cleanupRunning = false;
let paymentCleanupRunning = false;

const expireSeatLocks = async () => {
  if (cleanupRunning) return;
  cleanupRunning = true;
  
  try {
    const { SeatLock, Ticket } = require('../models');
    const now = new Date();
    
    const [expiredCount, expiredRows] = await SeatLock.update(
      {
        status: 'EXPIRED',
        updated_at: now,
      },
      {
        where: {
          status: 'ACTIVE',
          expires_at: { [Op.lte]: now },
        },
        returning: ['id', 'ticket_id'],
      }
    );

    const expiredTicketIds = (expiredRows || [])
      .map((row) => row.ticket_id)
      .filter(Boolean);

    if (expiredTicketIds.length > 0) {
      await Ticket.update(
        {
          status: 'EXPIRED',
          updated_at: now,
        },
        {
          where: {
            id: { [Op.in]: expiredTicketIds },
            status: 'PENDING_PAYMENT',
          },
        }
      );
    }

    if (expiredCount > 0) {
      console.log(`⏰ Expired ${expiredCount} seat lock(s)`);
    }
  } catch (err) {
    console.error('expireLocks error', err.message || err);
  } finally {
    cleanupRunning = false;
  }
};

const expirePendingPayments = async () => {
  if (paymentCleanupRunning) return;
  paymentCleanupRunning = true;
  
  try {
    const expiredCount = await paymentController.expirePendingPayments();
    if (expiredCount > 0) {
      console.log(`💳 Expired ${expiredCount} pending payment hold(s)`);
    }
  } catch (err) {
    console.error('expirePendingPayments error', err.message || err);
  } finally {
    paymentCleanupRunning = false;
  }
};

const initializeBackgroundTasks = () => {
  // Run immediately
  expireSeatLocks().catch((err) => console.error('Initial expireLocks error', err.message || err));
  expirePendingPayments().catch((err) => console.error('Initial expirePendingPayments error', err.message || err));
  
  // Then every 30 seconds
  setInterval(() => {
    expireSeatLocks().catch((err) => console.error('Scheduled expireLocks error', err.message || err));
  }, 30 * 1000);
  
  setInterval(() => {
    expirePendingPayments().catch((err) => console.error('Scheduled expirePendingPayments error', err.message || err));
  }, 30 * 1000);
  
  console.log('⏰ Background tasks initialized');
};

module.exports = { initializeBackgroundTasks, expireSeatLocks, expirePendingPayments };