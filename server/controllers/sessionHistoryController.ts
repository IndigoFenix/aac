import type { Request, Response } from "express";
import { chatRepository } from "../repositories/chatRepository";
import { activityLogService } from "../services/activityLogService";

class SessionHistoryController {
  async getAACSessions(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const studentId = req.query.studentId as string | undefined;
      const student = (req.query.student as string | undefined)?.trim() || undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;
      const minCost = req.query.minCost != null ? parseFloat(req.query.minCost as string) : undefined;
      const maxCost = req.query.maxCost != null ? parseFloat(req.query.maxCost as string) : undefined;
      const minDurationMin =
        req.query.minDurationMin != null ? parseFloat(req.query.minDurationMin as string) : undefined;
      const maxDurationMin =
        req.query.maxDurationMin != null ? parseFloat(req.query.maxDurationMin as string) : undefined;
      const minImportance =
        req.query.minImportance != null ? parseInt(req.query.minImportance as string, 10) : undefined;

      const opts = {
        studentId,
        student,
        startDate,
        endDate,
        minCost: Number.isFinite(minCost) ? minCost : undefined,
        maxCost: Number.isFinite(maxCost) ? maxCost : undefined,
        minDurationMin: Number.isFinite(minDurationMin) ? minDurationMin : undefined,
        maxDurationMin: Number.isFinite(maxDurationMin) ? maxDurationMin : undefined,
        minImportance: Number.isFinite(minImportance) ? minImportance : undefined,
        limit,
        offset,
      };

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
        costModalityBreakdown: s.costModalityBreakdown,
        status: s.status === "open" ? "active" : s.status === "closed" ? "ended" : s.status,
        started: s.started,
        lastActivity: s.lastUpdate,
        ended: s.status === "closed" ? s.lastUpdate : null,
        importance: s.importance,
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
      // A backoffice admin reading a child's full session transcript — the
      // reader owns nothing here, so every such read is audited.
      activityLogService.log({
        userId: req.user?.id ?? null,
        eventType: "view",
        subjectType1: "chat_session",
        subjectId1: id,
        subjectType2: session.studentId ? "student" : null,
        subjectId2: session.studentId,
        details: { viaAdmin: true },
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
   * The per-charge cost time-series for one session — ordered oldest→newest so
   * the client can chart how a session's spend accrued over time. Query:
   * ?limit&offset. Unlike the debug log, this is recorded for every session
   * (not just debug-mode ones).
   */
  async getSessionCostEvents(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await chatRepository.getSessionCostEvents(id, { limit, offset });
      if (!result) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({
        success: true,
        data: result.entries,
        pagination: {
          total: result.total,
          limit: limit ?? 1000,
          offset: offset ?? 0,
          hasMore: (offset ?? 0) + result.entries.length < result.total,
        },
      });
    } catch (error: any) {
      console.error("Error fetching session cost events:", error);
      res.status(500).json({ success: false, message: "Failed to fetch session cost events" });
    }
  }

  /**
   * Bulk-delete verbose per-session logging recorded before a given date —
   * both the debug trace (`session_debug_logs`) and the per-charge cost
   * time-series (`session_cost_events`). Body: { before: string } — an ISO
   * date/datetime (e.g. "2026-05-01"). Admin maintenance.
   */
  async deleteSessionDebugLogsBefore(req: Request, res: Response): Promise<void> {
    try {
      const before = typeof req.body?.before === "string" ? req.body.before.trim() : "";
      const cutoff = new Date(before);
      if (!before || Number.isNaN(cutoff.getTime())) {
        res.status(400).json({ success: false, message: "A valid 'before' date is required" });
        return;
      }
      const [deleted, costEventsDeleted] = await Promise.all([
        chatRepository.deleteSessionDebugLogsBefore(cutoff),
        chatRepository.deleteSessionCostEventsBefore(cutoff),
      ]);
      // `deleted` stays the debug-log count for backward compatibility.
      res.json({ success: true, deleted, costEventsDeleted, before: cutoff.toISOString() });
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
