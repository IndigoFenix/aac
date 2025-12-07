import {
  userRepository,
  interpretationRepository,
  settingsRepository,
  creditRepository,
  apiProviderRepository,
} from "../repositories";
import { type User, type SubscriptionPlan } from "@shared/schema";

export class AdminService {
  // Dashboard stats
  async getDashboardStats(): Promise<{
    users: { total: number; active: number; premium: number };
    interpretations: { total: number; today: number; thisWeek: number };
  }> {
    const [usersStats, interpretationsStats] = await Promise.all([
      userRepository.getUsersStats(),
      interpretationRepository.getInterpretationsStats(),
    ]);

    return {
      users: usersStats,
      interpretations: interpretationsStats,
    };
  }

  // User management
  async getAllUsersWithAacUsers(): Promise<any[]> {
    const users = await userRepository.getAllUsers();
    const { aacUserRepository } = await import("../repositories");

    const usersWithAacUsers = await Promise.all(
      users.map(async (user) => {
        const aacUsers = await aacUserRepository.getAacUsersByUserId(user.id);
        return {
          ...user,
          aacUsers: aacUsers || [],
        };
      })
    );

    return usersWithAacUsers;
  }

  async updateUserAdmin(
    userId: string,
    updates: {
      firstName?: string;
      lastName?: string;
      email?: string;
      userType?: string;
      subscriptionType?: string;
      isActive?: boolean;
    }
  ): Promise<User | undefined> {
    const allowedFields = [
      "firstName",
      "lastName",
      "email",
      "userType",
      "subscriptionType",
      "isActive",
    ];
    const validUserTypes = ["Parent", "Caregiver", "Teacher", "SLP", "admin"];
    const filteredUpdates: any = {};

    for (const field of allowedFields) {
      if ((updates as any)[field] !== undefined) {
        if (
          field === "userType" &&
          !validUserTypes.includes((updates as any)[field])
        ) {
          throw new Error("Invalid user type");
        }
        filteredUpdates[field] = (updates as any)[field];
      }
    }

    // Update fullName if firstName or lastName changed
    if (
      filteredUpdates.firstName !== undefined ||
      filteredUpdates.lastName !== undefined
    ) {
      const user = await userRepository.getUser(userId);
      if (user) {
        const firstName =
          filteredUpdates.firstName !== undefined
            ? filteredUpdates.firstName
            : user.firstName;
        const lastName =
          filteredUpdates.lastName !== undefined
            ? filteredUpdates.lastName
            : user.lastName;
        filteredUpdates.fullName = `${firstName || ""} ${lastName || ""}`.trim();
      }
    }

    return userRepository.updateUser(userId, filteredUpdates);
  }

  // Credits management
  async updateUserCredits(
    userId: string,
    amount: number,
    type: string,
    description: string,
    operation: "add" | "set" = "add"
  ): Promise<void> {
    if (operation === "set") {
      await creditRepository.setUserCredits(userId, amount, description);
    } else {
      await creditRepository.updateUserCredits(userId, amount, type, description);
    }
  }

  async getUserCreditTransactions(userId: string) {
    return creditRepository.getUserCreditTransactions(userId);
  }

  // System prompt management
  async getSystemPrompt(): Promise<string> {
    return settingsRepository.getSystemPrompt();
  }

  async updateSystemPrompt(prompt: string): Promise<void> {
    return settingsRepository.updateSystemPrompt(prompt);
  }

  // Settings management
  async getSetting(key: string, defaultValue?: string): Promise<string | null> {
    return settingsRepository.getSetting(key, defaultValue);
  }

  async updateSetting(key: string, value: string): Promise<void> {
    return settingsRepository.updateSetting(key, value);
  }

  // Subscription plans
  async getAllSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return settingsRepository.getAllSubscriptionPlans();
  }

  // Interpretations
  async getAllInterpretationsWithUsers(limit?: number) {
    return interpretationRepository.getAllInterpretationsWithUsers(limit);
  }

  // API usage stats
  async getApiUsageStats() {
    return apiProviderRepository.getApiUsageStats();
  }

  async getApiCalls(limit?: number, offset?: number) {
    return apiProviderRepository.getApiCalls(limit, offset);
  }

  async getApiCallsByProvider(providerId: string, limit?: number, offset?: number) {
    return apiProviderRepository.getApiCallsByProvider(providerId, limit, offset);
  }

  async getApiCallsCount(providerId?: string) {
    return apiProviderRepository.getApiCallsCount(providerId);
  }

  // API providers
  async getApiProviders() {
    return apiProviderRepository.getApiProviders();
  }

  async createApiProvider(provider: any) {
    return apiProviderRepository.createApiProvider(provider);
  }

  async updateApiProvider(id: string, updates: any) {
    return apiProviderRepository.updateApiProvider(id, updates);
  }
}

export const adminService = new AdminService();
