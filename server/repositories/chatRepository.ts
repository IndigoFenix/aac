/**
 * Chat Repository
 * 
 * Repository layer for chat sessions.
 * Simplified to remove agents and instances - uses mode-based templates instead.
 */

import {
  chatSessions,
  type ChatSession,
  type InsertChatSession,
  type ChatState,
  type ChatMessage,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, isNull, desc, or, sql } from "drizzle-orm";

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

  async getSessionsByAacUserId(aacUserId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.aacUserId, aacUserId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
  }

  async getSessionsByUserAacUserId(userAacUserId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.userAacUserId, userAacUserId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
  }

  async getOpenSessions(userId?: string, aacUserId?: string): Promise<ChatSession[]> {
    const conditions = [eq(chatSessions.status, "open"), isNull(chatSessions.deletedAt)];
    
    if (userId) {
      conditions.push(eq(chatSessions.userId, userId));
    }
    if (aacUserId) {
      conditions.push(eq(chatSessions.aacUserId, aacUserId));
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
    aacUserId?: string,
    limit: number = 5
  ): Promise<ChatSession[]> {
    const conditions = [isNull(chatSessions.deletedAt)];
    
    if (userId && aacUserId) {
      conditions.push(
        or(
          eq(chatSessions.userId, userId),
          eq(chatSessions.aacUserId, aacUserId)
        )!
      );
    } else if (userId) {
      conditions.push(eq(chatSessions.userId, userId));
    } else if (aacUserId) {
      conditions.push(eq(chatSessions.aacUserId, aacUserId));
    }
    
    return await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(limit);
  }
}

export const chatRepository = new ChatRepository();