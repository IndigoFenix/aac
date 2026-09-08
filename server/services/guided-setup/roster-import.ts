// server/services/guided-setup/roster-import.ts
//
// GUIDED SETUP step 1 for a SCHOOL or CLINIC: the roster the AI read off an
// uploaded spreadsheet / PDF / photo, and the batch create the user confirms.
//
// Two halves, deliberately split:
//
//   normaliseRoster()  PURE. Rows in, rows + warnings out. No database, so the
//                      date and warning rules are unit-testable without a DB
//                      and the SAME function runs on both the propose and the
//                      confirm path — the client sends the rows back with the
//                      user's edits and the server re-derives everything from
//                      scratch. Nothing the client says about warnings, row
//                      ids or seat counts is trusted.
//   confirmRoster()    The write. ONE ROW AT A TIME, each in its own try: a
//                      roster with one malformed birth date must not roll back
//                      the other twenty-nine students.
//
// The AI never creates a student here. It proposes; the USER presses the button
// (plan §3.7 step 3 and decision 5). The propose action is a host action so
// that rule lives in code, not only in prompt text.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db.js";
import { instituteStudents, studentContacts, students } from "@shared/schema";
import { gradeEnum, type GradeEnum } from "@shared/schema-private";
import {
  GUIDED_SETUP_ROSTER_MAX_ROWS,
  type GuidedSetupRosterCreated,
  type GuidedSetupRosterFailure,
  type GuidedSetupRosterInputRow,
  type GuidedSetupRosterProposal,
  type GuidedSetupRosterRow,
} from "@shared/guided-setup";

import { activityLogService } from "../activityLogService.js";
import { changeDetails, summarizeChanges } from "../activityChanges.js";
import { chatRepository } from "../../repositories/chatRepository.js";
import { instituteRepository } from "../../repositories/instituteRepository.js";
import { licenseService } from "../licenseService.js";
import { studentService } from "../studentService.js";
import { newRecord, writeRecord } from "./student-setup-state.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Bounded strings. The rows come from a MODEL reading a document, so a field
 * can arrive as a paragraph, a number, or the whole row repeated — trim and cap
 * rather than reject, because rejecting the batch over one long cell throws
 * away thirty good rows.
 */
const cell = (max: number) =>
  z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      if (s === "") return null;
      return s.length > max ? s.slice(0, max) : s;
    });

const inputRowSchema = z.object({
  firstName: cell(80),
  lastName: cell(80),
  birthDate: cell(40),
  gender: cell(40),
  grade: cell(40),
  idNumber: cell(60),
  guardianName: cell(120),
  guardianEmail: cell(160),
  guardianPhone: cell(60),
});

/** The rows as they come back from the CLIENT on confirm: same cells + include. */
const confirmRowSchema = inputRowSchema.extend({
  rowId: z.string().min(1).max(64).optional(),
  include: z.boolean().optional(),
});

export const rosterInputSchema = z.array(inputRowSchema).max(GUIDED_SETUP_ROSTER_MAX_ROWS);
export const rosterConfirmRowsSchema = z
  .array(confirmRowSchema)
  .max(GUIDED_SETUP_ROSTER_MAX_ROWS);

// ---------------------------------------------------------------------------
// Normalisation — pure
// ---------------------------------------------------------------------------

/** Rows already in this institute, for the duplicate check. */
export interface ExistingStudent {
  name: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
}

export interface NormaliseInput {
  rows: Array<GuidedSetupRosterInputRow & { rowId?: string; include?: boolean }>;
  /** Institute country (`US` reads MM/DD/YYYY; everything else DD/MM/YYYY). */
  country: string | null;
  existing: ExistingStudent[];
  /** License head-room: how many more students fit. -1 = unlimited. */
  remainingSeats: number;
}

const GRADE_VALUES = new Set<string>(gradeEnum.enumValues);

/** `grade` is a Postgres ENUM — an unrecognised value must land as null, never as text. */
export function normaliseGrade(raw: string | null): GradeEnum | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (GRADE_VALUES.has(v)) return v as GradeEnum;
  // "1st Grade" / "Grade 1" / "כיתה 1" all mean the same row in the enum.
  const digits = v.match(/(\d{1,2})/)?.[1];
  if (digits && GRADE_VALUES.has(String(Number(digits)))) return String(Number(digits)) as GradeEnum;
  if (/^(k|kg|kinder)/.test(v)) return "k";
  if (/^(pre.?k|nursery|gan)/.test(v)) return "pre_k";
  if (/special/.test(v)) return "special_ed";
  if (/adult/.test(v)) return "adult_ed";
  return null;
}

/** `students.gender` is free text but the platform only ever writes these three. */
export function normaliseGender(raw: string | null): "male" | "female" | "other" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (["m", "male", "boy", "ז", "זכר"].includes(v)) return "male";
  if (["f", "female", "girl", "נ", "נקבה"].includes(v)) return "female";
  if (["o", "other", "x", "nonbinary", "non-binary"].includes(v)) return "other";
  return null;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A birth date, in whatever shape the source used.
 *
 * The day/month ambiguity of `03/04/2018` cannot be resolved from the string —
 * it is resolved by WHERE THE INSTITUTE IS. US rosters are month-first;
 * everywhere else is day-first. A value that fits neither reading comes back
 * null and the row is flagged, never silently guessed into the wrong month.
 */
export function normaliseBirthDate(raw: string | null, country: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();

  const isoMatch = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const [y, m, d] = [+isoMatch[1], +isoMatch[2], +isoMatch[3]];
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }

  const parts = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (!parts) return null;

  const a = +parts[1];
  const b = +parts[2];
  let year = +parts[3];
  // A two-digit year in a BIRTH date is a 19xx/20xx question; anything past the
  // current century's two digits is last century.
  if (parts[3].length === 2) {
    const cutoff = new Date().getUTCFullYear() % 100;
    year += year <= cutoff ? 2000 : 1900;
  }

  const monthFirst = (country ?? "").toUpperCase() === "US";
  const primary = monthFirst ? { m: a, d: b } : { m: b, d: a };
  if (isRealDate(year, primary.m, primary.d)) return iso(year, primary.m, primary.d);

  // One reading only: `13/05/2018` in a US institute is unambiguous the other
  // way round, and refusing it would flag a row nobody could have meant twice.
  const fallback = monthFirst ? { m: b, d: a } : { m: a, d: b };
  if (isRealDate(year, fallback.m, fallback.d)) return iso(year, fallback.m, fallback.d);

  return null;
}

function fullName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter((p) => !!p && p.trim() !== "").join(" ").trim();
}

/** Case- and space-insensitive key for the duplicate check. */
function dupKey(name: string, birthDate: string | null): string {
  return `${name.toLowerCase().replace(/\s+/g, " ").trim()}|${birthDate ?? ""}`;
}

export interface NormalisedRoster {
  rows: GuidedSetupRosterRow[];
  remainingSeats: number;
}

/**
 * Turn raw rows into review-table rows with warnings.
 *
 * PURE — the DB reads it needs are its arguments. Called on BOTH paths, so the
 * user's edits on confirm are validated by exactly the code that validated the
 * proposal; the client is a text editor, not an authority.
 */
export function normaliseRoster(input: NormaliseInput): NormalisedRoster {
  const existingKeys = new Set(
    input.existing.map((e) => dupKey(e.name || fullName(e.firstName, e.lastName), e.birthDate)),
  );
  const seenKeys = new Set<string>();

  let seatsLeft = input.remainingSeats;
  const unlimited = input.remainingSeats === -1;
  const out: GuidedSetupRosterRow[] = [];

  for (const raw of input.rows) {
    const firstName = raw.firstName ?? null;
    const lastName = raw.lastName ?? null;
    const name = fullName(firstName, lastName);
    const rawBirth = raw.birthDate ?? null;
    const birthDate = normaliseBirthDate(rawBirth, input.country);
    const gender = normaliseGender(raw.gender ?? null);
    const grade = normaliseGrade(raw.grade ?? null);

    const warnings: string[] = [];
    if (name === "") warnings.push("missingName");
    if (!rawBirth) warnings.push("missingBirthDate");
    else if (!birthDate) warnings.push("badBirthDate");

    const key = dupKey(name, birthDate);
    const duplicate = name !== "" && (existingKeys.has(key) || seenKeys.has(key));
    if (duplicate) warnings.push("duplicate");
    if (name !== "") seenKeys.add(key);

    const hasGuardianContact = !!(raw.guardianEmail || raw.guardianPhone);
    if (!hasGuardianContact) warnings.push("noGuardianContact");

    // Seats are consumed by the rows that would actually be created, in order.
    // A row already over the cap is flagged AND unchecked — the alternative is
    // a batch that half-succeeds and a user who cannot tell which half.
    const blocked = name === "";
    let overCap = false;
    if (!unlimited && !blocked) {
      if (seatsLeft <= 0) overCap = true;
      else seatsLeft -= 1;
    }
    if (overCap) warnings.push("overCap");

    // `include` respects the user's own checkbox on the confirm path, but a row
    // the server would refuse anyway is never re-checked by it.
    const requested = raw.include !== false;
    out.push({
      rowId: typeof raw.rowId === "string" && raw.rowId ? raw.rowId : randomUUID(),
      include: requested && !blocked && !overCap,
      firstName,
      lastName,
      birthDate,
      gender,
      grade,
      idNumber: raw.idNumber ?? null,
      guardianName: raw.guardianName ?? null,
      guardianEmail: raw.guardianEmail ?? null,
      guardianPhone: raw.guardianPhone ?? null,
      warnings,
    });
  }

  return { rows: out, remainingSeats: input.remainingSeats };
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * License head-room for this institute. -1 = unlimited, 0 = no room (which is
 * also what a license with `maxStudents: 0` means — "cannot add students").
 *
 * checkMaxStudents answers a yes/no about ONE student; the review table has to
 * show a NUMBER, so the same arithmetic is done here rather than calling it in
 * a loop (which would be N license lookups and N institute counts).
 */
export async function remainingSeats(instituteId: string): Promise<number> {
  const perms = await licenseService.getInstitutePermissions(instituteId, false);
  const max = perms.maxStudents;
  if (max === -1) return -1;
  if (!max || max <= 0) return 0;
  const enrolled = await instituteRepository.getStudentsInInstitute(instituteId);
  return Math.max(0, max - enrolled.length);
}

/** The institute's students, for the duplicate check. */
export async function existingStudents(instituteId: string): Promise<ExistingStudent[]> {
  const rows = await db
    .select({
      name: students.name,
      firstName: students.firstName,
      lastName: students.lastName,
      birthDate: students.birthDate,
    })
    .from(students)
    .innerJoin(instituteStudents, eq(instituteStudents.studentId, students.id))
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.isActive, true),
        isNull(students.deletedAt),
      ),
    );
  return rows.map((r) => ({
    name: r.name ?? "",
    firstName: r.firstName ?? null,
    lastName: r.lastName ?? null,
    birthDate: r.birthDate ?? null,
  }));
}

/** Normalise against live institute state. Used by propose AND confirm. */
export async function normaliseForInstitute(args: {
  instituteId: string;
  country: string | null;
  rows: Array<GuidedSetupRosterInputRow & { rowId?: string; include?: boolean }>;
}): Promise<NormalisedRoster> {
  const [seats, existing] = await Promise.all([
    remainingSeats(args.instituteId),
    existingStudents(args.instituteId),
  ]);
  return normaliseRoster({
    rows: args.rows,
    country: args.country,
    existing,
    remainingSeats: seats,
  });
}

/** A fresh proposal from normalised rows. */
export function makeProposal(normalised: NormalisedRoster): GuidedSetupRosterProposal {
  return {
    id: randomUUID(),
    rows: normalised.rows,
    remainingSeats: normalised.remainingSeats,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Confirm — the batch create
// ---------------------------------------------------------------------------

export interface ConfirmRosterInput {
  userId: string;
  instituteId: string;
  proposalId: string;
  rows: Array<GuidedSetupRosterInputRow & { rowId?: string; include?: boolean }>;
  /** Institute defaults for the students we create. */
  country: string | null;
  language: string | null;
}

export interface ConfirmRosterResult {
  created: GuidedSetupRosterCreated[];
  skipped: string[];
  failed: GuidedSetupRosterFailure[];
}

/** `students.country` is a two-letter code the consent notice keys off. */
function studentCountry(country: string | null): string | undefined {
  const c = (country ?? "").toUpperCase();
  return c === "IL" || c === "US" ? c : undefined;
}

/**
 * Create every included row.
 *
 * The caller has already verified membership. The license is checked TWICE:
 * once up front against the whole included set (so a batch that cannot fit is
 * refused as a batch, with nothing half-created), and again immediately before
 * each insert (so a concurrent create from another tab cannot walk the
 * institute past its cap one row at a time).
 */
export async function confirmRoster(input: ConfirmRosterInput): Promise<ConfirmRosterResult> {
  const { rows } = await normaliseForInstitute({
    instituteId: input.instituteId,
    country: input.country,
    rows: input.rows,
  });

  const created: GuidedSetupRosterCreated[] = [];
  const skipped: string[] = [];
  const failed: GuidedSetupRosterFailure[] = [];

  const included = rows.filter((r) => r.include);
  for (const row of rows) if (!row.include) skipped.push(row.rowId);
  if (included.length === 0) return { created, skipped, failed };

  // Up-front head-room. normaliseRoster already unchecked anything past the
  // cap, so this only fires when the cap moved between propose and confirm.
  const seats = await remainingSeats(input.instituteId);
  if (seats !== -1 && included.length > seats) {
    for (const row of included.slice(Math.max(0, seats))) {
      failed.push({ rowId: row.rowId, reason: "licenseCapReached" });
    }
    included.length = Math.max(0, seats);
  }

  for (const row of included) {
    try {
      // Re-check right before the write: another tab, another confirm, or the
      // rows we just created all move this number.
      const check = await licenseService.checkMaxStudents(input.instituteId, false);
      if (!check.allowed) {
        failed.push({ rowId: row.rowId, reason: "licenseCapReached" });
        continue;
      }

      const name = fullName(row.firstName, row.lastName);
      if (name === "") {
        failed.push({ rowId: row.rowId, reason: "rosterRowFailed" });
        continue;
      }

      const { student } = await studentService.createStudentWithLink(
        {
          name,
          firstName: row.firstName ?? undefined,
          lastName: row.lastName ?? undefined,
          birthDate: row.birthDate ?? undefined,
          gender: row.gender ?? undefined,
          primaryLanguage: input.language ?? "he",
          ...(studentCountry(input.country) ? { country: studentCountry(input.country) } : {}),
          isActive: true,
        } as never,
        input.userId,
        "owner",
      );

      await instituteRepository.assignStudentToInstitute(input.instituteId, student.id);

      // idNumber / grade live on the LINK, not the student: they are facts
      // about this enrolment, and the same person can carry a different number
      // in a second institute.
      if (row.idNumber || row.grade) {
        await db
          .update(instituteStudents)
          .set({
            ...(row.idNumber ? { idNumber: row.idNumber } : {}),
            ...(row.grade ? { grade: normaliseGrade(row.grade) ?? undefined } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(instituteStudents.instituteId, input.instituteId),
              eq(instituteStudents.studentId, student.id),
            ),
          );
      }

      if (row.guardianName || row.guardianEmail || row.guardianPhone) {
        await db.insert(studentContacts).values({
          studentId: student.id,
          name: row.guardianName || row.guardianEmail || row.guardianPhone || "Guardian",
          relationship: "parent",
          role: "parent_guardian",
          contactEmail: row.guardianEmail ?? null,
          contactPhone: row.guardianPhone ?? null,
          // Says WHERE this contact came from without claiming it was verified;
          // `isLegalGuardian` still flips only on a signature.
          provenance: { source: "roster" },
        });
      }

      // The flow record, so the rail's parked list picks the student up at the
      // consent gate straight away.
      await writeRecord(student.id, input.instituteId, {
        ...newRecord({ userId: input.userId, source: "roster" }),
        rosterBatchId: input.proposalId,
      });

      const details = changeDetails(
        summarizeChanges("students", null, {
          firstName: row.firstName,
          lastName: row.lastName,
          birthDate: row.birthDate,
          gender: row.gender,
        }),
        { via: "guided_setup", source: "roster", rosterBatchId: input.proposalId },
      );
      activityLogService.log({
        instituteId: input.instituteId,
        userId: input.userId,
        eventType: "create",
        subjectType1: "student",
        subjectId1: student.id,
        // A person pressed "Create". Logging this as AI-initiated would make
        // the audit trail lie about who decided to add thirty children.
        isAiInitiated: false,
        details: details ?? { via: "guided_setup", source: "roster" },
      });

      created.push({ rowId: row.rowId, studentId: student.id, name });
    } catch (err) {
      // One row's failure is its own. Never abandon the rest of the class.
      console.warn("[guided-setup] roster row failed:", row.rowId, err);
      failed.push({ rowId: row.rowId, reason: "rosterRowFailed" });
    }
  }

  return { created, skipped, failed };
}

// ---------------------------------------------------------------------------
// Session bookkeeping
// ---------------------------------------------------------------------------

/**
 * Drop a confirmed proposal from whichever of this user's chat sessions holds
 * it, so the next turn does not re-render a table of students that now exist.
 *
 * The confirm request is a REST click and carries no session id, so the
 * proposal is found by ITS OWN id across the user's open sessions. Best-effort:
 * a stale proposal is a stale table, not a data problem, and the propose path
 * replaces it wholesale anyway.
 */
export async function clearRosterProposal(userId: string, proposalId: string): Promise<void> {
  try {
    const sessions = await chatRepository.getOpenSessions(userId);
    for (const session of sessions) {
      const state = session.state as { guidedSetup?: { rosterProposal?: { id?: string } } } | null;
      if (state?.guidedSetup?.rosterProposal?.id !== proposalId) continue;
      const next = {
        ...state,
        guidedSetup: { ...state.guidedSetup, rosterProposal: null },
      };
      await chatRepository.updateSessionState(session.id, next as never);
    }
  } catch (err) {
    console.warn("[guided-setup] could not clear roster proposal:", err);
  }
}
