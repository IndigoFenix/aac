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
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  resolveEntityRef,
} from "../external-storage";

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
    const ref = resolveEntityRef("chat_sessions", newSession as Record<string, unknown>);
    if (ref) {
      const ext = await extractSensitiveFields("chat_sessions", newSession.id, newSession as Record<string, unknown>, ref);
      if (ext.isExternal) {
        const nullSet: Record<string, null> = {};
        for (const key of ext.externalWrites.keys()) {
          const field = key.split("/").pop()!;
          nullSet[field] = null;
        }
        await db.update(chatSessions).set(nullSet).where(eq(chatSessions.id, newSession.id));
        await persistExtracted(ref, ext.externalWrites);
        return ext.completeData as ChatSession;
      }
    }
    return newSession;
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.deletedAt)));
    if (!session) return undefined;
    const [hydrated] = await hydrateRecords("chat_sessions", [session]);
    return hydrated;
  }

  async getSessionsByUserId(userId: string): Promise<ChatSession[]> {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.userId, userId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
    return hydrateRecords("chat_sessions", rows);
  }

  async getSessionsByStudentId(studentId: string): Promise<ChatSession[]> {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.studentId, studentId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
    return hydrateRecords("chat_sessions", rows, { type: "student", id: studentId });
  }

  async getSessionsByUserStudentId(userStudentId: string): Promise<ChatSession[]> {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.userStudentId, userStudentId), isNull(chatSessions.deletedAt)))
      .orderBy(desc(chatSessions.lastUpdate));
    return hydrateRecords("chat_sessions", rows);
  }

  async getOpenSessions(userId?: string, studentId?: string): Promise<ChatSession[]> {
    const conditions = [eq(chatSessions.status, "open"), isNull(chatSessions.deletedAt)];

    if (userId) {
      conditions.push(eq(chatSessions.userId, userId));
    }
    if (studentId) {
      conditions.push(eq(chatSessions.studentId, studentId));
    }

    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.priority), desc(chatSessions.lastUpdate));
    const ref = studentId ? { type: "student" as const, id: studentId } : undefined;
    return hydrateRecords("chat_sessions", rows, ref);
  }

  async updateSession(id: string, updates: Partial<InsertChatSession>): Promise<ChatSession | undefined> {
    // For updates that include sensitive fields, use extract pattern
    const existing = await this.getSession(id);
    if (!existing) return undefined;
    const ref = resolveEntityRef("chat_sessions", existing as Record<string, unknown>);
    if (ref) {
      const ext = await extractSensitiveFields("chat_sessions", id, updates as Record<string, unknown>, ref);
      const [session] = await db
        .update(chatSessions)
        .set({ ...ext.dbData, updatedAt: new Date() })
        .where(eq(chatSessions.id, id))
        .returning();
      if (!session) return undefined;
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("chat_sessions", [session]);
      return hydrated;
    }
    const [session] = await db
      .update(chatSessions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(chatSessions.id, id))
      .returning();
    return session || undefined;
  }

  async deleteSession(id: string): Promise<void> {
    // Soft delete — external data stays for potential audit
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
    // state and log are both sensitive — use extract pattern
    const existing = await this.getSession(id);
    const ref = existing ? resolveEntityRef("chat_sessions", existing as Record<string, unknown>) : null;
    if (ref) {
      const ext = await extractSensitiveFields("chat_sessions", id, updates as Record<string, unknown>, ref);
      await db.update(chatSessions).set({ ...ext.dbData, updatedAt: new Date() }).where(eq(chatSessions.id, id));
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
    } else {
      await db.update(chatSessions).set({ ...updates, updatedAt: new Date() }).where(eq(chatSessions.id, id));
    }
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

    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(limit);
    const ref = studentId ? { type: "student" as const, id: studentId } : undefined;
    return hydrateRecords("chat_sessions", rows, ref);
  }
  // ============================================================================
  // ADMIN OPERATIONS
  // ============================================================================

  async getSessionsAdmin(opts: ChatAdminSessionFilters) {
    const conditions = [
      isNull(chatSessions.deletedAt),
      ne(chatSessions.chatMode, "aac"),
      isNull(chatSessions.crmPotentialCustomerId),
    ];
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
    const conditions = [
      isNull(chatSessions.deletedAt),
      ne(chatSessions.chatMode, "aac"),
      isNull(chatSessions.crmPotentialCustomerId),
    ];
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

  async getAACSessionsAdmin(opts: ChatAdminSessionFilters & { studentId?: string }) {
    const conditions = [isNull(chatSessions.deletedAt), eq(chatSessions.chatMode, "aac")];
    if (opts.studentId) {
      conditions.push(eq(chatSessions.studentId, opts.studentId));
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

  async getAACSessionsAdminCount(opts: ChatAdminSessionFilters & { studentId?: string }): Promise<number> {
    const conditions = [isNull(chatSessions.deletedAt), eq(chatSessions.chatMode, "aac")];
    if (opts.studentId) {
      conditions.push(eq(chatSessions.studentId, opts.studentId));
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

  async getSessionLog(id: string): Promise<ChatMessage[] | undefined> {
    const [result] = await db
      .select({ log: chatSessions.log })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.deletedAt)));
    return (result?.log as ChatMessage[] | undefined) ?? undefined;
  }
}

export const chatRepository = new ChatRepository();