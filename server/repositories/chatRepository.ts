/**
 * Chat Repository
 * 
 * Repository layer for chat sessions.
 * Simplified to remove agents and instances - uses mode-based templates instead.
 */

import {
  chatSessions,
  users,
  students,
  type ChatSession,
  type InsertChatSession,
  type ChatState,
  type ChatMessage,
} from "@shared/schema";
import { db } from "../db";
import { eq, ne, and, isNull, desc, or, sql, gte, lte, count } from "drizzle-orm";

export interface ChatAdminSessionFilters {
  userId?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}

export class ChatRepository {
  // ============================================================================
  // SESSION OPERATIONS
  // ============================================================================

  async createSession(session: InsertChatSession): Promise<ChatSession> {
    const [newSession] = await db.insert(chatSessions).values(session).returning();
    return newSession;
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.deletedAt)));
    return session || undefined;
  }

  async getSessionsByUserId(userId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.userId, userId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
  }

  async getSessionsByStudentId(studentId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.studentId, studentId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
  }

  async getSessionsByUserStudentId(userStudentId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.userStudentId, userStudentId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
  }

  async getOpenSessions(userId?: string, studentId?: string): Promise<ChatSession[]> {
    const conditions = [eq(chatSessions.status, "open"), isNull(chatSessions.deletedAt)];
    
    if (userId) {
      conditions.push(eq(chatSessions.userId, userId));
    }
    if (studentId) {
      conditions.push(eq(chatSessions.studentId, studentId));
    }
    
    return await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.priority), desc(chatSessions.lastUpdate));
  }

  async updateSession(id: string, updates: Partial<InsertChatSession>): Promise<ChatSession | undefined> {
    const [session] = await db
      .update(chatSessions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(chatSessions.id, id))
      .returning();
    return session || undefined;
  }

  async deleteSession(id: string): Promise<void> {
    await db
      .update(chatSessions)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(chatSessions.id, id));
  }

  async updateSessionState(
    id: string,
    state: ChatState,
    log?: ChatMessage[]
  ): Promise<void> {
    const updates: Partial<InsertChatSession> = {
      state,
      lastUpdate: new Date(),
    };
    if (log !== undefined) {
      updates.log = log;
    }
    await db
      .update(chatSessions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(chatSessions.id, id));
  }

  async updateSessionCredits(id: string, creditsUsed: number): Promise<void> {
    await db
      .update(chatSessions)
      .set({
        creditsUsed: sql`${chatSessions.creditsUsed} + ${creditsUsed}`,
        lastUpdate: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, id));
  }

  async updateSessionLast(id: string, last: ChatMessage[]): Promise<void> {
    await db
      .update(chatSessions)
      .set({ last, lastUpdate: new Date(), updatedAt: new Date() })
      .where(eq(chatSessions.id, id));
  }

  async updateSessionStatus(
    id: string,
    status: "open" | "paused" | "closed"
  ): Promise<ChatSession | undefined> {
    const [session] = await db
      .update(chatSessions)
      .set({ status, updatedAt: new Date() })
      .where(eq(chatSessions.id, id))
      .returning();
    return session || undefined;
  }

  async getRecentSessionsForContext(
    userId?: string,
    studentId?: string,
    limit: number = 5
  ): Promise<ChatSession[]> {
    const conditions = [isNull(chatSessions.deletedAt)];
    
    if (userId && studentId) {
      conditions.push(
        or(
          eq(chatSessions.userId, userId),
          eq(chatSessions.studentId, studentId)
        )!
      );
    } else if (userId) {
      conditions.push(eq(chatSessions.userId, userId));
    } else if (studentId) {
      conditions.push(eq(chatSessions.studentId, studentId));
    }
    
    return await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(limit);
  }
  // ============================================================================
  // ADMIN OPERATIONS
  // ============================================================================

  async getSessionsAdmin(opts: ChatAdminSessionFilters) {
    const conditions = [isNull(chatSessions.deletedAt), ne(chatSessions.chatMode, "aac")];
    if (opts.userId) {
      conditions.push(eq(chatSessions.userId, opts.userId));
    }
    if (opts.startDate) {
      conditions.push(gte(chatSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(chatSessions.started, end));
    }

    return await db
      .select({
        id: chatSessions.id,
        userId: chatSessions.userId,
        userName: users.fullName,
        studentId: chatSessions.studentId,
        studentName: students.name,
        chatMode: chatSessions.chatMode,
        creditsUsed: chatSessions.creditsUsed,
        status: chatSessions.status,
        started: chatSessions.started,
        lastUpdate: chatSessions.lastUpdate,
      })
      .from(chatSessions)
      .leftJoin(users, eq(chatSessions.userId, users.id))
      .leftJoin(students, eq(chatSessions.studentId, students.id))
      .where(and(...conditions))
      .orderBy(desc(chatSessions.started))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async getSessionsAdminCount(opts: ChatAdminSessionFilters): Promise<number> {
    const conditions = [isNull(chatSessions.deletedAt), ne(chatSessions.chatMode, "aac")];
    if (opts.userId) {
      conditions.push(eq(chatSessions.userId, opts.userId));
    }
    if (opts.startDate) {
      conditions.push(gte(chatSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(chatSessions.started, end));
    }

    const [result] = await db
      .select({ total: count() })
      .from(chatSessions)
      .where(and(...conditions));
    return result?.total ?? 0;
  }

  async getAACSessionsAdmin(opts: ChatAdminSessionFilters) {
    const conditions = [isNull(chatSessions.deletedAt), eq(chatSessions.chatMode, "aac")];
    if (opts.startDate) {
      conditions.push(gte(chatSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(chatSessions.started, end));
    }

    return await db
      .select({
        id: chatSessions.id,
        userId: chatSessions.userId,
        userName: users.fullName,
        studentId: chatSessions.studentId,
        studentName: students.name,
        creditsUsed: chatSessions.creditsUsed,
        status: chatSessions.status,
        started: chatSessions.started,
        lastUpdate: chatSessions.lastUpdate,
      })
      .from(chatSessions)
      .leftJoin(users, eq(chatSessions.userId, users.id))
      .leftJoin(students, eq(chatSessions.studentId, students.id))
      .where(and(...conditions))
      .orderBy(desc(chatSessions.started))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async getAACSessionsAdminCount(opts: ChatAdminSessionFilters): Promise<number> {
    const conditions = [isNull(chatSessions.deletedAt), eq(chatSessions.chatMode, "aac")];
    if (opts.startDate) {
      conditions.push(gte(chatSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(chatSessions.started, end));
    }

    const [result] = await db
      .select({ total: count() })
      .from(chatSessions)
      .where(and(...conditions));
    return result?.total ?? 0;
  }

  async getSessionLog(id: string): Promise<ChatMessage[] | undefined> {
    const [result] = await db
      .select({ log: chatSessions.log })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.deletedAt)));
    return (result?.log as ChatMessage[] | undefined) ?? undefined;
  }
}

export const chatRepository = new ChatRepository();