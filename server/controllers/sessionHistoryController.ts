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
        costBreakdown: s.costBreakdown,
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

  /**
   * Bulk-delete all session debug logs recorded before a given date.
   * Body: { before: string } — an ISO date/datetime (e.g. "2026-05-01").
   * Admin maintenance to prune the debug trace table.
   */
  async deleteSessionDebugLogsBefore(req: Request, res: Response): Promise<void> {
    try {
      const before = typeof req.body?.before === "string" ? req.body.before.trim() : "";
      const cutoff = new Date(before);
      if (!before || Number.isNaN(cutoff.getTime())) {
        res.status(400).json({ success: false, message: "A valid 'before' date is required" });
        return;
      }
      const deleted = await chatRepository.deleteSessionDebugLogsBefore(cutoff);
      res.json({ success: true, deleted, before: cutoff.toISOString() });
    } catch (error: any) {
      console.error("Error deleting session debug logs:", error);
      res.status(500).json({ success: false, message: "Failed to delete session debug logs" });
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
