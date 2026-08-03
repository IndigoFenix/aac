/**
 * Package API (P2) integration tests.
 *
 * Exercises the controller through fake req/res against a real DB, covering:
 *  - the permission matrix on every write path
 *  - the three "add a board" routes (link / promote / copy) and their guards
 *  - the class-C content gate
 *  - orphaned packages being frozen
 *  - the `Institute_Packages` memory field the Clinician AI drives
 *
 * See planning-docs/aac-packages-plan.md §5.4, §9.2, §11 (P2).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  addUserToInstitute,
} from '../helpers/factories.js';
import { boards, packageBoards, packages } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { packageController } from '../../controllers/packageController.js';
import { packageRepository } from '../../repositories/packageRepository.js';
import { attachPackageToStudent } from '../../services/packages/packageLinks.js';
import { INSTITUTE_PACKAGES_FIELD } from '../../services/memory-schema/institute-packages-schema.js';
import type { DBOperationContext } from '../../services/chat/memory-types.js';

/** Call a controller method and return { status, body }. */
async function call(
  method: keyof typeof packageController,
  opts: Parameters<typeof makeReq>[0],
) {
  const req = makeReq(opts);
  const { res, capture } = makeRes();
  await (packageController[method] as any)(req, res);
  return { status: capture.statusCode, body: capture.jsonBody as any };
}

/** Memory-field context, as the chat layer would build it. */
function memCtx(userId: string, instituteId?: string): DBOperationContext {
  const all = { userId, instituteId };
  return { base: all, inherited: {}, all, path: '/Institute_Packages', pathTokens: [] } as any;
}

const ops = INSTITUTE_PACKAGES_FIELD.db!;

async function makeBoardFor(userId: string, opts: { studentId?: string; name?: string; irData?: any } = {}) {
  const [row] = await db
    .insert(boards)
    .values({
      userId,
      studentId: opts.studentId ?? null,
      name: opts.name ?? 'A board',
      irData: opts.irData ?? { grid: { rows: 2, cols: 2 }, pages: [{ id: 'main', buttons: [] }] },
    })
    .returning();
  return row;
}

describe('Packages — API (P2)', () => {
  afterEach(truncateAll);

  // ============================================================
  // CRUD + permissions
  // ============================================================
  describe('create', () => {
    it('creates a package in an institute the caller belongs to', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);

      const { status, body } = await call('create', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        body: { instituteId: institute.id, name: 'Kindergarten Core' },
      });

      expect(status).toBe(201);
      expect(body.name).toBe('Kindergarten Core');
      expect(body.visibility).toBe('institute');
      expect(body.defaultMemberPermission).toBe('use');
      expect(body.linkCount).toBe(0);
    });

    it('refuses an institute the caller does not belong to', async () => {
      const user = await makeUser();
      const stranger = await makeUser();
      const { institute: mine } = await makeInstitute(user.id);
      const { institute: theirs } = await makeInstitute(stranger.id);

      const { status } = await call('create', {
        user: { id: user.id },
        query: { instituteId: mine.id },
        body: { instituteId: theirs.id, name: 'Sneaky' },
      });

      expect(status).toBe(403);
    });
  });

  describe('read and update', () => {
    it('returns the package with the caller permission and its boards', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const { status, body } = await call('get', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
      });

      expect(status).toBe(200);
      expect(body.permission).toBe('edit');
      expect(body.frozen).toBe(false);
      expect(body.boards).toEqual([]);
    });

    it('lets an institute admin rename it', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Before',
        createdByUserId: admin.id,
      });

      const { status, body } = await call('update', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { name: 'After' },
      });

      expect(status).toBe(200);
      expect(body.name).toBe('After');
    });

    it('refuses an update from a use-only member', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const { status, body } = await call('update', {
        user: { id: member.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { name: 'Nope' },
      });

      expect(status).toBe(403);
      expect(body.error).toBe('error:PACKAGE_FORBIDDEN');
    });

    it('rejects unknown fields rather than silently ignoring them', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const { status } = await call('update', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { visibility: 'public' },
      });

      expect(status).toBe(400);
      // Publishing must never be reachable as a field write.
      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });

    it('hides an institute package from an outsider as 404, not 403', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { institute: other } = await makeInstitute(outsider.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Private',
        createdByUserId: admin.id,
      });

      const { status } = await call('get', {
        user: { id: outsider.id },
        query: { instituteId: other.id },
        params: { id: pkg.id },
      });

      expect(status).toBe(404);
    });
  });

  describe('delete', () => {
    it('reports "deleted" when nothing links, "orphaned" when a student does', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);

      const lonely = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Lonely',
        createdByUserId: admin.id,
      });
      const used = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Used',
        createdByUserId: admin.id,
      });
      await attachPackageToStudent({ packageId: used.id, studentId: student.id });

      const a = await call('remove', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: lonely.id },
      });
      expect(a.body.outcome).toBe('deleted');

      const b = await call('remove', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: used.id },
      });
      expect(b.body.outcome).toBe('orphaned');
    });

    it('freezes an orphan against further edits', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Frozen',
        createdByUserId: admin.id,
      });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await call('remove', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
      });

      const { status, body } = await call('update', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { name: 'Rename an orphan' },
      });

      expect(status).toBe(409);
      expect(body.error).toBe('error:PACKAGE_ORPHANED');
    });
  });

  // ============================================================
  // Membership
  // ============================================================
  describe('adding boards', () => {
    it('promotes an unassigned board in place', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const board = await makeBoardFor(admin.id);

      const { status, body } = await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id },
      });

      expect(status).toBe(201);
      expect(body.copied).toBe(false);
      const [after] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(after.scope).toBe('package');
      expect(after.instituteId).toBe(institute.id);
    });

    it('REFUSES a student board unless a copy is explicitly requested', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const board = await makeBoardFor(admin.id, { studentId: student.id });

      const refused = await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id },
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('error:BOARD_BELONGS_TO_STUDENT');

      const copied = await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id, copyStudentBoard: true },
      });
      expect(copied.status).toBe(201);
      expect(copied.body.copied).toBe(true);
      expect(copied.body.boardId).not.toBe(board.id);

      // The student's own board is untouched.
      const [original] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(original.scope).toBe('student');
      expect(original.studentId).toBe(student.id);

      // The copy is package-scoped with no student.
      const [copy] = await db.select().from(boards).where(eq(boards.id, copied.body.boardId));
      expect(copy.scope).toBe('package');
      expect(copy.studentId).toBeNull();
    });

    it('REJECTS a board carrying a student face reference', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const board = await makeBoardFor(admin.id, {
        irData: {
          grid: { rows: 2, cols: 2 },
          pages: [
            {
              id: 'main',
              buttons: [{ id: 'b1', label: 'Mum', glyph: 'face:contact-123' }],
            },
          ],
        },
      });

      const { status, body } = await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id },
      });

      expect(status).toBe(409);
      expect(body.error).toBe('error:PACKAGE_BOARD_REJECTED');
      expect(body.findings[0].reason).toBe('student_face_ref');
      expect(body.findings[0].buttonId).toBe('b1');
      // And it was NOT promoted as a side effect.
      const [after] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(after.scope).toBe('student');
    });

    it('refuses a board owned by someone else', async () => {
      const admin = await makeUser();
      const other = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const board = await makeBoardFor(other.id);

      const { status } = await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id },
      });

      expect(status).toBe(403);
    });

    it('toggles autoLoad and removes membership without deleting the board', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const board = await makeBoardFor(admin.id);
      await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: board.id },
      });

      const patched = await call('updateBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id, boardId: board.id },
        body: { autoLoad: false },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.autoLoad).toBe(false);

      const removed = await call('removeBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id, boardId: board.id },
      });
      expect(removed.status).toBe(204);

      expect(await packageRepository.listBoards(pkg.id)).toHaveLength(0);
      const [stillThere] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(stillThere).toBeDefined();
    });
  });

  // ============================================================
  // Grants
  // ============================================================
  describe('grants', () => {
    it('grants edit to a colleague and revokes it', async () => {
      const admin = await makeUser();
      const colleague = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, colleague.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const granted = await call('addGrant', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { granteeUserId: colleague.id, permission: 'edit' },
      });
      expect(granted.status).toBe(201);
      expect(granted.body).toHaveLength(1);

      // The colleague can now edit.
      const edited = await call('update', {
        user: { id: colleague.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { name: 'Co-owned' },
      });
      expect(edited.status).toBe(200);

      const revoked = await call('removeGrant', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id, grantId: granted.body[0].id },
      });
      expect(revoked.status).toBe(204);
      expect(await packageRepository.listGrants(pkg.id)).toHaveLength(0);
    });

    it('refuses to grant to someone outside the owning institute (v1 has no cross-institute sharing)', async () => {
      const admin = await makeUser();
      const outsider = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const { status, body } = await call('addGrant', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { granteeUserId: outsider.id, permission: 'use' },
      });

      expect(status).toBe(400);
      expect(body.error).toBe('error:GRANTEE_NOT_INSTITUTE_MEMBER');
    });
  });

  // ============================================================
  // Clinician AI rail
  // ============================================================
  describe('Institute_Packages memory field', () => {
    it('creates, lists and updates a package', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const ctx = memCtx(admin.id, institute.id);

      const created = await ops.add!(ctx, { name: 'AI Package', description: 'made by the AI' });
      expect(created.name).toBe('AI Package');
      expect(created.visibility).toBe('institute');

      const listed = await ops.list!(ctx, { offset: 0, limit: 10 });
      expect(listed.total).toBe(1);
      expect(listed.keys).toEqual([created.id]);

      const updated = await ops.update!(ctx, created.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
    });

    it('syncs board membership from a whole-list write', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const ctx = memCtx(admin.id, institute.id);
      const a = await makeBoardFor(admin.id, { name: 'A' });
      const b = await makeBoardFor(admin.id, { name: 'B' });

      const pkg = await ops.add!(ctx, { name: 'P' });
      await ops.update!(ctx, pkg.id, {
        boards: [{ boardId: a.id }, { boardId: b.id, autoLoad: false }],
      });

      let members = await packageRepository.listBoards(pkg.id);
      expect(members.map((m) => m.name).sort()).toEqual(['A', 'B']);
      expect(members.find((m) => m.name === 'B')!.autoLoad).toBe(false);

      // Omitting a board removes it from the package (but not from the DB).
      await ops.update!(ctx, pkg.id, { boards: [{ boardId: a.id }] });
      members = await packageRepository.listBoards(pkg.id);
      expect(members.map((m) => m.name)).toEqual(['A']);
      const [survivor] = await db.select().from(boards).where(eq(boards.id, b.id));
      expect(survivor).toBeDefined();
    });

    it('REFUSES to publish', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const ctx = memCtx(admin.id, institute.id);
      const pkg = await ops.add!(ctx, { name: 'P' });

      await expect(ops.update!(ctx, pkg.id, { visibility: 'public' })).rejects.toThrow(
        /not something you can do/i,
      );

      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });

    it('REFUSES to add a student-owned board (a person must copy it first)', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, institute.id);
      const board = await makeBoardFor(admin.id, { studentId: student.id, name: 'Personal' });
      const pkg = await ops.add!(ctx, { name: 'P' });

      await expect(
        ops.update!(ctx, pkg.id, { boards: [{ boardId: board.id }] }),
      ).rejects.toThrow(/belongs to a student/i);
    });

    it('REFUSES to edit a package the user only has use access to, naming the reason', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      await expect(
        ops.update!(memCtx(member.id, institute.id), pkg.id, { name: 'Nope' }),
      ).rejects.toThrow(/"use" access/);
    });

    it('REFUSES to edit a frozen package', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const { student } = await makeStudent(admin.id);
      const ctx = memCtx(admin.id, institute.id);
      const pkg = await ops.add!(ctx, { name: 'P' });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      await ops.delete!(ctx, pkg.id);

      await expect(ops.update!(ctx, pkg.id, { name: 'Nope' })).rejects.toThrow(/read-only/i);
    });

    it('rejects a face-ref board with a message naming the button', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const ctx = memCtx(admin.id, institute.id);
      const board = await makeBoardFor(admin.id, {
        name: 'Family',
        irData: {
          pages: [{ id: 'main', buttons: [{ id: 'dad', label: 'Dad', glyph: 'face:c-9' }] }],
        },
      });
      const pkg = await ops.add!(ctx, { name: 'P' });

      await expect(
        ops.update!(ctx, pkg.id, { boards: [{ boardId: board.id }] }),
      ).rejects.toThrow(/student's contacts/);
    });
  });

  describe('board candidates', () => {
    it('separates the caller own boards from the institute package boards', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await makeBoardFor(admin.id, { name: 'Mine' });
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });
      const shared = await makeBoardFor(admin.id, { name: 'Shared' });
      await call('addBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { boardId: shared.id },
      });

      const { body } = await call('boardCandidates', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
      });

      expect(body.own.map((b: any) => b.name)).toEqual(['Mine']);
      expect(body.institute.map((b: any) => b.name)).toEqual(['Shared']);
    });
  });

  describe('packages for a board', () => {
    it('lists the packages a board belongs to', async () => {
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      const board = await makeBoardFor(admin.id);
      const one = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'One',
        createdByUserId: admin.id,
      });
      const two = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Two',
        createdByUserId: admin.id,
      });
      for (const pkg of [one, two]) {
        await call('addBoard', {
          user: { id: admin.id },
          query: { instituteId: institute.id },
          params: { id: pkg.id },
          body: { boardId: board.id },
        });
      }

      const { body } = await call('packagesForBoard', {
        user: { id: admin.id },
        query: { instituteId: institute.id },
        params: { id: board.id },
      });

      expect(body.map((p: any) => p.name).sort()).toEqual(['One', 'Two']);
      const memberships = await db
        .select()
        .from(packageBoards)
        .where(eq(packageBoards.boardId, board.id));
      expect(memberships).toHaveLength(2);
    });
  });
});
