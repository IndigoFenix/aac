import { aacUserRepository } from "../repositories";
import {
  type AacUser,
  type InsertAacUser,
  type UpdateAacUser,
  type AacUserSchedule,
  type InsertAacUserSchedule,
  type UpdateAacUserSchedule,
  type UserAacUser,
  type InsertUserAacUser,
  type UpdateUserAacUser,
} from "@shared/schema";

export class AacUserService {
  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user and link it to the creating user
   * This is the primary method for creating AAC users through the app
   */
  async createAacUser(
    userId: string,
    name: string,
    gender?: string,
    birthDate?: string, // ISO date string 'YYYY-MM-DD'
    disabilityOrSyndrome?: string,
    backgroundContext?: string,
    role: string = "owner"
  ): Promise<AacUser> {
    const { aacUser } = await aacUserRepository.createAacUserWithLink(
      {
        name,
        gender,
        birthDate: birthDate || null,
        disabilityOrSyndrome,
        backgroundContext,
        isActive: true,
      },
      userId,
      role
    );
    return aacUser;
  }

  /**
   * Create an AAC user and return both the user and the link
   */
  async createAacUserWithLink(
    userId: string,
    name: string,
    gender?: string,
    birthDate?: string,
    disabilityOrSyndrome?: string,
    backgroundContext?: string,
    role: string = "owner"
  ): Promise<{ aacUser: AacUser; link: UserAacUser }> {
    return await aacUserRepository.createAacUserWithLink(
      {
        name,
        gender,
        birthDate: birthDate || null,
        disabilityOrSyndrome,
        backgroundContext,
        isActive: true,
      },
      userId,
      role
    );
  }

  /**
   * Get all AAC users linked to a specific user
   */
  async getAacUsersByUserId(userId: string): Promise<AacUser[]> {
    return aacUserRepository.getAacUsersByUserId(userId);
  }

  /**
   * Get all AAC users with their link details for a user
   */
  async getAacUsersWithLinksByUserId(
    userId: string
  ): Promise<{ aacUser: AacUser; link: UserAacUser }[]> {
    return aacUserRepository.getAacUsersWithLinksByUserId(userId);
  }

  /**
   * Get an AAC user by their ID
   */
  async getAacUserById(aacUserId: string): Promise<AacUser | undefined> {
    return aacUserRepository.getAacUserById(aacUserId);
  }

  /**
   * @deprecated Use getAacUserById instead
   */
  async getAacUserByAacUserId(aacUserId: string): Promise<AacUser | undefined> {
    return aacUserRepository.getAacUserById(aacUserId);
  }

  /**
   * Update an AAC user
   */
  async updateAacUser(
    aacUserId: string,
    updates: UpdateAacUser
  ): Promise<AacUser | undefined> {
    return aacUserRepository.updateAacUser(aacUserId, updates);
  }

  /**
   * Soft delete an AAC user
   */
  async deleteAacUser(aacUserId: string): Promise<boolean> {
    return aacUserRepository.deleteAacUser(aacUserId);
  }

  /**
   * Verify that a user has access to an AAC user
   */
  async verifyAacUserAccess(
    aacUserId: string,
    userId: string
  ): Promise<{ hasAccess: boolean; aacUser?: AacUser; link?: UserAacUser }> {
    const aacUser = await aacUserRepository.getAacUserById(aacUserId);
    if (!aacUser) {
      return { hasAccess: false };
    }

    const link = await aacUserRepository.getUserAacUserLink(userId, aacUserId);
    if (!link || !link.isActive) {
      return { hasAccess: false, aacUser };
    }

    return { hasAccess: true, aacUser, link };
  }

  // ==================== User-AAC User Link Operations ====================

  /**
   * Link a user to an existing AAC user
   */
  async linkUserToAacUser(
    userId: string,
    aacUserId: string,
    role: string = "caregiver"
  ): Promise<UserAacUser> {
    return aacUserRepository.createUserAacUserLink({
      userId,
      aacUserId,
      role,
      isActive: true,
    });
  }

  /**
   * Get the link between a user and an AAC user
   */
  async getUserAacUserLink(
    userId: string,
    aacUserId: string
  ): Promise<UserAacUser | undefined> {
    return aacUserRepository.getUserAacUserLink(userId, aacUserId);
  }

  /**
   * Get all users linked to an AAC user
   */
  async getUsersLinkedToAacUser(aacUserId: string): Promise<UserAacUser[]> {
    return aacUserRepository.getUsersByAacUserId(aacUserId);
  }

  /**
   * Update the link between a user and an AAC user
   */
  async updateUserAacUserLink(
    linkId: string,
    updates: UpdateUserAacUser
  ): Promise<UserAacUser | undefined> {
    return aacUserRepository.updateUserAacUserLink(linkId, updates);
  }

  /**
   * Remove a user's access to an AAC user (deactivates the link)
   */
  async unlinkUserFromAacUser(
    userId: string,
    aacUserId: string
  ): Promise<boolean> {
    return aacUserRepository.deactivateUserAacUserLink(userId, aacUserId);
  }

  // ==================== Schedule Operations ====================

  /**
   * Create a schedule entry for an AAC user
   */
  async createScheduleEntry(
    schedule: InsertAacUserSchedule
  ): Promise<AacUserSchedule> {
    return aacUserRepository.createScheduleEntry(schedule);
  }

  /**
   * Get all schedules for an AAC user
   */
  async getSchedulesByAacUserId(aacUserId: string): Promise<AacUserSchedule[]> {
    return aacUserRepository.getSchedulesByAacUserId(aacUserId);
  }

  /**
   * Get a specific schedule entry
   */
  async getScheduleEntry(id: string): Promise<AacUserSchedule | undefined> {
    return aacUserRepository.getScheduleEntry(id);
  }

  /**
   * Update a schedule entry
   */
  async updateScheduleEntry(
    id: string,
    updates: UpdateAacUserSchedule
  ): Promise<AacUserSchedule | undefined> {
    return aacUserRepository.updateScheduleEntry(id, updates);
  }

  /**
   * Delete a schedule entry
   */
  async deleteScheduleEntry(id: string): Promise<boolean> {
    return aacUserRepository.deleteScheduleEntry(id);
  }

  /**
   * Get the current schedule context for an AAC user
   */
  async getCurrentScheduleContext(
    aacUserId: string,
    timestamp: Date = new Date()
  ): Promise<{
    activityName: string | null;
    topicTags: string[] | null;
  }> {
    return aacUserRepository.getCurrentScheduleContext(aacUserId, timestamp);
  }

  // ==================== Utility Methods ====================

  /**
   * Calculate age from birth date
   */
  calculateAge(birthDate: string | null): number | null {
    if (!birthDate) return null;
    
    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    
    return age;
  }

  /**
   * Get AAC user with calculated age
   */
  async getAacUserWithAge(aacUserId: string): Promise<(AacUser & { age: number | null }) | undefined> {
    const aacUser = await this.getAacUserById(aacUserId);
    if (!aacUser) return undefined;
    
    return {
      ...aacUser,
      age: this.calculateAge(aacUser.birthDate),
    };
  }
}

export const aacUserService = new AacUserService();