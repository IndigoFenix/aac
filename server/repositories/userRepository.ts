import {
  users,
  aacUsers,
  aacUserSchedules,
  inviteCodeRedemptions,
  inviteCodes,
  interpretations,
  savedLocations,
  creditTransactions,
  passwordResetTokens,
  apiCalls,
  type User,
  type InsertUser,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, count, sql } from "drizzle-orm";

export class UserRepository {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId));
    return user || undefined;
  }

  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.referralCode, referralCode));
      return user || undefined;
    } catch (error) {
      console.error(`Error getting user by referral code:`, error);
      return undefined;
    }
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const bcrypt = await import("bcryptjs");
    const hashedPassword = insertUser.password
      ? await bcrypt.hash(insertUser.password, 12)
      : null;

    const referralCode = this.generateReferralCode();

    const userData = {
      ...insertUser,
      password: hashedPassword,
      fullName:
        insertUser.firstName && insertUser.lastName
          ? `${insertUser.firstName} ${insertUser.lastName}`
          : null,
      authProvider: "email",
      referralCode,
    };

    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async createGoogleUser(googleData: {
    email: string;
    firstName?: string;
    lastName?: string;
    googleId: string;
    profileImageUrl?: string;
    userType?: string;
  }): Promise<User> {
    const referralCode = this.generateReferralCode();

    const userData = {
      ...googleData,
      fullName:
        googleData.firstName && googleData.lastName
          ? `${googleData.firstName} ${googleData.lastName}`
          : null,
      authProvider: "google",
      userType: googleData.userType || "Caregiver",
      referralCode,
    };

    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async updateUserOnboardingStep(userId: string, step: number): Promise<void> {
    await db
      .update(users)
      .set({ onboardingStep: step, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async deleteUser(id: string): Promise<boolean> {
    try {
      // First, get all AAC users for this user to delete their schedules
      const userAacUsers = await db
        .select()
        .from(aacUsers)
        .where(eq(aacUsers.userId, id));

      // Delete AAC user schedules (foreign key to aac_users)
      for (const aacUser of userAacUsers) {
        await db
          .delete(aacUserSchedules)
          .where(eq(aacUserSchedules.aacUserId, aacUser.aacUserId));
      }

      // Delete invite code redemptions (foreign key to users)
      await db
        .delete(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.redeemedByUserId, id));

      // Delete invite codes created by user (foreign key to users)
      await db.delete(inviteCodes).where(eq(inviteCodes.createdByUserId, id));

      // Delete user's interpretations
      await db.delete(interpretations).where(eq(interpretations.userId, id));

      // Delete user's AAC users
      await db.delete(aacUsers).where(eq(aacUsers.userId, id));

      // Delete user's saved locations
      await db.delete(savedLocations).where(eq(savedLocations.userId, id));

      // Delete user's credit transactions
      await db
        .delete(creditTransactions)
        .where(eq(creditTransactions.userId, id));

      // Delete user's password reset tokens
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, id));

      // Delete user's API calls (nullable userId, so this is safe)
      await db.delete(apiCalls).where(eq(apiCalls.userId, id));

      // Finally delete the user
      await db.delete(users).where(eq(users.id, id));

      return true;
    } catch (error) {
      console.error("Error deleting user:", error);
      return false;
    }
  }

  async getUsersStats(): Promise<{ total: number; active: number; premium: number }> {
    const [totalResult] = await db.select({ count: count() }).from(users);
    const [activeResult] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.isActive, true));
    const [premiumResult] = await db
      .select({ count: count() })
      .from(users)
      .where(sql`${users.subscriptionType} != 'free'`);

    return {
      total: totalResult.count,
      active: activeResult.count,
      premium: premiumResult.count,
    };
  }

  generateReferralCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const part1 = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    const part2 = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    return `${part1}-${part2}`;
  }
}

export const userRepository = new UserRepository();
