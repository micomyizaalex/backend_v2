/**
 * Simple script to check what schedules exist
 */
require('dotenv').config();
const sequelize = require('./config/database');

async function checkSchedules() {
  try {
    console.log('Checking schedules in database...\n');

    // Check all schedules
    const [allSchedules] = await sequelize.query(`
      SELECT id, schedule_date, departure_time, status, ticket_status, available_seats
      FROM schedules
      LIMIT 5
    `);

    console.log('Sample schedules:');
    console.table(allSchedules);

    // Check current date/time
    const [current] = await sequelize.query(`
      SELECT CURRENT_DATE as today, CURRENT_TIME as now
    `);
    console.log('\nCurrent date/time in database:');
    console.table(current);

    // Count future schedules
    const [futureCount] = await sequelize.query(`
      SELECT COUNT(*) as count
      FROM schedules
      WHERE (schedule_date > CURRENT_DATE OR  
            (schedule_date = CURRENT_DATE AND departure_time > CURRENT_TIME))
        AND ticket_status = 'OPEN'
        AND status = 'scheduled'
    `);
    console.log('\nFuture schedules:', futureCount[0].count);

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await sequelize.close();
  }
}

checkSchedules();
