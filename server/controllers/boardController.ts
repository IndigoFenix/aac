import type { Request, Response } from "express";
import { z } from "zod";
import { boardRepository } from "../repositories";
import { analyticsService } from "../services/analyticsService";
import { activityLogService } from "../services/activityLogService";

const saveBoardSchema = z.object({
  name: z.string().min(1),
  irData: z.any(),
  studentId: z.string().optional(),
  automaticSelection: z.boolean().optional(),
  automaticSelectionHint: z.string().nullable().optional(),
});

export class BoardController {

  /**
   * POST /api/boards
   * Save a board
   */
  async saveBoard(req: Request, res: Response): Promise<void> {
    try {
      const { name, irData, studentId, automaticSelection, automaticSelectionHint } =
        saveBoardSchema.parse(req.body);

      const board = await boardRepository.createBoard({
        userId: req.user!.id,
        name,
        irData,
        ...(studentId ? { studentId } : {}),
        ...(automaticSelection !== undefined ? { automaticSelection } : {}),
        ...(automaticSelectionHint !== undefined ? { automaticSelectionHint } : {}),
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
   * Get user's boards
   */
  async getUserBoards(req: Request, res: Response): Promise<void> {
    try {
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
      const boards = await boardRepository.getStudentBoardsMetadata(req.user!.id, studentId);
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
      if (!board || board.userId !== req.user!.id) {
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
      if (!board || board.userId !== req.user!.id) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }

      const updateSchema = z.object({
        name: z.string().optional(),
        irData: z.unknown().optional(),
        automaticSelection: z.boolean().optional(),
        automaticSelectionHint: z.string().nullable().optional(),
      }).strict();
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "error:INVALID_BODY", details: parsed.error.errors });
        return;
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
