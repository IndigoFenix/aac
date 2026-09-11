// server/services/guided-setup/student-setup-service.ts
//
// The CliniAACian half of GUIDED SETUP: resolve the ctx from the database,
// run the generic engine over the `student_setup` definition, persist the
// record, and hand back the client-facing `GuidedSetupView`.
//
// Every entry point checks institute membership first, and student access
// second. A family institute grants blanket access to its members, so nothing
// here may take an instituteId on trust (memory: feedback_family_access_scoping).

import {
  GUIDED_SETUP_BIND_GRACE_MS,
  GUIDED_SETUP_DONE_PANEL,
  GUIDED_SETUP_FLOW_ACTIONS,
  GUIDED_SETUP_FLOW_ID,
  GUIDED_SETUP_HOST_ACTIONS,
  type GuidedSetupAccount,
  type GuidedSetupConsentChannel,
  type GuidedSetupHostAction,
  type GuidedSetupGate,
  type GuidedSetupParkedStudent,
  type GuidedSetupRecord,
  type GuidedSetupRosterProposal,
  type GuidedSetupSkippableStep,
  type GuidedSetupStepId,
  type GuidedSetupTerm,
  type GuidedSetupView,
} from "@shared/guided-setup";
import { DEFAULT_LICENSE_PERMISSIONS, type LicensePermissions } from "@shared/license-permissions";

import { applyAction, resolveFlowView, stepPosition } from "./flow-engine.js";
import { renderGuidedSetupSection } from "./flow-prompt-section.js";
import type { GuidedFlowActionInput, GuidedFlowView } from "./flow-types.js";
import { getConsentStatus, isConsentGateEnabled } from "../consent/consentGate.js";
import { instituteRepository, licenseRepository } from "../../repositories/index.js";
import { instituteService } from "../instituteService.js";
import { studentService } from "../studentService.js";
import { userService } from "../userService.js";
import { termForAccount } from "./terms.js";
import {
  canBindStudentToFlow,
  isResumableRecord,
  pickDiscoveredStudent,
  type BindStudentDecision,
  type DiscoveredStudent,
} from "./student-setup-binding.js";
import {
  activateProgramAction,
  requestConsentAction,
  setAacUserAction,
  type ActionRefusal,
} from "./student-setup-actions.js";
import {
  EMPTY_AAC,
  EMPTY_BASICS,
  EMPTY_CONTACTS,
  EMPTY_PROGRAM,
  EMPTY_REPORTS,
  currentStepBlockedBy,
  renderStudentSetupBlock,
  studentSetupFlow,
  type StudentSetupCtx,
} from "./student-setup-flow.js";
import {
  hasPendingConsentInvitation,
  loadAacFacts,
  loadAacLicensed,
  loadBasicsFacts,
  loadContactFacts,
  loadInstituteFacts,
  loadInstituteHasStudents,
  loadProgramFacts,
  loadNewestStudentCreatedSince,
  loadReportFacts,
  loadStudentCreatedAt,
} from "./student-setup-queries.js";
import {
  clearRosterProposal,
  confirmRoster,
  makeProposal,
  normaliseForInstitute,
  rosterConfirmRowsSchema,
  rosterInputSchema,
} from "./roster-import.js";
import {
  listRecords,
  newRecord,
  readRecord,
  writeRecord,
} from "./student-setup-state.js";

export class GuidedSetupError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.name = "GuidedSetupError";
  }
}

/**
 * The license a self-registered user's fallback family institute gets. Not a
 * product tier — just enough to let the flow run (maxStudents MUST be > 0;
 * DEFAULT_LICENSE_PERMISSIONS ships 0, which would block step 1 immediately).
 * Decision 2 of the plan: this path should never be hit in practice.
 */
export const DEFAULT_FAMILY_LICENSE_PERMISSIONS: LicensePermissions = {
  ...DEFAULT_LICENSE_PERMISSIONS,
  maxStudents: 1,
  maxDevicesPerStudent: 2,
  aacEnabled: true,
  boardMakerEnabled: true,
  calendar: true,
  dashboardLevel: 1,
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function requireMembership(instituteId: string, userId: string): Promise<void> {
  const { isMember } = await instituteService.verifyMembership(instituteId, userId);
  if (!isMember) {
    throw new GuidedSetupError(403, "FORBIDDEN_INSTITUTE", "Not a member of this institute");
  }
}

async function requireStudentAccess(
  studentId: string,
  userId: string,
  instituteId: string,
): Promise<void> {
  const access = await studentService.verifyStudentAccess(studentId, userId, instituteId);
  if (!access.hasAccess) {
    throw new GuidedSetupError(403, "FORBIDDEN_STUDENT", "No access to this student");
  }
}

// ---------------------------------------------------------------------------
// Flow binding — which student (if any) an active flow is about
// ---------------------------------------------------------------------------

// The rules themselves are pure and live in student-setup-binding.ts; they are
// re-exported here so callers have one guided-setup entry point.
export {
  canBindStudentToFlow,
  isResumableRecord,
  pickDiscoveredStudent,
  type BindStudentDecision,
  type DiscoveredStudent,
};

/**
 * The student an active chat flow is about, this turn.
 *
 * Once bound, a flow stays bound (the fill-in is a one-way door). While
 * unbound it reads `students.createdAt` for the selected id and applies
 * `canBindStudentToFlow`.
 */
export async function resolveFlowStudentId(args: {
  /** The id already stored on the session's flow state, if any. */
  boundStudentId: string | null;
  inputStudentId: string | null;
  ignoreStudentId?: string | null;
  startedAt?: string | null;
}): Promise<string | null> {
  if (args.boundStudentId) return args.boundStudentId;
  const candidate = args.inputStudentId ?? null;
  if (!candidate) return null;
  if (args.ignoreStudentId && candidate === args.ignoreStudentId) return null;
  if (!args.startedAt) return null;

  const createdAt = await loadStudentCreatedAt(candidate);
  return canBindStudentToFlow({
    inputStudentId: candidate,
    ignoreStudentId: args.ignoreStudentId ?? null,
    studentCreatedAt: createdAt,
    startedAt: args.startedAt,
  })
    ? candidate
    : null;
}

/**
 * The student an active UNBOUND flow just created, discovered from the DATA.
 *
 * `resolveFlowStudentId` can only bind what the request already names, and the
 * request only names it because the model chose to call `selectStudent`. It
 * did not (clinic, 2026-09-08): the patient was created, the flow stayed
 * unbound, `basics.inInstitute` stayed false, the STILL MISSING block never
 * rendered and the turn jumped to a consent-gated AAC question. This is the
 * source that does not depend on a UI call being made.
 *
 * The guard is the SAME one (`canBindStudentToFlow`, via
 * `pickDiscoveredStudent`), so an institute's pre-existing patients stay
 * unreachable. Access is checked here rather than left to `resolveForChat`: a
 * throw there takes the whole flow section down with it, and a student we
 * merely FOUND deserves a null, not an exception.
 */
export async function discoverFlowStudentId(args: {
  userId: string;
  instituteId: string;
  /** `GuidedSetupSessionState.startedAt`. No timestamp, no discovery. */
  startedAt?: string | null;
  ignoreStudentId?: string | null;
  graceMs?: number;
}): Promise<string | null> {
  if (!args.startedAt) return null;
  const startedMs = Date.parse(args.startedAt);
  if (!Number.isFinite(startedMs)) return null;

  const graceMs = args.graceMs ?? GUIDED_SETUP_BIND_GRACE_MS;
  await requireMembership(args.instituteId, args.userId);

  const candidate: DiscoveredStudent | null = await loadNewestStudentCreatedSince(
    args.instituteId,
    new Date(startedMs - graceMs),
  );
  const picked = pickDiscoveredStudent({
    candidate,
    ignoreStudentId: args.ignoreStudentId ?? null,
    startedAt: args.startedAt,
    graceMs,
  });
  if (!picked) return null;

  const access = await studentService.verifyStudentAccess(picked, args.userId, args.instituteId);
  return access.hasAccess ? picked : null;
}

// ---------------------------------------------------------------------------
// Consent gate state
// ---------------------------------------------------------------------------

/**
 * Derive the gate attribute for the view. Follows CONSENT_GATE_ENABLED exactly
 * — read at CALL TIME so a test can toggle it. There is no flow-level override.
 */
export async function resolveGate(args: {
  studentId: string | null;
  account: GuidedSetupAccount;
  hasGuardian: boolean;
}): Promise<GuidedSetupGate> {
  if (!isConsentGateEnabled()) return "off";
  if (!args.studentId) return "none";

  const status = await getConsentStatus(args.studentId);
  // writesAllowed covers the legacy-grace window as well as a signed record;
  // treating grace as anything but "active" would lock a legacy student out of
  // a flow every other gated write lets through.
  if (status.hasActiveConsent || status.writesAllowed) return "active";
  if (!args.hasGuardian) return "none";
  if (args.account === "family") return "sign_required";
  return (await hasPendingConsentInvitation(args.studentId)) ? "request_sent" : "sign_required";
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

export interface ResolveViewInput {
  userId: string;
  instituteId: string;
  studentId?: string | null;
  lang?: string;
  /** True on the flow's opening turn (drives the greeting in the prompt block). */
  firstTurn?: boolean;
  /** Pass the record when the caller already has it (avoids a second read). */
  record?: GuidedSetupRecord | null;
  /**
   * The roster proposal awaiting the user's confirmation, from the chat
   * session's state. It has to ride EVERY turn's view, not only the turn the
   * AI proposed it on: the rail renders the review table off `view.roster`, and
   * a table that vanished the moment the user typed "wait, row 4 is wrong"
   * would take the whole batch with it.
   */
  rosterProposal?: GuidedSetupRosterProposal | null;
}

export async function buildCtx(input: ResolveViewInput): Promise<StudentSetupCtx> {
  const institute = await loadInstituteFacts(input.instituteId);
  if (!institute) {
    throw new GuidedSetupError(404, "INSTITUTE_NOT_FOUND", "Institute not found");
  }

  const studentId = input.studentId ?? null;
  const account = institute.account;
  const term: GuidedSetupTerm = termForAccount(account);

  const user = await userService.getUser(input.userId);
  const userName = user?.firstName || user?.fullName || "";

  const [aacLicensed, instituteHasStudents] = await Promise.all([
    loadAacLicensed(input.instituteId),
    loadInstituteHasStudents(input.instituteId),
  ]);

  if (!studentId) {
    return {
      account,
      term,
      lang: input.lang || institute.language || "en",
      instituteId: institute.id,
      instituteName: institute.name,
      studentId: null,
      userName,
      // Explicit, never inferred: "no student yet" also describes turn 5 of a
      // conversation where the AI has not created the row, and greeting the
      // user again there reads as a reset.
      firstTurn: input.firstTurn === true,
      aacLicensed,
      instituteHasStudents,
      rosterPending: !!input.rosterProposal,
      gate: isConsentGateEnabled() ? "none" : "off",
      record: null,
      basics: EMPTY_BASICS,
      reports: EMPTY_REPORTS,
      program: EMPTY_PROGRAM,
      aac: EMPTY_AAC,
      contacts: EMPTY_CONTACTS,
    };
  }

  const [basics, reports, program, aac, contacts] = await Promise.all([
    loadBasicsFacts(studentId, input.instituteId),
    loadReportFacts(studentId),
    loadProgramFacts(studentId, input.instituteId),
    loadAacFacts(studentId),
    // The signed-in user is part of the question step 5 asks: their own
    // auto-created guardian row is not somebody they added.
    loadContactFacts(studentId, input.userId),
  ]);

  const record =
    input.record !== undefined ? input.record : await readRecord(studentId, input.instituteId);

  const gate = await resolveGate({ studentId, account, hasGuardian: basics.hasGuardian });

  return {
    account,
    term,
    lang: input.lang || basics.primaryLanguage || institute.language || "en",
    instituteId: institute.id,
    instituteName: institute.name,
    studentId,
    userName,
    firstTurn: input.firstTurn === true,
    aacLicensed,
    instituteHasStudents,
    rosterPending: !!input.rosterProposal,
    gate,
    record,
    basics,
    reports,
    program,
    aac,
    contacts,
  };
}

/** Widen the generic flow view into the client-facing contract shape. */
export function toGuidedSetupView(
  ctx: StudentSetupCtx,
  flowView: GuidedFlowView,
  opts: {
    active?: boolean;
    roster?: GuidedSetupRosterProposal | null;
    parked?: GuidedSetupParkedStudent[];
  } = {},
): GuidedSetupView {
  return {
    ...(opts.roster !== undefined ? { roster: opts.roster } : {}),
    ...(opts.parked !== undefined ? { parked: opts.parked } : {}),
    flow: GUIDED_SETUP_FLOW_ID,
    active: opts.active ?? true,
    account: ctx.account,
    term: ctx.term,
    instituteId: ctx.instituteId,
    studentId: ctx.studentId,
    step: flowView.step,
    steps: flowView.steps,
    gate: ctx.gate,
    panel: flowView.panel,
    lang: ctx.lang,
    refused: flowView.refused ?? null,
    record: ctx.record
      ? {
          source: ctx.record.source,
          startedAt: ctx.record.startedAt,
          completedAt: ctx.record.completedAt,
          dismissedAt: ctx.record.dismissedAt,
        }
      : null,
  };
}

/**
 * THE ONE PLACE `done` BECOMES ITS TWO SIGNALS.
 *
 * A finished flow tells the client twice — `active: false` and a stamped
 * `record.completedAt` — and the rail retires on either. Until now only the
 * CHAT path (`resolveForChat`) produced them; `resolveView` and
 * `applyFlowAction` both called `toGuidedSetupView` with no `active`, which
 * defaults to TRUE, on a record nobody had stamped.
 *
 * That is not a cosmetic gap: the turn that actually FINISHES the flow is a
 * `guidedSetup(advance)` or `guidedSetup(skip)`, and the view the client sees
 * for that turn is published by the tool action, not by the chat resolution
 * that ran BEFORE the model spoke. So the completing turn shipped
 * `{ step: "done", active: true, completedAt: undefined }` and the setup header
 * stayed up until the user pressed "finish later" (user report). Every other
 * consumer of `resolveView` — the REST view, `skipStep`, `ackAac`, `adopt`,
 * `dismiss`, `runHostAction` — was told the same untruth.
 *
 * Stamping here is why `resolveView` is no longer strictly read-only. It is
 * idempotent (`markCompleted` returns the record unchanged when it is already
 * stamped) and it is the honest write: the flow IS finished the moment the
 * derived step says so, and a record that says otherwise is what keeps a
 * completed student on the parked list.
 */
async function publishView(
  ctx: StudentSetupCtx,
  flowView: GuidedFlowView,
  args: { userId: string; rosterProposal?: GuidedSetupRosterProposal | null },
): Promise<{ view: GuidedSetupView; done: boolean }> {
  const done = flowView.step === "done";
  if (done && ctx.studentId && ctx.record && !ctx.record.completedAt) {
    ctx.record = await markCompleted({
      instituteId: ctx.instituteId,
      studentId: ctx.studentId,
      record: ctx.record,
    });
  }
  return {
    done,
    view: toGuidedSetupView(ctx, flowView, {
      active: !done,
      roster: args.rosterProposal ?? null,
      parked: await parkedForAccount(ctx, args.userId),
    }),
  };
}

/** The `=== Section: Guided Setup ===` text for this ctx + view. */
export function renderSection(
  ctx: StudentSetupCtx,
  flowView: GuidedFlowView,
): string {
  // Rendered only when the engine has the current step locked, so `step="2/4"`
  // can never read on its own as an invitation to start step 2.
  const blocked = currentStepBlockedBy(flowView);
  return renderGuidedSetupSection(
    {
      flow: GUIDED_SETUP_FLOW_ID,
      account: ctx.account,
      term: ctx.term,
      step: stepPosition(flowView),
      ...(blocked ? { blocked } : {}),
      consent: ctx.gate,
      lang: ctx.lang,
    },
    renderStudentSetupBlock(ctx, flowView),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ViewResult {
  view: GuidedSetupView;
  ctx: StudentSetupCtx;
  flowView: GuidedFlowView;
}

/**
 * The single entry point the chat session uses. Keeps sessionService's diff to
 * a handful of lines: it verifies access, creates the record on first sight,
 * closes the flow when every step is done, and hands back both the client view
 * and the rendered system-prompt section.
 */
export async function resolveForChat(args: {
  userId: string;
  instituteId: string;
  studentId: string | null;
  lang?: string;
  firstTurn?: boolean;
  /** Create the record when the student has none (chat-driven adoption). */
  ensureRecord?: boolean;
  /** The pending roster proposal from the chat session's state, if any. */
  rosterProposal?: GuidedSetupRosterProposal | null;
}): Promise<{ view: GuidedSetupView; section: string; done: boolean }> {
  await requireMembership(args.instituteId, args.userId);
  if (args.studentId) {
    await requireStudentAccess(args.studentId, args.userId, args.instituteId);
  }

  let record: GuidedSetupRecord | null | undefined;
  if (args.studentId && args.ensureRecord !== false) {
    record = await readRecord(args.studentId, args.instituteId);
    if (!record) {
      record = newRecord({ userId: args.userId, source: "chat" });
      const ok = await writeRecord(args.studentId, args.instituteId, record);
      if (!ok) record = null; // not enrolled here yet; the flow still renders
    }
  }

  const ctx = await buildCtx({
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: args.studentId,
    lang: args.lang,
    firstTurn: args.firstTurn,
    rosterProposal: args.rosterProposal ?? null,
    ...(record !== undefined ? { record } : {}),
  });
  const flowView = resolveFlowView(studentSetupFlow, ctx, ctx.record);
  const { view, done } = await publishView(ctx, flowView, {
    userId: args.userId,
    rosterProposal: args.rosterProposal ?? null,
  });

  return {
    view,
    section: renderSection(ctx, flowView),
    done,
  };
}

/**
 * The parked list, for institution accounts only.
 *
 * A family institute has one child in it — a "parked list" there is a list of
 * one, and the rail would render an empty panel section on every family turn.
 * Never throws: a slow or broken list must not take the whole flow's view down
 * with it.
 */
async function parkedForAccount(
  ctx: StudentSetupCtx,
  userId: string,
): Promise<GuidedSetupParkedStudent[] | undefined> {
  if (ctx.account === "family") return undefined;
  try {
    return await parked({ userId, instituteId: ctx.instituteId, lang: ctx.lang });
  } catch (err) {
    console.warn("[guided-setup] parked list failed:", err);
    return undefined;
  }
}

/**
 * The `guidedSetup` host tool's handler. Returns the post-action view.
 *
 * The arguments come from a model, so the action is validated here rather than
 * trusted: an unrecognised verb must come back as a refusal the AI can read,
 * not fall through the engine's switch and throw mid-turn.
 */
export async function runToolAction(args: {
  userId: string;
  instituteId: string;
  studentId: string | null;
  lang?: string;
  action: unknown;
  step?: unknown;
  value?: unknown;
  contactId?: unknown;
  channel?: unknown;
  rows?: unknown;
  /** The proposal already pending in the session, so every view carries it. */
  rosterProposal?: GuidedSetupRosterProposal | null;
}): Promise<GuidedSetupView> {
  // Some providers hand the whole argument object in as `action`; unwrap it
  // before reading any field, so every branch below sees the same shape.
  const bag = (args.action && typeof args.action === "object" ? args.action : args) as Record<
    string,
    unknown
  >;
  const verb = String((args.action as { action?: unknown })?.action ?? args.action ?? "");

  if (GUIDED_SETUP_HOST_ACTIONS.includes(verb as never)) {
    return runHostAction({
      userId: args.userId,
      instituteId: args.instituteId,
      studentId: args.studentId,
      lang: args.lang,
      action: verb as GuidedSetupHostAction,
      value: bag.value ?? args.value,
      contactId: bag.contactId ?? args.contactId,
      channel: bag.channel ?? args.channel,
      rows: bag.rows ?? args.rows,
      rosterProposal: args.rosterProposal ?? null,
    });
  }

  if (!GUIDED_SETUP_FLOW_ACTIONS.includes(verb as never)) {
    const { view } = await resolveView({
      userId: args.userId,
      instituteId: args.instituteId,
      studentId: args.studentId,
      lang: args.lang,
      rosterProposal: args.rosterProposal ?? null,
    });
    return { ...view, refused: { action: verb || "unknown", reason: "unknownAction" } };
  }

  const rawStep = bag.step ?? args.step ?? undefined;
  const step =
    typeof rawStep === "string" ? (rawStep as GuidedSetupSkippableStep) : undefined;

  const { view } = await applyFlowAction({
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: args.studentId,
    lang: args.lang,
    rosterProposal: args.rosterProposal ?? null,
    action:
      verb === "skip"
        ? { action: "skip", step: step as GuidedSetupStepId | undefined }
        : ({ action: verb } as GuidedFlowActionInput),
  });
  return view;
}

/**
 * The Phase C host actions (activateProgram / setAacUser / requestConsent).
 *
 * Each one writes outside the flow record, so access is verified HERE rather
 * than left to the view resolution that follows — a refusal must never be the
 * only thing standing between a non-member and a consent email.
 *
 * The result is always the fresh view: on success the caller sees the step the
 * action unlocked, on refusal the same view carrying `refused`.
 */
export async function runHostAction(args: {
  userId: string;
  instituteId: string;
  studentId: string | null;
  lang?: string;
  action: GuidedSetupHostAction;
  value?: unknown;
  contactId?: unknown;
  channel?: unknown;
  rows?: unknown;
  rosterProposal?: GuidedSetupRosterProposal | null;
}): Promise<GuidedSetupView> {
  await requireMembership(args.instituteId, args.userId);
  if (args.studentId) {
    await requireStudentAccess(args.studentId, args.userId, args.instituteId);
  }

  const base = {
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: args.studentId,
  };

  // proposeRoster produces a whole PROPOSAL, not a refusal-or-nothing, so it
  // returns its own view rather than joining the switch below.
  if (args.action === "proposeRoster") {
    return proposeRoster({ ...base, lang: args.lang, rows: args.rows });
  }

  let refusal: ActionRefusal;
  switch (args.action) {
    case "activateProgram":
      refusal = await activateProgramAction(base);
      break;
    case "setAacUser":
      // A missing / non-boolean `value` is a malformed call, not a "no": the
      // model must ask the user again rather than have the server guess.
      refusal =
        typeof args.value === "boolean"
          ? await setAacUserAction({ ...base, value: args.value })
          : "unknownAction";
      break;
    case "requestConsent": {
      const contactId = typeof args.contactId === "string" ? args.contactId : "";
      const channel = args.channel === "sms" ? "sms" : "email";
      refusal = contactId
        ? await requestConsentAction({
            ...base,
            contactId,
            channel: channel as GuidedSetupConsentChannel,
          })
        : "guardianMissing";
      break;
    }
  }

  const { view } = await resolveView({
    ...base,
    lang: args.lang,
    rosterProposal: args.rosterProposal ?? null,
  });
  return refusal ? { ...view, refused: { action: args.action, reason: refusal } } : view;
}

// ---------------------------------------------------------------------------
// Roster (Phase D)
// ---------------------------------------------------------------------------

/**
 * `guidedSetup(proposeRoster, rows)` — the AI's reading of an uploaded roster.
 *
 * Nothing is created here. The rows are normalised, warned about and stored on
 * the view; the USER confirms the table in the side panel (plan §3.7 step 3),
 * and only `confirmRosterBatch` writes. The action refuses outright on a family
 * account: a family sets up ONE child conversationally, and a "roster" there is
 * either a mistake or an attempt to bulk-create past a one-seat license.
 */
export async function proposeRoster(args: {
  userId: string;
  instituteId: string;
  studentId: string | null;
  lang?: string;
  rows: unknown;
}): Promise<GuidedSetupView> {
  await requireMembership(args.instituteId, args.userId);

  const institute = await loadInstituteFacts(args.instituteId);
  if (!institute) {
    throw new GuidedSetupError(404, "INSTITUTE_NOT_FOUND", "Institute not found");
  }

  const refuse = async (reason: string): Promise<GuidedSetupView> => {
    const { view } = await resolveView({
      userId: args.userId,
      instituteId: args.instituteId,
      studentId: args.studentId,
      lang: args.lang,
      rosterProposal: null,
    });
    return { ...view, refused: { action: "proposeRoster", reason } };
  };

  if (institute.account === "family") return refuse("rosterNotForFamily");

  const parsed = rosterInputSchema.safeParse(Array.isArray(args.rows) ? args.rows : []);
  if (!parsed.success || parsed.data.length === 0) return refuse("rosterEmpty");

  const normalised = await normaliseForInstitute({
    instituteId: args.instituteId,
    country: await instituteCountry(args.instituteId, institute.country),
    rows: parsed.data,
  });
  if (normalised.rows.length === 0) return refuse("rosterEmpty");

  const proposal = makeProposal(normalised);
  const { view } = await resolveView({
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: args.studentId,
    lang: args.lang,
    rosterProposal: proposal,
  });
  return view;
}

/**
 * The country the day/month reading follows.
 *
 * `institutes` has no country column, so the institute's own students are the
 * only evidence of where it operates. A school with no students yet falls back
 * to the platform default (IL → day-first), which is also the safer default:
 * a day-first misreading of a US date fails loudly on days 13-31 rather than
 * silently swapping March and April.
 */
async function instituteCountry(
  instituteId: string,
  fallback: string | null,
): Promise<string | null> {
  if (fallback) return fallback;
  const enrolled = await instituteRepository.getStudentsInInstitute(instituteId);
  for (const row of enrolled) {
    const country = (row.student as { country?: string | null }).country;
    if (country) return country;
  }
  return null;
}

/**
 * `POST /api/guided-setup/roster/confirm` — the USER's click.
 *
 * The rows arrive from the client carrying the user's edits, and are
 * re-validated from scratch by the same normaliser the proposal used. The
 * proposal id is only bookkeeping (the activity trail and the session cleanup);
 * it is never the source of the data, so a stale or forged id cannot smuggle a
 * row past the checks.
 */
export async function confirmRosterBatch(args: {
  userId: string;
  instituteId: string;
  proposalId: string;
  rows: unknown;
  lang?: string;
}): Promise<{
  created: Awaited<ReturnType<typeof confirmRoster>>["created"];
  skipped: string[];
  failed: Awaited<ReturnType<typeof confirmRoster>>["failed"];
  view: GuidedSetupView;
}> {
  await requireMembership(args.instituteId, args.userId);

  const institute = await loadInstituteFacts(args.instituteId);
  if (!institute) {
    throw new GuidedSetupError(404, "INSTITUTE_NOT_FOUND", "Institute not found");
  }
  if (institute.account === "family") {
    throw new GuidedSetupError(400, "ROSTER_NOT_FOR_FAMILY", "Roster import is for institutions");
  }

  const parsed = rosterConfirmRowsSchema.safeParse(Array.isArray(args.rows) ? args.rows : []);
  if (!parsed.success) {
    throw new GuidedSetupError(400, "BAD_REQUEST", "Invalid roster rows");
  }

  const result = await confirmRoster({
    userId: args.userId,
    instituteId: args.instituteId,
    proposalId: args.proposalId,
    rows: parsed.data,
    country: await instituteCountry(args.instituteId, institute.country),
    language: institute.language,
  });

  await clearRosterProposal(args.userId, args.proposalId);

  const { view } = await resolveView({
    userId: args.userId,
    instituteId: args.instituteId,
    // The rail is showing the institute, not one student: after a batch the
    // next thing the user does is pick somebody off the parked list.
    studentId: null,
    lang: args.lang ?? institute.language ?? undefined,
    rosterProposal: null,
  });
  return { ...result, view };
}

/**
 * `POST /api/guided-setup/consent/request-batch` — one click, N magic links.
 *
 * Each item goes through Phase C's `requestConsentAction`, which owns the gate,
 * the contact ownership check and the channel check. Nothing is sent
 * automatically on confirm (plan decision 5): an outward-facing send is always
 * a deliberate press.
 */
export async function requestConsentBatch(args: {
  userId: string;
  instituteId: string;
  items: Array<{ studentId: string; contactId: string; channel: GuidedSetupConsentChannel }>;
  lang?: string;
}): Promise<{
  results: Array<{ studentId: string; ok: boolean; reason?: string }>;
  view: GuidedSetupView;
}> {
  await requireMembership(args.instituteId, args.userId);

  const results: Array<{ studentId: string; ok: boolean; reason?: string }> = [];
  for (const item of args.items) {
    try {
      // Per item, not once for the batch: a list posted from a stale rail can
      // name a student this user lost access to since the page loaded.
      await requireStudentAccess(item.studentId, args.userId, args.instituteId);
    } catch {
      results.push({ studentId: item.studentId, ok: false, reason: "notStarted" });
      continue;
    }
    const refusal = await requestConsentAction({
      userId: args.userId,
      instituteId: args.instituteId,
      studentId: item.studentId,
      contactId: item.contactId,
      channel: item.channel,
    });
    results.push(
      refusal
        ? { studentId: item.studentId, ok: false, reason: refusal }
        : { studentId: item.studentId, ok: true },
    );
  }

  const { view } = await resolveView({
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: null,
    lang: args.lang,
    rosterProposal: null,
  });
  return { results, view };
}

/**
 * Resolve the view for (user, institute, student).
 *
 * Read-only EXCEPT for the completion stamp `publishView` applies — see that
 * function. Nothing else about the flow is written here.
 */
export async function resolveView(input: ResolveViewInput): Promise<ViewResult> {
  await requireMembership(input.instituteId, input.userId);
  if (input.studentId) {
    await requireStudentAccess(input.studentId, input.userId, input.instituteId);
  }
  const ctx = await buildCtx(input);
  const flowView = resolveFlowView(studentSetupFlow, ctx, ctx.record);
  const { view } = await publishView(ctx, flowView, {
    userId: input.userId,
    rosterProposal: input.rosterProposal ?? null,
  });
  return { ctx, flowView, view };
}

/** Run one flow action, persisting any record change. */
export async function applyFlowAction(
  input: ResolveViewInput & { action: GuidedFlowActionInput },
): Promise<ViewResult> {
  await requireMembership(input.instituteId, input.userId);
  if (input.studentId) {
    await requireStudentAccess(input.studentId, input.userId, input.instituteId);
  }
  const ctx = await buildCtx(input);

  // Step 4's acknowledgement, earned rather than clicked. `aacReviewedAt` is
  // what makes the AAC step complete, and the rail's "I reviewed this" button
  // is not the only way to review: an AI that has walked the settings, the
  // rules and the device sign-in and is now calling `advance` HAS finished the
  // review conversation. Without this the flow would sit on a step whose
  // checklist is full, refusing to move until the user found a button.
  if (
    input.action.action === "advance" &&
    ctx.studentId &&
    ctx.record &&
    !ctx.record.aacReviewedAt &&
    ctx.aac.enabled &&
    resolveFlowView(studentSetupFlow, ctx, ctx.record).step === "aac"
  ) {
    const stamped: GuidedSetupRecord = {
      ...ctx.record,
      aacReviewedAt: new Date().toISOString(),
    };
    await writeRecord(ctx.studentId, ctx.instituteId, stamped);
    ctx.record = stamped;
  }

  const result = applyAction(studentSetupFlow, ctx, ctx.record, input.action);

  if (ctx.studentId && result.record && result.record !== ctx.record) {
    await writeRecord(ctx.studentId, ctx.instituteId, result.record);
    ctx.record = result.record;
  }

  // The action that FINISHES the flow publishes from here, so this is the one
  // view that has to carry both completion signals — the chat resolution for
  // this turn ran before the model called the tool.
  const { view } = await publishView(ctx, result.view, {
    userId: input.userId,
    rosterProposal: input.rosterProposal ?? null,
  });

  return { ctx, flowView: result.view, view };
}

/**
 * Open the flow for a user.
 *
 * ALWAYS UNBOUND. `start` means a NEW student in both entry paths (the
 * "New student" button and the auto-launch on an empty institute), so the
 * `studentId` the caller happens to be carrying — the chat request body always
 * ships the current selection — is deliberately ignored. Adopting it is how
 * pressing New Patient resumed the patient already on screen at step 2.
 * Resuming an existing student is `adopt` / the session's own resume path,
 * never this one.
 *
 * A self-registered user with NO institute at all should not exist (plan
 * decision 2). If one does, provision a family institute plus a default family
 * license so the flow can run, and say so with `instituteCreated`.
 */
export async function start(args: {
  userId: string;
  instituteId?: string | null;
  /** Accepted for call-site compatibility and IGNORED — see above. */
  studentId?: string | null;
  lang?: string;
}): Promise<{ view: GuidedSetupView; instituteCreated: boolean }> {
  let instituteId = args.instituteId ?? null;
  let instituteCreated = false;

  if (instituteId) {
    await requireMembership(instituteId, args.userId);
  } else {
    const existing = await instituteRepository.getInstitutesByUserId(args.userId);
    if (existing.length > 0) {
      instituteId = existing[0].id;
    } else {
      const user = await userService.getUser(args.userId);
      const name = user?.lastName
        ? `${user.lastName} family`
        : user?.fullName
          ? `${user.fullName} family`
          : "My family";
      const { institute } = await instituteRepository.createInstituteWithAdmin(
        { name, type: "family" } as never,
        args.userId,
      );
      await licenseRepository.createLicense({
        name: `${name} license`,
        licenseType: "standard",
        subscriptionType: "monthly",
        permissions: DEFAULT_FAMILY_LICENSE_PERMISSIONS,
        inviteEmail: user?.email ?? `${args.userId}@local`,
        instituteId: institute.id,
        isActive: true,
      } as never);
      instituteId = institute.id;
      instituteCreated = true;
    }
  }

  const { view } = await resolveView({
    userId: args.userId,
    instituteId: instituteId!,
    studentId: null,
    lang: args.lang,
    firstTurn: true,
  });
  return { view, instituteCreated };
}

/**
 * Put a student into the flow (creating the record if absent).
 *
 * Adopting is the user CHOOSING this student, so it also lifts a previous
 * "not now": `dismissedAt` is what `isResumableRecord` refuses on, and without
 * clearing it the patient viewer's "Continue setup" button — whose whole point
 * is re-entering a setup the user parked — would send a resume the chat turn
 * then refuses, leaving the flow unopened and the click looking broken.
 * "Not now" stays a pause the AUTOMATIC paths (the rail's banner, a turn about
 * that student) still honour; only a deliberate adopt ends it.
 */
export async function adopt(args: {
  userId: string;
  instituteId: string;
  studentId: string;
  source?: GuidedSetupRecord["source"];
  lang?: string;
}): Promise<GuidedSetupView> {
  await requireMembership(args.instituteId, args.userId);
  await requireStudentAccess(args.studentId, args.userId, args.instituteId);

  let record = await readRecord(args.studentId, args.instituteId);
  if (!record) {
    record = newRecord({ userId: args.userId, source: args.source ?? "chat" });
    const ok = await writeRecord(args.studentId, args.instituteId, record);
    if (!ok) {
      throw new GuidedSetupError(404, "NOT_ENROLLED", "Student is not enrolled in this institute");
    }
  } else if (record.dismissedAt && !record.completedAt) {
    // `writeRecord` replaces the record wholesale, so dropping the key clears it.
    const revived: GuidedSetupRecord = { ...record };
    delete revived.dismissedAt;
    await writeRecord(args.studentId, args.instituteId, revived);
    record = revived;
  }
  const { view } = await resolveView({ ...args, record });
  return view;
}

/** Mark one step skipped. */
export async function skipStep(args: {
  userId: string;
  instituteId: string;
  studentId: string;
  step?: GuidedSetupSkippableStep;
  lang?: string;
}): Promise<GuidedSetupView> {
  const { view } = await applyFlowAction({
    userId: args.userId,
    instituteId: args.instituteId,
    studentId: args.studentId,
    lang: args.lang,
    action: { action: "skip", step: args.step },
  });
  return view;
}

/** "Not now" on a student's flow. The record survives so the rail can offer a resume. */
export async function dismiss(args: {
  userId: string;
  instituteId: string;
  studentId: string;
  lang?: string;
}): Promise<GuidedSetupView> {
  await requireMembership(args.instituteId, args.userId);
  await requireStudentAccess(args.studentId, args.userId, args.instituteId);

  const current =
    (await readRecord(args.studentId, args.instituteId)) ?? newRecord({ userId: args.userId });
  const next: GuidedSetupRecord = { ...current, dismissedAt: new Date().toISOString() };
  await writeRecord(args.studentId, args.instituteId, next);

  const { view } = await resolveView({ ...args, record: next });
  return view;
}

/** Step 4's acknowledgement: the user reviewed the AAC settings. */
export async function ackAac(args: {
  userId: string;
  instituteId: string;
  studentId: string;
  lang?: string;
}): Promise<GuidedSetupView> {
  await requireMembership(args.instituteId, args.userId);
  await requireStudentAccess(args.studentId, args.userId, args.instituteId);

  const current =
    (await readRecord(args.studentId, args.instituteId)) ?? newRecord({ userId: args.userId });
  const next: GuidedSetupRecord = { ...current, aacReviewedAt: new Date().toISOString() };
  await writeRecord(args.studentId, args.instituteId, next);

  const { view } = await resolveView({ ...args, record: next });
  return view;
}

/** Mark the flow finished for this student. Idempotent. */
export async function markCompleted(args: {
  instituteId: string;
  studentId: string;
  record: GuidedSetupRecord;
}): Promise<GuidedSetupRecord> {
  if (args.record.completedAt) return args.record;
  const next: GuidedSetupRecord = { ...args.record, completedAt: new Date().toISOString() };
  await writeRecord(args.studentId, args.instituteId, next);
  return next;
}

/** Students in this institute whose flow is unfinished (the rail's parked list). */
export async function parked(args: {
  userId: string;
  instituteId: string;
  lang?: string;
}): Promise<GuidedSetupParkedStudent[]> {
  await requireMembership(args.instituteId, args.userId);

  const records = await listRecords(args.instituteId);
  const unfinished = records.filter((r) => !r.record.completedAt);
  if (unfinished.length === 0) return [];

  const enrolled = await instituteRepository.getStudentsInInstitute(args.instituteId);
  const nameById = new Map(enrolled.map((e) => [e.student.id, e.student.name]));

  const out: GuidedSetupParkedStudent[] = [];
  for (const { studentId, record } of unfinished) {
    if (!nameById.has(studentId)) continue;
    const ctx = await buildCtx({
      userId: args.userId,
      instituteId: args.instituteId,
      studentId,
      lang: args.lang,
      record,
    });
    const flowView = resolveFlowView(studentSetupFlow, ctx, record);
    out.push({
      studentId,
      name: nameById.get(studentId) ?? "",
      step: flowView.step,
      gate: ctx.gate,
      // The rail's "Send consent requests (N)" button needs a contact id per
      // student and has nowhere else to get one — without this it would have
      // to fetch each student's contacts, or guess.
      consentContactId: ctx.basics.consentContact?.id ?? null,
    });
  }
  return out;
}

/**
 * The record a chat turn may RESUME from: unfinished and not dismissed.
 *
 * A dismissed student stays in the rail's parked list — "not now" means the
 * user wants the option back later, not that the setup is finished — but it
 * must not re-open the flow in the chat on its own, or every turn about that
 * student would drag the wizard back in.
 */
export async function hasUnfinishedRecord(
  studentId: string,
  instituteId: string,
): Promise<GuidedSetupRecord | null> {
  const record = await readRecord(studentId, instituteId);
  return isResumableRecord(record) ? record : null;
}

/**
 * The rail's "Continue setup": may THIS turn resume THIS student's flow?
 *
 * The button used to send `{ start: true }`, and `start` deliberately begins
 * unbound — so pressing it on a parked patient opened a fresh step-1 flow that
 * asked a clinic for its patient list instead of resuming the patient. The
 * resume is now its own request shape, and this is the check behind it.
 *
 * Access is verified with the same two helpers every other entry point uses:
 * an instituteId on the request body is never taken on trust, and a family
 * institute's blanket member access still has to be earned per student.
 *
 * Returns the record to resume from, or NULL for every refusal — an unresumable
 * student, a student this user cannot see, an institute they are not in. Never
 * throws: a refused resume must degrade to an ordinary turn, not take the whole
 * chat message down with it.
 */
export async function resumeForChat(args: {
  userId: string;
  instituteId: string;
  studentId: string;
}): Promise<GuidedSetupRecord | null> {
  try {
    await requireMembership(args.instituteId, args.userId);
    await requireStudentAccess(args.studentId, args.userId, args.instituteId);
    const record = await readRecord(args.studentId, args.instituteId);
    if (isResumableRecord(record)) return record;
    console.warn(
      `[guided-setup] resume refused: no resumable record for student ${args.studentId}`,
    );
  } catch (err) {
    console.warn("[guided-setup] resume refused:", err);
  }
  return null;
}

export const DONE_PANEL = GUIDED_SETUP_DONE_PANEL;
