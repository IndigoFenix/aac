import {
  //systemSettings,
  passwordResetTokens,
  subscriptionPlans,
  adminUsers,
  systemPrompt,
  type PasswordResetToken,
  type InsertPasswordResetToken,
  type SubscriptionPlan,
  type InsertSubscriptionPlan,
  type AdminUser,
  type UpsertAdminUser,
} from "@shared/schema";
import { db } from "../db";
import { eq, sql, desc } from "drizzle-orm";

export class SettingsRepository {
  // System settings
  async getSetting(key: string, defaultValue?: string): Promise<string | null> {
    return null; // Temporarily disabled
    /*
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      return setting?.value || defaultValue || null;
    } catch (error) {
      console.error(`Error getting setting ${key}:`, error);
      return defaultValue || null;
    }
    */
  }

  async updateSetting(key: string, value: string): Promise<void> {
    /*
    try {
      await db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    } catch (error) {
      console.error(`Error updating setting ${key}:`, error);
      throw error;
    }
    */
  }

  // System prompt operations
  async getSystemPrompt(): Promise<string> {
    return ""; // Temporarily disabled
    /*
    const [prompt] = await db
      .select()
      .from(systemPrompt)
      .orderBy(desc(systemPrompt.createdAt))
      .limit(1);

    return prompt?.prompt || "";
    */
  }

  async updateSystemPrompt(prompt: string): Promise<void> {
    //await db.insert(systemPrompt).values({ prompt });
  }

  // Password reset token operations
  async createPasswordResetToken(
    token: InsertPasswordResetToken
  ): Promise<PasswordResetToken> {
    const [resetToken] = await db
      .insert(passwordResetTokens)
      .values(token)
      .returning();
    return resetToken;
  }

  async getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined> {
    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, token));
    return resetToken || undefined;
  }

  async markTokenAsUsed(tokenId: string): Promise<void> {
    await db
      .update(passwordResetTokens)
      .set({ isUsed: true })
      .where(eq(passwordResetTokens.id, tokenId));
  }

  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();
    await db
      .delete(passwordResetTokens)
      .where(sql`${passwordResetTokens.expiresAt} < ${now}`);
  }

  // Subscription plan operations
  async createSubscriptionPlan(plan: InsertSubscriptionPlan): Promise<SubscriptionPlan> {
    const [subscriptionPlan] = await db
      .insert(subscriptionPlans)
      .values(plan)
      .returning();
    return subscriptionPlan;
  }

  async getAllSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return await db
      .select()
      .from(subscriptionPlans)
      .orderBy(subscriptionPlans.price);
  }

  async updateSubscriptionPlan(
    id: string,
    updates: Partial<SubscriptionPlan>
  ): Promise<SubscriptionPlan | undefined> {
    const [plan] = await db
      .update(subscriptionPlans)
      .set(updates)
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return plan || undefined;
  }

  // Admin user operations (for Replit Auth)
  async getAdminUser(id: string): Promise<AdminUser | undefined> {
    const [user] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    return user || undefined;
  }

  async upsertAdminUser(userData: UpsertAdminUser): Promise<AdminUser> {
    const [user] = await db
      .insert(adminUsers)
      .values(userData)
      .onConflictDoUpdate({
        target: adminUsers.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }
}

export const settingsRepository = new SettingsRepository();
