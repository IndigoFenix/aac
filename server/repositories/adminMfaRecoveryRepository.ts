// server/repositories/adminMfaRecoveryRepository.ts
// Repository for admin MFA recovery token operations. Parallel to the
// MFA-recovery half of mfaRepository but FK'd to admin_users.

import {
  adminMfaRecoveryTokens,
  adminUsers,
  type AdminMfaRecoveryToken,
  type AdminUser,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gt, isNull, lt } from "drizzle-orm";
import crypto from "crypto";

export class AdminMfaRecoveryRepository {
  generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async createRecoveryToken(
    adminUserId: string,
    expiresInMinutes: number = 60,
  ): Promise<{ token: string; expiresAt: Date }> {
    await this.invalidateAdminTokens(adminUserId);

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes);

    await db.insert(adminMfaRecoveryTokens).values({
      adminUserId,
      tokenHash,
      expiresAt,
    });

    return { token, expiresAt };
  }

  async validateToken(token: string): Promise<{
    valid: boolean;
    admin?: AdminUser;
    tokenRecord?: AdminMfaRecoveryToken;
    error?: string;
  }> {
    const tokenHash = this.hashToken(token);

    const [result] = await db
      .select({
        token: adminMfaRecoveryTokens,
        admin: adminUsers,
      })
      .from(adminMfaRecoveryTokens)
      .innerJoin(adminUsers, eq(adminMfaRecoveryTokens.adminUserId, adminUsers.id))
      .where(
        and(
          eq(adminMfaRecoveryTokens.tokenHash, tokenHash),
          isNull(adminMfaRecoveryTokens.usedAt),
          gt(adminMfaRecoveryTokens.expiresAt, new Date()),
        ),
      );

    if (!result) {
      return { valid: false, error: "Invalid or expired recovery link" };
    }

    return { valid: true, admin: result.admin, tokenRecord: result.token };
  }

  async markTokenUsed(tokenId: string): Promise<boolean> {
    const [updated] = await db
      .update(adminMfaRecoveryTokens)
      .set({ usedAt: new Date() })
      .where(eq(adminMfaRecoveryTokens.id, tokenId))
      .returning();
    return !!updated;
  }

  async invalidateAdminTokens(adminUserId: string): Promise<number> {
    const result = await db
      .update(adminMfaRecoveryTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(adminMfaRecoveryTokens.adminUserId, adminUserId),
          isNull(adminMfaRecoveryTokens.usedAt),
        ),
      )
      .returning();
    return result.length;
  }

  async cleanupExpiredTokens(): Promise<number> {
    const result = await db
      .delete(adminMfaRecoveryTokens)
      .where(lt(adminMfaRecoveryTokens.expiresAt, new Date()))
      .returning();
    return result.length;
  }
}

export const adminMfaRecoveryRepository = new AdminMfaRecoveryRepository();
