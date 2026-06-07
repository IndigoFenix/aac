/**
 * chatSessionsController
 *
 * Clinician-facing endpoints for the in-chat "past conversations" sidebar:
 * list / load / rename / delete the *requesting user's own* chat sessions.
 *
 * Distinct from sessionHistoryController, which is the admin (institute-wide)
 * surface gated behind requireAdminSection. Every method here is scoped to
 * req.user.id — a clinician can only ever see and mutate their own sessions.
 */

import type { Request, Response } from "express";
import { chatRepository } from "../repositories/chatRepository";
import { generateSessionSummary } from "../services/sessionSummary";

class ChatSessionsController {
  /** GET /api/chat/sessions?studentId= — list the user's own conversations. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const studentId = (req.query.studentId as string) || undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);

      // Opportunistically backfill AI titles for the user's recent *idle*
      // untitled sessions. Awaited (not fire-and-forget) so it completes before
      // the response — the Lambda Web Adapter freezes the container at response
      // time, so any post-response async work would never run. Bounded + tolerant
      // of failure so a slow/failed LLM call never blocks the list.
      try {
        const untitled = await chatRepository.getUntitledSessionIdsForUser({
          userId,
          studentId,
          limit: 2,
        });
        if (untitled.length > 0) {
          await Promise.all(untitled.map((id) => generateSessionSummary(id)));
        }
      } catch (e) {
        console.warn("[chatSessions] title backfill skipped:", e);
      }

      const sessions = await chatRepository.getSessionsForUser({ userId, studentId, limit });
      res.json({ success: true, sessions });
    } catch (error: any) {
      console.error("Error listing chat sessions:", error);
      res.status(500).json({ success: false, message: "Failed to list sessions" });
    }
  }

  /** GET /api/chat/sessions/:id — load one of the user's own sessions (resume). */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const session = await chatRepository.getSessionForUser(req.params.id, userId);
      if (!session) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true, session });
    } catch (error: any) {
      console.error("Error loading chat session:", error);
      res.status(500).json({ success: false, message: "Failed to load session" });
    }
  }

  /** PATCH /api/chat/sessions/:id { title } — rename (locks the title). */
  async rename(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(400).json({ success: false, message: "Title is required" });
        return;
      }
      const ok = await chatRepository.renameSession(req.params.id, userId, title);
      if (!ok) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true, title: title.slice(0, 200) });
    } catch (error: any) {
      console.error("Error renaming chat session:", error);
      res.status(500).json({ success: false, message: "Failed to rename session" });
    }
  }

  /** DELETE /api/chat/sessions/:id — soft-delete one of the user's sessions. */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const ok = await chatRepository.softDeleteSessionForUser(req.params.id, userId);
      if (!ok) {
        res.status(404).json({ success: false, message: "Session not found" });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting chat session:", error);
      res.status(500).json({ success: false, message: "Failed to delete session" });
    }
  }
}

export const chatSessionsController = new ChatSessionsController();
