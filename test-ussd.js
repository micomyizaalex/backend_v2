/**
 * USSD Testing Script for SafariTix
 * 
 * Usage: node test-ussd.js
 * 
 * This script simulates Africa's Talking USSD requests
 * to test the USSD menu flows locally
 */

const axios = require('axios');

// Configuration
const BASE_URL = 'https://backend-v2-wjcs.onrender.com/api/$1';
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
  cyan: '\x1b[36m'
};

/**
 * Send USSD request
 */
async function sendUSSDRequest(text, description = '') {
  try {
    console.log(`\n${colors.cyan}═══════════════════════════════════════${colors.reset}`);
    if (description) {
      console.log(`${colors.bright}${description}${colors.reset}`);
    }
    console.log(`${colors.yellow}Input:${colors.reset} "${text}"`);
    console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);

    const response = await axios.post(USSD_ENDPOINT, {
      ...testSession,
      text: text
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const responseText = response.data;
    const isContinue = responseText.startsWith('CON');
    const isEnd = responseText.startsWith('END');

    console.log(`${colors.green}Response:${colors.reset}`);
    console.log(responseText);
    
    if (isContinue) {
      console.log(`${colors.blue}[Session continues...]${colors.reset}`);
    } else if (isEnd) {
      console.log(`${colors.red}[Session ended]${colors.reset}`);
    }

    return responseText;

  } catch (error) {
    console.error(`${colors.red}Error:${colors.reset}`, error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Test Suite: Main Menu
 */
async function testMainMenu() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: MAIN MENU                   ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Step 1: Initial dial (empty text)');
}

/**
 * Test Suite: Booking Flow
 */
async function testBookingFlow() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: BOOKING FLOW                ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Step 1: Main menu');
  await sendUSSDRequest('1', 'Step 2: Select "Book Ticket"');
  await sendUSSDRequest('1*2', 'Step 3: Select destination "Huye"');
  await sendUSSDRequest('1*2*15', 'Step 4: Enter seat number "15"');
  await sendUSSDRequest('1*2*15*1', 'Step 5: Confirm booking');
}

/**
 * Test Suite: Booking Flow - Cancellation
 */
async function testBookingCancellation() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: BOOKING CANCELLATION        ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('1', 'Step 1: Select "Book Ticket"');
  await sendUSSDRequest('1*1', 'Step 2: Select destination "Kigali"');
  await sendUSSDRequest('1*1*8', 'Step 3: Enter seat number "8"');
  await sendUSSDRequest('1*1*8*2', 'Step 4: Cancel booking');
}

/**
 * Test Suite: Ticket Cancellation Flow
 */
async function testTicketCancellation() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: TICKET CANCELLATION         ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Step 1: Main menu');
  await sendUSSDRequest('2', 'Step 2: Select "Cancel Ticket"');
  await sendUSSDRequest('2*TKT123456', 'Step 3: Enter ticket ID');
  await sendUSSDRequest('2*TKT123456*1', 'Step 4: Confirm cancellation');
}

/**
 * Test Suite: Schedule Check Flow
 */
async function testScheduleCheck() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: SCHEDULE CHECK              ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Step 1: Main menu');
  await sendUSSDRequest('3', 'Step 2: Select "Check Bus Schedule"');
  await sendUSSDRequest('3*1', 'Step 3: Select route "Kigali-Huye"');
}

/**
 * Test Suite: Schedule Check - Option 2
 */
async function testScheduleCheck2() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: SCHEDULE CHECK (Route 2)    ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('3', 'Step 1: Select "Check Bus Schedule"');
  await sendUSSDRequest('3*2', 'Step 2: Select route "Kigali-Musanze"');
}

/**
 * Test Suite: Invalid Inputs
 */
async function testInvalidInputs() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: INVALID INPUTS              ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('9', 'Test: Invalid main menu option');
  await sendUSSDRequest('1*9', 'Test: Invalid destination');
  await sendUSSDRequest('1*1*abc', 'Test: Invalid seat number (letters)');
}

/**
 * Test Suite: Full Journey - Kigali
 */
async function testFullJourneyKigali() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: COMPLETE JOURNEY (Kigali)   ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Dial code');
  await sendUSSDRequest('1', 'Book ticket');
  await sendUSSDRequest('1*1', 'Destination: Kigali');
  await sendUSSDRequest('1*1*25', 'Seat: 25');
  await sendUSSDRequest('1*1*25*1', 'Confirm');
}

/**
 * Test Suite: Full Journey - Musanze
 */
async function testFullJourneyMusanze() {
  console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.green}║     TEST: COMPLETE JOURNEY (Musanze)  ║${colors.reset}`);
  console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}`);
  
  await sendUSSDRequest('', 'Dial code');
  await sendUSSDRequest('1', 'Book ticket');
  await sendUSSDRequest('1*3', 'Destination: Musanze');
  await sendUSSDRequest('1*3*42', 'Seat: 42');
  await sendUSSDRequest('1*3*42*1', 'Confirm');
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log(`\n${colors.bright}${colors.blue}╔════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}║  SafariTix USSD Testing Suite                  ║${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}║  Testing endpoint: ${USSD_ENDPOINT.padEnd(29)}║${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}╚════════════════════════════════════════════════╝${colors.reset}`);

  try {
    // Check if server is running
    console.log(`\n${colors.yellow}Checking server health...${colors.reset}`);
    await axios.get(`${BASE_URL}/api/health`);
    console.log(`${colors.green}✓ Server is running${colors.reset}`);

    // Run test suites
    await testMainMenu();
    await testBookingFlow();
    await testBookingCancellation();
    await testTicketCancellation();
    await testScheduleCheck();
    await testScheduleCheck2();
    await testInvalidInputs();
    await testFullJourneyKigali();
    await testFullJourneyMusanze();

    console.log(`\n${colors.bright}${colors.green}╔═══════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.bright}${colors.green}║  ✓ ALL TESTS COMPLETED SUCCESSFULLY   ║${colors.reset}`);
    console.log(`${colors.bright}${colors.green}╚═══════════════════════════════════════╝${colors.reset}\n`);

  } catch (error) {
    console.error(`\n${colors.red}╔═══════════════════════════════════════╗${colors.reset}`);
    console.error(`${colors.red}║  ✗ TEST SUITE FAILED                  ║${colors.reset}`);
    console.error(`${colors.red}╚═══════════════════════════════════════╝${colors.reset}`);
    console.error(`\n${colors.red}Error:${colors.reset}`, error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error(`\n${colors.yellow}Make sure the server is running:${colors.reset}`);
      console.error(`  cd backend_v2`);
      console.error(`  npm start`);
    }
    
    process.exit(1);
  }
}

/**
 * Interactive mode - run specific test
 */
async function interactiveMode() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`\n${colors.bright}Interactive USSD Testing Mode${colors.reset}`);
  console.log(`Enter USSD text input (or 'quit' to exit):\n`);

  const askQuestion = () => {
    rl.question(`${colors.cyan}USSD Input:${colors.reset} `, async (text) => {
      if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
        console.log('Goodbye!');
        rl.close();
        return;
      }

      try {
        await sendUSSDRequest(text, 'Interactive Test');
      } catch (error) {
        console.error('Error:', error.message);
      }

      askQuestion();
    });
  };

  askQuestion();
}

// Main execution
const args = process.argv.slice(2);

if (args.includes('--interactive') || args.includes('-i')) {
  interactiveMode();
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
SafariTix USSD Testing Script

Usage:
  node test-ussd.js              Run all test suites
  node test-ussd.js -i           Interactive mode (manual testing)
  node test-ussd.js --help       Show this help message

Examples:
  node test-ussd.js
  node test-ussd.js --interactive
  `);
} else {
  runAllTests();
}
