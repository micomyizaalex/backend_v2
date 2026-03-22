/**
 * Test the problematic SQL query directly
 */
const sequelize = require('./config/database');

async function testQuery() {
  try {
    console.log('Testing SQL query...');
    
    const query = `
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
            AND s.departure_time > NOW()
          )
        )
      ORDER BY r.origin, r.destination
      LIMIT 20
    `;

    console.log('\nExecuting query...');
    const [results] = await sequelize.query(query);
    
    console.log(`\n✅ Query successful! Found ${results.length} routes`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.origin} → ${r.destination}`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Query failed!');
    console.error('Error:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

testQuery();
