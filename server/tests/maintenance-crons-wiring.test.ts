/**
 * Pins that EVERY long-lived server entrypoint arms the maintenance crons.
 *
 * The production entrypoint (app.prod.ts) shipped without them for months
 * while its header comment claimed they "fire normally here": the
 * right-to-erasure hard-delete, the audit-log retention prune and the
 * minor-threshold consent check never ran on ECS. The crons themselves were
 * tested; the wiring was not. This test is the wiring test.
 *
 * Source-level on purpose: importing app.prod.ts would boot a server.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAINTENANCE_CRON_NAMES } from "../services/maintenanceCrons.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every entrypoint that runs as a long-lived process. Lambda is excluded:
 *  setInterval does not fire there (EventBridge → /internal/run-crons instead). */
const LONG_LIVED_ENTRYPOINTS = ["index.ts", "app.prod.ts"];

describe("maintenance cron wiring", () => {
  it.each(LONG_LIVED_ENTRYPOINTS)("%s calls scheduleMaintenanceCrons()", (file) => {
    const src = readFileSync(path.join(serverDir, file), "utf8");
    const calls = src.match(/\bscheduleMaintenanceCrons\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("no entrypoint schedules an individual cron directly (one owner)", () => {
    // If someone re-adds a per-cron schedule*() call to an entrypoint, the
    // set drifts again — the whole point of the central module.
    for (const file of LONG_LIVED_ENTRYPOINTS) {
      const src = readFileSync(path.join(serverDir, file), "utf8");
      expect(src).not.toMatch(/\bschedule(MinorThresholdCheck|ActivityLogRetention|StudentErasureSweep|SpendThresholdCheck|PackageLinkReconcile)\(/);
    }
  });

  it("registers every maintenance cron", () => {
    expect([...MAINTENANCE_CRON_NAMES].sort()).toEqual([
      "activity-log-retention",
      "consent-thresholds",
      "package-link-reconcile",
      "provider-spend-threshold",
      // Hourly, not daily — it guards the AKIM §6 48-hour notification window.
      "security-incident-deadlines",
      "student-erasure",
    ]);
  });
});
