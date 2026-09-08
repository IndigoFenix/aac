// server/services/guided-setup/student-setup-binding.ts
//
// One decision, on its own: may the student id a chat request carries BIND to
// an unbound GUIDED SETUP flow?
//
// It lives apart from student-setup-service.ts because it is PURE — no db, no
// clock, no env — and because it is the rule that decides whether a flow
// meant for a NEW student silently adopts an existing one. That deserves a
// DB-free test that does not have to import half the server to run.

import { GUIDED_SETUP_BIND_GRACE_MS, type GuidedSetupRecord } from "@shared/guided-setup";

export interface BindStudentDecision {
  /** The id the chat request carried (the user's CURRENT selection). */
  inputStudentId?: string | null;
  /** What was selected when the flow started. Never bindable. */
  ignoreStudentId?: string | null;
  /** `students.createdAt` for `inputStudentId`, or null when there is no row. */
  studentCreatedAt?: Date | string | null;
  /** ISO timestamp the flow started at (`GuidedSetupSessionState.startedAt`). */
  startedAt?: Date | string | null;
  /** Defaults to GUIDED_SETUP_BIND_GRACE_MS. */
  graceMs?: number;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every clinician chat request carries the currently selected student, so an
 * unbound flow that simply took it would adopt whoever was on screen when the
 * user pressed "New student" (observed live: the flow resumed Sam at step 2
 * instead of starting a new patient). A flow may only adopt a student it
 * plausibly CREATED:
 *
 *  - there is an id, and it is not the one selected when the flow started;
 *  - the row was created at or after the flow started, less a small grace for
 *    clock skew between the database and the app.
 *
 * Anything unverifiable — no `startedAt` (a session state written before the
 * field existed), no row, an unparseable timestamp — is a NO. The flow stays
 * unbound, which costs nothing: step 1 creates the student and the turn after
 * that binds it.
 */
export function canBindStudentToFlow(args: BindStudentDecision): boolean {
  const inputStudentId = args.inputStudentId ?? null;
  if (!inputStudentId) return false;
  if (args.ignoreStudentId && inputStudentId === args.ignoreStudentId) return false;

  const startedAt = toMillis(args.startedAt);
  const createdAt = toMillis(args.studentCreatedAt);
  if (startedAt === null || createdAt === null) return false;

  const grace = args.graceMs ?? GUIDED_SETUP_BIND_GRACE_MS;
  return createdAt >= startedAt - grace;
}

/** The newest institute student a discovery read handed back, if any. */
export interface DiscoveredStudent {
  id: string;
  /** `students.createdAt` of that row. */
  createdAt: Date | string | null;
}

/**
 * The same decision, applied to a student the SERVER found rather than one the
 * request named.
 *
 * Binding used to have exactly one source: the `studentId` on the next chat
 * request, which is only there because the model chose to call
 * `selectStudent(<new id>)`. When it did not (observed live, clinic
 * 2026-09-08), the flow stayed unbound forever — the rail said "No Patient
 * Selected" and the step-1 prompt could not name a single outstanding fact,
 * because as far as the ctx knew there was no student.
 *
 * Discovery closes that, and it goes through `canBindStudentToFlow` unchanged:
 * a pre-existing patient must be unreachable from a NEW-patient flow whichever
 * way the candidate arrived. The extra source is a second key to the same
 * lock, never a way around it.
 */
export function pickDiscoveredStudent(args: {
  candidate?: DiscoveredStudent | null;
  /** What was selected when the flow started. Never bindable, however it is found. */
  ignoreStudentId?: string | null;
  startedAt?: Date | string | null;
  graceMs?: number;
}): string | null {
  const candidate = args.candidate ?? null;
  if (!candidate?.id) return null;
  const ok = canBindStudentToFlow({
    inputStudentId: candidate.id,
    ignoreStudentId: args.ignoreStudentId ?? null,
    studentCreatedAt: candidate.createdAt ?? null,
    startedAt: args.startedAt ?? null,
    ...(args.graceMs !== undefined ? { graceMs: args.graceMs } : {}),
  });
  return ok ? candidate.id : null;
}

/**
 * May a chat turn RESUME this student's flow?
 *
 * The mirror image of `canBindStudentToFlow`: binding asks "did this flow make
 * that student?", resuming asks "is that student's flow still open?". Both are
 * the one decision that stands between a wizard and the wrong person's PHI, so
 * both are pure and both are pinned.
 *
 *  - no record → nothing to resume (the student was never in the flow);
 *  - `completedAt` → the setup is finished; re-opening it is a new decision;
 *  - `dismissedAt` → the user said "not now". The record survives so the parked
 *    list can still show the student, but no turn may re-open the flow.
 *
 * This is the same test the rail applies before it offers "Continue setup"
 * (GuidedSetupRail: `!record.completedAt && !record.dismissedAt`), so the button
 * and the turn it sends can never disagree about what is resumable.
 */
export function isResumableRecord(record: GuidedSetupRecord | null | undefined): boolean {
  if (!record) return false;
  return !record.completedAt && !record.dismissedAt;
}
