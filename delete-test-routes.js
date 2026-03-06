const pool = require('./config/pgPool');

/**
 * Delete specific test routes from the database
 * These are the 8 routes currently visible in the admin dashboard
 */

const routesToDelete = [
  { from: 'kigali', to: 'huye', date: '2024-03-03' },
  { from: 'kacyiru', to: 'kinamba', date: '2026-03-03' },
  { from: 'rubavu', to: 'kamembe', date: '2024-01-03' },
  { from: 'gicumbi', to: 'tetero', date: '2024-01-03' },
  { from: 'nyabugogo', to: 'gaseke', date: '2024-01-03' },
  { from: 'miyove', to: 'base', date: '2024-03-01' },
  { from: 'gaseke', to: 'rukomo', date: '2024-01-03' },
  { from: 'rukomo', to: 'gicumbi', date: '2024-03-01' }
];

async function deleteRoutes() {
  let client;
  
  try {
    client = await pool.connect();
    console.log('✅ Connected to database\n');

    // Check current count
    const beforeCount = await client.query('SELECT COUNT(*) FROM rura_routes');
    console.log(`📊 Current total routes: ${beforeCount.rows[0].count}\n`);

    let deletedCount = 0;

    for (const route of routesToDelete) {
      try {
        const result = await client.query(
          `DELETE FROM rura_routes 
           WHERE LOWER(TRIM(from_location)) = LOWER(TRIM($1))
           AND LOWER(TRIM(to_location)) = LOWER(TRIM($2))
           AND effective_date::date = $3::date
           RETURNING id, from_location, to_location, price`,
          [route.from, route.to, route.date]
        );

        if (result.rows.length > 0) {
          const deleted = result.rows[0];
          console.log(`✅ Deleted: ${deleted.from_location} → ${deleted.to_location} (ID: ${deleted.id}, Price: ${deleted.price})`);
          deletedCount++;
        } else {
          console.log(`⚠️  Not found: ${route.from} → ${route.to} (${route.date})`);
        }
      } catch (err) {
        console.error(`❌ Error deleting ${route.from} → ${route.to}:`, err.message);
      }
    }

    // Check final count
    const afterCount = await client.query('SELECT COUNT(*) FROM rura_routes');
    console.log(`\n📊 Final total routes: ${afterCount.rows[0].count}`);
    console.log(`🗑️  Routes deleted: ${deletedCount}`);
    console.log('\n✅ Deletion complete!');

  } catch (error) {
    console.error('❌ Database error:', error);
  } finally {
    if (client) client.release();
    process.exit(0);
  }
}

// Run the deletion
console.log('🚀 Starting route deletion...\n');
deleteRoutes();
