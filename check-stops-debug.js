const { Pool } = require('pg');
require('dotenv/config');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Find nyabugogo->muhanga routes
  const r1 = await pool.query(
    "SELECT id, from_location, to_location, price, status FROM rura_routes WHERE from_location ILIKE '%nyabugogo%' AND to_location ILIKE '%muhanga%'"
  );
  console.log('nyabugogo->muhanga routes:', JSON.stringify(r1.rows, null, 2));

  // Show all route_stops
  const r2 = await pool.query('SELECT route_id, stop_name, sequence FROM route_stops ORDER BY route_id, sequence');
  console.log('\nAll route_stops:', JSON.stringify(r2.rows, null, 2));

  pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
