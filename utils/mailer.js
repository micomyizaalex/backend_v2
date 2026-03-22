let transporter = null;
const smtpFromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '';
try {
  const nodemailer = require('nodemailer');
  // Configure transporter from environment variables if provided
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === 'true';

  if (host && port && user && pass) {
    transporter = nodemailer.createTransport({ 
      host, 
      port, 
      secure,
      auth: { user, pass }
    });
    console.log('✅ Email transporter initialized successfully');
  } else {
    console.log('⚠️  Email transporter not configured - missing SMTP credentials');
  }
} catch (e) {
  console.error('❌ Failed to initialize email transporter:', e.message);
}

const sendEmail = async ({ to, subject, text, html }) => {
  if (transporter) {
    try {
      const info = await transporter.sendMail({ 
        from: `"${process.env.SMTP_FROM_NAME || 'SafariTix'}" <${smtpFromEmail}>`, 
        to, 
        subject, 
        text, 
        html 
      });
      console.log('✅ Email sent successfully:', info.messageId);
      return info;
    } catch (error) {
      console.error('❌ Failed to send email:', error.message);
      throw error;
    }
  }
  // Fallback: log the email
  console.log('⚠️  Email not sent (no transporter configured) - would have sent:');
  console.log({ to, subject, text: text?.substring(0, 100) });
  return Promise.resolve({ fallback: true });
};

const sendSMS = async ({ to, text }) => {
  // No SMS provider configured; log for now. Add Twilio integration if needed.
  console.log('mailer: sendSMS fallback — SMS not sent (no provider configured)');
  console.log({ to, text });
  return Promise.resolve();
};

module.exports = { sendEmail, sendSMS };
