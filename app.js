const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const sequelize = require("./config/database");
const routes = require("./routes");
const { Op } = require('sequelize');

dotenv.config();

const app = express();

// Database connection status flag
let isDatabaseConnected = false;

// =====================
// MIDDLEWARE CONFIGURATION
// =====================

// Security headers - should be first
app.use(helmet());

// CORS configuration - move this BEFORE routes
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests, or Africa's Talking)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5000',
      'https://africastalking.com', // Africa's Talking sandbox
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    // In development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Request logging
app.use(morgan('dev'));

// Body parsing - IMPORTANT: These must come BEFORE routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// =====================
// HEALTH CHECK & INFO ROUTES
// =====================

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: isDatabaseConnected ? 'connected' : 'disconnected',
    ussd: 'available' // USSD works without database
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to SafariTix API',
    version: '1.0.0',
    docs: process.env.APP_URL + '/api-docs',
    endpoints: {
      auth: '/api/auth',
      bookings: '/api/bookings',
      buses: '/api/buses',
      routes: '/api/routes',
      payments: '/api/payments',
      ussd: '/api/ussd' // USSD endpoint for Africa's Talking
    }
  });
});

// =====================
// API ROUTES
// =====================
app.use("/api", routes);

// =====================
// ERROR HANDLING MIDDLEWARE
// =====================
app.use((req, res, next) => {
  res.status(404).json({
    status: 'error',
    message: `Cannot ${req.method} ${req.url}`,
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack || err.message || err);
  
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(status).json({
    status: 'error',
    message: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// =====================
// DATABASE CONNECTION
// =====================

const connectDatabase = async () => {
  try {
    console.log('🔄 Connecting to database...');
    
    let attempts = 0;
    const maxAttempts = 3; // Reduced attempts to fail faster
    const retryDelay = 2000; // 2 seconds
    
    while (attempts < maxAttempts) {
      try {
        attempts++;
        console.log(`📡 Attempt ${attempts}/${maxAttempts}...`);
        
        // Test connection
        await sequelize.authenticate();
        console.log('✅ Database connected successfully');
        
        // Sync models (in development only) - with safer sync
        if (process.env.NODE_ENV === 'development') {
          try {
            await sequelize.sync({ alter: false }); // Changed to false to prevent schema changes
            console.log('📊 Database synced');
          } catch (syncError) {
            console.warn('⚠️ Database sync failed (not critical):', syncError.message);
            // Continue anyway - connection is established
          }
        }
        
        isDatabaseConnected = true;
        return true;
      } catch (error) {
        console.error(`❌ Attempt ${attempts} failed:`, error.message);
        
        if (attempts >= maxAttempts) {
          console.warn('⚠️ Database connection failed - continuing without database');
          console.warn('⚠️ USSD and other mock-data features will work, but database-dependent features may fail');
          isDatabaseConnected = false;
          return false;
        }
        
        console.log(`⏳ Waiting ${retryDelay/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  } catch (error) {
    console.error('💥 Database connection error:', error.message);
    console.warn('⚠️ Starting server without database connection');
    isDatabaseConnected = false;
    return false;
  }
};

// =====================
// BACKGROUND TASKS
// =====================
const initializeBackgroundTasks = () => {
  const { SeatLock, Ticket } = require('./models');
  
  // Expire seat locks
  const expireLocks = async () => {
    try {
      const now = new Date();
      const expired = await SeatLock.findAll({ 
        where: { 
          status: 'ACTIVE', 
          expires_at: { [Op.lte]: now } 
        } 
      });
      
      for (const lock of expired) {
        try {
          lock.status = 'EXPIRED';
          await lock.save();
          
          if (lock.ticket_id) {
            const ticket = await Ticket.findByPk(lock.ticket_id);
            if (ticket && ticket.status === 'PENDING_PAYMENT') {
              ticket.status = 'EXPIRED';
              await ticket.save();
            }
          }
        } catch (e) {
          console.error('Failed to expire lock', lock.id, e.message || e);
        }
      }
    } catch (err) {
      console.error('expireLocks error', err.message || err);
    }
  };

  // Run every 30 seconds
  setInterval(expireLocks, 30 * 1000);
  console.log('⏰ Background tasks initialized');
};

// =====================
// SERVER STARTUP
// =====================
const startServer = async () => {
  try {
    // Validate environment variables
    const requiredEnvVars = ['PORT', 'JWT_SECRET'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
    }
    
    // Try to connect to database (non-blocking)
    await connectDatabase();
    
    // Create HTTP server from Express app
    const httpServer = http.createServer(app);
    
    // Initialize Socket.IO for real-time GPS tracking
    const { initializeSocket } = require('./config/socket');
    initializeSocket(httpServer); // Returns io instance, but we use httpServer for listening
    
    console.log('🚀 Starting server...');
    
    const PORT = process.env.PORT || 5000;
    
    httpServer.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 API URL: ${process.env.APP_URL || `http://localhost:${PORT}`}`);
      console.log(`🖥️ Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
      console.log(`📱 Socket.IO enabled for real-time tracking`);
      console.log(`💾 Database: ${isDatabaseConnected ? '✅ Connected' : '❌ Disconnected'}`);
      console.log(`📞 USSD: ✅ Available at /api/ussd (works without database)`);
      
      if (!isDatabaseConnected) {
        console.log(`\n⚠️  NOTE: Database is not connected`);
        console.log(`   - USSD features work with mock data`);
        console.log(`   - Other features may be limited`);
        console.log(`   - Fix database issues to enable full functionality\n`);
      }
    });
    
    // Initialize background tasks only if database is connected
    if (isDatabaseConnected) {
      initializeBackgroundTasks();
    } else {
      console.log('⏰ Background tasks skipped (database not available)');
    }
    
    // Handle graceful shutdown
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    
  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

const gracefulShutdown = () => {
  console.log('🛑 Received shutdown signal, closing connections...');
  
  // Close database connection
  sequelize.close().then(() => {
    console.log('✅ Database connection closed');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ Error closing database connection:', err);
    process.exit(1);
  });
};

// Start the server
startServer();

module.exports = app; // For testing purposes