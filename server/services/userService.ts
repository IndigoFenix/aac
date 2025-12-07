import { userRepository } from "../repositories";
import { creditRepository } from "../repositories";
import { settingsRepository } from "../repositories";
import { type User, type InsertUser } from "@shared/schema";
import bcrypt from "bcryptjs";

export class UserService {
  async registerUser(
    userData: InsertUser,
    referralCode?: string
  ): Promise<{ user: User; referralApplied: boolean }> {
    // Check if user already exists
    const existingUser = await userRepository.getUserByEmail(userData.email);
    if (existingUser) {
      throw new Error("An account with this email already exists");
    }

    // Validate referral code if provided
    let referrerId: string | null = null;
    if (referralCode && typeof referralCode === "string") {
      const referrer = await userRepository.getUserByReferralCode(referralCode);
      if (referrer) {
        referrerId = referrer.id;
      } else {
        console.log(`Invalid referral code provided: ${referralCode}`);
      }
    }

    // Create user with referred_by_id if valid referral code
    const userDataWithReferral = {
      ...userData,
      ...(referrerId && { referredById: referrerId }),
    };

    const user = await userRepository.createUser(userDataWithReferral);

    // Execute atomic credit rewards if user was referred
    if (referrerId) {
      try {
        const bonusCreditsStr = await settingsRepository.getSetting(
          "REFERRAL_BONUS_CREDITS",
          "50"
        );
        const bonusCredits = parseInt(bonusCreditsStr || "50", 10);

        await creditRepository.rewardReferralBonus(user.id, referrerId, bonusCredits);

        console.log(
          `Referral rewards processed: ${bonusCredits} credits to user ${user.id} and referrer ${referrerId}`
        );
      } catch (creditError) {
        console.error("Error processing referral credits:", creditError);
        throw new Error(
          "Account created but referral bonus failed. Please contact support."
        );
      }
    }

    // Fetch updated user data with correct credit balance
    const updatedUser = await userRepository.getUser(user.id);

    return {
      user: updatedUser || user,
      referralApplied: !!referrerId,
    };
  }

  async validateLogin(
    email: string,
    password: string
  ): Promise<User | null> {
    const user = await userRepository.getUserByEmail(email);
    if (!user || !user.password) {
      return null;
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return null;
    }

    return user;
  }

  async getUser(id: string): Promise<User | undefined> {
    return userRepository.getUser(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return userRepository.getUserByEmail(email);
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    return userRepository.getUserByGoogleId(googleId);
  }

  async createGoogleUser(googleData: {
    email: string;
    firstName?: string;
    lastName?: string;
    googleId: string;
    profileImageUrl?: string;
    userType?: string;
  }): Promise<User> {
    return userRepository.createGoogleUser(googleData);
  }

  async getAllUsers(): Promise<User[]> {
    return userRepository.getAllUsers();
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    return userRepository.updateUser(id, updates);
  }

  async updateUserProfile(
    userId: string,
    firstName: string,
    lastName?: string
  ): Promise<User | undefined> {
    const fullName = `${firstName.trim()} ${(lastName || "").trim()}`.trim();

    return userRepository.updateUser(userId, {
      firstName: firstName.trim(),
      lastName: lastName ? lastName.trim() : null,
      fullName,
    });
  }

  async updateProfileImage(
    userId: string,
    imageUrl: string
  ): Promise<User | undefined> {
    return userRepository.updateUser(userId, { profileImageUrl: imageUrl });
  }

  async updateOnboardingStep(userId: string, step: number): Promise<void> {
    return userRepository.updateUserOnboardingStep(userId, step);
  }

  async deleteUser(id: string): Promise<boolean> {
    return userRepository.deleteUser(id);
  }

  async getUsersStats(): Promise<{ total: number; active: number; premium: number }> {
    return userRepository.getUsersStats();
  }

  formatUserForResponse(user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      userType: user.userType,
      isAdmin: user.isAdmin,
      credits: user.credits,
      subscriptionType: user.subscriptionType,
      profileImageUrl: user.profileImageUrl,
      isActive: user.isActive,
      referralCode: user.referralCode,
    };
  }
}

export const userService = new UserService();
