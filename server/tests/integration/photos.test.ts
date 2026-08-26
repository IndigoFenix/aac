/**
 * Family-photo library against a real database.
 *
 * What these pin, in rough order of how much damage the bug would do:
 *
 *  • ERASURE IS REAL. A hard-deleted student leaves no assignment and no asset
 *    that only they referenced, and the S3 keys for those assets reach
 *    s3Service.delete. A photo of someone's child surviving an erasure is the
 *    worst failure this feature has.
 *  • A SHARED ASSET SURVIVES ITS LAST STUDENT. Dedup means one image can back
 *    several scopes; erasing one student must not yank the bytes out from under
 *    an institute library still showing them.
 *  • THE CAP HOLDS UNDER A RACE. Two concurrent uploads into a scope with one
 *    slot free produce exactly one winner. The cap is a promise made in the UI
 *    ("99 / 100"), so an overrun is a visible lie.
 *  • EVERY ROW HAS EXACTLY ONE SCOPE. The CHECK rejects both-null and both-set,
 *    so cap counting can never disagree with what the student sees.
 *
 * Pure logic (cap arithmetic, the render ladder) lives in
 * server/tests/photo-caps.test.ts and photo-renders.test.ts, which need no DB.
 * Run this one with `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { eq } from "drizzle-orm";
import { photoAssignments, photos, students } from "@shared/schema";
import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent, makeInstitute } from "../helpers/factories.js";
import { photoRepository } from "../../repositories/photoRepository.js";
import { photoService } from "../../services/photos/photo-service.js";
import { s3Service } from "../../services/storage/s3-service.js";
import { studentErasureService } from "../../services/studentErasureService.js";
import { runStudentErasureSweep } from "../../services/studentErasureCron.js";
import { PHOTO_CAP_PER_STUDENT } from "../../services/photos/photo-caps.js";

/** Insert an asset directly — these tests exercise assignment/erasure logic,
 *  not the render ladder (which has its own DB-free suite). */
async function makeAsset(hash: string) {
  return photoRepository.createPhoto({
    contentHash: hash,
    s3Key: `photos/${hash}/d.webp`,
    thumbS3Key: `photos/${hash}/t.webp`,
  });
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Drive a real hard delete the way the cron does: soft-delete, backdate the
 *  hard-delete window, then sweep. Calling the internal deleter directly would
 *  skip the path production actually takes. */
async function eraseStudent(studentId: string, ownerUserId: string): Promise<void> {
  await studentErasureService.softDeleteStudent(studentId, ownerUserId, null);
  await db
    .update(students)
    .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
    .where(eq(students.id, studentId));
  const result = await runStudentErasureSweep();
  expect(result.hardDeleted).toBe(1);
}

describe("photo assignments", () => {
  beforeEach(async () => {
    await truncateAll();
    jest.restoreAllMocks();
  });

  describe("scope constraint", () => {
    it("rejects a row with no scope", async () => {
      const asset = await makeAsset("hash-no-scope");
      // A scopeless row would be visible to everyone and counted by no cap.
      await expect(
        db.insert(photoAssignments).values({ photoId: asset.id }),
      ).rejects.toThrow();
    });

    it("rejects a row claiming both scopes", async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const { institute } = await makeInstitute(user.id);
      const asset = await makeAsset("hash-both-scopes");

      await expect(
        db.insert(photoAssignments).values({
          photoId: asset.id,
          studentId: student.id,
          instituteId: institute.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe("cap enforcement", () => {
    it("refuses the assignment that would exceed the cap", async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const scope = { kind: "student" as const, studentId: student.id };

      for (let i = 0; i < PHOTO_CAP_PER_STUDENT; i++) {
        const asset = await makeAsset(`hash-fill-${i}`);
        const res = await photoRepository.createAssignmentWithinCap(
          scope,
          { photoId: asset.id },
          PHOTO_CAP_PER_STUDENT,
        );
        expect(res).not.toBeNull();
      }

      const overflow = await makeAsset("hash-overflow");
      const result = await photoRepository.createAssignmentWithinCap(
        scope,
        { photoId: overflow.id },
        PHOTO_CAP_PER_STUDENT,
      );
      expect(result).toBeNull();
      expect(await photoRepository.countAssignments(scope)).toBe(PHOTO_CAP_PER_STUDENT);
    }, 120_000); // 2 × cap sequential round trips — exceeds 30 s on a loaded box

    it("admits exactly one of two concurrent writers to the last slot", async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const scope = { kind: "student" as const, studentId: student.id };
      const cap = 2;

      await photoRepository.createAssignmentWithinCap(
        scope,
        { photoId: (await makeAsset("hash-race-seed")).id },
        cap,
      );

      const a = await makeAsset("hash-race-a");
      const b = await makeAsset("hash-race-b");
      // Without the advisory lock both read count=1 and both insert.
      const [ra, rb] = await Promise.all([
        photoRepository.createAssignmentWithinCap(scope, { photoId: a.id }, cap),
        photoRepository.createAssignmentWithinCap(scope, { photoId: b.id }, cap),
      ]);

      const winners = [ra, rb].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(await photoRepository.countAssignments(scope)).toBe(cap);
    });

    it("treats re-assigning the same photo as idempotent, costing no slot", async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const scope = { kind: "student" as const, studentId: student.id };
      const asset = await makeAsset("hash-idempotent");

      const first = await photoRepository.createAssignmentWithinCap(scope, { photoId: asset.id }, 5);
      const second = await photoRepository.createAssignmentWithinCap(scope, { photoId: asset.id }, 5);

      expect(first?.created).toBe(true);
      expect(second?.created).toBe(false);
      expect(second?.assignment.id).toBe(first?.assignment.id);
      expect(await photoRepository.countAssignments(scope)).toBe(1);
    });

    it("counts the two scopes independently", async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const { institute } = await makeInstitute(user.id);
      const asset = await makeAsset("hash-shared-across-scopes");

      // The SAME asset in both scopes — dedup at work.
      await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id },
        5,
      );
      await photoRepository.createAssignmentWithinCap(
        { kind: "institute", instituteId: institute.id },
        { photoId: asset.id },
        5,
      );

      expect(
        await photoRepository.countAssignments({ kind: "student", studentId: student.id }),
      ).toBe(1);
      expect(
        await photoRepository.countAssignments({ kind: "institute", instituteId: institute.id }),
      ).toBe(1);
      expect(await db.select().from(photos)).toHaveLength(1);
    });
  });

  describe("orphan sweep", () => {
    it("collects an asset once nothing points at it, and deletes its bytes", async () => {
      const deleteSpy = jest.spyOn(s3Service, "delete").mockResolvedValue(undefined);
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const asset = await makeAsset("hash-orphan");

      const res = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id },
        5,
      );
      // Still referenced — not an orphan.
      expect(await photoService.sweepOrphans()).toBe(0);

      await photoRepository.deleteAssignment(res!.assignment.id);
      expect(await photoService.sweepOrphans()).toBe(1);

      expect(deleteSpy).toHaveBeenCalledWith(asset.s3Key);
      expect(deleteSpy).toHaveBeenCalledWith(asset.thumbS3Key);
      expect(await db.select().from(photos)).toHaveLength(0);
    });
  });

  describe("student erasure", () => {
    it("removes the student's photos and queues their bytes for deletion", async () => {
      const deleteSpy = jest.spyOn(s3Service, "delete").mockResolvedValue(undefined);
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const asset = await makeAsset("hash-erase-me");

      await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id, caption: "Grandma" },
        5,
      );

      await eraseStudent(student.id, user.id);

      expect(await db.select().from(photoAssignments)).toHaveLength(0);
      expect(await db.select().from(photos)).toHaveLength(0);
      expect(deleteSpy).toHaveBeenCalledWith(asset.s3Key);
      expect(deleteSpy).toHaveBeenCalledWith(asset.thumbS3Key);
    });

    it("leaves an asset another scope still shows", async () => {
      const deleteSpy = jest.spyOn(s3Service, "delete").mockResolvedValue(undefined);
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const { institute } = await makeInstitute(user.id);
      const asset = await makeAsset("hash-shared-survivor");

      await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id },
        5,
      );
      await photoRepository.createAssignmentWithinCap(
        { kind: "institute", instituteId: institute.id },
        { photoId: asset.id },
        5,
      );

      await eraseStudent(student.id, user.id);

      // The student's row is gone; the institute's remains, so the bytes stay.
      const remaining = await db.select().from(photoAssignments);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].instituteId).toBe(institute.id);
      expect(await db.select().from(photos)).toHaveLength(1);
      expect(deleteSpy).not.toHaveBeenCalledWith(asset.s3Key);
    });
  });
});
