// server/services/guided-setup/student-setup-actions.ts
//
// The three GUIDED SETUP host actions (plan §3.10, §3.11, §3.8). Each one is a
// decision the SERVER owns and the AI may only ask for:
//
//   activateProgram — a draft program is invisible to the AAC, so "activate"
//                     is a real transition, not a field the model can set.
//   setAacUser      — `aac_settings.enabled` is a MARKER ("this student uses
//                     the AAC app"), deliberately not AI-writable (decision 6).
//   requestConsent  — sends a magic link to a guardian; the gate must be on,
//                     the contact must be this student's, and it must have the
//                     address the chosen channel needs.
//
// Every one returns a refusal REASON rather than throwing: the model reads it
// off the tool result and explains it. A raised ConsentGateError would reach
// the model as an opaque tool failure and, worse, would leak the platform's
// internal message into the conversation.

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../../db.js";
import { goals, objectives, programs, studentContacts } from "@shared/schema";
import type {
  GuidedSetupConsentChannel,
  GuidedSetupRefusalReason,
} from "@shared/guided-setup";

import { activityLogService } from "../activityLogService.js";
import { changeDetails, summarizeChanges } from "../activityChanges.js";
import { aacSettingsRepository } from "../../repositories/aacSettingsRepository.js";
import {
  ConsentGateError,
  getConsentStatus,
  isConsentGateEnabled,
  requireActiveConsent,
} from "../consent/consentGate.js";
import { consentInvitationService } from "../consent/consentInvitationService.js";
import { programService } from "../programService.js";
import { loadAacLicensed } from "./student-setup-queries.js";
import { newRecord, updateRecord } from "./student-setup-state.js";

/** null = the action succeeded; a string = the reason the flow refused it. */
export type ActionRefusal = GuidedSetupRefusalReason | null;

export interface HostActionInput {
  userId: string;
  instituteId: string;
  studentId: string | null;
}

/**
 * The consent gate, as a refusal instead of an exception.
 *
 * `requireActiveConsent` is the platform's own helper — reusing it is what
 * keeps the flow from drifting into a second, softer rule (plan decision 1).
 */
async function consentRefusal(studentId: string): Promise<ActionRefusal> {
  try {
    await requireActiveConsent(studentId);
    return null;
  } catch (err) {
    if (err instanceof ConsentGateError) return "consentRequired";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// activateProgram
// ---------------------------------------------------------------------------

/**
 * Activate the student's newest program and lift its DRAFT goals and their
 * objectives to `active`.
 *
 * Draft rows are invisible to the AAC (aac-memory-schema loads only active
 * programs and active goals), so activating the program alone would leave the
 * assistant with a program and nothing in it — exactly the state step 3's
 * `programDraft` refusal exists to prevent.
 */
export async function activateProgramAction(input: HostActionInput): Promise<ActionRefusal> {
  if (!input.studentId) return "notStarted";

  const gate = await consentRefusal(input.studentId);
  if (gate) return gate;

  // A family student's program may carry no instituteId, so accept both an
  // unbound program and one bound to THIS institute (mirrors loadProgramFacts).
  const rows = await db
    .select({ id: programs.id, instituteId: programs.instituteId, status: programs.status })
    .from(programs)
    .where(eq(programs.studentId, input.studentId))
    .orderBy(desc(programs.createdAt));

  const program = rows.find((p) => !p.instituteId || p.instituteId === input.instituteId);
  if (!program) return "programMissing";

  await programService.activateProgram(program.id);

  const programGoals = await db
    .select({ id: goals.id, status: goals.status })
    .from(goals)
    .where(eq(goals.programId, program.id));

  const draftGoalIds = programGoals.filter((g) => g.status === "draft").map((g) => g.id);
  if (draftGoalIds.length > 0) {
    await db
      .update(goals)
      .set({ status: "active", updatedAt: new Date() })
      .where(inArray(goals.id, draftGoalIds));
  }
  // Objectives of EVERY goal in the program, not only the ones we just lifted:
  // a goal activated earlier by hand can still be carrying draft objectives,
  // and half an activated program is the state this action exists to prevent.
  if (programGoals.length > 0) {
    await db
      .update(objectives)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(
          inArray(
            objectives.goalId,
            programGoals.map((g) => g.id),
          ),
          eq(objectives.status, "draft"),
        ),
      );
  }

  activityLogService.log({
    instituteId: input.instituteId,
    userId: input.userId,
    eventType: "update",
    subjectType1: "program",
    subjectId1: program.id,
    subjectType2: "student",
    subjectId2: input.studentId,
    isAiInitiated: true,
    details: {
      via: "guided_setup",
      action: "activateProgram",
      changes: { status: { from: program.status, to: "active" } },
      goalsActivated: draftGoalIds.length,
    },
  });

  return null;
}

// ---------------------------------------------------------------------------
// setAacUser
// ---------------------------------------------------------------------------

/**
 * Record whether this student uses the AAC app.
 *
 * `true`  → `aac_settings.enabled` (through the repository, so external-storage
 *           extraction is honoured) plus a field-level audit row. The record's
 *           `notAacUser` marker is cleared: a user who says "no" and then "yes"
 *           must not leave step 4 complete on the stale answer.
 * `false` → the record's `notAacUser` marker, and `enabled` back to false.
 */
export async function setAacUserAction(
  input: HostActionInput & { value: boolean },
): Promise<ActionRefusal> {
  if (!input.studentId) return "notStarted";
  if (!(await loadAacLicensed(input.instituteId))) return "aacNotLicensed";

  const gate = await consentRefusal(input.studentId);
  if (gate) return gate;

  const before = await aacSettingsRepository.getByStudentId(input.studentId);
  const updates = { enabled: input.value };
  await aacSettingsRepository.upsert(input.studentId, updates);

  const details = changeDetails(summarizeChanges("aac_settings", before ?? null, updates), {
    via: "guided_setup",
    action: "setAacUser",
  });
  if (details) {
    activityLogService.log({
      instituteId: input.instituteId,
      userId: input.userId,
      eventType: "update",
      subjectType1: "student",
      subjectId1: input.studentId,
      isAiInitiated: true,
      details,
    });
  }

  const studentId = input.studentId;
  await updateRecord(studentId, input.instituteId, (current) => {
    // "not an AAC user" is the ONLY thing that makes step 4 complete without
    // settings, so it needs a record even on a student the flow never opened.
    const base = current ?? newRecord({ userId: input.userId });
    if (input.value) {
      if (!base.notAacUser) return current ? null : base;
      const { notAacUser: _dropped, ...rest } = base;
      return rest;
    }
    return base.notAacUser ? null : { ...base, notAacUser: true as const };
  });

  return null;
}

// ---------------------------------------------------------------------------
// requestConsent
// ---------------------------------------------------------------------------

/**
 * Send a guardian the consent magic link.
 *
 * Institution path only in spirit — a family guardian signs in the SIDE PANEL —
 * but nothing here forbids a family account: the refusals are about the gate
 * and the contact, and a family admin who asks for a link should get one.
 *
 * This is a HOST action, not the `sendEmail` chat tool, so it never widens the
 * agent's tool surface: sessionService's PHI + outbound-tool guard inspects
 * `template.tools`, which this path does not touch.
 */
export async function requestConsentAction(
  input: HostActionInput & { contactId: string; channel: GuidedSetupConsentChannel },
): Promise<ActionRefusal> {
  if (!input.studentId) return "notStarted";
  if (!isConsentGateEnabled()) return "consentGateOff";

  // Legacy grace is deliberately NOT treated as "already active" here: the
  // grace window is a deadline, not a signature, and a request sent inside it
  // is exactly what closes it.
  const status = await getConsentStatus(input.studentId);
  if (status.hasActiveConsent) return "alreadyActive";

  const [contact] = await db
    .select({
      id: studentContacts.id,
      contactEmail: studentContacts.contactEmail,
      contactPhone: studentContacts.contactPhone,
    })
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.id, input.contactId),
        eq(studentContacts.studentId, input.studentId),
        eq(studentContacts.isActive, true),
      ),
    );
  if (!contact) return "guardianMissing";

  const address = input.channel === "email" ? contact.contactEmail : contact.contactPhone;
  if (!address || address.trim() === "") return "guardianMissing";

  try {
    await consentInvitationService.createInvitation({
      studentId: input.studentId,
      contactId: contact.id,
      sourceInstituteId: input.instituteId,
      createdByUserId: input.userId,
      channel: input.channel,
    });
  } catch (err) {
    // createInvitation's own refusals (missing channel, wrong recipient type
    // for a self-consent student) all mean the same thing to the user: this
    // guardian cannot be sent a link. Never surface the internal code.
    console.warn("[guided-setup] requestConsent failed:", err);
    return "guardianMissing";
  }

  return null;
}
