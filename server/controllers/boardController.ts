import type { Request, Response } from "express";
import { z } from "zod";
import { boardRepository } from "../repositories";
import { analyticsService } from "../services/analyticsService";
import { boardGenerator } from "../services/boardGenerationService";

// Validation schemas
const generateBoardSchema = z.object({
  prompt: z.string().min(1),
  gridSize: z
    .object({
      rows: z.number().min(1).max(10),
      cols: z.number().min(1).max(10),
    })
    .optional(),
  boardContext: z.any().optional(),
  currentPageId: z.string().optional(),
});

const saveBoardSchema = z.object({
  name: z.string().min(1),
  irData: z.any(),
});

export class BoardController {
  /**
   * POST /api/board/generate
   * Generate a new board using AI
   */
  async generateBoard(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      const { prompt, gridSize, boardContext, currentPageId } =
        generateBoardSchema.parse(req.body);

      // Auto-detect analytics metadata
      const topic = analyticsService.detectTopic(prompt);
      const language = analyticsService.detectLanguage(prompt);
      const promptExcerpt = analyticsService.createExcerpt(prompt);

      // Create initial prompt record for API tracking
      const initialPromptRecord = await boardRepository.logPrompt({
        userId: req.user!.id,
        prompt,
        promptExcerpt,
        topic,
        language,
        promptLength: prompt.length,
        generatedBoardName: "Generating...",
        pagesGenerated: 0,
        success: false,
        processingTimeMs: 0,
      });

      // Use AI for intelligent board generation with API tracking
      const parsedBoard = await boardGenerator.runBoardGeneration(
        prompt,
        gridSize,
        req.user!.id,
        initialPromptRecord.id,
        boardContext && currentPageId
          ? { boardContext, currentPageId }
          : undefined
      );

      const processingTime = Date.now() - startTime;

      // Update the prompt record with final results
      const promptRecord = await boardRepository.logPrompt({
        userId: req.user!.id,
        prompt,
        promptExcerpt,
        topic,
        language,
        promptLength: prompt.length,
        generatedBoardName: parsedBoard.name,
        pagesGenerated: parsedBoard.pages ? parsedBoard.pages.length : 1,
        success: true,
        processingTimeMs: processingTime,
      });

      // Track analytics events
      await analyticsService.trackEvent(
        "prompt_created",
        req.user!.id,
        promptRecord.id
      );
      await analyticsService.trackEvent(
        "board_generated",
        req.user!.id,
        promptRecord.id,
        {
          boardName: parsedBoard.name,
          pagesGenerated: parsedBoard.pages ? parsedBoard.pages.length : 1,
        }
      );

      if (parsedBoard.pages) {
        for (let i = 0; i < parsedBoard.pages.length; i++) {
          await analyticsService.trackEvent(
            "board_page_created",
            req.user!.id,
            promptRecord.id,
            { pageIndex: i }
          );
        }
      }

      // Check for auto-backup to Dropbox
      try {
        const { DropboxService } = await import("../services/dropboxService");
        const dropboxService = new DropboxService();

        const userTokenResult = await dropboxService.getUserTokens(req.user!.id);

        if (userTokenResult) {
          const { accessToken, connection } = userTokenResult;

          if (connection.autoBackupEnabled) {
            console.log(
              `Auto-backup enabled for user ${req.user!.id}, uploading board "${parsedBoard.name}"`
            );

            try {
              const boardJson = JSON.stringify(parsedBoard, null, 2);
              const fileBuffer = Buffer.from(boardJson, "utf-8");
              const fileName = `${parsedBoard.name.replace(/[<>:"/\\|?*]/g, "_")}.json`;

              const filePath = dropboxService.generateFilePath(
                connection.backupFolderPath,
                fileName
              );

              await dropboxService.ensureFolderExists(
                accessToken,
                connection.backupFolderPath
              );

              const uploadResult = await dropboxService.uploadFile(
                accessToken,
                filePath,
                fileBuffer
              );

              const shareableUrl = await dropboxService.createShareableLink(
                accessToken,
                uploadResult.path
              );

              const { db } = await import("../db");
              const { dropboxBackups } = await import("@shared/schema");
              await db.insert(dropboxBackups).values({
                userId: req.user!.id,
                boardName: parsedBoard.name,
                fileType: "master_aac",
                fileName,
                dropboxPath: filePath,
                fileSizeBytes: fileBuffer.length,
                status: "completed",
                shareableUrl,
              });

              console.log(
                `Auto-backup completed: ${fileName} uploaded to ${filePath}`
              );
            } catch (backupError) {
              console.error("Auto-backup failed:", backupError);
            }
          }
        }
      } catch (autoBackupError) {
        console.error("Auto-backup error:", autoBackupError);
      }

      res.json(parsedBoard);
    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      console.error("Board generation error:", error);

      // Log the failed prompt with analytics
      try {
        const topic = req.body.prompt
          ? analyticsService.detectTopic(req.body.prompt)
          : "general";
        const language = req.body.prompt
          ? analyticsService.detectLanguage(req.body.prompt)
          : "en";
        const promptExcerpt = req.body.prompt
          ? analyticsService.createExcerpt(req.body.prompt)
          : "";
        const errorType = analyticsService.categorizeError(error.message);

        const promptRecord = await boardRepository.logPrompt({
          userId: req.user!.id,
          prompt: req.body.prompt || "Unknown prompt",
          promptExcerpt,
          topic,
          language,
          promptLength: req.body.prompt ? req.body.prompt.length : 0,
          success: false,
          errorMessage: error.message,
          errorType,
          processingTimeMs: processingTime,
        });

        await analyticsService.trackEvent(
          "prompt_created",
          req.user!.id,
          promptRecord.id
        );
        await analyticsService.trackEvent(
          "error_occurred",
          req.user!.id,
          promptRecord.id,
          { errorType, errorMessage: error.message }
        );
      } catch (logError) {
        console.error("Failed to log prompt error:", logError);
      }

      res.status(500).json({
        error: "Failed to generate board. Please try again.",
      });
    }
  }

  /**
   * POST /api/board/save
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
      res.json(boards);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/board/:id
   * Get specific board
   */
  async getBoard(req: Request, res: Response): Promise<void> {
    try {
      const board = await boardRepository.getBoard(req.params.id);
      if (!board || board.userId !== req.user!.id) {
        res.status(404).json({ error: "Board not found" });
        return;
      }
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
          await boardRepository.markPromptAsDownloaded(promptId);

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
          await boardRepository.markPromptAsDownloaded(promptId);

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
