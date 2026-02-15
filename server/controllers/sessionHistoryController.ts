import type { Request, Response } from "express";
import { aacSessionRepository } from "../repositories/aacSessionRepository";
import { chatRepository } from "../repositories/chatRepository";

class SessionHistoryController {
  async getAACSessions(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const studentId = req.query.studentId as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const opts = { studentId, startDate, endDate, limit, offset };
      const [data, total] = await Promise.all([
        aacSessionRepository.getSessionsAdmin(opts),
        aacSessionRepository.getSessionsAdminCount(opts),
      ]);

      res.json({
        success: true,
        data,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (error: any) {
      console.error("Error fetching AAC sessions:", error);
      res.status(500).json({ success: false, message: "Failed to fetch AAC sessions" });
    }
  }

  async getAACSessionLog(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const log = await aacSessionRepository.getSessionConversationHistory(id);
      if (!log) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true, data: log });
    } catch (error: any) {
      console.error("Error fetching AAC session log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session log" });
    }
  }

  async getChatSessions(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const userId = req.query.userId as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const opts = { userId, startDate, endDate, limit, offset };
      const [data, total] = await Promise.all([
        chatRepository.getSessionsAdmin(opts),
        chatRepository.getSessionsAdminCount(opts),
      ]);

      res.json({
        success: true,
        data,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (error: any) {
      console.error("Error fetching chat sessions:", error);
      res.status(500).json({ success: false, message: "Failed to fetch chat sessions" });
    }
  }

  async getChatSessionLog(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const log = await chatRepository.getSessionLog(id);
      if (!log) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true, data: log });
    } catch (error: any) {
      console.error("Error fetching chat session log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session log" });
    }
  }
}

export const sessionHistoryController = new SessionHistoryController();
