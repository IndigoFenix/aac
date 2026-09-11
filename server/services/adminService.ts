import {
  userRepository,
  interpretationRepository,
  creditRepository,
} from "../repositories";

/**
 * What used to live here — the platform-user list/update, the system-prompt
 * pair, the generic `system_settings` get/put, subscription plans,
 * interpretations-with-users and the api-provider CRUD — were thin pass-throughs
 * for the `requireAdmin` routes deleted on 2026-09-10 (authorization structural
 * pass, phase 0a). The repositories they called are still reached by their other
 * callers; only these wrappers went.
 */
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

}

export const adminService = new AdminService();
