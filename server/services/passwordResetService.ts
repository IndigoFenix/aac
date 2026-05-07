// server/services/passwordResetService.ts
// Business logic for password reset operations

import { passwordResetRepository } from "../repositories/passwordResetRepository";
import { userRepository } from "../repositories";
import { emailService } from "./emailService";
import bcrypt from "bcryptjs";

interface PasswordResetResult {
  success: boolean;
  error?: string;
  // True iff the user existed AND the SMTP send itself failed. Lets the
  // caller surface a "delivery failed" error to the operator while still
  // never revealing whether the email maps to a real account in the
  // happy / no-user paths.
  sendFailed?: boolean;
  sendError?: string;
  // Set on a successful reset so the caller can audit which user account
  // had its password changed.
  userId?: string;
}

export class PasswordResetService {
  private readonly TOKEN_EXPIRY_MINUTES = 60; // 1 hour
  private readonly SALT_ROUNDS = 12; // matches userRepository registration cost

  /**
   * Request a password reset
   * Creates a token and sends an email
   */
  async requestPasswordReset(
    email: string,
    baseUrl: string = "https://aivota.ai"
  ): Promise<PasswordResetResult> {
    try {
      // Find user by email
      const user = await userRepository.getUserByEmail(email.toLowerCase());
      
      if (!user) {
        // Don't reveal if user exists or not
        console.log(`Password reset requested for non-existent email: ${email}`);
        return { success: true }; // Silent success for security
      }

      // Check if user has a password (not OAuth-only)
      // OAuth users might not have a password set
      
      // Create reset token
      const { token, expiresAt } = await passwordResetRepository.createToken(
        user.id,
        this.TOKEN_EXPIRY_MINUTES
      );

      // Build reset link
      const resetLink = `${baseUrl}/reset-password/${token}`;

      // Send email
      const emailResult = await emailService.sendPasswordResetEmail({
        email: user.email,
        firstName: user.firstName || user.fullName || undefined,
        resetLink,
        expiresAt,
      });

      if (!emailResult.success) {
        console.error(`Failed to send password reset email to ${email}:`, emailResult.error);
        return { success: true, sendFailed: true, sendError: emailResult.error };
      }

      console.log(`Password reset email sent to ${email}`);
      return { success: true };
    } catch (error) {
      console.error("Password reset request error:", error);
      return { success: false, error: "Failed to process password reset request" };
    }
  }

  /**
   * Create a password reset token (for use by authController)
   * Returns the plain token to be sent via email
   */
  async createPasswordResetToken(userId: string): Promise<string> {
    const { token } = await passwordResetRepository.createToken(
      userId,
      this.TOKEN_EXPIRY_MINUTES
    );
    return token;
  }

  /**
   * Validate a reset token
   */
  async validateToken(token: string): Promise<{
    valid: boolean;
    email?: string;
    error?: string;
  }> {
    const result = await passwordResetRepository.validateToken(token);
    
    if (!result.valid) {
      return { valid: false, error: result.error };
    }

    return {
      valid: true,
      email: result.user?.email,
    };
  }

  /**
   * Reset password using a token
   */
  async resetPassword(
    token: string,
    newPassword: string
  ): Promise<PasswordResetResult> {
    try {
      // Validate password strength
      if (newPassword.length < 6) {
        return { success: false, error: "Password must be at least 6 characters" };
      }

      // Validate token
      const tokenResult = await passwordResetRepository.validateToken(token);
      
      if (!tokenResult.valid || !tokenResult.user || !tokenResult.tokenRecord) {
        return { success: false, error: tokenResult.error || "Invalid or expired reset link" };
      }

      const { user, tokenRecord } = tokenResult;

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

      // Update user's password
      const updated = await userRepository.updateUser(user.id, {
        password: hashedPassword,
      });

      if (!updated) {
        return { success: false, error: "Failed to update password" };
      }

      // Mark token as used
      await passwordResetRepository.markTokenUsed(tokenRecord.id);

      // Invalidate any other tokens for this user
      await passwordResetRepository.invalidateUserTokens(user.id);

      console.log(`Password reset successful for user ${user.id}`);

      return { success: true, userId: user.id };
    } catch (error) {
      console.error("Password reset error:", error);
      return { success: false, error: "Failed to reset password" };
    }
  }

  /**
   * Clean up expired tokens (for scheduled job)
   */
  async cleanupExpiredTokens(): Promise<number> {
    return passwordResetRepository.cleanupExpiredTokens();
  }
}

export const passwordResetService = new PasswordResetService();
