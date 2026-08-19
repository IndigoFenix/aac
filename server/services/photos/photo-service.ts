// server/services/photos/photo-service.ts
//
// Orchestration for the family-photo library: render -> dedup -> S3 -> assign.
// See planning-docs/aac-photos-plan.md.
//
// SECURITY — like photoRepository, this makes NO access-control decision. Every
// caller must have authorized the scope first.

import { v4 as uuidv4 } from "uuid";
import { photoRepository, type LibraryPhoto } from "../../repositories/photoRepository";
import { s3Service } from "../storage/s3-service";
import { photoS3Keys, renderPhoto, PHOTO_MIME_TYPE } from "./photo-renders";
import { capForScope, planIngestBatch, type PhotoScope } from "./photo-caps";
import type { Photo, PhotoAssignment } from "@shared/schema";

/** Thrown when a scope is already at its cap. Maps to `error:PHOTO_CAP_REACHED`. */
export class PhotoCapReachedError extends Error {
  constructor(public readonly cap: number) {
    super(`Photo cap reached (${cap})`);
    this.name = "PhotoCapReachedError";
  }
}

export interface IngestOptions {
  caption?: string | null;
  createdByUserId?: string | null;
  source?: string;
  sourceMediaItemId?: string | null;
}

export interface IngestResult {
  photo: Photo;
  assignment: PhotoAssignment;
  /** False when this exact image was already in this scope — the call was a no-op. */
  created: boolean;
  /** True when the bytes were already stored under another assignment. */
  deduped: boolean;
}

export const photoService = {
  /**
   * Ingest one image into one scope.
   *
   * Order matters: render (which validates the image) before touching the
   * database, and upload bytes before inserting the row, so a failure anywhere
   * leaves at worst an unreferenced S3 object for the sweeper rather than a row
   * pointing at bytes that do not exist.
   */
  async ingestPhoto(
    original: Buffer,
    scope: PhotoScope,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    // Throws on an undecodable buffer, before any row or object is created.
    const renders = await renderPhoto(original);

    const existing = await photoRepository.getPhotoByContentHash(renders.contentHash);
    let photo: Photo;
    let deduped = false;

    if (existing) {
      // Same bytes already stored — reuse them. This is why caps count
      // assignments: the second copy costs no storage but still occupies a slot.
      photo = existing;
      deduped = true;
    } else {
      // The id is generated up-front because the S3 keys embed it (same pattern
      // as custom-symbol-service).
      const id = uuidv4();
      const keys = photoS3Keys(id);
      await Promise.all([
        s3Service.upload(keys.display, renders.display.buffer, PHOTO_MIME_TYPE),
        s3Service.upload(keys.thumb, renders.thumb.buffer, PHOTO_MIME_TYPE),
      ]);

      photo = await photoRepository.createOrGetPhoto({
        id,
        contentHash: renders.contentHash,
        s3Key: keys.display,
        thumbS3Key: keys.thumb,
        mimeType: PHOTO_MIME_TYPE,
        width: renders.display.width,
        height: renders.display.height,
        byteSize: renders.display.byteSize,
        source: options.source ?? "upload",
        sourceMediaItemId: options.sourceMediaItemId ?? null,
        takenAt: renders.takenAt,
        createdByUserId: options.createdByUserId ?? null,
      });

      if (photo.id !== id) {
        // Another request won the race to this content hash while we were
        // uploading. Our objects are now unreferenced — drop them rather than
        // leaving litter the sweeper would never find (no row points at them).
        deduped = true;
        await Promise.allSettled([
          s3Service.delete(keys.display),
          s3Service.delete(keys.thumb),
        ]);
      }
    }

    const result = await photoRepository.createAssignmentWithinCap(
      scope,
      { photoId: photo.id, caption: options.caption ?? null },
      capForScope(scope),
    );
    if (!result) throw new PhotoCapReachedError(capForScope(scope));

    return { photo, assignment: result.assignment, created: result.created, deduped };
  },

  /**
   * Ingest several images, importing what fits and reporting what did not.
   *
   * Partial acceptance is deliberate (see photo-caps): a caretaker who selects
   * 40 photos with 25 slots free gets 25 and a clear message, rather than a
   * blanket rejection that makes them count by hand.
   */
  async ingestBatch(
    originals: readonly Buffer[],
    scope: PhotoScope,
    options: IngestOptions = {},
  ): Promise<{ ingested: IngestResult[]; skippedForCap: number; failed: number }> {
    const cap = capForScope(scope);
    const current = await photoRepository.countAssignments(scope);
    const plan = planIngestBatch(originals, current, cap);
    if (plan.atCap) throw new PhotoCapReachedError(cap);

    const ingested: IngestResult[] = [];
    let failed = 0;
    // Sequential on purpose: each ingest takes the scope's advisory lock, so
    // running them in parallel would just queue on that lock while holding
    // several decoded bitmaps in memory at once.
    for (const buffer of plan.accepted) {
      try {
        ingested.push(await this.ingestPhoto(buffer, scope, options));
      } catch (error) {
        if (error instanceof PhotoCapReachedError) break;
        console.error("[photos] ingest failed for one item:", error);
        failed++;
      }
    }

    return { ingested, skippedForCap: plan.rejected.length, failed };
  },

  /**
   * A short-lived direct URL for one render. Callers authorize first — the URL
   * is itself the capability.
   */
  async getViewUrl(photoId: string, render: "display" | "thumb" = "display"): Promise<string | null> {
    const photo = await photoRepository.getPhoto(photoId);
    if (!photo) return null;
    return s3Service.presignGet(render === "thumb" ? photo.thumbS3Key : photo.s3Key);
  },

  async listLibrary(scope: PhotoScope): Promise<LibraryPhoto[]> {
    return photoRepository.listScope(scope);
  },

  /**
   * Remove one photo from one scope. The ASSET survives — another scope may
   * share it, and the sweeper collects it once nothing points at it.
   */
  async removeFromScope(assignmentId: string): Promise<boolean> {
    return photoRepository.deleteAssignment(assignmentId);
  },

  /**
   * Delete assets nothing references, bytes included.
   *
   * Run on a schedule, not inline on assignment delete: dedup means an asset can
   * be shared, and a concurrent reader may be holding a presigned URL for bytes
   * whose last assignment just went away. Returns how many were collected.
   */
  async sweepOrphans(limit = 200): Promise<number> {
    const orphans = await photoRepository.findOrphanedPhotos(limit);
    if (orphans.length === 0) return 0;

    for (const photo of orphans) {
      // Objects first: a row without bytes is a broken photo, whereas bytes
      // without a row are merely cost the next sweep can still find.
      await Promise.allSettled([
        s3Service.delete(photo.s3Key),
        s3Service.delete(photo.thumbS3Key),
      ]);
    }
    return photoRepository.deletePhotos(orphans.map((p) => p.id));
  },

  /**
   * Erasure hook — drop every photo assignment belonging to a student.
   *
   * Assets are left to the sweeper, which deletes the bytes once no other scope
   * references them. Combined with the noncurrent-version lifecycle rule added
   * in Phase 0, that is what makes the deletion real: before that rule existed,
   * removing an object from a versioned bucket left the old version billed and
   * retrievable indefinitely.
   */
  async eraseStudentPhotos(studentId: string): Promise<number> {
    const removed = await photoRepository.deleteAssignmentsForStudent(studentId);
    if (removed > 0) await this.sweepOrphans();
    return removed;
  },
};
