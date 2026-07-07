// server/controllers/cronController.ts
// Machine-to-machine endpoint that runs the daily maintenance sweeps:
//   - right-to-erasure hard-delete sweep (GDPR Art.17 / IL PPL)
//   - activity-log retention prune (per-regime retention)
//   - LLM provider spend-threshold check (emails support near a monthly cap)
//
// On the Lambda production deployment, setInterval-based scheduling never fires
// (containers freeze between invocations), so an external scheduler (EventBridge)
// invokes this endpoint on a daily cadence instead. Authenticated by a shared
// secret header (constant-time compared), NOT a session — so it's CSRF-exempt.

import type { Request, Response } from "express";
import crypto from "crypto";
import { runStudentErasureSweep } from "../services/studentErasureCron";
import { runActivityLogRetentionCheck } from "../services/activityLogRetentionCron";
import { runSpendThresholdCheck } from "../services/providerAlertService";

/** Constant-time compare of the provided secret against the configured one. */
function secretMatches(provided: unknown): boolean {
  const expected = process.env.CRON_TRIGGER_SECRET;
  if (!expected) return false; // feature disabled when unset
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class CronController {
  /**
   * POST /internal/run-crons
   * Header: X-Cron-Secret: <CRON_TRIGGER_SECRET>
   * Runs the erasure + retention sweeps. Returns per-sweep results.
   */
  async runScheduledCrons(req: Request, res: Response): Promise<void> {
    // 404 (not 403) when the feature is unconfigured, so the endpoint is
    // indistinguishable from "not present" without the secret.
    if (!process.env.CRON_TRIGGER_SECRET) {
      res.status(404).json({ success: false, message: "Not found" });
      return;
    }
    if (!secretMatches(req.headers["x-cron-secret"])) {
      res.status(403).json({ success: false, message: "Forbidden" });
      return;
    }
    try {
      const erasure = await runStudentErasureSweep();
      const retention = await runActivityLogRetentionCheck();
      const spendThreshold = await runSpendThresholdCheck();
      res.json({ success: true, erasure, retention, spendThreshold });
    } catch (err: any) {
      console.error("Scheduled cron run failed:", err);
      res.status(500).json({ success: false, message: "Cron run failed" });
    }
  }
}

export const cronController = new CronController();
