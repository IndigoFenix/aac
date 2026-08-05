/**
 * Package foundation (P1) integration tests.
 *
 * Covers the three things P1 actually guarantees:
 *  - `boards.scope` — the CHECK constraint makes "a package board is not PHI"
 *    a database invariant, and package rows bypass external-storage extraction.
 *  - `packageAccess` — the permission resolver and the usable-packages filter.
 *  - `packageLinks` — refcounting, the orphan lifecycle, and the erasure path.
 *
 * See planning-docs/aac-packages-plan.md §1, §2, §11 (P1).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  addUserToInstitute,
} from '../helpers/factories.js';
import { boards, packageAssignments, packageBoards, packageGrants, packages } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { resolveEntityRef } from '../../external-storage/index.js';
import {
  resolvePackagePermission,
  listUsablePackages,
  isPubliclyUsable,
  isFrozen,
} from '../../services/packages/packageAccess.js';
import {
  attachPackageToStudent,
  detachPackageFromStudent,
  deleteStudentPackageLinks,
  addPackageGrant,
  removePackageGrant,
  deletePackage,
  reconcilePackageLinkCounts,
} from '../../services/packages/packageLinks.js';
import { studentErasureService } from '../../services/studentErasureService.js';
import { runPackageLinkReconcile } from '../../services/packages/packageLinkCron.js';
import { runWithSupportContext } from '../../services/customerSupportService.js';

/** Insert a package directly — P1 has no controller yet. */
async function makePackage(
  instituteId: string,
  createdByUserId: string,
  overrides: Partial<typeof packages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(packages)
    .values({
      instituteId,
      name: 'Test Package',
      createdByUserId,
      ...overrides,
    })
    .returning();
  return row;
}

async function makePackageBoard(instituteId: string, userId: string, name = 'Package Board') {
  const [row] = await db
    .insert(boards)
    .values({ userId, name, scope: 'package', instituteId, irData: { grid: { rows: 2, cols: 2 } } })
    .returning();
  return row;
}

async function linkCountOf(packageId: string): Promise<number> {
  const [row] = await db
    .select({ linkCount: packages.linkCount })
    .from(packages)
    .where(eq(packages.id, packageId));
  return row?.linkCount ?? -1;
}

/**
 * Assert a query failed on a specific DB CHECK constraint.
 *
 * Drizzle wraps driver errors, so the constraint name lives on the pg error in
 * `.cause` rather than the top-level message. Asserting on the NAME (not just
 * "it threw") is the point: it proves the database refused, not some incidental
 * validation upstream.
 */
async function expectCheckViolation(op: Promise<unknown>, constraint: string): Promise<void> {
  let caught: any;
  try {
    await op;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const pgError = caught?.cause ?? caught;
  const detail = pgError?.constraint ?? pgError?.message ?? String(caught);
  expect(detail).toContain(constraint);
}

async function packageExists(packageId: string): Promise<boolean> {
  const [row] = await db.select({ id: packages.id }).from(packages).where(eq(packages.id, packageId));
  return Boolean(row);
}

describe('Packages — foundation (P1)', () => {
  afterEach(truncateAll);

  // ============================================================
  // boards.scope
  // ============================================================
  describe('boards.scope constraint', () => {
    it('accepts a package board with an institute and no student', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const board = await makePackageBoard(institute.id, user.id);
      expect(board.scope).toBe('package');
      expect(board.studentId).toBeNull();
    });

    it('defaults existing/new boards to student scope', async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const [board] = await db
        .insert(boards)
        .values({ userId: user.id, studentId: student.id, name: 'Ordinary' })
        .returning();
      expect(board.scope).toBe('student');
    });

    it('REJECTS a package board that carries a studentId', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);
      await expectCheckViolation(
        db.insert(boards).values({
          userId: user.id,
          studentId: student.id,
          instituteId: institute.id,
          name: 'Leaky',
          scope: 'package',
        }),
        'boards_package_scope_has_no_student',
      );
    });

    it('REJECTS a package board with no owning institute', async () => {
      const user = await makeUser();
      await expectCheckViolation(
        db.insert(boards).values({ userId: user.id, name: 'Ownerless', scope: 'package' }),
        'boards_package_scope_has_no_student',
      );
    });

    it('REJECTS promoting a student board to package scope while it keeps its student', async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const { institute } = await makeInstitute(user.id);
      const [board] = await db
        .insert(boards)
        .values({ userId: user.id, studentId: student.id, name: 'Promote me' })
        .returning();

      await expectCheckViolation(
        db
          .update(boards)
          .set({ scope: 'package', instituteId: institute.id })
          .where(eq(boards.id, board.id)),
        'boards_package_scope_has_no_student',
      );
    });
  });

  describe('external-storage ownership', () => {
    it('resolves NO entity ref for a package board, so irData is never extracted', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const board = await makePackageBoard(institute.id, user.id);
      // userId is non-null on package rows; the scope guard must win over the
      // userId fallback or cross-institute packages break.
      expect(board.userId).toBeTruthy();
      expect(resolveEntityRef('boards', board as unknown as Record<string, unknown>)).toBeNull();
    });

    it('still resolves student/user refs for ordinary boards', async () => {
      const user = await makeUser();
      const { student } = await makeStudent(user.id);
      const [studentBoard] = await db
        .insert(boards)
        .values({ userId: user.id, studentId: student.id, name: 'S' })
        .returning();
      const [userBoard] = await db
        .insert(boards)
        .values({ userId: user.id, name: 'U' })
        .returning();

      expect(resolveEntityRef('boards', studentBoard as any)).toEqual({
        type: 'student',
        id: student.id,
      });
      expect(resolveEntityRef('boards', userBoard as any)).toEqual({ type: 'user', id: user.id });
    });
  });

  // ============================================================
  // packageAccess
  // ============================================================
  describe('permission resolution', () => {
    it('gives institute admins edit', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: institute.id, userId: admin.id },
        pkg.id,
      );
      expect(perm).toBe('edit');
    });

    it('gives plain institute members use by default', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await makePackage(institute.id, admin.id);

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: institute.id, userId: member.id },
        pkg.id,
      );
      expect(perm).toBe('use');
    });

    it('honours defaultMemberPermission=none for plain members', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await makePackage(institute.id, admin.id, { defaultMemberPermission: 'none' });

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: institute.id, userId: member.id },
        pkg.id,
      );
      expect(perm).toBe('none');
    });

    it('lifts a member to edit via an explicit grant', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await makePackage(institute.id, admin.id);
      await addPackageGrant({ packageId: pkg.id, granteeUserId: member.id, permission: 'edit' });

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: institute.id, userId: member.id },
        pkg.id,
      );
      expect(perm).toBe('edit');
    });

    it('denies outsiders on an institute-visible package', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(outsider.id);
      const pkg = await makePackage(institute.id, admin.id);

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: other.id, userId: outsider.id },
        pkg.id,
      );
      expect(perm).toBe('none');
    });

    it('gives outsiders use — never edit — on an APPROVED public package', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(outsider.id);
      const pkg = await makePackage(institute.id, admin.id, {
        visibility: 'public',
        approvalStatus: 'approved',
      });

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: other.id, userId: outsider.id },
        pkg.id,
      );
      expect(perm).toBe('use');
    });

    it('denies outsiders on a public package still awaiting approval', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(outsider.id);
      const pkg = await makePackage(institute.id, admin.id, {
        visibility: 'public',
        approvalStatus: 'pending',
      });

      const perm = await resolvePackagePermission(
        { kind: 'institute', instituteId: other.id, userId: outsider.id },
        pkg.id,
      );
      expect(perm).toBe('none');
    });

    it('isPubliclyUsable requires public AND approved AND live', () => {
      expect(
        isPubliclyUsable({ visibility: 'public', approvalStatus: 'approved', deletedAt: null }),
      ).toBe(true);
      expect(
        isPubliclyUsable({ visibility: 'public', approvalStatus: 'pending', deletedAt: null }),
      ).toBe(false);
      expect(
        isPubliclyUsable({ visibility: 'institute', approvalStatus: 'approved', deletedAt: null }),
      ).toBe(false);
      expect(
        isPubliclyUsable({ visibility: 'public', approvalStatus: 'approved', deletedAt: new Date() }),
      ).toBe(false);
    });
  });

  describe('listUsablePackages', () => {
    it('returns own-institute and approved-public packages, but not other institutes or orphans', async () => {
      const admin = await makeUser();
      const stranger = await makeUser();
      const { institute: mine } = await makeInstitute(admin.id);
      const { institute: theirs } = await makeInstitute(stranger.id);

      const ownPkg = await makePackage(mine.id, admin.id, { name: 'Mine' });
      const publicPkg = await makePackage(theirs.id, stranger.id, {
        name: 'Public',
        visibility: 'public',
        approvalStatus: 'approved',
      });
      const hiddenPkg = await makePackage(theirs.id, stranger.id, { name: 'Theirs' });
      const orphan = await makePackage(mine.id, admin.id, { name: 'Orphan' });
      // Give the orphan a link so deletePackage soft-deletes rather than removes.
      await addPackageGrant({ packageId: orphan.id, granteeUserId: admin.id, permission: 'use' });
      await deletePackage(orphan.id);

      const rows = await db
        .select({ id: packages.id, name: packages.name })
        .from(packages)
        .where(listUsablePackages({ kind: 'institute', instituteId: mine.id, userId: admin.id }));
      const names = rows.map((r) => r.name).sort();

      expect(names).toEqual(['Mine', 'Public']);
      expect(rows.map((r) => r.id)).not.toContain(hiddenPkg.id);
      expect(rows.map((r) => r.id)).not.toContain(orphan.id);
      expect(ownPkg.id).toBeTruthy();
      expect(publicPkg.id).toBeTruthy();
    });
  });

  // ============================================================
  // Customer support mode
  //
  // Both resolvers below read `institute_users` DIRECTLY rather than going
  // through instituteRepository, whose admin/member predicates short-circuit
  // on the active support institute. A support agent has no membership row in
  // the institute they are supporting, so without an explicit branch they saw
  // an empty package list ("Content Packages" in AAC Settings) and 404s when
  // opening a package the institute-keyed list had just shown them.
  // ============================================================
  describe('customer support mode', () => {
    it("resolves EDIT on the supported institute's packages", async () => {
      const customer = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(customer.id);
      const pkg = await makePackage(institute.id, customer.id, { name: 'Theirs' });

      const ctx = { kind: 'institute' as const, instituteId: institute.id, userId: support.id };

      // Outside a support session the agent is just another stranger.
      expect(await resolvePackagePermission(ctx, pkg.id)).toBe('none');

      const inSupport = await runWithSupportContext(institute.id, () =>
        resolvePackagePermission(ctx, pkg.id),
      );
      expect(inSupport).toBe('edit');
    });

    it('does NOT reach an institute other than the one being supported', async () => {
      const customer = await makeUser();
      const other = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute: supported } = await makeInstitute(customer.id);
      const { institute: unrelated } = await makeInstitute(other.id);
      const pkg = await makePackage(unrelated.id, other.id, { name: 'Unrelated' });

      const permission = await runWithSupportContext(supported.id, () =>
        resolvePackagePermission(
          { kind: 'institute', instituteId: supported.id, userId: support.id },
          pkg.id,
        ),
      );
      expect(permission).toBe('none');
    });

    it("lists the supported institute's packages, including defaultMemberPermission='none'", async () => {
      const customer = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(customer.id);
      const { institute: unrelated } = await makeInstitute(customer.id);
      await makePackage(institute.id, customer.id, { name: 'Shared' });
      // An admin sees this one; defaultMemberPermission gates ORDINARY members.
      await makePackage(institute.id, customer.id, {
        name: 'Members Excluded',
        defaultMemberPermission: 'none',
      });
      await makePackage(unrelated.id, customer.id, { name: 'Elsewhere' });

      const ctx = { kind: 'institute' as const, instituteId: institute.id, userId: support.id };

      const before = await db
        .select({ name: packages.name })
        .from(packages)
        .where(listUsablePackages(ctx));
      expect(before).toEqual([]);

      const rows = await runWithSupportContext(institute.id, () =>
        db.select({ name: packages.name }).from(packages).where(listUsablePackages(ctx)),
      );
      expect(rows.map((r) => r.name).sort()).toEqual(['Members Excluded', 'Shared']);
    });

    it('still excludes orphaned packages from the support listing', async () => {
      const customer = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(customer.id);
      const orphan = await makePackage(institute.id, customer.id, { name: 'Orphan' });
      await addPackageGrant({ packageId: orphan.id, granteeUserId: customer.id, permission: 'use' });
      await deletePackage(orphan.id);

      const rows = await runWithSupportContext(institute.id, () =>
        db
          .select({ name: packages.name })
          .from(packages)
          .where(
            listUsablePackages({
              kind: 'institute',
              instituteId: institute.id,
              userId: support.id,
            }),
          ),
      );
      expect(rows).toEqual([]);
    });
  });

  // ============================================================
  // packageLinks
  // ============================================================
  describe('link counting', () => {
    it('counts assignments and grants, and is idempotent on re-attach', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);

      expect(await linkCountOf(pkg.id)).toBe(0);

      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      expect(await linkCountOf(pkg.id)).toBe(1);

      // Re-attaching the same pair must not double-count.
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      expect(await linkCountOf(pkg.id)).toBe(1);

      await addPackageGrant({ packageId: pkg.id, granteeUserId: admin.id, permission: 'use' });
      expect(await linkCountOf(pkg.id)).toBe(2);

      // Re-granting updates the permission without counting again.
      await addPackageGrant({ packageId: pkg.id, granteeUserId: admin.id, permission: 'edit' });
      expect(await linkCountOf(pkg.id)).toBe(2);
      const [grant] = await db
        .select()
        .from(packageGrants)
        .where(eq(packageGrants.packageId, pkg.id));
      expect(grant.permission).toBe('edit');

      await detachPackageFromStudent(pkg.id, student.id);
      expect(await linkCountOf(pkg.id)).toBe(1);

      await removePackageGrant(pkg.id, admin.id);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });

    it('stays correct across a concurrent attach/detach burst', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      const students = await Promise.all(
        Array.from({ length: 8 }, () => makeStudent(admin.id).then((r) => r.student)),
      );

      await Promise.all(
        students.map((s) => attachPackageToStudent({ packageId: pkg.id, studentId: s.id })),
      );
      expect(await linkCountOf(pkg.id)).toBe(8);

      await Promise.all(
        students.slice(0, 5).map((s) => detachPackageFromStudent(pkg.id, s.id)),
      );
      expect(await linkCountOf(pkg.id)).toBe(3);
    });
  });

  describe('deletion and the orphan lifecycle', () => {
    it('hard-deletes immediately when nothing links to it', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);

      await expect(deletePackage(pkg.id)).resolves.toBe('deleted');
      expect(await packageExists(pkg.id)).toBe(false);
    });

    it('orphans rather than removes while a student is still attached', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      await expect(deletePackage(pkg.id)).resolves.toBe('orphaned');

      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row).toBeDefined();
      expect(row.deletedAt).not.toBeNull();
      expect(row.instituteId).toBeNull(); // lost its owner
      expect(isFrozen(row)).toBe(true);

      // The student's attachment still resolves — nothing was yanked away.
      const [assignment] = await db
        .select()
        .from(packageAssignments)
        .where(
          and(
            eq(packageAssignments.packageId, pkg.id),
            eq(packageAssignments.studentId, student.id),
          ),
        );
      expect(assignment).toBeDefined();
    });

    it('collects the orphan on the last detach', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student: a } = await makeStudent(admin.id);
      const { student: b } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: a.id });
      await attachPackageToStudent({ packageId: pkg.id, studentId: b.id });
      await deletePackage(pkg.id);

      await detachPackageFromStudent(pkg.id, a.id);
      expect(await packageExists(pkg.id)).toBe(true); // b still holds it

      await detachPackageFromStudent(pkg.id, b.id);
      expect(await packageExists(pkg.id)).toBe(false);
    });

    it('keeps an orphan alive on a grant alone (grants are co-ownership)', async () => {
      const admin = await makeUser();
      const colleague = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await addPackageGrant({ packageId: pkg.id, granteeUserId: colleague.id, permission: 'edit' });

      await expect(deletePackage(pkg.id)).resolves.toBe('orphaned');
      expect(await packageExists(pkg.id)).toBe(true);

      await removePackageGrant(pkg.id, colleague.id);
      expect(await packageExists(pkg.id)).toBe(false);
    });

    it('cascades package_boards when the package is finally removed', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      const board = await makePackageBoard(institute.id, admin.id);
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });

      await deletePackage(pkg.id);

      const rows = await db.select().from(packageBoards).where(eq(packageBoards.packageId, pkg.id));
      expect(rows).toHaveLength(0);
    });

    it('removes membership rows when the BOARD is deleted (FK cascade)', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      const board = await makePackageBoard(institute.id, admin.id);
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });

      await db.delete(boards).where(eq(boards.id, board.id));

      const rows = await db.select().from(packageBoards).where(eq(packageBoards.boardId, board.id));
      expect(rows).toHaveLength(0);
      expect(await packageExists(pkg.id)).toBe(true); // the package itself survives
    });
  });

  describe('student erasure', () => {
    it('drops package links and collects an orphan the student was holding alive', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await deletePackage(pkg.id);
      expect(await packageExists(pkg.id)).toBe(true);

      await studentErasureService._hardDeleteStudent(student.id, admin.id, institute.id);

      const assignments = await db
        .select()
        .from(packageAssignments)
        .where(eq(packageAssignments.studentId, student.id));
      expect(assignments).toHaveLength(0);
      // The erased student held the last link — the orphan must not survive.
      expect(await packageExists(pkg.id)).toBe(false);
    });

    it('leaves a LIVE package intact when an attached student is erased', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      await studentErasureService._hardDeleteStudent(student.id, admin.id, institute.id);

      expect(await packageExists(pkg.id)).toBe(true);
      expect(await linkCountOf(pkg.id)).toBe(0);
    });
  });

  describe('reconciliation backstop', () => {
    it('repairs drifted counters and collects orphans it finds', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const live = await makePackage(institute.id, admin.id, { name: 'Live' });
      await attachPackageToStudent({ packageId: live.id, studentId: student.id });

      const stranded = await makePackage(institute.id, admin.id, { name: 'Stranded' });
      await addPackageGrant({ packageId: stranded.id, granteeUserId: admin.id, permission: 'use' });
      await deletePackage(stranded.id);
      // Simulate a crashed transaction: the grant vanished without decrementing.
      await db.delete(packageGrants).where(eq(packageGrants.packageId, stranded.id));

      // Simulate counter drift on the live package.
      await db.update(packages).set({ linkCount: 99 }).where(eq(packages.id, live.id));

      const result = await reconcilePackageLinkCounts();

      expect(await linkCountOf(live.id)).toBe(1);
      expect(result.corrected.map((c) => c.packageId)).toContain(live.id);
      expect(result.collected).toContain(stranded.id);
      expect(await packageExists(stranded.id)).toBe(false);
    });

    it('is what the daily cron runs, and is a no-op on a clean database', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const result = await runPackageLinkReconcile();

      expect(result.checked).toBe(1);
      expect(result.corrected).toEqual([]);
      expect(result.collected).toEqual([]);
      expect(await linkCountOf(pkg.id)).toBe(1);
    });

    it('never removes a live package, even with a zeroed counter', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await makePackage(institute.id, admin.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await db.update(packages).set({ linkCount: 0 }).where(eq(packages.id, pkg.id));

      await reconcilePackageLinkCounts();

      // Not soft-deleted, so it is not a GC candidate regardless of the counter.
      expect(await packageExists(pkg.id)).toBe(true);
      expect(await linkCountOf(pkg.id)).toBe(1);
    });
  });
});
