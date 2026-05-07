// Daily cron that walks tombstoned students whose 30-day window has
// elapsed and physically deletes them via studentErasureService.
//
// Scheduling shape mirrors `activityLogRetentionCron.ts`:
//   - `runStudentErasureSweep()` is the work; tests drive it directly.
//   - `scheduleStudentErasureSweep()` arms a daily timer + an initial
//     run shortly after server boot (skipped under NODE_ENV=test).
//
// Errors on individual students are logged and skipped — one bad row
// must not stop the sweep from purging the rest.

import { studentErasureService } from "./studentErasureService.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface StudentErasureSweepResult {
  scanned: number;
  hardDeleted: number;
  failed: { studentId: string; error: string }[];
  /** S3 keys whose post-commit deletion failed across all sweeps. The DB
   *  rows are gone (so the blobs are unreachable); ops can use this list
   *  to drive a manual bucket cleanup. */
  s3KeysFailed: string[];
}

export async function runStudentErasureSweep(now: Date = new Date()): Promise<StudentErasureSweepResult> {
  const expired = await studentErasureService.listExpiredErasures(now);
  const failed: { studentId: string; error: string }[] = [];
  const s3KeysFailed: string[] = [];
  let hardDeleted = 0;

  for (const { id } of expired) {
    try {
      const out = await studentErasureService._hardDeleteStudent(id, null, null);
      hardDeleted++;
      if (out.s3KeysFailed.length) s3KeysFailed.push(...out.s3KeysFailed);
    } catch (err: any) {
      failed.push({ studentId: id, error: err?.message ?? String(err) });
      console.error(`[studentErasureCron] Hard-delete failed for student ${id}:`, err);
    }
  }

  return { scanned: expired.length, hardDeleted, failed, s3KeysFailed };
}

let scheduledTimer: NodeJS.Timeout | null = null;

export function scheduleStudentErasureSweep(): void {
  if (scheduledTimer) return;
  if (process.env.NODE_ENV === "test") return;

  setTimeout(() => {
    runStudentErasureSweep()
      .then((r) => {
        console.log(
          `[studentErasureCron] Initial sweep: scanned ${r.scanned}, hard-deleted ${r.hardDeleted}, ` +
          `failed ${r.failed.length}, S3 keys orphaned ${r.s3KeysFailed.length}.`,
        );
      })
      .catch((err) => {
        console.error("[studentErasureCron] Initial sweep failed:", err);
      });
  }, 90_000); // 90s after boot — runs after activityLogRetentionCron's 60s

  scheduledTimer = setInterval(() => {
    runStudentErasureSweep().catch((err) => {
      console.error("[studentErasureCron] Scheduled sweep failed:", err);
    });
  }, ONE_DAY_MS);
}
