// server/repositories/photoRepository.ts
//
// Data layer for the family-photo library — see planning-docs/aac-photos-plan.md.
//
// SECURITY — this is a server-internal DATA LAYER, not an authorization
// boundary. It queries by studentId/instituteId directly, and this codebase has
// a known hazard where direct table queries bypass support-mode restrictions.
// Every caller MUST have already authorized access to the scope before calling
// in here. Mirrors the contract on externalConnectionsService.

import {
  photos,
  photoAssignments,
  type Photo,
  type InsertPhoto,
  type PhotoAssignment,
  type InsertPhotoAssignment,
} from "@shared/schema";
import { db } from "../db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PhotoScope } from "../services/photos/photo-caps";

/** An assignment joined to the asset it points at — what every library view needs. */
export interface LibraryPhoto {
  assignmentId: string;
  photoId: string;
  caption: string | null;
  sortOrder: number;
  hiddenFromStudent: boolean;
  s3Key: string;
  thumbS3Key: string;
  width: number | null;
  height: number | null;
  aiDescription: string | null;
  takenAt: Date | null;
  scope: "student" | "institute";
}

/** Drizzle predicate selecting one scope's assignments. */
function scopeWhere(scope: PhotoScope) {
  return scope.kind === "student"
    ? eq(photoAssignments.studentId, scope.studentId)
    : eq(photoAssignments.instituteId, scope.instituteId);
}

class PhotoRepository {
  // ==================== Assets ====================

  /**
   * Find an existing asset by its content hash. The dedup path: a re-imported
   * photo reuses this row instead of writing a second copy to S3.
   */
  async getPhotoByContentHash(contentHash: string): Promise<Photo | undefined> {
    const [row] = await db.select().from(photos).where(eq(photos.contentHash, contentHash));
    return row;
  }

  async getPhoto(id: string): Promise<Photo | undefined> {
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    return row;
  }

  async createPhoto(data: InsertPhoto): Promise<Photo> {
    const [row] = await db.insert(photos).values(data).returning();
    return row;
  }

  /**
   * Insert, or return the existing row when another request won the race to the
   * same content hash. Concurrent uploads of the same image are ordinary (a
   * caretaker double-clicking, two devices importing the same album), so the
   * unique index is the arbiter rather than a pre-check.
   */
  async createOrGetPhoto(data: InsertPhoto): Promise<Photo> {
    const [row] = await db
      .insert(photos)
      .values(data)
      .onConflictDoNothing({ target: photos.contentHash })
      .returning();
    if (row) return row;
    const existing = await this.getPhotoByContentHash(data.contentHash);
    if (!existing) throw new Error("Photo insert conflicted but no existing row found");
    return existing;
  }

  // ==================== Assignments ====================

  /** How many photos a scope currently holds. This is the number caps apply to. */
  async countAssignments(scope: PhotoScope): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(photoAssignments)
      .where(scopeWhere(scope));
    return row?.count ?? 0;
  }

  async createAssignment(data: InsertPhotoAssignment): Promise<PhotoAssignment> {
    const [row] = await db.insert(photoAssignments).values(data).returning();
    return row;
  }

  async getAssignment(id: string): Promise<PhotoAssignment | undefined> {
    const [row] = await db.select().from(photoAssignments).where(eq(photoAssignments.id, id));
    return row;
  }

  async updateAssignment(
    id: string,
    patch: Partial<Pick<PhotoAssignment, "caption" | "sortOrder" | "hiddenFromStudent">>,
  ): Promise<PhotoAssignment | undefined> {
    const [row] = await db
      .update(photoAssignments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(photoAssignments.id, id))
      .returning();
    return row;
  }

  async deleteAssignment(id: string): Promise<boolean> {
    const deleted = await db
      .delete(photoAssignments)
      .where(eq(photoAssignments.id, id))
      .returning();
    return deleted.length > 0;
  }

  /** One scope's library, in display order. */
  async listScope(scope: PhotoScope): Promise<LibraryPhoto[]> {
    const rows = await db
      .select({
        assignmentId: photoAssignments.id,
        photoId: photos.id,
        caption: photoAssignments.caption,
        sortOrder: photoAssignments.sortOrder,
        hiddenFromStudent: photoAssignments.hiddenFromStudent,
        s3Key: photos.s3Key,
        thumbS3Key: photos.thumbS3Key,
        width: photos.width,
        height: photos.height,
        aiDescription: photos.aiDescription,
        takenAt: photos.takenAt,
      })
      .from(photoAssignments)
      .innerJoin(photos, eq(photoAssignments.photoId, photos.id))
      .where(scopeWhere(scope))
      .orderBy(asc(photoAssignments.sortOrder), asc(photoAssignments.createdAt));

    return rows.map((r) => ({ ...r, scope: scope.kind }));
  }

  /** Assignment ids in a scope — used by erasure to sweep without loading joins. */
  async listAssignmentIdsForStudent(studentId: string): Promise<string[]> {
    const rows = await db
      .select({ id: photoAssignments.id })
      .from(photoAssignments)
      .where(eq(photoAssignments.studentId, studentId));
    return rows.map((r) => r.id);
  }

  async deleteAssignmentsForStudent(studentId: string): Promise<number> {
    const deleted = await db
      .delete(photoAssignments)
      .where(eq(photoAssignments.studentId, studentId))
      .returning({ id: photoAssignments.id });
    return deleted.length;
  }

  /**
   * Insert an assignment only if the scope is under its cap, atomically.
   *
   * A plain count-then-insert races: two uploads landing together both read 99
   * and both insert, and the library quietly holds 101. The cap is a promise to
   * the caretaker ("47 / 100"), so it is enforced with a transaction plus a
   * per-scope advisory lock, which serializes writers to ONE scope without
   * blocking any other student or institute.
   *
   * Returns `null` when the scope is full — the caller turns that into
   * `error:PHOTO_CAP_REACHED`. An existing (photo, scope) pairing is returned
   * as-is rather than duplicated or rejected, so a re-import is idempotent and
   * does not burn a slot.
   */
  async createAssignmentWithinCap(
    scope: PhotoScope,
    data: Omit<InsertPhotoAssignment, "studentId" | "instituteId">,
    cap: number,
  ): Promise<{ assignment: PhotoAssignment; created: boolean } | null> {
    const lockKey = scope.kind === "student" ? `photos:student:${scope.studentId}` : `photos:institute:${scope.instituteId}`;

    return db.transaction(async (tx) => {
      // Held until the transaction ends; other writers to the SAME scope wait,
      // writers to any other scope proceed untouched.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const scopeCol =
        scope.kind === "student"
          ? eq(photoAssignments.studentId, scope.studentId)
          : eq(photoAssignments.instituteId, scope.instituteId);

      // Already assigned? Idempotent — costs no slot.
      const [existing] = await tx
        .select()
        .from(photoAssignments)
        .where(and(scopeCol, eq(photoAssignments.photoId, data.photoId)));
      if (existing) return { assignment: existing, created: false };

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(photoAssignments)
        .where(scopeCol);
      if ((count ?? 0) >= cap) return null;

      const [assignment] = await tx
        .insert(photoAssignments)
        .values({
          ...data,
          studentId: scope.kind === "student" ? scope.studentId : null,
          instituteId: scope.kind === "institute" ? scope.instituteId : null,
        })
        .returning();
      return { assignment, created: true };
    });
  }

  /**
   * Apply an explicit display order to a scope's assignments.
   *
   * Takes the whole ordered id list rather than a pair of moved items because
   * drag-and-drop reorders are naturally expressed that way, and a single
   * transaction avoids a half-applied order being visible to the AAC mid-write.
   * Ids not belonging to `scope` are ignored, so a hostile payload cannot
   * reorder another student's library.
   */
  async reorderAssignments(scope: PhotoScope, orderedIds: string[]): Promise<number> {
    if (orderedIds.length === 0) return 0;
    const scopeCol =
      scope.kind === "student"
        ? eq(photoAssignments.studentId, scope.studentId)
        : eq(photoAssignments.instituteId, scope.instituteId);

    return db.transaction(async (tx) => {
      let updated = 0;
      for (let i = 0; i < orderedIds.length; i++) {
        const rows = await tx
          .update(photoAssignments)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(and(eq(photoAssignments.id, orderedIds[i]), scopeCol))
          .returning({ id: photoAssignments.id });
        updated += rows.length;
      }
      return updated;
    });
  }

  /**
   * What the STUDENT sees on their device: their own library unioned with the
   * libraries of every institute they are enrolled in, hidden photos removed.
   *
   * Hidden photos are filtered HERE rather than in the client so a retired photo
   * (a bereavement, a relative no longer in the picture) never reaches the
   * device at all — not even as a presigned URL a cache could hold onto.
   *
   * Student-scoped photos sort first: a child's own family album is more
   * personal to them than the institute's shared set.
   */
  async listForStudentView(
    studentId: string,
    instituteIds: string[],
  ): Promise<LibraryPhoto[]> {
    const scopePredicate = instituteIds.length
      ? or(
          eq(photoAssignments.studentId, studentId),
          inArray(photoAssignments.instituteId, instituteIds),
        )
      : eq(photoAssignments.studentId, studentId);

    const rows = await db
      .select({
        assignmentId: photoAssignments.id,
        photoId: photos.id,
        caption: photoAssignments.caption,
        sortOrder: photoAssignments.sortOrder,
        hiddenFromStudent: photoAssignments.hiddenFromStudent,
        studentId: photoAssignments.studentId,
        s3Key: photos.s3Key,
        thumbS3Key: photos.thumbS3Key,
        width: photos.width,
        height: photos.height,
        aiDescription: photos.aiDescription,
        takenAt: photos.takenAt,
      })
      .from(photoAssignments)
      .innerJoin(photos, eq(photoAssignments.photoId, photos.id))
      .where(and(scopePredicate, eq(photoAssignments.hiddenFromStudent, false)))
      .orderBy(asc(photoAssignments.sortOrder), asc(photoAssignments.createdAt));

    return rows
      .map(({ studentId: rowStudentId, ...rest }) => ({
        ...rest,
        scope: (rowStudentId ? "student" : "institute") as "student" | "institute",
      }))
      .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "student" ? -1 : 1));
  }

  // ==================== Orphan sweep ====================

  /**
   * Assets no assignment points at any more.
   *
   * Deletion is a SWEEP rather than an inline cascade because dedup means an
   * asset can be shared: removing the last assignment must not yank bytes out
   * from under a concurrent reader holding a presigned URL. Bounded so one pass
   * cannot stall on a large backlog.
   */
  async findOrphanedPhotos(limit = 200): Promise<Photo[]> {
    return db
      .select()
      .from(photos)
      .leftJoin(photoAssignments, eq(photoAssignments.photoId, photos.id))
      .where(isNull(photoAssignments.id))
      .limit(limit)
      .then((rows) => rows.map((r: any) => r.photos));
  }

  async deletePhotos(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const deleted = await db
      .delete(photos)
      .where(inArray(photos.id, ids))
      .returning({ id: photos.id });
    return deleted.length;
  }
}

export const photoRepository = new PhotoRepository();
export { PhotoRepository };
