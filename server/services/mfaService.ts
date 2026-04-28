// server/services/mfaService.ts
// Service for TOTP-based MFA operations

import { TOTP, generateSecret, generateURI, verifySync } from "otplib";
import * as QRCode from "qrcode";
import crypto from "crypto";
import { mfaRepository } from "../repositories/mfaRepository";
import { emailService } from "./emailService";
import type { User } from "@shared/schema";

// Configuration
const APP_NAME = "Aivota";
const MFA_TOKEN_EXPIRY_MINUTES = 5;
const RECOVERY_TOKEN_EXPIRY_MINUTES = 60;

// Encryption key for MFA secrets (should be in env)
const ENCRYPTION_KEY =
  process.env.MFA_ENCRYPTION_KEY ||
  crypto.randomBytes(32).toString("hex").slice(0, 32);
const ENCRYPTION_IV_LENGTH = 16;

// Secret for signing MFA challenge tokens
const MFA_TOKEN_SECRET =
  process.env.MFA_TOKEN_SECRET ||
  process.env.SESSION_SECRET ||
  "mfa-token-secret-fallback";

interface MfaSetupData {
  secret: string;
  qrCodeDataUrl: string;
  manualEntryKey: string;
}

interface MfaTokenPayload {
  userId: string;
  exp: number;
  type: "mfa_challenge" | "mfa_setup";
}

export class MfaService {
  /**
   * Encrypt a TOTP secret for storage
   */
  private encryptSecret(secret: string): string {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(ENCRYPTION_KEY),
      iv
    );
    let encrypted = cipher.update(secret, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  /**
   * Decrypt a stored TOTP secret
   */
  private decryptSecret(encryptedSecret: string): string {
    const [ivHex, encrypted] = encryptedSecret.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(ENCRYPTION_KEY),
      iv
    );
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Generate a new TOTP secret and QR code for setup
   */
  async generateSetupData(email: string): Promise<MfaSetupData> {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
      label: email,
      issuer: APP_NAME,
      secret,
      algorithm: "sha1",
      digits: 6,
      period: 30,
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return {
      secret,
      qrCodeDataUrl,
      manualEntryKey: secret,
    };
  }

  /**
   * Verify a TOTP code against a secret
   */
  verifyToken(secret: string, token: string): boolean {
    try {
      const result = verifySync({ token, secret });
      return result.valid;
    } catch {
      return false;
    }
  }

  /**
   * Enable MFA for a user after successful setup verification
   */
  async enableMfa(userId: string, secret: string): Promise<boolean> {
    const encryptedSecret = this.encryptSecret(secret);
    return mfaRepository.enableMfa(userId, encryptedSecret);
  }

  /**
   * Disable MFA for a user
   */
  async disableMfa(userId: string): Promise<boolean> {
    return mfaRepository.disableMfa(userId);
  }

  /**
   * Verify MFA code for an authenticated user
   */
  async verifyUserMfa(user: User, token: string): Promise<boolean> {
    if (!user.mfaEnabled || !user.mfaSecret) {
      return false;
    }

    try {
      const secret = this.decryptSecret(user.mfaSecret);
      return this.verifyToken(secret, token);
    } catch (error) {
      console.error("Error verifying MFA:", error);
      return false;
    }
  }

  /**
   * Generate a temporary MFA challenge token (signed, not JWT)
   * Used to bridge password verification and MFA verification
   */
  generateMfaToken(userId: string, type: "mfa_challenge" | "mfa_setup" = "mfa_challenge"): string {
    const payload: MfaTokenPayload = {
      userId,
      exp: Date.now() + MFA_TOKEN_EXPIRY_MINUTES * 60 * 1000,
      type,
    };

    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", MFA_TOKEN_SECRET)
      .update(data)
      .digest("base64url");

    return `${data}.${signature}`;
  }

  /**
   * Verify and decode an MFA challenge token
   */
  verifyMfaToken(
    token: string,
    expectedType: "mfa_challenge" | "mfa_setup" = "mfa_challenge"
  ): { valid: boolean; userId?: string; error?: string } {
    try {
      const [data, signature] = token.split(".");

      // Verify signature
      const expectedSignature = crypto
        .createHmac("sha256", MFA_TOKEN_SECRET)
        .update(data)
        .digest("base64url");

      if (signature !== expectedSignature) {
        return { valid: false, error: "Invalid token signature" };
      }

      // Decode payload
      const payload: MfaTokenPayload = JSON.parse(
        Buffer.from(data, "base64url").toString("utf8")
      );

      // Check expiry
      if (Date.now() > payload.exp) {
        return { valid: false, error: "Token expired" };
      }

      // Check type
      if (payload.type !== expectedType) {
        return { valid: false, error: "Invalid token type" };
      }

      return { valid: true, userId: payload.userId };
    } catch (error) {
      return { valid: false, error: "Invalid token format" };
    }
  }

  /**
   * Request MFA recovery - sends email with recovery link
   */
  async requestRecovery(
    email: string,
    baseUrl: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const user = await mfaRepository.getUserByEmail(email);

      // Silent success if user not found (security)
      if (!user || !user.mfaEnabled) {
        return { success: true };
      }

      // Create recovery token
      const { token, expiresAt } = await mfaRepository.createRecoveryToken(
        user.id,
        RECOVERY_TOKEN_EXPIRY_MINUTES
      );

      // Build recovery link
      const recoveryLink = `${baseUrl}/mfa-recovery/${token}`;

      // Send email
      await this.sendRecoveryEmail({
        email: user.email,
        firstName: user.firstName || user.fullName || undefined,
        recoveryLink,
        expiresAt,
      });

      return { success: true };
    } catch (error) {
      console.error("MFA recovery request error:", error);
      return { success: false, error: "Failed to process recovery request" };
    }
  }

  /**
   * Complete MFA recovery - disables MFA after token validation
   */
  async completeRecovery(
    token: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await mfaRepository.validateToken(token);

      if (!result.valid || !result.user || !result.tokenRecord) {
        return { success: false, error: result.error || "Invalid recovery link" };
      }

      // Disable MFA
      await mfaRepository.disableMfa(result.user.id);

      // Mark token as used
      await mfaRepository.markTokenUsed(result.tokenRecord.id);

      // Invalidate all other tokens
      await mfaRepository.invalidateUserTokens(result.user.id);

      console.log(`MFA disabled via recovery for user ${result.user.id}`);
      return { success: true };
    } catch (error) {
      console.error("MFA recovery completion error:", error);
      return { success: false, error: "Failed to complete recovery" };
    }
  }

  /**
   * Validate a recovery token
   */
  async validateRecoveryToken(
    token: string
  ): Promise<{ valid: boolean; email?: string; error?: string }> {
    const result = await mfaRepository.validateToken(token);

    if (!result.valid || !result.user) {
      return { valid: false, error: result.error };
    }

    // Mask email for display
    const email = result.user.email;
    const [localPart, domain] = email.split("@");
    const maskedLocal =
      localPart.length > 2
        ? localPart[0] + "***" + localPart[localPart.length - 1]
        : "***";
    const maskedEmail = `${maskedLocal}@${domain}`;

    return { valid: true, email: maskedEmail };
  }

  /**
   * Set admin MFA enforcement for a user
   */
  async setMfaEnforcement(
    userId: string,
    enforced: boolean
  ): Promise<boolean> {
    return mfaRepository.setMfaEnforcement(userId, enforced);
  }

  /**
   * Get user by ID for MFA operations
   */
  async getUserById(userId: string): Promise<User | undefined> {
    return mfaRepository.getUserById(userId);
  }

  /**
   * Send MFA recovery email
   */
  private async sendRecoveryEmail(data: {
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
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #dc2626; border-radius: 12px 12px 0 0; padding: 30px; text-align: center;">
          <tr>
            <td>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">CliniAACian</h1>
              <p style="color: #fecaca; margin: 10px 0 0 0; font-size: 14px;">MFA Recovery</p>
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
                We received a request to disable two-factor authentication on your CliniAACian account.
              </p>

              <!-- Warning -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef2f2; border-radius: 8px; padding: 16px; margin: 20px 0;">
                <tr>
                  <td>
                    <p style="color: #991b1b; font-size: 14px; line-height: 1.5; margin: 0;">
                      <strong>Warning:</strong> Disabling MFA will reduce the security of your account.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
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

        <!-- Footer -->
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

    return emailService.sendEmail({
      to: email,
      subject,
      text,
      html,
    });
  }
}

export const mfaService = new MfaService();
