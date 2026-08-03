import {
  users,
  inviteCodeRedemptions,
  inviteCodes,
  creditTransactions,
  passwordResetTokens,
  persons,
  personChatRooms,
  personChats,
  personChatRoomParticipants,
  personChatPushTokens,
  callSessions,
  callParticipants,
  type User,
  type InsertUser,
} from "@shared/schema";
import { db } from "../db";
import { personRepository } from "./personRepository";
import { releaseBiometricDataAndImage } from "../services/biometric/recognition-service";
import { eq, desc, count, sql } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  type EntityRef,
} from "../external-storage";

export class UserRepository {
  private ref(id: string): EntityRef {
    return { type: "user", id };
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) return undefined;
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) return undefined;
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }

  /** @deprecated Use identityProviderRepository.getExternalIdentityByExternalId instead */
  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId));
    if (!user) return undefined;
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }

  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.referralCode, referralCode));
      if (!user) return undefined;
      const [hydrated] = await hydrateRecords("users", [user]);
      return hydrated;
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
      authProvider: insertUser.authProvider || "email",
      referralCode,
    };

    const [user] = await db.insert(users).values(userData).returning();
    // Provision the person row up front (the chat/call membership identity).
    void personRepository.getOrCreateForUser(user.id).catch(() => {});
    const ref = this.ref(user.id);
    const ext = await extractSensitiveFields("users", user.id, user as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(users).set(nullSet).where(eq(users.id, user.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return ext.completeData as User;
  }

  /** @deprecated Use createUser with authProvider: "google" + identityService.linkIdentity instead */
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
    // Provision the person row up front (the chat/call membership identity).
    void personRepository.getOrCreateForUser(user.id).catch(() => {});
    const ref = this.ref(user.id);
    const ext = await extractSensitiveFields("users", user.id, user as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(users).set(nullSet).where(eq(users.id, user.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return ext.completeData as User;
  }

  async getAllUsers(): Promise<User[]> {
    const rows = await db.select().from(users).orderBy(desc(users.createdAt));
    return hydrateRecords("users", rows);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const ref = this.ref(id);
    const ext = await extractSensitiveFields("users", id, updates as Record<string, unknown>, ref);
    const [user] = await db
      .update(users)
      .set({ ...ext.dbData, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!user) return undefined;
    if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
    const [hydrated] = await hydrateRecords("users", [user]);
    return hydrated;
  }

  async updateUserOnboardingStep(userId: string, step: number): Promise<void> {
    await db
      .update(users)
      .set({ onboardingStep: step, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async deleteUser(id: string): Promise<boolean> {
    try {
      // Read the biometric link before the row goes: biometric_data is
      // referenced, not referencing, so once this user is deleted nothing can
      // find their face record again. Released after the delete below.
      const [existing] = await db
        .select({ biometricDataId: users.biometricDataId })
        .from(users)
        .where(eq(users.id, id));

      // Delete invite code redemptions (foreign key to users)
      await db
        .delete(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.redeemedByUserId, id));

      // Delete invite codes created by user (foreign key to users)
      await db.delete(inviteCodes).where(eq(inviteCodes.createdByUserId, id));

      // Delete user's credit transactions
      await db
        .delete(creditTransactions)
        .where(eq(creditTransactions.userId, id));

      // Delete user's password reset tokens
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, id));

      // Person facet (person-chat + calls). Users get a persons row
      // auto-provisioned on creation; without this cleanup the users delete
      // below fails on persons_user_id_users_id_fk. Rooms the user created
      // survive for their other members with the creator nulled
      // (createdByPersonId is write-only provenance — nothing reads it);
      // the user's own messages, call rows, and memberships are removed.
      const person = await personRepository.getByUserId(id);
      if (person) {
        await db.update(personChatRooms)
          .set({ createdByPersonId: null })
          .where(eq(personChatRooms.createdByPersonId, person.id));
        await db.delete(personChats).where(eq(personChats.senderPersonId, person.id));
        await db.delete(callParticipants).where(eq(callParticipants.personId, person.id));
        await db.delete(callSessions).where(eq(callSessions.initiatedByPersonId, person.id));
        await db.delete(personChatRoomParticipants).where(eq(personChatRoomParticipants.personId, person.id));
        await db.delete(persons).where(eq(persons.id, person.id));
      }
      // Push tokens are user-keyed (device delivery targets) — FK to users.
      await db.delete(personChatPushTokens).where(eq(personChatPushTokens.userId, id));

      // Finally delete the user
      await db.delete(users).where(eq(users.id, id));

      // Drop the face record + photo now that nothing holds it. A contact of
      // some student may still link to it (shared person) — release() checks.
      await releaseBiometricDataAndImage(existing?.biometricDataId);

      // Clean up any externally stored data
      await deleteExternalData("users", id, this.ref(id));

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
