const QRCode = require('qrcode');
const { sendEmail } = require('../utils/mailer');

/**
 * Generate QR code as base64 data URL - Production Ready & Gmail-Optimized
 */
const generateQRCode = async (data) => {
  try {
    console.log('🔄 Generating QR code...', { dataLength: JSON.stringify(data).length });
    
    // Use smaller size and lower quality for Gmail compatibility
    const qrDataURL = await QRCode.toDataURL(JSON.stringify(data), {
      errorCorrectionLevel: 'M', // Changed from 'H' to 'M' for smaller size
      type: 'image/png',
      quality: 0.92, // Reduced from 1 to 0.92
      margin: 1,
      width: 180, // Reduced from 200 to 180
      color: {
        dark: '#2B2D42',
        light: '#FFFFFF'
      }
    });
    
    const sizeKB = (qrDataURL.length * 0.75 / 1024).toFixed(2);
    console.log('✅ QR code generated successfully:', {
      preview: qrDataURL.substring(0, 50) + '...',
      sizeKB: sizeKB + ' KB',
      totalLength: qrDataURL.length
    });
    
    // Gmail has issues with very large base64 images
    if (qrDataURL.length > 50000) {
      console.log('⚠️  QR code might be too large for some email clients');
    }
    
    return qrDataURL;
  } catch (error) {
    console.error('❌ Failed to generate QR code:', error);
    return null;
  }
};

/**
 * Generate QR code PNG buffer for CID embedding in emails.
 * CID images are far more reliable than data URLs in Gmail/mobile clients.
 */
const generateQRCodeBuffer = async (data) => {
  try {
    return await QRCode.toBuffer(JSON.stringify(data), {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 1,
      width: 220,
      color: {
        dark: '#2B2D42',
        light: '#FFFFFF'
      }
    });
  } catch (error) {
    console.error('❌ Failed to generate QR buffer:', error);
    return null;
  }
};

/**
 * Safe date formatter with fallbacks
 */
const formatDate = (dateValue) => {
  try {
    if (!dateValue) {
      console.log('⚠️  Date value is null/undefined, using fallback');
      return 'TBD';
    }
    
    const date = new Date(dateValue);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      console.log('⚠️  Invalid date:', dateValue);
      return 'TBD';
    }
    
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  } catch (error) {
    console.error('❌ Date formatting error:', error);
    return 'TBD';
  }
};

/**
 * Safe time formatter with fallbacks
 */
const formatTime = (timeValue) => {
  try {
    if (!timeValue) {
      console.log('⚠️  Time value is null/undefined, using fallback');
      return 'TBD';
    }
    
    // If it's already a formatted time string (HH:MM), return it
    if (typeof timeValue === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(timeValue)) {
      return timeValue.substring(0, 5); // Return HH:MM format
    }
    
    // Try to parse as date
    const date = new Date(timeValue);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      console.log('⚠️  Invalid time:', timeValue);
      return 'TBD';
    }
    
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
  } catch (error) {
    console.error('❌ Time formatting error:', error);
    return 'TBD';
  }
};

/**
 * Generate professional e-ticket HTML template - Production Ready
 */
const generateETicketHTML = async ({ ticket, passenger, trip, company, qrData, qrImageSrc = null }) => {
  try {
    console.log('🎨 Generating e-ticket HTML...');
    console.log('📊 Trip data received:', {
      origin: trip.origin,
      destination: trip.destination,
      date: trip.date,
      departureTime: trip.departureTime,
      busNumber: trip.busNumber
    });
    
    // Generate QR code with error handling
    // Prefer CID image (passed in from sendETicketEmail) for better client support.
    // Fallback to data URL if CID wasn't available.
    let qrCodeImage = qrImageSrc;
    if (!qrCodeImage) {
      try {
        qrCodeImage = await generateQRCode(qrData);
        if (qrCodeImage) {
          const qrSize = (qrCodeImage.length * 0.75 / 1024).toFixed(2);
          console.log(`✅ QR code data-url fallback ready: ${qrSize} KB, length: ${qrCodeImage.length} chars`);
        } else {
          console.log('⚠️  QR code generation returned null, email will show fallback message');
        }
      } catch (qrError) {
        console.error('❌ QR generation failed:', qrError);
        qrCodeImage = null;
      }
    }
    
    // Safe date formatting with fallbacks
    const formattedDate = formatDate(trip.date);
    const formattedTime = trip.departureTime || 'TBD';
    
    console.log('📅 Formatted date:', formattedDate);
    console.log('🕐 Formatted time:', formattedTime);
    console.log('📱 QR code will be shown:', qrCodeImage ? 'YES' : 'NO (showing fallback)');
    
    const ticketId = `STX-${new Date().getFullYear()}-${String(ticket.id).substring(0, 6).toUpperCase()}`;
    const ticketIdsDisplay = ticket.ticketIds || ticket.id;
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafariTix E-Ticket - ${ticketId}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #F5F7FA;">
  
  <!-- Main Container -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #F5F7FA;">
    <tr>
      <td align="center" style="padding: 20px 10px;">
        
        <!-- Email Card -->
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #FFFFFF; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0077B6 0%, #005f8f 100%); padding: 30px 40px; border-radius: 12px 12px 0 0; text-align: center;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="text-align: center;">
                    <h1 style="margin: 0 0 10px 0; color: #FFFFFF; font-size: 32px; font-weight: bold; letter-spacing: 2px;">SafariTix</h1>
                    <p style="margin: 0; color: #E0F2FE; font-size: 14px; font-weight: 500;">Your Journey, Our Priority</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top: 20px; text-align: center;">
                    <div style="display: inline-block; background-color: #27AE60; color: #FFFFFF; padding: 10px 30px; border-radius: 25px; font-size: 16px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">
                      ✓ BOOKING CONFIRMED
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Ticket ID & Status Bar -->
          <tr>
            <td style="padding: 25px 40px; background-color: #F0F9FF; border-bottom: 2px dashed #CBD5E1;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="text-align: left;">
                    <p style="margin: 0; color: #64748B; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 1px;">Ticket ID(s)</p>
                    <p style="margin: 5px 0 0 0; color: #0077B6; font-size: 18px; font-weight: bold; font-family: 'Courier New', monospace;">${ticketIdsDisplay}</p>
                  </td>
                  <td style="text-align: right;">
                    <p style="margin: 0; color: #64748B; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 1px;">Booking Ref</p>
                    <p style="margin: 5px 0 0 0; color: #2B2D42; font-size: 14px; font-weight: bold; font-family: 'Courier New', monospace;">${ticket.bookingRef}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 22px 40px 0 40px;">
              <p style="margin: 0; color: #2B2D42; font-size: 15px; line-height: 1.5;">Hello ${passenger.name},</p>
              <p style="margin: 8px 0 0 0; color: #475569; font-size: 14px; line-height: 1.6;">Your SafariTix booking is confirmed. Please find your ticket details below.</p>
            </td>
          </tr>

          <!-- Passenger Information -->
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #E2E8F0;">
              <h2 style="margin: 0 0 20px 0; color: #2B2D42; font-size: 18px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
                👤 Passenger Details
              </h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 8px 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="color: #64748B; font-size: 13px; width: 120px; vertical-align: top;">Name:</td>
                        <td style="color: #2B2D42; font-size: 15px; font-weight: 600;">${passenger.name}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 8px 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="color: #64748B; font-size: 13px; width: 120px; vertical-align: top;">Email:</td>
                        <td style="color: #2B2D42; font-size: 14px;">${passenger.email}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${passenger.phone ? `
                <tr>
                  <td style="padding: 8px 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="color: #64748B; font-size: 13px; width: 120px; vertical-align: top;">Phone:</td>
                        <td style="color: #2B2D42; font-size: 14px;">${passenger.phone}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}
              </table>
            </td>
          </tr>
          
          <!-- Trip Information - Main Route Display -->
          <tr>
            <td style="padding: 30px 40px; background: linear-gradient(to bottom, #F0F9FF 0%, #FFFFFF 100%);">
              <h2 style="margin: 0 0 25px 0; color: #2B2D42; font-size: 18px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
                🚌 Journey Details
              </h2>
              
              <!-- Route Display -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 25px;">
                <tr>
                  <td style="text-align: center; padding: 20px; background-color: #FFFFFF; border: 2px solid #0077B6; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="width: 40%; text-align: center; vertical-align: top;">
                          <p style="margin: 0 0 8px 0; color: #64748B; font-size: 12px; text-transform: uppercase; font-weight: 600;">From</p>
                          <p style="margin: 0; color: #0077B6; font-size: 24px; font-weight: bold;">${trip.origin}</p>
                        </td>
                        <td style="width: 20%; text-align: center; vertical-align: middle;">
                          <p style="margin: 0; color: #F4A261; font-size: 32px; font-weight: bold;">→</p>
                        </td>
                        <td style="width: 40%; text-align: center; vertical-align: top;">
                          <p style="margin: 0 0 8px 0; color: #64748B; font-size: 12px; text-transform: uppercase; font-weight: 600;">To</p>
                          <p style="margin: 0; color: #0077B6; font-size: 24px; font-weight: bold;">${trip.destination}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- Trip Details Grid -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="width: 50%; padding: 12px 8px 12px 0; vertical-align: top;">
                    <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; border-left: 4px solid #0077B6; height: 100%; box-sizing: border-box;">
                      <p style="margin: 0 0 5px 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 600;">Departure Date</p>
                      <p style="margin: 0; color: #2B2D42; font-size: 16px; font-weight: bold;">${formattedDate}</p>
                    </div>
                  </td>
                  <td style="width: 50%; padding: 12px 0 12px 8px; vertical-align: top;">
                    <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; border-left: 4px solid #F4A261; height: 100%; box-sizing: border-box;">
                      <p style="margin: 0 0 5px 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 600;">Departure Time</p>
                      <p style="margin: 0; color: #2B2D42; font-size: 16px; font-weight: bold;">${formattedTime}</p>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="width: 50%; padding: 12px 8px 12px 0; vertical-align: top;">
                    <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; border-left: 4px solid #27AE60; height: 100%; box-sizing: border-box;">
                      <p style="margin: 0 0 5px 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 600;">Seat Number(s)</p>
                      <p style="margin: 0; color: #27AE60; font-size: 20px; font-weight: bold;">${ticket.seatNumber}</p>
                    </div>
                  </td>
                  <td style="width: 50%; padding: 12px 0 12px 8px; vertical-align: top;">
                    <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; border-left: 4px solid #8B5CF6; height: 100%; box-sizing: border-box;">
                      <p style="margin: 0 0 5px 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 600;">Bus Number</p>
                      <p style="margin: 0; color: #2B2D42; font-size: 16px; font-weight: bold;">${trip.busNumber || 'Will be assigned'}</p>
                    </div>
                  </td>
                </tr>
                ${trip.driverName ? `
                <tr>
                  <td colspan="2" style="padding: 12px 0 0 0;">
                    <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; border-left: 4px solid #EC4899;">
                      <p style="margin: 0 0 5px 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 600;">Driver</p>
                      <p style="margin: 0; color: #2B2D42; font-size: 16px; font-weight: bold;">${trip.driverName}</p>
                    </div>
                  </td>
                </tr>
                ` : ''}
              </table>
            </td>
          </tr>
          
          <!-- Payment Info & QR Code Side by Side -->
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #E2E8F0; border-bottom: 2px dashed #CBD5E1;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="width: 60%; vertical-align: top; padding-right: 20px;">
                    <h3 style="margin: 0 0 15px 0; color: #2B2D42; font-size: 16px; font-weight: bold; text-transform: uppercase;">💳 Payment Details</h3>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 8px 0;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="color: #64748B; font-size: 14px;">Ticket Price:</td>
                              <td style="text-align: right; color: #2B2D42; font-size: 16px; font-weight: bold;">${ticket.price} RWF</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="color: #64748B; font-size: 14px;">Status:</td>
                              <td style="text-align: right;">
                                <span style="background-color: #D1FAE5; color: #065F46; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold;">PAID</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0 0 0; border-top: 1px solid #E2E8F0;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="color: #0077B6; font-size: 16px; font-weight: bold;">Total Paid:</td>
                              <td style="text-align: right; color: #0077B6; font-size: 20px; font-weight: bold;">${ticket.price} RWF</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style="width: 40%; vertical-align: top; text-align: center;">
                    <h3 style="margin: 0 0 15px 0; color: #2B2D42; font-size: 16px; font-weight: bold; text-transform: uppercase;">📱 Boarding Pass</h3>
                    ${qrCodeImage ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td align="center" style="padding: 15px; background-color: #FFFFFF; border-radius: 12px; border: 2px solid #0077B6;">
                          <img src="${qrCodeImage}" alt="Boarding Pass QR Code" width="140" height="140" border="0" style="display: block; width: 140px; height: 140px; margin: 0 auto;" />
                          <p style="margin: 10px 0 0 0; color: #64748B; font-size: 11px; font-weight: 600;">Please present this QR code when boarding</p>
                        </td>
                      </tr>
                    </table>
                    ` : `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td align="center" style="padding: 20px; background-color: #FEF3C7; border-radius: 12px; border: 2px solid #F59E0B;">
                          <p style="margin: 0 0 10px 0; color: #92400E; font-size: 14px; font-weight: bold;">QR Code Unavailable</p>
                          <p style="margin: 0; color: #78350F; font-size: 11px; line-height: 1.4;">Present your Booking Ref:<br><strong style="font-size: 13px; font-family: 'Courier New', monospace; color: #78350F;">${ticket.bookingRef}</strong></p>
                        </td>
                      </tr>
                    </table>
                    `}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Action Buttons -->
          <tr>
            <td style="padding: 30px 40px; text-align: center; background-color: #F9FAFB;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 0 10px;">
                          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/tickets/${ticket.id}" style="display: inline-block; background-color: #0077B6; color: #FFFFFF; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
                            View Ticket
                          </a>
                        </td>
                        <td style="padding: 0 10px;">
                          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/track-bus/${ticket.id}" style="display: inline-block; background-color: #27AE60; color: #FFFFFF; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
                            Track Bus
                          </a>
                        </td>
                        <td style="padding: 0 10px;">
                          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/tickets/${ticket.id}/cancel" style="display: inline-block; background-color: #FFFFFF; color: #E63946; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; border: 2px solid #E63946;">
                            Cancel Ticket
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Important Notice -->
          <tr>
            <td style="padding: 25px 40px; background-color: #FFF7ED; border-top: 3px solid #F4A261;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 12px;">
                    <p style="margin: 0; color: #92400E; font-size: 16px; font-weight: bold;">⚠️ Important Boarding Information</p>
                  </td>
                </tr>
                <tr>
                  <td>
                    <ul style="margin: 0; padding-left: 20px; color: #92400E; font-size: 14px; line-height: 1.8;">
                      <li>Please arrive at the boarding point <strong>at least 30 minutes</strong> before departure time</li>
                      <li>Have this email or printed ticket ready for verification</li>
                      <li>Carry a valid ID for identification</li>
                      <li>Luggage restrictions apply as per company policy</li>
                      <li>Ticket is non-transferable and must match passenger ID</li>
                    </ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Company Info & Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #2B2D42; border-radius: 0 0 12px 12px; text-align: center;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 20px; border-bottom: 1px solid #475569;">
                    <p style="margin: 0 0 15px 0; color: #FFFFFF; font-size: 18px; font-weight: bold;">${company.name || 'SafariTix Transport'}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="text-align: center; padding: 5px 0;">
                          <p style="margin: 0; color: #94A3B8; font-size: 13px;">📧 safaritixrwanda@gmail.com</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="text-align: center; padding: 5px 0;">
                          <p style="margin: 0; color: #94A3B8; font-size: 13px;">📞 +250 793 216 602</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="text-align: center; padding: 5px 0;">
                          <p style="margin: 0; color: #94A3B8; font-size: 13px;">🌐 www.safaritix.com</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top: 20px;">
                    <p style="margin: 0 0 10px 0; color: #64748B; font-size: 12px; line-height: 1.6;">
                      This is an automated email. Please do not reply to this message.<br/>
                      For support inquiries, contact us at safaritixrwanda@gmail.com
                    </p>
                    <p style="margin: 0; color: #475569; font-size: 11px;">
                      © ${new Date().getFullYear()} SafariTix. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
        </table>
        <!-- End Email Card -->
        
      </td>
    </tr>
  </table>
  <!-- End Main Container -->
  
</body>
</html>
  `;
  } catch (error) {
    console.error('❌ Error generating e-ticket HTML:', error);
    throw error;
  }
};

/**
 * Generate plain text version of e-ticket - Production Ready
 */
const generateETicketText = ({ ticket, passenger, trip, company }) => {
  const ticketId = `STX-${new Date().getFullYear()}-${String(ticket.id).substring(0, 6).toUpperCase()}`;
  const ticketIdsDisplay = ticket.ticketIds || ticket.id;
  
  // Safe date formatting for plain text
  const formattedDate = formatDate(trip.date);
  const formattedTime = trip.departureTime || 'TBD';
  
  return `
═══════════════════════════════════════════════════════════
                       SafariTix E-Ticket
                  Your Journey, Our Priority
═══════════════════════════════════════════════════════════

✓ BOOKING CONFIRMED

Hello ${passenger.name},
Your SafariTix booking is confirmed.

TICKET INFORMATION
──────────────────────────────────────────────────────────
Ticket ID(s):    ${ticketIdsDisplay}
Booking Ref:     ${ticket.bookingRef}
Status:          CONFIRMED

PASSENGER DETAILS
──────────────────────────────────────────────────────────
Name:            ${passenger.name}
Email:           ${passenger.email}
${passenger.phone ? `Phone:           ${passenger.phone}` : ''}

JOURNEY DETAILS
──────────────────────────────────────────────────────────
Route:           ${trip.origin} → ${trip.destination}
Date:            ${formattedDate}
Departure:       ${formattedTime}
Seat Number(s):  ${ticket.seatNumber}
Bus Number:      ${trip.busNumber || 'Will be assigned'}
${trip.driverName ? `Driver:          ${trip.driverName}\n` : ''}

PAYMENT DETAILS
──────────────────────────────────────────────────────────
Ticket Price:    ${ticket.price} RWF
Status:          PAID
Total Paid:      ${ticket.price} RWF

IMPORTANT BOARDING INFORMATION
──────────────────────────────────────────────────────────
⚠ Please arrive at least 30 minutes before departure time
⚠ Have this ticket ready for verification
⚠ Please present this QR code when boarding
⚠ Carry a valid ID for identification
⚠ Luggage restrictions apply as per company policy
⚠ Ticket is non-transferable

CONTACT INFORMATION
──────────────────────────────────────────────────────────
Company:         ${company.name || 'SafariTix Transport'}
Email:           safaritixrwanda@gmail.com
Phone:           +250 793 216 602
Website:         www.safaritix.com

═══════════════════════════════════════════════════════════
                © ${new Date().getFullYear()} SafariTix. All rights reserved.
═══════════════════════════════════════════════════════════
  `.trim();
};

/**
 * Send professional e-ticket confirmation email - Production Ready
 */
const sendETicketEmail = async ({
  userEmail,
  userName,
  tickets,
  scheduleInfo,
  companyInfo = {},
  bookingId = null,
  userId = null
}) => {
  try {
    console.log('📧 ===== E-TICKET EMAIL GENERATION STARTED =====');
    console.log('📨 Recipient:', userEmail);
    console.log('📊 Raw scheduleInfo:', JSON.stringify(scheduleInfo, null, 2));
    
    if (!userEmail) {
      console.log('❌ Cannot send e-ticket: User email is missing');
      return { success: false, error: 'User email is missing' };
    }

    if (!tickets || tickets.length === 0) {
      console.log('❌ Cannot send e-ticket: No tickets provided');
      return { success: false, error: 'No tickets provided' };
    }

    const ticket = tickets[0];
    const seatNumbers = tickets
      .map((item) => item?.seat_number || item?.seatNumber)
      .filter(Boolean)
      .map((seat) => String(seat));
    const ticketIds = tickets
      .map((item) => item?.id)
      .filter(Boolean)
      .map((id) => String(id));
    const totalPrice = tickets.reduce((sum, item) => sum + Number(item?.price || 0), 0);
    
    console.log('🎫 Processing ticket:', {
      id: ticket.id,
      bookingRef: ticket.booking_ref || ticket.bookingRef,
      seatNumber: ticket.seat_number || ticket.seatNumber
    });
    
    // Extract date and time from scheduleInfo with safe fallbacks
    // Database has TWO separate fields:
    //   - schedule_date (DATEONLY) - e.g., "2026-02-25"
    //   - departure_time (TIME) - e.g., "21:05:00"
    const scheduleDate = scheduleInfo?.schedule_date || scheduleInfo?.scheduleDate || null;
    const departureTime = scheduleInfo?.departure_time || scheduleInfo?.departureTime || null;
    
    console.log('📅 Raw schedule_date from DB:', scheduleDate);
    console.log('🕐 Raw departure_time from DB:', departureTime);
    
    // Combine date and time into a full timestamp for QR code data
    let combinedDateTime = null;
    if (scheduleDate && departureTime) {
      // Create a full ISO timestamp by combining date and time
      combinedDateTime = `${scheduleDate}T${departureTime}`;
      console.log('🔄 Combined date+time:', combinedDateTime);
    }
    
    // Format date and time separately for display
    const formattedDate = formatDate(scheduleDate);
    const formattedTime = formatTime(departureTime);

    // Prefer the exact segment saved on the ticket over the parent route.
    const bookedOrigin =
      ticket?.from_stop ||
      ticket?.fromStop ||
      scheduleInfo?.from_stop ||
      scheduleInfo?.pickup_stop ||
      scheduleInfo?.origin ||
      scheduleInfo?.from ||
      'N/A';

    const bookedDestination =
      ticket?.to_stop ||
      ticket?.toStop ||
      scheduleInfo?.to_stop ||
      scheduleInfo?.dropoff_stop ||
      scheduleInfo?.destination ||
      scheduleInfo?.to ||
      'N/A';
    
    console.log('📅 Formatted date:', formattedDate);
    console.log('🕐 Formatted time:', formattedTime);
    
    // Prepare QR code data.
    // Required payload schema:
    // {
    //   bookingId,
    //   userId,
    //   from,
    //   to,
    //   seats,
    //   date,
    //   bus
    // }
    //
    // NOTE: We also include `ticketId` for backward compatibility with
    // existing driver scanning/validation logic (which extracts ticketId).
    const qrData = {
      bookingId: bookingId || ticket.payment_id || ticket.booking_id || ticket.booking_ref || null,
      userId: userId || ticket.passenger_id || ticket.user_id || null,
      from: bookedOrigin,
      to: bookedDestination,
      seats: seatNumbers.map((s) => String(s)),
      date: scheduleInfo?.schedule_date || scheduleInfo?.scheduleDate || scheduleDate || null,
      bus: scheduleInfo?.bus_plate || scheduleInfo?.busPlate || scheduleInfo?.bus || null,
      ticketId: ticket.id || ticket.ticket_id || null
    };
    
    console.log('📱 QR Data prepared:', {
      bookingId: qrData.bookingId,
      userId: qrData.userId,
      from: qrData.from,
      to: qrData.to,
      seatsCount: Array.isArray(qrData.seats) ? qrData.seats.length : 0,
      dataSize: JSON.stringify(qrData).length + ' bytes'
    });

    // Prepare ticket data for template
    const ticketData = {
      id: ticket.id || `temp-${Date.now()}`,
      ticketIds: ticketIds.join(', '),
      bookingRef: ticket.booking_ref || ticket.bookingRef,
      seatNumber: seatNumbers.length ? seatNumbers.join(', ') : (ticket.seat_number || ticket.seatNumber),
      price: totalPrice || ticket.price || 0
    };

    const passengerData = {
      name: userName || 'Valued Customer',
      email: userEmail,
      phone: null // Can be added if available
    };

    const tripData = {
      origin: bookedOrigin,
      destination: bookedDestination,
      date: scheduleDate, // Pass raw date for safe formatting in template
      departureTime: formattedTime, // Already formatted time
      busNumber: scheduleInfo?.bus_plate || scheduleInfo?.busNumber || null,
      driverName: scheduleInfo?.driver_name || scheduleInfo?.driverName || null
    };

    const companyData = {
      name: companyInfo.name || 'SafariTix Transport'
    };
    
    console.log('🎨 Generating HTML with trip data:', {
      origin: tripData.origin,
      destination: tripData.destination,
      date: tripData.date,
      formattedTime: tripData.departureTime,
      busNumber: tripData.busNumber
    });

    // Generate a CID-embedded image for reliable rendering in Gmail and mobile email apps.
    const qrCid = `boarding-pass-qr-${Date.now()}@safaritix`;
    const qrBuffer = await generateQRCodeBuffer(qrData);
    const qrImageSrc = qrBuffer ? `cid:${qrCid}` : null;

    // Generate email content with comprehensive error handling
    let html;
    try {
      html = await generateETicketHTML({
        ticket: ticketData,
        passenger: passengerData,
        trip: tripData,
        company: companyData,
        qrData,
        qrImageSrc
      });
      console.log('✅ HTML template generated successfully');
    } catch (htmlError) {
      console.error('❌ Failed to generate HTML template:', htmlError);
      throw new Error(`HTML generation failed: ${htmlError.message}`);
    }

    const text = generateETicketText({
      ticket: ticketData,
      passenger: passengerData,
      trip: tripData,
      company: companyData
    });

    const subject = 'Your SafariTix Ticket Confirmation';
    
    console.log('📬 Sending email...');
    console.log('   To:', userEmail);
    console.log('   Subject:', subject);

    await sendEmail({
      to: userEmail,
      subject,
      text,
      html,
      attachments: qrBuffer
        ? [
            {
              filename: 'boarding-pass-qr.png',
              content: qrBuffer,
              cid: qrCid,
              contentType: 'image/png'
            }
          ]
        : []
    });

    console.log('✅ ===== E-TICKET EMAIL SENT SUCCESSFULLY =====');
    return { success: true };
  } catch (error) {
    console.error('❌ ===== E-TICKET EMAIL FAILED =====');
    console.error('❌ Error details:', error);
    console.error('❌ Error stack:', error.stack);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendETicketEmail,
  generateETicketHTML,
  generateETicketText,
  generateQRCode
};
