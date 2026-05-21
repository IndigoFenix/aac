// server/services/adminPasswordResetService.ts
// Admin password reset: parallel to passwordResetService but writes to
// admin_users (the legacy users row is gone for admins as of 0107).

import bcrypt from "bcryptjs";
import { adminPasswordResetRepository } from "../repositories/adminPasswordResetRepository";
import { adminUserRepository } from "../repositories/adminUserRepository";
import { emailService } from "./emailService";

interface AdminPasswordResetResult {
  success: boolean;
  error?: string;
  sendFailed?: boolean;
  sendError?: string;
  adminId?: string;
}

class AdminPasswordResetService {
  private readonly TOKEN_EXPIRY_MINUTES = 60;
  private readonly SALT_ROUNDS = 12;

  /**
   * Request a password reset for an admin. Silent success if the email
   * doesn't match an admin (same convention as the regular user flow:
   * never leak account existence).
   */
  async requestPasswordReset(
    email: string,
    baseUrl: string = "https://aivota.ai",
  ): Promise<AdminPasswordResetResult> {
    try {
      const admin = await adminUserRepository.getByEmail(email.toLowerCase());
      if (!admin) {
        return { success: true };
      }

      const { token, expiresAt } = await adminPasswordResetRepository.createToken(
        admin.id,
        this.TOKEN_EXPIRY_MINUTES,
      );

      // Admin reset link lives under /admin/reset-password so the admin login
      // UI can be routed separately from the regular reset flow.
      const resetLink = `${baseUrl}/admin/reset-password/${token}`;

      const emailResult = await emailService.sendPasswordResetEmail({
        email: admin.email ?? email,
        firstName: admin.firstName ?? undefined,
        resetLink,
        expiresAt,
      });

      if (!emailResult.success) {
        console.error(`Failed to send admin password reset email to ${email}:`, emailResult.error);
        return { success: true, sendFailed: true, sendError: emailResult.error };
      }

      console.log(`Admin password reset email sent to ${email}`);
      return { success: true };
    } catch (error) {
      console.error("Admin password reset request error:", error);
      return { success: false, error: "Failed to process password reset request" };
    }
  }

  async validateToken(token: string): Promise<{
    valid: boolean;
    email?: string;
    error?: string;
  }> {
    const result = await adminPasswordResetRepository.validateToken(token);
    if (!result.valid || !result.admin) {
      return { valid: false, error: result.error };
    }
    return { valid: true, email: result.admin.email ?? undefined };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<AdminPasswordResetResult> {
    try {
      if (newPassword.length < 6) {
        return { success: false, error: "Password must be at least 6 characters" };
      }

      const tokenResult = await adminPasswordResetRepository.validateToken(token);
      if (!tokenResult.valid || !tokenResult.admin || !tokenResult.tokenRecord) {
        return { success: false, error: tokenResult.error || "Invalid or expired reset link" };
      }

      const { admin, tokenRecord } = tokenResult;
      const hashedPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

      const updated = await adminUserRepository.update(admin.id, {
        password: hashedPassword,
      } as any);

      if (!updated) {
        return { success: false, error: "Failed to update password" };
      }

      await adminPasswordResetRepository.markTokenUsed(tokenRecord.id);
      await adminPasswordResetRepository.invalidateAdminTokens(admin.id);

      console.log(`Admin password reset successful for admin ${admin.id}`);
      return { success: true, adminId: admin.id };
    } catch (error) {
      console.error("Admin password reset error:", error);
      return { success: false, error: "Failed to reset password" };
    }
  }

  async cleanupExpiredTokens(): Promise<number> {
    return adminPasswordResetRepository.cleanupExpiredTokens();
  }
}

export const adminPasswordResetService = new AdminPasswordResetService();
