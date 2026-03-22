require('dotenv').config();
const pool = require('./config/pgPool');

async function readSnapshot(client) {
  const schedule = await client.query(
    `SELECT schedule_id
     FROM bus_schedules
     WHERE status = 'in_progress'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`
  );

  const scheduleId = schedule.rows[0]?.schedule_id;
  if (!scheduleId) {
    return { scheduleId: null, count: 0, latest: null };
  }

  const stats = await client.query(
    `SELECT COUNT(*)::int AS count, MAX(recorded_at) AS latest
     FROM live_bus_locations
     WHERE schedule_id = $1`,
    [scheduleId]
  );

  return {
    scheduleId,
    count: stats.rows[0].count,
    latest: stats.rows[0].latest,
  };
}

async function main() {
  const client = await pool.connect();
  try {
    const first = await readSnapshot(client);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const second = await readSnapshot(client);
    console.log(JSON.stringify({ first, second }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
