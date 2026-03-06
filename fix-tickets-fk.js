const { Pool } = require('pg');
require('dotenv/config');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    // Check the FK constraint exists
    const r = await client.query(`
      SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'tickets'::regclass AND conname = 'tickets_schedule_id_fkey'
    `);
    if (!r.rows.length) {
      console.log('FK constraint tickets_schedule_id_fkey does not exist — nothing to do.');
      return;
    }
    console.log('Found constraint:', r.rows[0]);

    // Drop it — tickets.schedule_id needs to reference EITHER schedules OR bus_schedules
    await client.query('ALTER TABLE tickets DROP CONSTRAINT tickets_schedule_id_fkey');
    console.log('Dropped tickets_schedule_id_fkey successfully.');

    // Also check for company_id FK
    const r2 = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'tickets'::regclass AND conname LIKE '%company%'
    `);
    console.log('company_id constraints:', r2.rows);

  } finally {
    client.release();
    pool.end();
  }
}
main().catch(e => { console.error(e.message); pool.end(); });
