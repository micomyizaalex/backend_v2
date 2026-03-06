/**
 * Migration: create bus_schedules table
 * Used by the shared-route scheduling system.
 * route_id stores rura_routes.id (integer, cast to text for flexibility).
 */
const pool = require('../config/pgPool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bus_schedules (
        schedule_id   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        bus_id        UUID        NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
        route_id      TEXT        NOT NULL,            -- rura_routes.id (integer stored as text)
        company_id    UUID        REFERENCES companies(id) ON DELETE SET NULL,
        date          DATE        NOT NULL,
        time          TIME        NOT NULL,
        capacity      INTEGER     NOT NULL DEFAULT 30,
        available_seats INTEGER   GENERATED ALWAYS AS (capacity - COALESCE(booked_seats, 0)) STORED,
        booked_seats  INTEGER     NOT NULL DEFAULT 0,
        status        VARCHAR(50) NOT NULL DEFAULT 'scheduled',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bus_schedules_bus_id     ON bus_schedules(bus_id);
      CREATE INDEX IF NOT EXISTS idx_bus_schedules_route_id   ON bus_schedules(route_id);
      CREATE INDEX IF NOT EXISTS idx_bus_schedules_company_id ON bus_schedules(company_id);
      CREATE INDEX IF NOT EXISTS idx_bus_schedules_date       ON bus_schedules(date);
    `);

    await client.query('COMMIT');
    console.log('✓ bus_schedules table created (or already exists)');
  } catch (err) {
    await client.query('ROLLBACK');
    // If generated column syntax isn't supported, create without it
    if (err.message.includes('GENERATED')) {
      console.log('Retrying without GENERATED column…');
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS bus_schedules (
          schedule_id   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
          bus_id        UUID        NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
          route_id      TEXT        NOT NULL,
          company_id    UUID        REFERENCES companies(id) ON DELETE SET NULL,
          date          DATE        NOT NULL,
          time          TIME        NOT NULL,
          capacity      INTEGER     NOT NULL DEFAULT 30,
          available_seats INTEGER,
          booked_seats  INTEGER     NOT NULL DEFAULT 0,
          status        VARCHAR(50) NOT NULL DEFAULT 'scheduled',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_bus_schedules_bus_id     ON bus_schedules(bus_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_bus_schedules_route_id   ON bus_schedules(route_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_bus_schedules_company_id ON bus_schedules(company_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_bus_schedules_date       ON bus_schedules(date);`);
      await client.query('COMMIT');
      console.log('✓ bus_schedules table created (fallback schema)');
    } else {
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
