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
// QR TICKET SCAN ENDPOINT (public — opened by phone after scanning QR)
// GET /scan/:ticketId
// Returns an HTML page showing ticket validity status and marks ticket as USED
// =====================
app.get('/scan/:ticketId', async (req, res) => {
  const pool = require('./config/pgPool');
  const { ticketId } = req.params;

  // Determine if the caller wants JSON (driver app) or HTML (phone browser)
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  const renderHtml = (title, emoji, color, lines) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SafariTix – ${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
         background:${color};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
    .card{background:#fff;border-radius:24px;padding:40px 32px;max-width:380px;width:100%;
          box-shadow:0 20px 60px rgba(0,0,0,.15);text-align:center}
    .emoji{font-size:72px;margin-bottom:16px;line-height:1}
    h1{font-size:24px;font-weight:800;color:#111;margin-bottom:8px}
    .sub{font-size:14px;color:#555;margin-bottom:20px}
    .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
    .row:last-child{border-bottom:none}
    .label{color:#888;font-weight:500}
    .value{color:#111;font-weight:700;text-align:right;max-width:60%}
    .brand{margin-top:28px;font-size:12px;color:#aaa;font-weight:600;letter-spacing:.5px}
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <div class="sub">${lines.sub || ''}</div>
    ${(lines.rows || []).map(r => `<div class="row"><span class="label">${r[0]}</span><span class="value">${r[1]}</span></div>`).join('')}
    <div class="brand">SafariTix · Secure Digital Ticket</div>
  </div>
</body>
</html>`;

  let client;
  try {
    client = await pool.connect();

    // Try by booking_ref first, then by UUID id
    let ticket = null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId);

    const q = await client.query(`
      SELECT
        t.id, t.booking_ref, t.seat_number, t.price, t.status,
        t.checked_in_at, t.booked_at,
        u.full_name AS passenger_name,
        COALESCE(r.origin, rr.from_location, '') AS route_from,
        COALESCE(r.destination, rr.to_location, '') AS route_to,
        COALESCE(s1.departure_time, s2.time, '') AS dep_time,
        COALESCE(s1.schedule_date, s2.date, NOW()) AS dep_date,
        b.plate_number AS bus_plate
      FROM tickets t
      LEFT JOIN users u ON u.id = t.passenger_id
      LEFT JOIN schedules s1 ON s1.id = t.schedule_id
      LEFT JOIN bus_schedules s2 ON s2.schedule_id::text = t.schedule_id::text
      LEFT JOIN routes r ON r.id = s1.route_id
      LEFT JOIN rura_routes rr ON rr.id::text = s2.route_id::text
      LEFT JOIN buses b ON b.id = COALESCE(s1.bus_id, s2.bus_id)
      WHERE t.booking_ref = $1
        ${isUuid ? 'OR t.id::text = $1' : ''}
      LIMIT 1
    `, [ticketId]);

    ticket = q.rows[0] || null;

    if (!ticket) {
      if (wantsJson) return res.status(404).json({ valid: false, status: 'NOT_FOUND', message: 'Ticket not found' });
      return res.send(renderHtml('Invalid Ticket', '❌', '#fee2e2', {
        sub: 'No ticket found with this ID.',
        rows: [['Ticket ID', ticketId]]
      }));
    }

    const statusUp = (ticket.status || '').toUpperCase();
    const usedStatuses = ['CHECKED_IN', 'USED'];

    if (usedStatuses.includes(statusUp)) {
      const usedAt = ticket.checked_in_at ? new Date(ticket.checked_in_at).toLocaleString('en-RW') : 'Earlier';
      if (wantsJson) return res.status(200).json({ valid: false, status: 'ALREADY_USED', message: 'Ticket already used', ticket: { bookingRef: ticket.booking_ref, passengerName: ticket.passenger_name } });
      return res.send(renderHtml('Already Used', '⚠️', '#fef9c3', {
        sub: 'This ticket has already been scanned.',
        rows: [
          ['Passenger', ticket.passenger_name || '—'],
          ['Route', `${ticket.route_from} → ${ticket.route_to}`],
          ['Seat', String(ticket.seat_number || '—')],
          ['Scanned at', usedAt],
        ]
      }));
    }

    if (statusUp === 'CANCELLED') {
      if (wantsJson) return res.status(200).json({ valid: false, status: 'CANCELLED', message: 'Ticket has been cancelled' });
      return res.send(renderHtml('Ticket Cancelled', '🚫', '#fee2e2', {
        sub: 'This ticket has been cancelled.',
        rows: [['Passenger', ticket.passenger_name || '—'], ['Ticket ID', ticket.booking_ref || ticketId]]
      }));
    }

    if (statusUp === 'PENDING_PAYMENT') {
      if (wantsJson) return res.status(200).json({ valid: false, status: 'PENDING_PAYMENT', message: 'Payment not completed' });
      return res.send(renderHtml('Payment Pending', '⏳', '#fef9c3', {
        sub: 'Payment has not been completed for this ticket.',
        rows: [['Ticket ID', ticket.booking_ref || ticketId]]
      }));
    }

    // Valid ticket — mark as CHECKED_IN/USED
    await client.query(
      `UPDATE tickets SET status = 'CHECKED_IN', checked_in_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [ticket.id]
    );

    const dateStr = ticket.dep_date ? String(ticket.dep_date).slice(0, 10) : '—';
    const timeStr = ticket.dep_time ? String(ticket.dep_time).slice(0, 5) : '—';

    if (wantsJson) {
      return res.status(200).json({
        valid: true,
        status: 'CHECKED_IN',
        message: 'Ticket valid – passenger checked in',
        ticket: {
          bookingRef: ticket.booking_ref,
          passengerName: ticket.passenger_name,
          seat: ticket.seat_number,
          route: `${ticket.route_from} → ${ticket.route_to}`,
          date: dateStr,
          time: timeStr,
          bus: ticket.bus_plate,
          price: ticket.price,
        }
      });
    }

    return res.send(renderHtml('Ticket Valid ✓', '✅', '#dcfce7', {
      sub: 'Welcome aboard! Passenger is cleared to board.',
      rows: [
        ['Passenger', ticket.passenger_name || '—'],
        ['Route', `${ticket.route_from} → ${ticket.route_to}`],
        ['Date', dateStr],
        ['Time', timeStr],
        ['Seat', String(ticket.seat_number || '—')],
        ['Bus', ticket.bus_plate || '—'],
        ['Price', ticket.price ? `${Number(ticket.price).toLocaleString()} RWF` : '—'],
        ['Ticket ID', ticket.booking_ref || ticketId],
      ]
    }));

  } catch (err) {
    console.error('[/scan] Error:', err.message || err);
    if (wantsJson) return res.status(500).json({ valid: false, status: 'ERROR', message: 'Server error' });
    return res.send(renderHtml('System Error', '❗', '#fee2e2', {
      sub: 'Could not validate ticket. Please try again.',
      rows: [['Ticket ID', ticketId]]
    }));
  } finally {
    if (client) client.release();
  }
});

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
        
        // Sync models disabled - schema is managed via migrations
        // (sequelize.sync was causing startup hangs with large schemas)
        
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