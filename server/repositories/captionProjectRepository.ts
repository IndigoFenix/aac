// server/repositories/captionProjectRepository.ts
// Video Caption Studio projects — user-owned, keyed by (userId, videoHash).

import { captionProjects, users, students, institutes, type CaptionProject, type CaptionProjectSegment } from "@shared/schema";
import { db } from "../db";
import { and, eq, sql, desc, gte, lte, count } from "drizzle-orm";

export interface CaptionProjectAdminFilters {
  instituteId?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}

function adminConditions(opts: CaptionProjectAdminFilters) {
  const conditions = [] as any[];
  if (opts.instituteId) conditions.push(eq(captionProjects.instituteId, opts.instituteId));
  if (opts.startDate) conditions.push(gte(captionProjects.createdAt, new Date(opts.startDate)));
  if (opts.endDate) {
    const end = new Date(opts.endDate);
    end.setDate(end.getDate() + 1);
    conditions.push(lte(captionProjects.createdAt, end));
  }
  return conditions;
}

export interface CaptionProjectInput {
  videoName?: string | null;
  language?: string | null;
  segments: CaptionProjectSegment[];
}

export interface CaptionProjectContext {
  instituteId?: string | null;
  studentId?: string | null;
  videoName?: string | null;
  language?: string | null;
}

export class CaptionProjectRepository {
  /** The current user's project for a given video hash, if any. */
  async getByUserAndHash(userId: string, videoHash: string): Promise<CaptionProject | undefined> {
    const [row] = await db
      .select()
      .from(captionProjects)
      .where(and(eq(captionProjects.userId, userId), eq(captionProjects.videoHash, videoHash)));
    return row || undefined;
  }

  /** Create or update the user's project for a video hash (upsert on the unique key). */
  async upsert(userId: string, videoHash: string, data: CaptionProjectInput): Promise<CaptionProject> {
    const [row] = await db
      .insert(captionProjects)
      .values({
        userId,
        videoHash,
        videoName: data.videoName ?? null,
        language: data.language ?? null,
        segments: data.segments,
      })
      .onConflictDoUpdate({
        target: [captionProjects.userId, captionProjects.videoHash],
        set: {
          videoName: data.videoName ?? null,
          language: data.language ?? null,
          segments: data.segments,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /**
   * Ensure a project row exists as the cost anchor for a (user, video), WITHOUT
   * touching its segments. Used by the charging path during generation, which
   * runs before the client's first save. Refreshes association metadata
   * (institute/student/name/language) when provided.
   */
  async ensureProject(
    userId: string,
    videoHash: string,
    ctx: CaptionProjectContext = {},
  ): Promise<CaptionProject> {
    const [row] = await db
      .insert(captionProjects)
      .values({
        userId,
        videoHash,
        instituteId: ctx.instituteId ?? null,
        studentId: ctx.studentId ?? null,
        videoName: ctx.videoName ?? null,
        language: ctx.language ?? null,
        segments: [],
      })
      .onConflictDoUpdate({
        target: [captionProjects.userId, captionProjects.videoHash],
        // Only refresh association metadata that was actually supplied; never
        // clobber segments or accumulated cost.
        set: {
          ...(ctx.instituteId != null ? { instituteId: ctx.instituteId } : {}),
          ...(ctx.studentId != null ? { studentId: ctx.studentId } : {}),
          ...(ctx.videoName != null ? { videoName: ctx.videoName } : {}),
          ...(ctx.language != null ? { language: ctx.language } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /** Admin: list caption projects (with cost + owner/student/institute names). */
  async getCaptionProjectsAdmin(opts: CaptionProjectAdminFilters) {
    const conditions = adminConditions(opts);
    return db
      .select({
        id: captionProjects.id,
        videoName: captionProjects.videoName,
        language: captionProjects.language,
        creditsUsed: captionProjects.creditsUsed,
        costBreakdown: captionProjects.costBreakdown,
        segmentCount: sql<number>`jsonb_array_length(${captionProjects.segments})`,
        userId: captionProjects.userId,
        userName: users.fullName,
        studentId: captionProjects.studentId,
        studentName: students.name,
        instituteId: captionProjects.instituteId,
        instituteName: institutes.name,
        createdAt: captionProjects.createdAt,
        updatedAt: captionProjects.updatedAt,
      })
      .from(captionProjects)
      .leftJoin(users, eq(captionProjects.userId, users.id))
      .leftJoin(students, eq(captionProjects.studentId, students.id))
      .leftJoin(institutes, eq(captionProjects.instituteId, institutes.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(captionProjects.updatedAt))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async getCaptionProjectsAdminCount(opts: CaptionProjectAdminFilters): Promise<number> {
    const conditions = adminConditions(opts);
    const [row] = await db
      .select({ n: count() })
      .from(captionProjects)
      .where(conditions.length ? and(...conditions) : undefined);
    return row?.n ?? 0;
  }

  /** Atomically add cost to a project (creditsUsed + per-category breakdown). */
  async chargeToProject(id: string, category: string, credits: number): Promise<void> {
    if (!(credits > 0)) return;
    await db
      .update(captionProjects)
      .set({
        creditsUsed: sql`${captionProjects.creditsUsed} + ${credits}`,
        costBreakdown: sql`jsonb_set(
          COALESCE(${captionProjects.costBreakdown}, '{}'::jsonb),
          ARRAY[${category}],
          to_jsonb(COALESCE((${captionProjects.costBreakdown}->>${category})::double precision, 0) + ${credits}),
          true
        )`,
      })
      .where(eq(captionProjects.id, id));
  }
}

export const captionProjectRepository = new CaptionProjectRepository();
