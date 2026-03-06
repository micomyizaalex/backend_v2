/**
 * Quick smoke test for segment-based booking system
 * Run: node test-segment-system.js
 */
require('dotenv').config();
const pool = require('./config/pgPool');

async function run() {
  const client = await pool.connect();
  try {
    console.log('=== Segment Booking System Smoke Test ===\n');

    // 1. Check tickets table has from_stop/to_stop
    const ticketCols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tickets'
      AND column_name IN ('from_stop', 'to_stop', 'price', 'booking_ref', 'seat_number')
      ORDER BY column_name
    `);
    console.log('tickets columns:');
    ticketCols.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
    const hasFromStop = ticketCols.rows.some(r => r.column_name === 'from_stop');
    const hasToStop   = ticketCols.rows.some(r => r.column_name === 'to_stop');
    console.log(`  ✅ from_stop: ${hasFromStop} | to_stop: ${hasToStop}\n`);

    // 2. Check route_stops table exists and has right columns
    const routeStopsCols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'route_stops'
      ORDER BY ordinal_position
    `);
    console.log('route_stops columns:');
    routeStopsCols.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
    console.log();

    // 3. Count stops
    const stopCount = await client.query('SELECT COUNT(*) FROM route_stops');
    console.log(`route_stops rows: ${stopCount.rows[0].count}`);

    // 4. Check bus_schedules
    const schedCount = await client.query('SELECT COUNT(*) FROM bus_schedules');
    console.log(`bus_schedules rows: ${schedCount.rows[0].count}`);

    // 5. Sample rura_routes
    const routes = await client.query('SELECT id, from_location, to_location, price, status FROM rura_routes LIMIT 3');
    console.log('\nSample rura_routes:');
    routes.rows.forEach(r => console.log(`  id=${r.id} | ${r.from_location} → ${r.to_location} | price=${r.price} | ${r.status}`));

    // 6. Try inserting a test stop and verifying
    if (routes.rows.length > 0) {
      const testRouteId = routes.rows[0].id;
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO route_stops (route_id, stop_name, sequence) VALUES ($1, 'Test Stop A', 1)
        ON CONFLICT DO NOTHING
      `, [String(testRouteId)]);
      const testFetch = await client.query(`
        SELECT * FROM route_stops WHERE route_id::text = $1 LIMIT 5
      `, [String(testRouteId)]);
      console.log(`\nTest stops for route ${testRouteId}: ${testFetch.rows.length} row(s)`);
      await client.query('ROLLBACK'); // clean up
    }

    console.log('\n🎉 Smoke test passed!');
  } catch (err) {
    console.error('❌ Smoke test failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
