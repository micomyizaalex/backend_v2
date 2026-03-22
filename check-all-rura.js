require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // All tables with rura or route in name
  const tables = await p.query(`
    SELECT table_schema, table_name 
    FROM information_schema.tables 
    WHERE table_name ILIKE '%rura%' OR table_name ILIKE '%route%'
    ORDER BY table_schema, table_name
  `);
  console.log('\n=== Tables matching rura/route ===');
  console.table(tables.rows);

  // All rows from rura_routes in every schema
  const schemas = tables.rows.filter(r => r.table_name === 'rura_routes');
  for (const s of schemas) {
    const rows = await p.query(`SELECT * FROM "${s.table_schema}"."${s.table_name}" ORDER BY id`);
    console.log(`\n=== ${s.table_schema}.rura_routes — ${rows.rows.length} row(s) ===`);
    console.table(rows.rows.map(r => ({
      id: r.id,
      from: r.from_location,
      to: r.to_location,
      price: r.price,
      date: r.effective_date ? r.effective_date.toISOString().split('T')[0] : null,
      doc: r.source_document,
      status: r.status,
    })));
  }

  // Also check the current search_path default schema
  const sp = await p.query('SHOW search_path');
  console.log('\nDefault search_path:', sp.rows[0].search_path);

  await p.end();
}

run().catch(e => { console.error(e.message); p.end(); });
