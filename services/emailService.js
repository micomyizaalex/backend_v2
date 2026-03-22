const { sendEmail } = require('../utils/mailer');

/**
 * Generate HTML email template for ticket confirmation
 */
const generateTicketEmailHTML = ({ userName, userEmail, tickets, scheduleInfo }) => {
  const ticketsHTML = tickets.map(ticket => `
    <tr>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: #f9fafb;">
        <strong style="color: #0077B6;">Seat ${ticket.seat_number}</strong>
      </td>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">
        ${ticket.booking_ref}
      </td>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">
        ${ticket.price} RWF
      </td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your SafariTix Ticket</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td align="center" style="padding: 40px 0;">
            <table role="presentation" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #0077B6 0%, #005f8f 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: bold;">🎫 Ticket Confirmed!</h1>
                  <p style="margin: 10px 0 0 0; color: #e0f2fe; font-size: 16px;">Your journey awaits</p>
                </td>
              </tr>
              
              <!-- Greeting -->
              <tr>
                <td style="padding: 30px 30px 20px 30px;">
                  <h2 style="margin: 0 0 10px 0; color: #1f2937; font-size: 22px;">Hello ${userName}! 👋</h2>
                  <p style="margin: 0; color: #6b7280; font-size: 16px; line-height: 1.5;">
                    Great news! Your ticket booking has been confirmed. Here are your ticket details:
                  </p>
                </td>
              </tr>
              
              <!-- Trip Details -->
              ${scheduleInfo ? `
              <tr>
                <td style="padding: 0 30px 20px 30px;">
                  <div style="background-color: #f0f9ff; border-left: 4px solid #0077B6; padding: 20px; border-radius: 4px;">
                    <h3 style="margin: 0 0 15px 0; color: #0077B6; font-size: 18px;">Trip Details</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 40%;">Route:</td>
                        <td style="padding: 8px 0; color: #1f2937; font-size: 14px; font-weight: 600;">
                          ${scheduleInfo.origin || 'N/A'} → ${scheduleInfo.destination || 'N/A'}
                        </td>
                      </tr>
                      ${scheduleInfo.departure_time ? `
                      <tr>
                        <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Departure:</td>
                        <td style="padding: 8px 0; color: #1f2937; font-size: 14px; font-weight: 600;">
                          ${new Date(scheduleInfo.departure_time).toLocaleString('en-US', { 
                            dateStyle: 'full', 
                            timeStyle: 'short' 
                          })}
                        </td>
                      </tr>
                      ` : ''}
                      ${scheduleInfo.bus_plate ? `
                      <tr>
                        <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Bus:</td>
                        <td style="padding: 8px 0; color: #1f2937; font-size: 14px; font-weight: 600;">
                          ${scheduleInfo.bus_plate}
                        </td>
                      </tr>
                      ` : ''}
                    </table>
                  </div>
                </td>
              </tr>
              ` : ''}
              
              <!-- Tickets Table -->
              <tr>
                <td style="padding: 0 30px 30px 30px;">
                  <h3 style="margin: 0 0 15px 0; color: #1f2937; font-size: 18px;">Your Ticket${tickets.length > 1 ? 's' : ''}</h3>
                  <table style="width: 100%; border-collapse: collapse; border: 2px solid #0077B6; border-radius: 8px; overflow: hidden;">
                    <thead>
                      <tr style="background-color: #0077B6; color: #ffffff;">
                        <th style="padding: 12px; text-align: left; font-size: 14px;">Seat Number</th>
                        <th style="padding: 12px; text-align: left; font-size: 14px;">Booking Reference</th>
                        <th style="padding: 12px; text-align: left; font-size: 14px;">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${ticketsHTML}
                    </tbody>
                  </table>
                </td>
              </tr>
              
              <!-- Important Info -->
              <tr>
                <td style="padding: 0 30px 30px 30px;">
                  <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px;">
                    <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.5;">
                      <strong>⚠️ Important:</strong> Please arrive at least 15 minutes before departure. 
                      Show this email or your booking reference at the check-in counter.
                    </p>
                  </div>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="padding: 30px; background-color: #f9fafb; text-align: center; border-radius: 0 0 8px 8px;">
                  <p style="margin: 0 0 10px 0; color: #6b7280; font-size: 14px;">
                    Have questions? Contact us at support@safaritix.com
                  </p>
                  <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                    © ${new Date().getFullYear()} SafariTix. All rights reserved.
                  </p>
                  <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 12px;">
                    This email was sent to ${userEmail}
                  </p>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

/**
 * Generate plain text version of ticket email
 */
const generateTicketEmailText = ({ userName, tickets, scheduleInfo }) => {
  const ticketsText = tickets.map(ticket => 
    `- Seat ${ticket.seat_number} | Booking Ref: ${ticket.booking_ref} | Price: ${ticket.price} RWF`
  ).join('\n');

  let tripDetails = '';
  if (scheduleInfo) {
    tripDetails = `
TRIP DETAILS:
Route: ${scheduleInfo.origin || 'N/A'} → ${scheduleInfo.destination || 'N/A'}
${scheduleInfo.departure_time ? `Departure: ${new Date(scheduleInfo.departure_time).toLocaleString()}` : ''}
${scheduleInfo.bus_plate ? `Bus: ${scheduleInfo.bus_plate}` : ''}
`;
  }

  return `
Hello ${userName}!

Your SafariTix ticket booking has been confirmed!
${tripDetails}

YOUR TICKET${tickets.length > 1 ? 'S' : ''}:
${ticketsText}

IMPORTANT: Please arrive at least 15 minutes before departure. Show this email or your booking reference at the check-in counter.

Have questions? Contact us at support@safaritix.com

© ${new Date().getFullYear()} SafariTix. All rights reserved.
  `.trim();
};

/**
 * Send ticket confirmation email to user
 * @param {Object} options - Email options
 * @param {string} options.userEmail - User's email address
 * @param {string} options.userName - User's full name
 * @param {Array} options.tickets - Array of ticket objects with seat_number, booking_ref, price
 * @param {Object} options.scheduleInfo - Optional schedule information (origin, destination, departure_time, bus_plate)
 */
const sendTicketConfirmationEmail = async ({ userEmail, userName, tickets, scheduleInfo = null }) => {
  try {
    if (!userEmail) {
      console.log('⚠️  Cannot send ticket email: User email is missing');
      return { success: false, error: 'User email is missing' };
    }

    if (!tickets || tickets.length === 0) {
      console.log('⚠️  Cannot send ticket email: No tickets provided');
      return { success: false, error: 'No tickets provided' };
    }

    const html = generateTicketEmailHTML({ userName, userEmail, tickets, scheduleInfo });
    const text = generateTicketEmailText({ userName, tickets, scheduleInfo });

    const subject = `🎫 Your SafariTix Ticket Confirmation - ${tickets.length} Seat${tickets.length > 1 ? 's' : ''}`;

    await sendEmail({
      to: userEmail,
      subject,
      text,
      html
    });

    console.log(`✅ Ticket confirmation email sent to ${userEmail}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to send ticket confirmation email:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendTicketConfirmationEmail,
  generateTicketEmailHTML,
  generateTicketEmailText
};
