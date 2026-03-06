const { Pool } = require('pg');
require('dotenv/config');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const r = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tickets'
     ORDER BY ordinal_position`
  );
  console.log('tickets schema:');
  for (const row of r.rows) {
    const req = row.is_nullable === 'NO' && !row.column_default ? ' *** REQUIRED (no default)' : '';
    console.log(`  ${row.column_name}  ${row.data_type}  nullable=${row.is_nullable}  default=${row.column_default}${req}`);
  }

  // Also check if bus_schedules has company_id
  const r2 = await pool.query(
    `SELECT bs.schedule_id, bs.company_id FROM bus_schedules bs LIMIT 3`
  );
  console.log('\nSample bus_schedules company_id:', JSON.stringify(r2.rows));

  pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
