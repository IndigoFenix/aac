// server/controllers/photoController.ts
//
// The clinician-facing Photo Manager API — see planning-docs/aac-photos-plan.md §5.
//
// SECURITY — this controller is the authorization boundary for the whole photo
// feature. `photoService` and `photoRepository` below it make NO access-control
// decision (they query by studentId/instituteId directly), so every path here
// MUST resolve the caller's rights before touching them.
//
// It deliberately does NOT follow customSymbolController, which reads
// `/api/custom-symbols/student/:studentId` for any authenticated caller with no
// access check at all. That is tolerable-ish for vocabulary artwork and is not
// tolerable for a family's photographs of their child: every scope-touching
// route here goes through studentService.verifyStudentAccess or an institute
// membership/admin check. See plan L6.
//
// Scope rights, in one place:
//   student   — read + write require verifyStudentAccess
//   institute — read requires membership; WRITE requires isAdmin, because an
//               institute photo appears on every student's board in the org
//               and is not one clinician's call.

import type { Request, Response } from "express";
import { studentService } from "../services/studentService";
import { instituteRepository } from "../repositories/instituteRepository";
import { photoRepository } from "../repositories/photoRepository";
import { photoService, PhotoCapReachedError } from "../services/photos/photo-service";
import { capForScope, type PhotoScope } from "../services/photos/photo-caps";
import { s3Service } from "../services/storage/s3-service";
import { activityLogService } from "../services/activityLogService";
import type { activitySubjectTypeEnum } from "@shared/schema";

/** How long a presigned photo URL lives. Short because the URL IS the
 *  capability — anyone holding it can read the object until it expires. The
 *  client refetches the list well inside this window. */
const PRESIGN_TTL_SECONDS = 900; // 15 minutes

/** Cap on how many files one request may carry. The per-scope cap is 100, but a
 *  single multipart request that large would blow the Lambda's time and memory
 *  budget, so the panel uploads in chunks. */
export const MAX_PHOTOS_PER_REQUEST = 20;

function currentUserId(req: Request): string | undefined {
  return (req as any).user?.id;
}

type ScopeResolution =
  | { ok: true; scope: PhotoScope; canWrite: boolean }
  | { ok: false; status: number; code: string };

/**
 * Resolve and authorize the scope named in the request.
 *
 * Returns `canWrite` separately from access so read-only callers (a clinician
 * viewing the institute library they are not an admin of) get a 200 on GET and a
 * 403 on mutation, rather than being hidden from the library entirely.
 */
async function resolveScope(req: Request): Promise<ScopeResolution> {
  const userId = currentUserId(req);
  if (!userId) return { ok: false, status: 401, code: "UNAUTHORIZED" };

  const studentId = (req.params.studentId || req.body?.studentId) as string | undefined;
  const instituteId = (req.params.instituteId || req.body?.instituteId) as string | undefined;

  if (studentId && instituteId) {
    // Mirrors the DB CHECK: exactly one scope, never both.
    return { ok: false, status: 400, code: "SCOPE_AMBIGUOUS" };
  }

  if (studentId) {
    const { hasAccess } = await studentService.verifyStudentAccess(studentId, userId);
    if (!hasAccess) return { ok: false, status: 403, code: "STUDENT_ACCESS_DENIED" };
    return { ok: true, scope: { kind: "student", studentId }, canWrite: true };
  }

  if (instituteId) {
    const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
    if (!isMember) return { ok: false, status: 403, code: "INSTITUTE_ACCESS_DENIED" };
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(instituteId, userId);
    return { ok: true, scope: { kind: "institute", instituteId }, canWrite: isAdmin };
  }

  return { ok: false, status: 400, code: "SCOPE_REQUIRED" };
}

/** Authorize by way of the assignment's own scope, for assignment-id routes. */
async function resolveScopeForAssignment(
  req: Request,
  assignmentId: string,
): Promise<ScopeResolution & { assignment?: any }> {
  const userId = currentUserId(req);
  if (!userId) return { ok: false, status: 401, code: "UNAUTHORIZED" };

  const assignment = await photoRepository.getAssignment(assignmentId);
  if (!assignment) return { ok: false, status: 404, code: "PHOTO_NOT_FOUND" };

  if (assignment.studentId) {
    const { hasAccess } = await studentService.verifyStudentAccess(assignment.studentId, userId);
    if (!hasAccess) return { ok: false, status: 403, code: "STUDENT_ACCESS_DENIED" };
    return {
      ok: true,
      scope: { kind: "student", studentId: assignment.studentId },
      canWrite: true,
      assignment,
    };
  }

  if (assignment.instituteId) {
    const isMember = await instituteRepository.isUserMemberOfInstitute(assignment.instituteId, userId);
    if (!isMember) return { ok: false, status: 403, code: "INSTITUTE_ACCESS_DENIED" };
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(assignment.instituteId, userId);
    return {
      ok: true,
      scope: { kind: "institute", instituteId: assignment.instituteId },
      canWrite: isAdmin,
      assignment,
    };
  }

  // Unreachable while the CHECK constraint holds.
  return { ok: false, status: 500, code: "SCOPE_MALFORMED" };
}

type ActivitySubjectType = (typeof activitySubjectTypeEnum)["enumValues"][number];

function scopeSubject(scope: PhotoScope): { type: ActivitySubjectType; id: string } {
  return scope.kind === "student"
    ? { type: "student", id: scope.studentId }
    : { type: "institute", id: scope.instituteId };
}

class PhotoController {
  /**
   * GET /api/photos/student/:studentId
   * GET /api/photos/institute/:instituteId
   *
   * The library plus its cap state. Thumb and display URLs are presigned INLINE
   * rather than fetched one-by-one: presigning is a local HMAC (no network), so
   * one round trip beats a hundred, and the bytes still come straight from S3
   * instead of through this process.
   */
  async listScope(req: Request, res: Response) {
    try {
      const resolved = await resolveScope(req);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.code });

      const rows = await photoRepository.listScope(resolved.scope);
      const photos = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          thumbUrl: await s3Service.presignGet(row.thumbS3Key, PRESIGN_TTL_SECONDS),
          displayUrl: await s3Service.presignGet(row.s3Key, PRESIGN_TTL_SECONDS),
        })),
      );

      res.json({
        photos,
        count: rows.length,
        cap: capForScope(resolved.scope),
        canWrite: resolved.canWrite,
        // So the client can refetch before the URLs go stale.
        urlTtlSeconds: PRESIGN_TTL_SECONDS,
      });
    } catch (error: any) {
      console.error("[PhotoController] listScope error:", error);
      res.status(500).json({ error: "PHOTO_LIST_FAILED" });
    }
  }

  /**
   * POST /api/photos/student/:studentId
   * POST /api/photos/institute/:instituteId
   * Multipart, field name `photos` (repeatable).
   *
   * Partial success is a NORMAL outcome, not an error: a caretaker selecting 40
   * photos with 25 slots free gets 25 imported plus a clear count of what did
   * not fit. Only a scope that is already full is a 409.
   */
  async upload(req: Request, res: Response) {
    try {
      const resolved = await resolveScope(req);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.code });
      if (!resolved.canWrite) return res.status(403).json({ error: "PHOTO_WRITE_FORBIDDEN" });

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) return res.status(400).json({ error: "NO_PHOTOS" });

      const captions: string[] = Array.isArray(req.body?.captions)
        ? req.body.captions
        : req.body?.captions
          ? [req.body.captions]
          : [];

      const results = [];
      let skippedForCap = 0;
      let failed = 0;

      for (let i = 0; i < files.length; i++) {
        try {
          results.push(
            await photoService.ingestPhoto(files[i].buffer, resolved.scope, {
              caption: captions[i]?.trim() || null,
              createdByUserId: currentUserId(req) ?? null,
              source: "upload",
            }),
          );
        } catch (error) {
          if (error instanceof PhotoCapReachedError) {
            // Everything from here on has nowhere to go.
            skippedForCap = files.length - i;
            break;
          }
          // One undecodable file must not fail the other 19.
          console.error("[PhotoController] ingest failed for one file:", error);
          failed++;
        }
      }

      if (results.length === 0 && skippedForCap > 0) {
        return res.status(409).json({
          error: "PHOTO_CAP_REACHED",
          cap: capForScope(resolved.scope),
        });
      }

      const subject = scopeSubject(resolved.scope);
      for (const result of results) {
        activityLogService.log({
          userId: currentUserId(req),
          eventType: "create",
          subjectType1: "photo",
          subjectId1: result.photo.id,
          subjectType2: subject.type,
          subjectId2: subject.id,
          details: { deduped: result.deduped, source: "upload" },
        });
      }

      res.status(201).json({
        added: results.length,
        deduped: results.filter((r) => r.deduped).length,
        alreadyPresent: results.filter((r) => !r.created).length,
        skippedForCap,
        failed,
        count: await photoRepository.countAssignments(resolved.scope),
        cap: capForScope(resolved.scope),
      });
    } catch (error: any) {
      console.error("[PhotoController] upload error:", error);
      res.status(500).json({ error: "PHOTO_UPLOAD_FAILED" });
    }
  }

  /**
   * PATCH /api/photos/assignments/:assignmentId
   * Caption, and whether the student sees it. Hiding is deliberately reversible —
   * a bereavement or a relative out of the picture should not force a delete.
   */
  async updateAssignment(req: Request, res: Response) {
    try {
      const { assignmentId } = req.params;
      const resolved = await resolveScopeForAssignment(req, assignmentId);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.code });
      if (!resolved.canWrite) return res.status(403).json({ error: "PHOTO_WRITE_FORBIDDEN" });

      const patch: Record<string, unknown> = {};
      if (typeof req.body?.caption === "string" || req.body?.caption === null) {
        const trimmed = typeof req.body.caption === "string" ? req.body.caption.trim() : null;
        patch.caption = trimmed || null;
      }
      if (typeof req.body?.hiddenFromStudent === "boolean") {
        patch.hiddenFromStudent = req.body.hiddenFromStudent;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "NOTHING_TO_UPDATE" });
      }

      const updated = await photoRepository.updateAssignment(assignmentId, patch as any);
      if (!updated) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });

      const subject = scopeSubject(resolved.scope);
      activityLogService.log({
        userId: currentUserId(req),
        eventType: "update",
        subjectType1: "photo",
        subjectId1: updated.photoId,
        subjectType2: subject.type,
        subjectId2: subject.id,
        // Field NAMES only. A caption can carry a family member's name, which
        // does not belong in the log body (values are deny-by-default).
        details: { fields: Object.keys(patch) },
      });

      res.json(updated);
    } catch (error: any) {
      console.error("[PhotoController] updateAssignment error:", error);
      res.status(500).json({ error: "PHOTO_UPDATE_FAILED" });
    }
  }

  /**
   * DELETE /api/photos/assignments/:assignmentId
   * Removes the photo from THIS scope. The underlying asset survives if another
   * scope shares it; the sweeper collects it otherwise.
   */
  async deleteAssignment(req: Request, res: Response) {
    try {
      const { assignmentId } = req.params;
      const resolved = await resolveScopeForAssignment(req, assignmentId);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.code });
      if (!resolved.canWrite) return res.status(403).json({ error: "PHOTO_WRITE_FORBIDDEN" });

      const photoId = resolved.assignment?.photoId;
      const removed = await photoService.removeFromScope(assignmentId);
      if (!removed) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });

      const subject = scopeSubject(resolved.scope);
      activityLogService.log({
        userId: currentUserId(req),
        eventType: "delete",
        subjectType1: "photo",
        subjectId1: photoId,
        subjectType2: subject.type,
        subjectId2: subject.id,
      });

      res.json({ removed: true, count: await photoRepository.countAssignments(resolved.scope) });
    } catch (error: any) {
      console.error("[PhotoController] deleteAssignment error:", error);
      res.status(500).json({ error: "PHOTO_DELETE_FAILED" });
    }
  }

  /**
   * GET /api/aac/photos?studentId=X
   *
   * The STUDENT-facing library, for the AAC device: their own photos plus their
   * institutes', hidden ones already filtered out server-side.
   *
   * ⚠️ AUTH — this follows the established AAC device pattern (`optionalAuth`
   * plus a studentId), the same one `/api/aac/spotify/token` and the other
   * device endpoints use: the AAC is a kiosk provisioned for one student and
   * does not reliably carry a user session (see the iPad WS-cookie gap). When a
   * user IS authenticated the full access check runs, so a clinician cannot use
   * this route to read a student they have no rights to.
   *
   * What that leaves: an unauthenticated caller who KNOWS a studentId can obtain
   * presigned URLs for that student's photos. That is the same exposure every
   * other AAC endpoint already carries, but the payload here is family
   * photographs rather than a track id, so it is called out in the plan as an
   * open item rather than quietly inherited. Do not widen this route further
   * (no institute-wide listing, no id enumeration) while it stands.
   */
  async listForStudent(req: Request, res: Response) {
    try {
      const studentId = (req.query.studentId as string | undefined)?.trim();
      if (!studentId) return res.status(400).json({ error: "STUDENT_ID_REQUIRED" });

      // A logged-in caller is held to the normal standard; a device session
      // (no user) falls back to the platform's AAC pattern.
      const userId = currentUserId(req);
      if (userId) {
        const { hasAccess } = await studentService.verifyStudentAccess(studentId, userId);
        if (!hasAccess) return res.status(403).json({ error: "STUDENT_ACCESS_DENIED" });
      }

      const enrollments = await instituteRepository.getInstitutesByStudentId(studentId);
      const instituteIds = enrollments
        .map((e: any) => e.institute?.id)
        .filter((id: string | undefined): id is string => !!id);

      const rows = await photoRepository.listForStudentView(studentId, instituteIds);
      const photos = await Promise.all(
        rows.map(async (row) => ({
          photoId: row.photoId,
          caption: row.caption,
          aiDescription: row.aiDescription,
          width: row.width,
          height: row.height,
          scope: row.scope,
          thumbUrl: await s3Service.presignGet(row.thumbS3Key, PRESIGN_TTL_SECONDS),
          displayUrl: await s3Service.presignGet(row.s3Key, PRESIGN_TTL_SECONDS),
        })),
      );

      res.json({ photos, urlTtlSeconds: PRESIGN_TTL_SECONDS });
    } catch (error: any) {
      console.error("[PhotoController] listForStudent error:", error);
      res.status(500).json({ error: "PHOTO_LIST_FAILED" });
    }
  }

  /**
   * POST /api/photos/reorder
   * Body: { studentId | instituteId, orderedAssignmentIds: string[] }
   *
   * The whole ordered list, applied in one transaction — ids outside the scope
   * are ignored server-side, so the ordering payload cannot reach another
   * student's library.
   */
  async reorder(req: Request, res: Response) {
    try {
      const resolved = await resolveScope(req);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.code });
      if (!resolved.canWrite) return res.status(403).json({ error: "PHOTO_WRITE_FORBIDDEN" });

      const ids = req.body?.orderedAssignmentIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        return res.status(400).json({ error: "INVALID_BODY" });
      }

      const updated = await photoRepository.reorderAssignments(resolved.scope, ids);
      res.json({ updated });
    } catch (error: any) {
      console.error("[PhotoController] reorder error:", error);
      res.status(500).json({ error: "PHOTO_REORDER_FAILED" });
    }
  }
}

export const photoController = new PhotoController();
