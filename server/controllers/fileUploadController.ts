// server/controllers/fileUploadController.ts
// File upload endpoint — stores files in server-side cache for reference by chat tools.
//
// Entries are bound to the uploading user. An id is a capability (random
// UUID), but a capability alone must not let a caller read, replace or delete
// another user's upload — clinicians attach assessment documents here.

import type { Request, Response } from "express";
import { storeFile, restoreFile, deleteFile, getFile, fileOwnedBy } from "../services/chat/tools/media-file-cache";

export class FileUploadController {
  async uploadFile(req: Request, res: Response): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: "No file provided" });
      return;
    }

    // If a fileId is provided (re-upload of expired file), restore with the same ID
    const requestedId = req.body?.fileId || req.query?.fileId;
    let fileId: string;
    if (requestedId && typeof requestedId === "string") {
      if (!restoreFile(requestedId, file.buffer, file.mimetype, file.originalname, userId)) {
        res.status(403).json({ success: false, error: "File belongs to another user" });
        return;
      }
      fileId = requestedId;
    } else {
      fileId = storeFile(file.buffer, file.mimetype, file.originalname, userId);
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
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    const { fileId } = req.params;
    const file = getFile(fileId);
    // Same 404 for missing and not-yours: don't confirm another user's id exists.
    if (!file || !fileOwnedBy(file, userId)) {
      res.status(404).json({ success: false, error: "File not found or expired" });
      return;
    }
    console.log(`[FileCache] Serving ${fileId}: mime=${file.mimeType}, size=${file.buffer.length}`);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", file.buffer.length.toString());
    res.setHeader("Cache-Control", "no-store");
    res.end(file.buffer);
  }

  async deleteFileHandler(req: Request, res: Response): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    const { fileId } = req.params;
    const file = fileId ? getFile(fileId) : undefined;
    if (file && fileOwnedBy(file, userId)) deleteFile(fileId);
    res.json({ success: true });
  }
}

export const fileUploadController = new FileUploadController();
