// server/controllers/dualAgentController.ts
// Controller for the dual-agent AAC system

import type { Request, Response } from "express";
import { dualAgentService } from "../services/dual-agent";
import { studentService } from "../services";

/**
 * Dual Agent Controller
 *
 * Handles API endpoints for the dual-agent AAC system:
 * - GET /api/aac/dual/session/:sessionId - Get current session state
 */
export class DualAgentController {
  /**
   * GET /api/aac/dual/session/:sessionId
   * Get current session state.
   *
   * Requires a session AND verified access to the student: with
   * `debugMode=true` the response carries the transcript and the interactive
   * prompt (name, age, diagnosis, memory), and `initializeSession` will CREATE
   * a billed session for the given student if none exists.
   */
  async getSession(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;
      const { studentId, debugMode } = req.query;

      if (!studentId || typeof studentId !== "string") {
        res.status(400).json({ error: "error:STUDENT_ID_REQUIRED" });
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: "error:AUTH_REQUIRED" });
        return;
      }
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, userId);
      if (!hasAccess) {
        res.status(403).json({ error: "error:STUDENT_ACCESS_DENIED" });
        return;
      }

      const state = await dualAgentService.initializeSession(
        studentId,
        userId,
        sessionId
      );

      if (debugMode === "true") {
        // Full debug data for the unified debug panel
        res.json({
          sessionId: state.sessionId,
          monitorBusy: state.monitorBusy,
          messageCount: state.messages.length,
          pendingCount: state.pendingMessages.length,
          interactivePrompt: state.interactivePrompt,
          lastMonitorActivity: state.lastMonitorActivity,
          lastInteractiveActivity: state.lastInteractiveActivity,
          muteState: state.muteState,
          messages: state.messages.slice(-50),
          pendingMessages: state.pendingMessages,
          monitorError: state.monitorError || null,
          monitorErrorTimestamp: state.monitorErrorTimestamp || null,
          monitorConsecutiveFailures: state.monitorConsecutiveFailures || 0,
          currentEmote: state.currentEmote || "neutral",
        });
      } else {
        res.json({
          sessionId: state.sessionId,
          monitorBusy: state.monitorBusy,
          messageCount: state.messages.length,
          pendingCount: state.pendingMessages.length,
          monitorError: state.monitorError || null,
          monitorConsecutiveFailures: state.monitorConsecutiveFailures || 0,
        });
      }
    } catch (error: any) {
      console.error("[DualAgentController] GetSession error:", error?.message || error);
      if (error?.stack) console.error("[DualAgentController] Stack trace:", error.stack);
      res.status(500).json({
        error: "error:SESSION_FAILED",
        details: error.message || String(error),
      });
    }
  }
}

export const dualAgentController = new DualAgentController();
