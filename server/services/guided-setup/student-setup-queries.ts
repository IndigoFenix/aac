// server/services/guided-setup/student-setup-queries.ts
//
// The real reads behind the student_setup flow's derived completion. Nothing
// here decides anything — it only reports what exists, so `isComplete` stays a
// pure function of the ctx (see chat/guided-flow/engine.ts).
//
// Every student-scoped read takes (studentId, instituteId): a family institute
// grants blanket access to its members, so the caller must have already
// verified access for THIS institute (memory: feedback_family_access_scoping).

import { and, desc, eq, gt, gte, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "../../db.js";
import {
  aacSettings,
  consentInvitations,
  educationalReports,
  functionalReports,
  goals,
  institutes,
  instituteStudents,
  medicalRecords,
  programs,
  studentContacts,
  students,
} from "@shared/schema";
import { licenseService } from "../licenseService.js";
import type { GuidedSetupAccount } from "@shared/guided-setup";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface StudentBasicsFacts {
  /** The student row exists AND is linked to this institute. */
  inInstitute: boolean;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  gender: string | null;
  primaryLanguage: string | null;
  country: string | null;
  framework: string | null;
  /** A guardian contact exists (role/relationship parent-guardian, or linked user). */
  hasGuardian: boolean;
  /**
   * The guardian a CONSENT request can actually be sent to, if any. Step 2's
   * waiting block names it so the AI can pass a real `contactId` to
   * `guidedSetup(requestConsent)` instead of guessing one.
   */
  consentContact: ConsentContactFacts | null;
}

export interface ConsentContactFacts {
  id: string;
  name: string;
  hasEmail: boolean;
  hasPhone: boolean;
}

export interface StudentReportFacts {
  /** At least one non-superseded medical / functional / educational report. */
  hasAnyReport: boolean;
  hasDiagnosis: boolean;
  hasAlerts: boolean;
  hasMedications: boolean;
}

export interface StudentProgramFacts {
  exists: boolean;
  hasActiveProgram: boolean;
  activeGoalCount: number;
  framework: string | null;
}

/**
 * Step 5 — the people around this person.
 *
 * `peopleAdded` is deliberately NOT "how many contacts exist". Two kinds of row
 * arrive without anybody deciding to add a person, and neither may finish the
 * step on its own:
 *
 *  - `autoAdded` rows, which the AAC's Monitor creates from what it observed in
 *    a session and a human has not yet confirmed;
 *  - the guardian row `autoCreateGuardianContactForFamilyAdmin` writes when a
 *    family admin creates a student through the form — it is the SIGNED-IN USER
 *    themself, linked back to their own account. It carries `autoAdded = false`
 *    (it is a system row, not an AI guess), so an `autoAdded` test alone would
 *    let a family flow declare step 5 finished before it asked a single
 *    question.
 *
 * What the step is actually asking for is who ELSE is in this person's life, so
 * that is what it counts.
 */
export interface StudentContactFacts {
  /** Active contacts of every kind — informational, never a completion test. */
  total: number;
  /** Active contacts that are neither auto-added nor the user's own guardian row. */
  peopleAdded: number;
}

export interface StudentAacFacts {
  enabled: boolean;
  voiceSet: boolean;
  /** Selection method / eyegaze / rest space have been decided. */
  inputDecided: boolean;
  /** chatAgentPrompt holds at least one rule. */
  rulesSet: boolean;
}

export interface InstituteFacts {
  id: string;
  name: string;
  account: GuidedSetupAccount;
  language: string | null;
  country: string | null;
}

// ---------------------------------------------------------------------------
// Institute + license
// ---------------------------------------------------------------------------

export async function loadInstituteFacts(instituteId: string): Promise<InstituteFacts | null> {
  const [row] = await db
    .select({
      id: institutes.id,
      name: institutes.name,
      type: institutes.type,
      language: institutes.language,
    })
    .from(institutes)
    .where(eq(institutes.id, instituteId));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    account: row.type as GuidedSetupAccount,
    language: row.language ?? null,
    // institutes carry no country column; the student's does the work.
    country: null,
  };
}

/** Whether the institute's license offers the AAC at all (step 4 is hidden otherwise). */
export async function loadAacLicensed(instituteId: string): Promise<boolean> {
  const perms = await licenseService.getInstitutePermissions(instituteId, false);
  return !!perms.aacEnabled;
}

/**
 * Does this institute already have at least one (non-deleted, actively
 * linked) student? Step 1's roster block leads with "send the whole list"
 * only for a brand-new institute — once there is a roster, pressing
 * "New student" almost always means adding one more.
 */
export async function loadInstituteHasStudents(instituteId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: instituteStudents.id })
    .from(instituteStudents)
    .innerJoin(students, eq(instituteStudents.studentId, students.id))
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.isActive, true),
        isNull(students.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * When a student row was created, or null when there is no such row.
 *
 * The one thing that tells "the student this flow just created" apart from
 * "the student the user already had selected when they pressed New student" —
 * the chat request body carries the same field for both. Deliberately NOT
 * folded into `loadBasicsFacts`: the decision is made BEFORE a ctx exists, and
 * a soft-deleted row must read as absent here exactly as it does there.
 */
export async function loadStudentCreatedAt(studentId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: students.createdAt })
    .from(students)
    .where(and(eq(students.id, studentId), isNull(students.deletedAt)));
  return row?.createdAt ?? null;
}

/** A student row an unbound flow could plausibly have created. */
export interface NewStudentCandidate {
  id: string;
  createdAt: Date;
}

/**
 * The newest student of this institute created at or after `since`.
 *
 * The DATA-side answer to "who did this flow just create?". Binding used to
 * depend entirely on the model calling `selectStudent(<new id>)` after its
 * `Context_Students add`, exactly as the step-1 block instructs — and observed
 * live (clinic, 2026-09-08) it simply did not: the patient count went 4 → 5,
 * the rail still said "No Patient Selected", `basics.inInstitute` stayed false
 * so nothing told the assistant which identity facts were outstanding, and the
 * turn wandered off to AAC. Flow correctness may not rest on the model
 * choosing to make a UI call.
 *
 * Same soft-delete and institute scoping as `loadInstituteHasStudents`; the
 * caller still applies `canBindStudentToFlow` to the row (via
 * `pickDiscoveredStudent`), so `since` is a cheap pre-filter, never the rule.
 */
export async function loadNewestStudentCreatedSince(
  instituteId: string,
  since: Date,
): Promise<NewStudentCandidate | null> {
  const [row] = await db
    .select({ id: students.id, createdAt: students.createdAt })
    .from(students)
    .innerJoin(instituteStudents, eq(instituteStudents.studentId, students.id))
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.isActive, true),
        isNull(students.deletedAt),
        gte(students.createdAt, since),
      ),
    )
    .orderBy(desc(students.createdAt))
    .limit(1);
  return row ? { id: row.id, createdAt: row.createdAt } : null;
}

// ---------------------------------------------------------------------------
// Step 1 — basics
// ---------------------------------------------------------------------------

export async function loadBasicsFacts(
  studentId: string,
  instituteId: string,
): Promise<StudentBasicsFacts> {
  const empty: StudentBasicsFacts = {
    inInstitute: false,
    name: null,
    firstName: null,
    lastName: null,
    birthDate: null,
    gender: null,
    primaryLanguage: null,
    country: null,
    framework: null,
    hasGuardian: false,
    consentContact: null,
  };

  const [row] = await db
    .select({
      name: students.name,
      firstName: students.firstName,
      lastName: students.lastName,
      birthDate: students.birthDate,
      gender: students.gender,
      primaryLanguage: students.primaryLanguage,
      country: students.country,
      framework: students.framework,
    })
    .from(students)
    .where(and(eq(students.id, studentId), isNull(students.deletedAt)));
  if (!row) return empty;

  const [link] = await db
    .select({ id: instituteStudents.id })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ),
    );

  return {
    inInstitute: !!link,
    name: row.name ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    birthDate: row.birthDate ?? null,
    gender: row.gender ?? null,
    primaryLanguage: row.primaryLanguage ?? null,
    country: row.country ?? null,
    framework: row.framework ?? null,
    hasGuardian: await hasGuardianContact(studentId),
    consentContact: await loadConsentContact(studentId),
  };
}

/**
 * The first guardian contact of this student that carries an email or a phone.
 *
 * One is enough: the flow offers a single "send the request" action, and a
 * list of every contact in a prompt block is both a line-budget problem and a
 * way to have the model pick the wrong parent.
 */
export async function loadConsentContact(
  studentId: string,
): Promise<ConsentContactFacts | null> {
  const [row] = await db
    .select({
      id: studentContacts.id,
      name: studentContacts.name,
      contactEmail: studentContacts.contactEmail,
      contactPhone: studentContacts.contactPhone,
    })
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        or(
          eq(studentContacts.role, "parent_guardian"),
          sql`lower(coalesce(${studentContacts.relationship}, '')) ~ '(parent|guardian|mother|father|mom|dad)'`,
          sql`${studentContacts.linkedUserId} is not null`,
        ),
        or(
          sql`coalesce(${studentContacts.contactEmail}, '') <> ''`,
          sql`coalesce(${studentContacts.contactPhone}, '') <> ''`,
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? "",
    hasEmail: !!row.contactEmail && row.contactEmail.trim() !== "",
    hasPhone: !!row.contactPhone && row.contactPhone.trim() !== "",
  };
}

/**
 * A contactable guardian: role `parent_guardian`, a relationship that reads as
 * parent/guardian, or a contact linked to a real user account.
 */
export async function hasGuardianContact(studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: studentContacts.id })
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        or(
          eq(studentContacts.role, "parent_guardian"),
          sql`lower(coalesce(${studentContacts.relationship}, '')) ~ '(parent|guardian|mother|father|mom|dad)'`,
          sql`${studentContacts.linkedUserId} is not null`,
        ),
      ),
    )
    .limit(1);
  return !!row;
}

/** Guardian contacts that carry an email or a phone (a consent request can be sent). */
export async function countContactableGuardians(studentId: string): Promise<number> {
  const rows = await db
    .select({ id: studentContacts.id })
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        or(
          eq(studentContacts.role, "parent_guardian"),
          sql`${studentContacts.linkedUserId} is not null`,
        ),
        or(
          sql`coalesce(${studentContacts.contactEmail}, '') <> ''`,
          sql`coalesce(${studentContacts.contactPhone}, '') <> ''`,
          sql`${studentContacts.linkedUserId} is not null`,
        ),
      ),
    );
  return rows.length;
}

/** A consent magic-link invitation that is still live (not redeemed, revoked or expired). */
export async function hasPendingConsentInvitation(studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: consentInvitations.id })
    .from(consentInvitations)
    .where(
      and(
        eq(consentInvitations.studentId, studentId),
        isNull(consentInvitations.redeemedAt),
        isNull(consentInvitations.revokedAt),
        gt(consentInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Step 2 — reports
// ---------------------------------------------------------------------------

function nonEmptyJsonArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export async function loadReportFacts(studentId: string): Promise<StudentReportFacts> {
  const medical = await db
    .select({
      primaryDiagnosis: medicalRecords.primaryDiagnosis,
      alertsAllergies: medicalRecords.alertsAllergies,
      alertsSeizures: medicalRecords.alertsSeizures,
      alertsCardiac: medicalRecords.alertsCardiac,
      medications: medicalRecords.medications,
    })
    .from(medicalRecords)
    .where(
      and(eq(medicalRecords.studentId, studentId), ne(medicalRecords.status, "superseded")),
    );

  const [functional] = await db
    .select({ id: functionalReports.id })
    .from(functionalReports)
    .where(
      and(
        eq(functionalReports.studentId, studentId),
        ne(functionalReports.status, "superseded"),
      ),
    )
    .limit(1);

  const [educational] = await db
    .select({ id: educationalReports.id })
    .from(educationalReports)
    .where(
      and(
        eq(educationalReports.studentId, studentId),
        ne(educationalReports.status, "superseded"),
      ),
    )
    .limit(1);

  return {
    hasAnyReport: medical.length > 0 || !!functional || !!educational,
    hasDiagnosis: medical.some((m) => !!m.primaryDiagnosis && m.primaryDiagnosis.trim() !== ""),
    hasAlerts: medical.some(
      (m) =>
        nonEmptyJsonArray(m.alertsAllergies) ||
        nonEmptyJsonArray(m.alertsSeizures) ||
        nonEmptyJsonArray(m.alertsCardiac),
    ),
    hasMedications: medical.some((m) => nonEmptyJsonArray(m.medications)),
  };
}

// ---------------------------------------------------------------------------
// Step 3 — program
// ---------------------------------------------------------------------------

export async function loadProgramFacts(
  studentId: string,
  instituteId: string,
): Promise<StudentProgramFacts> {
  // A family student's program may carry no instituteId, so we look at every
  // program for the student and prefer one bound to this institute.
  const rows = await db
    .select({
      id: programs.id,
      status: programs.status,
      framework: programs.framework,
      instituteId: programs.instituteId,
    })
    .from(programs)
    .where(eq(programs.studentId, studentId));

  const scoped = rows.filter((p) => !p.instituteId || p.instituteId === instituteId);
  if (scoped.length === 0) {
    return { exists: false, hasActiveProgram: false, activeGoalCount: 0, framework: null };
  }

  const active = scoped.find((p) => p.status === "active");
  const chosen = active ?? scoped[0];

  let activeGoalCount = 0;
  if (active) {
    const goalRows = await db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.programId, active.id), eq(goals.status, "active")));
    activeGoalCount = goalRows.length;
  }

  return {
    exists: true,
    hasActiveProgram: !!active,
    activeGoalCount,
    framework: chosen.framework ?? null,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — AAC
// ---------------------------------------------------------------------------

export async function loadAacFacts(studentId: string): Promise<StudentAacFacts> {
  const [row] = await db
    .select({
      enabled: aacSettings.enabled,
      voiceType: aacSettings.voiceType,
      customVoiceId: aacSettings.customVoiceId,
      selectionMethod: aacSettings.selectionMethod,
      eyegazeEnabled: aacSettings.eyegazeEnabled,
      eyegazeProvider: aacSettings.eyegazeProvider,
      chatAgentPrompt: aacSettings.chatAgentPrompt,
    })
    .from(aacSettings)
    .where(eq(aacSettings.studentId, studentId));

  if (!row) {
    return { enabled: false, voiceSet: false, inputDecided: false, rulesSet: false };
  }

  const prompts = row.chatAgentPrompt;
  const rulesSet = Array.isArray(prompts)
    ? prompts.some((p) => typeof p === "string" && p.trim() !== "")
    : typeof prompts === "string" && (prompts as string).trim() !== "";

  return {
    enabled: row.enabled === true,
    voiceSet: !!row.voiceType || !!row.customVoiceId,
    // "Decided" needs a POSITIVE signal: selectionMethod ("whole_button") and
    // restSpace ("large") ship with defaults, so a row nobody touched would
    // otherwise read as decided. Eyegaze on, an explicit provider, or a
    // non-default selection method all mean someone chose.
    inputDecided:
      row.eyegazeEnabled === true ||
      !!row.eyegazeProvider ||
      (!!row.selectionMethod && row.selectionMethod !== "whole_button"),
    rulesSet,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — contacts
// ---------------------------------------------------------------------------

/**
 * Who is on file for this student, and how many of them a person actually
 * chose to add.
 *
 * Same scoping as the guardian reads above: `student_contacts` carries no
 * institute column, so the student id is the scope and `isActive` is the
 * soft-delete (the caller has already verified access for this institute —
 * memory: feedback_family_access_scoping).
 *
 * `userId` is the signed-in user, used only to discount their OWN auto-created
 * guardian row. Passing it is not optional in practice: without it a family
 * student created through the StudentModal form arrives at step 5 already
 * "complete", and the step never asks anything.
 */
export async function loadContactFacts(
  studentId: string,
  userId: string,
): Promise<StudentContactFacts> {
  const rows = await db
    .select({
      id: studentContacts.id,
      autoAdded: studentContacts.autoAdded,
      linkedUserId: studentContacts.linkedUserId,
    })
    .from(studentContacts)
    .where(
      and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)),
    );

  return {
    total: rows.length,
    peopleAdded: rows.filter((r) => !r.autoAdded && r.linkedUserId !== userId).length,
  };
}
