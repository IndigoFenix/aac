import {
  boards,
  promptHistory,
  promptEvents,
  usageWindows,
  plans,
  users,
  type Board,
  type InsertBoard,
  type PromptHistory,
  type InsertPromptHistory,
  type PromptEvent,
  type InsertPromptEvent,
  type UsageWindow,
  type Plan,
  type InsertPlan,
  type User,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, and, gte, lte, inArray, sql, sum, count } from "drizzle-orm";

export class BoardRepository {
  // Board CRUD operations
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

  // Plan operations
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

  // Usage window operations
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

  // Prompt history operations
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

  async markPromptAsDownloaded(promptId: string): Promise<void> {
    await db
      .update(promptHistory)
      .set({
        downloaded: true,
        downloadedAt: new Date(),
      })
      .where(eq(promptHistory.id, promptId));
  }

  // Prompt events
  async createPromptEvent(event: InsertPromptEvent): Promise<PromptEvent> {
    const [newEvent] = await db.insert(promptEvents).values(event).returning();
    return newEvent;
  }

  // Analytics data
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

    // Time series data
    const timeSeriesData = await db
      .select({
        date: sql`DATE(created_at)`.as("date"),
        prompts: count(),
        boards: sql`SUM(CASE WHEN success = true THEN 1 ELSE 0 END)`.as("boards"),
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
        boards: sql`SUM(CASE WHEN success = true THEN 1 ELSE 0 END)`.as("boards"),
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
}

export const boardRepository = new BoardRepository();
