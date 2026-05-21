// server/repositories/mfaRepository.ts
// Repository for MFA recovery token operations

import {
  mfaRecoveryTokens,
  users,
  adminUsers,
  type MfaRecoveryToken,
  type User,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gt, isNull, lt } from "drizzle-orm";
import crypto from "crypto";
import { hydrateRecords } from "../external-storage";
import { adaptAdminAsUser } from "../services/adminAuthService";

export class MfaRepository {
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
   * Create an MFA recovery token for a user
   * Invalidates any existing tokens for this user
   */
  async createRecoveryToken(
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

    await db.insert(mfaRecoveryTokens).values({
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
    tokenRecord?: MfaRecoveryToken;
    error?: string;
  }> {
    const tokenHash = this.hashToken(token);

    const [result] = await db
      .select({
        token: mfaRecoveryTokens,
        user: users,
      })
      .from(mfaRecoveryTokens)
      .innerJoin(users, eq(mfaRecoveryTokens.userId, users.id))
      .where(
        and(
          eq(mfaRecoveryTokens.tokenHash, tokenHash),
          isNull(mfaRecoveryTokens.usedAt),
          gt(mfaRecoveryTokens.expiresAt, new Date())
        )
      );

    if (!result) {
      return { valid: false, error: "Invalid or expired recovery link" };
    }

    const [hydratedUser] = await hydrateRecords("users", [result.user]);
    return {
      valid: true,
      user: hydratedUser,
      tokenRecord: result.token,
    };
  }

  /**
   * Mark a token as used
   */
  async markTokenUsed(tokenId: string): Promise<boolean> {
    const [updated] = await db
      .update(mfaRecoveryTokens)
      .set({ usedAt: new Date() })
      .where(eq(mfaRecoveryTokens.id, tokenId))
      .returning();

    return !!updated;
  }

  /**
   * Invalidate all tokens for a user
   */
  async invalidateUserTokens(userId: string): Promise<number> {
    const result = await db
      .update(mfaRecoveryTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryTokens.userId, userId),
          isNull(mfaRecoveryTokens.usedAt)
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
      .delete(mfaRecoveryTokens)
      .where(lt(mfaRecoveryTokens.expiresAt, new Date()))
      .returning();

    return result.length;
  }

  /**
   * Whether a given id belongs to an admin (admin_users) rather than a
   * regular user. Used to route MFA writes to the correct table.
   */
  private async isAdminId(id: string): Promise<boolean> {
    const [row] = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    return !!row;
  }

  /**
   * Update user MFA settings
   */
  async enableMfa(userId: string, encryptedSecret: string): Promise<boolean> {
    if (await this.isAdminId(userId)) {
      const [updated] = await db
        .update(adminUsers)
        .set({
          mfaEnabled: true,
          mfaSecret: encryptedSecret,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, userId))
        .returning();
      return !!updated;
    }

    const [updated] = await db
      .update(users)
      .set({
        mfaEnabled: true,
        mfaSecret: encryptedSecret,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    return !!updated;
  }

  /**
   * Disable MFA for a user
   */
  async disableMfa(userId: string): Promise<boolean> {
    if (await this.isAdminId(userId)) {
      const [updated] = await db
        .update(adminUsers)
        .set({
          mfaEnabled: false,
          mfaSecret: null,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, userId))
        .returning();
      return !!updated;
    }

    const [updated] = await db
      .update(users)
      .set({
        mfaEnabled: false,
        mfaSecret: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    return !!updated;
  }

  /**
   * Set admin MFA enforcement for a user
   */
  async setMfaEnforcement(userId: string, enforced: boolean): Promise<boolean> {
    if (await this.isAdminId(userId)) {
      const [updated] = await db
        .update(adminUsers)
        .set({
          mfaEnforcedByAdmin: enforced,
          updatedAt: new Date(),
        })
        .where(eq(adminUsers.id, userId))
        .returning();
      return !!updated;
    }

    const [updated] = await db
      .update(users)
      .set({
        mfaEnforcedByAdmin: enforced,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    return !!updated;
  }

  /**
   * Get user by ID (for MFA operations). Returns an adapted admin pseudo-user
   * when the id belongs to admin_users, otherwise the regular users row.
   */
  async getUserById(userId: string): Promise<User | undefined> {
    const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    if (admin) return adaptAdminAsUser(admin);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return undefined;
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }

  /**
   * Get user by email (for MFA recovery). Returns an adapted admin pseudo-user
   * when the email belongs to admin_users, otherwise the regular users row.
   */
  async getUserByEmail(email: string): Promise<User | undefined> {
    const normalized = email.toLowerCase();
    const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.email, normalized));
    if (admin) return adaptAdminAsUser(admin);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalized));
    if (!user) return undefined;
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }
}

export const mfaRepository = new MfaRepository();
