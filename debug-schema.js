const pool = require('./config/pgPool');
async function main() {
  const c = await pool.connect();
  // All tables
  const tbls = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  console.log('TABLES:', tbls.rows.map(r=>r.table_name).join(', '));

  for (const t of ['rura_routes','route_stops','bus_schedules','schedules','tickets','buses','companies','shared_tickets']) {
    const r = await c.query(`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[t]);
    if(r.rows.length) {
      console.log(`\n=== ${t} ===`);
      r.rows.forEach(x=>console.log(`  ${x.column_name}  ${x.data_type}  nullable=${x.is_nullable}`));
    }
  }

  // Sample data
  const rr = await c.query(`SELECT id,from_location,to_location,price,status FROM rura_routes LIMIT 5`);
  console.log('\nSample rura_routes:', JSON.stringify(rr.rows));

  const rs = await c.query(`SELECT id,route_id,stop_name,sequence FROM route_stops LIMIT 10`).catch(()=>({rows:[]}));
  console.log('Sample route_stops:', JSON.stringify(rs.rows));

  const bs = await c.query(`SELECT schedule_id,bus_id,route_id,date,time,status FROM bus_schedules LIMIT 3`).catch(()=>({rows:[]}));
  console.log('Sample bus_schedules:', JSON.stringify(bs.rows));

  c.release(); pool.end();
}
main().catch(e=>{console.error(e.message);process.exit(1)});
