import type { Request, Response } from "express";
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
        chatRepository.getAACSessionsAdmin(opts),
        chatRepository.getAACSessionsAdminCount(opts),
      ]);

      const normalized = data.map((s) => ({
        id: s.id,
        studentId: s.studentId,
        studentName: s.studentName,
        userId: s.userId,
        userName: s.userName,
        creditsUsed: s.creditsUsed,
        status: s.status === "open" ? "active" : s.status === "closed" ? "ended" : s.status,
        started: s.started,
        lastActivity: s.lastUpdate,
        ended: s.status === "closed" ? s.lastUpdate : null,
      }));

      res.json({
        success: true,
        data: normalized,
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
      const session = await chatRepository.getSessionLog(id);
      if (!session) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({
        success: true,
        data: session.log,
        title: session.title,
        summary: session.summary,
        importance: session.importance,
      });
    } catch (error: any) {
      console.error("Error fetching AAC session log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session log" });
    }
  }

  async getSessionDebugLog(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const section = (req.query.section as string) || undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await chatRepository.getSessionDebugLog(id, { section, limit, offset });
      if (!result) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({
        success: true,
        data: result.entries,
        pagination: {
          total: result.total,
          limit: limit ?? 500,
          offset: offset ?? 0,
          hasMore: (offset ?? 0) + result.entries.length < result.total,
        },
      });
    } catch (error: any) {
      console.error("Error fetching session debug log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session debug log" });
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
      const session = await chatRepository.getSessionLog(id);
      if (!session) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({
        success: true,
        data: session.log,
        title: session.title,
        summary: session.summary,
        importance: session.importance,
      });
    } catch (error: any) {
      console.error("Error fetching chat session log:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session log" });
    }
  }
}

export const sessionHistoryController = new SessionHistoryController();
