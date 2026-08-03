// Daily backstop for the package link refcount.
//
// `packages.linkCount` is kept correct by packageLinks.ts on every attach,
// detach, grant and revoke. This sweep exists only for what a crashed
// transaction could strand — it is NOT part of the design, and the system is
// correct without it.
//
// The asymmetry that makes the counter safe to denormalise: drift can leave a
// deleted package alive (untidy), never remove one a student is still using
// (harmful). Collection re-verifies with real COUNTs before deleting anything,
// so this sweep cannot make the harmful direction happen either.
//
// Scheduling mirrors studentErasureCron / activityLogRetentionCron:
//   - `runPackageLinkReconcile()` is the work; tests drive it directly.
//   - `schedulePackageLinkReconcile()` arms a daily timer plus one run after
//     boot (skipped under NODE_ENV=test).
//
// See planning-docs/aac-packages-plan.md §1.5.

import {
  reconcilePackageLinkCounts,
  type ReconcileResult,
} from "./packageLinks.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function runPackageLinkReconcile(): Promise<ReconcileResult> {
  return reconcilePackageLinkCounts();
}

let scheduledTimer: NodeJS.Timeout | null = null;

export function schedulePackageLinkReconcile(): void {
  if (scheduledTimer) return;
  if (process.env.NODE_ENV === "test") return;

  setTimeout(() => {
    runPackageLinkReconcile()
      .then((r) => {
        // Only worth a line when it actually found something — a clean sweep is
        // the expected case and should not add noise to every boot log.
        if (r.corrected.length > 0 || r.collected.length > 0) {
          console.log(
            `[packageLinkCron] Initial reconcile: checked ${r.checked}, ` +
              `corrected ${r.corrected.length}, collected ${r.collected.length}.`,
          );
        }
      })
      .catch((err) => {
        console.error("[packageLinkCron] Initial reconcile failed:", err);
      });
  }, 150_000); // 150s after boot — staggered behind the spend-threshold check

  scheduledTimer = setInterval(() => {
    runPackageLinkReconcile().catch((err) => {
      console.error("[packageLinkCron] Scheduled reconcile failed:", err);
    });
  }, ONE_DAY_MS);
}
