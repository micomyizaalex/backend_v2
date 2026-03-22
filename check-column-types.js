/**
 * Check actual database column types
 */
const pgPool = require('./config/pgPool');

async function checkSchema() {
  const client = await pgPool.connect();
  
  try {
    const result = await client.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns 
      WHERE table_name = 'schedules'
        AND column_name IN ('schedule_date', 'departure_time', 'arrival_time')
      ORDER BY column_name
    `);
    
    console.log('\nSchedules table column types:');
    console.table(result.rows);
    
  } finally {
    client.release();
    await pgPool.end();
  }
}

checkSchema();
