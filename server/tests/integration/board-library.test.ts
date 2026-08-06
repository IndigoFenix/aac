/**
 * The board picker's grouped library, and the three ways a {{student}}'s board
 * can join a package.
 *
 * What this pins:
 *
 *  - GROUPING is the server's answer, not the client's guess. With no student
 *    selected the picker is the whole institute — "Not assigned", one section
 *    per package, one section per student — and with a student selected it is
 *    only what that child can actually open.
 *  - EDITABILITY travels with each board. A board in a package the caller only
 *    holds `use` on comes back `canEdit: false`, and PATCH refuses it too — the
 *    greyed-out Save button and the server say the same thing.
 *  - A board that belongs to a child never joins a package by accident: copy,
 *    move, or move-and-give-the-package-to-the-child, each asked for by name.
 *
 * See planning-docs/aac-packages-plan.md §2 for the permission model.
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
import { boards, packageBoards, packages } from '@shared/schema';
import { eq } from 'drizzle-orm';
import type { BoardLibraryResponse } from '@shared/board-library';
import { boardController } from '../../controllers/boardController.js';
import { packageController } from '../../controllers/packageController.js';
import { boardRepository } from '../../repositories/boardRepository.js';
import { packageRepository } from '../../repositories/packageRepository.js';
import { attachPackageToStudent } from '../../services/packages/packageLinks.js';

const IR = { grid: { rows: 2, cols: 2 }, pages: [{ id: 'main', buttons: [] }] };

async function makeBoard(values: Record<string, unknown>) {
  const [row] = await db
    .insert(boards)
    .values({ irData: IR, ...values } as any)
    .returning();
  return row;
}

async function makePackage(
  instituteId: string,
  createdByUserId: string,
  overrides: Partial<typeof packages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(packages)
    .values({ instituteId, name: 'Test Package', createdByUserId, ...overrides })
    .returning();
  return row;
}

async function library(
  userId: string,
  query: Record<string, string>,
): Promise<{ status: number; body: BoardLibraryResponse }> {
  const req = makeReq({ user: { id: userId }, query });
  const { res, capture } = makeRes();
  await boardController.getLibrary(req, res);
  return { status: capture.statusCode, body: capture.jsonBody as BoardLibraryResponse };
}

const group = (body: BoardLibraryResponse, kind: string, id?: string) =>
  body.groups.find((g) => g.kind === kind && (id === undefined || g.id === id));

const names = (g: { boards: { name: string }[] } | undefined) =>
  (g?.boards ?? []).map((b) => b.name).sort();

describe('board library — no {{student}} selected', () => {
  afterEach(truncateAll);

  it('returns nothing to create against when no institute is selected', async () => {
    const user = await makeUser();
    const { status, body } = await library(user.id, {});

    expect(status).toBe(200);
    expect(body).toEqual({ canCreate: false, groups: [] });
  });

  it('REFUSES an institute the caller does not belong to', async () => {
    const outsider = await makeUser();
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id);

    const { status } = await library(outsider.id, { instituteId: institute.id });

    expect(status).toBe(403);
  });

  it('groups the institute into Not assigned / packages / {{students}}', async () => {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { student } = await makeStudent(user.id);
    await enrollStudent(institute.id, student.id, user.id);

    await makeBoard({ userId: user.id, instituteId: institute.id, name: 'Loose Draft' });
    await makeBoard({ userId: user.id, studentId: student.id, name: "Child's Board" });

    const pkg = await makePackage(institute.id, user.id, { name: 'Core Words' });
    const inPackage = await makeBoard({
      userId: user.id,
      instituteId: institute.id,
      scope: 'package',
      name: 'Shared Board',
    });
    await packageRepository.addBoard({ packageId: pkg.id, boardId: inPackage.id });

    const { body } = await library(user.id, { instituteId: institute.id });

    expect(body.canCreate).toBe(true);
    expect(names(group(body, 'unassigned'))).toEqual(['Loose Draft']);
    expect(names(group(body, 'package', pkg.id))).toEqual(['Shared Board']);
    expect(names(group(body, 'student', student.id))).toEqual(["Child's Board"]);
  });

  it('keeps package-scoped content that no package holds any more', async () => {
    // Removing a board from its last package must not make it unreachable: it
    // is still the institute's, so it belongs under "Not assigned".
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    await makeBoard({
      userId: user.id,
      instituteId: institute.id,
      scope: 'package',
      name: 'Ex-package Board',
    });

    const { body } = await library(user.id, { instituteId: institute.id });

    expect(names(group(body, 'unassigned'))).toEqual(['Ex-package Board']);
  });

  it('shows a legacy draft to its author only', async () => {
    // Boards saved before every board carried an institute have nobody but
    // their author to authorise the read.
    const author = await makeUser();
    const colleague = await makeUser();
    const { institute } = await makeInstitute(author.id);
    await addUserToInstitute(institute.id, colleague.id);
    await makeBoard({ userId: author.id, name: 'Old Draft' });

    const mine = await library(author.id, { instituteId: institute.id });
    const theirs = await library(colleague.id, { instituteId: institute.id });

    expect(names(group(mine.body, 'unassigned'))).toEqual(['Old Draft']);
    expect(names(group(theirs.body, 'unassigned'))).toEqual([]);
  });

  it('never leaks another institute’s boards', async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { institute: other } = await makeInstitute(stranger.id);
    await makeBoard({ userId: stranger.id, instituteId: other.id, name: 'Not Yours' });

    const { body } = await library(user.id, { instituteId: institute.id });

    expect(body.groups.flatMap((g) => g.boards.map((b) => b.name))).not.toContain('Not Yours');
  });
});

describe('board library — a {{student}} is selected', () => {
  afterEach(truncateAll);

  it('lists their own boards first, then their packages', async () => {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { student } = await makeStudent(user.id);
    await enrollStudent(institute.id, student.id, user.id);

    await makeBoard({ userId: user.id, studentId: student.id, name: 'Theirs' });
    // An institute draft that is NOT theirs — must not appear.
    await makeBoard({ userId: user.id, instituteId: institute.id, name: 'Loose Draft' });

    const pkg = await makePackage(institute.id, user.id, { name: 'Core Words' });
    const shared = await makeBoard({
      userId: user.id,
      instituteId: institute.id,
      scope: 'package',
      name: 'Shared Board',
    });
    await packageRepository.addBoard({ packageId: pkg.id, boardId: shared.id });
    await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

    const { body } = await library(user.id, {
      instituteId: institute.id,
      studentId: student.id,
    });

    expect(body.groups.map((g) => g.kind)).toEqual(['student', 'package']);
    expect(names(group(body, 'student', student.id))).toEqual(['Theirs']);
    expect(names(group(body, 'package', pkg.id))).toEqual(['Shared Board']);
  });

  it('shows a public package the caller cannot edit, and marks it read-only', async () => {
    const user = await makeUser();
    const publisher = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { institute: publisherInstitute } = await makeInstitute(publisher.id);
    const { student } = await makeStudent(user.id);
    await enrollStudent(institute.id, student.id, user.id);

    const pkg = await makePackage(publisherInstitute.id, publisher.id, {
      name: 'Public Set',
      visibility: 'public',
      approvalStatus: 'approved',
    });
    const shared = await makeBoard({
      userId: publisher.id,
      instituteId: publisherInstitute.id,
      scope: 'package',
      name: 'Published Board',
    });
    await packageRepository.addBoard({ packageId: pkg.id, boardId: shared.id });
    await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

    const { body } = await library(user.id, {
      instituteId: institute.id,
      studentId: student.id,
    });

    const pkgGroup = group(body, 'package', pkg.id)!;
    expect(pkgGroup.canEdit).toBe(false);
    expect(pkgGroup.boards[0].canEdit).toBe(false);

    // And the server refuses the write the greyed-out Save button would have
    // attempted — the picker is a convenience, not the guard.
    const req = makeReq({
      user: { id: user.id },
      params: { id: shared.id },
      query: { instituteId: institute.id },
      body: { name: 'Rewritten' },
    });
    const { res, capture } = makeRes();
    await boardController.updateBoard(req, res);

    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).error).toBe('error:BOARD_READ_ONLY');
    expect((await boardRepository.getBoard(shared.id))?.name).toBe('Published Board');
  });

  it('REFUSES a {{student}} the caller cannot reach', async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { student } = await makeStudent(stranger.id);

    const { status } = await library(user.id, {
      instituteId: institute.id,
      studentId: student.id,
    });

    expect(status).toBe(403);
  });
});

describe("adding a {{student}}'s board to a package", () => {
  afterEach(truncateAll);

  /** The caller, their institute, a package, and a board owned by a child. */
  async function scenario() {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const { student } = await makeStudent(user.id);
    await enrollStudent(institute.id, student.id, user.id);
    const pkg = await makePackage(institute.id, user.id);
    const board = await makeBoard({
      userId: user.id,
      studentId: student.id,
      name: 'Mealtime',
    });
    return { user, institute, student, pkg, board };
  }

  async function addBoard(userId: string, instituteId: string, packageId: string, body: unknown) {
    const req = makeReq({
      user: { id: userId },
      params: { id: packageId },
      query: { instituteId },
      body,
    });
    const { res, capture } = makeRes();
    await packageController.addBoard(req, res);
    return capture;
  }

  it('REFUSES to add it without being told which resolution to use', async () => {
    const { user, institute, pkg, board } = await scenario();

    const capture = await addBoard(user.id, institute.id, pkg.id, { boardId: board.id });

    expect(capture.statusCode).toBe(409);
    expect((capture.jsonBody as any).error).toBe('error:BOARD_BELONGS_TO_STUDENT');
    expect(await packageRepository.listBoardIds(pkg.id)).toEqual([]);
  });

  it('COPY leaves the child’s board exactly where it was', async () => {
    const { user, institute, student, pkg, board } = await scenario();

    const capture = await addBoard(user.id, institute.id, pkg.id, {
      boardId: board.id,
      copyStudentBoard: true,
    });

    expect(capture.statusCode).toBe(201);
    const { boardId, copied } = capture.jsonBody as any;
    expect(copied).toBe(true);
    expect(boardId).not.toBe(board.id);

    const original = await boardRepository.getBoard(board.id);
    expect(original?.studentId).toBe(student.id);
    expect(original?.scope).toBe('student');

    const copy = await boardRepository.getBoard(boardId);
    expect(copy?.scope).toBe('package');
    expect(copy?.studentId).toBeNull();
  });

  it('MOVE takes the board off the child', async () => {
    const { user, institute, student, pkg, board } = await scenario();

    const capture = await addBoard(user.id, institute.id, pkg.id, {
      boardId: board.id,
      detachFromStudent: true,
    });

    expect(capture.statusCode).toBe(201);
    expect((capture.jsonBody as any).boardId).toBe(board.id);

    const moved = await boardRepository.getBoard(board.id);
    expect(moved?.scope).toBe('package');
    expect(moved?.studentId).toBeNull();
    expect(moved?.instituteId).toBe(institute.id);

    // It really is gone from the child's own list — that is the cost of this
    // option, and the dialog says so.
    expect(await boardRepository.getStudentBoardsMetadata(student.id)).toEqual([]);
    expect(await packageRepository.isAssigned(pkg.id, student.id)).toBe(false);
  });

  it('MOVE + assign keeps the board reaching the child through the package', async () => {
    const { user, institute, student, pkg, board } = await scenario();

    const capture = await addBoard(user.id, institute.id, pkg.id, {
      boardId: board.id,
      detachFromStudent: true,
      assignPackageToStudent: true,
    });

    expect(capture.statusCode).toBe(201);
    expect((capture.jsonBody as any).assignedToStudent).toBe(true);
    expect(await packageRepository.isAssigned(pkg.id, student.id)).toBe(true);

    // Same board, same child — now as shared content.
    const reachable = await boardRepository.getStudentPickerBoards(student.id);
    expect(reachable.map((b) => b.id)).toEqual([board.id]);
  });

  it('REFUSES to move a board off a child the caller cannot reach', async () => {
    const { institute, pkg, board } = await scenario();
    const outsider = await makeUser();
    await addUserToInstitute(institute.id, outsider.id, { isAdmin: true });

    const capture = await addBoard(outsider.id, institute.id, pkg.id, {
      boardId: board.id,
      detachFromStudent: true,
    });

    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).error).toBe('error:STUDENT_ACCESS_DENIED');
    expect((await boardRepository.getBoard(board.id))?.scope).toBe('student');
  });

  it('a moved board is listed under the package, not under the child', async () => {
    const { user, institute, student, pkg, board } = await scenario();
    await addBoard(user.id, institute.id, pkg.id, {
      boardId: board.id,
      detachFromStudent: true,
      assignPackageToStudent: true,
    });

    const { body } = await library(user.id, {
      instituteId: institute.id,
      studentId: student.id,
    });

    expect(names(group(body, 'student', student.id))).toEqual([]);
    expect(names(group(body, 'package', pkg.id))).toEqual(['Mealtime']);
  });
});

describe('package membership bookkeeping', () => {
  afterEach(truncateAll);

  it('lists the boards of several packages in one pass', async () => {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const a = await makePackage(institute.id, user.id, { name: 'A' });
    const b = await makePackage(institute.id, user.id, { name: 'B' });
    const empty = await makePackage(institute.id, user.id, { name: 'C' });

    for (const [pkg, name] of [
      [a, 'A1'],
      [a, 'A2'],
      [b, 'B1'],
    ] as const) {
      const board = await makeBoard({
        userId: user.id,
        instituteId: institute.id,
        scope: 'package',
        name,
      });
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });
    }

    const contents = await packageRepository.listBoardsForPackages([a.id, b.id, empty.id]);

    expect(contents.get(a.id)?.map((x) => x.name).sort()).toEqual(['A1', 'A2']);
    expect(contents.get(b.id)?.map((x) => x.name)).toEqual(['B1']);
    expect(contents.has(empty.id)).toBe(false);
  });

  it('drops a board out of Not assigned once a package holds it', async () => {
    const user = await makeUser();
    const { institute } = await makeInstitute(user.id);
    const pkg = await makePackage(institute.id, user.id);
    const board = await makeBoard({
      userId: user.id,
      instituteId: institute.id,
      scope: 'package',
      name: 'Shared',
    });

    let unassigned = await boardRepository.getInstituteUnassignedBoards(institute.id, user.id);
    expect(unassigned.map((b) => b.name)).toEqual(['Shared']);

    await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });

    unassigned = await boardRepository.getInstituteUnassignedBoards(institute.id, user.id);
    expect(unassigned).toEqual([]);

    await db.delete(packageBoards).where(eq(packageBoards.boardId, board.id));

    unassigned = await boardRepository.getInstituteUnassignedBoards(institute.id, user.id);
    expect(unassigned.map((b) => b.name)).toEqual(['Shared']);
  });
});
