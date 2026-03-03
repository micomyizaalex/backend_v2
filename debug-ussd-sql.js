/**
 * Debug script to test USSD SQL queries
 */
require('dotenv').config();
const sequelize = require('./config/database');

async function testQueries() {
  console.log('Testing USSD SQL queries...\n');

  try {
    // Test 1: Get routes with future schedules
    console.log('1. Testing getActiveRoutes query...');
    const routesQuery = `
      SELECT DISTINCT r.id, r.origin, r.destination, r.name
      FROM routes r
      INNER JOIN schedules s ON r.id = s.route_id
      WHERE s.ticket_status = 'OPEN'
        AND s.available_seats > 0
        AND s.status = 'scheduled'
        AND (
          s.schedule_date > CURRENT_DATE 
          OR (
            s.schedule_date = CURRENT_DATE 
            AND s.departure_time > CURRENT_TIME
          )
        )
      ORDER BY r.origin, r.destination
      LIMIT 20
    `;

    const [routes] = await sequelize.query(routesQuery);
    console.log(`✓ Found ${routes.length} routes with future schedules`);
    if (routes.length > 0) {
      console.log('  Sample:', routes[0]);
    }

    if (routes.length === 0) {
      console.log('\n⚠ No routes found. Creating a test schedule...');
      console.log('  Run this SQL to create a future schedule:');
      console.log(`  
  UPDATE schedules 
  SET schedule_date = CURRENT_DATE + 1,
      departure_time = '10:00:00',
      arrival_time = '12:00:00',
      ticket_status = 'OPEN',
      available_seats = 20,
      status = 'scheduled'
  WHERE id = (SELECT id FROM schedules LIMIT 1);
      `);
      return;
    }

    // Test 2: Get schedules for first route
    console.log('\n2. Testing getSchedulesForRoute query...');
    const schedulesQuery = `
      SELECT 
        s.id,
        s.schedule_date,
        s.departure_time,
        s.arrival_time,
        s.price_per_seat,
        s.total_seats,
        s.available_seats,
        s.company_id,
        r.origin,
        r.destination,
        b.plate_number,
        b.make,
        b.capacity,
        (s.total_seats - COALESCE(
          (SELECT COUNT(*) FROM tickets t 
           WHERE t.schedule_id = s.id 
             AND t.status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN')),
          0
        )) as real_available_seats
      FROM schedules s
      INNER JOIN routes r ON s.route_id = r.id
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE s.route_id = $1
        AND s.ticket_status = 'OPEN'
        AND s.available_seats > 0
        AND s.status = 'scheduled'
        AND (
          s.schedule_date > CURRENT_DATE 
          OR (
            s.schedule_date = CURRENT_DATE 
            AND s.departure_time > CURRENT_TIME
          )
        )
      ORDER BY s.schedule_date ASC, s.departure_time ASC
      LIMIT 10
    `;

    const [schedules] = await sequelize.query(schedulesQuery, {
      bind: [routes[0].id]
    });

    console.log(`✓ Found ${schedules.length} future schedules for route`);
    if (schedules.length > 0) {
      console.log('  Sample schedule:');
      console.log('   ', {
        date: schedules[0].schedule_date,
        departure: schedules[0].departure_time,
        arrival: schedules[0].arrival_time,
        availableSeats: schedules[0].real_available_seats
      });
    }

    console.log('\n✓ All SQL queries working correctly!\n');

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error.stack);
  } finally {
    await sequelize.close();
  }
}

testQueries();
