// The ONE place the daily maintenance crons are scheduled.
//
// History: each cron file shipped its own `schedule*()` and the dev entrypoint
// (server/index.ts) called all five — but the ECS entrypoint (app.prod.ts)
// called none, under a comment claiming they "fire normally here". So in
// production the right-to-erasure hard-delete, the audit-log retention prune
// and the minor-threshold consent check never ran. The EventBridge fallback
// (terraform/eventbridge-cron.tf) was gated on `use_lambda`, so it was off on
// ECS too. Nothing detected it: the crons were tested in isolation, and the
// entrypoints were not tested for wiring.
//
// Both entrypoints now call `scheduleMaintenanceCrons()`, and
// server/tests/maintenance-crons-wiring.test.ts pins that they do.
//
// Every run is wrapped in a cluster-wide advisory lock (cron-lock.ts): under
// the ECS `hipaa` profile there are 2–10 identical tasks, and a setInterval
// fires once PER TASK. The lock makes exactly one of them do the work; the
// others log a skip and try again next tick.

import { withCronLock } from "./cron-lock";
import { runMinorThresholdCheck, runConsentAuthorityReviewCheck } from "./consent/consentThresholdCron";
import { runActivityLogRetentionCheck } from "./activityLogRetentionCron";
import { runStudentErasureSweep } from "./studentErasureCron";
import { runSpendThresholdCheck } from "./providerAlertService";
import { runPackageLinkReconcile } from "./packages/packageLinkCron";
import { runSecurityIncidentDeadlineSweep } from "./securityIncidentSweepCron";
import { runDataSubjectRequestSweep } from "./dataSubjectRequestSweepCron";
import { runAccessReview } from "./accessReviewCron";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
// Well inside setInterval's ~24.8-day maximum delay (a longer period would
// silently fire immediately and forever, since the delay overflows to 1ms).
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

interface MaintenanceCron {
  name: string;
  /** Delay before the first run after boot — staggered so they don't all hit the DB at once. */
  initialDelayMs: number;
  /**
   * How often to repeat. Defaults to daily, which suits a retention prune or an
   * erasure sweep. A cron guarding a deadline measured in HOURS must set this
   * explicitly — a 48-hour window checked once a day can be blown by nearly a
   * full day before anyone is told.
   */
  intervalMs?: number;
  run: () => Promise<unknown>;
  /** One-line summary for the boot log; undefined = stay quiet on a clean run. */
  summarize?: (result: any) => string | undefined;
}

const CRONS: MaintenanceCron[] = [
  {
    name: "consent-thresholds",
    initialDelayMs: 30_000,
    run: async () => {
      // Two independent scans; one failing must not stop the other.
      const minor = await runMinorThresholdCheck().catch((err) => {
        console.error("[maintenanceCrons] minor-threshold check failed:", err);
        return null;
      });
      const authority = await runConsentAuthorityReviewCheck().catch((err) => {
        console.error("[maintenanceCrons] consent-authority review failed:", err);
        return null;
      });
      return { minor, authority };
    },
  },
  {
    name: "activity-log-retention",
    initialDelayMs: 60_000,
    run: () => runActivityLogRetentionCheck(),
    summarize: (r) =>
      `scanned ${r.institutesScanned} institutes, deleted ${r.globalDeleted} global + ${r.perInstituteDeleted} per-institute rows`,
  },
  {
    name: "student-erasure",
    initialDelayMs: 90_000,
    run: () => runStudentErasureSweep(),
    summarize: (r) =>
      `scanned ${r.scanned}, hard-deleted ${r.hardDeleted}, failed ${r.failed.length}, S3 keys orphaned ${r.s3KeysFailed.length}`,
  },
  {
    name: "provider-spend-threshold",
    initialDelayMs: 120_000,
    run: () => runSpendThresholdCheck(),
    summarize: (r) => (r?.ran ? `${r.breached.length} provider(s) over ${r.thresholdPct}%` : undefined),
  },
  {
    // Hourly: this one guards the AKIM §6 notification deadlines.
    name: "security-incident-deadlines",
    initialDelayMs: 45_000,
    intervalMs: ONE_HOUR_MS,
    run: () => runSecurityIncidentDeadlineSweep(),
    summarize: (r) =>
      r.raised.length > 0
        ? `${r.raised.length} deadline finding(s) raised, ${r.suppressed} already announced, alerted=${r.alerted}`
        : undefined,
  },
  {
    // Hourly: AKIM §18.3's 72-hour window for forwarding a data-subject access
    // or amendment request to the controlling institute. Daily would let a
    // 72-hour deadline be blown by nearly a day before anyone was told.
    name: "data-subject-deadlines",
    initialDelayMs: 75_000,
    intervalMs: ONE_HOUR_MS,
    run: () => runDataSubjectRequestSweep(),
    summarize: (r) =>
      r.raised.length > 0
        ? `${r.raised.length} forward-deadline finding(s) raised, ${r.suppressed} already announced, alerted=${r.alerted}`
        : undefined,
  },
  {
    // Weekly: AKIM §2.8's periodic access review. Dormancy is measured in
    // months, so a daily mail about the same accounts would be ignored by the
    // second week — which is the same as not sending it.
    name: "access-review",
    initialDelayMs: 180_000,
    intervalMs: SEVEN_DAYS_MS,
    run: () => runAccessReview(),
    summarize: (r) =>
      r.flagged.length > 0
        ? `${r.flagged.length} dormant account(s), ${r.deactivated.length} auto-deactivated, alerted=${r.alerted}`
        : undefined,
  },
  {
    name: "package-link-reconcile",
    initialDelayMs: 150_000,
    run: () => runPackageLinkReconcile(),
    summarize: (r) =>
      r.corrected.length > 0 || r.collected.length > 0
        ? `checked ${r.checked}, corrected ${r.corrected.length}, collected ${r.collected.length}`
        : undefined,
  },
];

async function runOne(cron: MaintenanceCron, label: string): Promise<void> {
  try {
    const { ran, result } = await withCronLock(cron.name, cron.run);
    if (!ran) {
      console.log(`[maintenanceCrons] ${cron.name}: ${label} run skipped — another task holds the lock`);
      return;
    }
    const summary = cron.summarize?.(result);
    if (summary) console.log(`[maintenanceCrons] ${cron.name}: ${label} run — ${summary}`);
  } catch (err) {
    console.error(`[maintenanceCrons] ${cron.name}: ${label} run failed:`, err);
  }
}

let armed = false;
const timers: NodeJS.Timeout[] = [];

/**
 * Arm every maintenance cron. Idempotent; a no-op under NODE_ENV=test
 * (tests drive the run functions directly). Call from EVERY long-lived
 * entrypoint — the wiring test enforces it.
 */
export function scheduleMaintenanceCrons(): void {
  if (armed) return;
  if (process.env.NODE_ENV === "test") return;
  armed = true;

  for (const cron of CRONS) {
    timers.push(setTimeout(() => void runOne(cron, "initial"), cron.initialDelayMs));
    timers.push(
      setInterval(() => void runOne(cron, "scheduled"), cron.intervalMs ?? ONE_DAY_MS),
    );
  }
  console.log(`[maintenanceCrons] armed ${CRONS.length} crons: ${CRONS.map((c) => c.name).join(", ")}`);
}

/** The cron names, for the wiring test and for ops docs. */
export const MAINTENANCE_CRON_NAMES: readonly string[] = CRONS.map((c) => c.name);
