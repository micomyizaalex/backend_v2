require('dotenv').config();
const pool = require('./config/pgPool');

async function main() {
  const client = await pool.connect();
  try {
    const columns = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'rura_routes'
       ORDER BY ordinal_position`
    );
    console.log(JSON.stringify(columns.rows, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
