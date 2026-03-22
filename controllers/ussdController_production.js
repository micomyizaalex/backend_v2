/**
 * USSD Controller for SafariTix - PRODUCTION VERSION
 * Handles all USSD menu interactions for Africa's Talking integration
 * 
 * USSD Response Format:
 * - CON: Continue session (show menu/prompt)
 * - END: End session (final message)
 * 
 * Features:
 * - Dynamic routes and schedules from PostgreSQL database
 * - Real-time seat availability checking
 * - Seat locking to prevent double booking
 * - Booking with transaction safety
 * - Ticket lookup and cancellation
 * - Comprehensive error handling
 */

const ussdService = require('../services/ussdService');

// ==============================================================
// SESSION STORAGE (In-memory - use Redis for production scale)
// ==============================================================

/**
 * Session storage to track user's journey through USSD menus
 * Key: sessionId, Value: { routes, schedules, selectedRoute, selectedSchedule, etc. }
 * 
 * Note: For high-scale production, use Redis instead of in-memory storage
 */
const sessionStore = new Map();

/**
 * Get or initialize session data
 */
function getSession(sessionId) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { lastActivity: Date.now() });
  }
  const session = sessionStore.get(sessionId);
  session.lastActivity = Date.now();
  return session;
}

/**
 * Update session data
 */
function updateSession(sessionId, data) {
  const session = getSession(sessionId);
  Object.assign(session, data);
  sessionStore.set(sessionId, session);
}

/**
 * Clear a session (on completion or timeout)
 */
function clearSession(sessionId) {
  sessionStore.delete(sessionId);
}

// Cleanup old sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessionStore.entries()) {
    if (!session.lastActivity || now - session.lastActivity > 600000) { // 10 min
      sessionStore.delete(sessionId);
    }
  }
}, 600000);

// ==============================================================
// MAIN USSD HANDLER
// ==============================================================

/**
 * Main USSD handler function
 * Parses user input and routes to appropriate menu/action
 */
const handleUSSD = async (req, res) => {
  try {
    // Extract USSD parameters from request body
    const { sessionId, serviceCode, phoneNumber, text } = req.body;

    // Log incoming request for debugging
    console.log('\n=== USSD Request ===');
    console.log('Session ID:', sessionId);
    console.log('Phone:', phoneNumber);
    console.log('Text:', text || '(empty - main menu)');
    console.log('====================\n');

    let response = '';

    // Parse user input using * as delimiter
    // Example: "1*2*15" means: Book(1) → Route 2 → Seat 15
    const userInputs = text.split('*');
    const level = userInputs.length;

    // =============================================
    // MAIN MENU (Initial Request - text is empty)
    // =============================================
    if (text === '') {
      response = buildMainMenu();
    }

    // =============================================
    // OPTION 1: BOOK TICKET FLOW
    // =============================================
    else if (userInputs[0] === '1') {
      response = await handleBookingFlow(sessionId, phoneNumber, userInputs, level);
    }

    // =============================================
    // OPTION 2: CHECK TICKET FLOW
    // =============================================
    else if (userInputs[0] === '2') {
      response = await handleCheckTicketFlow(sessionId, phoneNumber, userInputs, level);
    }

    // =============================================
    // OPTION 3: CANCEL TICKET FLOW
    // =============================================
    else if (userInputs[0] === '3') {
      response = await handleCancelTicketFlow(sessionId, phoneNumber, userInputs, level);
    }

    // =============================================
    // OPTION 4: HELP
    // =============================================
    else if (userInputs[0] === '4') {
      response = buildHelpMenu();
      clearSession(sessionId);
    }

    // =============================================
    // INVALID INPUT - Error Handling
    // =============================================
    else {
      response = 'END Invalid choice. Please dial again and select 1-4.';
      clearSession(sessionId);
    }

    // Log response
    console.log('Response:', response.substring(0, 100) + '...\n');

    // Send response with correct content type for Africa's Talking
    res.set('Content-Type', 'text/plain');
    res.send(response);

  } catch (error) {
    console.error('❌ USSD Error:', error.message);
    console.error(error.stack);
    
    // Send error message and close session
    res.set('Content-Type', 'text/plain');
    res.send('END Service temporarily unavailable. Please try again later.');
  }
};

// ==============================================================
// MENU BUILDERS
// ==============================================================

/**
 * Build main menu (shown when user first dials USSD code)
 */
const buildMainMenu = () => {
  return `CON Welcome to SafariTix
1. Book Ticket
2. Check Ticket
3. Cancel Ticket
4. Help`;
};

/**
 * Build help menu
 */
const buildHelpMenu = () => {
  return `END SafariTix - Bus Ticket Booking

Book tickets: Dial USSD code and select "Book Ticket"

Check ticket: Use your booking reference (e.g., STX-ABC123)

Cancel ticket: Enter booking reference to cancel

Seats are held for ${ussdService.SEAT_LOCK_MINUTES} minutes during booking.

Thank you for using SafariTix!`;
};

// ==============================================================
// BOOKING FLOW HANDLER
// ==============================================================

/**
 * Handle ticket booking flow
 * Flow: Main → Routes → Schedules → Seats → Confirmation
 */
const handleBookingFlow = async (sessionId, phoneNumber, inputs, level) => {
  const session = getSession(sessionId);

  try {
    // ============================================
    // Level 1: Show available routes
    // ============================================
    if (level === 1) {
      const routes = await ussdService.getActiveRoutes();
      
      if (routes.length === 0) {
        clearSession(sessionId);
        return 'END No routes available at the moment. Please try again later.';
      }

      // Store routes in session
      updateSession(sessionId, { routes });

      // Build menu
      let menu = 'CON Select route:\n';
      routes.forEach((route, index) => {
        menu += `${index + 1}. ${route.origin} → ${route.destination}\n`;
      });
      return menu.trimEnd();
    }

    // ============================================
    // Level 2: Show schedules for selected route
    // ============================================
    else if (level === 2) {
      const routeIndex = parseInt(inputs[1]) - 1;
      
      if (!session.routes || routeIndex < 0 || routeIndex >= session.routes.length) {
        clearSession(sessionId);
        return 'END Invalid route selection.';
      }

      const selectedRoute = session.routes[routeIndex];
      const schedules = await ussdService.getSchedulesForRoute(selectedRoute.id);

      if (schedules.length === 0) {
        clearSession(sessionId);
        return `END No schedules available for ${selectedRoute.origin} → ${selectedRoute.destination}.`;
      }

      // Store schedules in session
      updateSession(sessionId, { schedules, selectedRoute });

      // Build menu
      let menu = `CON ${selectedRoute.origin} → ${selectedRoute.destination}\nSelect bus:\n`;
      schedules.forEach((schedule, index) => {
        const date = new Date(schedule.schedule_date).toLocaleDateString('en-GB', { 
          month: 'short', day: 'numeric' 
        });
        const time = schedule.departure_time.substring(0, 5); // HH:MM
        const price = parseFloat(schedule.price_per_seat).toLocaleString();
        menu += `${index + 1}. ${date} ${time} - RWF ${price} (${schedule.available_seats} seats)\n`;
      });
      return menu.trimEnd();
    }

    // ============================================
    // Level 3: Show available seats
    // ============================================
    else if (level === 3) {
      const scheduleIndex = parseInt(inputs[2]) - 1;

      if (!session.schedules || scheduleIndex < 0 || scheduleIndex >= session.schedules.length) {
        clearSession(sessionId);
        return 'END Invalid schedule selection.';
      }

      const selectedSchedule = session.schedules[scheduleIndex];
      const availableSeats = await ussdService.getAvailableSeats(selectedSchedule.id);

      if (availableSeats.length === 0) {
        clearSession(sessionId);
        return 'END Sorry, all seats are booked for this schedule.';
      }

      updateSession(sessionId, { selectedSchedule, availableSeats });

      // Show first 20 seats (to avoid overflow)
      const seatsToShow = availableSeats.slice(0, 20);
      let menu = `CON Available seats:\n${seatsToShow.join(', ')}`;
      
      if (availableSeats.length > 20) {
        menu += ', ...';
      }
      
      menu += `\n\nEnter seat number:`;
      return menu;
    }

    // ============================================
    // Level 4: Confirm booking
    // ============================================
    else if (level === 4) {
      const seatNumber = inputs[3].trim();

      if (!session.availableSeats || !session.availableSeats.includes(seatNumber)) {
        clearSession(sessionId);
        return 'END Invalid or unavailable seat number.';
      }

      const schedule = session.selectedSchedule;
      const route = session.selectedRoute;
      const date = new Date(schedule.schedule_date).toLocaleDateString('en-GB');
      const time = schedule.departure_time.substring(0, 5);
      const price = parseFloat(schedule.price_per_seat).toLocaleString();

      updateSession(sessionId, { selectedSeat: seatNumber });

      return `CON Confirm booking:
Route: ${route.origin} → ${route.destination}
Date: ${date}
Time: ${time}
Seat: ${seatNumber}
Price: RWF ${price}

1. Confirm
2. Cancel`;
    }

    // ============================================
    // Level 5: Process booking
    // ============================================
    else if (level === 5) {
      const confirmation = inputs[4];

      if (confirmation === '2') {
        clearSession(sessionId);
        return 'END Booking cancelled.';
      }

      if (confirmation !== '1') {
        clearSession(sessionId);
        return 'END Invalid choice. Booking cancelled.';
      }

      // Process the booking
      const schedule = session.selectedSchedule;
      const seatNumber = session.selectedSeat;

      // 1. Get or create passenger
      const passenger = await ussdService.findOrCreatePassenger(phoneNumber);

      // 2. Create seat lock
      let lock;
      try {
        lock = await ussdService.createSeatLock(
          schedule.id,
          seatNumber,
          passenger.id,
          schedule.company_id
        );
      } catch (lockError) {
        clearSession(sessionId);
        return `END ${lockError.message}. Please try another seat.`;
      }

      // 3. Book ticket
      try {
        const ticket = await ussdService.bookTicket({
          scheduleId: schedule.id,
          passengerId: passenger.id,
          seatNumber: seatNumber,
          lockId: lock.id
        });

        clearSession(sessionId);

        const route = session.selectedRoute;
        return `END ✓ Booking successful!

Ref: ${ticket.booking_ref}
Route: ${route.origin} → ${route.destination}
Seat: ${seatNumber}
Date: ${new Date(schedule.schedule_date).toLocaleDateString('en-GB')}
Time: ${schedule.departure_time.substring(0, 5)}

Save your booking reference!
To cancel: Dial USSD → Cancel Ticket`;

      } catch (bookingError) {
        clearSession(sessionId);
        return `END Booking failed: ${bookingError.message}`;
      }
    }

    // Too many levels - error
    else {
      clearSession(sessionId);
      return 'END Invalid input. Please try again.';
    }

  } catch (error) {
    console.error('❌ Booking flow error:', error);
    clearSession(sessionId);
    return 'END An error occurred. Please try again.';
  }
};

// ==============================================================
// CHECK TICKET FLOW HANDLER
// ==============================================================

/**
 * Handle ticket checking flow
 * Flow: Main → Enter Booking Ref → Display Ticket
 */
const handleCheckTicketFlow = async (sessionId, phoneNumber, inputs, level) => {
  try {
    // ============================================
    // Level 1: Ask for booking reference
    // ============================================
    if (level === 1) {
      return 'CON Enter your booking reference (e.g., STX-ABC123):';
    }

    // ============================================
    // Level 2: Lookup and display ticket
    // ============================================
    else if (level === 2) {
      const bookingRef = inputs[1].trim().toUpperCase();

      // Validate format
      if (!bookingRef.startsWith('STX-')) {
        clearSession(sessionId);
        return 'END Invalid booking reference format. Should start with STX-';
      }

      // Lookup ticket
      const ticket = await ussdService.findTicketByRef(bookingRef, phoneNumber);

      if (!ticket) {
        clearSession(sessionId);
        return 'END Ticket not found or does not belong to this phone number.';
      }

      clearSession(sessionId);

      const schedule = ticket.Schedule;
      const route = schedule.Route;
      const date = new Date(schedule.schedule_date).toLocaleDateString('en-GB');
      const time = schedule.departure_time.substring(0, 5);
      const statusEmoji = ticket.status === 'CONFIRMED' ? '✓' : 
                         ticket.status === 'CANCELLED' ? '✗' :
                         ticket.status === 'CHECKED_IN' ? '✓✓' : '○';

      return `END 🎫 Ticket Details

Ref: ${ticket.booking_ref}
Status: ${statusEmoji} ${ticket.status}

Route: ${route.origin} → ${route.destination}
Date: ${date}
Time: ${time}
Seat: ${ticket.seat_number}
Price: RWF ${parseFloat(ticket.price).toLocaleString()}

${ticket.status === 'CONFIRMED' ? 'Show this at boarding.' : 
  ticket.status === 'CANCELLED' ? 'This ticket is cancelled.' : 
  ticket.status === 'CHECKED_IN' ? 'Already checked in.' : ''}`;
    }

    // Invalid level
    else {
      clearSession(sessionId);
      return 'END Invalid input. Please try again.';
    }

  } catch (error) {
    console.error('❌ Check ticket error:', error);
    clearSession(sessionId);
    return 'END An error occurred. Please try again.';
  }
};

// ==============================================================
// CANCEL TICKET FLOW HANDLER
// ==============================================================

/**
 * Handle ticket cancellation flow
 * Flow: Main → Enter Booking Ref → Confirm → Cancel
 */
const handleCancelTicketFlow = async (sessionId, phoneNumber, inputs, level) => {
  const session = getSession(sessionId);

  try {
    // ============================================
    // Level 1: Ask for booking reference
    // ============================================
    if (level === 1) {
      return 'CON Enter your booking reference to cancel:';
    }

    // ============================================
    // Level 2: Lookup ticket and confirm
    // ============================================
    else if (level === 2) {
      const bookingRef = inputs[1].trim().toUpperCase();

      // Validate format
      if (!bookingRef.startsWith('STX-')) {
        clearSession(sessionId);
        return 'END Invalid booking reference format.';
      }

      // Lookup ticket
      const ticket = await ussdService.findTicketByRef(bookingRef, phoneNumber);

      if (!ticket) {
        clearSession(sessionId);
        return 'END Ticket not found or does not belong to this phone number.';
      }

      if (ticket.status === 'CANCELLED') {
        clearSession(sessionId);
        return 'END This ticket is already cancelled.';
      }

      if (ticket.status === 'CHECKED_IN') {
        clearSession(sessionId);
        return 'END Cannot cancel a checked-in ticket. Please contact support.';
      }

      // Store ticket in session
      updateSession(sessionId, { ticketToCancel: ticket });

      const schedule = ticket.Schedule;
      const route = schedule.Route;

      return `CON Cancel ticket?

Ref: ${ticket.booking_ref}
Route: ${route.origin} → ${route.destination}
Seat: ${ticket.seat_number}
Date: ${new Date(schedule.schedule_date).toLocaleDateString('en-GB')}

1. Yes, cancel
2. No, keep ticket`;
    }

    // ============================================
    // Level 3: Process cancellation
    // ============================================
    else if (level === 3) {
      const confirmation = inputs[2];

      if (confirmation === '2') {
        clearSession(sessionId);
        return 'END Ticket not cancelled.';
      }

      if (confirmation !== '1') {
        clearSession(sessionId);
        return 'END Invalid choice. Ticket not cancelled.';
      }

      const ticket = session.ticketToCancel;

      if (!ticket) {
        clearSession(sessionId);
        return 'END Session expired. Please try again.';
      }

      // Cancel the ticket
      await ussdService.cancelTicket(ticket.id, phoneNumber);

      clearSession(sessionId);

      return `END ✓ Ticket cancelled successfully

Ref: ${ticket.booking_ref}
Seat ${ticket.seat_number} has been released.

You can book another ticket using the USSD menu.`;
    }

    // Invalid level
    else {
      clearSession(sessionId);
      return 'END Invalid input. Please try again.';
    }

  } catch (error) {
    console.error('❌ Cancel ticket error:', error);
    clearSession(sessionId);
    if (error.message.includes('not found')) {
      return 'END Ticket not found or unauthorized.';
    }
    return 'END An error occurred during cancellation.';
  }
};

// ==============================================================
// EXPORTS
// ==============================================================

module.exports = {
  handleUSSD
};
