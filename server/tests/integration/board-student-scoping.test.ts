/**
 * Board visibility is scoped by STUDENT, not by author.
 *
 * The bug this pins: `/api/boards/student/:id` filtered on `boards.userId =
 * caller`, with an `OR studentId IS NULL` arm. Two things followed, and both
 * were visible in the "Generate AAC Boards" panel:
 *
 *   - a colleague's board for a child you both treat was missing, and a
 *     customer-support agent (whose `req.user.id` is their own admin id, never
 *     the institute's clinician) saw NONE of the customer's boards — only
 *     their own;
 *   - every board you ever saved with no student loaded appeared under EVERY
 *     student you opened, because a null studentId matched them all.
 *
 * So: a student's boards belong to that student's care team, and an unattached
 * board belongs to nobody until someone attaches it.
 *
 * See docs/SECURITY_ARCHITECTURE.md §5.4 for the access model this aligns with.
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
import { boards } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { boardRepository } from '../../repositories/boardRepository.js';
import { boardController } from '../../controllers/boardController.js';
import { studentService } from '../../services/studentService.js';
import { runWithSupportContext } from '../../services/customerSupportService.js';

const IR = { grid: { rows: 2, cols: 2 }, pages: [{ id: 'main', buttons: [] }] };

async function makeBoard(
  userId: string,
  studentId: string | null,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const [row] = await db
    .insert(boards)
    .values({ userId, studentId, name, irData: IR, ...extra } as any)
    .returning();
  return row;
}

describe('board visibility is student-scoped', () => {
  afterEach(truncateAll);

  describe('the picker list', () => {
    it("shows a COLLEAGUE's board for a shared student", async () => {
      const author = await makeUser();
      const colleague = await makeUser();
      const { student } = await makeStudent(author.id);
      await studentService.linkUserToStudent(colleague.id, student.id, 'clinician');

      await makeBoard(author.id, student.id, 'Morning Routine');

      const req = makeReq({ user: { id: colleague.id }, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      await boardController.getStudentBoards(req, res);

      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any[]).map((b) => b.name)).toEqual(['Morning Routine']);
    });

    it('does NOT leak an unattached draft into a student list', async () => {
      const author = await makeUser();
      const { student } = await makeStudent(author.id);
      await makeBoard(author.id, student.id, 'Attached');
      await makeBoard(author.id, null, 'Loose Draft');

      const forStudent = await boardRepository.getStudentPickerBoards(student.id);
      expect(forStudent.map((b) => b.name)).toEqual(['Attached']);

      // It is not lost — it is listed separately so the picker can offer to
      // attach it.
      const drafts = await boardRepository.getUnassignedBoards(author.id);
      expect(drafts.map((b) => b.name)).toEqual(['Loose Draft']);
    });

    it("keeps one author's draft out of ANOTHER author's draft list", async () => {
      const a = await makeUser();
      const b = await makeUser();
      await makeBoard(a.id, null, 'Mine');

      expect(await boardRepository.getUnassignedBoards(b.id)).toEqual([]);
    });

    it('REFUSES a caller with no access to the student', async () => {
      const author = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(author.id);
      await makeBoard(author.id, student.id, 'Private');

      const req = makeReq({ user: { id: stranger.id }, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      await boardController.getStudentBoards(req, res);

      expect(capture.statusCode).toBe(403);
      expect((capture.jsonBody as any).error).toBe('error:STUDENT_ACCESS_DENIED');
    });

    it("shows the customer's boards to a support agent in support mode", async () => {
      const clinician = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(clinician.id);
      const { student } = await makeStudent(clinician.id);
      await enrollStudent(institute.id, student.id, clinician.id);
      await makeBoard(clinician.id, student.id, 'Snack Time');
      // The agent's own unrelated board, which used to be ALL they could see.
      await makeBoard(support.id, null, 'Support Scratch');

      const req = makeReq({ user: { id: support.id }, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      // supportContext middleware puts the institute in AsyncLocalStorage; the
      // access check reads it via isUserAdminOfInstitute.
      await runWithSupportContext(institute.id, () => boardController.getStudentBoards(req, res));

      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any[]).map((b) => b.name)).toEqual(['Snack Time']);
    });

    it('refuses that same agent once the support session is over', async () => {
      const clinician = await makeUser();
      const support = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(clinician.id);
      const { student } = await makeStudent(clinician.id);
      await enrollStudent(institute.id, student.id, clinician.id);
      await makeBoard(clinician.id, student.id, 'Snack Time');

      const req = makeReq({ user: { id: support.id }, params: { studentId: student.id } });
      const { res, capture } = makeRes();
      await boardController.getStudentBoards(req, res);

      expect(capture.statusCode).toBe(403);
    });
  });

  describe('reading and writing one board', () => {
    it('lets an institute admin load the IR of a board they did not author', async () => {
      const clinician = await makeUser();
      const admin = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, clinician.id);
      const { student } = await makeStudent(clinician.id);
      // The CLINICIAN enrolls: assignStudentToInstitute needs the requester to
      // hold both institute membership and access to the student, and the
      // admin has no route to the student until it is enrolled.
      await enrollStudent(institute.id, student.id, clinician.id);
      const board = await makeBoard(clinician.id, student.id, 'Lunch');

      const req = makeReq({ user: { id: admin.id }, params: { id: board.id } });
      const { res, capture } = makeRes();
      await boardController.getBoard(req, res);

      expect(capture.statusCode).toBe(200);
      expect((capture.jsonBody as any).irData).toBeTruthy();
    });

    it('lets a colleague EDIT a board for their shared student', async () => {
      const author = await makeUser();
      const colleague = await makeUser();
      const { student } = await makeStudent(author.id);
      await studentService.linkUserToStudent(colleague.id, student.id, 'clinician');
      const board = await makeBoard(author.id, student.id, 'Before');

      const req = makeReq({
        user: { id: colleague.id },
        params: { id: board.id },
        body: { name: 'After' },
      });
      const { res, capture } = makeRes();
      await boardController.updateBoard(req, res);

      expect(capture.statusCode).toBe(200);
      const [stored] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(stored.name).toBe('After');
    });

    it('still refuses a stranger, on both read and write', async () => {
      const author = await makeUser();
      const stranger = await makeUser();
      const { student } = await makeStudent(author.id);
      const board = await makeBoard(author.id, student.id, 'Private');

      const readReq = makeReq({ user: { id: stranger.id }, params: { id: board.id } });
      const read = makeRes();
      await boardController.getBoard(readReq, read.res);
      expect(read.capture.statusCode).toBe(404);

      const writeReq = makeReq({
        user: { id: stranger.id },
        params: { id: board.id },
        body: { name: 'Hijacked' },
      });
      const write = makeRes();
      await boardController.updateBoard(writeReq, write.res);
      expect(write.capture.statusCode).toBe(404);

      const [stored] = await db.select().from(boards).where(eq(boards.id, board.id));
      expect(stored.name).toBe('Private');
    });
  });

  describe('attaching a draft to a student', () => {
    it('attaches an unattached board to a student the caller can reach', async () => {
      const author = await makeUser();
      const { student } = await makeStudent(author.id);
      const board = await makeBoard(author.id, null, 'Draft');

      const req = makeReq({
        user: { id: author.id },
        params: { id: board.id },
        body: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.updateBoard(req, res);

      expect(capture.statusCode).toBe(200);
      const forStudent = await boardRepository.getStudentPickerBoards(student.id);
      expect(forStudent.map((b) => b.name)).toEqual(['Draft']);
    });

    it('REFUSES to move a board off the student it already belongs to', async () => {
      const author = await makeUser();
      const { student: first } = await makeStudent(author.id);
      const { student: second } = await makeStudent(author.id);
      const board = await makeBoard(author.id, first.id, 'Theirs');

      const req = makeReq({
        user: { id: author.id },
        params: { id: board.id },
        body: { studentId: second.id },
      });
      const { res, capture } = makeRes();
      await boardController.updateBoard(req, res);

      expect(capture.statusCode).toBe(409);
      expect((capture.jsonBody as any).error).toBe('error:BOARD_ALREADY_ASSIGNED');
    });

    it('REFUSES to attach to a student the caller cannot reach', async () => {
      const author = await makeUser();
      const other = await makeUser();
      const { student } = await makeStudent(other.id);
      const board = await makeBoard(author.id, null, 'Draft');

      const req = makeReq({
        user: { id: author.id },
        params: { id: board.id },
        body: { studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.updateBoard(req, res);

      expect(capture.statusCode).toBe(403);
    });

    it('REFUSES to create a board against a student the caller cannot reach', async () => {
      const author = await makeUser();
      const other = await makeUser();
      const { student } = await makeStudent(other.id);
      const { institute } = await makeInstitute(author.id);

      const req = makeReq({
        user: { id: author.id },
        body: { name: 'Sneaky', irData: IR, instituteId: institute.id, studentId: student.id },
      });
      const { res, capture } = makeRes();
      await boardController.saveBoard(req, res);

      expect(capture.statusCode).toBe(403);
      expect(await boardRepository.getStudentPickerBoards(student.id)).toEqual([]);
    });
  });

  describe('isGenerated ("Update Automatically") round-trips', () => {
    it('persists on create', async () => {
      const author = await makeUser();
      const { student } = await makeStudent(author.id);
      const { institute } = await makeInstitute(author.id);

      const req = makeReq({
        user: { id: author.id },
        body: {
          name: 'Live',
          irData: IR,
          instituteId: institute.id,
          studentId: student.id,
          isGenerated: true,
        },
      });
      const { res, capture } = makeRes();
      await boardController.saveBoard(req, res);

      expect(capture.statusCode).toBe(201);
      const stored = await boardRepository.getBoard((capture.jsonBody as any).id);
      expect(stored?.isGenerated).toBe(true);
    });

    it('persists on update instead of rejecting the whole save', async () => {
      const author = await makeUser();
      const { student } = await makeStudent(author.id);
      const board = await makeBoard(author.id, student.id, 'Live');

      const req = makeReq({
        user: { id: author.id },
        params: { id: board.id },
        body: { name: 'Live', irData: IR, isGenerated: true },
      });
      const { res, capture } = makeRes();
      await boardController.updateBoard(req, res);

      // The strict update schema used to omit isGenerated, so sending it
      // 400'd and took the board's content with it.
      expect(capture.statusCode).toBe(200);
      const stored = await boardRepository.getBoard(board.id);
      expect(stored?.isGenerated).toBe(true);
    });
  });

  describe('what the session AI is offered', () => {
    it("auto-loads a clinician's board for a session run by a caretaker", async () => {
      const clinician = await makeUser();
      const caretaker = await makeUser();
      const { student } = await makeStudent(clinician.id);
      await studentService.linkUserToStudent(caretaker.id, student.id, 'caregiver');
      await makeBoard(clinician.id, student.id, 'Mealtime', {
        automaticSelection: true,
        automaticSelectionHint: 'during meals',
      });

      // Author scoping meant the device — signed in as the caretaker — was
      // offered nothing at all.
      const available = await boardRepository.getAutoSelectableBoardsWithPackages(student.id);
      expect(available.map((b) => b.name)).toEqual(['Mealtime']);
    });

    it('never offers an unattached draft', async () => {
      const author = await makeUser();
      const { student } = await makeStudent(author.id);
      await makeBoard(author.id, null, 'Loose', { automaticSelection: true });

      expect(await boardRepository.getAutoSelectableBoardsWithPackages(student.id)).toEqual([]);
    });
  });
});
