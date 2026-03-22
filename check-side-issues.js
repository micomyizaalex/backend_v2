const { Pool } = require('pg');
require('dotenv/config');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Check bus_schedules available_seats - is it a generated column?
  const r1 = await pool.query(`
    SELECT column_name, is_generated, generation_expression, column_default
    FROM information_schema.columns
    WHERE table_name = 'bus_schedules' AND column_name = 'available_seats'
  `);
  console.log('available_seats column:', JSON.stringify(r1.rows));

  // Check users table columns
  const r2 = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    ORDER BY ordinal_position
  `);
  console.log('users columns:', r2.rows.map(r => r.column_name));

  pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
