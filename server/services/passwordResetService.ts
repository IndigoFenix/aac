import { settingsRepository, userRepository } from "../repositories";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export class PasswordResetService {
  generateResetToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  async createPasswordResetToken(userId: string): Promise<string> {
    // Cleanup expired tokens first
    await settingsRepository.cleanupExpiredTokens();

    const resetToken = this.generateResetToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await settingsRepository.createPasswordResetToken({
      userId,
      token: resetToken,
      expiresAt,
      isUsed: false,
    });

    return resetToken;
  }

  async validateResetToken(token: string): Promise<{
    valid: boolean;
    userId?: string;
    error?: string;
  }> {
    const resetToken = await settingsRepository.getPasswordResetToken(token);

    if (!resetToken) {
      return { valid: false, error: "Invalid or expired reset token" };
    }

    if (resetToken.expiresAt < new Date()) {
      return { valid: false, error: "Reset token has expired" };
    }

    if (resetToken.isUsed) {
      return { valid: false, error: "Reset token has already been used" };
    }

    return { valid: true, userId: resetToken.userId };
  }

  async resetPassword(
    token: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> {
    const validation = await this.validateResetToken(token);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const user = await userRepository.getUser(validation.userId!);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update user password
    await userRepository.updateUser(user.id, {
      password: hashedPassword,
      updatedAt: new Date(),
    });

    // Mark token as used
    const resetToken = await settingsRepository.getPasswordResetToken(token);
    if (resetToken) {
      await settingsRepository.markTokenAsUsed(resetToken.id);
    }

    console.log(`Password successfully reset for user: ${user.email} (ID: ${user.id})`);

    return { success: true };
  }

  async cleanupExpiredTokens(): Promise<void> {
    return settingsRepository.cleanupExpiredTokens();
  }
}

export const passwordResetService = new PasswordResetService();
