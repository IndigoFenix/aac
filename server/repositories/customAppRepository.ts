import {
  customApps,
  customAppAssignments,
  instituteStudents,
  type CustomApp,
  type InsertCustomApp,
  type CustomAppAssignment,
  type InsertCustomAppAssignment,
} from "@shared/schema";
import { db } from "../db";
import { and, eq, inArray, or, isNull, desc } from "drizzle-orm";
import {
  withInstituteVisibility,
  type AccessCtx,
} from "../services/sharing/visibility";
import { recordShareDerivedView } from "../services/sharing/audit";

type CustomAppMetadata = Omit<CustomApp, "definition">;

/**
 * Custom apps (games and other AI-generated apps).
 *
 * A custom app is owned by a user, optionally scoped to an institute, and
 * assigned to zero-or-more students via customAppAssignments.
 *
 * Unlike boards, definitions are not PHI — we don't route them through
 * external-storage.
 */
export class CustomAppRepository {
  async createApp(app: InsertCustomApp): Promise<CustomApp> {
    const [row] = await db.insert(customApps).values(app).returning();
    return row;
  }

  async getApp(id: string): Promise<CustomApp | undefined> {
    const [row] = await db.select().from(customApps).where(eq(customApps.id, id));
    return row;
  }

  async updateApp(
    id: string,
    data: Partial<InsertCustomApp>,
  ): Promise<CustomApp | undefined> {
    const [row] = await db.update(customApps)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(customApps.id, id))
      .returning();
    return row;
  }

  async touchLoaded(id: string): Promise<void> {
    await db.update(customApps)
      .set({ loadedAt: new Date() })
      .where(eq(customApps.id, id));
  }

  async deleteApp(id: string): Promise<void> {
    await db.delete(customApps).where(eq(customApps.id, id));
  }

  /** All apps owned by a user, metadata only (no definition). */
  async getUserApps(userId: string): Promise<CustomAppMetadata[]> {
    return await db.select({
      id: customApps.id,
      userId: customApps.userId,
      instituteId: customApps.instituteId,
      type: customApps.type,
      name: customApps.name,
      description: customApps.description,
      imageUrl: customApps.imageUrl,
      language: customApps.language,
      isGenerated: customApps.isGenerated,
      createdAt: customApps.createdAt,
      updatedAt: customApps.updatedAt,
      loadedAt: customApps.loadedAt,
    })
      .from(customApps)
      .where(eq(customApps.userId, userId))
      .orderBy(desc(customApps.loadedAt));
  }

  /** Apps available to a student — either assigned to them directly, or authored by the user and unassigned. */
  async getStudentApps(userId: string, studentId: string): Promise<CustomAppMetadata[]> {
    const assignedIds = await db.select({ appId: customAppAssignments.appId })
      .from(customAppAssignments)
      .where(eq(customAppAssignments.studentId, studentId));
    const ids = assignedIds.map((r) => r.appId);

    const whereClause = ids.length
      ? or(
          inArray(customApps.id, ids),
          and(eq(customApps.userId, userId), isNull(customApps.instituteId)),
        )
      : and(eq(customApps.userId, userId), isNull(customApps.instituteId));

    return await db.select({
      id: customApps.id,
      userId: customApps.userId,
      instituteId: customApps.instituteId,
      type: customApps.type,
      name: customApps.name,
      description: customApps.description,
      imageUrl: customApps.imageUrl,
      language: customApps.language,
      isGenerated: customApps.isGenerated,
      createdAt: customApps.createdAt,
      updatedAt: customApps.updatedAt,
      loadedAt: customApps.loadedAt,
    })
      .from(customApps)
      .where(whereClause)
      .orderBy(desc(customApps.loadedAt));
  }

  /**
   * All apps available to this student — i.e. scoped to any institute the
   * student is actively enrolled in. Used by the AAC settings UI to show
   * a "pick which apps to assign" list.
   */
  async getAvailableAppsForStudent(studentId: string): Promise<CustomAppMetadata[]> {
    const enrollments = await db.select({ instituteId: instituteStudents.instituteId })
      .from(instituteStudents)
      .where(and(
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ));
    const instituteIds = enrollments.map((r) => r.instituteId);
    if (instituteIds.length === 0) return [];

    return await db.select({
      id: customApps.id,
      userId: customApps.userId,
      instituteId: customApps.instituteId,
      type: customApps.type,
      name: customApps.name,
      description: customApps.description,
      imageUrl: customApps.imageUrl,
      language: customApps.language,
      isGenerated: customApps.isGenerated,
      createdAt: customApps.createdAt,
      updatedAt: customApps.updatedAt,
      loadedAt: customApps.loadedAt,
    })
      .from(customApps)
      .where(inArray(customApps.instituteId, instituteIds))
      .orderBy(desc(customApps.loadedAt));
  }

  /**
   * Multiplayer apps owned by an institute — the social games a clinician can
   * attach to a call. Filtered to the multiplayer engine type(s).
   */
  async listMultiplayerAppsForInstitute(
    instituteId: string,
    multiplayerTypes: string[],
  ): Promise<CustomAppMetadata[]> {
    if (multiplayerTypes.length === 0) return [];
    return await db.select({
      id: customApps.id,
      userId: customApps.userId,
      instituteId: customApps.instituteId,
      type: customApps.type,
      name: customApps.name,
      description: customApps.description,
      imageUrl: customApps.imageUrl,
      language: customApps.language,
      isGenerated: customApps.isGenerated,
      createdAt: customApps.createdAt,
      updatedAt: customApps.updatedAt,
      loadedAt: customApps.loadedAt,
    })
      .from(customApps)
      .where(and(
        eq(customApps.instituteId, instituteId),
        inArray(customApps.type, multiplayerTypes),
      ))
      .orderBy(desc(customApps.loadedAt));
  }

  /** App ids currently assigned to the student. Pass `ctx` to filter assignments by cross-institute visibility. */
  async getAssignedAppIds(studentId: string, ctx?: AccessCtx): Promise<string[]> {
    const where = ctx
      ? and(
          eq(customAppAssignments.studentId, studentId),
          withInstituteVisibility(customAppAssignments, ctx, "custom_app_assignment"),
        )
      : eq(customAppAssignments.studentId, studentId);
    const rows = await db.select({
      id: customAppAssignments.id,
      appId: customAppAssignments.appId,
      studentId: customAppAssignments.studentId,
      instituteId: customAppAssignments.instituteId,
    })
      .from(customAppAssignments)
      .where(where);
    if (ctx) recordShareDerivedView(ctx, "custom_app_assignment", rows);
    return rows.map((r) => r.appId);
  }

  /**
   * Apps currently assigned to the student, with full metadata.
   * Used by the AAC live session to show the AI what games it can launch.
   */
  async getAssignedAppsForStudent(studentId: string, ctx?: AccessCtx): Promise<CustomAppMetadata[]> {
    const ids = await this.getAssignedAppIds(studentId, ctx);
    if (ids.length === 0) return [];
    return await db.select({
      id: customApps.id,
      userId: customApps.userId,
      instituteId: customApps.instituteId,
      type: customApps.type,
      name: customApps.name,
      description: customApps.description,
      imageUrl: customApps.imageUrl,
      language: customApps.language,
      isGenerated: customApps.isGenerated,
      createdAt: customApps.createdAt,
      updatedAt: customApps.updatedAt,
      loadedAt: customApps.loadedAt,
    })
      .from(customApps)
      .where(inArray(customApps.id, ids));
  }

  // --------------------------------------------------------------------------
  // Assignments
  // --------------------------------------------------------------------------

  async assignToStudent(input: InsertCustomAppAssignment): Promise<CustomAppAssignment> {
    const [row] = await db.insert(customAppAssignments)
      .values(input)
      .onConflictDoNothing({
        target: [customAppAssignments.appId, customAppAssignments.studentId],
      })
      .returning();
    if (row) return row;
    // Already assigned; return the existing row.
    const [existing] = await db.select()
      .from(customAppAssignments)
      .where(and(
        eq(customAppAssignments.appId, input.appId),
        eq(customAppAssignments.studentId, input.studentId),
      ));
    return existing;
  }

  async unassignFromStudent(appId: string, studentId: string): Promise<void> {
    await db.delete(customAppAssignments)
      .where(and(
        eq(customAppAssignments.appId, appId),
        eq(customAppAssignments.studentId, studentId),
      ));
  }

  async getAssignmentsForApp(appId: string): Promise<CustomAppAssignment[]> {
    return await db.select()
      .from(customAppAssignments)
      .where(eq(customAppAssignments.appId, appId));
  }
}

export const customAppRepository = new CustomAppRepository();
