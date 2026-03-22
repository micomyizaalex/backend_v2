/**
 * Test getSchedulesForRoute query
 */
const sequelize = require('./config/database');

async function testSchedulesQuery() {
  try {
    const routeId = '836043bb-8dd4-48fb-aa44-bc3b7a88d842'; // kigali-muhanga route ID from logs
    
    console.log('Testing schedules query for route:', routeId);
    
    const query = `
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
        b.model,
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
            AND s.departure_time > NOW()
          )
        )
      ORDER BY s.schedule_date ASC, s.departure_time ASC
      LIMIT 10
    `;

    console.log('\nExecuting query...');
    const [results] = await sequelize.query(query, {
      bind: [routeId]
    });
    
    console.log(`\n✅ Query successful! Found ${results.length} schedules`);
    if (results.length > 0) {
      console.log('\nFirst schedule:');
      console.log(results[0]);
    } else {
      console.log('\nNo future schedules found for this route.');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Query failed!');
    console.error('Error:', error.message);
    console.error('\nError code:', error.original?.code);
    console.error('\nError detail:', error.original?.detail);
    console.error('\nError hint:', error.original?.hint);
    process.exit(1);
  }
}

testSchedulesQuery();
