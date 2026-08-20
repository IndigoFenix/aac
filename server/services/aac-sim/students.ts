/**
 * students.ts — THE SIM STUDENTS (harness design ⑤, §9).
 *
 * A small fixed set of students, one per profile, created through the NORMAL
 * path and treated as real by every behaviour and database write: consent,
 * budget meters, session rows, monitor notes, activity log, erasure. There is no
 * privileged lane and no `simProfile` column — which is the point. The suite
 * exercises the real machinery instead of tiptoeing around it, and the records
 * are safe because they are FABRICATED, not because they are flagged.
 *
 * ⚠️ RUNS ARE NOT INDEPENDENT. A session leaves durable traces on these rows:
 * chatMemory the Monitor wrote, contacts it auto-added, budget-meter drain. That
 * is desirable — it tests persistence, and lets a run see what the last one
 * taught the AI — but it means a scenario needing a clean slate must call
 * `resetSimStudent` in setup and say so in its transcript header. Otherwise
 * "the AI already knew that" silently changes results between runs.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { students, aacSettings } from "@shared/schema-private";
import { getConsentStatus } from "../consent/consentGate.js";
import { SIM_PROFILES, type ChildProfile } from "@shared/aac/sim-profiles";

/** Name prefix, so a human reading the clinician client can tell at a glance
 *  that a session was synthetic. Not a security boundary — a signpost. */
export const SIM_NAME_PREFIX = "[SIM]";

export function simStudentName(profile: ChildProfile): string {
  return `${SIM_NAME_PREFIX} ${profile.id}`;
}

export interface SimStudentRecord {
  studentId: string;
  profile: ChildProfile;
  /** False when the consent gate would refuse a session for this student. */
  sessionAllowed: boolean;
  consentNote: string;
}

/**
 * Find the sim student for a profile, if one has been created.
 * Matched by NAME, since there is no marker column by design.
 */
export async function findSimStudent(profile: ChildProfile): Promise<string | null> {
  const want = simStudentName(profile);
  const rows = await db.select({ id: students.id, name: students.name }).from(students);
  return rows.find((r) => r.name === want && !("deletedAt" in r && r.deletedAt))?.id ?? null;
}

/**
 * Write the profile's settings onto an existing student's `aac_settings` row.
 *
 * Only the columns the profile PINS are touched; everything else keeps whatever
 * the defaults gave it, so a profile cannot quietly become a full settings
 * fixture that drifts from production defaults.
 */
export async function applyProfileSettings(studentId: string, profile: ChildProfile): Promise<void> {
  const s = profile.aacSettings;
  await db
    .update(aacSettings)
    .set({
      enabled: true,
      languageLevel: s.languageLevel,
      iconTextRatio: s.iconTextRatio,
      restSpace: s.restSpace,
      selectionMethod: s.selectionMethod,
      eyegazeEnabled: s.eyegazeEnabled,
      eyegazeTimeout: s.eyegazeTimeout,
      singleGlyphButtons: s.singleGlyphButtons,
      dynamicBoardsEnabled: s.dynamicBoardsEnabled,
      autoAudioScan: s.autoAudioScan,
    })
    .where(eq(aacSettings.studentId, studentId));

  // verbalAbility lives on the STUDENT, not the settings row — it is a clinical
  // fact about the child, and the coordinator enforces it deterministically
  // (a transcript can never attribute speech the student cannot produce).
  await db
    .update(students)
    .set({ verbalAbility: profile.verbalAbility })
    .where(eq(students.id, studentId));
}

/**
 * Create any sim student that does not exist yet, and bring every one of them
 * into line with its profile. IDEMPOTENT: safe to re-run, and re-running is how
 * a profile change reaches the rows.
 *
 * Goes through `studentService.createStudent`, the same call the clinician UI
 * makes — so the student gets its `user_students` link and its default
 * `aac_settings` row exactly as a real one does. §9: no privileged lane.
 *
 * `birthDate` is derived from the profile's age because the platform reasons
 * about age in several places (consent authority, register, content) and a
 * missing one would quietly opt these students out of that reasoning.
 */
export async function ensureSimStudents(
  ownerUserId: string,
  opts: { today?: Date } = {},
): Promise<SimStudentRecord[]> {
  const today = opts.today ?? new Date();
  const { studentService } = await import("../studentService.js");

  for (const profile of SIM_PROFILES) {
    const existing = await findSimStudent(profile);
    if (!existing) {
      const birthYear = today.getUTCFullYear() - profile.ageYears;
      await studentService.createStudent(
        {
          name: simStudentName(profile),
          firstName: "[SIM]",
          lastName: profile.id,
          birthDate: `${birthYear}-01-01`,
          primaryLanguage: "en",
          country: "IL",
          communicationProfile: profile.description,
        } as never,
        ownerUserId,
        "owner",
      );
    }
    const studentId = await findSimStudent(profile);
    if (studentId) await applyProfileSettings(studentId, profile);
  }

  return inspectSimStudents();
}

/**
 * Report what exists and whether it can actually run.
 *
 * Deliberately READ-ONLY about consent. A new student gets no legacy grace, so
 * with `CONSENT_GATE_ENABLED=true` the session is refused until someone collects
 * consent — exactly as for a real child. Minting a consent record as a seeding
 * side effect would be recording a legally-meaningful act nobody performed, so
 * this reports the block and leaves it to a person.
 */
export async function inspectSimStudents(): Promise<SimStudentRecord[]> {
  const out: SimStudentRecord[] = [];
  for (const profile of SIM_PROFILES) {
    const studentId = await findSimStudent(profile);
    if (!studentId) continue;
    const consent = await getConsentStatus(studentId);
    out.push({
      studentId,
      profile,
      sessionAllowed: consent.writesAllowed,
      consentNote: consent.writesAllowed
        ? consent.gateEnabled
          ? consent.hasActiveConsent
            ? "consent on file"
            : "within the legacy grace window"
          : "consent gate is off in this environment"
        : "BLOCKED — the consent gate is on and this student has no consent on file",
    });
  }
  return out;
}

/**
 * Clear what a previous run taught the AI about this student, so a scenario can
 * start from a known state. Touches only the AI-learned layer — the profile's
 * own settings and the student row survive.
 *
 * NOT called automatically: a scenario that WANTS continuity (testing whether
 * the Monitor remembers) must be able to keep it.
 */
export async function resetSimStudent(studentId: string): Promise<void> {
  await db
    .update(students)
    .set({
      chatMemory: {},
      // The rolling budget meters. Clearing them stops one long run throttling
      // the next and being misread as the AI going terse.
      budgetMeters: {},
    })
    .where(eq(students.id, studentId));

  await db
    .update(aacSettings)
    .set({ autoAacPrompt: [] })
    .where(eq(aacSettings.studentId, studentId));
}
