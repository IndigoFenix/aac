import { db } from "../db";
import { eq, and, gte, lte, sql, desc, count } from "drizzle-orm";
import {
  activityLogs,
  users,
  institutes,
  type ActivityEventType,
  type ActivitySubjectType,
  type ActivityLog,
} from "@shared/schema";

export interface ActivityLogEntry {
  instituteId?: string | null;
  userId?: string | null;
  eventType: ActivityEventType;
  subjectType1: ActivitySubjectType;
  subjectId1?: string | null;
  subjectType2?: ActivitySubjectType | null;
  subjectId2?: string | null;
  details?: Record<string, unknown> | null;
  isAiInitiated?: boolean;
}

export interface ActivityLogFilters {
  instituteId?: string;
  userId?: string;
  eventType?: ActivityEventType;
  subjectType?: ActivitySubjectType;
  startDate?: string;
  endDate?: string;
  isAiInitiated?: boolean;
  limit: number;
  offset: number;
}

export interface ActivityLogRow extends ActivityLog {
  userName?: string | null;
  userEmail?: string | null;
  instituteName?: string | null;
}

class ActivityLogService {
  /**
   * Fire-and-forget activity log insert.
   * Never throws — errors go to stderr.
   */
  log(entry: ActivityLogEntry): void {
    db.insert(activityLogs)
      .values({
        instituteId: entry.instituteId ?? null,
        userId: entry.userId ?? null,
        eventType: entry.eventType,
        subjectType1: entry.subjectType1,
        subjectId1: entry.subjectId1 ?? null,
        subjectType2: entry.subjectType2 ?? null,
        subjectId2: entry.subjectId2 ?? null,
        details: entry.details ?? null,
        isAiInitiated: entry.isAiInitiated ?? false,
      })
      .execute()
      .catch((err) => {
        console.error("[ActivityLog] Failed to write log:", err);
      });
  }

  async query(filters: ActivityLogFilters): Promise<{ data: ActivityLogRow[]; total: number }> {
    const conditions = [];

    if (filters.instituteId) {
      conditions.push(eq(activityLogs.instituteId, filters.instituteId));
    }
    if (filters.userId) {
      conditions.push(eq(activityLogs.userId, filters.userId));
    }
    if (filters.eventType) {
      conditions.push(eq(activityLogs.eventType, filters.eventType));
    }
    if (filters.subjectType) {
      conditions.push(eq(activityLogs.subjectType1, filters.subjectType));
    }
    if (filters.startDate) {
      conditions.push(gte(activityLogs.createdAt, new Date(filters.startDate)));
    }
    if (filters.endDate) {
      conditions.push(lte(activityLogs.createdAt, new Date(filters.endDate)));
    }
    if (filters.isAiInitiated !== undefined) {
      conditions.push(eq(activityLogs.isAiInitiated, filters.isAiInitiated));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(activityLogs)
        .where(where),
      db
        .select({
          id: activityLogs.id,
          instituteId: activityLogs.instituteId,
          userId: activityLogs.userId,
          eventType: activityLogs.eventType,
          subjectType1: activityLogs.subjectType1,
          subjectId1: activityLogs.subjectId1,
          subjectType2: activityLogs.subjectType2,
          subjectId2: activityLogs.subjectId2,
          details: activityLogs.details,
          isAiInitiated: activityLogs.isAiInitiated,
          createdAt: activityLogs.createdAt,
          userName: users.fullName,
          userEmail: users.email,
          instituteName: institutes.name,
        })
        .from(activityLogs)
        .leftJoin(users, eq(activityLogs.userId, users.id))
        .leftJoin(institutes, eq(activityLogs.instituteId, institutes.id))
        .where(where)
        .orderBy(desc(activityLogs.createdAt))
        .limit(filters.limit)
        .offset(filters.offset),
    ]);

    return {
      data: rows as ActivityLogRow[],
      total: Number(totalResult[0]?.count ?? 0),
    };
  }
}

export const activityLogService = new ActivityLogService();
