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
  sessionDebugLogs,
  type ChatSession,
  type InsertChatSession,
  type ChatState,
  type ChatMessage,
} from "@shared/schema";
import { db } from "../db";
import { eq, ne, and, isNull, desc, asc, or, sql, gte, lte, lt, count } from "drizzle-orm";
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
  // CLINICIAN (own-data) OPERATIONS
  //
  // These power the in-chat "past conversations" sidebar. Unlike the admin
  // methods above, every query is scoped to the requesting user's own sessions
  // (userId match) — never institute-wide. AAC and CRM sessions are excluded;
  // those have their own surfaces.
  // ============================================================================

  /**
   * List the requesting user's own chat conversations, newest first. Returns a
   * lightweight projection (no full log) plus a derived message count and a
   * snippet of the first message, so the sidebar can show a fallback name when
   * no AI/manual title exists yet. Empty sessions (0 messages) are omitted.
   */
  async getSessionsForUser(opts: {
    userId: string;
    studentId?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      title: string | null;
      titleManual: boolean;
      importance: number;
      chatMode: string;
      status: "open" | "paused" | "closed";
      started: Date;
      lastUpdate: Date;
      messageCount: number;
      firstMessage: string | null;
    }>
  > {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const conditions = [
      eq(chatSessions.userId, opts.userId),
      isNull(chatSessions.deletedAt),
      ne(chatSessions.chatMode, "aac"),
      isNull(chatSessions.crmPotentialCustomerId),
      sql`jsonb_array_length(${chatSessions.log}) > 0`,
    ];
    if (opts.studentId) {
      conditions.push(eq(chatSessions.studentId, opts.studentId));
    }

    return await db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        titleManual: chatSessions.titleManual,
        importance: chatSessions.importance,
        chatMode: chatSessions.chatMode,
        status: chatSessions.status,
        started: chatSessions.started,
        lastUpdate: chatSessions.lastUpdate,
        messageCount: sql<number>`jsonb_array_length(${chatSessions.log})`,
        // First message is the user's opening line (string content); truncate
        // for a fallback label. Objects (assistant md/html) yield their JSON
        // text, which we never reach here since index 0 is the user's message.
        firstMessage: sql<string | null>`left(${chatSessions.log}->0->>'content', 140)`,
      })
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(limit);
  }

  /** Load one of the user's own sessions in full (for resume). Ownership-scoped. */
  async getSessionForUser(id: string, userId: string): Promise<ChatSession | undefined> {
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, id),
          eq(chatSessions.userId, userId),
          isNull(chatSessions.deletedAt),
        ),
      );
    if (!session) return undefined;
    const [hydrated] = await hydrateRecords("chat_sessions", [session]);
    return hydrated;
  }

  /**
   * Rename one of the user's own sessions and lock the title so the summarizer
   * never overwrites it. Returns false if the session isn't found / not owned.
   */
  async renameSession(id: string, userId: string, title: string): Promise<boolean> {
    const trimmed = title.trim().slice(0, 200);
    const result = await db
      .update(chatSessions)
      .set({ title: trimmed, titleManual: true, updatedAt: new Date() })
      .where(
        and(
          eq(chatSessions.id, id),
          eq(chatSessions.userId, userId),
          isNull(chatSessions.deletedAt),
        ),
      )
      .returning({ id: chatSessions.id });
    return result.length > 0;
  }

  /** Soft-delete one of the user's own sessions. Returns false if not owned. */
  async softDeleteSessionForUser(id: string, userId: string): Promise<boolean> {
    const result = await db
      .update(chatSessions)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(chatSessions.id, id),
          eq(chatSessions.userId, userId),
          isNull(chatSessions.deletedAt),
        ),
      )
      .returning({ id: chatSessions.id });
    return result.length > 0;
  }

  /**
   * IDs of the user's recent sessions that have messages but no title yet.
   * Used to opportunistically backfill titles when the sidebar is opened —
   * awaited (not fire-and-forget) so it survives the Lambda post-response freeze.
   */
  async getUntitledSessionIdsForUser(opts: {
    userId: string;
    studentId?: string;
    limit?: number;
  }): Promise<string[]> {
    const limit = Math.min(Math.max(opts.limit ?? 3, 1), 10);
    const conditions = [
      eq(chatSessions.userId, opts.userId),
      isNull(chatSessions.deletedAt),
      ne(chatSessions.chatMode, "aac"),
      isNull(chatSessions.crmPotentialCustomerId),
      isNull(chatSessions.title),
      sql`jsonb_array_length(${chatSessions.log}) > 0`,
      // Only summarize conversations that have gone idle, so we never title an
      // actively-in-progress chat mid-stream (which would freeze a half-baked
      // title via the summarizer's idempotency guard).
      sql`${chatSessions.lastUpdate} < now() - interval '2 minutes'`,
    ];
    if (opts.studentId) {
      conditions.push(eq(chatSessions.studentId, opts.studentId));
    }
    const rows = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(limit);
    return rows.map((r) => r.id);
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
        costBreakdown: chatSessions.costBreakdown,
        costModalityBreakdown: chatSessions.costModalityBreakdown,
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
        costBreakdown: chatSessions.costBreakdown,
        costModalityBreakdown: chatSessions.costModalityBreakdown,
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

  async getSessionLog(id: string): Promise<
    | {
        log: ChatMessage[];
        title: string | null;
        summary: string | null;
        importance: number | null;
      }
    | undefined
  > {
    const [result] = await db
      .select({
        log: chatSessions.log,
        title: chatSessions.title,
        summary: chatSessions.summary,
        importance: chatSessions.importance,
      })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.deletedAt)));
    if (!result) return undefined;
    return {
      log: (result.log as ChatMessage[] | null) ?? [],
      title: result.title ?? null,
      summary: result.summary ?? null,
      importance: result.importance ?? null,
    };
  }

  /**
   * Per-session debug log entries written by dual-agent-logger when the
   * session was initialized with debugMode=true. Ordered by insertion
   * sequence (seq) so the trace reads chronologically even when timestamps
   * collide. Returns null when the chat session doesn't exist.
   */
  async getSessionDebugLog(
    sessionId: string,
    opts: { section?: string; limit?: number; offset?: number } = {},
  ): Promise<{ entries: Array<{ id: string; seq: number; timestamp: Date; section: string; content: string }>; total: number } | null> {
    const [session] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt)));
    if (!session) return null;

    const conds = [eq(sessionDebugLogs.sessionId, sessionId)];
    if (opts.section) conds.push(eq(sessionDebugLogs.section, opts.section));

    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const [totalRow] = await db
      .select({ total: count() })
      .from(sessionDebugLogs)
      .where(and(...conds));

    const entries = await db
      .select({
        id: sessionDebugLogs.id,
        seq: sessionDebugLogs.seq,
        timestamp: sessionDebugLogs.timestamp,
        section: sessionDebugLogs.section,
        content: sessionDebugLogs.content,
      })
      .from(sessionDebugLogs)
      .where(and(...conds))
      .orderBy(asc(sessionDebugLogs.seq))
      .limit(limit)
      .offset(offset);

    return { entries, total: totalRow?.total ?? 0 };
  }

  /**
   * Bulk-delete session debug log entries older than `before` (admin
   * maintenance — keeps the session_debug_logs table from growing without
   * bound). Matches on the row `timestamp`. Returns the number of rows
   * removed. Does not touch the parent chat sessions.
   */
  async deleteSessionDebugLogsBefore(before: Date): Promise<number> {
    const result = await db
      .delete(sessionDebugLogs)
      .where(lt(sessionDebugLogs.timestamp, before));
    return result.rowCount ?? 0;
  }
}

export const chatRepository = new ChatRepository();