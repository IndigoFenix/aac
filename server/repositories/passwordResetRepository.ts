// server/repositories/passwordResetRepository.ts
// Repository for password reset token operations

import {
  passwordResetTokens,
  users,
  type PasswordResetToken,
  type User,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gt, isNull, lt } from "drizzle-orm";
import crypto from "crypto";

export class PasswordResetRepository {
  /**
   * Generate a secure random token
   */
  generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Hash a token for storage
   */
  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Create a password reset token for a user
   * Invalidates any existing tokens for this user
   */
  async createToken(
    userId: string,
    expiresInMinutes: number = 60
  ): Promise<{ token: string; expiresAt: Date }> {
    // Invalidate existing tokens for this user
    await this.invalidateUserTokens(userId);

    // Generate new token
    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes);

    await db.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /**
   * Validate a token and return the associated user if valid
   */
  async validateToken(token: string): Promise<{
    valid: boolean;
    user?: User;
    tokenRecord?: PasswordResetToken;
    error?: string;
  }> {
    const tokenHash = this.hashToken(token);

    const [result] = await db
      .select({
        token: passwordResetTokens,
        user: users,
      })
      .from(passwordResetTokens)
      .innerJoin(users, eq(passwordResetTokens.userId, users.id))
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      );

    if (!result) {
      return { valid: false, error: "Invalid or expired reset link" };
    }

    return {
      valid: true,
      user: result.user,
      tokenRecord: result.token,
    };
  }

  /**
   * Mark a token as used
   */
  async markTokenUsed(tokenId: string): Promise<boolean> {
    const [updated] = await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, tokenId))
      .returning();

    return !!updated;
  }

  /**
   * Invalidate all tokens for a user
   */
  async invalidateUserTokens(userId: string): Promise<number> {
    const result = await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.usedAt)
        )
      )
      .returning();

    return result.length;
  }

  /**
   * Clean up expired tokens (for scheduled cleanup job)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const result = await db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, new Date()))
      .returning();

    return result.length;
  }

  /**
   * Get token by hash (for internal use)
   */
  async getTokenByHash(tokenHash: string): Promise<PasswordResetToken | undefined> {
    const [token] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));

    return token || undefined;
  }
}

export const passwordResetRepository = new PasswordResetRepository();
