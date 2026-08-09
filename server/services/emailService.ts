// server/services/emailService.ts
// Email service for sending transactional emails.
//
// Transport: Amazon SES (SESv2 SendEmail over HTTPS). We run on AWS, so this
// needs NO credential of its own — the Lambda/ECS role carries ses:SendEmail
// (terraform/ses.tf), and locally the SDK uses AWS_PROFILE. Never SMTP: the
// Gmail-SMTP era authenticated as a personal mailbox, which both branded all
// platform mail as that person and coupled sending to their account.
//
// Sender identity — see docs/EMAIL.md. The rule learned the hard way: the
// From address must NOT be a human's mailbox or a Workspace alias of one.
// Gmail resolves a known address against the Workspace directory and renders
// that person's profile name no matter what display name we set, so mail from
// `cs@aivota.ai` (an alias) shows up as its owner.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Fallback sender. `EMAIL_FROM` should be set in every deployed environment;
 * this default exists so a misconfigured host still sends under a neutral
 * identity rather than an arbitrary leftover address.
 */
const DEFAULT_FROM = "Aivota <noreply@aivota.ai>";

/** Where replies go. noreply@ is unattended, so point humans at support. */
const DEFAULT_REPLY_TO = "cs@aivota.ai";

/**
 * Settings from retired transports (Gmail SMTP, then briefly Resend). The
 * From address used to fall back through SMTP_FROM → SMTP_USER, which meant a
 * stale credential silently *became* the platform's sender identity. Nothing
 * reads these now; we only look at them to tell the operator they are dead
 * weight and should be removed.
 */
const LEGACY_EMAIL_VARS = [
  "SMTP_FROM",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_HOST",
  "SMTP_PORT",
  "RESEND_API_KEY",
] as const;

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface InstituteInviteEmailData {
  inviteeEmail: string;
  instituteName: string;
  instituteType: "school" | "clinic" | "family";
  inviterName?: string;
  role: string;
  isAdmin: boolean;
  message?: string;
  inviteLink: string;
  expiresAt: Date;
  language?: string;
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
  language?: string;
}

interface PasswordResetEmailData {
  email: string;
  firstName?: string;
  resetLink: string;
  expiresAt: Date;
}

export class EmailService {
  private ses: SESv2Client | null = null;
  private isConfigured: boolean = false;
  private fromAddress: string;
  private replyToAddress: string;

  constructor() {
    // EMAIL_FROM is the ONLY source of sender identity — no fallback chain.
    // Format should be "Display Name <addr@domain>"; a bare address works but
    // leaves the display name up to the recipient's mail client.
    this.fromAddress = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
    this.replyToAddress = process.env.EMAIL_REPLY_TO?.trim() || DEFAULT_REPLY_TO;
    this.initialize();
  }

  /** The From header this service sends under. Exposed for diagnostics/tests. */
  getFromAddress(): string {
    return this.fromAddress;
  }

  private getLogoUrl(): string {
    const baseUrl = process.env.APP_URL || "https://aivota.ai";
    return `${baseUrl}/aivota_logo_dark.png`;
  }

  private getEmailHeader(isHebrew: boolean): string {
    const dir = isHebrew ? 'dir="rtl"' : '';
    return `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td ${dir}>
              <img src="${this.getLogoUrl()}" alt="Aivota" style="height: 40px; width: auto;" />
              <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">${isHebrew ? "כלי AAC לבריאות וחינוך" : "AAC Tools for Healthcare & Education"}</p>
            </td>
          </tr>
        </table>`;
  }

  private getEmailFooter(isHebrew: boolean, safeIgnoreMessage?: boolean): string {
    const dir = isHebrew ? 'dir="rtl"' : '';
    const safeIgnore = safeIgnoreMessage
      ? `<p style="color: #71717a; font-size: 12px; margin: 0;" ${dir}>
          ${isHebrew ? "אם לא ציפית להזמנה זו, ניתן להתעלם מהודעה זו בבטחה." : "If you didn't expect this invitation, you can safely ignore this email."}
        </p>`
      : "";
    return `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px 30px; text-align: center;">
          <tr>
            <td>
              ${safeIgnore}
              <p style="color: #a1a1aa; font-size: 11px; margin: 10px 0 0 0;">
                &copy; ${new Date().getFullYear()} Aivota. All rights reserved.
              </p>
            </td>
          </tr>
        </table>`;
  }

  private initialize(): void {
    if (!process.env.EMAIL_FROM?.trim()) {
      console.warn(
        `Email service: EMAIL_FROM not set — falling back to "${DEFAULT_FROM}". ` +
          "Set EMAIL_FROM to an address on the SES-verified domain."
      );
    }

    const staleVars = LEGACY_EMAIL_VARS.filter((name) => process.env[name]);
    if (staleVars.length > 0) {
      console.warn(
        `Email service: settings from retired email transports are set but IGNORED (${staleVars.join(", ")}). ` +
          "Delete them — mail is sent via SES with role credentials, and the " +
          "SMTP ones used to override the sender identity."
      );
    }

    // No API key to check: SES authenticates with the ambient AWS credentials
    // (task/execution role in AWS, AWS_PROFILE locally). If those are missing
    // or lack ses:SendEmail, the failure surfaces per-send below. SES lives in
    // the same region as the rest of the stack — AWS_REGION is set by the
    // Lambda/ECS runtime and in local .env; SES_REGION is an escape hatch.
    const region =
      process.env.SES_REGION || process.env.AWS_REGION || "il-central-1";
    try {
      this.ses = new SESv2Client({ region });
      this.isConfigured = true;
      console.log(
        `Email service: SES configured (region=${region}, from=${this.fromAddress}, replyTo=${this.replyToAddress})`
      );
    } catch (error) {
      console.error("Email service: Failed to configure SES:", error);
    }
  }

  /**
   * Check if email service is ready to send emails
   */
  isReady(): boolean {
    return this.isConfigured && this.ses !== null;
  }

  /**
   * Verify the email transport is configured. SES is a stateless HTTP API
   * with no connection to open, so this just reports configuration status —
   * kept for API compatibility with prior callers.
   */
  async verifyConnection(): Promise<boolean> {
    return this.isReady();
  }

  /**
   * Send a generic email
   */
  async sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isReady()) {
      console.warn("Email service: Attempted to send email but service is not configured");
      return { success: false, error: "Email service not configured" };
    }

    const start = Date.now();
    try {
      // Explicit UTF-8 charsets: subjects and bodies are frequently Hebrew.
      const result = await this.ses!.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromAddress,
          ReplyToAddresses: [this.replyToAddress],
          Destination: { ToAddresses: [options.to] },
          Content: {
            Simple: {
              Subject: { Data: options.subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: options.text, Charset: "UTF-8" },
                Html: { Data: options.html, Charset: "UTF-8" },
              },
            },
          },
        })
      );

      console.log(
        `Email sent successfully to ${options.to} in ${Date.now() - start}ms, messageId: ${result.MessageId}`
      );
      return { success: true, messageId: result.MessageId };
    } catch (error: any) {
      // The SES SDK throws on failure; error.name pinpoints the cause. The two
      // usual ways this service goes quiet:
      //  • MessageRejected "Email address is not verified" — the From domain's
      //    identity isn't verified yet, OR the account is still in SANDBOX
      //    mode and the RECIPIENT isn't verified (docs/EMAIL.md).
      //  • CredentialsProviderError / AccessDenied — the role is missing
      //    ses:SendEmail (or no AWS creds locally).
      const errorMsg = `${error?.name ? `${error.name}: ` : ""}${error?.message || String(error)}`;
      const hint =
        error?.name === "MessageRejected"
          ? ` (unverified identity or SES sandbox — see docs/EMAIL.md)`
          : "";
      console.error(
        `Email service: Failed to send email to ${options.to} after ${Date.now() - start}ms: ${errorMsg}${hint}`
      );
      return { success: false, error: errorMsg };
    }
  }

  // ==================== Institute Invite Emails ====================

  /**
   * Send an institute invite email
   */
  async sendInstituteInvite(data: InstituteInviteEmailData): Promise<{ success: boolean; error?: string }> {
    const { inviteeEmail, instituteName, instituteType, inviterName, role, isAdmin, message, inviteLink, expiresAt, language } = data;

    const isHebrew = language === "he";

    const instituteTypeLabel = isHebrew
      ? (instituteType === "clinic" ? "מרפאה" : instituteType === "family" ? "משפחה" : "בית ספר")
      : (instituteType === "clinic" ? "Clinic" : instituteType === "family" ? "Family" : "School");
    const adminLabel = isHebrew
      ? (isAdmin ? " עם הרשאות מנהל" : "")
      : (isAdmin ? " with admin privileges" : "");
    const expiryDate = expiresAt.toLocaleDateString(isHebrew ? "he-IL" : "en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const subject = isHebrew
      ? `הוזמנת להצטרף ל-${instituteName} ב-Aivota CliniAACian`
      : `You've been invited to join ${instituteName} on Aivota CliniAACian`;

    const text = isHebrew
      ? `
הוזמנת להצטרף ל-${instituteName}!

${inviterName ? `${inviterName} הזמין/ה אותך` : "הוזמנת"} להצטרף ל-${instituteName} (${instituteTypeLabel}) כ-${role}${adminLabel}.

${message ? `הודעה אישית: "${message}"` : ""}

לחץ/י על הקישור הבא כדי לקבל את ההזמנה:
${inviteLink}

ההזמנה תפוג בתאריך ${expiryDate}.

אם לא ציפית להזמנה זו, ניתן להתעלם מהודעה זו בבטחה.

---
Aivota - כלי AAC לבריאות וחינוך
    `.trim()
      : `
You've been invited to join ${instituteName}!

${inviterName ? `${inviterName} has invited you` : "You have been invited"} to join ${instituteName} (${instituteTypeLabel}) as a ${role}${adminLabel}.

${message ? `Personal message: "${message}"` : ""}

Click the link below to accept the invitation:
${inviteLink}

This invitation expires on ${expiryDate}.

If you didn't expect this invitation, you can safely ignore this email.

---
Aivota - AAC Tools for Healthcare & Education
    `.trim();

    const dir = isHebrew ? ' dir="rtl"' : '';
    const msgBorderSide = isHebrew ? "border-right" : "border-left";
    const msgPaddingSide = isHebrew ? "padding-right" : "padding-left";
    const iconPaddingSide = isHebrew ? "padding-left" : "padding-right";
    const adminPaddingSide = isHebrew ? "padding-right" : "padding-left";

    const html = `
<!DOCTYPE html>
<html${dir}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isHebrew ? "הזמנה למוסד" : "Institute Invitation"}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        ${this.getEmailHeader(isHebrew)}

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td${dir}>
              <h2 style="color: #18181b; margin: 0 0 20px 0; font-size: 22px;">${isHebrew ? "קיבלת הזמנה! 🎉" : "You've been invited! 🎉"}</h2>

              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${isHebrew
                  ? `${inviterName ? `<strong>${inviterName}</strong> הזמין/ה אותך` : "הוזמנת"} להצטרף ל-<strong>${instituteName}</strong> ב-Aivota CliniAACian.`
                  : `${inviterName ? `<strong>${inviterName}</strong> has invited you` : "You have been invited"} to join <strong>${instituteName}</strong> on Aivota CliniAACian.`
                }
              </p>

              <!-- Institute Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <tr>
                  <td>
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="vertical-align: top; ${iconPaddingSide}: 15px;">
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
                        <td style="${adminPaddingSide}: 8px;">
                          <span style="background-color: #fef3c7; color: #b45309; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500;">
                            ${isHebrew ? "מנהל" : "Admin"}
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
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="${msgBorderSide}: 4px solid #6366f1; ${msgPaddingSide}: 15px; margin: 20px 0;">
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
                      ${isHebrew ? "קבל/י הזמנה" : "Accept Invitation"}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; text-align: center; margin: 20px 0 0 0;">
                ${isHebrew
                  ? `ההזמנה תפוג בתאריך <strong>${expiryDate}</strong>`
                  : `This invitation expires on <strong>${expiryDate}</strong>`
                }
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        ${this.getEmailFooter(isHebrew, true)}
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

    const subject = `Welcome to Aivota CliniAACian${instituteName ? ` - ${instituteName}` : ""}!`;

    const text = `
Welcome to Aivota CliniAACian, ${firstName}!

${instituteName ? `You've successfully joined ${instituteName}.` : "Your account has been created successfully."}

You can now access all the AAC tools and features available on our platform:
- Create and manage AAC boards
- Track student progress
- Collaborate with your team
- And much more!

Get started by logging in at: https://aivota.ai/login

If you have any questions, feel free to reach out to our support team.

Best regards,
The Aivota Team
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Aivota CliniAACian</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #6366f1; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <img src="${this.getLogoUrl()}" alt="Aivota" style="height: 40px; width: auto;" />
              <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 18px;">Welcome! 🎉</p>
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
                  ? `You've successfully joined <strong>${instituteName}</strong> on Aivota CliniAACian!`
                  : "Your Aivota CliniAACian account has been created successfully!"
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
                Best regards,<br>The Aivota Team
              </p>
              <p style="color: #a1a1aa; font-size: 11px; margin: 10px 0 0 0;">
                &copy; ${new Date().getFullYear()} Aivota. All rights reserved.
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

    const subject = "Reset Your Aivota CliniAACian Password";

    const text = `
Password Reset Request

${firstName ? `Hi ${firstName},` : "Hello,"}

We received a request to reset your password for your Aivota CliniAACian account.

Click the link below to reset your password:
${resetLink}

This link will expire at ${expiryTime}.

If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.

---
Aivota - AAC Tools for Healthcare & Education
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
              <img src="${this.getLogoUrl()}" alt="Aivota" style="height: 40px; width: auto;" />
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
                We received a request to reset your password for your Aivota CliniAACian account.
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
                &copy; ${new Date().getFullYear()} Aivota. All rights reserved.
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

  // ==================== MFA Recovery Email ====================

  /**
   * Send an MFA recovery email. Used by both the regular MFA recovery flow
   * and the admin-specific flow — the email body is identical aside from the
   * recovery link the caller supplies.
   */
  async sendMfaRecoveryEmail(data: {
    email: string;
    firstName?: string;
    recoveryLink: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; error?: string }> {
    const { email, firstName, recoveryLink, expiresAt } = data;

    const expiryTime = expiresAt.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      month: "short",
      day: "numeric",
    });

    const subject = "Disable Two-Factor Authentication - CliniAACian";

    const text = `
MFA Recovery Request

${firstName ? `Hi ${firstName},` : "Hello,"}

We received a request to disable two-factor authentication on your CliniAACian account.

Click the link below to disable MFA:
${recoveryLink}

This link will expire at ${expiryTime}.

If you didn't request this, please secure your account immediately by changing your password.

---
CliniAACian - AAC Tools for Healthcare & Education
    `.trim();

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Disable Two-Factor Authentication</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #dc2626; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CliniAACian</h1>
              <p style="color: #fecaca; margin: 10px 0 0 0; font-size: 14px;">MFA Recovery</p>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td>
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${firstName ? `Hi <strong>${firstName}</strong>,` : "Hello,"}
              </p>

              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                We received a request to disable two-factor authentication on your CliniAACian account.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef2f2; border-radius: 8px; padding: 16px; margin: 20px 0;">
                <tr>
                  <td>
                    <p style="color: #991b1b; font-size: 14px; line-height: 1.5; margin: 0;">
                      <strong>Warning:</strong> Disabling MFA will reduce the security of your account.
                    </p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${recoveryLink}" style="display: inline-block; background-color: #dc2626; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      Disable Two-Factor Authentication
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">
                This link will expire at <strong>${expiryTime}</strong>.
              </p>

              <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 20px 0 0 0;">
                If you didn't request this, please secure your account immediately by changing your password.
              </p>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 0 0 12px 12px; padding: 20px; text-align: center;">
          <tr>
            <td>
              <p style="color: #71717a; font-size: 12px; margin: 0;">
                CliniAACian - AAC Tools for Healthcare & Education
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

    return this.sendEmail({ to: email, subject, text, html });
  }

  // ==================== License Invite Email ====================

  /**
   * Send a license invite email
   */
  async sendLicenseInvite(data: LicenseInviteEmailData): Promise<{ success: boolean; error?: string }> {
    const { inviteeEmail, licenseName, licenseType, instituteName, inviteLink, expiresAt, language } = data;

    const isHebrew = language === "he";

    const expiryDate = expiresAt.toLocaleDateString(isHebrew ? "he-IL" : "en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const subject = isHebrew
      ? `רישיון Aivota CliniAACian שלך מוכן`
      : `Your Aivota CliniAACian License is Ready`;

    const instituteText = instituteName
      ? (isHebrew ? ` עבור ${instituteName}` : ` for ${instituteName}`)
      : "";

    const text = isHebrew
      ? `
רישיון Aivota CliniAACian שלך מוכן!

רישיון ${licenseType}${instituteText} נוצר עבורך.

רישיון: ${licenseName}

לחץ/י על הקישור הבא כדי להתחיל:
${inviteLink}

ההזמנה תפוג בתאריך ${expiryDate}.

אם לא ציפית להזמנה זו, ניתן להתעלם מהודעה זו בבטחה.

---
Aivota - כלי AAC לבריאות וחינוך
    `.trim()
      : `
Your Aivota CliniAACian License is Ready!

A ${licenseType} license${instituteText} has been created for you.

License: ${licenseName}

Click the link below to get started:
${inviteLink}

This invitation expires on ${expiryDate}.

If you didn't expect this, you can safely ignore this email.

---
Aivota - AAC Tools for Healthcare & Education
    `.trim();

    const dir = isHebrew ? ' dir="rtl"' : '';

    const html = `
<!DOCTYPE html>
<html${dir}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isHebrew ? "הזמנת רישיון" : "License Invitation"}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        ${this.getEmailHeader(isHebrew)}

        <!-- Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; padding: 40px 30px;">
          <tr>
            <td${dir}>
              <p style="color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                ${isHebrew
                  ? `רישיון <strong>${licenseType}</strong>${instituteText} נוצר עבורך ב-Aivota CliniAACian.`
                  : `A <strong>${licenseType}</strong> license${instituteText} has been created for you on Aivota CliniAACian.`
                }
              </p>

              <!-- License Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <tr>
                  <td${dir}>
                    <p style="margin: 0; font-weight: 600; color: #18181b; font-size: 16px;">${licenseName}</p>
                    <p style="margin: 4px 0 0 0; color: #71717a; font-size: 14px;">${isHebrew ? `רישיון ${licenseType}` : `${licenseType} license`}</p>
                    ${instituteName ? `<p style="margin: 4px 0 0 0; color: #71717a; font-size: 14px;">${isHebrew ? `מוסד: ${instituteName}` : `Institute: ${instituteName}`}</p>` : ""}
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${inviteLink}" style="display: inline-block; background-color: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; padding: 14px 32px; border-radius: 8px; font-size: 16px;">
                      ${isHebrew ? "להתחיל" : "Get Started"}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #71717a; font-size: 14px; text-align: center; margin: 20px 0 0 0;">
                ${isHebrew
                  ? `ההזמנה תפוג בתאריך <strong>${expiryDate}</strong>`
                  : `This invitation expires on <strong>${expiryDate}</strong>`
                }
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        ${this.getEmailFooter(isHebrew, true)}
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
