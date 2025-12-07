import {
  users,
  creditTransactions,
  creditPackages,
  type CreditTransaction,
  type InsertCreditTransaction,
  type CreditPackage,
  type InsertCreditPackage,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, sql } from "drizzle-orm";

export class CreditRepository {
  // Credit transaction operations
  async createCreditTransaction(
    transaction: InsertCreditTransaction
  ): Promise<CreditTransaction> {
    const [creditTransaction] = await db
      .insert(creditTransactions)
      .values(transaction)
      .returning();
    return creditTransaction;
  }

  async getUserCreditTransactions(userId: string): Promise<CreditTransaction[]> {
    return await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt));
  }

  async updateUserCredits(
    userId: string,
    amount: number,
    type: string,
    description: string,
    stripePaymentIntentId?: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx.insert(creditTransactions).values({
        userId,
        amount,
        type,
        description,
        stripePaymentIntentId,
      });
    });
  }

  async setUserCredits(
    userId: string,
    newAmount: number,
    description: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [currentUser] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.id, userId));

      if (!currentUser) {
        throw new Error("User not found");
      }

      const difference = newAmount - currentUser.credits;

      await tx
        .update(users)
        .set({
          credits: newAmount,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx.insert(creditTransactions).values({
        userId,
        amount: difference,
        type: "set",
        description: `${description} (Set to ${newAmount} credits)`,
      });
    });
  }

  async rewardReferralBonus(
    newUserId: string,
    referrerId: string,
    bonusAmount: number
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Update new user's credits
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${bonusAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, newUserId));

      await tx.insert(creditTransactions).values({
        userId: newUserId,
        amount: bonusAmount,
        type: "referral_bonus",
        description: `Referral signup bonus`,
      });

      // Update referrer's credits
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${bonusAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, referrerId));

      await tx.insert(creditTransactions).values({
        userId: referrerId,
        amount: bonusAmount,
        type: "referral_reward",
        description: `Referral reward for inviting new user`,
      });
    });
  }

  // Credit package operations
  async createCreditPackage(creditPackage: InsertCreditPackage): Promise<CreditPackage> {
    const [newCreditPackage] = await db
      .insert(creditPackages)
      .values(creditPackage)
      .returning();
    return newCreditPackage;
  }

  async getAllCreditPackages(): Promise<CreditPackage[]> {
    return await db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.isActive, true))
      .orderBy(creditPackages.sortOrder, creditPackages.price);
  }

  async getCreditPackage(id: string): Promise<CreditPackage | undefined> {
    const [creditPackage] = await db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.id, id));
    return creditPackage || undefined;
  }

  async updateCreditPackage(
    id: string,
    updates: Partial<CreditPackage>
  ): Promise<CreditPackage | undefined> {
    const [creditPackage] = await db
      .update(creditPackages)
      .set(updates)
      .where(eq(creditPackages.id, id))
      .returning();
    return creditPackage || undefined;
  }

  async deleteCreditPackage(id: string): Promise<boolean> {
    const result = await db
      .delete(creditPackages)
      .where(eq(creditPackages.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}

export const creditRepository = new CreditRepository();
