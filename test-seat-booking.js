/**
 * Test Script for Production-Ready Seat Booking API
 * 
 * This script demonstrates how to test the new bookSeatsWithConcurrencySafety endpoint
 * Run with: node test-seat-booking.js
 */

require('dotenv').config();
const fetch = require('node-fetch');

const API_URL = process.env.API_URL || 'https://backend-v2-wjcs.onrender.com/api/$1';

// Test configuration
const TEST_CONFIG = {
  // Replace these with actual values from your database
  scheduleId: 'YOUR_SCHEDULE_UUID',
  busId: 'YOUR_BUS_UUID',
  seatNumbers: ['10', '11', '12'],
  pricePerSeat: 5000,
  // Get this from logging in a user
  accessToken: 'YOUR_ACCESS_TOKEN'
};

/**
 * Helper function to make API request
 */
async function bookSeats(scheduleId, busId, seatNumbers, accessToken, pricePerSeat) {
  const response = await fetch(`${API_URL}/api/seats/book-seats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      scheduleId,
      busId,
      seatNumbers,
      pricePerSeat
    })
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Helper function to get seat map
 */
async function getSeatMap(scheduleId, accessToken = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_URL}/api/seats/schedules/${scheduleId}`, {
    method: 'GET',
    headers
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Test 1: Successful booking
 */
async function testSuccessfulBooking() {
  console.log('\n=== TEST 1: Successful Booking ===');
  
  try {
    const result = await bookSeats(
      TEST_CONFIG.scheduleId,
      TEST_CONFIG.busId,
      TEST_CONFIG.seatNumbers,
      TEST_CONFIG.accessToken,
      TEST_CONFIG.pricePerSeat
    );

    console.log('Status:', result.status);
    console.log('Response:', JSON.stringify(result.data, null, 2));

    if (result.data.success) {
      console.log('\n✅ TEST PASSED: Seats booked successfully');
      console.log(`   Booked seats: ${result.data.booking.tickets.map(t => t.seat_number).join(', ')}`);
      console.log(`   Total price: ${result.data.booking.totalPrice}`);
      console.log(`   Remaining seats: ${result.data.schedule.available_seats}`);
    } else {
      console.log('\n❌ TEST FAILED:', result.data.error);
    }
  } catch (error) {
    console.error('\n❌ TEST ERROR:', error.message);
  }
}

/**
 * Test 2: Duplicate booking (should fail)
 */
async function testDuplicateBooking() {
  console.log('\n=== TEST 2: Duplicate Booking (Should Fail) ===');
  
  try {
    // Try to book the same seats again
    const result = await bookSeats(
      TEST_CONFIG.scheduleId,
      TEST_CONFIG.busId,
      TEST_CONFIG.seatNumbers,
      TEST_CONFIG.accessToken,
      TEST_CONFIG.pricePerSeat
    );

    console.log('Status:', result.status);
    console.log('Response:', JSON.stringify(result.data, null, 2));

    if (!result.data.success && result.status === 409) {
      console.log('\n✅ TEST PASSED: Duplicate booking correctly rejected');
      console.log(`   Error message: ${result.data.message}`);
    } else {
      console.log('\n❌ TEST FAILED: Duplicate booking should have been rejected');
    }
  } catch (error) {
    console.error('\n❌ TEST ERROR:', error.message);
  }
}

/**
 * Test 3: Verify seat map shows seats as occupied
 */
async function testSeatMapUpdate() {
  console.log('\n=== TEST 3: Verify Seat Map Update ===');
  
  try {
    const result = await getSeatMap(TEST_CONFIG.scheduleId, TEST_CONFIG.accessToken);

    console.log('Status:', result.status);
    
    if (result.data.seats) {
      const bookedSeats = result.data.seats.filter(seat => 
        TEST_CONFIG.seatNumbers.includes(seat.seat_number)
      );

      console.log('\nBooked seats status:');
      bookedSeats.forEach(seat => {
        console.log(`   Seat ${seat.seat_number}: ${seat.state}`);
      });

      const allOccupied = bookedSeats.every(seat => seat.state === 'BOOKED');
      
      if (allOccupied) {
        console.log('\n✅ TEST PASSED: All booked seats show as BOOKED in seat map');
      } else {
        console.log('\n❌ TEST FAILED: Some seats not showing as BOOKED');
      }
    } else {
      console.log('\n❌ TEST FAILED: Could not retrieve seat map');
    }
  } catch (error) {
    console.error('\n❌ TEST ERROR:', error.message);
  }
}

/**
 * Test 4: Invalid parameters
 */
async function testInvalidParameters() {
  console.log('\n=== TEST 4: Invalid Parameters (Should Fail) ===');
  
  const tests = [
    {
      name: 'Missing scheduleId',
      params: { busId: TEST_CONFIG.busId, seatNumbers: ['1'], accessToken: TEST_CONFIG.accessToken }
    },
    {
      name: 'Missing busId',
      params: { scheduleId: TEST_CONFIG.scheduleId, seatNumbers: ['1'], accessToken: TEST_CONFIG.accessToken }
    },
    {
      name: 'Empty seatNumbers',
      params: { scheduleId: TEST_CONFIG.scheduleId, busId: TEST_CONFIG.busId, seatNumbers: [], accessToken: TEST_CONFIG.accessToken }
    },
    {
      name: 'Missing authentication',
      params: { scheduleId: TEST_CONFIG.scheduleId, busId: TEST_CONFIG.busId, seatNumbers: ['1'], accessToken: null }
    }
  ];

  for (const test of tests) {
    try {
      const response = await fetch(`${API_URL}/api/seats/book-seats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(test.params.accessToken && { 'Authorization': `Bearer ${test.params.accessToken}` })
        },
        body: JSON.stringify({
          scheduleId: test.params.scheduleId,
          busId: test.params.busId,
          seatNumbers: test.params.seatNumbers
        })
      });

      const data = await response.json();

      if (!data.success && (response.status === 400 || response.status === 401)) {
        console.log(`\n✅ ${test.name}: Correctly rejected (${response.status})`);
      } else {
        console.log(`\n❌ ${test.name}: Should have been rejected`);
      }
    } catch (error) {
      console.error(`\n❌ ${test.name} ERROR:`, error.message);
    }
  }
}

/**
 * Test 5: Concurrent booking simulation
 */
async function testConcurrentBooking() {
  console.log('\n=== TEST 5: Concurrent Booking (2 users, same seat) ===');
  
  const singleSeat = ['20']; // A different seat for this test
  const user1Token = TEST_CONFIG.accessToken;
  const user2Token = TEST_CONFIG.accessToken; // In real test, use different token

  try {
    // Simulate two users trying to book the same seat simultaneously
    const [result1, result2] = await Promise.all([
      bookSeats(TEST_CONFIG.scheduleId, TEST_CONFIG.busId, singleSeat, user1Token),
      bookSeats(TEST_CONFIG.scheduleId, TEST_CONFIG.busId, singleSeat, user2Token)
    ]);

    console.log('\nUser 1 result:', result1.status, result1.data.success ? 'SUCCESS' : 'FAILED');
    console.log('User 2 result:', result2.status, result2.data.success ? 'SUCCESS' : 'FAILED');

    // One should succeed, one should fail
    const oneSuccess = (result1.data.success && !result2.data.success) || 
                       (!result1.data.success && result2.data.success);

    if (oneSuccess) {
      console.log('\n✅ TEST PASSED: Concurrency control working - only one booking succeeded');
    } else if (result1.data.success && result2.data.success) {
      console.log('\n❌ TEST FAILED: Both bookings succeeded - concurrency issue!');
    } else {
      console.log('\n⚠️  Both failed - possible test setup issue');
    }
  } catch (error) {
    console.error('\n❌ TEST ERROR:', error.message);
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('===============================================');
  console.log('  Production Seat Booking API - Test Suite');
  console.log('===============================================');
  console.log('\nAPI URL:', API_URL);
  console.log('Schedule ID:', TEST_CONFIG.scheduleId);
  console.log('Bus ID:', TEST_CONFIG.busId);
  console.log('Seats to book:', TEST_CONFIG.seatNumbers.join(', '));

  // Verify configuration
  if (TEST_CONFIG.scheduleId === 'YOUR_SCHEDULE_UUID') {
    console.error('\n❌ ERROR: Please update TEST_CONFIG with actual values from your database');
    console.log('\nPlease edit this file and set:');
    console.log('  - scheduleId: A valid schedule UUID from your schedules table');
    console.log('  - busId: A valid bus UUID from your buses table');
    console.log('  - accessToken: A valid JWT token from logging in');
    console.log('\nYou can get an access token by:');
    console.log('  1. POST /api/auth/login with username and password');
    console.log('  2. Copy the accessToken from the response');
    return;
  }

  try {
    await testSuccessfulBooking();
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

    await testDuplicateBooking();
    await new Promise(resolve => setTimeout(resolve, 1000));

    await testSeatMapUpdate();
    await new Promise(resolve => setTimeout(resolve, 1000));

    await testInvalidParameters();
    await new Promise(resolve => setTimeout(resolve, 1000));

    await testConcurrentBooking();
  } catch (error) {
    console.error('\nTest suite error:', error);
  }

  console.log('\n===============================================');
  console.log('  Test Suite Complete');
  console.log('===============================================\n');
}

// Run tests if executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { bookSeats, getSeatMap };
