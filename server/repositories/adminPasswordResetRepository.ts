// server/repositories/adminPasswordResetRepository.ts
// Repository for admin password reset token operations. Parallel to
// passwordResetRepository but FK'd to admin_users.

import {
  adminPasswordResetTokens,
  adminUsers,
  type AdminPasswordResetToken,
  type AdminUser,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gt, isNull, lt } from "drizzle-orm";
import crypto from "crypto";

export class AdminPasswordResetRepository {
  generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async createToken(
    adminUserId: string,
    expiresInMinutes: number = 60,
  ): Promise<{ token: string; expiresAt: Date }> {
    await this.invalidateAdminTokens(adminUserId);

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes);

    await db.insert(adminPasswordResetTokens).values({
      adminUserId,
      tokenHash,
      expiresAt,
    });

    return { token, expiresAt };
  }

  async validateToken(token: string): Promise<{
    valid: boolean;
    admin?: AdminUser;
    tokenRecord?: AdminPasswordResetToken;
    error?: string;
  }> {
    const tokenHash = this.hashToken(token);

    const [result] = await db
      .select({
        token: adminPasswordResetTokens,
        admin: adminUsers,
      })
      .from(adminPasswordResetTokens)
      .innerJoin(adminUsers, eq(adminPasswordResetTokens.adminUserId, adminUsers.id))
      .where(
        and(
          eq(adminPasswordResetTokens.tokenHash, tokenHash),
          isNull(adminPasswordResetTokens.usedAt),
          gt(adminPasswordResetTokens.expiresAt, new Date()),
        ),
      );

    if (!result) {
      return { valid: false, error: "Invalid or expired reset link" };
    }

    return { valid: true, admin: result.admin, tokenRecord: result.token };
  }

  async markTokenUsed(tokenId: string): Promise<boolean> {
    const [updated] = await db
      .update(adminPasswordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(adminPasswordResetTokens.id, tokenId))
      .returning();
    return !!updated;
  }

  async invalidateAdminTokens(adminUserId: string): Promise<number> {
    const result = await db
      .update(adminPasswordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(adminPasswordResetTokens.adminUserId, adminUserId),
          isNull(adminPasswordResetTokens.usedAt),
        ),
      )
      .returning();
    return result.length;
  }

  async cleanupExpiredTokens(): Promise<number> {
    const result = await db
      .delete(adminPasswordResetTokens)
      .where(lt(adminPasswordResetTokens.expiresAt, new Date()))
      .returning();
    return result.length;
  }
}

export const adminPasswordResetRepository = new AdminPasswordResetRepository();
