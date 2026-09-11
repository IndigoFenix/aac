// server/services/guided-setup/student-setup-queries.ts
//
// The real reads behind the student_setup flow's derived completion. Nothing
// here decides anything — it only reports what exists, so `isComplete` stays a
// pure function of the ctx (see flow-engine.ts).
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
 * `peopleAdded` is deliberately NOT "how many contacts exist". Three kinds of
 * row arrive without anybody answering step 5's question, and none of them may
 * finish the step on its own:
 *
 *  - `autoAdded` rows, which the AAC's Monitor creates from what it observed in
 *    a session and a human has not yet confirmed;
 *  - the guardian row `autoCreateGuardianContactForFamilyAdmin` writes when a
 *    family admin creates a student through the form — it is the SIGNED-IN USER
 *    themself, linked back to their own account. It carries `autoAdded = false`
 *    (it is a system row, not an AI guess), so an `autoAdded` test alone would
 *    let a family flow declare step 5 finished before it asked a single
 *    question.
 *  - the guardian the CONSENT stage asked an institution user for, so the
 *    request had somewhere to go. It is a plain human-entered contact on the
 *    row — nothing distinguishes it but being the row `loadConsentContact`
 *    picks — and counting it let step 5 satisfy itself before it was reached.
 *
 * What the step is actually asking for is who ELSE is in this person's life, so
 * that is what it counts.
 */
export interface StudentContactFacts {
  /** Active contacts of every kind — informational, never a completion test. */
  total: number;
  /**
   * Active contacts that are none of: auto-added, the user's own guardian row,
   * the consent guardian. One row per exclusion, never a class of row.
   */
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

  // Both guardian facts come off ONE read: "is there a guardian at all" and
  // "which guardian gets the link" are the same rows asked two ways, and this
  // runs inside a chat turn against a `max: 3` pool.
  const contacts = await loadActiveContactRows(studentId);

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
    hasGuardian: contacts.some(isGuardian),
    consentContact: toConsentFacts(pickConsentContact(contacts)),
  };
}

/**
 * ONE READ of this student's active contacts, and the fields every rule in this
 * file needs from them.
 *
 * `student_contacts` carries no institute column, so the student id is the
 * scope and `isActive` is the soft-delete (the caller has already verified
 * access for this institute — memory: feedback_family_access_scoping).
 *
 * Deliberately reads whole rows rather than asking the database a question per
 * rule. Three of them — "is there a guardian", "which guardian gets the consent
 * link", "how many people did somebody actually add" — are the SAME rows read
 * three ways, they are a handful of rows per student, and the pool is `max: 3`
 * (server/db.ts): every extra round trip inside a chat turn is a connection
 * somebody else is waiting for.
 */
async function loadActiveContactRows(studentId: string) {
  return db
    .select({
      id: studentContacts.id,
      name: studentContacts.name,
      relationship: studentContacts.relationship,
      role: studentContacts.role,
      linkedUserId: studentContacts.linkedUserId,
      contactEmail: studentContacts.contactEmail,
      contactPhone: studentContacts.contactPhone,
      autoAdded: studentContacts.autoAdded,
      createdAt: studentContacts.createdAt,
    })
    .from(studentContacts)
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));
}

type ContactRow = Awaited<ReturnType<typeof loadActiveContactRows>>[number];

const GUARDIAN_WORDS = /(parent|guardian|mother|father|mom|dad)/;

function filled(value: string | null): boolean {
  return !!value && value.trim() !== "";
}

/**
 * Reads as a guardian: the `parent_guardian` role, a relationship that says so
 * in words, or a contact linked to a real user account.
 *
 * ONE definition, in one place, on purpose. It used to be the same regex
 * hand-written into two queries, and `loadContactFacts` now has to agree with
 * `pickConsentContact` EXACTLY — a copy that drifted would silently either
 * double-count the consent guardian or drop a contact a person really added.
 */
function isGuardian(row: ContactRow): boolean {
  return (
    row.role === "parent_guardian" ||
    GUARDIAN_WORDS.test((row.relationship ?? "").toLowerCase()) ||
    !!row.linkedUserId
  );
}

/** Carries an address a consent link could actually be sent to. */
function isReachable(row: ContactRow): boolean {
  return filled(row.contactEmail) || filled(row.contactPhone);
}

/**
 * WHICH guardian is offered the consent link. Exactly one, deterministically.
 *
 * One is enough: the flow offers a single "send the request" action, and a list
 * of every contact in a prompt block is both a line-budget problem and a way to
 * have the model pick the wrong parent.
 *
 * The ORDER is load-bearing, not decoration. This was a `limit(1)` with no
 * `ORDER BY`, and Postgres promises nothing there: on a student with two
 * contactable guardians, the row named in the prompt block, the row the rail's
 * "Send consent request" button targets (`parked()` publishes this id) and the
 * row step 5 discounts could all be DIFFERENT rows, and two calls inside one
 * request could disagree — worse than picking the same "wrong" parent every
 * time. The rule, most significant first:
 *
 *  1. an explicit `role = 'parent_guardian'` over a guessed one (a relationship
 *     that merely reads as parental, or any linked account, is weaker evidence);
 *  2. a row with an email over a phone-only row — email is the channel
 *     `consentRequestLine` chooses whenever it can, and the one that needs no
 *     SMS provider configured;
 *  3. the oldest row, so the guardian already on file wins over one added later
 *     and the pick stops moving as contacts accumulate;
 *  4. `id`, so the order is TOTAL — two rows written in one statement share a
 *     `created_at` to the microsecond, and that is exactly the tie that made
 *     this non-deterministic. Sorting in TypeScript rather than SQL also keeps
 *     the tiebreak out of the database's collation.
 */
function pickConsentContact(rows: ContactRow[]): ContactRow | null {
  const eligible = rows.filter((r) => isGuardian(r) && isReachable(r));
  if (eligible.length === 0) return null;
  const rank = (r: ContactRow) => [
    r.role === "parent_guardian" ? 0 : 1,
    filled(r.contactEmail) ? 0 : 1,
    r.createdAt instanceof Date ? r.createdAt.getTime() : 0,
  ];
  return eligible.slice().sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

function toConsentFacts(row: ContactRow | null): ConsentContactFacts | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? "",
    hasEmail: filled(row.contactEmail),
    hasPhone: filled(row.contactPhone),
  };
}

/**
 * The guardian contact a consent request can be sent to, or null.
 *
 * Kept as its own entry point because tests and future callers ask this
 * question on its own; `loadBasicsFacts` derives it from the rows it has
 * already read rather than calling this and paying for a second query.
 */
export async function loadConsentContact(
  studentId: string,
): Promise<ConsentContactFacts | null> {
  return toConsentFacts(pickConsentContact(await loadActiveContactRows(studentId)));
}

/**
 * A guardian: role `parent_guardian`, a relationship that reads as
 * parent/guardian, or a contact linked to a real user account.
 */
export async function hasGuardianContact(studentId: string): Promise<boolean> {
  return (await loadActiveContactRows(studentId)).some(isGuardian);
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
 *
 * The consent guardian is discounted the same way, and for the same reason.
 * The consent stage ASKS an institution user for a guardian ("their name, their
 * relationship, and an email or phone") so the request can be sent at all, and
 * saves it through the same `Student_Contacts add` op — so it arrives here
 * looking exactly like a person somebody chose to add. Observed live: a clinic
 * patient with no contacts, the assistant took one guardian during the consent
 * wait, and step 5's dot went DONE before the step was ever reached. Step 5
 * asks who ELSE is in this person's life, so the row the flow itself asked for
 * is by construction not an answer to it.
 *
 * EXACTLY ONE row comes out — whichever `loadConsentContact` currently picks.
 * A co-parent, a second guardian, any other contactable parent the user
 * deliberately adds at step 5 still counts, or a family with only the other
 * parent left to list could never finish the step.
 */
export async function loadContactFacts(
  studentId: string,
  userId: string,
): Promise<StudentContactFacts> {
  // The SAME read the guardian rules use, and the same pick applied to it — no
  // second query, and no second copy of "which row is the consent one". A copy
  // is how the prompt block, the rail's send button and this count would come
  // to disagree; a second query is a third connection out of a pool of three,
  // inside a chat turn (see loadActiveContactRows).
  const rows = await loadActiveContactRows(studentId);
  const consentContactId = pickConsentContact(rows)?.id ?? null;

  return {
    total: rows.length,
    peopleAdded: rows.filter(
      (r) => !r.autoAdded && r.linkedUserId !== userId && r.id !== consentContactId,
    ).length,
  };
}
