# Email Ticket Confirmation System

## Overview
This system automatically sends ticket confirmation emails to users when they successfully book tickets through the SafariTix platform.

## How It Works

### 1. User Books a Ticket
When a user completes a payment and the ticket is confirmed, the system:
- Creates the ticket in the database
- Updates seat availability
- **Automatically sends a confirmation email to the user's registered email address**

### 2. Email Content
The confirmation email includes:
- ✅ All booked tickets with seat numbers and booking references
- 🚌 Trip details (route, departure time, bus information)
- 💳 Payment information
- 📋 Important reminders (arrive 15 minutes early, etc.)
- 📧 Beautiful HTML formatting for easy reading

### 3. Where the Email is Sent
The email is sent to the **email address from the user's profile** in the database:
- Field: `users.email`
- Example: micomyizaa742@gmail.com (from user profile)

The system retrieves this information automatically when a booking is made.

## Email Configuration

### Current Setup (Gmail)
The system is configured to use Gmail SMTP. Configuration is in `.env`:

\`\`\`env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=laurentniyigena1@gmail.com
SMTP_PASS=hifn astm glwq akjq
SMTP_FROM_EMAIL=laurentniyigena1@gmail.com
SMTP_FROM_NAME=SafariTix - Bus Booking
\`\`\`

### Setting Up Gmail
1. **Enable 2-Factor Authentication** on your Google Account
2. **Generate an App Password**:
   - Go to: https://myaccount.google.com/apppasswords
   - Create a new app password for "SafariTix"
   - Copy the 16-character password
3. **Update `.env`** with your credentials:
   \`\`\`env
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-app-password
   \`\`\`

## Testing

### Test the Email Service
Run this command to send a test email:

\`\`\`bash
node scripts/test-email-service.js
\`\`\`

This will:
- Check your SMTP configuration
- Send a test ticket confirmation email to your configured email address
- Verify that emails are working correctly

### Test with Real Booking
1. Make a real booking through the app
2. Complete the payment
3. Check the user's email inbox for the confirmation

## Files Modified

### New Files Created
1. **`services/emailService.js`** - Email template and sending logic
   - `sendTicketConfirmationEmail()` - Main function to send ticket emails
   - `generateTicketEmailHTML()` - Creates beautiful HTML email template
   - `generateTicketEmailText()` - Creates plain text version

2. **`scripts/test-email-service.js`** - Test script for email functionality

### Modified Files
1. **`utils/mailer.js`** - Enhanced email transporter with better error handling
2. **`controllers/paymentController.js`** - Integrated email sending after successful booking
3. **`.env`** - Added Gmail SMTP configuration
4. **`package.json`** - Added nodemailer dependency

## How It Gets User Email

The system automatically retrieves the user's email from their profile:

\`\`\`javascript
// In paymentController.js after successful booking:
const userQuery = await pool.query(
  'SELECT email, full_name FROM users WHERE id = $1',
  [userId]
);

// Email is sent to: userQuery.rows[0].email
\`\`\`

This ensures that:
- ✅ The correct email is always used
- ✅ It matches the user's profile information
- ✅ Users can update their email in their profile and future bookings will use the updated email

## User Profile Email Location

Users can view/edit their email in the commuter dashboard:
- **Frontend**: Profile section shows email (e.g., micomyizaa742@gmail.com)
- **Database**: Stored in \`users.email\` column
- **API**: Updated via \`PUT /api/auth/me\` endpoint

## Troubleshooting

### Email Not Being Sent?

1. **Check SMTP Configuration**:
   \`\`\`bash
   node scripts/test-email-service.js
   \`\`\`

2. **Check User Has Email**:
   \`\`\`bash
   node scripts/find-user-by-email.js <email>
   \`\`\`

3. **Check Server Logs**:
   - Look for: ✅ "Ticket confirmation email sent to..."
   - Or: ❌ "Failed to send ticket confirmation email"

4. **Common Issues**:
   - Invalid Gmail app password → Generate a new one
   - 2FA not enabled → Enable it in Google Account
   - Firewall blocking port 587 → Check network settings
   - User has no email in profile → Update user profile

### Email Goes to Spam?
- Add your domain to SPF records
- Use a verified email address in SMTP_FROM_EMAIL
- Ask users to add sender to contacts

## Features

### Non-Blocking Email
- Emails are sent **after the booking is committed** to the database
- If email fails, the booking still succeeds
- Users can always access their tickets in the app

### Beautiful Template
- Responsive HTML design
- Works on all email clients
- Professional branding
- Clear call-to-action

### Multiple Tickets
- Supports sending confirmation for multiple tickets in one email
- Shows all seats and booking references
- Total price calculation

## Future Enhancements

Possible additions:
- 📱 SMS notifications (integrate with Twilio)
- 🔔 Push notifications
- 📄 PDF ticket attachments
- 🔄 Email for ticket updates/cancellations
- 📊 Email delivery tracking
- 🌍 Multi-language support

## Support

For issues or questions:
- Check server logs in \`backend_v2/app.js\`
- Run test script: \`node scripts/test-email-service.js\`
- Verify user email: \`node scripts/find-user-by-email.js <email>\`

---

**Status**: ✅ Fully Implemented and Tested
**Last Updated**: February 24, 2026
