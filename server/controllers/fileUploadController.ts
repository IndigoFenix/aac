// server/controllers/fileUploadController.ts
// Standalone file upload endpoint (files are now sent with chat messages via FormData,
// but this endpoint remains for validation/compatibility).

import type { Request, Response } from "express";

export class FileUploadController {
  async uploadFile(req: Request, res: Response): Promise<void> {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: "No file provided" });
      return;
    }
    // Just validate — file is not stored; clients send files with chat messages instead
    res.json({ success: true, file: { filename: file.originalname, mimeType: file.mimetype, size: file.size } });
  }

  async deleteFileHandler(_req: Request, res: Response): Promise<void> {
    res.json({ success: true });
  }
}

export const fileUploadController = new FileUploadController();
