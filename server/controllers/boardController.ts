import type { Request, Response } from "express";
import { z } from "zod";
import { boardRepository } from "../repositories";
import { analyticsService } from "../services/analyticsService";

const saveBoardSchema = z.object({
  name: z.string().min(1),
  irData: z.any(),
});

export class BoardController {

  /**
   * POST /api/boards
   * Save a board
   */
  async saveBoard(req: Request, res: Response): Promise<void> {
    try {
      const { name, irData } = saveBoardSchema.parse(req.body);

      const board = await boardRepository.createBoard({
        userId: req.user!.id,
        name,
        irData,
      });

      res.status(201).json(board);
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
   * GET /api/boards/:id
   * Get specific board
   */
  async getBoard(req: Request, res: Response): Promise<void> {
    try {
      const board = await boardRepository.getBoard(req.params.id);
      if (!board || board.userId !== req.user!.id) {
        res.status(404).json({ error: "Board not found" });
        return;
      }
      boardRepository.updateBoard(board.id, { loadedAt: new Date() });
      res.json(board);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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
