const dotenv = require('dotenv');
const { sequelize } = require('./models/index');
const { initializeSocket } = require('./config/socket');
const { gracefulShutdown } = require('./utils/helpers');

dotenv.config();

const startServer = async () => {
  try {
    // Validate environment
    const requiredEnvVars = ['PORT', 'JWT_SECRET'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
    }
    
    // Connect to database
    let isDatabaseConnected = false;
    try {
      await sequelize.authenticate();
      await sequelize.sync({ alter: true }); // Set to true only if you want to sync schema changes
      isDatabaseConnected = true;
      console.log('📡 Database connection established successfully.');
    } catch (dbError) {
      console.error('❌ Unable to connect to the database:', dbError.message);
    }
    
    // Create Express app
    const app = require('./app');
    
    // Create HTTP server
    const httpServer = require('http').createServer(app);
    
    // Initialize Socket.IO
    initializeSocket(httpServer);
    
    const PORT = process.env.PORT || 5000;
    
    httpServer.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 API URL: ${process.env.APP_URL || `http://localhost:${PORT}`}`);
      console.log(`🖥️ Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
      console.log(`📱 Socket.IO enabled for real-time tracking`);
      console.log(`💾 Database: ${isDatabaseConnected ? '✅ Connected' : '❌ Disconnected'}`);
      console.log(`📞 USSD: ✅ Available at /api/ussd (works without database)`);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown(httpServer));
    process.on('SIGINT', () => gracefulShutdown(httpServer));
    
  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

startServer();