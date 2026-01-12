// server/controllers/fileUploadController.ts
// Controller for handling file uploads to OpenAI

import type { Request, Response } from "express";
import { openAIFileService } from "../services/chat/openai-file-service";

// Allowed file types for upload
const ALLOWED_MIME_TYPES = [
  // Documents
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  // Microsoft Office
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Images (for vision)
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // Code files
  "text/javascript",
  "text/typescript",
  "text/html",
  "text/css",
  "application/javascript",
];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export class FileUploadController {
  /**
   * POST /api/chat/files/upload
   * Upload a file for use in chat context
   */
  async uploadFile(req: Request, res: Response): Promise<void> {
    try {
      const file = req.file;
      const sessionId = req.body.sessionId;

      if (!file) {
        res.status(400).json({
          success: false,
          error: "No file provided",
        });
        return;
      }

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: "Session ID is required",
        });
        return;
      }

      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          error: `File type ${file.mimetype} is not supported`,
        });
        return;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        res.status(400).json({
          success: false,
          error: `File size exceeds maximum allowed (${MAX_FILE_SIZE / 1024 / 1024}MB)`,
        });
        return;
      }

      // Upload to OpenAI
      const result = await openAIFileService.uploadFile(
        sessionId,
        file.buffer,
        file.originalname,
        file.mimetype
      );

      if (!result.success) {
        res.status(500).json({
          success: false,
          error: result.error || "Failed to upload file",
        });
        return;
      }

      res.json({
        success: true,
        file: result.file,
      });
    } catch (error: any) {
      console.error("[FileUploadController] Upload error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Internal server error",
      });
    }
  }

  /**
   * DELETE /api/chat/files/:fileId
   * Delete a specific file
   */
  async deleteFile(req: Request, res: Response): Promise<void> {
    try {
      const { fileId } = req.params;

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: "File ID is required",
        });
        return;
      }

      const deleted = await openAIFileService.deleteFile(fileId);

      res.json({
        success: deleted,
        error: deleted ? undefined : "Failed to delete file",
      });
    } catch (error: any) {
      console.error("[FileUploadController] Delete error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Internal server error",
      });
    }
  }

  /**
   * DELETE /api/chat/sessions/:sessionId/files
   * Clean up all files for a session
   */
  async cleanupSessionFiles(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: "Session ID is required",
        });
        return;
      }

      await openAIFileService.cleanupSession(sessionId);

      res.json({
        success: true,
      });
    } catch (error: any) {
      console.error("[FileUploadController] Cleanup error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Internal server error",
      });
    }
  }

  /**
   * GET /api/chat/sessions/:sessionId/files
   * List files for a session
   */
  async listSessionFiles(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: "Session ID is required",
        });
        return;
      }

      const files = await openAIFileService.listSessionFiles(sessionId);

      res.json({
        success: true,
        files,
      });
    } catch (error: any) {
      console.error("[FileUploadController] List error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Internal server error",
      });
    }
  }
}

export const fileUploadController = new FileUploadController();
