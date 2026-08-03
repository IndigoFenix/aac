/**
 * Package assignment (P3) integration tests.
 *
 * Attaching a package to a student is the point where content meets a real
 * person, so the gates matter more here than anywhere else:
 *  - the caller must be able to USE the package AND access the student
 *  - a frozen (orphaned) package can be kept and removed, never newly added
 *  - detaching needs student access only, so a revoked or orphaned package can
 *    always be taken off someone
 *  - the assignment row carries instituteId (the gap in the customApps path)
 *
 * Plus the `Student_Packages` memory field the Clinician AI drives.
 *
 * See planning-docs/aac-packages-plan.md §5.4, §9.1, §11 (P3).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  addUserToInstitute,
  enrollStudent,
} from '../helpers/factories.js';
import { packageAssignments, packages } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { packageController } from '../../controllers/packageController.js';
import { packageRepository } from '../../repositories/packageRepository.js';
import {
  attachPackageToStudent,
  deletePackage,
} from '../../services/packages/packageLinks.js';
import { STUDENT_PACKAGES_FIELD } from '../../services/memory-schema/student-packages-schema.js';
import type { DBOperationContext } from '../../services/chat/memory-types.js';

async function call(
  method: keyof typeof packageController,
  opts: Parameters<typeof makeReq>[0],
) {
  const req = makeReq(opts);
  const { res, capture } = makeRes();
  await (packageController[method] as any)(req, res);
  return { status: capture.statusCode, body: capture.jsonBody as any };
}

function memCtx(userId: string, studentId: string, instituteId?: string): DBOperationContext {
  const all = { userId, studentId, instituteId };
  return { base: all, inherited: {}, all, path: '/Student_Packages', pathTokens: [] } as any;
}

const ops = STUDENT_PACKAGES_FIELD.db!;

async function makePkg(instituteId: string, userId: string, overrides = {}) {
  return packageRepository.createPackage({
    instituteId,
    name: 'Test Package',
    createdByUserId: userId,
    ...overrides,
  });
}

async function linkCountOf(packageId: string): Promise<number> {
  const [row] = await db
    .select({ linkCount: packages.linkCount })
    .from(packages)
    .where(eq(packages.id, packageId));
  return row?.linkCount ?? -1;
}

describe('Packages — assignment (P3)', () => {
  afterEach(truncateAll);

  // ============================================================
  // available list
  // ============================================================
  describe('available for student', () => {
    it('lists usable packages and flags the attached ones', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      await enrollStudent(institute.id, student.id, admin.id);

      const attached = await makePkg(institute.id, admin.id, { name: 'Attached' });
      const loose = await makePkg(institute.id, admin.id, { name: 'Loose' });
      await attachPackageToStudent({ packageId: attached.id, studentId: student.id });

      const { status, body } = await call('availableForStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { studentId: student.id },
      });

      expect(status).toBe(200);
      expect(body.packages.map((p: any) => p.name).sort()).toEqual(['Attached', 'Loose']);
      expect(body.assignedIds).toEqual([attached.id]);
      expect(loose.id).toBeTruthy();
    });

    it('includes an approved public package from another institute', async () => {
      const admin = await makeUser();
      const stranger = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(stranger.id);
      const { student } = await makeStudent(admin.id);
      await makePkg(other.id, stranger.id, {
        name: 'Public',
        visibility: 'public',
        approvalStatus: 'approved',
      });
      await makePkg(other.id, stranger.id, { name: 'Private' });

      const { body } = await call('availableForStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { studentId: student.id },
      });

      expect(body.packages.map((p: any) => p.name)).toEqual(['Public']);
    });

    it('still shows an ORPHANED package that is attached, so it can be removed', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id, { name: 'Gone' });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await deletePackage(pkg.id);

      const { body } = await call('availableForStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { studentId: student.id },
      });

      expect(body.packages.map((p: any) => p.name)).toEqual(['Gone']);
      expect(body.assignedIds).toEqual([pkg.id]);
    });
  });

  // ============================================================
  // attach / detach
  // ============================================================
  describe('attach', () => {
    it('attaches and records the institute on the assignment row', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);

      const { status } = await call('assignToStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { studentId: student.id },
      });

      expect(status).toBe(201);
      const [row] = await db
        .select()
        .from(packageAssignments)
        .where(
          and(
            eq(packageAssignments.packageId, pkg.id),
            eq(packageAssignments.studentId, student.id),
          ),
        );
      expect(row).toBeDefined();
      // The gap in the customApps path — this is the visibility key.
      expect(row.instituteId).toBe(institute.id);
      expect(row.assignedByUserId).toBe(admin.id);
      expect(await linkCountOf(pkg.id)).toBe(1);
    });

    it('is idempotent — attaching twice does not double-count', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);
      const args = {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { studentId: student.id },
      };

      await call('assignToStudent', args);
      await call('assignToStudent', args);

      expect(await linkCountOf(pkg.id)).toBe(1);
    });

    it('REFUSES a package the caller cannot use', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(outsider.id);
      const { student } = await makeStudent(outsider.id);
      const pkg = await makePkg(institute.id, admin.id);

      const { status } = await call('assignToStudent', {
        user: { id: outsider.id },
        query: { instituteId: other.id },
        params: { id: pkg.id },
        body: { studentId: student.id },
      });

      expect(status).toBe(404);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it("REFUSES a student the caller cannot access", async () => {
      const admin = await makeUser();
      const colleague = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, colleague.id);
      // The student belongs to someone else entirely.
      const outsider = await makeUser();
      const { student } = await makeStudent(outsider.id);
      const pkg = await makePkg(institute.id, admin.id);

      const { status, body } = await call('assignToStudent', {
        user: { id: colleague.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { studentId: student.id },
      });

      expect(status).toBe(403);
      expect(body.error).toBe('error:STUDENT_FORBIDDEN');
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it('REFUSES to attach an orphaned package to anyone new', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student: keeper } = await makeStudent(admin.id);
      const { student: newcomer } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: keeper.id });
      await deletePackage(pkg.id);

      const { status, body } = await call('assignToStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { studentId: newcomer.id },
      });

      expect(status).toBe(409);
      expect(body.error).toBe('error:PACKAGE_ORPHANED');
      expect(await linkCountOf(pkg.id)).toBe(1); // still just the keeper
    });
  });

  describe('detach', () => {
    it('detaches and decrements', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const { status } = await call('unassignFromStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id, studentId: student.id },
      });

      expect(status).toBe(204);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it('detaches an ORPHANED package and collects it', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await deletePackage(pkg.id);

      const { status } = await call('unassignFromStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id, studentId: student.id },
      });

      expect(status).toBe(204);
      const [gone] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(gone).toBeUndefined();
    });

    it('still allows detach when the caller has lost package access', async () => {
      const admin = await makeUser();
      const owner = await makeUser();
      const { institute: theirs } = await makeInstitute(owner.id);
      const { institute: mine } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      // Attached earlier (e.g. while public), now not usable by this caller.
      const pkg = await makePkg(theirs.id, owner.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const { status } = await call('unassignFromStudent', {
        user: { id: admin.id },
        query: { instituteId: mine.id },
        params: { id: pkg.id, studentId: student.id },
      });

      expect(status).toBe(204);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it("REFUSES to detach from a student the caller cannot access", async () => {
      const admin = await makeUser();
      const stranger = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: theirs } = await makeInstitute(stranger.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const { status } = await call('unassignFromStudent', {
        user: { id: stranger.id },
        query: { instituteId: theirs.id },
        params: { id: pkg.id, studentId: student.id },
      });

      expect(status).toBe(403);
      expect(await linkCountOf(pkg.id)).toBe(1);
    });
  });

  // ============================================================
  // Clinician AI rail
  // ============================================================
  describe('Student_Packages memory field', () => {
    it('adds, reads and removes an attachment', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, student.id, institute.id);
      const pkg = await makePkg(institute.id, admin.id, { name: 'Kindergarten' });

      const added = await ops.add!(ctx, { id: pkg.id, name: '' });
      expect(added).toEqual({ id: pkg.id, name: 'Kindergarten' });

      expect(await ops.read!(ctx)).toEqual([{ id: pkg.id, name: 'Kindergarten' }]);
      expect(await linkCountOf(pkg.id)).toBe(1);

      await ops.delete!(ctx, pkg.id);
      expect(await ops.read!(ctx)).toEqual([]);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it('agrees with the settings panel — the AI and the UI read the same rows', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, student.id, institute.id);
      const pkg = await makePkg(institute.id, admin.id, { name: 'Shared view' });

      await ops.add!(ctx, { id: pkg.id, name: '' });

      const { body } = await call('availableForStudent', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { studentId: student.id },
      });
      expect(body.assignedIds).toEqual([pkg.id]);
    });

    it('syncs the whole list on write', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, student.id, institute.id);
      const a = await makePkg(institute.id, admin.id, { name: 'A' });
      const b = await makePkg(institute.id, admin.id, { name: 'B' });

      await ops.write!(ctx, [{ id: a.id, name: '' }, { id: b.id, name: '' }]);
      expect((await ops.read!(ctx))!.map((x: any) => x.name).sort()).toEqual(['A', 'B']);

      await ops.write!(ctx, [{ id: b.id, name: '' }]);
      expect((await ops.read!(ctx))!.map((x: any) => x.name)).toEqual(['B']);
      expect(await linkCountOf(a.id)).toBe(0);
      expect(await linkCountOf(b.id)).toBe(1);
    });

    it('does not half-apply a write containing a bad id', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, student.id, institute.id);
      const good = await makePkg(institute.id, admin.id, { name: 'Good' });

      await expect(
        ops.write!(ctx, [{ id: good.id, name: '' }, { id: 'no-such-package', name: '' }]),
      ).rejects.toThrow(/No package with id/);

      // Nothing was attached — the validation pass runs before any mutation.
      expect(await ops.read!(ctx)).toEqual([]);
      expect(await linkCountOf(good.id)).toBe(0);
    });

    it('REFUSES a package from an institute the user is not in, naming the reason', async () => {
      const admin = await makeUser();
      const stranger = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: theirs } = await makeInstitute(stranger.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePkg(theirs.id, stranger.id, { name: 'Theirs' });

      await expect(
        ops.add!(memCtx(admin.id, student.id, institute.id), { id: pkg.id, name: '' }),
      ).rejects.toThrow(/not a member of, and it is not public/);
    });

    it('REFUSES to attach an orphan but still detaches one', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student: keeper } = await makeStudent(admin.id);
      const { student: newcomer } = await makeStudent(admin.id);
      const pkg = await makePkg(institute.id, admin.id, { name: 'Gone' });
      await attachPackageToStudent({ packageId: pkg.id, studentId: keeper.id });
      await deletePackage(pkg.id);

      await expect(
        ops.add!(memCtx(admin.id, newcomer.id, institute.id), { id: pkg.id, name: '' }),
      ).rejects.toThrow(/has been deleted/);

      // The keeper can still let it go.
      await ops.delete!(memCtx(admin.id, keeper.id, institute.id), pkg.id);
      const [gone] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(gone).toBeUndefined();
    });

    it('clears every attachment', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, student.id, institute.id);
      const a = await makePkg(institute.id, admin.id, { name: 'A' });
      const b = await makePkg(institute.id, admin.id, { name: 'B' });
      await ops.write!(ctx, [{ id: a.id, name: '' }, { id: b.id, name: '' }]);

      await ops.clear!(ctx);

      expect(await ops.read!(ctx)).toEqual([]);
      expect(await linkCountOf(a.id)).toBe(0);
      expect(await linkCountOf(b.id)).toBe(0);
    });
  });
});
