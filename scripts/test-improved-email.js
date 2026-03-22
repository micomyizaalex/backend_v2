require('dotenv').config();
const { sendETicketEmail } = require('../services/eTicketService');

console.log('🧪 ===== TESTING IMPROVED E-TICKET SYSTEM =====\n');

async function testEmailWithVariousScenarios() {
  const testEmail = process.env.SMTP_USER || 'test@example.com';
  
  console.log('📋 Running 3 test scenarios...\n');
  
  // TEST 1: Normal case with valid departure_time
  console.log('══════════════════════════════════════════════');
  console.log('TEST 1: Normal case with valid timestamp');
  console.log('══════════════════════════════════════════════');
  
  const result1 = await sendETicketEmail({
    userEmail: testEmail,
    userName: 'John Doe',
    tickets: [{
      id: 'test-ticket-001',
      booking_ref: 'BK-2026-TEST001',
      seat_number: 'A1',
      price: 5000
    }],
    scheduleInfo: {
      origin: 'Kigali',
      destination: 'Musanze',
      departure_time: '2026-02-25T10:00:00.000Z', // Valid ISO timestamp
      bus_plate: 'RAD 123 B'
    },
    companyInfo: {
      name: 'SafariTix Transport'
    }
  });
  
  console.log('\n✅ Test 1 Result:', result1);
  console.log('\n');
  
  // TEST 2: Edge case - undefined departure_time (should show TBD)
  console.log('══════════════════════════════════════════════');
  console.log('TEST 2: Edge case - undefined departure_time');
  console.log('══════════════════════════════════════════════');
  
  const result2 = await sendETicketEmail({
    userEmail: testEmail,
    userName: 'Jane Smith',
    tickets: [{
      id: 'test-ticket-002',
      booking_ref: 'BK-2026-TEST002',
      seat_number: 'B3',
      price: 3500
    }],
    scheduleInfo: {
      origin: 'Huye',
      destination: 'Kigali',
      departure_time: null, // NULL - should show TBD
      bus_plate: 'RAC 456 A'
    },
    companyInfo: {
      name: 'SafariTix Transport'
    }
  });
  
  console.log('\n✅ Test 2 Result:', result2);
  console.log('\n');
  
  // TEST 3: Edge case - malformed date string
  console.log('══════════════════════════════════════════════');
  console.log('TEST 3: Edge case - malformed date string');
  console.log('══════════════════════════════════════════════');
  
  const result3 = await sendETicketEmail({
    userEmail: testEmail,
    userName: 'Test User',
    tickets: [{
      id: 'test-ticket-003',
      booking_ref: 'BK-2026-TEST003',
      seat_number: 'C5',
      price: 4200
    }],
    scheduleInfo: {
      origin: 'Rubavu',
      destination: 'Muhanga',
      departure_time: 'invalid-date-string', // Invalid - should show TBD
      bus_plate: 'RAB 789 C'
    },
    companyInfo: {
      name: 'SafariTix Transport'
    }
  });
  
  console.log('\n✅ Test 3 Result:', result3);
  console.log('\n');
  
  // TEST 4: Time-only string (HH:MM format)
  console.log('══════════════════════════════════════════════');
  console.log('TEST 4: Time string format (HH:MM)');
  console.log('══════════════════════════════════════════════');
  
  const result4 = await sendETicketEmail({
    userEmail: testEmail,
    userName: 'Alice Johnson',
    tickets: [{
      id: 'test-ticket-004',
      booking_ref: 'BK-2026-TEST004',
      seat_number: 'D2',
      price: 6000
    }],
    scheduleInfo: {
      origin: 'Kigali',
      destination: 'Rwamagana',
      departure_time: '14:30:00', // Time-only format
      bus_plate: 'RAD 111 X'
    },
    companyInfo: {
      name: 'SafariTix Transport'
    }
  });
  
  console.log('\n✅ Test 4 Result:', result4);
  console.log('\n');
  
  console.log('══════════════════════════════════════════════');
  console.log('🎉 ALL TESTS COMPLETED!');
  console.log('══════════════════════════════════════════════');
  console.log('\n📬 Check your inbox at:', testEmail);
  console.log('\n🔍 What to verify in emails:');
  console.log('  1. ✅ No "Invalid Date" anywhere');
  console.log('  2. ✅ QR codes visible in all emails');
  console.log('  3. ✅ Fallback "TBD" shown when date/time missing');
  console.log('  4. ✅ All booking details correct');
  console.log('  5. ✅ Professional formatting maintained');
  console.log('\n💡 If QR fails, you should see "QR Code Unavailable" with booking ref');
}

testEmailWithVariousScenarios()
  .then(() => {
    console.log('\n✅ All test scenarios executed successfully\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
