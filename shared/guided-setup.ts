/**
 * Guided Setup — the server ↔ client contract for the chat-driven student
 * onboarding flow (plan: planning-docs/student-onboarding-flow-plan.md).
 *
 * Server: server/services/guided-setup/* — the flow engine (flow-*.ts) and
 *         the student_setup flow it runs.
 * Client: client/src/features/guided-setup/*.
 *
 * Everything here is a TYPE or a constant. No logic. Both sides import from
 * `@shared/guided-setup` so the shapes cannot drift.
 */

import type { FeatureType } from "./schema";

/** The one flow this contract currently describes. */
export const GUIDED_SETUP_FLOW_ID = "student_setup" as const;

/**
 * The hidden user message the client sends to open the flow. The server
 * treats it like any user turn; the client never renders it
 * (`metadata.hidden === true`).
 */
export const GUIDED_SETUP_KICKOFF = "[GUIDED SETUP] start" as const;

/**
 * The memory key the server sets every turn while the flow is active. It
 * reaches the client, lower-cased and stripped of the prefix, as
 * `contextData.guidedsetup` (see sessionService.extractContextFromMemoryValues).
 *
 * It carries a `GuidedSetupSignal`, NOT a `GuidedSetupView` — see that type.
 */
export const GUIDED_SETUP_CONTEXT_KEY = "Context_GuidedSetup" as const;
export const GUIDED_SETUP_CONTEXT_DATA_KEY = "guidedsetup" as const;

/** Name of the host tool the AI calls for flow control. */
export const GUIDED_SETUP_TOOL_NAME = "guidedSetup" as const;

/** `institutes.type` → who we are setting up. */
export type GuidedSetupAccount = "family" | "school" | "clinic";

/** Canonical prompt term per account type. "AAC USER" is allowed anywhere. */
export type GuidedSetupTerm = "CHILD" | "STUDENT" | "PATIENT";

export const GUIDED_SETUP_TERM_BY_ACCOUNT: Record<GuidedSetupAccount, GuidedSetupTerm> = {
  family: "CHILD",
  school: "STUDENT",
  clinic: "PATIENT",
};

export type GuidedSetupStepId = "basics" | "medical" | "program" | "aac" | "contacts";

export const GUIDED_SETUP_STEP_ORDER: readonly GuidedSetupStepId[] = [
  "basics",
  "medical",
  "program",
  "aac",
  // Step 5, added 2026-09-08 at the user's request ("There should also be a
  // fifth step, to add student contacts"). It comes LAST on purpose: the people
  // around a child are personal data, so it sits behind the same consent gate
  // as steps 2-4, and nothing earlier in the flow depends on it.
  "contacts",
];

/**
 * The feature panel that shows each step's data. Both sides read it: the
 * server puts it on every `GuidedSetupStepView`, the rail uses it to decide
 * which panel to open when the user clicks a step.
 */
export const GUIDED_SETUP_PANEL_BY_STEP: Record<GuidedSetupStepId, FeatureType> = {
  basics: "studentInfo",
  medical: "reports",
  program: "progress",
  aac: "aacsettings",
  contacts: "contacts",
};

/** Panel shown once the flow is finished. */
export const GUIDED_SETUP_DONE_PANEL: FeatureType = "students";

/** Steps the user may skip. `basics` never is. */
export type GuidedSetupSkippableStep = Exclude<GuidedSetupStepId, "basics">;

/**
 * The skippable steps as a VALUE.
 *
 * Two places used to hand-maintain this list — the `guidedSetup` tool schema
 * and the REST skip endpoint's zod enum — and a fifth step is exactly the kind
 * of change that updates one and forgets the other: the tool would offer
 * `contacts` while the controller rejected it, and the failure is a 400 the
 * user reads as "the assistant is broken".
 */
export const GUIDED_SETUP_SKIPPABLE_STEPS: readonly GuidedSetupSkippableStep[] =
  GUIDED_SETUP_STEP_ORDER.filter((s): s is GuidedSetupSkippableStep => s !== "basics");

export type GuidedSetupStepStatus =
  | "done"
  | "current"
  | "locked" // not reachable yet (earlier step incomplete, or consent gate closed)
  | "skipped"
  | "hidden"; // e.g. `aac` when the license has no aacEnabled

/**
 * Consent gate between step 1 and step 2.
 * - `off`           CONSENT_GATE_ENABLED is not "true": the gate does not apply.
 * - `none`          gate on, no guardian contact yet (nothing to sign / send).
 * - `sign_required` gate on, family account: the signed-in guardian signs in the wizard.
 * - `request_sent`  gate on, institution: a magic-link request is pending.
 * - `active`        consent is active; steps 2–4 are reachable.
 * - `revoked`       consent was revoked; behaves like `sign_required` / `request_sent`.
 */
export type GuidedSetupGate =
  | "off"
  | "none"
  | "sign_required"
  | "request_sent"
  | "active"
  | "revoked";

/** One line in the rail's per-step checklist; `key` → i18n `guidedSetup.checklist.<key>`. */
export interface GuidedSetupChecklistItem {
  key: string;
  done: boolean;
}

export interface GuidedSetupStepView {
  id: GuidedSetupStepId;
  status: GuidedSetupStepStatus;
  /** The feature panel that shows this step's data. */
  panel: FeatureType;
  checklist: GuidedSetupChecklistItem[];
}

/** A row the AI proposed from an uploaded roster (school / clinic step 1). Phase D. */
export interface GuidedSetupRosterRow {
  rowId: string;
  include: boolean;
  firstName: string | null;
  lastName: string | null;
  /** ISO YYYY-MM-DD */
  birthDate: string | null;
  gender: string | null;
  grade: string | null;
  /** The institution's own student / patient number — never a government ID. */
  idNumber: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  /** i18n keys under guidedSetup.roster.warn.* (duplicate, missingBirthDate, …). */
  warnings: string[];
}

export interface GuidedSetupRosterProposal {
  id: string;
  rows: GuidedSetupRosterRow[];
  /** License head-room at proposal time; -1 = unlimited. */
  remainingSeats: number;
  createdAt: string;
}

/** An institution student that is mid-setup (the rail's parked list). */
export interface GuidedSetupParkedStudent {
  studentId: string;
  name: string;
  step: GuidedSetupStepId | "done";
  gate: GuidedSetupGate;
  /**
   * The guardian contact a CONSENT request can be sent to, or null when this
   * student has none with an email / phone. The rail's batch button needs a
   * contact id per student and has no other way to learn one.
   */
  consentContactId?: string | null;
}

/** One row's outcome from POST /api/guided-setup/roster/confirm. */
export interface GuidedSetupRosterCreated {
  rowId: string;
  studentId: string;
  name: string;
}

export interface GuidedSetupRosterFailure {
  rowId: string;
  /** i18n key under guidedSetup.refused.* when known, else a bare code. */
  reason: string;
}

export interface GuidedSetupRosterConfirmResult {
  success: boolean;
  created: GuidedSetupRosterCreated[];
  /** rowIds the user unchecked, or that the server refused to even attempt. */
  skipped: string[];
  failed: GuidedSetupRosterFailure[];
  view: GuidedSetupView;
}

/** One item of POST /api/guided-setup/consent/request-batch. */
export interface GuidedSetupConsentBatchItem {
  studentId: string;
  contactId: string;
  channel: GuidedSetupConsentChannel;
}

export interface GuidedSetupConsentBatchOutcome {
  studentId: string;
  ok: boolean;
  /** i18n key under guidedSetup.refused.* when the send was refused. */
  reason?: string;
}

export interface GuidedSetupConsentBatchResult {
  success: boolean;
  results: GuidedSetupConsentBatchOutcome[];
  view: GuidedSetupView;
}

/** The last flow action the server refused, so the AI and the rail can both explain. */
export interface GuidedSetupRefusal {
  action: string;
  /** i18n key under guidedSetup.refused.* */
  reason: string;
}

/**
 * What the server computes every turn (and on GET) and what the rail renders.
 * `step` is the CURRENT step; `steps` carries every step's status + checklist.
 */
export interface GuidedSetupView {
  flow: typeof GUIDED_SETUP_FLOW_ID;
  active: boolean;
  account: GuidedSetupAccount;
  term: GuidedSetupTerm;
  instituteId: string;
  studentId: string | null;
  step: GuidedSetupStepId | "done";
  steps: GuidedSetupStepView[];
  gate: GuidedSetupGate;
  /** The panel to show right now (the current step's panel, or `students` when done). */
  panel: FeatureType;
  /** UI locale the user is working in (from the request), e.g. "he". */
  lang: string;
  roster?: GuidedSetupRosterProposal | null;
  parked?: GuidedSetupParkedStudent[];
  refused?: GuidedSetupRefusal | null;
  /**
   * The persisted record for (institute, student), or null when the student
   * was never put through the flow. Lets the rail tell "resumable" apart from
   * "never started" without a second request.
   */
  record?: Pick<GuidedSetupRecord, "source" | "startedAt" | "completedAt" | "dismissedAt"> | null;
}

/**
 * WHAT RIDES THE CHAT RESPONSE (`Context_GuidedSetup` → `contextData.guidedsetup`).
 *
 * NOT the view. The view is an ordinary react-query query over
 * `GET /api/guided-setup/students/:id`, invalidated when a turn ends — every
 * field of it is DERIVED from rows, so a refetch reproduces it exactly.
 *
 * This is the remainder: the part of a running flow that lives in
 * `chat_sessions.state.guidedSetup` (or, for `refused`, nowhere at all) and
 * that no GET can therefore reproduce. Four values, and only four:
 *
 *  - `active`   — a flow is running in THIS chat. NOT the same fact as
 *                 `view.active`, which is merely "this student's setup is
 *                 unfinished" and is true on a GET for anyone mid-profile.
 *  - `studentId`— who the flow BOUND to, which can happen mid-turn by
 *                 discovery when the model never calls `selectStudent`.
 *  - `roster`   — a proposal awaiting confirmation. Session state; the GET
 *                 always answers `roster: null`.
 *  - `refused`  — the reason a flow action was rejected. Produced by a tool
 *                 call and persisted nowhere, so it is TURN-LOCAL: it rides
 *                 the turn that produced it and no other.
 *
 * `panel` is derived (it is `view.panel`) but rides along because the panel
 * switch is an EVENT — it fires on the turn, not on every re-render of a view.
 */
export interface GuidedSetupSignal {
  active: boolean;
  instituteId: string;
  studentId: string | null;
  panel?: FeatureType;
  roster?: GuidedSetupRosterProposal | null;
  refused?: GuidedSetupRefusal | null;
}

/**
 * Persisted per (institute, student) in `institute_students.data.onboarding`.
 * Completion is DERIVED from data; only skips, acknowledgements and dismissals
 * live here.
 */
export interface GuidedSetupRecord {
  v: 1;
  source: "chat" | "roster" | "form";
  startedAt: string;
  startedByUserId: string;
  skipped: GuidedSetupSkippableStep[];
  /** Set when the user (or the AI on the user's behalf) finished reviewing AAC settings. */
  aacReviewedAt?: string;
  /** The user answered "not an AAC user" in step 4. */
  notAacUser?: true;
  completedAt?: string;
  dismissedAt?: string;
  rosterBatchId?: string;
}

export const GUIDED_SETUP_RECORD_KEY = "onboarding" as const;

/** Per-chat-session state, stored in `chat_sessions.state.guidedSetup`. */
export interface GuidedSetupSessionState {
  active: boolean;
  /** null until step 1 creates the student (or the user picks a parked one). */
  studentId: string | null;
  instituteId: string;
  rosterProposal?: GuidedSetupRosterProposal | null;
  /**
   * ISO timestamp of the turn that opened this flow. It is the yardstick for
   * the null→value fill-in: only a student row CREATED at or after it (minus
   * `GUIDED_SETUP_BIND_GRACE_MS`) can be the one this flow made.
   *
   * Optional on the type, not in practice: a session state written before this
   * field existed has none, and an unverifiable fill-in is refused rather than
   * guessed.
   */
  startedAt?: string;
  /**
   * Whatever student the user happened to have SELECTED when the flow started.
   * The chat request body always carries the current selection, so without
   * this "New student" would silently adopt the student already on screen
   * (observed live: pressing New Patient resumed Sam at step 2).
   */
  ignoreStudentId?: string | null;
}

/**
 * How much earlier than `startedAt` a student row may have been created and
 * still count as "this flow made them". Covers clock skew between the row's
 * `createdAt` (database clock) and `startedAt` (app clock), plus the turn the
 * client spent opening the flow.
 */
export const GUIDED_SETUP_BIND_GRACE_MS = 60_000;

/** Optional field on the chat request body. */
export interface GuidedSetupRequest {
  /**
   * First turn: open the flow for the selected institute, for a NEW student.
   * Always begins UNBOUND (see `GuidedSetupSessionState.ignoreStudentId`).
   */
  start?: boolean;
  /**
   * Resume an existing student's flow (the rail's "Continue setup").
   *
   * A separate field rather than a `start` with a student on the request, because
   * `start` deliberately ignores the selected student: overloading it is exactly
   * how "Continue setup" on a parked patient opened a fresh unbound step-1 flow
   * that asked a clinic for its patient list.
   */
  resumeStudentId?: string;
}

/** Actions of the `guidedSetup` host tool. Flow-specific ones land in later phases. */
export type GuidedSetupAction =
  | "status"
  | "advance"
  | "skip"
  | "back"
  | "proposeRoster" // Phase D
  | "requestConsent" // Phase C
  | "setAacUser" // Phase C
  | "activateProgram"; // Phase C

/** The flow-control subset the engine implements today (Phase A). */
export type GuidedSetupFlowAction = Extract<
  GuidedSetupAction,
  "status" | "advance" | "skip" | "back"
>;

export const GUIDED_SETUP_FLOW_ACTIONS: readonly GuidedSetupFlowAction[] = [
  "status",
  "advance",
  "skip",
  "back",
];

/**
 * Actions that touch data outside the flow record (Phase C). They still write
 * nothing the AI could have written itself through manageMemory: each one is a
 * decision the SERVER owns — activating a program, marking a student an AAC
 * user, sending a consent request.
 */
export type GuidedSetupHostAction = Extract<
  GuidedSetupAction,
  "activateProgram" | "setAacUser" | "requestConsent" | "proposeRoster"
>;

export const GUIDED_SETUP_HOST_ACTIONS: readonly GuidedSetupHostAction[] = [
  "activateProgram",
  "setAacUser",
  "requestConsent",
  "proposeRoster",
];

/** Everything the `guidedSetup` tool accepts today (flow control + host actions). */
export type GuidedSetupToolAction = GuidedSetupFlowAction | GuidedSetupHostAction;

export const GUIDED_SETUP_TOOL_ACTIONS: readonly GuidedSetupToolAction[] = [
  ...GUIDED_SETUP_FLOW_ACTIONS,
  ...GUIDED_SETUP_HOST_ACTIONS,
];

/** Channels a consent invitation may go out on from the flow. */
export type GuidedSetupConsentChannel = "email" | "sms";

/**
 * One row exactly as the AI read it off an uploaded roster. Every field is
 * optional and may be null: the model is told to mark anything unreadable null
 * rather than guess, so the server normalises and warns instead of trusting.
 */
export interface GuidedSetupRosterInputRow {
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: string | null;
  gender?: string | null;
  grade?: string | null;
  idNumber?: string | null;
  guardianName?: string | null;
  guardianEmail?: string | null;
  guardianPhone?: string | null;
}

/** Hard cap on a proposal. A roster larger than this is a paste, not a class. */
export const GUIDED_SETUP_ROSTER_MAX_ROWS = 500;

/** Arguments of the `guidedSetup` host tool. */
export interface GuidedSetupToolArgs {
  action: GuidedSetupToolAction;
  /** Which step to skip. Defaults to the current step. `skip` only. */
  step?: GuidedSetupSkippableStep;
  /** `setAacUser` only: does this student use the AAC app? */
  value?: boolean;
  /** `requestConsent` only: the guardian contact to send the magic link to. */
  contactId?: string;
  /** `requestConsent` only: which of the contact's addresses to use. */
  channel?: GuidedSetupConsentChannel;
  /** `proposeRoster` only: the rows the AI read from the uploaded roster. */
  rows?: GuidedSetupRosterInputRow[];
}

/**
 * Every reason the server can refuse a flow action. The client maps each to
 * `guidedSetup.refused.<reason>`; the AI reads the raw key off the tool result.
 */
export const GUIDED_SETUP_REFUSAL_REASONS = [
  /** The current step's checklist is not satisfied yet. */
  "stepIncomplete",
  /** `skip` on a step that may not be skipped (or one already done). */
  "notSkippable",
  /** Consent gate is on and this student has no active consent. */
  "consentRequired",
  /** Step 3: no program row exists at all. */
  "programMissing",
  /** Step 3: a program exists but it (or all its goals) are still draft. */
  "programDraft",
  /** The action needs a persisted record and the student has none. */
  "notStarted",
  /** `skip` named a step this flow does not have. */
  "unknownStep",
  /** The tool was called with an action this phase does not implement. */
  "unknownAction",
  /** `setAacUser` on an institute whose license has no `aacEnabled`. */
  "aacNotLicensed",
  /** `requestConsent` while CONSENT_GATE_ENABLED is off — there is nothing to request. */
  "consentGateOff",
  /** `requestConsent` named no contact of this student, or one with no email / phone. */
  "guardianMissing",
  /** `requestConsent` for a student whose consent is already signed and active. */
  "alreadyActive",
  /** `proposeRoster` on a family account — a family sets up one child in chat. */
  "rosterNotForFamily",
  /** A roster proposal or confirmation carried no usable rows. */
  "rosterEmpty",
  /** `roster/confirm` named a proposal this session no longer holds. */
  "rosterProposalMissing",
  /** The institute's license has no room left for another student. */
  "licenseCapReached",
  /** One roster row could not be created; the rest of the batch still ran. */
  "rosterRowFailed",
] as const;

export type GuidedSetupRefusalReason = (typeof GUIDED_SETUP_REFUSAL_REASONS)[number];

/** REST surface (server/controllers/guidedSetupController.ts). */
export const GUIDED_SETUP_ROUTES = {
  start: "/api/guided-setup/start", // POST { instituteId } → { success, view, instituteCreated? }
  student: (studentId: string) => `/api/guided-setup/students/${studentId}`, // GET ?instituteId= → { success, view }
  parked: "/api/guided-setup", // GET ?instituteId= → { success, parked }
  /** Put an existing student (e.g. one created through the StudentModal form) into the flow. */
  adopt: (studentId: string) => `/api/guided-setup/students/${studentId}/adopt`, // POST { instituteId, source? } → { success, view }
  skip: (studentId: string) => `/api/guided-setup/students/${studentId}/skip`, // POST { instituteId, step } → { success, view }
  dismiss: (studentId: string) => `/api/guided-setup/students/${studentId}/dismiss`, // POST { instituteId } → { success, view }
  ackAac: (studentId: string) => `/api/guided-setup/students/${studentId}/ack-aac`, // POST { instituteId } → { success, view }
  rosterConfirm: "/api/guided-setup/roster/confirm", // Phase D
  consentRequestBatch: "/api/guided-setup/consent/request-batch", // Phase D
} as const;

/** Client-side session storage key for "Not now" on the zero-student auto-launch. */
export const GUIDED_SETUP_NOT_NOW_KEY = "guidedSetup.notNow" as const;
