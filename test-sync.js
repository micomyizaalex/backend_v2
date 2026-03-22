const sequelize = require('./config/database');

async function testSync() {
  try {
    console.log('Testing database authentication...');
    await sequelize.authenticate();
    console.log('✅ Connected');
    
    console.log('Testing database sync...');
    await sequelize.sync({ alter: false });
    console.log('✅ Synced');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

testSync();
