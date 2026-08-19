/**
 * Photo Manager API authorization, against a real database.
 *
 * WHY THIS SUITE EXISTS AT ALL: the panel it serves was built "structurally
 * similar to the symbol manager", and customSymbolController deliberately was
 * NOT copied on this point — `GET /api/custom-symbols/student/:studentId`
 * returns any student's symbols to any authenticated caller, with no access
 * check. That is a defensible-ish shortcut for vocabulary artwork and an
 * indefensible one for photographs of somebody's child. So every assertion here
 * is about a caller who should be refused:
 *
 *  • A signed-in stranger cannot read a student's photo library.
 *  • A non-member cannot read an institute's.
 *  • A plain institute MEMBER may look but not touch — an institute photo lands
 *    on every student's board in the org, so writing is admin-only.
 *  • Assignment-id routes authorize via the assignment's OWN scope, so knowing
 *    a uuid is not enough to caption or delete someone else's photo.
 *  • Reorder ignores foreign ids rather than trusting the payload.
 *
 * Data-layer behaviour (caps, dedup, erasure, the scope CHECK) is in
 * server/tests/integration/photos.test.ts. Run both with
 * `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { truncateAll, db } from "../helpers/db.js";
import { makeReq, makeRes } from "../helpers/http.js";
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
} from "../helpers/factories.js";
import { photoController } from "../../controllers/photoController.js";
import { photoRepository } from "../../repositories/photoRepository.js";
import { s3Service } from "../../services/storage/s3-service.js";
import { photoAssignments } from "@shared/schema";

async function makeAsset(hash: string) {
  return photoRepository.createPhoto({
    contentHash: hash,
    s3Key: `photos/${hash}/d.webp`,
    thumbS3Key: `photos/${hash}/t.webp`,
  });
}

/** Call a controller method with a fake req/res and return the captured result. */
async function call(
  method: "listScope" | "upload" | "updateAssignment" | "deleteAssignment" | "reorder",
  opts: Parameters<typeof makeReq>[0],
) {
  const req = makeReq(opts);
  const { res, capture } = makeRes();
  await (photoController as any)[method](req, res);
  return capture;
}

describe("photo API authorization", () => {
  beforeEach(async () => {
    await truncateAll();
    jest.restoreAllMocks();
    // No S3 in tests; presigning is the only thing listScope needs from it.
    jest.spyOn(s3Service, "presignGet").mockResolvedValue("https://signed.example/x");
  });

  describe("student scope", () => {
    it("refuses a signed-in stranger", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);

      const out = await call("listScope", {
        user: { id: stranger.id },
        params: { studentId: student.id },
      });

      expect(out.statusCode).toBe(403);
      expect(out.jsonBody).toEqual({ error: "STUDENT_ACCESS_DENIED" });
    });

    it("allows the owner, and reports the cap", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const out = await call("listScope", {
        user: { id: owner.id },
        params: { studentId: student.id },
      });

      expect(out.statusCode).toBe(200);
      expect(out.jsonBody).toMatchObject({ count: 0, cap: 100, canWrite: true });
    });

    it("refuses an unauthenticated caller", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const out = await call("listScope", { user: null, params: { studentId: student.id } });
      expect(out.statusCode).toBe(401);
    });
  });

  describe("institute scope", () => {
    it("refuses a non-member", async () => {
      const founder = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(founder.id);

      const out = await call("listScope", {
        user: { id: outsider.id },
        params: { instituteId: institute.id },
      });

      expect(out.statusCode).toBe(403);
      expect(out.jsonBody).toEqual({ error: "INSTITUTE_ACCESS_DENIED" });
    });

    it("lets a plain member read but not write", async () => {
      const founder = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(founder.id);
      await addUserToInstitute(institute.id, member.id, { isAdmin: false });

      const list = await call("listScope", {
        user: { id: member.id },
        params: { instituteId: institute.id },
      });
      expect(list.statusCode).toBe(200);
      // Readable — but the panel must not offer edit controls.
      expect(list.jsonBody).toMatchObject({ canWrite: false });

      const reorder = await call("reorder", {
        user: { id: member.id },
        body: { instituteId: institute.id, orderedAssignmentIds: [] },
      });
      expect(reorder.statusCode).toBe(403);
      expect(reorder.jsonBody).toEqual({ error: "PHOTO_WRITE_FORBIDDEN" });
    });

    it("lets an admin write", async () => {
      const founder = await makeUser();
      const admin = await makeUser();
      const { institute } = await makeInstitute(founder.id);
      await addUserToInstitute(institute.id, admin.id, { isAdmin: true });

      const out = await call("listScope", {
        user: { id: admin.id },
        params: { instituteId: institute.id },
      });
      expect(out.jsonBody).toMatchObject({ canWrite: true });
    });
  });

  describe("scope shape", () => {
    it("rejects a request naming both scopes", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      const { institute } = await makeInstitute(owner.id);

      const out = await call("listScope", {
        user: { id: owner.id },
        params: { studentId: student.id, instituteId: institute.id },
      });

      expect(out.statusCode).toBe(400);
      expect(out.jsonBody).toEqual({ error: "SCOPE_AMBIGUOUS" });
    });

    it("rejects a request naming neither", async () => {
      const user = await makeUser();
      const out = await call("listScope", { user: { id: user.id }, params: {} });
      expect(out.statusCode).toBe(400);
      expect(out.jsonBody).toEqual({ error: "SCOPE_REQUIRED" });
    });
  });

  describe("assignment routes authorize by the assignment's own scope", () => {
    it("refuses a stranger who knows the assignment id", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);
      const asset = await makeAsset("hash-api-1");
      const created = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id },
        100,
      );
      const assignmentId = created!.assignment.id;

      // Guessing/leaking a uuid must not be sufficient.
      const patch = await call("updateAssignment", {
        user: { id: stranger.id },
        params: { assignmentId },
        body: { caption: "mine now" },
      });
      expect(patch.statusCode).toBe(403);

      const del = await call("deleteAssignment", {
        user: { id: stranger.id },
        params: { assignmentId },
      });
      expect(del.statusCode).toBe(403);

      // And nothing changed.
      const still = await photoRepository.getAssignment(assignmentId);
      expect(still?.caption).toBeNull();
    });

    it("lets the owner caption and delete", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      const asset = await makeAsset("hash-api-2");
      const created = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id },
        100,
      );
      const assignmentId = created!.assignment.id;

      const patch = await call("updateAssignment", {
        user: { id: owner.id },
        params: { assignmentId },
        body: { caption: "  Grandma  " },
      });
      expect(patch.statusCode).toBe(200);
      // Trimmed on the way in — a caption is a display label.
      expect((await photoRepository.getAssignment(assignmentId))?.caption).toBe("Grandma");

      const del = await call("deleteAssignment", {
        user: { id: owner.id },
        params: { assignmentId },
      });
      expect(del.statusCode).toBe(200);
      expect(await photoRepository.getAssignment(assignmentId)).toBeUndefined();
    });

    it("404s an unknown assignment rather than leaking whether it exists", async () => {
      const user = await makeUser();
      const out = await call("deleteAssignment", {
        user: { id: user.id },
        params: { assignmentId: "00000000-0000-0000-0000-000000000000" },
      });
      expect(out.statusCode).toBe(404);
    });

    it("treats an empty caption as clearing it, not as a no-op", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      const asset = await makeAsset("hash-api-3");
      const created = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: student.id },
        { photoId: asset.id, caption: "Old" },
        100,
      );
      const assignmentId = created!.assignment.id;

      const out = await call("updateAssignment", {
        user: { id: owner.id },
        params: { assignmentId },
        body: { caption: "   " },
      });
      expect(out.statusCode).toBe(200);
      expect((await photoRepository.getAssignment(assignmentId))?.caption).toBeNull();
    });
  });

  describe("reorder", () => {
    it("ignores assignment ids from another scope", async () => {
      const ownerA = await makeUser();
      const ownerB = await makeUser();
      const { student: studentA } = await makeStudent(ownerA.id);
      const { student: studentB } = await makeStudent(ownerB.id);

      const a1 = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: studentA.id },
        { photoId: (await makeAsset("hash-reorder-a1")).id },
        100,
      );
      const a2 = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: studentA.id },
        { photoId: (await makeAsset("hash-reorder-a2")).id },
        100,
      );
      const foreign = await photoRepository.createAssignmentWithinCap(
        { kind: "student", studentId: studentB.id },
        { photoId: (await makeAsset("hash-reorder-b1")).id },
        100,
      );

      // ownerA submits an order that smuggles in studentB's assignment id.
      const out = await call("reorder", {
        user: { id: ownerA.id },
        body: {
          studentId: studentA.id,
          orderedAssignmentIds: [a2!.assignment.id, foreign!.assignment.id, a1!.assignment.id],
        },
      });

      expect(out.statusCode).toBe(200);
      // Only studentA's two rows were touched.
      expect(out.jsonBody).toEqual({ updated: 2 });

      const foreignRow = await photoRepository.getAssignment(foreign!.assignment.id);
      expect(foreignRow?.sortOrder).toBe(0); // untouched

      const listA = await photoRepository.listScope({ kind: "student", studentId: studentA.id });
      expect(listA.map((p) => p.assignmentId)).toEqual([a2!.assignment.id, a1!.assignment.id]);
    });

    it("rejects a malformed payload", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      const out = await call("reorder", {
        user: { id: owner.id },
        body: { studentId: student.id, orderedAssignmentIds: "not-an-array" },
      });
      expect(out.statusCode).toBe(400);
      expect(out.jsonBody).toEqual({ error: "INVALID_BODY" });
    });
  });

  describe("upload", () => {
    it("refuses a stranger before any file is decoded", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);

      const out = await call("upload", {
        user: { id: stranger.id },
        params: { studentId: student.id },
      });

      expect(out.statusCode).toBe(403);
      expect(await db.select().from(photoAssignments)).toHaveLength(0);
    });

    it("400s when no files arrived", async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const out = await call("upload", {
        user: { id: owner.id },
        params: { studentId: student.id },
      });

      expect(out.statusCode).toBe(400);
      expect(out.jsonBody).toEqual({ error: "NO_PHOTOS" });
    });
  });
});
