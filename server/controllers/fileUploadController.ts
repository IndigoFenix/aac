// server/controllers/fileUploadController.ts
// File upload endpoint — stores files in server-side cache for reference by chat tools

import type { Request, Response } from "express";
import { storeFile, restoreFile, deleteFile, getFile } from "../services/chat/tools/media-file-cache";

export class FileUploadController {
  async uploadFile(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: "No file provided" });
      return;
    }

    // If a fileId is provided (re-upload of expired file), restore with the same ID
    const requestedId = req.body?.fileId || req.query?.fileId;
    let fileId: string;
    if (requestedId && typeof requestedId === "string") {
      restoreFile(requestedId, file.buffer, file.mimetype, file.originalname);
      fileId = requestedId;
    } else {
      fileId = storeFile(file.buffer, file.mimetype, file.originalname);
    }

    res.json({
      success: true,
      file: {
        id: fileId,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
    });
  }

  async getFileHandler(req: Request, res: Response): Promise<void> {
    const { fileId } = req.params;
    console.log(`[FileCache] GET /api/chat/files/${fileId}`);
    const file = getFile(fileId);
    if (!file) {
      console.log(`[FileCache] File not found: ${fileId}`);
      res.status(404).json({ success: false, error: "File not found or expired" });
      return;
    }
    console.log(`[FileCache] Serving file: ${file.filename}, mime=${file.mimeType}, size=${file.buffer.length}`);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", file.buffer.length.toString());
    res.setHeader("Cache-Control", "no-cache");
    res.end(file.buffer);
  }

  async deleteFileHandler(req: Request, res: Response): Promise<void> {
    const { fileId } = req.params;
    if (fileId) deleteFile(fileId);
    res.json({ success: true });
  }
}

export const fileUploadController = new FileUploadController();
