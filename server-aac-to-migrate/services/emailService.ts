import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface PasswordResetEmailData {
  userEmail: string;
  resetToken: string;
  userName?: string;
  language?: 'en' | 'he';
}

class EmailService {
  private transporter: Transporter | null = null;
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  private async initialize() {
    try {
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = parseInt(process.env.SMTP_PORT || '465');
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;

      if (!smtpHost || !smtpUser || !smtpPass) {
        console.log('SMTP configuration incomplete, email service disabled');
        return;
      }

      // Use SSL (port 465) for Titan Email since STARTTLS port may be blocked
      const finalPort = smtpHost === 'smtp.titan.email' ? 465 : smtpPort;
      console.log(`Using port ${finalPort} for ${smtpHost}`);

      // Simplified configuration for Titan Email
      const transportConfig = {
        host: smtpHost,
        port: finalPort,
        secure: true, // Use SSL for port 465
        auth: {
          user: smtpUser,
          pass: smtpPass,
        }
      };

      this.transporter = nodemailer.createTransport(transportConfig);

      // Verify connection
      await this.transporter.verify();
      
      const encryption = finalPort === 465 ? 'SSL' : 'STARTTLS';
      console.log(`Titan Email SMTP initialized: ${smtpHost}:${finalPort} (${encryption})`);
      this.isInitialized = true;

    } catch (error) {
      console.error('Failed to initialize email service:', error);
      this.transporter = null;
      this.isInitialized = false;
    }
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.transporter || !this.isInitialized) {
      console.error('Email service not initialized');
      return false;
    }

    try {
      const mailOptions = {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || undefined,
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`Email sent successfully to ${options.to}:`, result.messageId);
      return true;

    } catch (error) {
      console.error('Failed to send email:', error);
      return false;
    }
  }

  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<boolean> {
    const { userEmail, resetToken, userName = '', language = 'en' } = data;
    
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password?token=${resetToken}`;
    
    // Hebrew RTL email template
    const hebrewTemplate = `
      <!DOCTYPE html>
      <html dir="rtl" lang="he">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>איפוס סיסמה - Xahaph</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right; background-color: #f5f5f5; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
          .content { padding: 30px; }
          .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: bold; margin: 20px 0; }
          .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .security-note { background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Xahaph</h1>
            <h2>בקשת איפוס סיסמה</h2>
          </div>
          <div class="content">
            <p>שלום ${userName},</p>
            <p>קיבלנו בקשה לאיפוס הסיסמה שלך באפליקציית Xahaph.</p>
            <p>לחץ על הכפתור למטה כדי לאפס את הסיסמה שלך:</p>
            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">איפוס סיסמה</a>
            </div>
            <div class="security-note">
              <strong>⚠️ הערת אבטחה:</strong>
              <ul>
                <li>הקישור תקף למשך 24 שעות בלבד</li>
                <li>אם לא ביקשת איפוס סיסמה, התעלם מהודעה זו</li>
                <li>לעולם אל תשתף את הקישור עם אחרים</li>
              </ul>
            </div>
            <p>במידה ויש לך שאלות, צור איתנו קשר דרך אתר האינטרנט שלנו.</p>
            <p>בברכה,<br>צוות Xahaph</p>
          </div>
          <div class="footer">
            <p>Xahaph - מערכת תקשורת מתקדמת עם בינה מלאכותית</p>
            <p>הודעה זו נשלחה אוטומטית, אנא אל תענה עליה ישירות.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // English LTR email template
    const englishTemplate = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - Xahaph</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
          .content { padding: 30px; }
          .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: bold; margin: 20px 0; }
          .footer { background-color: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .security-note { background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Xahaph</h1>
            <h2>Password Reset Request</h2>
          </div>
          <div class="content">
            <p>Hello ${userName},</p>
            <p>We received a request to reset your password for your Xahaph account.</p>
            <p>Click the button below to reset your password:</p>
            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">Reset Password</a>
            </div>
            <div class="security-note">
              <strong>⚠️ Security Notice:</strong>
              <ul>
                <li>This link is valid for 24 hours only</li>
                <li>If you didn't request a password reset, please ignore this email</li>
                <li>Never share this link with others</li>
              </ul>
            </div>
            <p>If you have any questions, please contact us through our website.</p>
            <p>Best regards,<br>The Xahaph Team</p>
          </div>
          <div class="footer">
            <p>Xahaph - Advanced AI-Powered Communication System</p>
            <p>This message was sent automatically, please do not reply directly.</p>
          </div>
        </div>
      </div>
      </body>
      </html>
    `;

    const template = language === 'he' ? hebrewTemplate : englishTemplate;
    const subject = language === 'he' ? 'איפוס סיסמה - Xahaph' : 'Password Reset - Xahaph';

    return await this.sendEmail({
      to: userEmail,
      subject,
      html: template
    });
  }

  async sendAdminNotification(subject: string, message: string, adminEmail?: string): Promise<boolean> {
    const targetEmail = adminEmail || process.env.SMTP_USER || 'admin@xahaph.com';
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px;">
          🔔 Xahaph Admin Notification
        </h2>
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
          ${message}
        </div>
        <p style="color: #666; font-size: 12px;">
          Sent from Xahaph System at ${new Date().toLocaleString()}
        </p>
      </div>
    `;

    return await this.sendEmail({
      to: targetEmail,
      subject: `[Xahaph Admin] ${subject}`,
      html
    });
  }

  isReady(): boolean {
    return this.isInitialized && this.transporter !== null;
  }

  getStatus(): { initialized: boolean, host?: string, port?: number } {
    return {
      initialized: this.isInitialized,
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465')
    };
  }
}

// Create singleton instance
export const emailService = new EmailService();