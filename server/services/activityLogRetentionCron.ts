// Daily cron: prune `activity_logs` rows past their retention window.
//
// Per-institute rows: retention = `resolveAuditRetentionDays(regimes)` from
// the institute's compliance regimes (regime registry, §3 / §6 of
// SECURITY_ARCHITECTURE.md). Falls back to 1 year when no regime is set.
//
// Global rows (no `instituteId` — e.g. failed-login attempts where we
// don't know which institute the attacker was after): use the strictest
// retention across the whole regime registry so the longest-lookback
// regulator can still see the trail.
//
// De-duplication isn't needed because we DELETE old rows; running twice
// in one day is a no-op the second time. Idempotent + safe to retry.
//
// Closes the §12 open item in `docs/SECURITY_ARCHITECTURE.md`:
//   "Auto-prune `activity_logs` per `resolveAuditRetentionDays`."

import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "../db.js";
import { activityLogs, institutes } from "@shared/schema";
import {
  KNOWN_REGIMES,
  getRegimeBundle,
  resolveAuditRetentionDays,
} from "@shared/regime";
import { regimeService } from "./regimeService.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_INSTITUTE_RETENTION_DAYS = 365;

/**
 * Compute the strictest (longest) retention across every known regime.
 * Used as the floor for orphan/global rows.
 */
function strictestKnownRetentionDays(): number {
  let max = 0;
  for (const slug of KNOWN_REGIMES) {
    const b = getRegimeBundle(slug);
    if (b && b.auditRetentionDays > max) max = b.auditRetentionDays;
  }
  return max || 365;
}

/**
 * Single-pass prune. Returns row counts deleted per category.
 * Safe to call repeatedly — once-deleted rows are gone.
 */
export async function runActivityLogRetentionCheck(now: Date = new Date()): Promise<{
  globalDeleted: number;
  perInstituteDeleted: number;
  institutesScanned: number;
}> {
  // 1) Orphan / global rows (instituteId IS NULL).
  const globalDays = strictestKnownRetentionDays();
  const globalCutoff = new Date(now.getTime() - globalDays * ONE_DAY_MS);
  const globalDeletedRows = await db
    .delete(activityLogs)
    .where(and(isNull(activityLogs.instituteId), lt(activityLogs.createdAt, globalCutoff)))
    .returning({ id: activityLogs.id });
  const globalDeleted = globalDeletedRows.length;

  // 2) Per-institute rows.
  const allInstitutes = await db.select({ id: institutes.id }).from(institutes);
  let perInstituteDeleted = 0;
  for (const inst of allInstitutes) {
    const slugs = await regimeService.getRegimesForInstitute(inst.id);
    const days = resolveAuditRetentionDays(slugs) || FALLBACK_INSTITUTE_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - days * ONE_DAY_MS);
    const deleted = await db
      .delete(activityLogs)
      .where(and(eq(activityLogs.instituteId, inst.id), lt(activityLogs.createdAt, cutoff)))
      .returning({ id: activityLogs.id });
    perInstituteDeleted += deleted.length;
  }

  return {
    globalDeleted,
    perInstituteDeleted,
    institutesScanned: allInstitutes.length,
  };
}

let scheduledTimer: NodeJS.Timeout | null = null;

/**
 * Idempotent scheduler. Starts a daily run plus an immediate run after
 * a short delay (so server boot isn't blocked). Tests drive
 * runActivityLogRetentionCheck directly.
 */
export function scheduleActivityLogRetention(): void {
  if (scheduledTimer) return;
  if (process.env.NODE_ENV === "test") return;

  setTimeout(() => {
    runActivityLogRetentionCheck()
      .then((r) => {
        console.log(
          `[activityLogRetention] Initial run: scanned ${r.institutesScanned} institutes, ` +
          `deleted ${r.globalDeleted} global + ${r.perInstituteDeleted} per-institute rows.`,
        );
      })
      .catch((err) => {
        console.error("[activityLogRetention] Initial run failed:", err);
      });
  }, 60_000); // 1 minute delay

  scheduledTimer = setInterval(() => {
    runActivityLogRetentionCheck().catch((err) => {
      console.error("[activityLogRetention] Scheduled run failed:", err);
    });
  }, ONE_DAY_MS);
}
