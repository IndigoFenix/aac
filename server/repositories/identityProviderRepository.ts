import {
  identityProviders,
  userExternalIdentities,
  type IdentityProvider,
  type InsertIdentityProvider,
  type UpdateIdentityProvider,
  type UserExternalIdentity,
  type InsertUserExternalIdentity,
} from "@shared/schema";
import { db } from "../db";
import { eq, and } from "drizzle-orm";

class IdentityProviderRepository {
  // ==================== Identity Provider Operations ====================

  async getAll(): Promise<IdentityProvider[]> {
    return db.select().from(identityProviders);
  }

  async getActive(): Promise<IdentityProvider[]> {
    return db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.isActive, true));
  }

  async getById(id: string): Promise<IdentityProvider | undefined> {
    const [provider] = await db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.id, id));
    return provider;
  }

  async getByInstituteIdType(idType: string): Promise<IdentityProvider | undefined> {
    const [provider] = await db
      .select()
      .from(identityProviders)
      .where(
        and(
          eq(identityProviders.instituteIdType, idType),
          eq(identityProviders.isActive, true),
        ),
      );
    return provider;
  }

  async create(data: InsertIdentityProvider): Promise<IdentityProvider> {
    const [provider] = await db
      .insert(identityProviders)
      .values(data)
      .returning();
    return provider;
  }

  async update(id: string, data: UpdateIdentityProvider): Promise<IdentityProvider | undefined> {
    const [provider] = await db
      .update(identityProviders)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(identityProviders.id, id))
      .returning();
    return provider;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(identityProviders)
      .where(eq(identityProviders.id, id))
      .returning();
    return result.length > 0;
  }

  // ==================== User External Identity Operations ====================

  async getExternalIdentity(
    userId: string,
    providerId: string,
  ): Promise<UserExternalIdentity | undefined> {
    const [identity] = await db
      .select()
      .from(userExternalIdentities)
      .where(
        and(
          eq(userExternalIdentities.userId, userId),
          eq(userExternalIdentities.providerId, providerId),
        ),
      );
    return identity;
  }

  async getExternalIdentityByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<UserExternalIdentity | undefined> {
    const [identity] = await db
      .select()
      .from(userExternalIdentities)
      .where(
        and(
          eq(userExternalIdentities.providerId, providerId),
          eq(userExternalIdentities.externalId, externalId),
        ),
      );
    return identity;
  }

  async getExternalIdentitiesByUser(userId: string): Promise<UserExternalIdentity[]> {
    return db
      .select()
      .from(userExternalIdentities)
      .where(eq(userExternalIdentities.userId, userId));
  }

  async upsertExternalIdentity(data: InsertUserExternalIdentity): Promise<UserExternalIdentity> {
    // Try to find existing
    const existing = await this.getExternalIdentity(data.userId, data.providerId);
    if (existing) {
      const [updated] = await db
        .update(userExternalIdentities)
        .set({
          externalId: data.externalId,
          email: data.email,
          claims: data.claims,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userExternalIdentities.id, existing.id))
        .returning();
      return updated;
    }
    const [identity] = await db
      .insert(userExternalIdentities)
      .values(data)
      .returning();
    return identity;
  }

  async deleteExternalIdentity(userId: string, providerId: string): Promise<boolean> {
    const result = await db
      .delete(userExternalIdentities)
      .where(
        and(
          eq(userExternalIdentities.userId, userId),
          eq(userExternalIdentities.providerId, providerId),
        ),
      )
      .returning();
    return result.length > 0;
  }
}

export const identityProviderRepository = new IdentityProviderRepository();
