import {
  users,
  interpretations,
  adminUsers,
  creditTransactions,
  subscriptionPlans,
  creditPackages,
  passwordResetTokens,
  aacUsers,
  aacUserSchedules,
  systemSettings,
  inviteCodes,
  inviteCodeRedemptions,
  apiProviders,
  apiCalls,
  savedLocations,
  type User,
  type InsertUser,
  type Interpretation,
  type InsertInterpretation,
  type AdminUser,
  type UpsertAdminUser,
  type CreditTransaction,
  type InsertCreditTransaction,
  type SubscriptionPlan,
  type InsertSubscriptionPlan,
  type CreditPackage,
  type InsertCreditPackage,
  type PasswordResetToken,
  type InsertPasswordResetToken,
  type AacUser,
  type InsertAacUser,
  type UpdateAacUser,
  type AacUserSchedule,
  type InsertAacUserSchedule,
  type UpdateAacUserSchedule,
  type InviteCode,
  type InsertInviteCode,
  type InviteCodeRedemption,
  type ApiProvider,
  type InsertApiProvider,
  type ApiCall,
  type InsertApiCall,
  type SavedLocation,
  type InsertSavedLocation,
  boards,
  plans,
  usageWindows,
  promptHistory,
  promptEvents,
  analyticsAggregates,
  userSessions,
  userEvents,
  planChanges,
  userCohorts,
  systemPrompt,
  apiProviderPricing,
  type Board,
  type InsertBoard,
  type Plan,
  type InsertPlan,
  type UsageWindow,
  type InsertUsageWindow,
  type PromptHistory,
  type InsertPromptHistory,
  type PromptEvent,
  type InsertPromptEvent,
  type AnalyticsAggregate,
  type InsertAnalyticsAggregate,
  type UserSession,
  type UserEvent,
  type PlanChange,
  type UserCohort,
  type InsertUserSession,
  type InsertUserEvent,
  type InsertPlanChange,
  type SystemPrompt,
  type InsertSystemPrompt,
  type ApiProviderPricing,
  type InsertApiProviderPricing,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, count, sql, and, gte, lte, inArray, sum, asc } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createGoogleUser(googleData: {
    email: string;
    firstName?: string;
    lastName?: string;
    googleId: string;
    profileImageUrl?: string;
  }): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  updateUserOnboardingStep(userId: string, step: number): Promise<void>;
  deleteUser(id: string): Promise<boolean>;

  // Admin user operations (for Replit Auth)
  getAdminUser(id: string): Promise<AdminUser | undefined>;
  upsertAdminUser(user: UpsertAdminUser): Promise<AdminUser>;

  // Interpretation operations
  createInterpretation(
    interpretation: InsertInterpretation
  ): Promise<Interpretation>;
  getInterpretations(limit?: number): Promise<Interpretation[]>;
  getInterpretationsByUser(
    userId: string,
    limit?: number
  ): Promise<Interpretation[]>;
  getInterpretation(id: string): Promise<Interpretation | undefined>;
  getAllInterpretationsWithUsers(
    limit?: number
  ): Promise<
    (Interpretation & {
      user: { id: string; email: string; fullName: string | null } | null;
    })[]
  >;
  deleteInterpretation(id: string): Promise<boolean>;

  // Clinical data operations
  getClinicalData(filters: {
    userId?: string;
    aacUserId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Interpretation[]>;
  getClinicalMetrics(filters: {
    userId?: string;
    aacUserId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalInterpretations: number;
    averageWPM: number | null;
    averageConfidence: number | null;
    acceptanceRate: number | null;
    feedbackCounts: {
      confirmed: number;
      corrected: number;
      rejected: number;
      noFeedback: number;
    };
  }>;

  // Board operations
  createBoard(board: InsertBoard): Promise<Board>;
  getUserBoards(userId: string): Promise<Board[]>;
  getBoard(id: string): Promise<Board | undefined>;
  updateBoard(
    id: string,
    data: Partial<InsertBoard>
  ): Promise<Board | undefined>;
  deleteBoard(id: string): Promise<void>;

  // Plan operations
  getPlan(code: string): Promise<Plan | undefined>;
  createOrUpdatePlan(plan: InsertPlan): Promise<Plan>;

  // Usage operations
  getOrCreateUsageWindow(
    userId: string,
    windowStart: Date
  ): Promise<UsageWindow>;
  incrementUsage(
    windowId: string,
    type: "generations" | "downloads"
  ): Promise<void>;

  // Prompt history operations
  logPrompt(promptLog: InsertPromptHistory): Promise<PromptHistory>;
  getUserPromptHistory(
    userId: string,
    limit?: number
  ): Promise<PromptHistory[]>;
  markPromptAsDownloaded(promptId: string): Promise<void>;

  // Analytics operations
  createPromptEvent(event: InsertPromptEvent): Promise<PromptEvent>;
  getAnalyticsData(filters: {
    startDate?: string;
    endDate?: string;
    topics?: string[];
    users?: string[];
    models?: string[];
    languages?: string[];
  }): Promise<{
    kpis: {
      totalPrompts: number;
      uniqueUsers: number;
      boardsGenerated: number;
      pagesCreated: number;
      downloads: number;
      successRate: number;
      avgPagesPerBoard: number;
      avgProcessingTime: number;
    };
    timeSeriesData: Array<{
      date: string;
      prompts: number;
      boards: number;
      downloads: number;
    }>;
    topTopics: Array<{
      topic: string;
      prompts: number;
      boards: number;
      conversionRate: number;
      avgPages: number;
      lastUsed: string;
    }>;
    recentPrompts: Array<PromptHistory & { user: User }>;
    funnelData: {
      promptsCreated: number;
      boardsGenerated: number;
      downloaded: number;
    };
  }>;

  // Credit operations
  createCreditTransaction(
    transaction: InsertCreditTransaction
  ): Promise<CreditTransaction>;
  getUserCreditTransactions(userId: string): Promise<CreditTransaction[]>;
  updateUserCredits(
    userId: string,
    amount: number,
    type: string,
    description: string,
    stripePaymentIntentId?: string
  ): Promise<void>;
  rewardReferralBonus(
    newUserId: string,
    referrerId: string,
    bonusAmount: number
  ): Promise<void>;

  // Subscription operations
  createSubscriptionPlan(
    plan: InsertSubscriptionPlan
  ): Promise<SubscriptionPlan>;
  getAllSubscriptionPlans(): Promise<SubscriptionPlan[]>;
  updateSubscriptionPlan(
    id: string,
    updates: Partial<SubscriptionPlan>
  ): Promise<SubscriptionPlan | undefined>;

  // Credit package operations
  createCreditPackage(
    creditPackage: InsertCreditPackage
  ): Promise<CreditPackage>;
  getAllCreditPackages(): Promise<CreditPackage[]>;
  getCreditPackage(id: string): Promise<CreditPackage | undefined>;
  updateCreditPackage(
    id: string,
    updates: Partial<CreditPackage>
  ): Promise<CreditPackage | undefined>;
  deleteCreditPackage(id: string): Promise<boolean>;

  // Analytics
  getUsersStats(): Promise<{ total: number; active: number; premium: number }>;
  getInterpretationsStats(): Promise<{
    total: number;
    today: number;
    thisWeek: number;
  }>;

  // Password reset operations
  createPasswordResetToken(
    token: InsertPasswordResetToken
  ): Promise<PasswordResetToken>;
  getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined>;
  markTokenAsUsed(tokenId: string): Promise<void>;
  cleanupExpiredTokens(): Promise<void>;

  // AAC User operations
  createAacUser(aacUser: InsertAacUser): Promise<AacUser>;
  getAacUsersByUserId(userId: string): Promise<AacUser[]>;
  getAacUserByAacUserId(aacUserId: string): Promise<AacUser | undefined>;
  updateAacUser(
    id: string,
    updates: UpdateAacUser
  ): Promise<AacUser | undefined>;
  deleteAacUser(id: string): Promise<boolean>;

  // AAC User Schedule operations
  createScheduleEntry(
    schedule: InsertAacUserSchedule
  ): Promise<AacUserSchedule>;
  getSchedulesByAacUserId(aacUserId: string): Promise<AacUserSchedule[]>;
  getScheduleEntry(id: string): Promise<AacUserSchedule | undefined>;
  updateScheduleEntry(
    id: string,
    updates: UpdateAacUserSchedule
  ): Promise<AacUserSchedule | undefined>;
  deleteScheduleEntry(id: string): Promise<boolean>;
  getCurrentScheduleContext(
    aacUserId: string,
    timestamp: Date
  ): Promise<{
    activityName: string | null;
    topicTags: string[] | null;
  }>;

  // System prompt operations
  getSystemPrompt(): Promise<string>;
  updateSystemPrompt(prompt: string): Promise<void>;

  // Invite code operations
  createInviteCode(inviteCode: InsertInviteCode): Promise<InviteCode>;
  getInviteCode(code: string): Promise<InviteCode | undefined>;
  getInviteCodesByUserId(userId: string): Promise<InviteCode[]>;
  redeemInviteCode(
    code: string,
    userId: string
  ): Promise<{ success: boolean; aacUser?: AacUser; error?: string }>;
  getInviteCodeRedemptions(userId: string): Promise<InviteCodeRedemption[]>;
  deactivateInviteCode(id: string): Promise<boolean>;

  // API tracking operations
  createApiProvider(provider: InsertApiProvider): Promise<ApiProvider>;
  getApiProviders(): Promise<ApiProvider[]>;
  getApiProvider(id: string): Promise<ApiProvider | undefined>;
  updateApiProvider(
    id: string,
    updates: Partial<ApiProvider>
  ): Promise<ApiProvider | undefined>;
  createApiCall(apiCall: InsertApiCall): Promise<ApiCall>;
  getApiCalls(limit?: number, offset?: number): Promise<ApiCall[]>;
  getApiCallsByProvider(
    providerId: string,
    limit?: number,
    offset?: number
  ): Promise<ApiCall[]>;
  getApiCallsCount(providerId?: string): Promise<number>;
  getApiUsageStats(): Promise<{
    totalCostToday: number;
    totalCostWeek: number;
    totalCostMonth: number;
    totalCallsToday: number;
    totalCallsWeek: number;
    totalCallsMonth: number;
    averageCostPerCall: number;
    topProviderBySpend: { name: string; cost: number } | null;
  }>;

  getUserApiCalls(
    userId: string,
    limit?: number,
    offset?: number
  ): Promise<{ calls: ApiCall[]; total: number }>;
  getApiCallsByDateRange(startDate: Date, endDate: Date): Promise<ApiCall[]>;
  getApiCallsByProvider(provider: string, limit?: number): Promise<ApiCall[]>;

  // API provider pricing operations
  createApiProviderPricing(
    pricing: InsertApiProviderPricing
  ): Promise<ApiProviderPricing>;
  getApiProviderPricing(
    provider: string,
    model: string,
    endpoint?: string
  ): Promise<ApiProviderPricing | null>;
  getAllActiveApiProviderPricing(): Promise<ApiProviderPricing[]>;
  updateApiProviderPricing(
    id: string,
    pricing: Partial<InsertApiProviderPricing>
  ): Promise<ApiProviderPricing | undefined>;
  deactivateApiProviderPricing(
    provider: string,
    model: string,
    endpoint?: string
  ): Promise<void>;

  // Saved locations operations
  createSavedLocation(location: InsertSavedLocation): Promise<SavedLocation>;
  getUserSavedLocations(userId: string): Promise<SavedLocation[]>;
  deleteSavedLocation(id: string, userId: string): Promise<boolean>;

  // Historical AAC analysis operations
  getAacUserHistory(
    aacUserId: string,
    limit?: number
  ): Promise<Interpretation[]>;
  analyzeHistoricalPatterns(
    aacUserId: string,
    currentInput: string
  ): Promise<{
    suggestions: Array<{
      interpretation: string;
      confidence: number;
      frequency: number;
      pattern: string;
    }>;
    totalPatterns: number;
  }>;

  // Settings operations
  getSetting(key: string, defaultValue?: string): Promise<string | null>;
  updateSetting(key: string, value: string): Promise<void>;

  // Referral operations
  getUserByReferralCode(referralCode: string): Promise<User | undefined>;
  generateReferralCode(): string;
}

export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    // Hash password before storing
    const bcrypt = await import("bcryptjs");
    const hashedPassword = insertUser.password
      ? await bcrypt.hash(insertUser.password, 12)
      : null;

    // Generate unique referral code
    const referralCode = this.generateReferralCode();

    const userData = {
      ...insertUser,
      password: hashedPassword,
      fullName:
        insertUser.firstName && insertUser.lastName
          ? `${insertUser.firstName} ${insertUser.lastName}`
          : null,
      authProvider: "email",
      referralCode,
    };

    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async createGoogleUser(googleData: {
    email: string;
    firstName?: string;
    lastName?: string;
    googleId: string;
    profileImageUrl?: string;
    userType?: string;
  }): Promise<User> {
    // Generate unique referral code
    const referralCode = this.generateReferralCode();

    const userData = {
      ...googleData,
      fullName:
        googleData.firstName && googleData.lastName
          ? `${googleData.firstName} ${googleData.lastName}`
          : null,
      authProvider: "google",
      userType: googleData.userType || "Caregiver", // Default to Caregiver for Google users
      referralCode,
    };

    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async updateUser(
    id: string,
    updates: Partial<User>
  ): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async updateUserOnboardingStep(userId: string, step: number): Promise<void> {
    await db
      .update(users)
      .set({ onboardingStep: step, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async deleteUser(id: string): Promise<boolean> {
    try {
      // First, get all AAC users for this user to delete their schedules
      const userAacUsers = await db
        .select()
        .from(aacUsers)
        .where(eq(aacUsers.userId, id));

      // Delete AAC user schedules (foreign key to aac_users)
      for (const aacUser of userAacUsers) {
        await db
          .delete(aacUserSchedules)
          .where(eq(aacUserSchedules.aacUserId, aacUser.aacUserId));
      }

      // Delete invite code redemptions (foreign key to users)
      await db
        .delete(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.redeemedByUserId, id));

      // Delete invite codes created by user (foreign key to users)
      await db.delete(inviteCodes).where(eq(inviteCodes.createdByUserId, id));

      // Delete user's interpretations
      await db.delete(interpretations).where(eq(interpretations.userId, id));

      // Delete user's AAC users
      await db.delete(aacUsers).where(eq(aacUsers.userId, id));

      // Delete user's saved locations
      await db.delete(savedLocations).where(eq(savedLocations.userId, id));

      // Delete user's credit transactions
      await db
        .delete(creditTransactions)
        .where(eq(creditTransactions.userId, id));

      // Delete user's password reset tokens
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, id));

      // Delete user's API calls (nullable userId, so this is safe)
      await db.delete(apiCalls).where(eq(apiCalls.userId, id));

      // Finally delete the user
      await db.delete(users).where(eq(users.id, id));

      return true;
    } catch (error) {
      console.error("Error deleting user:", error);
      return false;
    }
  }

  // Admin user operations (for Replit Auth)
  async getAdminUser(id: string): Promise<AdminUser | undefined> {
    const [user] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    return user || undefined;
  }

  async upsertAdminUser(userData: UpsertAdminUser): Promise<AdminUser> {
    const [user] = await db
      .insert(adminUsers)
      .values(userData)
      .onConflictDoUpdate({
        target: adminUsers.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  // Interpretation operations
  async createInterpretation(
    insertInterpretation: InsertInterpretation
  ): Promise<Interpretation> {
    const [interpretation] = await db
      .insert(interpretations)
      .values(insertInterpretation)
      .returning();
    return interpretation;
  }

  async getInterpretations(limit?: number): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .orderBy(desc(interpretations.createdAt));
    return limit ? await query.limit(limit) : await query;
  }

  async getInterpretationsByUser(
    userId: string,
    limit?: number
  ): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .where(eq(interpretations.userId, userId))
      .orderBy(desc(interpretations.createdAt));
    return limit ? await query.limit(limit) : await query;
  }

  async getInterpretation(id: string): Promise<Interpretation | undefined> {
    const [interpretation] = await db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, id));
    return interpretation || undefined;
  }

  async getAllInterpretationsWithUsers(
    limit?: number
  ): Promise<
    (Interpretation & {
      user: { id: string; email: string; fullName: string | null } | null;
    })[]
  > {
    const query = db
      .select({
        id: interpretations.id,
        userId: interpretations.userId,
        originalInput: interpretations.originalInput,
        interpretedMeaning: interpretations.interpretedMeaning,
        analysis: interpretations.analysis,
        confidence: interpretations.confidence,
        suggestedResponse: interpretations.suggestedResponse,
        inputType: interpretations.inputType,
        language: interpretations.language,
        context: interpretations.context,
        aacUserId: interpretations.aacUserId,
        aacUserAlias: interpretations.aacUserAlias,
        imageData: interpretations.imageData,
        caregiverFeedback: interpretations.caregiverFeedback,
        aacUserWPM: interpretations.aacUserWPM,
        scheduleActivity: interpretations.scheduleActivity,
        createdAt: interpretations.createdAt,
        user: {
          id: users.id,
          email: users.email,
          fullName: users.fullName,
        },
      })
      .from(interpretations)
      .leftJoin(users, eq(interpretations.userId, users.id))
      .orderBy(desc(interpretations.createdAt));

    return limit ? await query.limit(limit) : await query;
  }

  async deleteInterpretation(id: string): Promise<boolean> {
    const result = await db
      .delete(interpretations)
      .where(eq(interpretations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Clinical data operations
  async getClinicalData(filters: {
    userId?: string;
    aacUserId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Interpretation[]> {
    const conditions = [];

    if (filters.userId) {
      conditions.push(eq(interpretations.userId, filters.userId));
    }

    if (filters.aacUserId) {
      conditions.push(eq(interpretations.aacUserId, filters.aacUserId));
    }

    if (filters.startDate) {
      conditions.push(
        sql`${interpretations.createdAt} >= ${filters.startDate}`
      );
    }

    if (filters.endDate) {
      conditions.push(sql`${interpretations.createdAt} <= ${filters.endDate}`);
    }

    const query = db.select().from(interpretations);

    if (conditions.length > 0) {
      return await query
        .where(and(...conditions))
        .orderBy(desc(interpretations.createdAt));
    }

    return await query.orderBy(desc(interpretations.createdAt));
  }

  async getClinicalMetrics(filters: {
    userId?: string;
    aacUserId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalInterpretations: number;
    averageWPM: number | null;
    averageConfidence: number | null;
    acceptanceRate: number | null;
    feedbackCounts: {
      confirmed: number;
      corrected: number;
      rejected: number;
      noFeedback: number;
    };
  }> {
    const data = await this.getClinicalData(filters);

    const totalInterpretations = data.length;

    // Calculate average WPM (excluding null values)
    const wpmValues = data
      .filter((d) => d.aacUserWPM !== null)
      .map((d) => d.aacUserWPM as number);
    const averageWPM =
      wpmValues.length > 0
        ? wpmValues.reduce((a, b) => a + b, 0) / wpmValues.length
        : null;

    // Calculate average confidence
    const averageConfidence =
      data.length > 0
        ? data.reduce((sum, d) => sum + d.confidence, 0) / data.length
        : null;

    // Count feedback types
    const feedbackCounts = {
      confirmed: data.filter((d) => d.caregiverFeedback === "confirmed").length,
      corrected: data.filter((d) => d.caregiverFeedback === "corrected").length,
      rejected: data.filter((d) => d.caregiverFeedback === "rejected").length,
      noFeedback: data.filter((d) => !d.caregiverFeedback).length,
    };

    // Calculate acceptance rate (confirmed / total with feedback)
    const totalWithFeedback =
      feedbackCounts.confirmed +
      feedbackCounts.corrected +
      feedbackCounts.rejected;
    const acceptanceRate =
      totalWithFeedback > 0
        ? (feedbackCounts.confirmed / totalWithFeedback) * 100
        : null;

    return {
      totalInterpretations,
      averageWPM,
      averageConfidence,
      acceptanceRate,
      feedbackCounts,
    };
  }

  // Board operations
  async createBoard(board: InsertBoard): Promise<Board> {
    const [newBoard] = await db.insert(boards).values(board).returning();
    return newBoard;
  }

  async getUserBoards(userId: string): Promise<Board[]> {
    return await db.select().from(boards).where(eq(boards.userId, userId));
  }

  async getBoard(id: string): Promise<Board | undefined> {
    const [board] = await db.select().from(boards).where(eq(boards.id, id));
    return board || undefined;
  }

  async updateBoard(
    id: string,
    data: Partial<InsertBoard>
  ): Promise<Board | undefined> {
    const [board] = await db
      .update(boards)
      .set(data)
      .where(eq(boards.id, id))
      .returning();
    return board || undefined;
  }

  async deleteBoard(id: string): Promise<void> {
    await db.delete(boards).where(eq(boards.id, id));
  }

  async getPlan(code: string): Promise<Plan | undefined> {
    const [plan] = await db.select().from(plans).where(eq(plans.code, code));
    return plan || undefined;
  }

  async createOrUpdatePlan(planData: InsertPlan): Promise<Plan> {
    const existing = await this.getPlan(planData.code);
    if (existing) {
      const [plan] = await db
        .update(plans)
        .set(planData)
        .where(eq(plans.code, planData.code))
        .returning();
      return plan;
    } else {
      const [plan] = await db.insert(plans).values(planData).returning();
      return plan;
    }
  }

  async getOrCreateUsageWindow(
    userId: string,
    windowStart: Date
  ): Promise<UsageWindow> {
    const [existing] = await db
      .select()
      .from(usageWindows)
      .where(
        and(
          eq(usageWindows.userId, userId),
          gte(usageWindows.windowStart, windowStart)
        )
      );

    if (existing) {
      return existing;
    }

    const [newWindow] = await db
      .insert(usageWindows)
      .values({
        userId,
        windowStart,
        generations: 0,
        downloads: 0,
        storedBoards: 0,
      })
      .returning();

    return newWindow;
  }

  async incrementUsage(
    windowId: string,
    type: "generations" | "downloads"
  ): Promise<void> {
    if (type === "generations") {
      await db
        .update(usageWindows)
        .set({ generations: sql`generations + 1` })
        .where(eq(usageWindows.id, windowId));
    } else {
      await db
        .update(usageWindows)
        .set({ downloads: sql`downloads + 1` })
        .where(eq(usageWindows.id, windowId));
    }
  }

  async logPrompt(promptLog: InsertPromptHistory): Promise<PromptHistory> {
    const [log] = await db.insert(promptHistory).values(promptLog).returning();
    return log;
  }

  async getUserPromptHistory(
    userId: string,
    limit: number = 50
  ): Promise<PromptHistory[]> {
    return await db
      .select()
      .from(promptHistory)
      .where(eq(promptHistory.userId, userId))
      .orderBy(desc(promptHistory.createdAt))
      .limit(limit);
  }

  async createPromptEvent(event: InsertPromptEvent): Promise<PromptEvent> {
    const [newEvent] = await db.insert(promptEvents).values(event).returning();
    return newEvent;
  }

  async markPromptAsDownloaded(promptId: string): Promise<void> {
    await db
      .update(promptHistory)
      .set({
        downloaded: true,
        downloadedAt: new Date(),
      })
      .where(eq(promptHistory.id, promptId));
  }

  async getAnalyticsData(filters: {
    startDate?: string;
    endDate?: string;
    topics?: string[];
    users?: string[];
    models?: string[];
    languages?: string[];
  }): Promise<{
    kpis: {
      totalPrompts: number;
      uniqueUsers: number;
      boardsGenerated: number;
      pagesCreated: number;
      downloads: number;
      successRate: number;
      avgPagesPerBoard: number;
      avgProcessingTime: number;
    };
    timeSeriesData: Array<{
      date: string;
      prompts: number;
      boards: number;
      downloads: number;
    }>;
    topTopics: Array<{
      topic: string;
      prompts: number;
      boards: number;
      conversionRate: number;
      avgPages: number;
      lastUsed: string;
    }>;
    recentPrompts: Array<PromptHistory & { user: User }>;
    funnelData: {
      promptsCreated: number;
      boardsGenerated: number;
      downloaded: number;
    };
  }> {
    // Build date filter condition
    const dateConditions: any[] = [];
    if (filters.startDate) {
      dateConditions.push(
        gte(promptHistory.createdAt, new Date(filters.startDate))
      );
    }
    if (filters.endDate) {
      dateConditions.push(
        lte(promptHistory.createdAt, new Date(filters.endDate))
      );
    }

    // Build other filter conditions
    const filterConditions: any[] = [...dateConditions];
    if (filters.topics?.length) {
      filterConditions.push(inArray(promptHistory.topic, filters.topics));
    }
    if (filters.users?.length) {
      filterConditions.push(inArray(promptHistory.userId, filters.users));
    }
    if (filters.models?.length) {
      filterConditions.push(inArray(promptHistory.model, filters.models));
    }
    if (filters.languages?.length) {
      filterConditions.push(inArray(promptHistory.language, filters.languages));
    }

    const whereClause =
      filterConditions.length > 0 ? and(...filterConditions) : undefined;

    // KPIs
    const [totalPrompts] = await db
      .select({ count: count() })
      .from(promptHistory)
      .where(whereClause);

    const [uniqueUsers] = await db
      .select({ count: sql`COUNT(DISTINCT user_id)`.as("count") })
      .from(promptHistory)
      .where(whereClause);

    const [boardsGenerated] = await db
      .select({ count: count() })
      .from(promptHistory)
      .where(
        whereClause
          ? and(whereClause, eq(promptHistory.success, true))
          : eq(promptHistory.success, true)
      );

    const [pagesCreated] = await db
      .select({ sum: sum(promptHistory.pagesGenerated) })
      .from(promptHistory)
      .where(
        whereClause
          ? and(whereClause, eq(promptHistory.success, true))
          : eq(promptHistory.success, true)
      );

    const [downloads] = await db
      .select({ count: count() })
      .from(promptHistory)
      .where(
        whereClause
          ? and(whereClause, eq(promptHistory.downloaded, true))
          : eq(promptHistory.downloaded, true)
      );

    const [avgProcessingTime] = await db
      .select({ avg: sql`AVG(processing_time_ms)`.as("avg") })
      .from(promptHistory)
      .where(
        whereClause
          ? and(whereClause, eq(promptHistory.success, true))
          : eq(promptHistory.success, true)
      );

    const [avgPagesPerBoard] = await db
      .select({ avg: sql`AVG(pages_generated)`.as("avg") })
      .from(promptHistory)
      .where(
        whereClause
          ? and(whereClause, eq(promptHistory.success, true))
          : eq(promptHistory.success, true)
      );

    const successRate =
      totalPrompts.count > 0
        ? (boardsGenerated.count / totalPrompts.count) * 100
        : 0;

    // Time series data - group by date
    const timeSeriesData = await db
      .select({
        date: sql`DATE(created_at)`.as("date"),
        prompts: count(),
        boards: sql`SUM(CASE WHEN success = true THEN 1 ELSE 0 END)`.as(
          "boards"
        ),
        downloads: sql`SUM(CASE WHEN downloaded = true THEN 1 ELSE 0 END)`.as(
          "downloads"
        ),
      })
      .from(promptHistory)
      .where(whereClause)
      .groupBy(sql`DATE(created_at)`)
      .orderBy(sql`DATE(created_at)`);

    // Top topics
    const topTopics = await db
      .select({
        topic: promptHistory.topic,
        prompts: count(),
        boards: sql`SUM(CASE WHEN success = true THEN 1 ELSE 0 END)`.as(
          "boards"
        ),
        avgPages: sql`AVG(pages_generated)`.as("avgPages"),
        lastUsed: sql`MAX(created_at)`.as("lastUsed"),
      })
      .from(promptHistory)
      .where(whereClause)
      .groupBy(promptHistory.topic)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10);

    // Recent prompts
    const recentPrompts = await db
      .select({
        id: promptHistory.id,
        userId: promptHistory.userId,
        prompt: promptHistory.prompt,
        promptExcerpt: promptHistory.promptExcerpt,
        topic: promptHistory.topic,
        language: promptHistory.language,
        model: promptHistory.model,
        outputFormat: promptHistory.outputFormat,
        generatedBoardName: promptHistory.generatedBoardName,
        generatedBoardId: promptHistory.generatedBoardId,
        pagesGenerated: promptHistory.pagesGenerated,
        promptLength: promptHistory.promptLength,
        success: promptHistory.success,
        errorMessage: promptHistory.errorMessage,
        errorType: promptHistory.errorType,
        processingTimeMs: promptHistory.processingTimeMs,
        downloaded: promptHistory.downloaded,
        downloadedAt: promptHistory.downloadedAt,
        userFeedback: promptHistory.userFeedback,
        createdAt: promptHistory.createdAt,
        user: users,
      })
      .from(promptHistory)
      .leftJoin(users, eq(promptHistory.userId, users.id))
      .where(whereClause)
      .orderBy(desc(promptHistory.createdAt))
      .limit(100);

    return {
      kpis: {
        totalPrompts: totalPrompts.count,
        uniqueUsers: parseInt(uniqueUsers.count as string) || 0,
        boardsGenerated: boardsGenerated.count,
        pagesCreated: parseInt(pagesCreated.sum as string) || 0,
        downloads: downloads.count,
        successRate: Math.round(successRate * 100) / 100,
        avgPagesPerBoard:
          Math.round((parseFloat(avgPagesPerBoard.avg as string) || 0) * 100) /
          100,
        avgProcessingTime: Math.round(
          parseFloat(avgProcessingTime.avg as string) || 0
        ),
      },
      timeSeriesData: timeSeriesData.map((row) => ({
        date: row.date as string,
        prompts: row.prompts,
        boards: parseInt(row.boards as string) || 0,
        downloads: parseInt(row.downloads as string) || 0,
      })),
      topTopics: topTopics.map((row) => ({
        topic: row.topic || "general",
        prompts: row.prompts,
        boards: parseInt(row.boards as string) || 0,
        conversionRate:
          row.prompts > 0
            ? Math.round(
                ((parseInt(row.boards as string) || 0) / row.prompts) * 10000
              ) / 100
            : 0,
        avgPages:
          Math.round((parseFloat(row.avgPages as string) || 0) * 100) / 100,
        lastUsed: row.lastUsed as string,
      })),
      recentPrompts: recentPrompts.map((row) => ({ ...row, user: row.user! })),
      funnelData: {
        promptsCreated: totalPrompts.count,
        boardsGenerated: boardsGenerated.count,
        downloaded: downloads.count,
      },
    };
  }

  // Credit operations
  async createCreditTransaction(
    transaction: InsertCreditTransaction
  ): Promise<CreditTransaction> {
    const [creditTransaction] = await db
      .insert(creditTransactions)
      .values(transaction)
      .returning();
    return creditTransaction;
  }

  async getUserCreditTransactions(
    userId: string
  ): Promise<CreditTransaction[]> {
    return await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt));
  }

  async updateUserCredits(
    userId: string,
    amount: number,
    type: string,
    description: string,
    stripePaymentIntentId?: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Update user credits
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // Create transaction record
      await tx.insert(creditTransactions).values({
        userId,
        amount,
        type,
        description,
        stripePaymentIntentId,
      });
    });
  }

  async setUserCredits(
    userId: string,
    newAmount: number,
    description: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Get current credits to calculate the difference for transaction log
      const [currentUser] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.id, userId));

      if (!currentUser) {
        throw new Error("User not found");
      }

      const difference = newAmount - currentUser.credits;

      // Set user credits to the new amount
      await tx
        .update(users)
        .set({
          credits: newAmount,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // Create transaction record showing the difference
      await tx.insert(creditTransactions).values({
        userId,
        amount: difference,
        type: "set",
        description: `${description} (Set to ${newAmount} credits)`,
      });
    });
  }

  async rewardReferralBonus(
    newUserId: string,
    referrerId: string,
    bonusAmount: number
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Update new user's credits
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${bonusAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, newUserId));

      // Create transaction record for new user
      await tx.insert(creditTransactions).values({
        userId: newUserId,
        amount: bonusAmount,
        type: "referral_bonus",
        description: `Referral signup bonus`,
      });

      // Update referrer's credits
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${bonusAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, referrerId));

      // Create transaction record for referrer
      await tx.insert(creditTransactions).values({
        userId: referrerId,
        amount: bonusAmount,
        type: "referral_reward",
        description: `Referral reward for inviting new user`,
      });
    });
  }

  // Subscription operations
  async createSubscriptionPlan(
    plan: InsertSubscriptionPlan
  ): Promise<SubscriptionPlan> {
    const [subscriptionPlan] = await db
      .insert(subscriptionPlans)
      .values(plan)
      .returning();
    return subscriptionPlan;
  }

  async getAllSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return await db
      .select()
      .from(subscriptionPlans)
      .orderBy(subscriptionPlans.price);
  }

  async updateSubscriptionPlan(
    id: string,
    updates: Partial<SubscriptionPlan>
  ): Promise<SubscriptionPlan | undefined> {
    const [plan] = await db
      .update(subscriptionPlans)
      .set(updates)
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return plan || undefined;
  }

  // Credit package operations
  async createCreditPackage(
    creditPackage: InsertCreditPackage
  ): Promise<CreditPackage> {
    const [newCreditPackage] = await db
      .insert(creditPackages)
      .values(creditPackage)
      .returning();
    return newCreditPackage;
  }

  async getAllCreditPackages(): Promise<CreditPackage[]> {
    return await db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.isActive, true))
      .orderBy(creditPackages.sortOrder, creditPackages.price);
  }

  async getCreditPackage(id: string): Promise<CreditPackage | undefined> {
    const [creditPackage] = await db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.id, id));
    return creditPackage || undefined;
  }

  async updateCreditPackage(
    id: string,
    updates: Partial<CreditPackage>
  ): Promise<CreditPackage | undefined> {
    const [creditPackage] = await db
      .update(creditPackages)
      .set(updates)
      .where(eq(creditPackages.id, id))
      .returning();
    return creditPackage || undefined;
  }

  async deleteCreditPackage(id: string): Promise<boolean> {
    const result = await db
      .delete(creditPackages)
      .where(eq(creditPackages.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Analytics
  async getUsersStats(): Promise<{
    total: number;
    active: number;
    premium: number;
  }> {
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

  async getInterpretationsStats(): Promise<{
    total: number;
    today: number;
    thisWeek: number;
  }> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [totalResult] = await db
      .select({ count: count() })
      .from(interpretations);
    const [todayResult] = await db
      .select({ count: count() })
      .from(interpretations)
      .where(sql`${interpretations.createdAt} >= ${today}`);
    const [weekResult] = await db
      .select({ count: count() })
      .from(interpretations)
      .where(sql`${interpretations.createdAt} >= ${weekAgo}`);

    return {
      total: totalResult.count,
      today: todayResult.count,
      thisWeek: weekResult.count,
    };
  }

  // Password reset operations
  async createPasswordResetToken(
    token: InsertPasswordResetToken
  ): Promise<PasswordResetToken> {
    const [resetToken] = await db
      .insert(passwordResetTokens)
      .values(token)
      .returning();
    return resetToken;
  }

  async getPasswordResetToken(
    token: string
  ): Promise<PasswordResetToken | undefined> {
    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, token));
    return resetToken || undefined;
  }

  async markTokenAsUsed(tokenId: string): Promise<void> {
    await db
      .update(passwordResetTokens)
      .set({ isUsed: true })
      .where(eq(passwordResetTokens.id, tokenId));
  }

  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();
    await db
      .delete(passwordResetTokens)
      .where(sql`${passwordResetTokens.expiresAt} < ${now}`);
  }

  // AAC User operations
  async createAacUser(insertAacUser: InsertAacUser): Promise<AacUser> {
    // Auto-generate aacUserId if not provided, with retry loop for collisions
    const maxRetries = 3;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Generate aacUserId if not provided or on retry
        let aacUserId = attempt === 0 ? insertAacUser.aacUserId : undefined;

        if (!aacUserId) {
          const timestamp = Date.now();
          const randomBytes =
            Math.random().toString(36).substring(2, 10) +
            Math.random().toString(36).substring(2, 10);
          aacUserId = `aac_${insertAacUser.userId}_${timestamp}_${randomBytes}`;
          if (attempt === 0) {
            console.log(`Auto-generated aacUserId: ${aacUserId}`);
          } else {
            console.log(
              `Retry ${attempt}: Generated new aacUserId after collision`
            );
          }
        }

        const dataToInsert = {
          ...insertAacUser,
          aacUserId,
        };

        const [aacUser] = await db
          .insert(aacUsers)
          .values(dataToInsert)
          .returning();
        return aacUser;
      } catch (error: any) {
        lastError = error;

        // Only retry on unique constraint violation for aacUserId
        if (
          error.code === "23505" &&
          error.constraint === "aac_users_aac_user_id_unique"
        ) {
          if (attempt < maxRetries - 1) {
            console.error(
              `aacUserId collision detected on attempt ${
                attempt + 1
              }, retrying...`
            );
            // Small delay before retry
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
        }

        // Log error without sensitive data
        console.error("Failed to create AAC user:", {
          error: error.message,
          code: error.code,
          constraint: error.constraint,
          userId: insertAacUser.userId,
          attempt: attempt + 1,
        });
        throw error;
      }
    }

    // If all retries failed
    console.error(`Failed to create AAC user after ${maxRetries} attempts`);
    throw lastError || new Error("Failed to create AAC user");
  }

  async getAacUsersByUserId(userId: string): Promise<AacUser[]> {
    return await db.select().from(aacUsers).where(eq(aacUsers.userId, userId));
  }

  async getAacUserByAacUserId(aacUserId: string): Promise<AacUser | undefined> {
    const [aacUser] = await db
      .select()
      .from(aacUsers)
      .where(eq(aacUsers.aacUserId, aacUserId));
    return aacUser || undefined;
  }

  async updateAacUser(
    id: string,
    updates: UpdateAacUser
  ): Promise<AacUser | undefined> {
    const [aacUser] = await db
      .update(aacUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(aacUsers.id, id))
      .returning();
    return aacUser || undefined;
  }

  async deleteAacUser(id: string): Promise<boolean> {
    const result = await db.delete(aacUsers).where(eq(aacUsers.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // AAC User Schedule operations
  async createScheduleEntry(
    schedule: InsertAacUserSchedule
  ): Promise<AacUserSchedule> {
    const [scheduleEntry] = await db
      .insert(aacUserSchedules)
      .values(schedule)
      .returning();
    return scheduleEntry;
  }

  async getSchedulesByAacUserId(aacUserId: string): Promise<AacUserSchedule[]> {
    return await db
      .select()
      .from(aacUserSchedules)
      .where(eq(aacUserSchedules.aacUserId, aacUserId))
      .orderBy(aacUserSchedules.dayOfWeek, aacUserSchedules.startTime);
  }

  async getScheduleEntry(id: string): Promise<AacUserSchedule | undefined> {
    const [entry] = await db
      .select()
      .from(aacUserSchedules)
      .where(eq(aacUserSchedules.id, id));
    return entry || undefined;
  }

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

  async deleteScheduleEntry(id: string): Promise<boolean> {
    const result = await db
      .delete(aacUserSchedules)
      .where(eq(aacUserSchedules.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getCurrentScheduleContext(
    aacUserId: string,
    timestamp: Date
  ): Promise<{
    activityName: string | null;
    topicTags: string[] | null;
  }> {
    const dayOfWeek = timestamp.getDay() + 1; // JavaScript: 0=Sunday, Database: 1=Sunday
    const currentTime = timestamp.toTimeString().slice(0, 8); // 'HH:MM:SS'
    const currentDate = timestamp.toISOString().split("T")[0]; // 'YYYY-MM-DD'

    // First check for date-specific overrides
    const [override] = await db
      .select()
      .from(aacUserSchedules)
      .where(
        and(
          eq(aacUserSchedules.aacUserId, aacUserId),
          eq(aacUserSchedules.dateOverride, currentDate),
          sql`${aacUserSchedules.startTime} <= ${currentTime}`,
          sql`${aacUserSchedules.endTime} >= ${currentTime}`
        )
      )
      .limit(1);

    if (override) {
      return {
        activityName: override.activityName,
        topicTags: override.topicTags || null,
      };
    }

    // Check regular weekly schedule
    const [schedule] = await db
      .select()
      .from(aacUserSchedules)
      .where(
        and(
          eq(aacUserSchedules.aacUserId, aacUserId),
          eq(aacUserSchedules.dayOfWeek, dayOfWeek),
          eq(aacUserSchedules.isRepeatingWeekly, true),
          sql`${aacUserSchedules.startTime} <= ${currentTime}`,
          sql`${aacUserSchedules.endTime} >= ${currentTime}`
        )
      )
      .limit(1);

    if (schedule) {
      return {
        activityName: schedule.activityName,
        topicTags: schedule.topicTags || null,
      };
    }

    return {
      activityName: null,
      topicTags: null,
    };
  }

  // System prompt operations
  async getSystemPrompt(): Promise<string> {
    try {
      console.log("Getting system prompt from database...");
      // Try to get from systemSettings table
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "system_prompt"));

      if (setting) {
        console.log("Found system prompt in database");
        return setting.value;
      }

      console.log("No system prompt found in database, returning default");
      // Return default prompt if not found in database
      const defaultPrompt = `You are a specialized AAC (Augmentative and Alternative Communication) interpreter for caregivers. Your role is to analyze and interpret communication attempts from individuals with communication disabilities, particularly children with conditions like Rett syndrome.

Context Information:
- Input: {input}
- Language: {language}
- Situational Context: {context}
- AAC User Profile: {aacUserInfo}

Your task is to:
1. Analyze the provided AAC input (text or image description)
2. Consider the context and user profile information
3. Provide an interpretation of what the individual is likely trying to communicate
4. Suggest appropriate responses for the caregiver

Respond with a JSON object containing:
{
  "interpretedMeaning": "Clear, empathetic interpretation of the intended communication",
  "analysis": ["Point 1 about communication patterns", "Point 2 about context clues", "Point 3 about user-specific insights"],
  "confidence": 0.85,
  "suggestedResponse": "Caring, appropriate response suggestion for the caregiver"
}

Guidelines:
- Be empathetic and person-centered in interpretations
- Consider the individual's known preferences and patterns
- Provide confidence scores between 0.1-1.0
- Suggest responses that validate the communication attempt
- Use {language} for all response text (Hebrew if "he", English if "en")
- Consider developmental and physical limitations
- Be specific and actionable in suggestions`;

      return defaultPrompt;
    } catch (error) {
      console.error("Error getting system prompt:", error);
      throw error;
    }
  }

  async updateSystemPrompt(prompt: string): Promise<void> {
    try {
      console.log("Updating system prompt in database...");
      // Use upsert to insert or update the system prompt
      await db
        .insert(systemSettings)
        .values({ key: "system_prompt", value: prompt, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: prompt,
            updatedAt: new Date(),
          },
        });

      console.log("System prompt updated successfully in database");
    } catch (error) {
      console.error("Error updating system prompt:", error);
      throw error;
    }
  }

  // Invite code operations
  async createInviteCode(
    inviteCodeData: InsertInviteCode
  ): Promise<InviteCode> {
    // Generate 8-character alphanumeric code
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();

    const [inviteCode] = await db
      .insert(inviteCodes)
      .values({ ...inviteCodeData, code })
      .returning();
    return inviteCode;
  }

  async getInviteCode(code: string): Promise<InviteCode | undefined> {
    const [inviteCode] = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code));
    return inviteCode || undefined;
  }

  async getInviteCodesByUserId(userId: string): Promise<InviteCode[]> {
    return await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.createdByUserId, userId))
      .orderBy(desc(inviteCodes.createdAt));
  }

  async redeemInviteCode(
    code: string,
    userId: string
  ): Promise<{ success: boolean; aacUser?: AacUser; error?: string }> {
    try {
      // Get the invite code
      const inviteCode = await this.getInviteCode(code);
      if (!inviteCode) {
        return { success: false, error: "Invalid invite code" };
      }

      // Check if code is active
      if (!inviteCode.isActive) {
        return { success: false, error: "Invite code is no longer active" };
      }

      // Check if code has expired
      if (inviteCode.expiresAt && new Date() > inviteCode.expiresAt) {
        return { success: false, error: "Invite code has expired" };
      }

      // Check redemption limit
      const redemptionLimit = inviteCode.redemptionLimit ?? Infinity;
      if (inviteCode.timesRedeemed >= redemptionLimit) {
        return {
          success: false,
          error: "Invite code has reached its usage limit",
        };
      }

      // Check if user already redeemed this code
      const existingRedemption = await db
        .select()
        .from(inviteCodeRedemptions)
        .where(
          and(
            eq(inviteCodeRedemptions.inviteCodeId, inviteCode.id),
            eq(inviteCodeRedemptions.redeemedByUserId, userId)
          )
        )
        .limit(1);

      if (existingRedemption.length > 0) {
        return {
          success: false,
          error: "You have already used this invite code",
        };
      }

      // Get the AAC user associated with this invite code
      const aacUser = await this.getAacUserByAacUserId(inviteCode.aacUserId);
      if (!aacUser) {
        return { success: false, error: "Associated AAC user not found" };
      }

      // Create a copy of the AAC user for the redeeming user
      const newAacUserData = {
        userId: userId,
        aacUserId: `aac_${Date.now()}_${Math.random()
          .toString(36)
          .substr(2, 9)}`, // Generate unique ID
        alias: aacUser.alias,
        gender: aacUser.gender,
        age: aacUser.age,
        disabilityOrSyndrome: aacUser.disabilityOrSyndrome,
        backgroundContext: aacUser.backgroundContext,
      };

      const newAacUser = await this.createAacUser(newAacUserData);

      // Record the redemption
      await db.insert(inviteCodeRedemptions).values({
        inviteCodeId: inviteCode.id,
        redeemedByUserId: userId,
        aacUserId: newAacUser.aacUserId,
      });

      // Update redemption count
      await db
        .update(inviteCodes)
        .set({ timesRedeemed: inviteCode.timesRedeemed + 1 })
        .where(eq(inviteCodes.id, inviteCode.id));

      return { success: true, aacUser: newAacUser };
    } catch (error) {
      console.error("Error redeeming invite code:", error);
      return { success: false, error: "Failed to redeem invite code" };
    }
  }

  async getInviteCodeRedemptions(
    userId: string
  ): Promise<InviteCodeRedemption[]> {
    return await db
      .select()
      .from(inviteCodeRedemptions)
      .where(eq(inviteCodeRedemptions.redeemedByUserId, userId))
      .orderBy(desc(inviteCodeRedemptions.redeemedAt));
  }

  async deactivateInviteCode(id: string): Promise<boolean> {
    const result = await db
      .update(inviteCodes)
      .set({ isActive: false })
      .where(eq(inviteCodes.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // API tracking operations
  async createApiProvider(provider: InsertApiProvider): Promise<ApiProvider> {
    // Validate provider data before insertion
    const { insertApiProviderSchemaWithValidation } = await import(
      "@shared/schema"
    );
    const validatedProvider =
      insertApiProviderSchemaWithValidation.parse(provider);

    const [createdProvider] = await db
      .insert(apiProviders)
      .values(validatedProvider)
      .returning();

    // Refresh API tracker cache to pick up new provider
    const { apiTracker } = await import("./services/apiTracker");
    await apiTracker.refreshProviders().catch(console.error);

    return createdProvider;
  }

  async getApiProviders(): Promise<ApiProvider[]> {
    return await db
      .select()
      .from(apiProviders)
      .where(eq(apiProviders.isActive, true));
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
    // Validate updates if they include critical fields
    if (updates.pricingJson || updates.currencyCode) {
      const { insertApiProviderSchemaWithValidation } = await import(
        "@shared/schema"
      );
      const currentProvider = await this.getApiProvider(id);
      if (!currentProvider) return undefined;

      const mergedProvider = { ...currentProvider, ...updates };
      insertApiProviderSchemaWithValidation.parse(mergedProvider);
    }

    const [provider] = await db
      .update(apiProviders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(apiProviders.id, id))
      .returning();

    // Refresh API tracker cache after provider update
    if (provider) {
      const { apiTracker } = await import("./services/apiTracker");
      await apiTracker.refreshProviders().catch(console.error);
    }

    return provider || undefined;
  }

  async createApiCall(apiCall: InsertApiCall): Promise<ApiCall> {
    const [createdCall] = await db.insert(apiCalls).values(apiCall).returning();
    return createdCall;
  }

  async getApiCalls(
    limit: number = 100,
    offset: number = 0
  ): Promise<ApiCall[]> {
    return await db
      .select()
      .from(apiCalls)
      .orderBy(desc(apiCalls.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getApiCallsByProvider(
    providerId: string,
    limit: number = 100,
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
        .select({ count: sql<number>`COUNT(*)` })
        .from(apiCalls)
        .where(eq(apiCalls.providerId, providerId));
      return Number(result?.count || 0);
    } else {
      const [result] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(apiCalls);
      return Number(result?.count || 0);
    }
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
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);

      // Single query with conditional aggregates for all stats
      const [stats] = await db
        .select({
          totalCostToday: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${today} THEN ${apiCalls.totalCostUsd} END)::float8, 0)`,
          totalCostWeek: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${weekAgo} THEN ${apiCalls.totalCostUsd} END)::float8, 0)`,
          totalCostMonth: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${monthAgo} THEN ${apiCalls.totalCostUsd} END)::float8, 0)`,
          totalCallsToday: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${today} THEN 1 ELSE 0 END), 0)`,
          totalCallsWeek: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${weekAgo} THEN 1 ELSE 0 END), 0)`,
          totalCallsMonth: sql<string>`COALESCE(SUM(CASE WHEN ${apiCalls.createdAt} >= ${monthAgo} THEN 1 ELSE 0 END), 0)`,
          avgCost: sql<string>`COALESCE(AVG(${apiCalls.totalCostUsd})::float8, 0)`,
        })
        .from(apiCalls);

      // Separate query for top provider
      const topProviderResult = await db
        .select({
          name: apiProviders.name,
          totalCost: sql<string>`COALESCE(SUM(${apiCalls.totalCostUsd})::float8, 0)`,
        })
        .from(apiCalls)
        .innerJoin(apiProviders, eq(apiCalls.providerId, apiProviders.id))
        .where(sql`${apiCalls.createdAt} >= ${monthAgo}`)
        .groupBy(apiProviders.id, apiProviders.name)
        .orderBy(sql`SUM(${apiCalls.totalCostUsd}) DESC`)
        .limit(1);

      const topProvider =
        topProviderResult.length > 0
          ? {
              name: topProviderResult[0].name,
              cost: Number(topProviderResult[0].totalCost),
            }
          : null;

      // Safe number coercion with fallbacks
      const totalCallsMonth = Number(stats?.totalCallsMonth || 0);
      const avgCost = totalCallsMonth > 0 ? Number(stats?.avgCost || 0) : 0;

      return {
        totalCostToday: Number(stats?.totalCostToday || 0),
        totalCostWeek: Number(stats?.totalCostWeek || 0),
        totalCostMonth: Number(stats?.totalCostMonth || 0),
        totalCallsToday: Number(stats?.totalCallsToday || 0),
        totalCallsWeek: Number(stats?.totalCallsWeek || 0),
        totalCallsMonth,
        averageCostPerCall: avgCost,
        topProviderBySpend: topProvider,
      };
    } catch (error) {
      console.error("Error getting API usage stats:", error);
      // Always return a valid response to prevent timeouts
      return {
        totalCostToday: 0,
        totalCostWeek: 0,
        totalCostMonth: 0,
        totalCallsToday: 0,
        totalCallsWeek: 0,
        totalCallsMonth: 0,
        averageCostPerCall: 0,
        topProviderBySpend: null,
      };
    }
  }

  // API calls

  async getUserApiCalls(userId: string, limit: number = 50, offset: number = 0): Promise<{ calls: ApiCall[], total: number }> {
    const calls = await db
      .select()
      .from(apiCalls)
      .where(eq(apiCalls.userId, userId))
      .orderBy(desc(apiCalls.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: count() })
      .from(apiCalls)
      .where(eq(apiCalls.userId, userId));

    return { calls, total };
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

  // API provider pricing operations
  async createApiProviderPricing(pricing: InsertApiProviderPricing): Promise<ApiProviderPricing> {
    const [created] = await db
      .insert(apiProviderPricing)
      .values(pricing)
      .returning();
    return created;
  }

  async getApiProviderPricing(provider: string, model: string, endpoint?: string): Promise<ApiProviderPricing | null> {
    let whereConditions = [
      eq(apiProviderPricing.provider, provider),
      eq(apiProviderPricing.model, model),
      eq(apiProviderPricing.isActive, true)
    ];

    if (endpoint) {
      whereConditions.push(eq(apiProviderPricing.endpoint, endpoint));
    }

    const [pricing] = await db
      .select()
      .from(apiProviderPricing)
      .where(and(...whereConditions))
      .orderBy(desc(apiProviderPricing.effectiveFrom))
      .limit(1);

    return pricing || null;
  }

  async getAllActiveApiProviderPricing(): Promise<ApiProviderPricing[]> {
    return await db
      .select()
      .from(apiProviderPricing)
      .where(eq(apiProviderPricing.isActive, true))
      .orderBy(asc(apiProviderPricing.provider), asc(apiProviderPricing.model));
  }

  async updateApiProviderPricing(id: string, pricing: Partial<InsertApiProviderPricing>): Promise<ApiProviderPricing | undefined> {
    const [updated] = await db
      .update(apiProviderPricing)
      .set({
        ...pricing,
        updatedAt: new Date()
      })
      .where(eq(apiProviderPricing.id, id))
      .returning();

    return updated || undefined;
  }

  async deactivateApiProviderPricing(provider: string, model: string, endpoint?: string): Promise<void> {
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
        updatedAt: new Date()
      })
      .where(whereCondition);
  }

  // Saved locations operations
  async createSavedLocation(
    location: InsertSavedLocation
  ): Promise<SavedLocation> {
    const [createdLocation] = await db
      .insert(savedLocations)
      .values(location)
      .returning();
    return createdLocation;
  }

  async getUserSavedLocations(userId: string): Promise<SavedLocation[]> {
    return await db
      .select()
      .from(savedLocations)
      .where(
        and(
          eq(savedLocations.userId, userId),
          eq(savedLocations.isActive, true)
        )
      )
      .orderBy(desc(savedLocations.createdAt));
  }

  async deleteSavedLocation(id: string, userId: string): Promise<boolean> {
    const result = await db
      .update(savedLocations)
      .set({ isActive: false })
      .where(and(eq(savedLocations.id, id), eq(savedLocations.userId, userId)));

    return result.rowCount !== null && result.rowCount > 0;
  }

  // Historical AAC analysis operations
  async getAacUserHistory(
    aacUserId: string,
    limit?: number
  ): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .where(eq(interpretations.aacUserId, aacUserId))
      .orderBy(desc(interpretations.createdAt));

    return limit ? await query.limit(limit) : await query;
  }

  async analyzeHistoricalPatterns(
    aacUserId: string,
    currentInput: string
  ): Promise<{
    suggestions: Array<{
      interpretation: string;
      confidence: number;
      frequency: number;
      pattern: string;
    }>;
    totalPatterns: number;
  }> {
    try {
      // Get all historical interpretations for this AAC user
      const history = await this.getAacUserHistory(aacUserId);

      if (history.length === 0) {
        return { suggestions: [], totalPatterns: 0 };
      }

      // Normalize input for matching
      const normalizeText = (text: string): string[] => {
        return text
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter((word) => word.length > 0);
      };

      const currentWords = normalizeText(currentInput);

      // Create pattern frequency map
      const patternFrequency = new Map<
        string,
        {
          interpretation: string;
          count: number;
          matchScore: number;
        }
      >();

      // Analyze each historical record
      for (const record of history) {
        const historicalWords = normalizeText(record.originalInput);

        // Calculate similarity score between current input and historical input
        const matchScore = this.calculateWordSimilarity(
          currentWords,
          historicalWords
        );

        if (matchScore > 0) {
          const pattern = historicalWords.join(" ");
          const existing = patternFrequency.get(pattern);

          if (existing) {
            existing.count++;
            existing.matchScore = Math.max(existing.matchScore, matchScore);
          } else {
            patternFrequency.set(pattern, {
              interpretation: record.interpretedMeaning,
              count: 1,
              matchScore,
            });
          }
        }
      }

      // Convert to suggestions and sort by relevance
      const suggestions = Array.from(patternFrequency.entries())
        .map(([pattern, data]) => ({
          interpretation: data.interpretation,
          confidence: this.calculateConfidence(
            data.matchScore,
            data.count,
            history.length
          ),
          frequency: data.count,
          pattern,
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5); // Return top 5 suggestions

      return {
        suggestions,
        totalPatterns: patternFrequency.size,
      };
    } catch (error) {
      console.error("Error analyzing historical patterns:", error);
      return { suggestions: [], totalPatterns: 0 };
    }
  }

  private calculateWordSimilarity(words1: string[], words2: string[]): number {
    if (words1.length === 0 || words2.length === 0) return 0;

    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    // Jaccard similarity with bonus for exact matches
    const jaccardSimilarity = intersection.size / union.size;

    // Bonus for word order similarity
    let orderBonus = 0;
    const minLength = Math.min(words1.length, words2.length);
    for (let i = 0; i < minLength; i++) {
      if (words1[i] === words2[i]) {
        orderBonus += 0.1;
      }
    }

    return Math.min(jaccardSimilarity + orderBonus, 1.0);
  }

  private calculateConfidence(
    matchScore: number,
    frequency: number,
    totalRecords: number
  ): number {
    // Base confidence from similarity score (0-1)
    const similarityWeight = 0.6;

    // Frequency weight (normalized by total records)
    const frequencyWeight = 0.4;
    const normalizedFrequency = Math.min(frequency / totalRecords, 1.0);

    return Math.min(
      matchScore * similarityWeight + normalizedFrequency * frequencyWeight,
      1.0
    );
  }

  // Settings operations
  async getSetting(key: string, defaultValue?: string): Promise<string | null> {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));

      return setting?.value || defaultValue || null;
    } catch (error) {
      console.error(`Error getting setting ${key}:`, error);
      return defaultValue || null;
    }
  }

  async updateSetting(key: string, value: string): Promise<void> {
    try {
      await db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    } catch (error) {
      console.error(`Error updating setting ${key}:`, error);
      throw error;
    }
  }

  // Referral operations
  async getUserByReferralCode(referralCode: string): Promise<User | undefined> {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.referralCode, referralCode));

      return user || undefined;
    } catch (error) {
      console.error(`Error getting user by referral code:`, error);
      return undefined;
    }
  }

  generateReferralCode(): string {
    // Generate a unique 12-character referral code (e.g., XAHAPH-A1B2C3)
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar looking characters
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

export const storage = new DatabaseStorage();
