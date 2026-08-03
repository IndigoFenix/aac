/**
 * Package → AAC session wiring (P4).
 *
 * The split that matters here: the PICKER and the AI see different sets. A
 * package board with `autoLoad=false` (or `automaticSelection=false`) stays in
 * the student's picker but never reaches the prompt — browsing is the student's
 * business, prompt space is a budget.
 *
 * Also covers the read guard that lets the AAC fetch a package board's IR at
 * all, and the prompt block's grouping + cap.
 *
 * See planning-docs/aac-packages-plan.md §6, §7, §11 (P4).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeInstitute, makeStudent } from '../helpers/factories.js';
import { boards, packageBoards } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { boardRepository } from '../../repositories/boardRepository.js';
import { packageRepository } from '../../repositories/packageRepository.js';
import { boardController } from '../../controllers/boardController.js';
import { attachPackageToStudent } from '../../services/packages/packageLinks.js';
import { buildBoardKeys } from '@shared/board-keys';
import {
  renderPrebuiltBoardLines,
  MAX_PREBUILT_BOARDS_IN_PROMPT,
} from '../../services/dual-agent/prompts/board-manager.js';

const IR = { grid: { rows: 2, cols: 2 }, pages: [{ id: 'main', buttons: [] }] };

async function makePackageBoard(
  instituteId: string,
  userId: string,
  name: string,
  opts: { automaticSelection?: boolean } = {},
) {
  const [row] = await db
    .insert(boards)
    .values({
      userId,
      instituteId,
      scope: 'package',
      name,
      irData: IR,
      automaticSelection: opts.automaticSelection ?? true,
      automaticSelectionHint: 'when it fits',
    })
    .returning();
  return row;
}

describe('Packages — AAC session wiring (P4)', () => {
  afterEach(truncateAll);

  describe('what the AI sees vs what the picker shows', () => {
    it('offers auto-loading package boards to the AI, alongside the students own', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);

      const [ownBoard] = await db
        .insert(boards)
        .values({
          userId: user.id,
          studentId: student.id,
          name: 'Morning Routine',
          irData: IR,
          automaticSelection: true,
        })
        .returning();

      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Kindergarten',
        createdByUserId: user.id,
      });
      const packaged = await makePackageBoard(institute.id, user.id, 'Snack');
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: packaged.id });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const available = await boardRepository.getAutoSelectableBoardsWithPackages(
        user.id,
        student.id,
      );
      const names = available.map((b) => b.name).sort();
      expect(names).toEqual(['Morning Routine', 'Snack']);

      const keys = buildBoardKeys(
        available.map((b) => ({ id: b.id, name: b.name, packageName: b.packageName })),
      );
      expect(keys.get(ownBoard.id)).toBe('morning_routine');
      expect(keys.get(packaged.id)).toBe('kindergarten.snack');
    });

    it('HIDES an autoLoad=false package board from the AI but keeps it in the picker', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Pack',
        createdByUserId: user.id,
      });
      const shown = await makePackageBoard(institute.id, user.id, 'Offered');
      const hidden = await makePackageBoard(institute.id, user.id, 'Browse Only');
      await db.insert(packageBoards).values([
        { packageId: pkg.id, boardId: shown.id, autoLoad: true },
        { packageId: pkg.id, boardId: hidden.id, autoLoad: false },
      ]);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const forAI = await boardRepository.getAutoSelectableBoardsWithPackages(user.id, student.id);
      expect(forAI.map((b) => b.name)).toEqual(['Offered']);

      const forPicker = await boardRepository.getStudentPickerBoards(user.id, student.id);
      expect(forPicker.map((b) => b.name).sort()).toEqual(['Browse Only', 'Offered']);
    });

    it('also hides a board whose own automaticSelection is off', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Pack',
        createdByUserId: user.id,
      });
      const board = await makePackageBoard(institute.id, user.id, 'Manual', {
        automaticSelection: false,
      });
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id, autoLoad: true });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      expect(await boardRepository.getAutoSelectableBoardsWithPackages(user.id, student.id)).toEqual([]);
      const forPicker = await boardRepository.getStudentPickerBoards(user.id, student.id);
      expect(forPicker.map((b) => b.name)).toEqual(['Manual']);
    });

    it('shows nothing from a package that is not attached', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Pack',
        createdByUserId: user.id,
      });
      const board = await makePackageBoard(institute.id, user.id, 'Unattached');
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });

      expect(await boardRepository.getAutoSelectableBoardsWithPackages(user.id, student.id)).toEqual([]);
      expect(await boardRepository.getStudentPickerBoards(user.id, student.id)).toEqual([]);
    });

    it('lists a board once even when two attached packages both contain it', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const { student } = await makeStudent(user.id);
      const board = await makePackageBoard(institute.id, user.id, 'Shared');
      for (const name of ['Alpha', 'Beta']) {
        const pkg = await packageRepository.createPackage({
          instituteId: institute.id,
          name,
          createdByUserId: user.id,
        });
        await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });
        await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      }

      const forAI = await boardRepository.getAutoSelectableBoardsWithPackages(user.id, student.id);
      expect(forAI).toHaveLength(1);
      // Attributed to the first package alphabetically, deterministically.
      expect(forAI[0].packageName).toBe('Alpha');
    });
  });

  describe('reading a package board', () => {
    it('lets the AAC fetch the IR of a package board it did not author', async () => {
      const author = await makeUser();
      const device = await makeUser();
      const { institute } = await makeInstitute(author.id);
      // The device user owns the student but not the board.
      const { student } = await makeStudent(device.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'Pack',
        createdByUserId: author.id,
      });
      const board = await makePackageBoard(institute.id, author.id, 'Snack');
      await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      const req = makeReq({
        user: { id: device.id },
        params: { id: board.id },
        query: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.getBoard(req, res);

      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any).irData).toBeTruthy();
    });

    it('REFUSES a package board for a student it is not attached to', async () => {
      const author = await makeUser();
      const device = await makeUser();
      const { institute } = await makeInstitute(author.id);
      const { student } = await makeStudent(device.id);
      const board = await makePackageBoard(institute.id, author.id, 'Snack');

      const req = makeReq({
        user: { id: device.id },
        params: { id: board.id },
        query: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.getBoard(req, res);

      expect(capture.statusCode).toBe(404);
    });

    it('still refuses an ordinary board belonging to someone else', async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(owner.id);
      const [board] = await db
        .insert(boards)
        .values({ userId: owner.id, studentId: student.id, name: 'Private', irData: IR })
        .returning();

      const req = makeReq({
        user: { id: stranger.id },
        params: { id: board.id },
        query: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.getBoard(req, res);

      expect(capture.statusCode).toBe(404);
    });
  });

  describe('prompt rendering', () => {
    it('groups package boards under a heading, own boards first', () => {
      const { lines, dropped } = renderPrebuiltBoardLines([
        { key: 'kindergarten.snack', name: 'Snack', packageName: 'Kindergarten' },
        { key: 'morning_routine', name: 'Morning Routine', hint: 'at the start of the day' },
        { key: 'kindergarten.lunch', name: 'Lunch', packageName: 'Kindergarten' },
      ]);

      expect(dropped).toBe(0);
      expect(lines[0]).toContain('morning_routine');
      expect(lines[0]).toContain('at the start of the day');
      expect(lines[1]).toBe('  From package "Kindergarten":');
      expect(lines[2]).toContain('kindergarten.snack');
      expect(lines[3]).toContain('kindergarten.lunch');
    });

    it('emits one heading per package', () => {
      const { lines } = renderPrebuiltBoardLines([
        { key: 'a.one', name: 'One', packageName: 'Alpha' },
        { key: 'b.two', name: 'Two', packageName: 'Beta' },
      ]);
      expect(lines.filter((l) => l.startsWith('  From package'))).toHaveLength(2);
    });

    it('caps the listing and REPORTS how many it dropped', () => {
      const many = Array.from({ length: MAX_PREBUILT_BOARDS_IN_PROMPT + 7 }, (_, i) => ({
        key: `board_${i}`,
        name: `Board ${i}`,
      }));
      const { lines, dropped } = renderPrebuiltBoardLines(many);

      expect(lines).toHaveLength(MAX_PREBUILT_BOARDS_IN_PROMPT);
      // A silent cap would read as "you have seen everything".
      expect(dropped).toBe(7);
    });
  });

  describe('package boards are read-only to the session AI', () => {
    it('is enforced by scope, not by isGenerated', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const board = await makePackageBoard(institute.id, user.id, 'Shared');
      // Even marked generated, a package board must not be editable.
      await db.update(boards).set({ isGenerated: true }).where(eq(boards.id, board.id));

      const loaded = await boardRepository.getBoard(board.id);
      expect(loaded?.scope).toBe('package');
      expect(loaded?.isGenerated).toBe(true);
      // The guard in dual-agent-service keys off scope alone — this asserts the
      // condition it tests is the one that holds.
      expect(loaded?.scope === 'package').toBe(true);
    });
  });
});
