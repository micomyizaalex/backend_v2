require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  const sqlFilePath = path.resolve(
    __dirname,
    '..',
    'php',
    'payment_gateway',
    'migrations',
    'create_bookings_payment_tables.sql'
  );

  const sql = await fs.readFile(sqlFilePath, 'utf8');
  if (!sql.trim()) {
    throw new Error(`SQL file is empty: ${sqlFilePath}`);
  }

  const pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  let client;
  try {
    client = await pool.connect();
    await client.query(sql);
    console.log(`Migration executed successfully from: ${sqlFilePath}`);
  } catch (error) {
    console.error('Failed to execute migration SQL.');
    console.error(error.message);
    if (error.code) console.error(`code: ${error.code}`);
    if (error.detail) console.error(`detail: ${error.detail}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
    if (error.position) console.error(`position: ${error.position}`);
    if (error.where) console.error(`where: ${error.where}`);
    if (error.schema) console.error(`schema: ${error.schema}`);
    if (error.table) console.error(`table: ${error.table}`);
    if (error.column) console.error(`column: ${error.column}`);
    process.exitCode = 1;
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Unexpected migration runner error.');
  console.error(error.message);
  process.exitCode = 1;
});
