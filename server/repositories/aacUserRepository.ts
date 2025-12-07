import {
  aacUsers,
  aacUserSchedules,
  userAacUsers,
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
import { db } from "../db";
import { eq, and, lte, gte, desc, sql } from "drizzle-orm";

export class AacUserRepository {
  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user (without linking to any user)
   */
  async createAacUser(insertAacUser: InsertAacUser): Promise<AacUser> {
    const [aacUser] = await db
      .insert(aacUsers)
      .values(insertAacUser)
      .returning();
    return aacUser;
  }

  /**
   * Create an AAC user and link it to a user in a single transaction
   */
  async createAacUserWithLink(
    insertAacUser: InsertAacUser,
    userId: string,
    role: string = "owner"
  ): Promise<{ aacUser: AacUser; link: UserAacUser }> {
    return await db.transaction(async (tx) => {
      // Create the AAC user
      const [aacUser] = await tx
        .insert(aacUsers)
        .values(insertAacUser)
        .returning();

      // Create the link
      const [link] = await tx
        .insert(userAacUsers)
        .values({
          userId,
          aacUserId: aacUser.id,
          role,
          isActive: true,
        })
        .returning();

      return { aacUser, link };
    });
  }

  /**
   * Get an AAC user by their primary key ID
   */
  async getAacUserById(id: string): Promise<AacUser | undefined> {
    const [aacUser] = await db
      .select()
      .from(aacUsers)
      .where(eq(aacUsers.id, id));
    return aacUser || undefined;
  }

  /**
   * Get all AAC users linked to a specific user
   */
  async getAacUsersByUserId(userId: string): Promise<AacUser[]> {
    const results = await db
      .select({
        aacUser: aacUsers,
      })
      .from(userAacUsers)
      .innerJoin(aacUsers, eq(userAacUsers.aacUserId, aacUsers.id))
      .where(
        and(
          eq(userAacUsers.userId, userId),
          eq(userAacUsers.isActive, true),
          eq(aacUsers.isActive, true)
        )
      )
      .orderBy(desc(aacUsers.createdAt));

    return results.map((r) => r.aacUser);
  }

  /**
   * Get all AAC users linked to a specific user with link details
   */
  async getAacUsersWithLinksByUserId(
    userId: string
  ): Promise<{ aacUser: AacUser; link: UserAacUser }[]> {
    const results = await db
      .select({
        aacUser: aacUsers,
        link: userAacUsers,
      })
      .from(userAacUsers)
      .innerJoin(aacUsers, eq(userAacUsers.aacUserId, aacUsers.id))
      .where(
        and(
          eq(userAacUsers.userId, userId),
          eq(userAacUsers.isActive, true),
          eq(aacUsers.isActive, true)
        )
      )
      .orderBy(desc(aacUsers.createdAt));

    return results;
  }

  /**
   * Update an AAC user
   */
  async updateAacUser(id: string, updates: UpdateAacUser): Promise<AacUser | undefined> {
    const [updated] = await db
      .update(aacUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(aacUsers.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Soft delete an AAC user (sets isActive to false)
   */
  async deleteAacUser(id: string): Promise<boolean> {
    const [updated] = await db
      .update(aacUsers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(aacUsers.id, id))
      .returning();
    return !!updated;
  }

  // ==================== User-AAC User Link Operations ====================

  /**
   * Create a link between a user and an AAC user
   */
  async createUserAacUserLink(link: InsertUserAacUser): Promise<UserAacUser> {
    const [created] = await db
      .insert(userAacUsers)
      .values(link)
      .returning();
    return created;
  }

  /**
   * Get a specific link by user ID and AAC user ID
   */
  async getUserAacUserLink(
    userId: string,
    aacUserId: string
  ): Promise<UserAacUser | undefined> {
    const [link] = await db
      .select()
      .from(userAacUsers)
      .where(
        and(
          eq(userAacUsers.userId, userId),
          eq(userAacUsers.aacUserId, aacUserId)
        )
      );
    return link || undefined;
  }

  /**
   * Get all users linked to an AAC user
   */
  async getUsersByAacUserId(aacUserId: string): Promise<UserAacUser[]> {
    return await db
      .select()
      .from(userAacUsers)
      .where(
        and(
          eq(userAacUsers.aacUserId, aacUserId),
          eq(userAacUsers.isActive, true)
        )
      );
  }

  /**
   * Update a user-AAC user link
   */
  async updateUserAacUserLink(
    id: string,
    updates: UpdateUserAacUser
  ): Promise<UserAacUser | undefined> {
    const [updated] = await db
      .update(userAacUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userAacUsers.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Deactivate a link between a user and an AAC user
   */
  async deactivateUserAacUserLink(
    userId: string,
    aacUserId: string
  ): Promise<boolean> {
    const [updated] = await db
      .update(userAacUsers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(userAacUsers.userId, userId),
          eq(userAacUsers.aacUserId, aacUserId)
        )
      )
      .returning();
    return !!updated;
  }

  /**
   * Check if a user has access to an AAC user
   */
  async userHasAccessToAacUser(
    userId: string,
    aacUserId: string
  ): Promise<boolean> {
    const [link] = await db
      .select()
      .from(userAacUsers)
      .where(
        and(
          eq(userAacUsers.userId, userId),
          eq(userAacUsers.aacUserId, aacUserId),
          eq(userAacUsers.isActive, true)
        )
      );
    return !!link;
  }

  // ==================== AAC User Schedule Operations ====================

  /**
   * Create a schedule entry for an AAC user
   */
  async createScheduleEntry(schedule: InsertAacUserSchedule): Promise<AacUserSchedule> {
    const [entry] = await db
      .insert(aacUserSchedules)
      .values(schedule)
      .returning();
    return entry;
  }

  /**
   * Get all schedules for an AAC user
   */
  async getSchedulesByAacUserId(aacUserId: string): Promise<AacUserSchedule[]> {
    return await db
      .select()
      .from(aacUserSchedules)
      .where(eq(aacUserSchedules.aacUserId, aacUserId))
      .orderBy(aacUserSchedules.startTime);
  }

  /**
   * Get a specific schedule entry by ID
   */
  async getScheduleEntry(id: string): Promise<AacUserSchedule | undefined> {
    const [entry] = await db
      .select()
      .from(aacUserSchedules)
      .where(eq(aacUserSchedules.id, id));
    return entry || undefined;
  }

  /**
   * Update a schedule entry
   */
  async updateScheduleEntry(
    id: string,
    updates: UpdateAacUserSchedule
  ): Promise<AacUserSchedule | undefined> {
    const [updated] = await db
      .update(aacUserSchedules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(aacUserSchedules.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Delete a schedule entry
   */
  async deleteScheduleEntry(id: string): Promise<boolean> {
    const result = await db
      .delete(aacUserSchedules)
      .where(eq(aacUserSchedules.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get the current schedule context for an AAC user based on a timestamp
   */
  async getCurrentScheduleContext(
    aacUserId: string,
    timestamp: Date
  ): Promise<{
    activityName: string | null;
    topicTags: string[] | null;
  }> {
    const dayOfWeek = timestamp.getDay();
    const timeString = timestamp.toTimeString().substring(0, 5);

    const [schedule] = await db
      .select()
      .from(aacUserSchedules)
      .where(
        and(
          eq(aacUserSchedules.aacUserId, aacUserId),
          eq(aacUserSchedules.isActive, true),
          sql`${aacUserSchedules.dayOfWeek} = ${dayOfWeek}`,
          lte(aacUserSchedules.startTime, timeString),
          gte(aacUserSchedules.endTime, timeString)
        )
      )
      .limit(1);

    if (schedule) {
      return {
        activityName: schedule.activityName,
        topicTags: schedule.topicTags,
      };
    }

    return { activityName: null, topicTags: null };
  }

  // ==================== Legacy Compatibility Methods ====================
  // These methods are provided for backward compatibility during migration

  /**
   * @deprecated Use getAacUserById instead
   */
  async getAacUserByAacUserId(aacUserId: string): Promise<AacUser | undefined> {
    // During migration period, this might still be called with old aacUserId values
    // First try to find by id (new system)
    const byId = await this.getAacUserById(aacUserId);
    if (byId) return byId;
    
    // Fallback: the aacUserId might actually be an id
    return undefined;
  }
}

export const aacUserRepository = new AacUserRepository();