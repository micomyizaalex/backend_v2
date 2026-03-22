# SafariTix USSD - Production System 🚌

## Overview

Production-ready USSD backend for SafariTix bus ticket booking system. Built with Node.js, Express, and PostgreSQL (Neon Cloud), integrated with Africa's Talking USSD gateway.

## Features ✨

- ✅ **Dynamic Route Loading** - Routes and schedules loaded from PostgreSQL database
- ✅ **Real-time Seat Availability** - Checks actual seat availability before booking
- ✅ **Seat Locking** - Temporary seat locks (7 minutes) prevent double booking
- ✅ **Transaction Safety** - Database transactions ensure data consistency
- ✅ **Passenger Auto-Creation** - Creates commuter accounts automatically from phone numbers
- ✅ **Booking Management** - Book, check, and cancel tickets via USSD
- ✅ **Error Handling** - Comprehensive error handling for all operations
- ✅ **Session Management** - Tracks user journeys through USSD menus
- ✅ **Concurrent Sessions** - Handles multiple users simultaneously

## Architecture 🏗️

```
backend_v2/
├── controllers/
│   ├── ussdController.js           # Main USSD controller (PRODUCTION)
│   └── ussdController_mock_backup.js # Old mock version (backup)
├── services/
│   └── ussdService.js              # Database operations layer
├── models/
│   ├── User.js                     # Passenger accounts
│   ├── Route.js                    # Bus routes
│   ├── Schedule.js                 # Bus schedules
│   ├── Ticket.js                   # Bookings
│   └── SeatLock.js                 # Temporary seat reservations
└── routes/
    └── ussd.js                     # USSD API route
```

## Database Schema 📊

### Tables

**routes**
- `id` (UUID) - Primary key
- `origin` (String) - Departure city
- `destination` (String) - Arrival city
- `name` (String) - Route name
- `company_id` (UUID) - Bus company

**schedules**
- `id` (UUID) - Primary key
- `route_id` (UUID) - Foreign key to routes
- `bus_id` (UUID) - Foreign key to buses
- `schedule_date` (Date) - Travel date
- `departure_time` (Time) - Departure time
- `price_per_seat` (Decimal) - Ticket price
- `total_seats` (Integer) - Total seats on bus
- `available_seats` (Integer) - Remaining seats
- `ticket_status` (ENUM) - OPEN/CLOSED
- `status` (ENUM) - scheduled/in_progress/completed/cancelled

**tickets**
- `id` (UUID) - Primary key
- `passenger_id` (UUID) - Foreign key to users
- `schedule_id` (UUID) - Foreign key to schedules
- `seat_number` (String) - Seat assignment
- `booking_ref` (String) - Unique reference (e.g., STX-ABC123)
- `price` (Decimal) - Ticket price
- `status` (ENUM) - PENDING_PAYMENT/CONFIRMED/CANCELLED/EXPIRED/CHECKED_IN
- `lock_id` (UUID) - Optional seat lock reference

**seat_locks**
- `id` (UUID) - Primary key
- `schedule_id` (UUID) - Foreign key to schedules
- `seat_number` (String) - Locked seat
- `passenger_id` (UUID) - User holding the lock
- `expires_at` (DateTime) - Lock expiration time
- `status` (ENUM) - ACTIVE/EXPIRED/RELEASED/CONSUMED
- `ticket_id` (UUID) - Ticket created from lock (if any)

**users**
- `id` (UUID) - Primary key
- `phone_number` (String) - Phone number (unique)
- `full_name` (String) - Passenger name
- `email` (String) - Email address
- `role` (ENUM) - commuter/company_admin/driver/admin
- `password` (String) - Hashed password

## USSD Menu Flow 📱

```
┌─────────────────────────────────────┐
│      Welcome to SafariTix           │
│  1. Book Ticket                     │
│  2. Check Ticket                    │
│  3. Cancel Ticket                   │
│  4. Help                            │
└─────────────────────────────────────┘
          │
    ┌─────┴─────┬─────────┬─────────┐
    │           │         │         │
  [1]         [2]       [3]       [4]
 Book       Check     Cancel     Help
    │           │         │         │
    v           v         v         v
┌─────────┐ ┌────────┐ ┌────────┐ Display
│ Routes  │ │ Enter  │ │ Enter  │  Help
│         │ │Booking │ │Booking │  Info
│Select:  │ │  Ref   │ │  Ref   │
│1.Kigali→│ └────┬───┘ └───┬────┘
│  Huye   │      │          │
│2.Kigali→│      v          v
│ Musanze │   Display    Confirm
└────┬────┘   Ticket     Cancel
     │
     v
┌──────────────┐
│  Schedules   │
│              │
│ Select bus:  │
│1.Feb 26 08:00│
│  RWF 2500    │
│  (25 seats)  │
└──────┬───────┘
       │
       v
┌──────────────┐
│Avail. Seats: │
│1,2,3,5,7,... │
│              │
│Enter seat #  │
└──────┬───────┘
       │
       v
┌──────────────┐
│ Confirmation │
│              │
│Route: Kigali │
│  → Huye      │
│Date: Feb 26  │
│Time: 08:00   │
│Seat: 15      │
│Price:RWF2500 │
│              │
│1. Confirm    │
│2. Cancel     │
└──────┬───────┘
       │
     [1]
       │
       v
┌──────────────┐
│ ✓ SUCCESS!   │
│              │
│Ref:STX-AB123 │
│Seat: 15      │
│              │
│Save your ref!│
└──────────────┘
```

## Installation & Setup 🚀

### Prerequisites

- Node.js 16+
- PostgreSQL database (Neon Cloud or local)
- Africa's Talking account (for production)
- ngrok (for local testing)

### 1. Install Dependencies

```bash
cd backend_v2
npm install
```

### 2. Configure Environment

Ensure `.env` file has:

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Server
PORT=5000
APP_URL=https://backend-7cxc.onrender.com/api/$1

# Seat Lock Configuration
SEAT_LOCK_MINUTES=7
```

### 3. Setup Database

```bash
# Run migrations (if using Sequelize migrations)
npx sequelize-cli db:migrate

# Or sync models
node -e "require('./config/database').sync()"
```

### 4. Start Server

```bash
# Development
npm run dev

# Production
npm start
```

### 5. Expose via ngrok (for Africa's Talking)

```bash
ngrok http 5000
```

Copy the `https://xxxxx.ngrok-free.dev` URL.

### 6. Configure Africa's Talking

1. Go to [Africa's Talking Dashboard](https://account.africastalking.com)
2. Navigate to USSD → Simulator
3. Set Callback URL: `https://xxxxx.ngrok-free.dev/api/ussd`
4. Set Method: `POST`
5. Save and test

## Testing 🧪

### Local Testing (Without Africa's Talking)

```bash
# Run comprehensive test suite
node test-ussd-production.js
```

This will test:
- ✓ Server health check
- ✓ Main menu display
- ✓ Route loading from database
- ✓ Check ticket flow
- ✓ Cancel ticket flow
- ✓ Help menu
- ✓ Error handling

### Manual Testing with curl

```bash
# Test main menu
curl -X POST https://backend-7cxc.onrender.com/api/$1/api/ussd \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"123","serviceCode":"*384#","phoneNumber":"+250788123456","text":""}'

# Test booking flow - view routes
curl -X POST https://backend-7cxc.onrender.com/api/$1/api/ussd \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"123","serviceCode":"*384#","phoneNumber":"+250788123456","text":"1"}'
```

### Test with Africa's Talking Simulator

1. Go to [USSD Simulator](https://account.africastalking.com/ussd/simulator)
2. Enter phone number: `+250788123456`
3. Dial your USSD code
4. Navigate through menus

## API Endpoints 🔌

### POST `/api/ussd`

Main USSD endpoint for Africa's Talking callbacks.

**Request Body:**
```json
{
  "sessionId": "ATUid_xxx",
  "serviceCode": "*384*123#",
  "phoneNumber": "+250788123456",
  "text": "1*2*15"
}
```

**Response:**
```
CON Welcome to SafariTix
1. Book Ticket
2. Check Ticket
3. Cancel Ticket
4. Help
```

**Response Types:**
- `CON` - Continue session (show menu/prompt)
- `END` - End session (final message)

## Service Layer Functions 🛠️

### `ussdService.js`

**Passenger Management:**
- `findOrCreatePassenger(phoneNumber)` - Auto-create commuter accounts

**Route & Schedule Queries:**
- `getActiveRoutes()` - Get routes with available schedules
- `getSchedulesForRoute(routeId)` - Get schedules for route
- `getAvailableSeats(scheduleId)` - Get available seat numbers

**Seat Locking:**
- `createSeatLock(scheduleId, seatNumber, passengerId, companyId)` - Lock seat
- `cleanupExpiredLocks()` - Mark expired locks

**Booking Operations:**
- `bookTicket(bookingData)` - Create ticket with transaction
- `findTicketByRef(bookingRef, phoneNumber)` - Lookup ticket
- `cancelTicket(ticketId, phoneNumber)` - Cancel and release seat

## Configuration ⚙️

### Seat Lock Duration

Default: 7 minutes

Configure in `.env`:
```env
SEAT_LOCK_MINUTES=7
```

### Session Storage

**Current:** In-memory Map (suitable for single-server)

**Production (High Scale):** Use Redis
```javascript
// Replace sessionStore with Redis client
const redis = require('redis');
const client = redis.createClient();
```

## Error Handling 🚨

All operations include try-catch blocks with user-friendly messages:

```javascript
try {
  // Operation
} catch (error) {
  console.error('Error:', error);
  return 'END Service unavailable. Please try again.';
}
```

**Common errors handled:**
- Database connection failures
- Invalid seat selections
- Expired seat locks
- Unauthorized cancellations
- Double bookings
- Invalid booking references

## Monitoring & Logging 📊

All USSD requests are logged:

```
=== USSD Request ===
Session ID: ATUid_xxx
Phone: +250788123456
Text: 1*2*15
====================
```

**Production Recommendations:**
- Use Winston or Bunyan for structured logging
- Log to files or external service (Papertrail, Loggly)
- Monitor error rates
- Track booking success rates
- Monitor seat lock expiration rates

## Security Considerations 🔒

1. **Phone Number Verification** - Tickets tied to phone numbers
2. **Booking Reference Security** - Unique 6-character codes
3. **Transaction Safety** - All bookings use DB transactions
4. **Seat Locking** - Prevents double booking races
5. **Input Validation** - All user inputs validated
6. **SQL Injection Protection** - Using Sequelize ORM with parameterized queries

## Performance Optimization 🚀

**Current Implementation:**
- Session cleanup every 10 minutes
- Expired lock cleanup before new locks
- Limited menu items (to avoid USSD overflow)
- Query result limits

**Recommended for Scale:**
- Redis for session storage
- Database connection pooling
- Caching frequently-accessed routes
- Background job for lock cleanup
- Load balancing multiple servers

## Troubleshooting 🔧

### "No routes available"
**Cause:** Database has no routes with open schedules
**Fix:** Create routes and schedules in database

```sql
-- Check routes
SELECT * FROM routes;

-- Check schedules
SELECT * FROM schedules WHERE ticket_status = 'OPEN';
```

### "Seat already booked"
**Cause:** Race condition or lock not working
**Fix:** Check seat_locks table

```sql
-- View active locks
SELECT * FROM seat_locks WHERE status = 'ACTIVE';

-- Clear expired locks
UPDATE seat_locks SET status = 'EXPIRED' 
WHERE expires_at < NOW() AND status = 'ACTIVE';
```

### "Database not connected"
**Cause:** DATABASE_URL incorrect or database down
**Fix:** Check connection string and database status

```bash
# Test database connection
node test-db-connection.js
```

### "Session expired"
**Cause:** User took too long (>10 minutes)
**Fix:** This is normal - user needs to start over

## Deployment 📦

### Heroku

```bash
heroku create safaritix-ussd
heroku addons:create heroku-postgresql
heroku config:set SEAT_LOCK_MINUTES=7
git push heroku main
```

### Render

1. Connect GitHub repo
2. Add environment variables
3. Deploy

### VPS (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone <repo>
cd backend_v2
npm install
npm install -g pm2

# Start with PM2
pm2 start app.js --name safaritix-ussd
pm2 save
pm2 startup
```

## Future Enhancements 🌟

- [ ] Payment integration (MTN Mobile Money)
- [ ] Send SMS confirmation after booking
- [ ] Multi-language support (English, Kinyarwanda, French)
- [ ] Booking history per user
- [ ] Loyalty points system
- [ ] Group booking support
- [ ] Return journey booking
- [ ] Bus live tracking
- [ ] QR code generation for tickets

## Support 📞

For issues or questions:
- Check logs in console
- Run test suite: `node test-ussd-production.js`
- Review Africa's Talking dashboard logs
- Check database connectivity

## License 📄

MIT License - SafariTix 2026

---

**Built with ❤️ for African bus transportation**
