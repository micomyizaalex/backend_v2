#!/usr/bin/env node
/**
 * Test booking with email - simulates a real booking to debug email issues
 * Usage: node scripts/test-booking-with-email.js <user-email>
 */

require('dotenv').config();
const pool = require('../config/pgPool');
const { sendTicketConfirmationEmail } = require('../services/emailService');

async function testBookingEmail() {
  const userEmail = process.argv[2] || 'micomyizaa742@gmail.com';
  
  console.log('🧪 Testing booking email for:', userEmail);
  console.log('');
  
  let client;
  try {
    client = await pool.connect();
    
    // Find user by email
    console.log('1️⃣ Looking up user...');
    const userQuery = await client.query(
      'SELECT id, email, full_name FROM users WHERE email ILIKE $1',
      [userEmail]
    );
    
    if (userQuery.rows.length === 0) {
      console.error('❌ User not found with email:', userEmail);
      console.log('\nTry:');
      console.log('  node scripts/find-user-by-email.js', userEmail.split('@')[0]);
      process.exit(1);
    }
    
    const user = userQuery.rows[0];
    console.log('✅ Found user:', user.full_name, '(' + user.email + ')');
    console.log('');
    
    // Find a recent schedule
    console.log('2️⃣ Finding an available schedule...');
    const scheduleQuery = await client.query(`
      SELECT 
        s.id, 
        s.origin, 
        s.destination, 
        s.departure_time, 
        s.bus_id,
        s.company_id,
        b.plate_number as bus_plate,
        s.price_per_seat
      FROM schedules s
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE s.status = 'scheduled'
      AND s.available_seats > 0
      ORDER BY s.created_at DESC
      LIMIT 1
    `);
    
    if (scheduleQuery.rows.length === 0) {
      console.error('❌ No available schedules found');
      process.exit(1);
    }
    
    const schedule = scheduleQuery.rows[0];
    console.log('✅ Found schedule:', schedule.origin, '→', schedule.destination);
    console.log('   Bus:', schedule.bus_plate || 'Unknown');
    console.log('   Departure:', schedule.departure_time ? new Date(schedule.departure_time).toLocaleString() : 'Not set');
    console.log('');
    
    // Simulate ticket data
    console.log('3️⃣ Preparing test ticket data...');
    const testTickets = [
      {
        seat_number: 'TEST-A1',
        booking_ref: `BK-TEST-${Date.now()}`,
        price: parseFloat(schedule.price_per_seat || 5000)
      }
    ];
    console.log('✅ Test ticket:', testTickets[0].booking_ref, '- Seat', testTickets[0].seat_number);
    console.log('');
    
    // Send email
    console.log('4️⃣ Sending confirmation email...');
    const emailResult = await sendTicketConfirmationEmail({
      userEmail: user.email,
      userName: user.full_name || 'Valued Customer',
      tickets: testTickets,
      scheduleInfo: {
        origin: schedule.origin,
        destination: schedule.destination,
        departure_time: schedule.departure_time,
        bus_plate: schedule.bus_plate
      }
    });
    
    console.log('');
    if (emailResult.success) {
      console.log('✅ SUCCESS! Email sent to:', user.email);
      console.log('');
      console.log('📬 Check your inbox (it may take a few moments)');
      console.log('   - Check spam/junk folder if not in inbox');
      console.log('   - Subject: 🎫 Your SafariTix Ticket Confirmation - 1 Seat');
    } else {
      console.log('❌ FAILED! Email not sent');
      console.log('   Error:', emailResult.error);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    if (client) client.release();
  }
  
  process.exit(0);
}

testBookingEmail();
