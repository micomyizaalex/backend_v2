const pool = require('./config/pgPool');

async function verifyDeletion() {
  let client;
  try {
    client = await pool.connect();
    
    const result = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive
      FROM rura_routes
    `);
    
    const stats = result.rows[0];
    console.log('\n📊 Database Status:');
    console.log('═══════════════════════════════');
    console.log(`Total routes:    ${stats.total}`);
    console.log(`Active routes:   ${stats.active}`);
    console.log(`Inactive routes: ${stats.inactive}`);
    console.log('═══════════════════════════════\n');
    
    if (stats.total === '0') {
      console.log('✅ All test routes have been deleted successfully!');
      console.log('🎉 The rura_routes table is now empty.\n');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

verifyDeletion();
