import type { Request, Response } from "express";
import { z } from "zod";
import { boardRepository, packageRepository } from "../repositories";
import { instituteRepository } from "../repositories/instituteRepository";
import { studentRepository } from "../repositories/studentRepository";
import { analyticsService } from "../services/analyticsService";
import { activityLogService } from "../services/activityLogService";
import { studentService } from "../services/studentService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import { canEditPackage, resolvePackagePermission } from "../services/packages/packageAccess";
import type { AccessCtx } from "../services/sharing/visibility";
import type { BoardLibraryEntry, BoardLibraryGroup } from "@shared/board-library";

const saveBoardSchema = z.object({
  name: z.string().min(1),
  irData: z.any(),
  studentId: z.string().optional(),
  /**
   * The institute this board belongs to. REQUIRED: every board is owned by a
   * student or by an institute, so a board saved with no institute selected
   * would have no owner at all and would be invisible to everyone but its
   * author. See BoardController.saveBoard.
   */
  instituteId: z.string().optional(),
  automaticSelection: z.boolean().optional(),
  automaticSelectionHint: z.string().nullable().optional(),
  isGenerated: z.boolean().optional(),
});

/** The shape every access helper here needs off a board row. */
type BoardPrincipals = {
  id: string;
  userId: string;
  studentId: string | null;
  scope: string;
  instituteId: string | null;
};

/**
 * Can this caller read a board they did not author, because it belongs to a
 * package they can reach?
 *
 * Two routes in, matching the two callers:
 *   - clinician: holds `use` (or better) on a package containing the board
 *   - AAC device: acting for a student the board is attached to, named via
 *     `?studentId=` (the device already proves student access to reach this)
 *
 * Returns false for ordinary student-scoped boards — this is not a general
 * relaxation of board ownership.
 */
async function canReadPackageBoard(
  req: Request,
  board: { id: string; scope: string; instituteId?: string | null },
): Promise<boolean> {
  if (board.scope !== "package") return false;

  const studentId = typeof req.query.studentId === "string" ? req.query.studentId : undefined;
  if (studentId) {
    const { hasAccess } = await studentService.verifyStudentAccess(studentId, req.user!.id);
    if (hasAccess && (await boardRepository.isBoardInStudentPackages(board.id, studentId))) {
      return true;
    }
  }

  const ctx = await boardCtx(req, board);
  for (const pkg of await packageRepository.listPackagesForBoard(board.id)) {
    if ((await resolvePackagePermission(ctx, pkg.id)) !== "none") return true;
  }
  return false;
}

/**
 * The access context to resolve a board's package permissions with.
 *
 * `buildClinicianCtx` reads `?instituteId=`, which the board routes do not
 * carry — and package permission is resolved from the USER's memberships and
 * grants, never from the selected institute (see resolvePackagePermission), so
 * falling back to the board's OWN institute yields the same answer without the
 * query param. Without this fallback, whether a package board was readable or
 * writable would depend on which screen happened to make the call.
 */
async function boardCtx(
  req: Request,
  board: { instituteId?: string | null },
): Promise<AccessCtx> {
  return (
    (await buildClinicianCtx(req)) ?? {
      kind: "institute",
      instituteId: board.instituteId ?? "",
      userId: req.user!.id,
    }
  );
}

/**
 * May this caller act for this student? Wraps `verifyStudentAccess`, which
 * already grants a customer-support agent access to their support institute's
 * students (via the AsyncLocalStorage short-circuit in
 * `instituteRepository.isUserAdminOfInstitute`) — so support mode needs no
 * special case anywhere in this controller.
 */
async function hasStudentAccess(req: Request, studentId: string | null | undefined): Promise<boolean> {
  if (!studentId) return false;
  const { hasAccess } = await studentService.verifyStudentAccess(studentId, req.user!.id);
  return hasAccess;
}

/**
 * Can this caller WRITE a PACKAGE-scoped board?
 *
 * `edit` on any package that contains it. Being able to USE a package must
 * never let you rewrite content other institutes have attached — that is the
 * whole point of `defaultMemberPermission`, and of "publicly usable is never
 * publicly editable".
 *
 * A package board that no package contains any more is the institute's own
 * unattached content (it shows in the picker's "Not assigned" section), and
 * there is no membership row left to consult — so the owning institute's
 * members may edit it. That fallback is deliberately gated on `pkgs.length === 0`:
 * applying it to a board that IS in a package would hand every institute member
 * `edit` on packages whose defaultMemberPermission says `use`.
 *
 * See {@link boardCtx} for why the context does not come from `?instituteId=`.
 */
async function canWritePackageBoard(req: Request, board: BoardPrincipals): Promise<boolean> {
  const userId = req.user!.id;
  const ctx = await boardCtx(req, board);

  const pkgs = await packageRepository.listPackagesForBoard(board.id);
  for (const pkg of pkgs) {
    if (await canEditPackage(ctx, pkg.id)) return true;
  }
  if (pkgs.length === 0 && board.instituteId) {
    return instituteRepository.isUserMemberOfInstitute(board.instituteId, userId);
  }
  return false;
}

/**
 * Can this caller WRITE this board?
 *
 * Authorship, or access to the student the board is attached to. A board made
 * for a child belongs to that child's care team, not to whoever happened to
 * click Save — a co-clinician, an institute admin, or a support agent may all
 * edit it.
 *
 * An unattached board belongs to its INSTITUTE, so any member of that institute
 * may edit it: it is listed to all of them under "Not assigned", and a board
 * everyone can see but only one person can change is exactly the confusion the
 * picker rework set out to remove.
 *
 * Package boards resolve through `canWritePackageBoard` — see there.
 */
async function canWriteBoard(req: Request, board: BoardPrincipals): Promise<boolean> {
  if (board.scope === "package") return canWritePackageBoard(req, board);
  if (board.userId === req.user!.id) return true;
  if (await hasStudentAccess(req, board.studentId)) return true;
  if (!board.studentId && board.instituteId) {
    return instituteRepository.isUserMemberOfInstitute(board.instituteId, req.user!.id);
  }
  return false;
}

export class BoardController {

  /**
   * POST /api/boards
   * Save a board
   */
  async saveBoard(req: Request, res: Response): Promise<void> {
    try {
      const {
        name,
        irData,
        studentId,
        instituteId,
        automaticSelection,
        automaticSelectionHint,
        isGenerated,
      } = saveBoardSchema.parse(req.body);

      // Every board belongs to a student or to an institute. Without an
      // institute a board attached to nobody has no owner at all: nobody but
      // its author can ever see it, and it can never be added to a package.
      // So a board cannot be created with no institute selected.
      if (!instituteId) {
        res.status(400).json({ error: "error:INSTITUTE_REQUIRED" });
        return;
      }
      if (!(await instituteRepository.isUserMemberOfInstitute(instituteId, req.user!.id))) {
        res.status(403).json({ error: "error:INSTITUTE_ACCESS_DENIED" });
        return;
      }

      // Attaching a board to a student is a PHI write — prove access to that
      // student first, or the studentId is just an unchecked id from the body.
      if (studentId && !(await hasStudentAccess(req, studentId))) {
        res.status(403).json({ error: "error:STUDENT_ACCESS_DENIED" });
        return;
      }

      const board = await boardRepository.createBoard({
        userId: req.user!.id,
        name,
        irData,
        instituteId,
        ...(studentId ? { studentId } : {}),
        ...(automaticSelection !== undefined ? { automaticSelection } : {}),
        ...(automaticSelectionHint !== undefined ? { automaticSelectionHint } : {}),
        ...(isGenerated !== undefined ? { isGenerated } : {}),
      });

      res.status(201).json(board);

      activityLogService.log({
        userId: req.user!.id,
        eventType: "create",
        subjectType1: "board",
        subjectId1: board.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * GET /api/boards
   * Get user's boards. `?unassigned=1` narrows this to the caller's boards that
   * are attached to no student — the drafts the board picker offers to attach
   * to whichever student is loaded.
   */
  async getUserBoards(req: Request, res: Response): Promise<void> {
    try {
      if (req.query.unassigned === "1") {
        const drafts = await boardRepository.getUnassignedBoards(req.user!.id);
        res.json(drafts.sort((a, b) => b.loadedAt.getTime() - a.loadedAt.getTime()));
        return;
      }

      const boards = await boardRepository.getUserBoards(req.user!.id);
      // Get most recent board data
      const sortedBoards = boards.sort((a, b) => b.loadedAt.getTime() - a.loadedAt.getTime());
      if (sortedBoards.length > 0) {
        const mostRecentBoard = sortedBoards[0];
        // Update the loadedAt timestamp to now
        const boardData = await boardRepository.getBoard(mostRecentBoard.id);
        sortedBoards[0].irData = boardData?.irData;
        // Don't await this update
        boardRepository.updateBoard(mostRecentBoard.id, { loadedAt: new Date() });
      }
      res.json(boards);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/boards/library?instituteId=…[&studentId=…]
   *
   * The board picker's whole content, already grouped and already carrying
   * per-board editability, so the client never has to infer either.
   *
   * Two views, because the panel has two modes:
   *
   *   NO STUDENT — everything in this institute the caller can reach:
   *     "Not assigned" (institute boards with no student and no package),
   *     one section per package the institute owns,
   *     one section per student the caller can see, holding only the boards
   *     assigned DIRECTLY to that student.
   *
   *   A STUDENT — what that child can actually open:
   *     their own boards first, then every package attached to them —
   *     including public packages the caller may not edit, which they may
   *     still view. Those come back with `canEdit: false`, and the same
   *     answer is enforced on the write path (see canWriteBoard).
   *
   * Groups are ordered here, not on the client: the order is part of the
   * answer.
   */
  async getLibrary(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const instituteId = typeof req.query.instituteId === "string" ? req.query.instituteId : "";
      const studentId = typeof req.query.studentId === "string" ? req.query.studentId : "";

      // No institute selected is a legitimate state (the header lets you have
      // none), not an error — the picker just has nothing to show and says so
      // by way of canCreate.
      if (!instituteId) {
        res.json({ canCreate: false, groups: [] });
        return;
      }
      if (!(await instituteRepository.isUserMemberOfInstitute(instituteId, userId))) {
        res.status(403).json({ error: "error:INSTITUTE_ACCESS_DENIED" });
        return;
      }

      const ctx: AccessCtx = { kind: "institute", instituteId, userId };
      const groups: BoardLibraryGroup[] = [];

      /** One package section, with the boards it holds. */
      const packageGroup = async (
        pkg: { id: string; name: string },
        boardsIn: BoardLibraryEntry[],
      ): Promise<BoardLibraryGroup> => ({
        kind: "package",
        id: pkg.id,
        name: pkg.name,
        canEdit: await canEditPackage(ctx, pkg.id),
        boards: boardsIn.map((b) => ({ ...b, packageName: pkg.name })),
      });

      if (studentId) {
        if (!(await hasStudentAccess(req, studentId))) {
          res.status(403).json({ error: "error:STUDENT_ACCESS_DENIED" });
          return;
        }

        const [student, own, assigned] = await Promise.all([
          studentRepository.getStudentById(studentId),
          boardRepository.getStudentBoardsMetadata(studentId),
          packageRepository.listAssignedPackages(studentId),
        ]);

        groups.push({
          kind: "student",
          id: studentId,
          name: student?.firstName || student?.name || "",
          canEdit: true,
          boards: own,
        });

        const byName = [...assigned].sort((a, b) => a.name.localeCompare(b.name));
        const contents = await packageRepository.listBoardsForPackages(byName.map((p) => p.id));
        for (const pkg of byName) {
          groups.push(await packageGroup(pkg, contents.get(pkg.id) ?? []));
        }
      } else {
        const [unassigned, institutePackages, studentRows] = await Promise.all([
          boardRepository.getInstituteUnassignedBoards(instituteId, userId),
          packageRepository.listByInstitute(instituteId),
          studentRepository.getStudentsForUserInInstitute(userId, instituteId),
        ]);

        groups.push({
          kind: "unassigned",
          id: null,
          name: "",
          canEdit: true,
          boards: unassigned,
        });

        const contents = await packageRepository.listBoardsForPackages(
          institutePackages.map((p) => p.id),
        );
        for (const pkg of institutePackages) {
          groups.push(await packageGroup(pkg, contents.get(pkg.id) ?? []));
        }

        // One section per student, holding ONLY their direct boards — what
        // reaches them through a package is already shown under that package,
        // and repeating it per child would bury the picker.
        const students = studentRows.map((r) => r.student);
        const direct = await boardRepository.getBoardsForStudents(students.map((s) => s.id));
        const byStudent = new Map<string, typeof direct>();
        for (const b of direct) {
          const list = byStudent.get(b.studentId!) ?? [];
          list.push(b);
          byStudent.set(b.studentId!, list);
        }
        for (const s of students) {
          const own = byStudent.get(s.id) ?? [];
          if (own.length === 0) continue;
          groups.push({
            kind: "student",
            id: s.id,
            name: (s as any).firstName || s.name || "",
            canEdit: true,
            boards: own,
          });
        }
      }

      // A board can sit in two packages with different permissions. The write
      // path allows the edit if ANY of them does, so the picker must agree —
      // otherwise the same board reads as read-only under one section and
      // editable under another.
      const editable = new Set<string>();
      for (const g of groups) {
        if (!g.canEdit) continue;
        for (const b of g.boards) editable.add(b.id);
      }
      for (const g of groups) {
        g.boards = g.boards.map((b) => ({ ...b, canEdit: editable.has(b.id) }));
      }

      res.json({ canCreate: true, groups });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/boards/student/:studentId
   * Get boards for a specific student
   */
  async getStudentBoards(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;

      // The list is scoped by STUDENT, not by author, so access to the student
      // is what authorises the read. Without this gate the route would hand a
      // child's boards to anyone who could guess their id.
      if (!(await hasStudentAccess(req, studentId))) {
        res.status(403).json({ error: "error:STUDENT_ACCESS_DENIED" });
        return;
      }

      // Includes boards from packages attached to this student, auto-loading or
      // not — the picker shows everything, the AI only sees auto-load boards.
      const boards = await boardRepository.getStudentPickerBoards(studentId);
      const sortedBoards = boards.sort((a, b) => b.loadedAt.getTime() - a.loadedAt.getTime());
      res.json(sortedBoards);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/boards/:id
   * Get specific board
   */
  async getBoard(req: Request, res: Response): Promise<void> {
    try {
      const board = await boardRepository.getBoard(req.params.id);
      if (!board) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }

      // Readable by anyone who can reach it: the author, someone with access to
      // the student it is attached to (which is what the picker lists it for),
      // a user who can use one of its packages, or (the AAC case) a caller
      // acting for a student a package is attached to. Without the last two the
      // device could list a package board in the picker but never load its IR.
      const mayRead =
        board.userId === req.user!.id ||
        (await hasStudentAccess(req, board.studentId)) ||
        (await canReadPackageBoard(req, board));
      if (!mayRead) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }

      boardRepository.updateBoard(board.id, { loadedAt: new Date() });
      res.json(board);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * PATCH /api/boards/:id
   * Update a board
   */
  async updateBoard(req: Request, res: Response): Promise<void> {
    try {
      const board = await boardRepository.getBoard(req.params.id);
      if (!board) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }
      if (!(await canWriteBoard(req, board))) {
        // A board the caller can OPEN but not change (shared package content
        // they only hold `use` on) gets a straight answer — the picker greys
        // Save out for exactly this reason, and a 404 here would read as a bug.
        // Anything else stays a 404 so we don't confirm the row exists.
        const mayRead =
          board.userId === req.user!.id ||
          (await hasStudentAccess(req, board.studentId)) ||
          (await canReadPackageBoard(req, board));
        res.status(mayRead ? 403 : 404).json({
          error: mayRead ? "error:BOARD_READ_ONLY" : "error:BOARD_NOT_FOUND",
        });
        return;
      }

      const updateSchema = z.object({
        name: z.string().optional(),
        irData: z.unknown().optional(),
        automaticSelection: z.boolean().optional(),
        automaticSelectionHint: z.string().nullable().optional(),
        isGenerated: z.boolean().optional(),
        // Attaching an unassigned draft to the loaded student. One-way on
        // purpose: a board can be given to a student, never taken from one or
        // handed to a different one, so a child's board list cannot change
        // under them from another screen.
        studentId: z.string().optional(),
      }).strict();
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "error:INVALID_BODY", details: parsed.error.errors });
        return;
      }

      if (parsed.data.studentId !== undefined) {
        if (board.studentId && board.studentId !== parsed.data.studentId) {
          res.status(409).json({ error: "error:BOARD_ALREADY_ASSIGNED" });
          return;
        }
        if (!(await hasStudentAccess(req, parsed.data.studentId))) {
          res.status(403).json({ error: "error:STUDENT_ACCESS_DENIED" });
          return;
        }
      }

      // Drop undefined keys so we don't overwrite columns with null on partial updates.
      const updates: Record<string, any> = {};
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v !== undefined) updates[k] = v;
      }

      const updated = await boardRepository.updateBoard(board.id, updates);
      res.json(updated);

      activityLogService.log({
        userId: req.user!.id,
        eventType: "update",
        subjectType1: "board",
        subjectId1: req.params.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * POST /api/export/gridset
   * Export board as gridset format
   */
  async exportGridset(req: Request, res: Response): Promise<void> {
    return this.exportBoard(req, res, "gridset");
  }

  /**
   * POST /api/export/snappkg
   * Export board as snap package format
   */
  async exportSnappkg(req: Request, res: Response): Promise<void> {
    return this.exportBoard(req, res, "snappkg");
  }

  /**
   * A board authored for a student is PHI, and an export is that PHI leaving
   * the system as a file — so every export is an `export` audit row (with the
   * student when the board names one), in addition to the product analytics.
   */
  private async exportBoard(req: Request, res: Response, format: "gridset" | "snappkg"): Promise<void> {
    try {
      const { boardData, promptId } = req.body;

      // Track download analytics if promptId is provided
      if (promptId) {
        try {
          await analyticsService.trackEvent("board_downloaded", req.user!.id, promptId, {
            format,
            boardName: boardData.name,
          });
        } catch (analyticsError) {
          console.error("Failed to track download analytics:", analyticsError);
        }
      }

      const studentId: string | null = typeof boardData?.studentId === "string" ? boardData.studentId : null;
      activityLogService.log({
        userId: req.user!.id,
        eventType: "export",
        subjectType1: "board",
        subjectId1: typeof boardData?.id === "string" ? boardData.id : null,
        subjectType2: studentId ? "student" : null,
        subjectId2: studentId,
        details: { format },
      });

      res.json({ success: true, data: boardData });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const boardController = new BoardController();
