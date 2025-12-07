import {
  apiProviders,
  apiCalls,
  apiProviderPricing,
  type ApiProvider,
  type InsertApiProvider,
  type ApiCall,
  type InsertApiCall,
  type ApiProviderPricing,
  type InsertApiProviderPricing,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, count, sql, and, gte, lte, sum } from "drizzle-orm";

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

  // API Call operations
  async createApiCall(apiCall: InsertApiCall): Promise<ApiCall> {
    const [created] = await db.insert(apiCalls).values(apiCall).returning();
    return created;
  }

  async getApiCalls(limit: number = 50, offset: number = 0): Promise<ApiCall[]> {
    return await db
      .select()
      .from(apiCalls)
      .orderBy(desc(apiCalls.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getApiCallsByProvider(
    providerId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ApiCall[]> {
    return await db
      .select()
      .from(apiCalls)
      .where(eq(apiCalls.providerId, providerId))
      .orderBy(desc(apiCalls.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getApiCallsCount(providerId?: string): Promise<number> {
    if (providerId) {
      const [result] = await db
        .select({ count: count() })
        .from(apiCalls)
        .where(eq(apiCalls.providerId, providerId));
      return result.count;
    }
    const [result] = await db.select({ count: count() }).from(apiCalls);
    return result.count;
  }

  async getUserApiCalls(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ calls: ApiCall[]; total: number }> {
    const calls = await db
      .select()
      .from(apiCalls)
      .where(eq(apiCalls.userId, userId))
      .orderBy(desc(apiCalls.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: count() })
      .from(apiCalls)
      .where(eq(apiCalls.userId, userId));

    return { calls, total: countResult.count };
  }

  async getApiCallsByDateRange(startDate: Date, endDate: Date): Promise<ApiCall[]> {
    return await db
      .select()
      .from(apiCalls)
      .where(
        and(
          gte(apiCalls.createdAt, startDate),
          lte(apiCalls.createdAt, endDate)
        )
      )
      .orderBy(desc(apiCalls.createdAt));
  }

  async getApiUsageStats(): Promise<{
    totalCostToday: number;
    totalCostWeek: number;
    totalCostMonth: number;
    totalCallsToday: number;
    totalCallsWeek: number;
    totalCallsMonth: number;
    averageCostPerCall: number;
    topProviderBySpend: { name: string; cost: number } | null;
  }> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Today stats
    const [todayStats] = await db
      .select({
        cost: sum(apiCalls.totalCostUsd),
        calls: count(),
      })
      .from(apiCalls)
      .where(gte(apiCalls.createdAt, today));

    // Week stats
    const [weekStats] = await db
      .select({
        cost: sum(apiCalls.totalCostUsd),
        calls: count(),
      })
      .from(apiCalls)
      .where(gte(apiCalls.createdAt, weekAgo));

    // Month stats
    const [monthStats] = await db
      .select({
        cost: sum(apiCalls.totalCostUsd),
        calls: count(),
      })
      .from(apiCalls)
      .where(gte(apiCalls.createdAt, monthAgo));

    // All time stats for average
    const [allTimeStats] = await db
      .select({
        cost: sum(apiCalls.totalCostUsd),
        calls: count(),
      })
      .from(apiCalls);

    // Top provider by spend
    const topProviders = await db
      .select({
        providerId: apiCalls.providerId,
        cost: sum(apiCalls.totalCostUsd),
      })
      .from(apiCalls)
      .groupBy(apiCalls.providerId)
      .orderBy(desc(sum(apiCalls.totalCostUsd)))
      .limit(1);

    let topProviderBySpend: { name: string; cost: number } | null = null;
    if (topProviders.length > 0 && topProviders[0].providerId) {
      const provider = await this.getApiProvider(topProviders[0].providerId);
      if (provider) {
        topProviderBySpend = {
          name: provider.name,
          cost: parseFloat(topProviders[0].cost as string) || 0,
        };
      }
    }

    const totalCost = parseFloat(allTimeStats.cost as string) || 0;
    const totalCalls = allTimeStats.calls || 0;

    return {
      totalCostToday: parseFloat(todayStats.cost as string) || 0,
      totalCostWeek: parseFloat(weekStats.cost as string) || 0,
      totalCostMonth: parseFloat(monthStats.cost as string) || 0,
      totalCallsToday: todayStats.calls || 0,
      totalCallsWeek: weekStats.calls || 0,
      totalCallsMonth: monthStats.calls || 0,
      averageCostPerCall: totalCalls > 0 ? totalCost / totalCalls : 0,
      topProviderBySpend,
    };
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
