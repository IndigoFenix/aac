/**
 * AAC Session Repository
 *
 * Repository layer for AAC sessions - real-time communication sessions
 * for non-verbal users.
 */

import {
  aacSessions,
  students,
  users,
  type AACSession,
  type InsertAACSession,
  type UpdateAACSession,
  type AACSessionContext,
  type AACMessage,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, sql, isNull, or, gt, gte, lte, count } from "drizzle-orm";

export interface AdminSessionFilters {
  studentId?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  limit: number;
  offset: number;
}

export class AACSessionRepository {
  // ============================================================================
  // SESSION OPERATIONS
  // ============================================================================

  async createSession(session: InsertAACSession): Promise<AACSession> {
    const [newSession] = await db
      .insert(aacSessions)
      .values(session)
      .returning();
    return newSession;
  }

  async getSession(id: string): Promise<AACSession | undefined> {
    const [session] = await db
      .select()
      .from(aacSessions)
      .where(eq(aacSessions.id, id));
    return session || undefined;
  }

  async getSessionsByStudentId(studentId: string): Promise<AACSession[]> {
    return await db
      .select()
      .from(aacSessions)
      .where(eq(aacSessions.studentId, studentId))
      .orderBy(desc(aacSessions.lastActivity));
  }

  async getActiveSessionByStudentId(
    studentId: string
  ): Promise<AACSession | undefined> {
    const [session] = await db
      .select()
      .from(aacSessions)
      .where(
        and(
          eq(aacSessions.studentId, studentId),
          eq(aacSessions.status, "active")
        )
      )
      .orderBy(desc(aacSessions.lastActivity))
      .limit(1);
    return session || undefined;
  }

  async getActiveOrPausedSessionByStudentId(
    studentId: string
  ): Promise<AACSession | undefined> {
    const [session] = await db
      .select()
      .from(aacSessions)
      .where(
        and(
          eq(aacSessions.studentId, studentId),
          or(
            eq(aacSessions.status, "active"),
            eq(aacSessions.status, "paused")
          )
        )
      )
      .orderBy(desc(aacSessions.lastActivity))
      .limit(1);
    return session || undefined;
  }

  async updateSession(
    id: string,
    updates: UpdateAACSession
  ): Promise<AACSession | undefined> {
    const [session] = await db
      .update(aacSessions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(aacSessions.id, id))
      .returning();
    return session || undefined;
  }

  async updateSessionContext(
    id: string,
    context: AACSessionContext
  ): Promise<void> {
    await db
      .update(aacSessions)
      .set({
        context,
        lastActivity: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aacSessions.id, id));
  }

  async updateSessionConversation(
    id: string,
    conversationHistory: AACMessage[]
  ): Promise<void> {
    await db
      .update(aacSessions)
      .set({
        conversationHistory,
        lastActivity: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aacSessions.id, id));
  }

  async updateSessionCredits(id: string, creditsToAdd: number): Promise<void> {
    await db
      .update(aacSessions)
      .set({
        creditsUsed: sql`${aacSessions.creditsUsed} + ${creditsToAdd}`,
        lastActivity: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aacSessions.id, id));
  }

  async updateSessionStatus(
    id: string,
    status: "active" | "paused" | "ended"
  ): Promise<AACSession | undefined> {
    const updates: UpdateAACSession = {
      status,
      updatedAt: new Date(),
    };
    if (status === "ended") {
      updates.ended = new Date();
    }
    const [session] = await db
      .update(aacSessions)
      .set(updates)
      .where(eq(aacSessions.id, id))
      .returning();
    return session || undefined;
  }

  async endSession(id: string): Promise<AACSession | undefined> {
    return this.updateSessionStatus(id, "ended");
  }

  async pauseSession(id: string): Promise<AACSession | undefined> {
    return this.updateSessionStatus(id, "paused");
  }

  async resumeSession(id: string): Promise<AACSession | undefined> {
    return this.updateSessionStatus(id, "active");
  }

  // ============================================================================
  // CLEANUP OPERATIONS
  // ============================================================================

  /**
   * End all stale sessions (no activity for specified duration)
   */
  async endStaleSessions(maxInactiveMs: number): Promise<number> {
    const cutoffTime = new Date(Date.now() - maxInactiveMs);
    const result = await db
      .update(aacSessions)
      .set({
        status: "ended",
        ended: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          or(
            eq(aacSessions.status, "active"),
            eq(aacSessions.status, "paused")
          ),
          sql`${aacSessions.lastActivity} < ${cutoffTime}`
        )
      )
      .returning({ id: aacSessions.id });
    return result.length;
  }

  /**
   * Get sessions that need to be persisted (recently active)
   */
  async getRecentlyActiveSessions(sinceMs: number): Promise<AACSession[]> {
    const cutoffTime = new Date(Date.now() - sinceMs);
    return await db
      .select()
      .from(aacSessions)
      .where(
        and(
          eq(aacSessions.status, "active"),
          gt(aacSessions.lastActivity, cutoffTime)
        )
      );
  }
  // ============================================================================
  // ADMIN OPERATIONS
  // ============================================================================

  async getSessionsAdmin(opts: AdminSessionFilters) {
    const conditions = [];
    if (opts.studentId) {
      conditions.push(eq(aacSessions.studentId, opts.studentId));
    }
    if (opts.startDate) {
      conditions.push(gte(aacSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      // End of the given day
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(aacSessions.started, end));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return await db
      .select({
        id: aacSessions.id,
        studentId: aacSessions.studentId,
        studentName: students.name,
        userId: aacSessions.userId,
        userName: users.fullName,
        creditsUsed: aacSessions.creditsUsed,
        status: aacSessions.status,
        started: aacSessions.started,
        lastActivity: aacSessions.lastActivity,
        ended: aacSessions.ended,
      })
      .from(aacSessions)
      .leftJoin(students, eq(aacSessions.studentId, students.id))
      .leftJoin(users, eq(aacSessions.userId, users.id))
      .where(where)
      .orderBy(desc(aacSessions.started))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async getSessionsAdminCount(opts: AdminSessionFilters): Promise<number> {
    const conditions = [];
    if (opts.studentId) {
      conditions.push(eq(aacSessions.studentId, opts.studentId));
    }
    if (opts.startDate) {
      conditions.push(gte(aacSessions.started, new Date(opts.startDate)));
    }
    if (opts.endDate) {
      const end = new Date(opts.endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(aacSessions.started, end));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [result] = await db
      .select({ total: count() })
      .from(aacSessions)
      .where(where);
    return result?.total ?? 0;
  }

  async getSessionConversationHistory(id: string): Promise<AACMessage[] | undefined> {
    const [result] = await db
      .select({ conversationHistory: aacSessions.conversationHistory })
      .from(aacSessions)
      .where(eq(aacSessions.id, id));
    return result?.conversationHistory ?? undefined;
  }
}

export const aacSessionRepository = new AACSessionRepository();
