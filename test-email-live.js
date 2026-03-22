// Quick test for live email system
require('dotenv').config();
const { sendETicketEmail } = require('./services/eTicketService');

console.log('🔍 Environment Variables Check:');
console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('SMTP_PORT:', process.env.SMTP_PORT);
console.log('SMTP_USER:', process.env.SMTP_USER);
console.log('SMTP_PASS:', process.env.SMTP_PASS ? '***hidden***' : 'NOT SET');

console.log('\n📧 Testing email sending...\n');

// Test with sample data
sendETicketEmail({
  userEmail: process.env.SMTP_USER, // Send to yourself for testing
  userName: 'Test User',
  tickets: [{
    id: 999,
    seat_number: 'A1',
    booking_ref: 'TEST-' + Date.now(),
    price: 5000
  }],
  scheduleInfo: {
    origin: 'Kigali',
    destination: 'Huye',
    schedule_date: '2026-02-25',
    departure_time: '14:30:00',
    bus_plate: 'RAC 123 B'
  },
  companyInfo: {
    name: 'SafariTix Transport'
  }
}).then(() => {
  console.log('\n✅ Test email sent successfully!');
  console.log('📬 Check your inbox:', process.env.SMTP_USER);
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Failed to send test email:', err);
  process.exit(1);
});
