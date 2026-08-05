import type { Request, Response } from "express";
import { z } from "zod";
import { boardRepository, packageRepository } from "../repositories";
import { analyticsService } from "../services/analyticsService";
import { activityLogService } from "../services/activityLogService";
import { studentService } from "../services/studentService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import { resolvePackagePermission } from "../services/packages/packageAccess";

const saveBoardSchema = z.object({
  name: z.string().min(1),
  irData: z.any(),
  studentId: z.string().optional(),
  automaticSelection: z.boolean().optional(),
  automaticSelectionHint: z.string().nullable().optional(),
  restSpace: z.enum(["none", "small", "large"]).optional(),
  isGenerated: z.boolean().optional(),
});

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
async function canReadPackageBoard(req: Request, board: { id: string; scope: string }): Promise<boolean> {
  if (board.scope !== "package") return false;

  const studentId = typeof req.query.studentId === "string" ? req.query.studentId : undefined;
  if (studentId) {
    const { hasAccess } = await studentService.verifyStudentAccess(studentId, req.user!.id);
    if (hasAccess && (await boardRepository.isBoardInStudentPackages(board.id, studentId))) {
      return true;
    }
  }

  const ctx = await buildClinicianCtx(req);
  if (!ctx) return false;
  for (const pkg of await packageRepository.listPackagesForBoard(board.id)) {
    if ((await resolvePackagePermission(ctx, pkg.id)) !== "none") return true;
  }
  return false;
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
 * Can this caller WRITE this board?
 *
 * Authorship, or access to the student the board is attached to. A board made
 * for a child belongs to that child's care team, not to whoever happened to
 * click Save — a co-clinician, an institute admin, or a support agent may all
 * edit it. Package boards are deliberately NOT included: being able to USE a
 * package must not let you rewrite content other institutes have attached.
 */
async function canWriteBoard(req: Request, board: { userId: string; studentId: string | null }): Promise<boolean> {
  if (board.userId === req.user!.id) return true;
  return hasStudentAccess(req, board.studentId);
}

export class BoardController {

  /**
   * POST /api/boards
   * Save a board
   */
  async saveBoard(req: Request, res: Response): Promise<void> {
    try {
      const { name, irData, studentId, automaticSelection, automaticSelectionHint, restSpace, isGenerated } =
        saveBoardSchema.parse(req.body);

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
        ...(studentId ? { studentId } : {}),
        ...(automaticSelection !== undefined ? { automaticSelection } : {}),
        ...(automaticSelectionHint !== undefined ? { automaticSelectionHint } : {}),
        ...(restSpace !== undefined ? { restSpace } : {}),
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
      if (!board || !(await canWriteBoard(req, board))) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }

      const updateSchema = z.object({
        name: z.string().optional(),
        irData: z.unknown().optional(),
        automaticSelection: z.boolean().optional(),
        automaticSelectionHint: z.string().nullable().optional(),
        restSpace: z.enum(["none", "small", "large"]).optional(),
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
    try {
      const { boardData, promptId } = req.body;

      // Track download analytics if promptId is provided
      if (promptId) {
        try {

          await analyticsService.trackEvent(
            "board_downloaded",
            req.user!.id,
            promptId,
            {
              format: "gridset",
              boardName: boardData.name,
            }
          );
        } catch (analyticsError) {
          console.error("Failed to track download analytics:", analyticsError);
        }
      }

      res.json({ success: true, data: boardData });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/export/snappkg
   * Export board as snap package format
   */
  async exportSnappkg(req: Request, res: Response): Promise<void> {
    try {
      const { boardData, promptId } = req.body;

      // Track download analytics if promptId is provided
      if (promptId) {
        try {

          await analyticsService.trackEvent(
            "board_downloaded",
            req.user!.id,
            promptId,
            {
              format: "snappkg",
              boardName: boardData.name,
            }
          );
        } catch (analyticsError) {
          console.error("Failed to track download analytics:", analyticsError);
        }
      }

      res.json({ success: true, data: boardData });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const boardController = new BoardController();
