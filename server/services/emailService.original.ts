import 'dotenv/config';
import nodemailer from 'nodemailer';
import crypto from 'crypto';

// Email service configuration - Google Workspace SMTP
let transporter: nodemailer.Transporter | null = null;

// Initialize Google Workspace SMTP transporter
async function initializeEmailService() {
  // Validate required SMTP environment variables
  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Missing required SMTP environment variables: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS');
  }
  
  const smtpPort = parseInt(process.env.SMTP_PORT);
  
  // Google Workspace SMTP configuration
  const config = {
    host: 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpPort === 465, // true for port 465, false for other ports like 587
    auth: {
      user: process.env.SMTP_USER, // Full email address (e.g., user@yourdomain.com)
      pass: process.env.SMTP_PASS  // App password (not regular password)
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 60000, // 60 seconds
    greetingTimeout: 30000,   // 30 seconds
    socketTimeout: 60000      // 60 seconds
  };
  
  transporter = nodemailer.createTransport(config);
  
  console.log(`Google Workspace SMTP initialized: ${config.host}:${smtpPort} (secure: ${config.secure})`);
}

// Generate secure reset token
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Send password reset email
export async function sendPasswordResetEmail(
  email: string, 
  resetToken: string, 
  userName?: string
): Promise<boolean> {
  try {
    if (!transporter) {
      console.error('Email service not initialized');
      return false;
    }

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password?token=${resetToken}`;
    
    const mailOptions = {
      from: `"CommuniAACte" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: 'איפוס סיסמה - CommuniAACte',
      html: `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>איפוס סיסמה</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; direction: rtl; text-align: right; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: right; }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #007bff; margin-bottom: 10px; }
            .button { display: inline-block; padding: 12px 30px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; text-align: center; }
            .warning { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="logo">CommuniAACte</div>
              <h2>בקשה לאיפוס סיסמה</h2>
            </div>
            
            <p>שלום ${userName || ''},</p>
            
            <p>קיבלנו בקשה לאיפוס הסיסמה עבור החשבון שלך. אם ביקשת לאפס את הסיסמה, לחץ על הכפתור למטה:</p>
            
            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">איפוס סיסמה</a>
            </div>
            
            <div class="warning">
              <strong>חשוב:</strong> הקישור תקף למשך 24 שעות בלבד.
            </div>
            
            <p>אם לא ביקשת לאפס את הסיסמה, התעלם מהודעה זו. הסיסמה שלך תישאר ללא שינוי.</p>
            
            <p>אם הכפתור לא עובד, העתק והדבק את הקישור הבא בדפדפן:</p>
            <p style="word-break: break-all; color: #007bff; text-align: left;">${resetUrl}</p>
            
            <div class="footer">
              <p>הודעה זו נשלחה אוטומטית, אנא אל תשיב לכתובת זו.</p>
              <p>© ${new Date().getFullYear()} CommuniAACte. כל הזכויות שמורות.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
שלום ${userName || ''},

קיבלנו בקשה לאיפוס הסיסמה עבור החשבון שלך.

לאיפוס הסיסמה, היכנס לקישור הבא:
${resetUrl}

הקישור תקף למשך 24 שעות בלבד.

אם לא ביקשת לאפס את הסיסמה, התעלם מהודעה זו.

תודה,
צוות CommuniAACte
      `
    };

    const result = await transporter.sendMail(mailOptions);
    
    console.log('Google Workspace email sending result:', {
      messageId: result.messageId,
      response: result.response,
      envelope: result.envelope,
      accepted: result.accepted,
      rejected: result.rejected,
      pending: result.pending
    });
    
    // Check if email was actually accepted
    if (result.rejected && result.rejected.length > 0) {
      console.error('Email was rejected for recipients:', result.rejected);
      return false;
    }
    
    console.log('Google Workspace: Password reset email sent successfully to:', email);
    return true;
    
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    return false;
  }
}

// Initialize the email service when the module is loaded
initializeEmailService().catch(error => {
  console.error('Failed to initialize email service:', error);
});

export default {
  sendPasswordResetEmail,
  generateResetToken
};