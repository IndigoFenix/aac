// server/services/consent/consentThresholdCron.ts
//
// Daily cron: find students whose age has crossed out of the protection
// regime under which their active consent record was signed (e.g. a US
// student turning 13 ages out of `us_coppa` into the standard regime).
// For each such transition, emit a `minor_threshold_crossed` activity log
// entry — one per consent record per crossing — so the clinician can
// follow up with re-consent. Does NOT auto-revoke; the existing consent
// remains valid until a human acts.
//
// De-duplication: queries the activity log for any prior
// `minor_threshold_crossed` entry whose subject is the consent record id;
// skips if found. This avoids needing a new column on the consent table.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db.js";
import {
  studentConsentRecords,
  students,
  activityLogs,
  type StudentConsentRecord,
} from "@shared/schema";
import {
  computeAgeYears,
  getRegimeThreshold,
  type MinorProtectionRegime,
} from "@shared/legal";
import { activityLogService } from "../activityLogService.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single-pass scan. Returns the count of newly-flagged crossings.
 * Safe to call repeatedly — already-logged crossings are skipped.
 */
export async function runMinorThresholdCheck(now: Date = new Date()): Promise<{
  scanned: number;
  flagged: number;
}> {
  // Pull every active consent record that signed under an enhanced-protection
  // regime, plus the student's birth date.
  const rows = await db
    .select({
      consent: studentConsentRecords,
      birthDate: students.birthDate,
      country: students.country,
    })
    .from(studentConsentRecords)
    .innerJoin(students, eq(studentConsentRecords.studentId, students.id))
    .where(
      and(
        isNull(studentConsentRecords.revokedAt),
        isNotNull(studentConsentRecords.enhancedProtectionRegime),
      ),
    );

  let flagged = 0;

  for (const row of rows) {
    const consent = row.consent as StudentConsentRecord;
    if (!row.birthDate) continue; // can't decide without a birth date
    const regime = consent.enhancedProtectionRegime as MinorProtectionRegime | null;
    if (!regime) continue;

    const threshold = getRegimeThreshold(regime);
    if (typeof threshold !== "number") continue;

    const currentAge = computeAgeYears(new Date(row.birthDate), now);
    if (currentAge < threshold) continue; // still inside the regime

    // Check the activity log for a prior flag for THIS consent record.
    const [prior] = await db
      .select({ id: activityLogs.id })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, "minor_threshold_crossed"),
          eq(activityLogs.subjectType1, "consent_record"),
          eq(activityLogs.subjectId1, consent.id),
        ),
      )
      .limit(1);
    if (prior) continue;

    activityLogService.log({
      eventType: "minor_threshold_crossed",
      subjectType1: "consent_record",
      subjectId1: consent.id,
      subjectType2: "student",
      subjectId2: consent.studentId,
      details: {
        priorRegime: regime,
        threshold,
        currentAge,
        signedAt: consent.signedAt instanceof Date
          ? consent.signedAt.toISOString()
          : consent.signedAt,
        country: consent.country,
        recommendation:
          "Student has aged out of the enhanced-protection regime under which consent was signed. Recommend obtaining re-consent to keep opt-in choices and disclosures current.",
      },
    });
    flagged++;
  }

  return { scanned: rows.length, flagged };
}

let scheduledTimer: NodeJS.Timeout | null = null;

/**
 * Idempotent scheduler. Starts a daily run + an immediate first run.
 * Called once from server bootstrap. Tests can call runMinorThresholdCheck
 * directly without scheduling.
 */
export function scheduleMinorThresholdCheck(): void {
  if (scheduledTimer) return; // already scheduled
  if (process.env.NODE_ENV === "test") return; // tests drive it directly

  // Initial run, deferred slightly so server boot isn't blocked.
  setTimeout(() => {
    runMinorThresholdCheck().catch((err) => {
      console.error("[consentThresholdCron] Initial run failed:", err);
    });
  }, 30_000);

  scheduledTimer = setInterval(() => {
    runMinorThresholdCheck().catch((err) => {
      console.error("[consentThresholdCron] Scheduled run failed:", err);
    });
  }, ONE_DAY_MS);
}
