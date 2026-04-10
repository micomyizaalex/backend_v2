const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { corsOptions } = require('./config//cors');
const { activityLogger } = require('./middleware/activityLogger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const routes = require('./routes');

const app = express();

// Security headers - should be first
app.use(helmet());

// CORS configuration
app.use(cors(corsOptions));

// Request logging
app.use(morgan('dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded profile pictures
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use("/api", activityLogger, routes);

// 404 handler
app.use(notFound);

// Error handler
app.use(errorHandler);

module.exports = app;