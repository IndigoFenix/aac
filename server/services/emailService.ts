// server/services/emailService.ts
// Email service using SMTP for sending transactional emails

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface InstituteInviteEmailData {
  inviteeEmail: string;
  instituteName: string;
  instituteType: "school" | "clinic";
  inviterName?: string;
  role: string;
  isAdmin: boolean;
  message?: string;
  inviteLink: string;
  expiresAt: Date;
}

interface WelcomeEmailData {
  email: string;
  firstName: string;
  instituteName?: string;
}

interface LicenseInviteEmailData {
  inviteeEmail: string;
  licenseName: string;
  licenseType: string;
  instituteName?: string;
  inviteLink: string;
  expiresAt: Date;
}

interface PasswordResetEmailData {
  email: string;
  firstName?: string;
  resetLink: string;
  expiresAt: Date;
}

class EmailService {
  private transporter: Transporter | null = null;
  private isConfigured: boolean = false;
  private fromAddress: string;

  constructor() {
    this.fromAddress = "cs@aivota.ai";
    this.initialize();
  }

  private initialize(): void {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
      console.warn(
        "Email service: SMTP not configured. Email sending disabled.",
        "Missing env vars:",
        !SMTP_HOST && "SMTP_HOST",
        !SMTP_PORT && "SMTP_PORT",
        !SMTP_USER && "SMTP_USER",
        !SMTP_PASS && "SMTP_PASS"
      );
      return;
    }

    try {
      const port = parseInt(SMTP_PORT, 10);
      this.transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465, // true for 465, false for other ports
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
        connectionTimeout: 10000, // 10s to establish connection
        greetingTimeout: 10000,   // 10s for SMTP greeting
        socketTimeout: 15000,     // 15s for socket inactivity
      });

      // Prevent unhandled error events from crashing the process
      this.transporter.on("error", (err) => {
        console.error("Email service: Transporter error:", err.message);
      });

      this.isConfigured = true;
      console.log("Email service: SMTP configured successfully");
    } catch (error) {
      console.error("Email service: Failed to configure SMTP:", error);
    }
  }

  /**
   * Check if email service is ready to send emails
   */
  isReady(): boolean {
    return this.isConfigured && this.transporter !== null;
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) return false;

    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      console.error("Email service: SMTP verification failed:", error);
      return false;
    }
  }

  /**
   * Send a generic email
   */
  async sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isReady()) {
      console.warn("Email service: Attempted to send email but service is not configured");
      return { success: false, error: "Email service not configured" };
    }

    try {
      const result = await this.transporter!.sendMail({
        from: this.fromAddress,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      console.log(`Email sent successfully to ${options.to}, messageId: ${result.messageId}`);
      return { success: true, messageId: result.messageId };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`Email service: Failed to send email to ${options.to}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  // ==================== Institute Invite Emails ====================

  /**
   * Send an institute invite email
   */
  async sendInstituteInvite(data: InstituteInviteEmailData): Promise<{ success: boolean; error?: string }> {
    const { inviteeEmail, instituteName, instituteType, inviterName, role, isAdmin, message, inviteLink, expiresAt } = data;

    const instituteTypeLabel = instituteType === "clinic" ? "Clinic" : "School";
    const adminLabel = isAdmin ? " with admin privileges" : "";
    const expiryDate = expiresAt.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const subject = `You've been invited to join ${instituteName} on CliniAACian`;

    const text = `
You've been invited to join ${instituteName}!

${inviterName ? `${inviterName} has invited you` : "You have been invited"} to join ${instituteName} (${instituteTypeLabel}) as a ${role}${adminLabel}.

${message ? `Personal message: "${message}"` : ""}

Click the link below to accept the invitation:
${inviteLink}

This invitation expires on ${expiryDate}.

If you didn't expect this invitation, you can safely ignore this email.

---
CliniAACian - AAC Tools for Healthcare & Education
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Institute Invitation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CliniAACian</h1>
              <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">AAC Tools for Healthcare & Education</p>
            </td>
          </tr>
        </table>

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td>
              <h2 style="color: #18181b; margin: 0 0 20px 0; font-size: 22px;">You've been invited! 🎉</h2>
              
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${inviterName ? `<strong>${inviterName}</strong> has invited you` : "You have been invited"} to join 
                <strong>${instituteName}</strong> on CliniAACian.
              </p>

              <!-- Institute Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <tr>
                  <td>
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="vertical-align: top; padding-right: 15px;">
                          <div style="width: 48px; height: 48px; background-color: #e0e7ff; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                            <span style="font-size: 24px;">${instituteType === "clinic" ? "🏥" : "🏫"}</span>
                          </div>
                        </td>
                        <td style="vertical-align: top;">
                          <p style="margin: 0; font-weight: 600; color: #18181b; font-size: 16px;">${instituteName}</p>
                          <p style="margin: 4px 0 0 0; color: #71717a; font-size: 14px;">${instituteTypeLabel}</p>
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top: 15px;">
                      <tr>
                        <td style="background-color: #e0e7ff; color: #4338ca; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500;">
                          ${role}
                        </td>
                        ${isAdmin ? `
                        <td style="padding-left: 8px;">
                          <span style="background-color: #fef3c7; color: #b45309; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500;">
                            Admin
                          </span>
                        </td>
                        ` : ""}
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              ${message ? `
              <!-- Personal Message -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-left: 4px solid #6366f1; padding-left: 15px; margin: 20px 0;">
                <tr>
                  <td>
                    <p style="color: #52525b; font-size: 14px; font-style: italic; margin: 0;">"${message}"</p>
                  </td>
                </tr>
              </table>
              ` : ""}

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${inviteLink}" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; text-align: center; margin: 20px 0 0 0;">
                This invitation expires on <strong>${expiryDate}</strong>
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px 30px; text-align: center;">
          <tr>
            <td>
              <p style="color: #71717a; font-size: 12px; margin: 0;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
              <p style="color: #a1a1aa; font-size: 11px; margin: 10px 0 0 0;">
                © ${new Date().getFullYear()} CliniAACian. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    return this.sendEmail({
      to: inviteeEmail,
      subject,
      text,
      html,
    });
  }

  // ==================== Welcome Email ====================

  /**
   * Send a welcome email to a new user
   */
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<{ success: boolean; error?: string }> {
    const { email, firstName, instituteName } = data;

    const subject = `Welcome to CliniAACian${instituteName ? ` - ${instituteName}` : ""}!`;

    const text = `
Welcome to CliniAACian, ${firstName}!

${instituteName ? `You've successfully joined ${instituteName}.` : "Your account has been created successfully."}

You can now access all the AAC tools and features available on our platform:
- Create and manage AAC boards
- Track student progress
- Collaborate with your team
- And much more!

Get started by logging in at: https://aivota.ai/login

If you have any questions, feel free to reach out to our support team.

Best regards,
The CliniAACian Team
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to CliniAACian</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome to CliniAACian! 🎉</h1>
            </td>
          </tr>
        </table>

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td>
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                Hi <strong>${firstName}</strong>,
              </p>
              
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${instituteName 
                  ? `You've successfully joined <strong>${instituteName}</strong> on CliniAACian!`
                  : "Your CliniAACian account has been created successfully!"
                }
              </p>

              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                You now have access to all our AAC tools and features:
              </p>

              <ul style="color: #3f3f46; font-size: 15px; line-height: 1.8; margin: 0 0 20px 0; padding-left: 20px;">
                <li>Create and manage AAC boards</li>
                <li>Track student progress</li>
                <li>Collaborate with your team</li>
                <li>Generate reports and assessments</li>
              </ul>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="https://aivota.ai/login" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      Get Started
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; margin: 20px 0 0 0;">
                If you have any questions, feel free to reach out to our support team.
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px 30px; text-align: center;">
          <tr>
            <td>
              <p style="color: #71717a; font-size: 12px; margin: 0;">
                Best regards,<br>The CliniAACian Team
              </p>
              <p style="color: #a1a1aa; font-size: 11px; margin: 10px 0 0 0;">
                © ${new Date().getFullYear()} CliniAACian. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    return this.sendEmail({
      to: email,
      subject,
      text,
      html,
    });
  }

  // ==================== Password Reset Email ====================

  /**
   * Send a password reset email
   */
  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<{ success: boolean; error?: string }> {
    const { email, firstName, resetLink, expiresAt } = data;

    const expiryTime = expiresAt.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      month: "short",
      day: "numeric",
    });

    const subject = "Reset Your CliniAACian Password";

    const text = `
Password Reset Request

${firstName ? `Hi ${firstName},` : "Hello,"}

We received a request to reset your password for your CliniAACian account.

Click the link below to reset your password:
${resetLink}

This link will expire at ${expiryTime}.

If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.

---
CliniAACian - AAC Tools for Healthcare & Education
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CliniAACian</h1>
              <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">Password Reset</p>
            </td>
          </tr>
        </table>

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td>
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${firstName ? `Hi <strong>${firstName}</strong>,` : "Hello,"}
              </p>
              
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                We received a request to reset your password for your CliniAACian account.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetLink}" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; text-align: center; margin: 20px 0;">
                This link will expire at <strong>${expiryTime}</strong>
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef3c7; border-radius: 8px; padding: 15px; margin: 20px 0;">
                <tr>
                  <td>
                    <p style="color: #92400e; font-size: 13px; margin: 0;">
                      ⚠️ If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px 30px; text-align: center;">
          <tr>
            <td>
              <p style="color: #a1a1aa; font-size: 11px; margin: 0;">
                © ${new Date().getFullYear()} CliniAACian. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    return this.sendEmail({
      to: email,
      subject,
      text,
      html,
    });
  }
  // ==================== License Invite Email ====================

  /**
   * Send a license invite email
   */
  async sendLicenseInvite(data: LicenseInviteEmailData): Promise<{ success: boolean; error?: string }> {
    const { inviteeEmail, licenseName, licenseType, instituteName, inviteLink, expiresAt } = data;

    const expiryDate = expiresAt.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const subject = `Your CliniAACian License is Ready`;

    const instituteText = instituteName ? ` for ${instituteName}` : "";

    const text = `
Your CliniAACian License is Ready!

A ${licenseType} license${instituteText} has been created for you.

License: ${licenseName}

Click the link below to get started:
${inviteLink}

This invitation expires on ${expiryDate}.

If you didn't expect this, you can safely ignore this email.

---
CliniAACian - AAC Tools for Healthcare & Education
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>License Invitation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CliniAACian</h1>
              <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">Your License is Ready</p>
            </td>
          </tr>
        </table>

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td>
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                A <strong>${licenseType}</strong> license${instituteText} has been created for you on CliniAACian.
              </p>

              <!-- License Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <tr>
                  <td>
                    <p style="margin: 0; font-weight: 600; color: #18181b; font-size: 16px;">${licenseName}</p>
                    <p style="margin: 4px 0 0 0; color: #71717a; font-size: 14px;">${licenseType} license</p>
                    ${instituteName ? `<p style="margin: 4px 0 0 0; color: #71717a; font-size: 14px;">Institute: ${instituteName}</p>` : ""}
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${inviteLink}" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      Get Started
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; text-align: center; margin: 20px 0 0 0;">
                This invitation expires on <strong>${expiryDate}</strong>
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px 30px; text-align: center;">
          <tr>
            <td>
              <p style="color: #71717a; font-size: 12px; margin: 0;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
              <p style="color: #a1a1aa; font-size: 11px; margin: 10px 0 0 0;">
                &copy; ${new Date().getFullYear()} CliniAACian. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    return this.sendEmail({
      to: inviteeEmail,
      subject,
      text,
      html,
    });
  }
}

export const emailService = new EmailService();
