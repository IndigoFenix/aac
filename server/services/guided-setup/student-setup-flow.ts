// server/services/guided-setup/student-setup-flow.ts
//
// The `student_setup` flow: five steps, their derived completion rules, their
// entry gates and their system-prompt blocks.
//
// Completion is DERIVED from real rows (student-setup-queries.ts). The record
// on institute_students.data.onboarding only carries skips, the AAC
// acknowledgement and dismissals.
//
// Prompt rules (docs/PROMPT_WRITING.md): terse, ≤130 chars per line, ≤5
// bullets per list, canonical ALL-CAPS terms from terms.ts only, examples over
// explanations. The tool description says HOW to call guidedSetup; these
// blocks say WHEN — never both.

import {
  GUIDED_SETUP_DONE_PANEL,
  GUIDED_SETUP_FLOW_ID,
  GUIDED_SETUP_PANEL_BY_STEP,
  type GuidedSetupAccount,
  type GuidedSetupChecklistItem,
  type GuidedSetupGate,
  type GuidedSetupRecord,
  type GuidedSetupStepId,
  type GuidedSetupTerm,
} from "@shared/guided-setup";
import {
  GATE_OK,
  type GuidedFlowDefinition,
  type GuidedFlowView,
  type GuidedGateResult,
  type GuidedStep,
} from "../chat/guided-flow/types.js";
import { GS, termForAccount } from "./terms.js";
import type {
  StudentAacFacts,
  StudentBasicsFacts,
  StudentContactFacts,
  StudentProgramFacts,
  StudentReportFacts,
} from "./student-setup-queries.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface StudentSetupCtx {
  account: GuidedSetupAccount;
  term: GuidedSetupTerm;
  /** UI locale the user is working in, from the request (e.g. "he"). */
  lang: string;
  instituteId: string;
  instituteName: string;
  /** null until step 1 creates the student. */
  studentId: string | null;
  /** Display name of the signed-in user, for the first-turn greeting. */
  userName: string;
  /** True on the flow's opening turn (no student picked yet, no record). */
  firstTurn: boolean;
  /** The institute's license offers the AAC; step 4 is hidden otherwise. */
  aacLicensed: boolean;
  /**
   * The institute already has at least one student before this flow's own
   * student. Flips the roster block's lead from "send the whole list" (a
   * brand-new institute) to "add this one, or send a list if there are more".
   */
  instituteHasStudents: boolean;
  /**
   * A roster proposal is sitting in the SIDE PANEL awaiting the user's
   * confirmation. While it is, the AI must not create anybody: the table is the
   * decision, and a model that "helpfully" adds row 1 through Context_Students
   * would double every student the user then confirms.
   */
  rosterPending?: boolean;
  gate: GuidedSetupGate;
  record: GuidedSetupRecord | null;
  basics: StudentBasicsFacts;
  reports: StudentReportFacts;
  program: StudentProgramFacts;
  aac: StudentAacFacts;
  contacts: StudentContactFacts;
}

/** A ctx for a flow that has not created its student yet — everything empty. */
export const EMPTY_BASICS: StudentBasicsFacts = {
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

export const EMPTY_REPORTS: StudentReportFacts = {
  hasAnyReport: false,
  hasDiagnosis: false,
  hasAlerts: false,
  hasMedications: false,
};

export const EMPTY_PROGRAM: StudentProgramFacts = {
  exists: false,
  hasActiveProgram: false,
  activeGoalCount: 0,
  framework: null,
};

export const EMPTY_AAC: StudentAacFacts = {
  enabled: false,
  voiceSet: false,
  inputDecided: false,
  rulesSet: false,
};

export const EMPTY_CONTACTS: StudentContactFacts = {
  total: 0,
  peopleAdded: 0,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function item(key: string, done: boolean): GuidedSetupChecklistItem {
  return { key, done };
}

/**
 * The consent gate for every step after BASIC INFO. `off` (the flag is not
 * "true") and `active` pass; everything else refuses. No flow-level override —
 * the flow follows CONSENT_GATE_ENABLED exactly, like every other gated write.
 */
function consentGate(ctx: StudentSetupCtx): GuidedGateResult {
  if (ctx.gate === "off" || ctx.gate === "active") return GATE_OK;
  return { ok: false, reason: "consentRequired" };
}

/** Suggested framework: families are personal; institutions follow the country. */
export function suggestedFramework(ctx: StudentSetupCtx): string {
  if (ctx.account === "family") return GS.PERSONAL;
  const country = (ctx.basics.country ?? "").toUpperCase();
  if (country === "IL") return GS.TALA;
  if (country === "US") return GS.US_IEP;
  return GS.PERSONAL;
}

/**
 * The step-1 identity facts this person still lacks, in checklist order.
 *
 * `isComplete` and the step-1 block read this ONE list, so the flow can never
 * hold a step open for a reason it cannot name. The live failure it closes: a
 * single `Context_Students add` carrying a name and a BIRTH DATE satisfied
 * step 1, the flow jumped straight to a consent-LOCKED step 2, and with
 * nothing left it could legally do the model went interviewing the user about
 * the child's communication instead.
 *
 * GUARDIAN is deliberately NOT here. It is the consent gate's business, and a
 * roster-created student with no contact yet must still be able to finish
 * step 1 (`hasGuardian` stays on the rail's checklist as information only).
 */
export function missingBasicsFacts(ctx: StudentSetupCtx): string[] {
  const missing: string[] = [];
  if (!ctx.basics.name || ctx.basics.name.trim() === "") missing.push("name");
  if (!ctx.basics.birthDate) missing.push(GS.BIRTH_DATE);
  if (!ctx.basics.gender) missing.push("gender");
  if (!ctx.basics.primaryLanguage) missing.push(GS.HOME_LANGUAGE);
  return missing;
}

/**
 * The one line that keeps step 1 ON step 1.
 *
 * Observed live (clinic, 2026-09-08): the assistant created the patient and
 * went straight to "does Mira use any AAC?" — step 4, behind the CONSENT
 * gate, with gender and HOME LANGUAGE still missing. Nothing in the step-1
 * blocks said the later steps were off-limits, so having satisfied the ask in
 * front of it, it went and found another one.
 *
 * Carried by every step-1 block (both roster variants included) rather than
 * stated once in the rules: the rules list is already at its bullet budget,
 * and the block the model is working from is the one that has to say it.
 */
const STEP_ONE_ONLY_LINE =
  `- Ask only for these facts now. ${GS.STEP_MEDICAL}, ${GS.STEP_PROGRAM}, ${GS.STEP_AAC} and ${GS.STEP_CONTACTS} come later, after ${GS.CONSENT}.`;

/** Keep an institute or user name from blowing the 130-char line budget. */
function short(value: string, max = 60): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Prompt blocks
// ---------------------------------------------------------------------------

/**
 * Is the step the flow is SITTING on locked (its `canEnter` refuses)?
 *
 * Read off the view rather than re-derived from the ctx: the engine decides
 * status, and a second opinion here is how the prompt and the rail end up
 * disagreeing about the same turn.
 */
export function isCurrentStepLocked(view: GuidedFlowView<GuidedSetupStepId>): boolean {
  if (view.step === "done") return false;
  return view.steps.find((s) => s.id === view.step)?.status === "locked";
}

/**
 * The `blocked="…"` value for the section header, or undefined when the
 * current step is workable. Every gate in this flow is the CONSENT gate
 * (`consentGate` is the only `canEnter` any step carries), so a locked step
 * always means the same thing.
 */
export function currentStepBlockedBy(
  view: GuidedFlowView<GuidedSetupStepId>,
): string | undefined {
  return isCurrentStepLocked(view) ? "consent" : undefined;
}

/**
 * The standing rules, plus the FIRST TURN opening on the flow's first turn.
 *
 * `locked` is not a detail. These lines sit ABOVE every step block, so while
 * they told the model to "ask the first question" it asked one — observed
 * live: a PATIENT with no consent record was asked for diagnoses, even though
 * the block underneath was WAITING FOR CONSENT and the engine had the step
 * locked. While a step is locked the only moves are to explain and to point at
 * the panel.
 */
function rulesBlock(ctx: StudentSetupCtx, locked: boolean): string {
  const term = ctx.term;
  const forbidden =
    term === "CHILD"
      ? '"student" or "patient"'
      : term === "STUDENT"
        ? '"child" or "patient"'
        : '"child" or "student"';
  const lines = [
    // An institution is setting up a ROSTER: "for one STUDENT" contradicted
    // the roster instruction two lines below it.
    ctx.account === "family"
      ? `You are walking the user through ${GS.FLOW} for one ${term}, one step at a time.`
      : `You are walking the user through ${GS.FLOW} for their ${term}S, one step at a time.`,
    `RULES`,
    `- Call the person the ${term} or the ${GS.AAC_USER}. Never ${forbidden}.`,
    `- Ask ONE thing at a time. Keep replies short. Reply in the user's language (${ctx.lang}).`,
    `- Save each fact as soon as you have it (manageMemory). The ${GS.SIDE_PANEL} mirrors what is saved.`,
    `- Never invent a fact. Never ask for a government ID number.`,
    // The flow OWNS the sequence. Observed live: the assistant closed a turn
    // with "What would you like to do next?" — which hands the user back a
    // decision the flow already made, and is how a turn ends up improvising.
    `- Never end a turn asking what to do next. Say what the next step is and continue. Skip only if asked.`,
    // Replaces the advance line rather than joining it: advance is refused
    // while the gate is shut, and the bullet budget is five.
    locked
      ? `- The flow is BLOCKED at this step. Do not ask for anything belonging to it.`
      : `- When the step's checklist is done call ${"guidedSetup"}(advance).`,
  ];
  if (ctx.firstTurn) {
    lines.push(`FIRST TURN`, `- Greet ${short(ctx.userName, 40)} by name in one or two sentences.`);
    if (locked) {
      lines.push(
        `- Say what is already set up, then that nothing more can be collected until ${GS.CONSENT} is active.`,
        `- Point at the ${GS.SIDE_PANEL} for the next move. Ask nothing that belongs to this step.`,
      );
    } else {
      lines.push(
        ctx.account === "family"
          ? `- Say you will set up the ${term} together, step by step, then ask the first question.`
          : `- Say you will add their ${term}S from a list they send, then ask for that list.`,
      );
    }
  }
  return lines.join("\n");
}

function basicsBlock(ctx: StudentSetupCtx): string {
  return [
    `STEP 1 — ${GS.STEP_BASICS}`,
    `- Checklist: first + last name, ${GS.BIRTH_DATE} (required), gender, ${GS.HOME_LANGUAGE}.`,
    `- Save: Context_Students add { firstName, lastName, birthDate, gender, primaryLanguage }.`,
    `- On that add pass instituteIds: ["${ctx.instituteId}"].`,
    `- That is the institute "${short(ctx.instituteName)}". Right after the add, call selectStudent(<new id>).`,
    // The consent wizard picks the notice by country, and country silently
    // defaults to IL. Ask when the language does not already settle it.
    `- Ask which ${GS.COUNTRY} the ${ctx.term} lives in unless it is obvious. Save country: IL or US only.`,
    `- ${GS.CONSENT} is signed by the user from a button in the ${GS.SIDE_PANEL} — never collect ID numbers here.`,
    STEP_ONE_ONLY_LINE,
  ].join("\n");
}

/**
 * What step 1 is still waiting for, once the row exists.
 *
 * A model that has just created the student should never have to guess what
 * remains — it saw its own `add` succeed, so as far as it knows step 1 is
 * over. Naming the outstanding checklist items (from the SAME list
 * `isComplete` reads) is what keeps the turn on step 1 instead of drifting
 * into an unprompted interview.
 *
 * The gender line is the escape hatch: `students.gender` is nullable and the
 * memory schema offers "other", so a user who will not answer must not be able
 * to dead-end the flow.
 */
function stillMissingBlock(ctx: StudentSetupCtx): string | null {
  if (!ctx.basics.inInstitute) return null;
  const missing = missingBasicsFacts(ctx);
  if (missing.length === 0) return null;
  const lines = [
    `STILL MISSING — ${GS.STEP_BASICS}`,
    `- This ${ctx.term} is saved but incomplete: ${missing.join(", ")}.`,
    `- Ask for exactly those, one at a time, then save each with Context_Students update.`,
    STEP_ONE_ONLY_LINE,
  ];
  if (missing.includes("gender")) {
    lines.push(`- If the user will not give a gender, save "other" and move on. Never guess it.`);
  }
  return lines.join("\n");
}

/**
 * The one step-1 job that is NOT a memory write.
 *
 * A face photo is what lets the AAC assistant tell who is in the room, and the
 * assistant CANNOT add one itself: the 128-D descriptor that makes a picture
 * recognisable is computed in the browser by face-api.js and posted with the
 * image (`client/src/lib/biometricImage.ts`, `POST /api/biometric/students/
 * :id/photo`). No tool and no memory-schema field reaches it — the contacts
 * schema deliberately exposes a read-only `hasPhoto` and nothing more. So the
 * line names the button and stops there; it must never read as an offer.
 *
 * Gated on the row existing, because "add a photo of them" is nonsense before
 * there is a them — and rendered from the step's promptBlock so the family
 * path and both roster paths get it from ONE place.
 */
function portraitBlock(ctx: StudentSetupCtx): string | null {
  if (!ctx.basics.inInstitute) return null;
  return [
    `${GS.PORTRAIT} — ${ctx.term}`,
    `- Tell them the edit button by the ${GS.PORTRAIT} in the ${GS.SIDE_PANEL} adds a photo; the ${GS.AAC_APP} uses it to recognise who is present.`,
  ].join("\n");
}

/**
 * Step 1 for a SCHOOL or a CLINIC: the roster, not one conversation.
 *
 * The pending variant is the important one. A model that has just proposed
 * thirty rows and is then asked "can you add Noa too?" will happily call
 * Context_Students.add — and every one of those students is created a SECOND
 * time when the user presses Create in the panel. The table IS the decision;
 * while it is on screen the AI's job is to talk about it, not to write.
 *
 * The non-pending variant forks on whether the institute already has a
 * roster. A brand-new institute leads with the list ask — there is nothing
 * to fall back on yet. Once there is a roster, pressing "New student" almost
 * always means one person, so that leads instead; the list stays available
 * as the equal alternative for "actually I have several".
 */
function rosterBlock(ctx: StudentSetupCtx): string {
  const who = ctx.term;
  if (ctx.rosterPending) {
    return [
      `STEP 1 — ${GS.STEP_ROSTER} (AWAITING CONFIRMATION)`,
      `- The rows you proposed are in the ${GS.SIDE_PANEL}. The user edits them there and presses Create.`,
      `- Create NO ${who}S yourself while that table is open. Do not propose again unless given a new list.`,
      `- Answer questions about the rows. Warnings on a row mean it needs a human look, not a fix from you.`,
      `- After they press Create, report how many were created, skipped and failed.`,
    ].join("\n");
  }
  if (!ctx.instituteHasStudents) {
    return [
      `STEP 1 — ${GS.STEP_ROSTER}`,
      `- Ask for the list of ${who}S as a spreadsheet, PDF or photo. Read it.`,
      `- Then call guidedSetup(proposeRoster) with one row per ${who}. Mark anything unreadable null; never guess.`,
      `- Do NOT create ${who}S yourself. The user confirms the table in the ${GS.SIDE_PANEL}.`,
      `- Only if they say they have no list, or name one ${who} directly, add that one instead:`,
      `- Context_Students add { firstName, lastName, birthDate, gender, primaryLanguage },`,
      `  with instituteIds: ["${ctx.instituteId}"], then selectStudent(<new id>).`,
      STEP_ONE_ONLY_LINE,
    ].join("\n");
  }
  return [
    `STEP 1 — ${GS.STEP_ROSTER}`,
    `- Ask for this ${who}'s details, or a document about them (a form, PDF or photo). Read any document.`,
    `- Context_Students add { firstName, lastName, birthDate, gender, primaryLanguage },`,
    `  with instituteIds: ["${ctx.instituteId}"], then selectStudent(<new id>).`,
    `- If they are adding several instead, offer to take a whole list (spreadsheet, PDF or photo):`,
    `  read it, then call guidedSetup(proposeRoster) with one row per ${who}; mark unreadable fields null.`,
    `- Do NOT create ${who}S yourself while a table is pending. The user confirms it in the ${GS.SIDE_PANEL}.`,
    STEP_ONE_ONLY_LINE,
  ].join("\n");
}

/**
 * The institution's own "send it now" line, when there is somebody to send to.
 *
 * Only institutions get it: a family ${GS.GUARDIAN} is the signed-in user, and
 * mailing yourself a magic link instead of pressing the button in front of you
 * is a worse flow, not a shortcut.
 */
function consentRequestLine(ctx: StudentSetupCtx): string | null {
  if (ctx.account === "family") return null;
  const contact = ctx.basics.consentContact;
  if (!contact || (!contact.hasEmail && !contact.hasPhone)) return null;
  const channel = contact.hasEmail ? "email" : "sms";
  return (
    `- If the user asks to send it: guidedSetup(requestConsent, contactId="${contact.id}", ` +
    `channel="${channel}").`
  );
}

/**
 * Does this student have a guardian a CONSENT request could actually reach?
 * `hasGuardian` alone is not enough — a guardian row with no email or phone
 * cannot receive a link, and `consentContact` is already the honest,
 * send-ready fact (loadConsentContact only returns a row with one or the
 * other). Mirrors the null check `consentRequestLine` uses to hide its line.
 */
function hasContactableGuardian(ctx: StudentSetupCtx): boolean {
  const contact = ctx.basics.consentContact;
  return !!contact && (contact.hasEmail || contact.hasPhone);
}

/**
 * The block a LOCKED step renders instead of its own.
 *
 * It used to end with "Meanwhile you may correct step 1 facts, and answer
 * questions about what happens next" — an invitation, with nothing else on
 * offer, to go and find something to talk about. Observed live: the assistant
 * interviewed the user about a consent-pending patient's communication and
 * wrote `Student_CommunicationProfile` and `Student_CommunicationStyle`. Those
 * are student chat-memory fields; `requireConsentForMemoryWrite` covers only
 * the reports, the program and incidents, so NOTHING refused the write.
 *
 * The prohibition therefore has to be stated in the prompt, and it has to name
 * the path that was actually taken — not just "reports".
 */
function awaitingConsentBlock(ctx: StudentSetupCtx): string {
  const who = ctx.term;
  const action =
    ctx.account === "family"
      ? `- Tell the user to press "Sign consent" in the ${GS.SIDE_PANEL} and complete the form there.`
      : ctx.gate === "request_sent"
        ? `- A ${GS.CONSENT} request is already pending with the ${GS.GUARDIAN}. Tell the user we are waiting for it.`
        : hasContactableGuardian(ctx)
          ? `- Point the user at "Send consent requests" in the ${GS.SIDE_PANEL} — it sends one link per ${who}.`
          : `- This ${who} has no guardian contact with an email or phone yet. Nothing can be sent.`;
  const addGuardian =
    ctx.account !== "family" && ctx.gate !== "request_sent" && !hasContactableGuardian(ctx)
      ? `- Add a guardian with an email or phone in the ${GS.CONTACTS_PANEL}, then send the ${GS.CONSENT} link.`
      : null;
  const send = consentRequestLine(ctx);
  return [
    `WAITING FOR ${GS.CONSENT}`,
    `- Nothing beyond ${GS.STEP_BASICS} may be collected or recorded for this ${who} until ${GS.CONSENT} is active.`,
    action,
    ...(addGuardian ? [addGuardian] : []),
    ...(send ? [send] : []),
    `- Never collect ID numbers, health details, documents, notes, interests, communication profile or style.`,
    `- No Student_* memory writes. You may only finish step 1 facts, explain ${GS.CONSENT} and answer questions.`,
  ].join("\n");
}

function medicalBlock(ctx: StudentSetupCtx): string {
  if (consentGate(ctx).ok === false) return awaitingConsentBlock(ctx);
  return [
    `STEP 2 — ${GS.STEP_MEDICAL}`,
    `- Ask for ${GS.DIAGNOSIS}, ${GS.ALERTS} (allergies / seizures / cardiac), ${GS.MEDICATIONS}, equipment.`,
    `- An uploaded report counts. Save: Context_Reports.medicalRecord, or functionalReport / educationalReport.`,
    `- Leave every record as a draft. Do not finalize.`,
    `- A document is readable ONLY in the turn it is attached. Extract everything in that turn.`,
    `- If the user has nothing yet, offer to skip.`,
  ].join("\n");
}

function programBlock(ctx: StudentSetupCtx): string {
  if (consentGate(ctx).ok === false) return awaitingConsentBlock(ctx);
  return [
    `STEP 3 — ${GS.STEP_PROGRAM}`,
    `- Confirm the framework with the user: ${GS.TALA}, ${GS.US_IEP} or ${GS.PERSONAL} (no statutory paperwork).`,
    `- Suggest ${suggestedFramework(ctx)}.`,
    `- Then propose 2-4 ${GS.GOALS} with objectives, drawn from steps 1-2. Ask before saving.`,
    `- Save: Context_Program (framework, title), then the goals and their objectives.`,
    `- Once the user agrees to the ${GS.GOALS}, call guidedSetup(activateProgram), then guidedSetup(advance).`,
  ].join("\n");
}

/**
 * Names to offer for the AI companion, as a FIXED list.
 *
 * Fixed is the whole point. The user asked for "a name, suggesting one from a
 * random list", and the obvious implementation — shuffle per render — would
 * make this block different bytes on every turn, which is exactly what the
 * cached Anthropic prefix and the byte-stability tests forbid. The randomness
 * belongs to the MODEL: the list is constant, the three it offers are its own
 * choice.
 *
 * Short, one or two syllables, easy for a synthetic voice and for a child to
 * say, and not obviously tied to one culture or gender — this companion ships
 * in eleven locales.
 */
export const AI_NAME_SUGGESTIONS: readonly string[] = [
  "Ari",
  "Bo",
  "Kai",
  "Lumi",
  "Mika",
  "Nia",
  "Ori",
  "Pip",
  "Rio",
  "Tavi",
];

/** The fixed list as it appears in the prompt. Never shuffled — see above. */
export const AI_NAME_SUGGESTION_LINE = AI_NAME_SUGGESTIONS.join(", ");

/**
 * STEP 4, rewritten 2026-09-08 on the user's report: "The AAC Settings step is
 * asking questions one at a time, and isn't prioritizing them well."
 *
 * The old block was a bag of settings in no stated order, so the model asked
 * for whatever came to hand — voices before it knew whether the person could
 * press a button at all. The order below is the user's, and it is NUMBERED
 * because an unordered bullet list is what produced the complaint:
 *
 *  1. is this person an AAC USER at all (the host action);
 *  2. INPUT — touch or eyegaze. The minimum for the app to be usable;
 *  3. WHAT IT IS FOR — everyday needs / teaching / conversation, plus any
 *     specific behaviours. Third, and immediately after input, because
 *     caretakers arrive expecting a companion and are handed a needs board;
 *     this is the question that catches that. It is also the one thing here
 *     they can change later just by asking, so the block says so in the same
 *     turn rather than leaving them to discover it;
 *  4. a NAME, offered from AI_NAME_SUGGESTIONS;
 *  5. the remaining settings, then the device sign-in.
 *
 * Only fields `WRITABLE_COLUMNS` in aac-settings-memory-schema.ts accepts are
 * named. `enabled` is NOT one of them (that is `setAacUser`'s job), and neither
 * are the app list, gestures or knownPeople — naming an unwritable field here
 * only teaches the model to make writes that are silently dropped.
 *
 * Item 5 NAMES its fields for the same reason item 2 and item 4 do. The user's
 * report: "Can the AI see AI name and Language level? I see it's adding them as
 * system prompt lines instead of those fields." Both ARE writable properties of
 * `Context_AACSettings` (`aiName`, `languageLevel`), so the model could always
 * have set them — it wrote free-text rules because the block described the
 * SUBJECT ("language level") and never the COLUMN. There is no `language`
 * column here at all: the language itself is step 1's HOME LANGUAGE on the
 * student row, so item 5 no longer asks for it.
 */
function aacBlock(ctx: StudentSetupCtx): string {
  if (consentGate(ctx).ok === false) return awaitingConsentBlock(ctx);
  return [
    `STEP 4 — ${GS.STEP_AAC}`,
    `- Ask ONE numbered question per turn, in this order. Do not run ahead.`,
    `1. Will the ${ctx.term} use the ${GS.AAC_APP}? Then guidedSetup(setAacUser, value). If no, advance.`,
    `2. Touch or eyegaze? If eyegaze: which provider, and how much rest space at the screen edge.`,
    `   Save Context_AACSettings { selectionMethod, eyegazeEnabled, eyegazeProvider, restSpace }.`,
    `3. What is the assistant FOR: everyday needs (the default), teaching, or company and talk?`,
    `   Ask for any specific behaviours they want. Save each as one rule in Context_AACPrompt.`,
    `   Say in the same reply that they can change this any time by asking you here.`,
    `4. A name for the assistant. Offer three of these, or take their own:`,
    `   ${AI_NAME_SUGGESTION_LINE}. Save Context_AACSettings { aiName }.`,
    `5. How long the assistant's sentences should be, then its voice and the ${ctx.term}'s voice.`,
    `   Save Context_AACSettings { languageLevel, voiceType, studentVoiceType }.`,
    `- Never put a ${GS.DIAGNOSIS} name or a ${GS.MEDICATIONS} name in those rules.`,
    `- Device: install the ${GS.AAC_APP}, sign in with this account, pick the ${ctx.term}. It registers itself.`,
    `- When all five are covered, call guidedSetup(advance).`,
  ].join("\n");
}

/**
 * STEP 5 — the people around this person. Added 2026-09-08 at the user's
 * request: "There should also be a fifth step, to add student contacts."
 *
 * Only fields the AI can actually write are named: contacts-memory-schema.ts
 * accepts name, relationship, role, customRole, organization, contactEmail,
 * contactPhone, contextNotes and the two link ids. The three things a caretaker
 * WILL volunteer here and the AI must not record — `isLegalGuardian`,
 * `callable` and the government-ID columns — are not writable through that
 * field at all, so the block refuses them out loud instead of letting the model
 * try and have the write silently dropped.
 *
 * The photo/voice line is not a nicety: a caretaker who has just been asked to
 * list the people in a child's life is exactly the person who asks "and how
 * does it recognise them?", and the answer is the panel, not this conversation.
 * It names the EDIT BUTTON and says what the photo is for, because "added
 * later in the Contacts panel" told a user neither where to click nor why to
 * bother. Same wording and same non-offer as `portraitBlock` — the assistant
 * cannot set a portrait itself from a chat attachment (see that comment).
 */
function contactsBlock(ctx: StudentSetupCtx): string {
  if (consentGate(ctx).ok === false) return awaitingConsentBlock(ctx);
  return [
    `STEP 5 — ${GS.STEP_CONTACTS}`,
    `- Ask who ELSE is in the ${ctx.term}'s life: family, teachers, therapists. One person per turn.`,
    `- Take a name and their ${GS.RELATIONSHIP}. An email or phone only if the user offers one.`,
    `- Save: Student_Contacts add { name, relationship, role, organization, contactEmail, contactPhone }.`,
    `- Never ask for an ID number, for legal guardianship, or for permission to call. Not set here.`,
    `- Photos and voices go in the ${GS.CONTACTS_PANEL}: the edit button by each ${GS.PORTRAIT}. The ${GS.AAC_APP} uses them to recognise people.`,
    `- Offer to skip. When they have nobody else to add, call guidedSetup(advance).`,
  ].join("\n");
}

function doneBlock(ctx: StudentSetupCtx): string {
  return [
    `${GS.FLOW} IS COMPLETE`,
    `- Tell the user in two or three sentences what is now set up for the ${ctx.term}.`,
    `- Say anything can still be changed later from the ${GS.SIDE_PANEL}.`,
    `- Do not call guidedSetup again.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const basicsStep: GuidedStep<StudentSetupCtx, GuidedSetupStepId> = {
  id: "basics",
  panel: GUIDED_SETUP_PANEL_BY_STEP.basics,
  skippable: false,
  checklist: (ctx) => {
    // A school or clinic starts on a ROSTER, not one person's facts — before
    // any student is in scope for this flow, the rail should show that, not a
    // personal checklist with nobody behind it (seen live: a five-item
    // name/birth/gender/language/guardian list next to an empty roster table).
    if (ctx.account !== "family" && !ctx.basics.inInstitute) {
      return [item("roster", ctx.basics.inInstitute)];
    }
    return [
      item("name", !!ctx.basics.name && ctx.basics.name.trim() !== ""),
      item("birthDate", !!ctx.basics.birthDate),
      item("gender", !!ctx.basics.gender),
      item("language", !!ctx.basics.primaryLanguage),
      item("guardian", ctx.basics.hasGuardian),
    ];
  },
  // The row must exist IN THIS INSTITUTE and carry every identity fact the
  // checklist above lists (BIRTH DATE included — the consent wizard cannot run
  // without one). GUARDIAN is excluded on purpose: see `missingBasicsFacts`.
  isComplete: (ctx) => ctx.basics.inInstitute && missingBasicsFacts(ctx).length === 0,
  canEnter: () => GATE_OK,
  promptBlock: (ctx, view) =>
    [
      rulesBlock(ctx, isCurrentStepLocked(view)),
      ctx.account === "family" ? basicsBlock(ctx) : rosterBlock(ctx),
      stillMissingBlock(ctx),
      portraitBlock(ctx),
    ]
      .filter((block): block is string => block !== null)
      .join("\n"),
};

const medicalStep: GuidedStep<StudentSetupCtx, GuidedSetupStepId> = {
  id: "medical",
  panel: GUIDED_SETUP_PANEL_BY_STEP.medical,
  skippable: true,
  checklist: (ctx) => [
    item("diagnosis", ctx.reports.hasDiagnosis),
    item("alerts", ctx.reports.hasAlerts),
    item("medications", ctx.reports.hasMedications),
  ],
  isComplete: (ctx) => ctx.reports.hasAnyReport,
  canEnter: consentGate,
  promptBlock: (ctx, view) => `${rulesBlock(ctx, isCurrentStepLocked(view))}\n${medicalBlock(ctx)}`,
};

const programStep: GuidedStep<StudentSetupCtx, GuidedSetupStepId> = {
  id: "program",
  panel: GUIDED_SETUP_PANEL_BY_STEP.program,
  skippable: true,
  checklist: (ctx) => [
    item("framework", !!ctx.program.framework || !!ctx.basics.framework),
    item("goals", ctx.program.activeGoalCount > 0),
    item("activated", ctx.program.hasActiveProgram),
  ],
  // A draft program is INVISIBLE to the AAC (aac-memory-schema loads only
  // active programs and active goals), so the step is not done until both are.
  isComplete: (ctx) => ctx.program.hasActiveProgram && ctx.program.activeGoalCount > 0,
  canEnter: consentGate,
  incompleteReason: (ctx) => (ctx.program.exists ? "programDraft" : "programMissing"),
  promptBlock: (ctx, view) => `${rulesBlock(ctx, isCurrentStepLocked(view))}\n${programBlock(ctx)}`,
};

const aacStep: GuidedStep<StudentSetupCtx, GuidedSetupStepId> = {
  id: "aac",
  panel: GUIDED_SETUP_PANEL_BY_STEP.aac,
  skippable: true,
  isHidden: (ctx) => !ctx.aacLicensed,
  // Listed in the order the block now ASKS them (input, then the rules that
  // come out of "what is it for", then voices). The rail is the user's map of
  // the conversation; a checklist in a different order than the questions is
  // how "isn't prioritizing them well" looks on screen.
  checklist: (ctx) => [
    item("aacUser", ctx.record?.notAacUser === true || ctx.aac.enabled),
    item("input", ctx.aac.inputDecided),
    item("rules", ctx.aac.rulesSet),
    item("voice", ctx.aac.voiceSet),
  ],
  isComplete: (ctx) =>
    ctx.record?.notAacUser === true || (ctx.aac.enabled && !!ctx.record?.aacReviewedAt),
  canEnter: consentGate,
  promptBlock: (ctx, view) => `${rulesBlock(ctx, isCurrentStepLocked(view))}\n${aacBlock(ctx)}`,
};

/**
 * STEP 5 — CONTACTS.
 *
 * Completion is `peopleAdded > 0`: at least one active contact that a PERSON
 * decided to add. Two rows deliberately do not count (see
 * `loadContactFacts`): an `autoAdded` row the AAC Monitor guessed from a
 * session, and the guardian row the system writes for a family admin who
 * created the student through the form. The second is the one that matters
 * here — it lands with `autoAdded = false`, so counting rows, or even counting
 * non-auto-added rows, would let a family flow finish step 5 without asking a
 * single question.
 *
 * Skippable, like steps 2-4: plenty of children are set up by one person who
 * has nobody else to list yet. Behind the same consent gate as the rest —
 * the people around a child are personal data about third parties.
 */
const contactsStep: GuidedStep<StudentSetupCtx, GuidedSetupStepId> = {
  id: "contacts",
  panel: GUIDED_SETUP_PANEL_BY_STEP.contacts,
  skippable: true,
  checklist: (ctx) => [item("people", ctx.contacts.peopleAdded > 0)],
  isComplete: (ctx) => ctx.contacts.peopleAdded > 0,
  canEnter: consentGate,
  promptBlock: (ctx, view) => `${rulesBlock(ctx, isCurrentStepLocked(view))}\n${contactsBlock(ctx)}`,
};

export const studentSetupFlow: GuidedFlowDefinition<StudentSetupCtx, GuidedSetupStepId> = {
  id: GUIDED_SETUP_FLOW_ID,
  donePanel: GUIDED_SETUP_DONE_PANEL,
  steps: [basicsStep, medicalStep, programStep, aacStep, contactsStep],
};

// Phase C landed the setAacUser / activateProgram / requestConsent host actions
// in student-setup-actions.ts; the blocks above tell the AI when to call them.
// Phase D swapped step 1's block for school/clinic: `rosterBlock` proposes, the
// user confirms in the panel, and `roster-import.ts` does the writing.

/** The prompt body for the current step, or the completion block when finished. */
export function renderStudentSetupBlock(
  ctx: StudentSetupCtx,
  view: GuidedFlowView<GuidedSetupStepId>,
): string {
  if (view.step === "done") return doneBlock(ctx);
  const step = studentSetupFlow.steps.find((s) => s.id === view.step);
  if (!step) return doneBlock(ctx);
  return step.promptBlock(ctx, view);
}
