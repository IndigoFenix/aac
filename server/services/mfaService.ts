// server/services/mfaService.ts
// Service for TOTP-based MFA operations

import { TOTP, generateSecret, generateURI, verifySync } from "otplib";
import * as QRCode from "qrcode";
import crypto from "crypto";
import path from "path";
import sharp from "sharp";
import { mfaRepository } from "../repositories/mfaRepository";
import { emailService } from "./emailService";
import { deleteUserSessions } from "./sessionInvalidation";
import type { User } from "@shared/schema";

// Configuration
const APP_NAME = "Aivota";
const QR_SIZE = 400;
const LOGO_PATH = path.join(process.cwd(), "attached_assets/aivota_icon.png");
// Logo overlay buffer cached after first build (icon is static)
let cachedLogoOverlay: Buffer | null = null;
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
    // AES-256-GCM (authenticated). Output: iv:authTag:ciphertext.
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(ENCRYPTION_KEY),
      iv
    );
    let encrypted = cipher.update(secret, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return iv.toString("hex") + ":" + authTag + ":" + encrypted;
  }

  /**
   * Decrypt a stored TOTP secret. Accepts the current GCM format
   * (iv:authTag:ciphertext) and the legacy unauthenticated CBC format
   * (iv:ciphertext) so existing enrollments keep working.
   */
  private decryptSecret(encryptedSecret: string): string {
    const parts = encryptedSecret.split(":");
    if (parts.length === 3) {
      const [ivHex, authTagHex, encrypted] = parts;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        Buffer.from(ENCRYPTION_KEY),
        Buffer.from(ivHex, "hex")
      );
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    }
    // Legacy AES-256-CBC (iv:ciphertext).
    const [ivHex, encrypted] = parts;
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(ENCRYPTION_KEY),
      Buffer.from(ivHex, "hex")
    );
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * Build (and memoize) the Aivota logo overlay sized for the QR center.
   * White rounded square keeps the QR-side modules readable around the icon.
   */
  private async getLogoOverlay(): Promise<Buffer | null> {
    if (cachedLogoOverlay) return cachedLogoOverlay;
    try {
      const iconSize = Math.round(QR_SIZE * 0.20);
      const bgSize = Math.round(iconSize * 1.25);
      const cornerRadius = Math.round(bgSize * 0.18);

      const icon = await sharp(LOGO_PATH)
        .resize(iconSize, iconSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();

      const roundedMask = Buffer.from(
        `<svg width="${bgSize}" height="${bgSize}"><rect x="0" y="0" width="${bgSize}" height="${bgSize}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
      );

      cachedLogoOverlay = await sharp({
        create: { width: bgSize, height: bgSize, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
      })
        .composite([
          { input: roundedMask, blend: "dest-in" },
          { input: icon, gravity: "center" },
        ])
        .png()
        .toBuffer();
      return cachedLogoOverlay;
    } catch (error) {
      console.error("Failed to build MFA QR logo overlay; falling back to plain QR:", error);
      return null;
    }
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

    // High error correction (H ~30%) lets us overlay a center logo without breaking scannability.
    const qrBuffer = await QRCode.toBuffer(otpauthUrl, {
      errorCorrectionLevel: "H",
      width: QR_SIZE,
      margin: 2,
    });

    const overlay = await this.getLogoOverlay();
    const finalBuffer = overlay
      ? await sharp(qrBuffer).composite([{ input: overlay, gravity: "center" }]).png().toBuffer()
      : qrBuffer;

    const qrCodeDataUrl = `data:image/png;base64,${finalBuffer.toString("base64")}`;

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
      if (!data || !signature) {
        return { valid: false, error: "Invalid token format" };
      }

      // Verify signature with a constant-time comparison (the token bridges
      // password verification and TOTP, so a forged signature bypasses MFA).
      const expectedSignature = crypto
        .createHmac("sha256", MFA_TOKEN_SECRET)
        .update(data)
        .digest("base64url");

      const sigBuf = Buffer.from(signature, "base64url");
      const expBuf = Buffer.from(expectedSignature, "base64url");
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
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
  ): Promise<{ success: boolean; error?: string; sendFailed?: boolean; sendError?: string }> {
    try {
      const user = await mfaRepository.getUserByEmail(email);

      // Silent success if user not found (security)
      if (!user || !user.mfaEnabled) {
        return { success: true };
      }

      // Admins don't use the self-service recovery email path: the
      // mfa_recovery_tokens table FKs to users.id and admins no longer have
      // a users row (migration 0107). MFA for a stuck admin is reset by
      // another admin through the management UI / direct DB update.
      if ((user as any)?._identityKind === "admin") {
        return { success: true };
      }

      // Create recovery token
      const { token, expiresAt } = await mfaRepository.createRecoveryToken(
        user.id,
        RECOVERY_TOKEN_EXPIRY_MINUTES
      );

      // Build recovery link
      const recoveryLink = `${baseUrl}/mfa-recovery/${token}`;

      // Send email — sendRecoveryEmail returns {success, error} from
      // emailService.sendEmail; surface a delivery failure to the caller
      // (controller) so it can return a non-200 to the operator. The
      // user-existence side of this still stays silent.
      const sendResult = await this.sendRecoveryEmail({
        email: user.email,
        firstName: user.firstName || user.fullName || undefined,
        recoveryLink,
        expiresAt,
      });

      if (!sendResult.success) {
        console.error(`Failed to send MFA recovery email to ${email}:`, sendResult.error);
        return { success: true, sendFailed: true, sendError: sendResult.error };
      }

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

      // Evict existing sessions — recovering MFA is a security-sensitive change.
      await deleteUserSessions(result.user.id);

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
   * Send MFA recovery email. Delegates to `emailService.sendMfaRecoveryEmail`
   * so the admin-specific recovery flow can reuse the same template.
   */
  private async sendRecoveryEmail(data: {
    email: string;
    firstName?: string;
    recoveryLink: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; error?: string }> {
    return emailService.sendMfaRecoveryEmail(data);
  }
}

export const mfaService = new MfaService();
