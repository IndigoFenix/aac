// Admin endpoints for the right-to-erasure workflow.
//
// Three operations:
//   POST /api/admin/students/:id/erase            — soft-delete + schedule
//   POST /api/admin/students/:id/erase/cancel     — within window, restore
//   GET  /api/admin/students/:id/erasure-status   — read-only status
//
// All gated by requireSystemAdmin. Institute admins can request erasure
// via a separate self-service flow (out of scope for v1; surface this
// through the admin console for now).

import type { Request, Response } from "express";
import { z } from "zod";
import { studentErasureService } from "../services/studentErasureService";
import { runStudentErasureSweep } from "../services/studentErasureCron";

const eraseBodySchema = z.object({
  reason: z.string().max(2000).optional(),
  instituteId: z.string().uuid().optional(),
});

export class StudentErasureController {
  async requestErasure(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.id;
      const user = req.user as any;
      const parsed = eraseBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const status = await studentErasureService.softDeleteStudent(
        studentId,
        user.id,
        parsed.data.instituteId ?? null,
        parsed.data.reason,
      );
      if (status.state === "missing") {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }
      res.json({ success: true, status });
    } catch (err: any) {
      console.error("Erasure request failed:", err);
      res.status(500).json({ success: false, message: "Failed to request erasure" });
    }
  }

  async cancelErasure(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.id;
      const user = req.user as any;
      const parsed = eraseBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid body", errors: parsed.error.errors });
        return;
      }
      const status = await studentErasureService.cancelErasure(
        studentId,
        user.id,
        parsed.data.instituteId ?? null,
      );
      if (status.state === "missing") {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }
      res.json({ success: true, status });
    } catch (err: any) {
      const message = err?.message?.includes("Erasure window") ? err.message : "Failed to cancel erasure";
      const status = err?.message?.includes("Erasure window") ? 409 : 500;
      res.status(status).json({ success: false, message });
    }
  }

  /**
   * POST /api/admin/students/erasure/run-sweep
   * Manually run the expired-erasure hard-delete sweep. STOPGAP: the scheduled
   * sweep (setInterval) does not fire on the Lambda production deployment
   * (containers freeze between invocations), so without this, requested
   * erasures past their cancellation window are never physically carried out.
   * Until an EventBridge-scheduled cron Lambda is wired, an admin can drive the
   * sweep here. Gated by requireSystemAdmin.
   */
  async runSweep(_req: Request, res: Response): Promise<void> {
    try {
      const result = await runStudentErasureSweep();
      res.json({ success: true, result });
    } catch (err: any) {
      console.error("Erasure sweep failed:", err);
      res.status(500).json({ success: false, message: "Failed to run erasure sweep" });
    }
  }

  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.id;
      const status = await studentErasureService.getErasureStatus(studentId);
      if (status.state === "missing") {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }
      res.json({ success: true, status });
    } catch (err: any) {
      console.error("Erasure status failed:", err);
      res.status(500).json({ success: false, message: "Failed to fetch status" });
    }
  }
}

export const studentErasureController = new StudentErasureController();
