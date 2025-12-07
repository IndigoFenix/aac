import {
  inviteCodes,
  inviteCodeRedemptions,
  aacUsers,
  type InviteCode,
  type InsertInviteCode,
  type InviteCodeRedemption,
  type AacUser,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, and, sql } from "drizzle-orm";

export class InviteCodeRepository {
  async createInviteCode(inviteCode: InsertInviteCode): Promise<InviteCode> {
    const code = this.generateInviteCode();
    const [created] = await db
      .insert(inviteCodes)
      .values({ ...inviteCode, code })
      .returning();
    return created;
  }

  async getInviteCode(code: string): Promise<InviteCode | undefined> {
    const [inviteCode] = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code));
    return inviteCode || undefined;
  }

  async getInviteCodesByUserId(userId: string): Promise<InviteCode[]> {
    return await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.createdByUserId, userId))
      .orderBy(desc(inviteCodes.createdAt));
  }

  async redeemInviteCode(
    code: string,
    userId: string
  ): Promise<{ success: boolean; aacUser?: AacUser; error?: string }> {
    try {
      const inviteCode = await this.getInviteCode(code);

      if (!inviteCode) {
        return { success: false, error: "Invalid invite code" };
      }

      if (!inviteCode.isActive) {
        return { success: false, error: "This invite code has been deactivated" };
      }

      if (inviteCode.expiresAt && new Date(inviteCode.expiresAt) < new Date()) {
        return { success: false, error: "This invite code has expired" };
      }

      if (
        inviteCode.redemptionLimit &&
        inviteCode.timesRedeemed >= inviteCode.redemptionLimit
      ) {
        return { success: false, error: "This invite code has reached its redemption limit" };
      }

      // Check if user already redeemed this code
      const [existingRedemption] = await db
        .select()
        .from(inviteCodeRedemptions)
        .where(
          and(
            eq(inviteCodeRedemptions.inviteCodeId, inviteCode.id),
            eq(inviteCodeRedemptions.redeemedByUserId, userId)
          )
        );

      if (existingRedemption) {
        return { success: false, error: "You have already redeemed this invite code" };
      }

      // Get the AAC user that this code grants access to
      const [aacUser] = await db
        .select()
        .from(aacUsers)
        .where(eq(aacUsers.id, inviteCode.aacUserId));

      if (!aacUser) {
        return { success: false, error: "AAC user not found" };
      }

      // Create redemption record and update count
      await db.transaction(async (tx) => {
        await tx.insert(inviteCodeRedemptions).values({
          inviteCodeId: inviteCode.id,
          redeemedByUserId: userId,
          redeemedAt: new Date(),
          aacUserId: aacUser.id,
        });

        await tx
          .update(inviteCodes)
          .set({ timesRedeemed: sql`${inviteCodes.timesRedeemed} + 1` })
          .where(eq(inviteCodes.id, inviteCode.id));
      });

      return { success: true, aacUser };
    } catch (error) {
      console.error("Error redeeming invite code:", error);
      return { success: false, error: "Failed to redeem invite code" };
    }
  }

  async getInviteCodeRedemptions(userId: string): Promise<InviteCodeRedemption[]> {
    return await db
      .select()
      .from(inviteCodeRedemptions)
      .where(eq(inviteCodeRedemptions.redeemedByUserId, userId))
      .orderBy(desc(inviteCodeRedemptions.redeemedAt));
  }

  async deactivateInviteCode(id: string): Promise<boolean> {
    const [updated] = await db
      .update(inviteCodes)
      .set({ isActive: false })
      .where(eq(inviteCodes.id, id))
      .returning();
    return !!updated;
  }

  private generateInviteCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(
      { length: 8 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  }
}

export const inviteCodeRepository = new InviteCodeRepository();
