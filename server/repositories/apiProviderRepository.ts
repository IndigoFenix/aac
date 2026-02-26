import {
  apiProviders,
  apiProviderPricing,
  type ApiProvider,
  type InsertApiProvider,
  type ApiProviderPricing,
  type InsertApiProviderPricing,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, and } from "drizzle-orm";

export class ApiProviderRepository {
  // API Provider operations
  async createApiProvider(provider: InsertApiProvider): Promise<ApiProvider> {
    const [created] = await db
      .insert(apiProviders)
      .values(provider)
      .returning();
    return created;
  }

  async getApiProviders(): Promise<ApiProvider[]> {
    return await db
      .select()
      .from(apiProviders)
      .where(eq(apiProviders.isActive, true))
      .orderBy(apiProviders.name);
  }

  async getApiProvider(id: string): Promise<ApiProvider | undefined> {
    const [provider] = await db
      .select()
      .from(apiProviders)
      .where(eq(apiProviders.id, id));
    return provider || undefined;
  }

  async updateApiProvider(
    id: string,
    updates: Partial<ApiProvider>
  ): Promise<ApiProvider | undefined> {
    const [updated] = await db
      .update(apiProviders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(apiProviders.id, id))
      .returning();
    return updated || undefined;
  }

  // API Provider Pricing operations
  async createApiProviderPricing(
    pricing: InsertApiProviderPricing
  ): Promise<ApiProviderPricing> {
    const [created] = await db
      .insert(apiProviderPricing)
      .values(pricing)
      .returning();
    return created;
  }

  async getApiProviderPricing(
    provider: string,
    model: string,
    endpoint?: string
  ): Promise<ApiProviderPricing | null> {
    let whereCondition = and(
      eq(apiProviderPricing.provider, provider),
      eq(apiProviderPricing.model, model),
      eq(apiProviderPricing.isActive, true)
    );

    if (endpoint) {
      whereCondition = and(
        eq(apiProviderPricing.provider, provider),
        eq(apiProviderPricing.model, model),
        eq(apiProviderPricing.endpoint, endpoint),
        eq(apiProviderPricing.isActive, true)
      );
    }

    const [pricing] = await db
      .select()
      .from(apiProviderPricing)
      .where(whereCondition)
      .orderBy(desc(apiProviderPricing.effectiveFrom))
      .limit(1);

    return pricing || null;
  }

  async getAllActiveApiProviderPricing(): Promise<ApiProviderPricing[]> {
    return await db
      .select()
      .from(apiProviderPricing)
      .where(eq(apiProviderPricing.isActive, true))
      .orderBy(apiProviderPricing.provider, apiProviderPricing.model);
  }

  async updateApiProviderPricing(
    id: string,
    pricing: Partial<InsertApiProviderPricing>
  ): Promise<ApiProviderPricing | undefined> {
    const [updated] = await db
      .update(apiProviderPricing)
      .set({
        ...pricing,
        updatedAt: new Date(),
      })
      .where(eq(apiProviderPricing.id, id))
      .returning();

    return updated || undefined;
  }

  async deactivateApiProviderPricing(
    provider: string,
    model: string,
    endpoint?: string
  ): Promise<void> {
    let whereCondition = and(
      eq(apiProviderPricing.provider, provider),
      eq(apiProviderPricing.model, model),
      eq(apiProviderPricing.isActive, true)
    );

    if (endpoint) {
      whereCondition = and(
        eq(apiProviderPricing.provider, provider),
        eq(apiProviderPricing.model, model),
        eq(apiProviderPricing.endpoint, endpoint),
        eq(apiProviderPricing.isActive, true)
      );
    }

    await db
      .update(apiProviderPricing)
      .set({
        isActive: false,
        effectiveUntil: new Date(),
        updatedAt: new Date(),
      })
      .where(whereCondition);
  }
}

export const apiProviderRepository = new ApiProviderRepository();
