/**
 * USSD Testing Script for SafariTix - PRODUCTION VERSION
 * Tests all USSD flows with database integration
 * 
 * Usage: node test-ussd-production.js
 * 
 * This script simulates Africa's Talking USSD requests
 * and tests real database operations
 */

require('dotenv').config();
const axios = require('axios');

// Configuration
const BASE_URL = process.env.APP_URL || 'https://backend-7cxc.onrender.com/api/$1';
const USSD_ENDPOINT = `${BASE_URL}/api/ussd`;

// Test session data
const testSession = {
  sessionId: 'TEST_SESSION_' + Date.now(),
  serviceCode: '*384*123#',
  phoneNumber: '+250788123456'
};

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

/**
 * Send USSD request
 */
async function sendUSSDRequest(text, description = '') {
  try {
    console.log(`\n${colors.cyan}═══════════════════════════════════════${colors.reset}`);
    if (description) {
      console.log(`${colors.bright}${colors.magenta}${description}${colors.reset}`);
    }
    console.log(`${colors.yellow}Input:${colors.reset} "${text}"`);
    console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);

    const response = await axios.post(USSD_ENDPOINT, {
      ...testSession,
      text: text
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    const responseText = response.data;
    const isContinue = responseText.startsWith('CON');
    const statusColor = isContinue ? colors.green : colors.blue;

    console.log(`${statusColor}Response (${isContinue ? 'CONTINUE' : 'END'}):${colors.reset}`);
    console.log(responseText.replace(/^(CON|END)\s*/, ''));
    console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}\n`);

    return responseText;

  } catch (error) {
    console.error(`${colors.red}ERROR:${colors.reset}`, error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Pause execution
 */
function pause(ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test 1: Check server and database
 */
async function testServerHealth() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 1: Server & Database Health Check${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  try {
    const response = await axios.get(`${BASE_URL}/api/health`);
    console.log(`${colors.green}✓ Server Status:${colors.reset} ${response.data.status}`);
    console.log(`${colors.green}✓ Database:${colors.reset} ${response.data.database}`);
    console.log(`${colors.green}✓ USSD Service:${colors.reset} ${response.data.ussd}`);
    return true;
  } catch (error) {
    console.error(`${colors.red}✗ Server not responding${colors.reset}`);
    return false;
  }
}

/**
 * Test 2: Main Menu
 */
async function testMainMenu() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 2: Main Menu${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  const response = await sendUSSDRequest('', '📱 Initial USSD dial');
  
  if (response.includes('Welcome to SafariTix') && response.includes('Book Ticket')) {
    console.log(`${colors.green}✓ Test PASSED${colors.reset}`);
    return true;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Test 3: Booking Flow - View Routes
 */
async function testViewRoutes() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 3: View Available Routes${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  const response = await sendUSSDRequest('1', '🚌 Select "Book Ticket"');
  
  if (response.includes('CON') && (response.includes('route') || response.includes('→'))) {
    console.log(`${colors.green}✓ Test PASSED - Routes loaded from database${colors.reset}`);
    return true;
  } else if (response.includes('No routes available')) {
    console.log(`${colors.yellow}⚠ No routes in database - Create some routes first${colors.reset}`);
    return false;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Test 4: Check Ticket Flow
 */
async function testCheckTicket() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 4: Check Ticket Flow${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  // New session for this test
  testSession.sessionId = 'CHECK_' + Date.now();

  const response1 = await sendUSSDRequest('2', '🎫 Select "Check Ticket"');
  
  if (!response1.includes('Enter your booking reference')) {
    console.log(`${colors.red}✗ Test FAILED - Unexpected response${colors.reset}`);
    return false;
  }

  // Try with invalid ticket
  const response2 = await sendUSSDRequest('2*INVALID', '❌ Enter invalid booking ref');
  
  if (response2.includes('Invalid booking reference') || response2.includes('not found')) {
    console.log(`${colors.green}✓ Test PASSED - Validation working${colors.reset}`);
    return true;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Test 5: Cancel Ticket Flow
 */
async function testCancelTicket() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 5: Cancel Ticket Flow${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  // New session
  testSession.sessionId = 'CANCEL_' + Date.now();

  const response1 = await sendUSSDRequest('3', '🚫 Select "Cancel Ticket"');
  
  if (response1.includes('Enter your booking reference')) {
    console.log(`${colors.green}✓ Test PASSED - Cancel flow initiated${colors.reset}`);
    return true;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Test 6: Help Menu
 */
async function testHelpMenu() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 6: Help Menu${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  // New session
  testSession.sessionId = 'HELP_' + Date.now();

  const response = await sendUSSDRequest('4', 'ℹ️ Select "Help"');
  
  if (response.includes('SafariTix') && response.includes('END')) {
    console.log(`${colors.green}✓ Test PASSED - Help menu displayed${colors.reset}`);
    return true;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Test 7: Invalid Input Handling
 */
async function testInvalidInput() {
  console.log(`\n${colors.bright}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST 7: Invalid Input Handling${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  // New session
  testSession.sessionId = 'INVALID_' + Date.now();

  const response = await sendUSSDRequest('99', '⚠️ Enter invalid option');
  
  if (response.includes('Invalid') && response.includes('END')) {
    console.log(`${colors.green}✓ Test PASSED - Error handling working${colors.reset}`);
    return true;
  } else {
    console.log(`${colors.red}✗ Test FAILED${colors.reset}`);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log(`\n${colors.bright}${colors.cyan}╔═══════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}║  SafariTix USSD - Production Test Suite      ║${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╚═══════════════════════════════════════════════╝${colors.reset}\n`);

  const results = [];

  try {
    // Test 1: Health Check
    results.push({ name: 'Server Health', passed: await testServerHealth() });
    await pause(500);

    // Test 2: Main Menu
    results.push({ name: 'Main Menu', passed: await testMainMenu() });
    await pause(500);

    // Test 3: View Routes
    results.push({ name: 'View Routes', passed: await testViewRoutes() });
    await pause(500);

    // Test 4: Check Ticket
    results.push({ name: 'Check Ticket', passed: await testCheckTicket() });
    await pause(500);

    // Test 5: Cancel Ticket
    results.push({ name: 'Cancel Ticket', passed: await testCancelTicket() });
    await pause(500);

    // Test 6: Help Menu
    results.push({ name: 'Help Menu', passed: await testHelpMenu() });
    await pause(500);

    // Test 7: Invalid Input
    results.push({ name: 'Invalid Input', passed: await testInvalidInput() });

  } catch (error) {
    console.error(`\n${colors.red}Test suite interrupted:${colors.reset}`, error.message);
  }

  // Summary
  console.log(`\n${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}TEST SUMMARY${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach(result => {
    const icon = result.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`${icon} ${result.name}`);
  });

  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}Total: ${passed}/${total} passed${colors.reset}`);

  if (passed === total) {
    console.log(`${colors.green}${colors.bright}🎉 All tests passed!${colors.reset}\n`);
  } else {
    console.log(`${colors.yellow}${colors.bright}⚠️ Some tests failed${colors.reset}\n`);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
