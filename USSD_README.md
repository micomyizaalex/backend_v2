# SafariTix USSD Backend - Africa's Talking Integration

Complete USSD backend for SafariTix commuter booking system, fully integrated with Africa's Talking USSD service.

## 🚀 Features

- **Modular Architecture**: Separate controller and route files for maintainability
- **Dynamic Menu Parsing**: Uses `text.split("*")` for easy menu expansion
- **Three Main Flows**:
  1. **Book Ticket**: Choose destination → Enter seat → Confirm → Book
  2. **Cancel Ticket**: Enter ticket ID → Confirm cancellation
  3. **Check Schedule**: Enter route → View bus times
- **Error Handling**: Validates inputs and provides user-friendly error messages
- **Database-Ready**: Placeholder functions marked for database integration
- **CORS Enabled**: Supports Africa's Talking sandbox and local development

## 📁 Project Structure

```
backend_v2/
├── app.js                          # Main Express app (cleaned up)
├── controllers/
│   └── ussdController.js           # USSD logic (NEW)
└── routes/
    ├── index.js                    # Routes registry (updated)
    └── ussd.js                     # USSD routes (NEW)
```

## 🛠 Installation

```bash
cd backend_v2
npm install
```

**Required packages** (already in your package.json):
- express
- cors
- body-parser (or express.json())
- dotenv

## 🔧 Configuration

Create or update `.env` file:

```env
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

## ▶️ Running the Server

```bash
# Development mode
npm start

# Or with nodemon (if installed)
npm run dev
```

Server will start on `https://backend-7cxc.onrender.com/api/$1`

## 📡 API Endpoint

### POST `/api/ussd`

**Request Body** (sent by Africa's Talking):
```json
{
  "sessionId": "ATUid_1234567890",
  "serviceCode": "*384*123#",
  "phoneNumber": "+250788123456",
  "text": "1*2*15"
}
```

**Response** (Content-Type: text/plain):
```
CON Choose destination:
1. Kigali
2. Huye
3. Musanze
```

## 🎯 USSD Menu Flow

### Main Menu (Dial `*YOUR_CODE#`)
```
CON Welcome to SafariTix
1. Book Ticket
2. Cancel Ticket
3. Check Bus Schedule
```

### Flow 1: Book Ticket
```
1. Book Ticket
   ↓
2. Choose destination:
   1. Kigali
   2. Huye
   3. Musanze
   ↓
3. Enter seat number (1-50):
   [User enters: 15]
   ↓
4. Confirm booking:
   Destination: Huye
   Seat: 15
   Price: 2500 RWF
   
   1. Confirm
   2. Cancel
   ↓
END Ticket booked to Huye.
Seat: 15
Ticket ID: TKT123456789
Pay 2500 RWF at station.
```

### Flow 2: Cancel Ticket
```
2. Cancel Ticket
   ↓
Enter ticket ID:
[User enters: TKT123456]
   ↓
Cancel ticket TKT123456?
1. Yes, cancel
2. No, go back
   ↓
END Ticket TKT123456 cancelled successfully.
```

### Flow 3: Check Schedule
```
3. Check Bus Schedule
   ↓
Enter route (e.g., Kigali-Huye):
Popular routes:
1. Kigali-Huye
2. Kigali-Musanze
3. Huye-Kigali
Or type custom route
   ↓
[User selects: 1]
   ↓
CON Next buses for Kigali → Huye:

08:00 AM, 11:00 AM, 02:00 PM, 05:00 PM

Safe travels with SafariTix!
```

## 🧪 Testing Locally

### Option 1: Using cURL

**Test main menu:**
```bash
curl -X POST https://backend-7cxc.onrender.com/api/$1/api/ussd \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "serviceCode": "*384*123#",
    "phoneNumber": "+250788123456",
    "text": ""
  }'
```

**Test booking flow (destination selection):**
```bash
curl -X POST https://backend-7cxc.onrender.com/api/$1/api/ussd \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "phoneNumber": "+250788123456",
    "text": "1"
  }'
```

**Test complete booking (confirm):**
```bash
curl -X POST https://backend-7cxc.onrender.com/api/$1/api/ussd \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "TEST123",
    "phoneNumber": "+250788123456",
    "text": "1*2*15*1"
  }'
```

### Option 2: Using Postman

1. Create POST request to `https://backend-7cxc.onrender.com/api/$1/api/ussd`
2. Set Header: `Content-Type: application/json`
3. Body (raw JSON):
```json
{
  "sessionId": "TEST_SESSION_001",
  "serviceCode": "*384*123#",
  "phoneNumber": "+250788123456",
  "text": ""
}
```
4. Change `text` value to simulate user navigation:
   - `""` → Main menu
   - `"1"` → Book ticket (destinations)
   - `"1*2"` → Selected Huye, ask for seat
   - `"1*2*15"` → Seat 15, show confirmation
   - `"1*2*15*1"` → Confirmed booking

## 🌍 Testing with Africa's Talking Sandbox

1. **Sign up**: [Africa's Talking](https://africastalking.com/)
2. **Go to Sandbox** → USSD
3. **Create USSD Code** (e.g., `*384*123#`)
4. **Set Callback URL**: 
   - For local testing: Use [ngrok](https://ngrok.com/) to expose localhost
   ```bash
   ngrok http 5000
   ```
   - Use the ngrok URL: `https://your-ngrok-id.ngrok.io/api/ussd`
5. **Test on phone** or use Simulator

## 🔌 Database Integration (Next Steps)

Current implementation uses mock data. To connect to a real database:

### 1. Update `isSeatAvailable()` function
```javascript
const isSeatAvailable = async (destination, seatNumber) => {
  const { Schedule, Seat } = require('../models');
  
  // Find active schedule for destination
  const schedule = await Schedule.findOne({
    where: { destination, status: 'ACTIVE' }
  });
  
  if (!schedule) return false;
  
  // Check if seat is available
  const seat = await Seat.findOne({
    where: { 
      schedule_id: schedule.id,
      seat_number: seatNumber,
      status: 'AVAILABLE'
    }
  });
  
  return seat !== null;
};
```

### 2. Update booking confirmation
```javascript
// In handleBookingFlow, level 4:
const { Ticket, Seat } = require('../models');

// Create ticket in database
const ticket = await Ticket.create({
  user_phone: phoneNumber,
  schedule_id: scheduleId,
  seat_number: seatNumber,
  destination: destination.name,
  price: destination.price,
  status: 'PENDING_PAYMENT'
});

// Mark seat as booked
await Seat.update(
  { status: 'BOOKED', ticket_id: ticket.id },
  { where: { id: seatId } }
);
```

### 3. Update ticket cancellation
```javascript
const ticketExists = async (ticketId) => {
  const { Ticket } = require('../models');
  const ticket = await Ticket.findOne({ 
    where: { ticket_id: ticketId } 
  });
  return ticket !== null;
};

// In cancellation confirmation:
await Ticket.update(
  { status: 'CANCELLED' },
  { where: { ticket_id: ticketId } }
);

// Free up the seat
await Seat.update(
  { status: 'AVAILABLE', ticket_id: null },
  { where: { ticket_id: ticketId } }
);
```

### 4. Update schedule queries
```javascript
const schedules = async (route) => {
  const { Schedule } = require('../models');
  const [origin, destination] = route.split('-');
  
  const results = await Schedule.findAll({
    where: {
      origin,
      destination,
      status: 'ACTIVE',
      departure_date: { [Op.gte]: new Date() }
    },
    order: [['departure_time', 'ASC']],
    limit: 5
  });
  
  return results.map(s => s.departure_time);
};
```

## 🛡️ Security Considerations

1. **Validate Phone Numbers**: Verify user identity
2. **Session Management**: Track user sessions to prevent abuse
3. **Rate Limiting**: Add rate limiting middleware
4. **Input Sanitization**: Already implemented basic validation
5. **Payment Integration**: Add M-Pesa/MTN Mobile Money

## 📊 Adding New Destinations

Simply update the `destinations` object in `ussdController.js`:

```javascript
const destinations = {
  '1': { name: 'Kigali', price: 1500 },
  '2': { name: 'Huye', price: 2500 },
  '3': { name: 'Musanze', price: 3000 },
  '4': { name: 'Rubavu', price: 3500 },  // NEW
  '5': { name: 'Rusizi', price: 5000 }   // NEW
};
```

The menu automatically updates!

## 🐛 Debugging

Enable detailed logging:
```javascript
// In ussdController.js
console.log('User Input Array:', userInputs);
console.log('Current Level:', level);
console.log('Selected Options:', { destination, seat, confirmation });
```

## 📱 Example User Journey

```
User dials: *384*123#

Screen 1:
CON Welcome to SafariTix
1. Book Ticket
2. Cancel Ticket
3. Check Bus Schedule

User types: 1

Screen 2:
CON Choose destination:
1. Kigali
2. Huye
3. Musanze

User types: 2

Screen 3:
CON Enter seat number (1-50):

User types: 15

Screen 4:
CON Confirm booking:
Destination: Huye
Seat: 15
Price: 2500 RWF

1. Confirm
2. Cancel

User types: 1

Screen 5:
END Ticket booked to Huye.
Seat: 15
Ticket ID: TKT1234567890
Pay 2500 RWF at station.

[Session ends]
```

## 🤝 Contributing

To extend functionality:
1. Add new menu options at the main menu level
2. Create handler functions following the existing pattern
3. Update the main `handleUSSD` function to route to your new handler
4. Test thoroughly with mock data before database integration

## 📞 Support

For Africa's Talking API issues:
- [Documentation](https://developers.africastalking.com/docs/ussd/overview)
- [Community](https://community.africastalking.com/)

## ✅ Checklist Before Going Live

- [ ] Test all menu flows
- [ ] Connect to production database
- [ ] Add payment gateway integration
- [ ] Implement SMS confirmations
- [ ] Add logging and monitoring
- [ ] Set up error alerts
- [ ] Configure production CORS
- [ ] Add rate limiting
- [ ] Test with real phone numbers
- [ ] Document API for team

---

**Built with ❤️ for SafariTix**
