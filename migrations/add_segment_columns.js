/**
 * Migration: Add from_stop / to_stop columns to the tickets table
 * so segment-based overlap detection works correctly.
 *
 * Run with: node migrations/add_segment_columns.js
 */
require('dotenv').config();
const pool = require('../config/pgPool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. tickets: add from_stop and to_stop columns
    await client.query(`
      ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS from_stop TEXT,
        ADD COLUMN IF NOT EXISTS to_stop   TEXT;
    `);
    console.log('✅  tickets.from_stop / to_stop added (or already existed)');

    // 2. route_stops table (create if missing, add sequence column if absent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS route_stops (
        id        SERIAL PRIMARY KEY,
        route_id  TEXT         NOT NULL,
        stop_name VARCHAR(255) NOT NULL,
        sequence  INT          NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅  route_stops table created (or already existed)');

    const rsCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'route_stops'
      ORDER BY ordinal_position
    `);
    const rsCols = rsCheck.rows.map(r => r.column_name);
    console.log('   route_stops columns:', rsCols.join(', '));

    if (!rsCols.includes('sequence')) {
      await client.query(`ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS sequence INT NOT NULL DEFAULT 0`);
      console.log('   Added route_stops.sequence');
    }

    // 3. index to speed up segment occupancy look-ups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_schedule_segment
        ON tickets (schedule_id, from_stop, to_stop)
        WHERE status IS DISTINCT FROM 'CANCELLED';
    `);
    console.log('✅  Index idx_tickets_schedule_segment created (or already existed)');

    await client.query('COMMIT');
    console.log('\n🎉  Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
