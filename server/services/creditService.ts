import { creditRepository, userRepository } from "../repositories";
import {
  type CreditTransaction,
  type CreditPackage,
  type InsertCreditPackage,
} from "@shared/schema";

export class CreditService {
  async validateCredits(userId: string): Promise<{
    hasCredits: boolean;
    credits: number;
  }> {
    const user = await userRepository.getUser(userId);
    if (!user) {
      return { hasCredits: false, credits: 0 };
    }
    return {
      hasCredits: user.credits > 0,
      credits: user.credits,
    };
  }

  async deductCredit(
    userId: string,
    description: string
  ): Promise<boolean> {
    try {
      await creditRepository.updateUserCredits(userId, -1, "usage", description);
      return true;
    } catch (error) {
      console.error(`Failed to deduct credit for user ${userId}:`, error);
      return false;
    }
  }

  async addCredits(
    userId: string,
    amount: number,
    type: string,
    description: string,
    stripePaymentIntentId?: string
  ): Promise<void> {
    await creditRepository.updateUserCredits(
      userId,
      amount,
      type,
      description,
      stripePaymentIntentId
    );
  }

  async setUserCredits(
    userId: string,
    newAmount: number,
    description: string
  ): Promise<void> {
    await creditRepository.setUserCredits(userId, newAmount, description);
  }

  async getUserCreditTransactions(userId: string): Promise<CreditTransaction[]> {
    return creditRepository.getUserCreditTransactions(userId);
  }

  async rewardReferralBonus(
    newUserId: string,
    referrerId: string,
    bonusAmount: number
  ): Promise<void> {
    return creditRepository.rewardReferralBonus(newUserId, referrerId, bonusAmount);
  }

  // Credit package operations
  async createCreditPackage(
    packageData: InsertCreditPackage
  ): Promise<CreditPackage> {
    return creditRepository.createCreditPackage(packageData);
  }

  async getAllCreditPackages(): Promise<CreditPackage[]> {
    return creditRepository.getAllCreditPackages();
  }

  async getCreditPackage(id: string): Promise<CreditPackage | undefined> {
    return creditRepository.getCreditPackage(id);
  }

  async updateCreditPackage(
    id: string,
    updates: Partial<CreditPackage>
  ): Promise<CreditPackage | undefined> {
    return creditRepository.updateCreditPackage(id, updates);
  }

  async deleteCreditPackage(id: string): Promise<boolean> {
    return creditRepository.deleteCreditPackage(id);
  }
}

export const creditService = new CreditService();
