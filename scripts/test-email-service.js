#!/usr/bin/env node
/**
 * Test script for email service
 * Tests sending a ticket confirmation email
 * 
 * Usage: node scripts/test-email-service.js
 */

require('dotenv').config();
const { sendTicketConfirmationEmail } = require('../services/emailService');

async function testEmailService() {
  console.log('🧪 Testing Email Service...\n');
  
  // Check if SMTP is configured
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.error('❌ SMTP not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env file');
    console.log('\nFor Gmail:');
    console.log('1. Enable 2-factor authentication in your Google Account');
    console.log('2. Generate an App Password: https://myaccount.google.com/apppasswords');
    console.log('3. Add to .env:');
    console.log('   SMTP_HOST=smtp.gmail.com');
    console.log('   SMTP_PORT=587');
    console.log('   SMTP_USER=your-email@gmail.com');
    console.log('   SMTP_PASS=your-app-password');
    process.exit(1);
  }
  
  console.log('📧 SMTP Configuration:');
  console.log(`   Host: ${process.env.SMTP_HOST}`);
  console.log(`   Port: ${process.env.SMTP_PORT}`);
  console.log(`   User: ${process.env.SMTP_USER}`);
  console.log(`   From: ${process.env.SMTP_FROM_EMAIL}`);
  console.log('');
  
  // Sample ticket data
  const testData = {
    userEmail: process.env.SMTP_USER, // Send to yourself for testing
    userName: 'Test User',
    tickets: [
      {
        seat_number: 'A1',
        booking_ref: 'BK-TEST-123456',
        price: 5000
      },
      {
        seat_number: 'A2',
        booking_ref: 'BK-TEST-123457',
        price: 5000
      }
    ],
    scheduleInfo: {
      origin: 'Kigali',
      destination: 'Musanze',
      departure_time: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
      bus_plate: 'RAD 123 B'
    }
  };
  
  console.log('📨 Sending test email to:', testData.userEmail);
  console.log('');
  
  try {
    const result = await sendTicketConfirmationEmail(testData);
    
    if (result.success) {
      console.log('✅ Test email sent successfully!');
      console.log('\n📬 Check your inbox at:', testData.userEmail);
      console.log('   (It may take a few moments to arrive)');
    } else {
      console.error('❌ Failed to send test email:', result.error);
    }
  } catch (error) {
    console.error('❌ Error sending test email:', error.message);
    console.error(error);
  }
}

testEmailService()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
