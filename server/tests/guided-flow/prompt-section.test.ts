/**
 * Two things about the GUIDED SETUP prompt section can break without anyone
 * noticing, and both cost real money or real quality:
 *
 *  1. POSITION. The block is volatile — it changes every time the step or the
 *     consent state changes. Anywhere but the TAIL of the system prompt it
 *     invalidates Anthropic's cached prefix, turning cache READS (0.1x) into
 *     WRITES (1.25x) on every turn of every clinician session.
 *  2. SHAPE. docs/PROMPT_WRITING.md caps a prompt line at 130 characters and a
 *     bullet list at ~5 items. A long line does not throw; it just degrades the
 *     small models this text also has to survive.
 *
 * Byte-stability is asserted rather than eyeballed so a refactor cannot quietly
 * reorder attributes and bust the cache on the first production turn.
 */

import { describe, it, expect } from "@jest/globals";

import { buildPromptAndTools } from "../../services/chat/prompt-kit.js";
import {
  GUIDED_FLOW_SECTION_HEADER,
  renderGuidedSetupSection,
} from "../../services/guided-setup/flow-prompt-section.js";
import { resolveFlowView, stepPosition } from "../../services/guided-setup/flow-engine.js";
import {
  AI_NAME_SUGGESTIONS,
  AI_NAME_SUGGESTION_LINE,
  EMPTY_AAC,
  EMPTY_BASICS,
  EMPTY_CONTACTS,
  EMPTY_PROGRAM,
  EMPTY_REPORTS,
  currentStepBlockedBy,
  missingBasicsFacts,
  renderStudentSetupBlock,
  studentSetupFlow,
  type StudentSetupCtx,
} from "../../services/guided-setup/student-setup-flow.js";
import { isResumableRecord } from "../../services/guided-setup/student-setup-binding.js";
import {
  GUIDED_SETUP_CONTEXT_KEY,
  GUIDED_SETUP_PANEL_BY_STEP,
  GUIDED_SETUP_SKIPPABLE_STEPS,
  GUIDED_SETUP_STEP_ORDER,
  GUIDED_SETUP_TOOL_NAME,
  type GuidedSetupAccount,
  type GuidedSetupGate,
  type GuidedSetupRecord,
} from "@shared/guided-setup";
import { GS, termForAccount } from "../../services/guided-setup/terms.js";

const MAX_LINE = 130;

function makeCtx(over: Partial<StudentSetupCtx> = {}): StudentSetupCtx {
  const account: GuidedSetupAccount = over.account ?? "family";
  return {
    account,
    term: termForAccount(account),
    lang: "he",
    instituteId: "11111111-2222-3333-4444-555555555555",
    instituteName: "Test Institute",
    studentId: null,
    userName: "Dana",
    firstTurn: false,
    aacLicensed: true,
    instituteHasStudents: false,
    gate: "off",
    record: null,
    basics: EMPTY_BASICS,
    reports: EMPTY_REPORTS,
    program: EMPTY_PROGRAM,
    aac: EMPTY_AAC,
    contacts: EMPTY_CONTACTS,
    ...over,
    ...(over.account ? { term: over.term ?? termForAccount(over.account) } : {}),
  };
}

/**
 * Exactly what `student-setup-service.renderSection` assembles — including the
 * `blocked` attribute — so this suite cannot pass on a header the server never
 * emits.
 */
function sectionFor(ctx: StudentSetupCtx): string {
  const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
  const blocked = currentStepBlockedBy(view);
  return renderGuidedSetupSection(
    {
      flow: "student_setup",
      account: ctx.account,
      term: ctx.term,
      step: stepPosition(view),
      ...(blocked ? { blocked } : {}),
      consent: ctx.gate,
      lang: ctx.lang,
    },
    renderStudentSetupBlock(ctx, view),
  );
}

/**
 * Step 1 satisfied: the flow now sits on step 2, gated or not.
 *
 * Every identity fact, not just the BIRTH DATE. A row with a name and a birth
 * date used to finish step 1 on its own — which is exactly how a single
 * `Context_Students add` threw the flow onto a consent-locked step 2 with
 * nothing left to do (see `missingBasicsFacts`).
 */
const COMPLETE_BASICS = {
  ...EMPTY_BASICS,
  inInstitute: true,
  name: "Ray Cairo",
  birthDate: "2018-01-01",
  gender: "male",
  primaryLanguage: "en",
};

/** Steps 1-3 done: the flow sits on AAC SETUP. */
const THROUGH_PROGRAM: Partial<StudentSetupCtx> = {
  studentId: "s1",
  basics: {
    ...EMPTY_BASICS,
    inInstitute: true,
    name: "Ray Cairo",
    birthDate: "2018-01-01",
    gender: "male",
    primaryLanguage: "en",
  },
  reports: { ...EMPTY_REPORTS, hasAnyReport: true },
  program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
};

/** The record that makes the AAC step derived-complete (see `aacStep.isComplete`). */
const AAC_REVIEWED: GuidedSetupRecord = {
  v: 1,
  source: "chat",
  startedAt: "2026-01-01T00:00:00.000Z",
  startedByUserId: "u1",
  skipped: [],
  aacReviewedAt: "2026-01-02T00:00:00.000Z",
};

/** Steps 1-4 done: the flow sits on CONTACTS, the fifth step. */
const THROUGH_AAC: Partial<StudentSetupCtx> = {
  ...THROUGH_PROGRAM,
  aac: { ...EMPTY_AAC, enabled: true },
  record: AAC_REVIEWED,
};

/**
 * The one line of the WAITING block that is allowed to name the locked steps.
 *
 * User, 2026-09-09: "Assume the user has no idea what they're doing and needs
 * everything clearly explained." A person told only that they are blocked, and
 * never what being unblocked gives them, has no reason to go and do the work —
 * so the block says what CONSENT opens, in the same "comes later" framing the
 * step-1 blocks have used since the Mira Vance fix.
 *
 * It is a NAME, not an ask, and it is the ONLY mention permitted while a step
 * is locked: the pins below strip this line and then assert that step-2
 * vocabulary appears nowhere else. Widen that carve-out and the Ray Cairo
 * failure — a consent-pending patient interviewed about their diagnoses — has
 * its opening back.
 */
const UNLOCKS_LINE =
  `- ${GS.STEP_MEDICAL}, ${GS.STEP_PROGRAM}, ${GS.STEP_AAC} and ${GS.STEP_CONTACTS} ` +
  `all open the moment ${GS.CONSENT} is active. Say so.`;

const withoutUnlocksLine = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line !== UNLOCKS_LINE)
    .join("\n");

/** The row exists but only carries what one hasty `add` supplied. */
const PARTIAL_BASICS = {
  ...EMPTY_BASICS,
  inInstitute: true,
  name: "Ray Cairo",
  birthDate: "2018-01-01",
};

describe("renderGuidedSetupSection", () => {
  it("is byte-stable for the same inputs", () => {
    const ctx = makeCtx();
    expect(sectionFor(ctx)).toBe(sectionFor(makeCtx()));
  });

  it("renders the header, the tag and its attributes in a fixed order", () => {
    const text = sectionFor(makeCtx({ gate: "sign_required" }));
    expect(text.startsWith(`${GUIDED_FLOW_SECTION_HEADER}\n\n`)).toBe(true);
    expect(text).toContain(
      '<guided_setup flow="student_setup" account="family" term="CHILD" step="1/5" consent="sign_required" lang="he">',
    );
    expect(text.trimEnd().endsWith("</guided_setup>")).toBe(true);
  });

  it("uses the account's own term and forbids the others", () => {
    expect(sectionFor(makeCtx({ account: "school" }))).toContain("Call the person the STUDENT");
    expect(sectionFor(makeCtx({ account: "clinic" }))).toContain("Call the person the PATIENT");
  });

  it("names the reply language from the view", () => {
    expect(sectionFor(makeCtx({ lang: "pt" }))).toContain("(pt)");
  });
});

describe("student_setup prompt blocks", () => {
  const gates: GuidedSetupGate[] = ["off", "none", "sign_required", "request_sent", "active", "revoked"];
  const accounts: GuidedSetupAccount[] = ["family", "school", "clinic"];

  it("keeps every line within the 130-character prompt budget", () => {
    const offenders: string[] = [];
    for (const account of accounts) {
      for (const gate of gates) {
        for (const firstTurn of [false, true]) {
          // Walk every step by making the earlier ones complete.
          const stages: Partial<StudentSetupCtx>[] = [
            {},
            // The row exists but step 1 is not finished — the STILL MISSING
            // block, which names every outstanding item on one line.
            { basics: { ...PARTIAL_BASICS } },
            { basics: { ...COMPLETE_BASICS } },
            // A contactable GUARDIAN puts a uuid and a channel on one line of
            // the waiting block — the longest line the flow can emit.
            {
              basics: {
                ...COMPLETE_BASICS,
                hasGuardian: true,
                consentContact: {
                  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                  name: "A Very Long Guardian Name That Should Not Reach The Prompt",
                  hasEmail: true,
                  hasPhone: true,
                },
              },
            },
            {
              basics: { ...COMPLETE_BASICS },
              reports: { ...EMPTY_REPORTS, hasAnyReport: true },
            },
            {
              basics: { ...COMPLETE_BASICS },
              reports: { ...EMPTY_REPORTS, hasAnyReport: true },
              program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
            },
            // Step 4 reviewed → the flow sits on CONTACTS, the fifth step.
            {
              basics: { ...COMPLETE_BASICS },
              reports: { ...EMPTY_REPORTS, hasAnyReport: true },
              program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
              aac: { ...EMPTY_AAC, enabled: true },
              record: AAC_REVIEWED,
            },
            // …and with a contact on file, the completion block.
            {
              basics: { ...COMPLETE_BASICS },
              reports: { ...EMPTY_REPORTS, hasAnyReport: true },
              program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
              aac: { ...EMPTY_AAC, enabled: true },
              record: AAC_REVIEWED,
              contacts: { total: 2, peopleAdded: 1 },
            },
          ];
          for (const stage of stages) {
            const ctx = makeCtx({ account, gate, firstTurn, studentId: "s1", ...stage });
            for (const line of sectionFor(ctx).split("\n")) {
              if (line.length > MAX_LINE) offenders.push(`${account}/${gate}: ${line}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("tells step 1 which institute the student belongs to, and to select it after creating", () => {
    const ctx = makeCtx();
    const text = sectionFor(ctx);
    expect(text).toContain(`instituteIds: ["${ctx.instituteId}"]`);
    expect(text).toContain("selectStudent");
    expect(text).toContain("Context_Students add");
  });

  it("greets the user by name only on the first turn", () => {
    expect(sectionFor(makeCtx({ firstTurn: true }))).toContain("Greet Dana by name");
    expect(sectionFor(makeCtx({ firstTurn: false }))).not.toContain("Greet Dana by name");
  });

  /**
   * Observed live: a clinic's very first turn asked for one patient's first
   * name and never mentioned the roster, because the old FIRST TURN lines were
   * singular and account-blind. The first thing the model says must point at
   * the list for a school/clinic, and stay exactly as it was for a family.
   */
  it("makes the FIRST TURN line account-aware: the list for an institution, the single walk-through for a family", () => {
    const family = sectionFor(makeCtx({ account: "family", firstTurn: true }));
    expect(family).toContain(
      "Say you will set up the CHILD together, step by step, then ask the first question.",
    );
    expect(family).not.toContain("from a list they send");

    for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
      const term = termForAccount(account);
      const text = sectionFor(makeCtx({ account, firstTurn: true }));
      expect(text).toContain(`Say you will add their ${term}S from a list they send, then ask for that list.`);
      expect(text).not.toContain("what is the");
      expect(text).not.toContain("first name");
      expect(text).not.toContain("Say you will set up the");
    }
  });

  it("swaps step 2 for a consent-waiting block while the gate is closed", () => {
    const basics = { ...COMPLETE_BASICS };
    const waiting = sectionFor(makeCtx({ studentId: "s1", gate: "sign_required", basics }));
    expect(waiting).toContain("WAITING FOR CONSENT");
    expect(waiting).toContain("SIDE PANEL");
    expect(waiting).toContain("Never collect ID numbers");
    expect(waiting).not.toContain("STEP 2 — MEDICAL INFO");

    const open = sectionFor(makeCtx({ studentId: "s1", gate: "active", basics }));
    expect(open).toContain("STEP 2 — MEDICAL INFO");
    expect(open).not.toContain("WAITING FOR CONSENT");
  });

  /**
   * Phase C replaced three "do it yourself in the SIDE PANEL" instructions with
   * real host actions. If a block drifts back to the panel wording the flow
   * still works — it just stops moving on its own, and the user is told to
   * press a button that Phase B never grew.
   */
  it("names the host action for each step instead of sending the user to the panel", () => {
    const complete = { ...COMPLETE_BASICS };
    const atProgram = sectionFor(
      makeCtx({
        studentId: "s1",
        basics: complete,
        reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      }),
    );
    expect(atProgram).toContain("guidedSetup(activateProgram)");
    expect(atProgram).not.toContain(`activate the ${GS.STEP_PROGRAM} in the`);

    const atAac = sectionFor(
      makeCtx({
        studentId: "s1",
        basics: complete,
        reports: { ...EMPTY_REPORTS, hasAnyReport: true },
        program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
      }),
    );
    expect(atAac).toContain("guidedSetup(setAacUser, value)");
    expect(atAac).toContain("guidedSetup(advance)");
  });

  it("offers requestConsent to an institution with a contactable guardian, never to a family", () => {
    const basics = {
      ...COMPLETE_BASICS,
      hasGuardian: true,
      consentContact: {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name: "Guardian",
        hasEmail: true,
        hasPhone: false,
      },
    };
    const school = sectionFor(
      makeCtx({ account: "school", studentId: "s1", gate: "sign_required", basics }),
    );
    expect(school).toContain(
      'guidedSetup(requestConsent, contactId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", channel="email")',
    );

    // A family GUARDIAN is the signed-in user: they press the button, they are
    // not mailed a magic link.
    const family = sectionFor(
      makeCtx({ account: "family", studentId: "s1", gate: "sign_required", basics }),
    );
    expect(family).not.toContain("requestConsent");
    expect(family).toContain("Sign consent");

    // Nothing to send to → no offer at all.
    const noContact = sectionFor(
      makeCtx({
        account: "school",
        studentId: "s1",
        gate: "sign_required",
        basics: { ...basics, consentContact: null },
      }),
    );
    expect(noContact).not.toContain("requestConsent");
  });

  /**
   * Phase D. The institution's step 1 is a ROSTER, and the one instruction that
   * matters is the negative: while a proposal is on screen the model must not
   * create anybody itself. It will otherwise "helpfully" add the student the
   * user just asked about through Context_Students — and then that student is
   * created a SECOND time when the panel's Create button is pressed.
   */
  it("gives a school and a clinic the roster block, and a family the conversational one", () => {
    for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
      const text = sectionFor(makeCtx({ account }));
      expect(text).toContain(`STEP 1 — ${GS.STEP_ROSTER}`);
      expect(text).toContain("guidedSetup(proposeRoster)");
      expect(text).toContain(GS.SIDE_PANEL);
      expect(text).not.toContain(`STEP 1 — ${GS.STEP_BASICS}`);
    }

    const family = sectionFor(makeCtx({ account: "family" }));
    expect(family).toContain(`STEP 1 — ${GS.STEP_BASICS}`);
    expect(family).not.toContain("proposeRoster");
  });

  it("forbids the AI creating people itself on the roster path", () => {
    const proposing = sectionFor(makeCtx({ account: "school" }));
    expect(proposing).toContain("Do NOT create STUDENTS yourself");
    // The single-student escape hatch survives: a school adding one child mid-
    // year should not have to build a spreadsheet for it. But it must read as
    // a FALLBACK, not a parallel option offered up front — the AI asks for the
    // list first, and only takes one student if there is no list, or the user
    // names someone directly.
    expect(proposing).toContain(
      "Only if they say they have no list, or name one STUDENT directly, add that one instead:",
    );
    expect(proposing).not.toContain("Or offer:");
    expect(proposing).toContain("Context_Students add");

    const pending = sectionFor(makeCtx({ account: "school", rosterPending: true }));
    expect(pending).toContain("AWAITING CONFIRMATION");
    expect(pending).toContain("Create NO STUDENTS yourself");
    // While the table is open there is no single-student path at all — that is
    // exactly the double-create.
    expect(pending).not.toContain("Context_Students add");
    expect(pending).toContain("created, skipped and failed");
  });

  /**
   * The block is always about the ONE bound student, so it points at the rail's
   * SINGULAR "Send consent request" button. The plural "Send consent requests"
   * is the roster batch and belongs to nobody's step block — naming it here
   * sent a user looking for a list-wide control in a one-student flow.
   */
  it("sends an institution with a contactable guardian to the panel's single-student button", () => {
    const basics = {
      ...COMPLETE_BASICS,
      hasGuardian: true,
      consentContact: {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name: "Guardian",
        hasEmail: true,
        hasPhone: false,
      },
    };
    const school = sectionFor(
      makeCtx({ account: "school", studentId: "s1", gate: "sign_required", basics }),
    );
    expect(school).toContain('press "Send consent request" in the SIDE PANEL');
    expect(school).not.toContain("Send consent requests");
    // A family guardian is the signed-in user; they press Sign consent instead.
    const family = sectionFor(
      makeCtx({ account: "family", studentId: "s1", gate: "sign_required", basics }),
    );
    expect(family).not.toContain("Send consent request");
  });

  /**
   * The live bug: a patient with NO guardian contact at all (`gate: "none"`)
   * got the SAME "Send consent requests" line as one with a contactable
   * guardian, sending the user hunting for a button the rail never rendered.
   */
  describe("an institution with no contactable guardian yet", () => {
    const noGuardianBasics = { ...COMPLETE_BASICS };

    /**
     * The original pin: a patient with NO guardian contact must never be sent
     * to a button the rail does not render for them. It used to be met by
     * pointing at the Contacts panel; since 2026-09-09 the block does better
     * and ASKS for the guardian in the conversation it is already having. The
     * property that mattered — no phantom button, a concrete next move — is
     * unchanged, so it is asserted the same way.
     */
    it("never names the batch button, and asks for the guardian instead", () => {
      const text = sectionFor(
        makeCtx({ account: "clinic", studentId: "s1", gate: "none", basics: noGuardianBasics }),
      );
      expect(text).not.toContain("Send consent requests");
      expect(text).toContain(`ASK for the ${GS.GUARDIAN} now`);
      expect(text).toContain("Student_Contacts add");
    });

    it("still says a request is pending, not that a guardian is missing, once one is sent", () => {
      const text = sectionFor(
        makeCtx({
          account: "clinic",
          studentId: "s1",
          gate: "request_sent",
          basics: noGuardianBasics,
        }),
      );
      expect(text).toContain("already pending");
      expect(text).not.toContain(`ASK for the ${GS.GUARDIAN} now`);
      expect(text).not.toContain("Student_Contacts add");
      expect(text).not.toContain("Send consent requests");
    });

    it("a contactable guardian gets the send line, and is never asked for a guardian again", () => {
      const basics = {
        ...noGuardianBasics,
        hasGuardian: true,
        consentContact: {
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          name: "Guardian",
          hasEmail: true,
          hasPhone: false,
        },
      };
      const text = sectionFor(
        makeCtx({ account: "clinic", studentId: "s1", gate: "sign_required", basics }),
      );
      expect(text).toContain('press "Send consent request" in the SIDE PANEL');
      expect(text).not.toContain("Send consent requests");
      expect(text).not.toContain(`ASK for the ${GS.GUARDIAN} now`);
      expect(text).not.toContain("Student_Contacts add");
    });

    /**
     * The family branch forks on the gate now. A family admin IS the guardian,
     * so `sign_required` still means "press Sign consent" — but `none` means
     * the auto-created guardian contact never landed, and the rail renders no
     * Sign consent button at all until it does.
     */
    it("a family with a guardian on file still presses 'Sign consent' in the SIDE PANEL", () => {
      const text = sectionFor(
        makeCtx({
          account: "family",
          studentId: "s1",
          gate: "sign_required",
          basics: noGuardianBasics,
        }),
      );
      expect(text).toContain(`press "Sign consent" in the ${GS.SIDE_PANEL}`);
      expect(text).not.toContain(GS.CONTACTS_PANEL);
      expect(text).not.toContain("Send consent requests");
    });
  });

  it("keeps the roster block inside the 130-character prompt budget", () => {
    const offenders: string[] = [];
    for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
      for (const rosterPending of [false, true]) {
        for (const firstTurn of [false, true]) {
          for (const instituteHasStudents of [false, true]) {
            const ctx = makeCtx({ account, rosterPending, firstTurn, instituteHasStudents });
            for (const line of sectionFor(ctx).split("\n")) {
              if (line.length > MAX_LINE) offenders.push(`${account}: ${line}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The user-reported fix: "Build patient roster" should only lead once the
   * institute has nobody yet. Once there is a roster, pressing "New patient"
   * almost always means one person — the list stays available, just no
   * longer the default.
   */
  describe("roster block forks on whether the institute already has students", () => {
    it("an empty institute still leads with the list ask", () => {
      const text = sectionFor(makeCtx({ account: "school", instituteHasStudents: false }));
      expect(text).toContain(`Ask for the list of STUDENTS as a spreadsheet, PDF or photo`);
      expect(text).toContain("guidedSetup(proposeRoster)");
    });

    it("an institute with existing students leads with the single student", () => {
      const text = sectionFor(makeCtx({ account: "school", instituteHasStudents: true }));
      expect(text).toContain(`Ask for this STUDENT's details, or a document about them`);
      expect(text).toContain("Context_Students add");
      // The list stays available as the equal alternative, not the default.
      expect(text).toContain("guidedSetup(proposeRoster)");
      expect(text).not.toContain("Ask for the list of STUDENTS as a spreadsheet, PDF or photo");
      // The double-create rule survives in this variant too.
      expect(text).toContain("Do NOT create STUDENTS yourself while a table is pending");
    });

    it("the pending variant is unchanged regardless of instituteHasStudents", () => {
      const withRoster = sectionFor(
        makeCtx({ account: "clinic", rosterPending: true, instituteHasStudents: true }),
      );
      const withoutRoster = sectionFor(
        makeCtx({ account: "clinic", rosterPending: true, instituteHasStudents: false }),
      );
      expect(withRoster).toBe(withoutRoster);
      expect(withRoster).toContain("AWAITING CONFIRMATION");
    });

    it("leaves the family branch untouched", () => {
      const withStudents = sectionFor(makeCtx({ account: "family", instituteHasStudents: true }));
      const withoutStudents = sectionFor(
        makeCtx({ account: "family", instituteHasStudents: false }),
      );
      expect(withStudents).toBe(withoutStudents);
      expect(withStudents).toContain(`STEP 1 — ${GS.STEP_BASICS}`);
    });
  });

  /**
   * The wall must be announced BEFORE it is hit (user, 2026-09-09). Step 1 used
   * to name the CONSENT button and nothing else, so the first a novice heard of
   * a guardian approval was the turn the flow stopped. Said while step 1 is
   * still running it is a warning; said afterwards it is an excuse.
   */
  describe("step 1 warns that CONSENT comes next", () => {
    const NEXT =
      `- Say ${GS.CONSENT} from a parent or ${GS.GUARDIAN} comes next: no health, ${GS.STEP_PROGRAM} or ` +
      `${GS.STEP_AAC} detail may be recorded before it.`;

    it("carries the warning on the family basics block, with the signing line after it", () => {
      const text = sectionFor(makeCtx());
      expect(text).toContain(NEXT);
      expect(text).toContain(
        `- They sign it themselves from a button in the ${GS.SIDE_PANEL}. Never collect ID numbers here.`,
      );
      // The prohibition that shared the old line survives the split.
      expect(text).toContain("Never collect ID numbers here.");
    });

    it("carries it on both non-pending roster variants", () => {
      for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
        for (const instituteHasStudents of [false, true]) {
          expect(sectionFor(makeCtx({ account, instituteHasStudents }))).toContain(NEXT);
        }
      }
    });

    /**
     * The AWAITING CONFIRMATION variant stays exempt for the same reason it is
     * exempt from STEP_ONE_ONLY_LINE: while the review table is open the whole
     * block is "write nothing, talk about the rows", and another bullet blunts
     * it.
     */
    it("leaves the AWAITING CONFIRMATION variant alone", () => {
      expect(sectionFor(makeCtx({ account: "school", rosterPending: true }))).not.toContain(NEXT);
    });

    it("stays inside the 130-character budget", () => {
      expect(NEXT.length).toBeLessThanOrEqual(MAX_LINE);
    });
  });

  it("asks step 1 for the country, because the consent wizard silently defaults to IL", () => {
    const text = sectionFor(makeCtx());
    expect(text).toContain(GS.COUNTRY);
  });

  it("does not restate the tool's own argument list (that lives in the tool description)", () => {
    const text = sectionFor(makeCtx());
    expect(text).not.toContain("Returns the new flow view");
    expect(text).toContain(`${GUIDED_SETUP_TOOL_NAME}(advance)`);
  });
});

/**
 * Observed live (clinic, 3 patients, 2026-09-08): the engine did everything
 * right — `step: medical`, `medical=locked`, and the step block underneath was
 * WAITING FOR CONSENT — and the assistant still opened with "We're on Step 2:
 * Medical Information now… Does Sam have any diagnoses?" for a patient with NO
 * consent record. Two lines above the block were enough: the standing rules
 * said "ask the first question", and the header said `step="2/5"`.
 *
 * Asking for PHI without consent is the one thing this feature must never do,
 * so the gate-aware shape of the rules and the header is pinned here.
 */
describe("student_setup rules — a LOCKED current step", () => {
  const lockedCtx = (over: Partial<StudentSetupCtx> = {}) =>
    makeCtx({
      account: "clinic",
      studentId: "s1",
      // The live shape: the gate is on, nobody has been asked yet.
      gate: "none",
      basics: COMPLETE_BASICS,
      ...over,
    });

  it("sits on step 2 with it locked, and says so in the header", () => {
    const ctx = lockedCtx();
    const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
    expect(view.step).toBe("medical");
    expect(view.steps.find((s) => s.id === "medical")?.status).toBe("locked");
    expect(sectionFor(ctx)).toContain('step="2/5" blocked="consent" consent="none"');
  });

  it("adds the BLOCKED rule instead of the advance rule", () => {
    const blocked = sectionFor(lockedCtx());
    expect(blocked).toContain("- The flow is BLOCKED at this step. Do not ask for anything belonging to it.");
    expect(blocked).not.toContain("(advance)");

    const open = sectionFor(lockedCtx({ gate: "active" }));
    expect(open).toContain("guidedSetup(advance)");
    expect(open).not.toContain("BLOCKED at this step");
  });

  it("gives the FIRST TURN no first question and no step-2 vocabulary", () => {
    const text = sectionFor(lockedCtx({ firstTurn: true }));
    expect(text).toContain("FIRST TURN");
    expect(text).toContain("Greet Dana by name");
    expect(text).toContain(`nothing more can be collected until ${GS.CONSENT} is active`);
    expect(text).toContain(GS.SIDE_PANEL);
    // The exact phrasings that produced the live failure.
    expect(text).not.toContain("first question");
    expect(text).not.toContain("step by step");
    // MEDICAL INFO is named once, in the line that says what CONSENT opens, and
    // nowhere else — see UNLOCKS_LINE.
    expect(text).toContain(UNLOCKS_LINE);
    const rest = withoutUnlocksLine(text);
    for (const word of [GS.DIAGNOSIS, GS.MEDICATIONS, GS.ALERTS, GS.STEP_MEDICAL]) {
      expect(rest).not.toContain(word);
    }
    for (const word of ["diagnos", "medicat", "allerg", "seizure"]) {
      expect(rest.toLowerCase()).not.toContain(word);
    }
    // …and the step block underneath is still the waiting one.
    expect(text).toContain(`WAITING FOR ${GS.CONSENT}`);
  });

  it("keeps the FIRST TURN unchanged while the step is workable", () => {
    const open = sectionFor(lockedCtx({ gate: "active", firstTurn: true }));
    expect(open).toContain(`Say you will add their ${GS.PATIENT}S from a list they send`);
    expect(open).not.toContain("nothing more can be collected");
  });

  it("renders no blocked attribute — byte-for-byte the old header — when nothing is locked", () => {
    const ctx = lockedCtx({ gate: "active" });
    const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
    const text = sectionFor(ctx);
    expect(text).not.toContain("blocked=");
    expect(text).toBe(
      renderGuidedSetupSection(
        {
          flow: "student_setup",
          account: ctx.account,
          term: ctx.term,
          step: stepPosition(view),
          consent: ctx.gate,
          lang: ctx.lang,
        },
        renderStudentSetupBlock(ctx, view),
      ),
    );
  });

  /**
   * The tag line is the longest single line the section can emit, and `blocked`
   * made it 18 characters longer. Worst case = the longest gate value, the
   * longest account/term pair and the longest locale code the app ships.
   */
  it("keeps the opening tag inside the 130-character budget in the worst case", () => {
    const text = sectionFor(lockedCtx({ gate: "request_sent", lang: "yue" }));
    const tag = text.split("\n").find((l) => l.startsWith("<guided_setup"))!;
    expect(tag).toContain('blocked="consent"');
    expect(tag.length).toBeLessThanOrEqual(MAX_LINE);
  });

  it("keeps every locked line within the prompt budget", () => {
    const offenders: string[] = [];
    for (const account of ["family", "school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["none", "sign_required", "request_sent", "revoked"] as GuidedSetupGate[]) {
        for (const firstTurn of [false, true]) {
          // Both step-1 shapes: complete (→ locked step 2) and partial (→ the
          // STILL MISSING block, whose longest line names all four facts).
          for (const basics of [COMPLETE_BASICS, PARTIAL_BASICS, { ...EMPTY_BASICS, inInstitute: true }]) {
            const ctx = makeCtx({ account, gate, firstTurn, studentId: "s1", basics });
            for (const line of sectionFor(ctx).split("\n")) {
              if (line.length > MAX_LINE) offenders.push(`${account}/${gate}: ${line}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * RESUME — the rail's "Continue setup" on a parked student.
 *
 * Observed live (clinic, 2026-09-08, "Sam Nella — Medical info — Waiting for
 * consent"): the button sent the kickoff as `{ start: true }`, and `start`
 * always begins UNBOUND, so the turn opened a fresh step-1 roster flow and the
 * assistant asked the clinic for a patient list. The gate-aware first turn
 * below is implemented and was pinned above — but until the resume actually
 * bound a student, it had never once executed on a real turn.
 *
 * The resume is `GuidedSetupRequest.resumeStudentId` now, and this is the turn
 * it produces: the student BOUND, `firstTurn` true, and the consent gate shut.
 */
describe("student_setup — a RESUMED student whose current step is locked", () => {
  const SAM = "44444444-5555-6666-7777-888888888888";

  const parkedRecord = (over: Partial<GuidedSetupRecord> = {}): GuidedSetupRecord => ({
    v: 1,
    source: "chat",
    // Parked days ago: the resume keeps the record's own startedAt rather than
    // re-dating the flow, so nothing created since can bind to it by accident.
    startedAt: "2026-09-01T08:00:00.000Z",
    startedByUserId: "u1",
    skipped: [],
    ...over,
  });

  /**
   * Exactly what sessionService's resume branch decides, minus the database:
   * an unresumable record is no flow at all (null), a resumable one is a BOUND
   * first turn. Keeping the two decisions in one helper is the point — the live
   * bug was a resume that bound nothing and greeted anyway.
   */
  const resumeTurn = (
    record: GuidedSetupRecord | null,
    over: Partial<StudentSetupCtx> = {},
  ): StudentSetupCtx | null =>
    isResumableRecord(record)
      ? makeCtx({
          account: "clinic",
          studentId: SAM,
          gate: "none",
          basics: COMPLETE_BASICS,
          record,
          firstTurn: true,
          ...over,
        })
      : null;

  it("opens no flow at all for a finished or dismissed record", () => {
    expect(resumeTurn(parkedRecord({ completedAt: "2026-09-02T08:00:00.000Z" }))).toBeNull();
    expect(resumeTurn(parkedRecord({ dismissedAt: "2026-09-02T08:00:00.000Z" }))).toBeNull();
    expect(resumeTurn(null)).toBeNull();
  });

  it("resumes the student on the step they were parked at, not step 1", () => {
    const ctx = resumeTurn(parkedRecord())!;
    const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
    expect(ctx.studentId).toBe(SAM);
    expect(view.step).toBe("medical");
    expect(view.steps.find((s) => s.id === "medical")?.status).toBe("locked");
    expect(sectionFor(ctx)).toContain('step="2/5" blocked="consent" consent="none"');
  });

  it("renders the gate-aware FIRST TURN and the waiting block", () => {
    const text = sectionFor(resumeTurn(parkedRecord())!);
    expect(text).toContain("FIRST TURN");
    expect(text).toContain("Greet Dana by name");
    expect(text).toContain(`nothing more can be collected until ${GS.CONSENT} is active`);
    expect(text).toContain(GS.SIDE_PANEL);
    expect(text).toContain(`WAITING FOR ${GS.CONSENT}`);
    expect(text).toContain("- The flow is BLOCKED at this step. Do not ask for anything belonging to it.");
  });

  it("asks nothing that belongs to the locked step, and never for the roster", () => {
    const text = sectionFor(resumeTurn(parkedRecord())!);
    expect(text).not.toContain("first question");
    expect(text).not.toContain("step by step");
    // The live symptom: a resumed patient was greeted with a request for the
    // clinic's patient LIST, which is the unbound step-1 opening.
    expect(text).not.toContain("from a list they send");
    const rest = withoutUnlocksLine(text);
    for (const word of [GS.DIAGNOSIS, GS.MEDICATIONS, GS.ALERTS, GS.STEP_MEDICAL]) {
      expect(rest).not.toContain(word);
    }
    for (const word of ["diagnos", "medicat", "allerg", "seizure"]) {
      expect(rest.toLowerCase()).not.toContain(word);
    }
  });

  it("gives a resumed student with consent the ordinary workable first turn", () => {
    const text = sectionFor(resumeTurn(parkedRecord(), { gate: "active" })!);
    expect(text).not.toContain("blocked=");
    expect(text).not.toContain("nothing more can be collected");
    expect(text).toContain("guidedSetup(advance)");
  });
});

/**
 * The opening line said "for one STUDENT, one step at a time" on every account,
 * two lines above an instruction to ask a school for its whole roster. One of
 * the two had to give, and it is not the roster.
 */
describe("student_setup rules — the opening line", () => {
  it("is singular for a family and plural for an institution", () => {
    expect(sectionFor(makeCtx({ account: "family" }))).toContain(
      `${GS.FLOW} for one ${GS.CHILD}, one step at a time.`,
    );
    expect(sectionFor(makeCtx({ account: "school" }))).toContain(
      `${GS.FLOW} for their ${GS.STUDENT}S, one step at a time.`,
    );
    expect(sectionFor(makeCtx({ account: "clinic" }))).toContain(
      `${GS.FLOW} for their ${GS.PATIENT}S, one step at a time.`,
    );
    for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
      expect(sectionFor(makeCtx({ account }))).not.toContain("for one");
    }
  });
});

describe("student_setup basics checklist", () => {
  /**
   * Observed live: a clinic's step-1 rail showed the five personal-facts
   * items (name, birth date, gender, language, guardian) next to an empty
   * roster table, with no student even proposed yet. Before any student is in
   * scope for an institution account, the checklist should say so instead of
   * describing a person who does not exist yet.
   */
  it("shows a single roster item for an institution with no student in scope yet", () => {
    const view = resolveFlowView(studentSetupFlow, makeCtx({ account: "school" }), null);
    const items = studentSetupFlow.steps
      .find((s) => s.id === "basics")!
      .checklist(makeCtx({ account: "school" }));
    expect(items).toEqual([{ key: "roster", done: false }]);
    expect(view.step).toBe("basics");
  });

  it("switches to the five personal-facts items once a student is in this institute", () => {
    const ctx = makeCtx({
      account: "school",
      studentId: "s1",
      basics: { ...EMPTY_BASICS, inInstitute: true, name: "Noa", birthDate: "2018-01-01" },
    });
    const items = studentSetupFlow.steps.find((s) => s.id === "basics")!.checklist(ctx);
    expect(items.map((i) => i.key)).toEqual(["name", "birthDate", "gender", "language", "guardian"]);
  });

  it("keeps the personal-facts checklist for a family from the start", () => {
    const items = studentSetupFlow.steps.find((s) => s.id === "basics")!.checklist(makeCtx({ account: "family" }));
    expect(items.map((i) => i.key)).toEqual(["name", "birthDate", "gender", "language", "guardian"]);
  });
});

/**
 * THE RAY CAIRO SESSION (clinic, 2026-09-08), read off the dev-server log. The
 * whole conversation produced exactly five memory operations: one
 * `Context_Students add`, a `Student_Incidents` view, and then
 * `Student_CommunicationStyle` + `Student_CommunicationProfile` writes for a
 * patient whose CONSENT was still pending.
 *
 * Nothing threw. The add satisfied step 1 (`inInstitute && birthDate`), the
 * derived pointer moved to a consent-LOCKED step 2, and the waiting block's
 * closing invitation — "meanwhile you may … answer questions about what
 * happens next" — left the model with nothing to do but interview the user.
 * `requireConsentForMemoryWrite` guards the reports, the program and incidents;
 * it does NOT guard `Student_*` chat memory, so the writes went through.
 *
 * Three separate holes, pinned three ways below.
 */
describe("student_setup step 1 — completion is the identity facts, not just a birth date", () => {
  const basicsStep = () => studentSetupFlow.steps.find((s) => s.id === "basics")!;

  it("is NOT complete on the name and birth date one hasty add supplies", () => {
    expect(basicsStep().isComplete(makeCtx({ studentId: "s1", basics: PARTIAL_BASICS }))).toBe(false);
    expect(missingBasicsFacts(makeCtx({ basics: PARTIAL_BASICS }))).toEqual([
      "gender",
      GS.HOME_LANGUAGE,
    ]);
  });

  it("becomes complete once gender and the HOME LANGUAGE land", () => {
    const ctx = makeCtx({ studentId: "s1", basics: COMPLETE_BASICS });
    expect(missingBasicsFacts(ctx)).toEqual([]);
    expect(basicsStep().isComplete(ctx)).toBe(true);
  });

  it("names every missing fact, in checklist order, on an empty row", () => {
    const bare = { ...EMPTY_BASICS, inInstitute: true };
    expect(missingBasicsFacts(makeCtx({ basics: bare }))).toEqual([
      "name",
      GS.BIRTH_DATE,
      "gender",
      GS.HOME_LANGUAGE,
    ]);
    // A whitespace-only name is not a name.
    expect(
      missingBasicsFacts(makeCtx({ basics: { ...COMPLETE_BASICS, name: "   " } })),
    ).toEqual(["name"]);
  });

  /**
   * The GUARDIAN is the consent gate's business. A roster-created student has
   * no contact at all yet and must still be able to finish step 1 — otherwise
   * every imported row is stuck on step 1 forever.
   */
  it("is unaffected by the guardian, in either direction", () => {
    const without = makeCtx({ studentId: "s1", basics: COMPLETE_BASICS });
    const with_ = makeCtx({
      studentId: "s1",
      basics: { ...COMPLETE_BASICS, hasGuardian: true },
    });
    expect(basicsStep().isComplete(without)).toBe(true);
    expect(basicsStep().isComplete(with_)).toBe(true);

    const partialWithGuardian = makeCtx({
      studentId: "s1",
      basics: { ...PARTIAL_BASICS, hasGuardian: true },
    });
    expect(basicsStep().isComplete(partialWithGuardian)).toBe(false);
  });

  it("still requires the row to be linked to THIS institute", () => {
    const elsewhere = makeCtx({
      studentId: "s1",
      basics: { ...COMPLETE_BASICS, inInstitute: false },
    });
    expect(basicsStep().isComplete(elsewhere)).toBe(false);
  });

  it("holds the flow on step 1 instead of dropping it onto a locked step 2", () => {
    const ctx = makeCtx({ account: "clinic", studentId: "s1", gate: "none", basics: PARTIAL_BASICS });
    const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
    expect(view.step).toBe("basics");
    expect(sectionFor(ctx)).not.toContain(`WAITING FOR ${GS.CONSENT}`);
  });
});

describe("student_setup step 1 — the block names what is outstanding", () => {
  it("lists the specific missing items and says to ask for exactly those", () => {
    const text = sectionFor(makeCtx({ account: "clinic", studentId: "s1", basics: PARTIAL_BASICS }));
    expect(text).toContain(`STILL MISSING — ${GS.STEP_BASICS}`);
    expect(text).toContain(`This ${GS.PATIENT} is saved but incomplete: gender, ${GS.HOME_LANGUAGE}.`);
    expect(text).toContain("Ask for exactly those, one at a time");
    expect(text).toContain("Context_Students update");
  });

  it("offers the \"other\" gender escape hatch so the step cannot dead-end", () => {
    const text = sectionFor(makeCtx({ studentId: "s1", basics: PARTIAL_BASICS }));
    expect(text).toContain('If the user will not give a gender, save "other"');
    expect(text).toContain("Never guess it.");
  });

  it("drops the gender line once gender is known", () => {
    const text = sectionFor(
      makeCtx({ studentId: "s1", basics: { ...PARTIAL_BASICS, gender: "female" } }),
    );
    expect(text).toContain(`is saved but incomplete: ${GS.HOME_LANGUAGE}.`);
    expect(text).not.toContain('save "other"');
  });

  it("renders no STILL MISSING block before the row exists, or once it is complete", () => {
    expect(sectionFor(makeCtx())).not.toContain("STILL MISSING");
    expect(sectionFor(makeCtx({ account: "school" }))).not.toContain("STILL MISSING");
    // Complete → the flow has already moved off step 1.
    expect(sectionFor(makeCtx({ studentId: "s1", basics: COMPLETE_BASICS }))).not.toContain(
      "STILL MISSING",
    );
  });

  it("gives an institution the same block on top of the roster instructions", () => {
    const text = sectionFor(
      makeCtx({ account: "school", studentId: "s1", instituteHasStudents: true, basics: PARTIAL_BASICS }),
    );
    expect(text).toContain(`STEP 1 — ${GS.STEP_ROSTER}`);
    expect(text).toContain(`STILL MISSING — ${GS.STEP_BASICS}`);
  });
});

/**
 * THE PORTRAIT — the one step-1 job that is not a memory write.
 *
 * A face photo is what lets the AAC assistant tell who is in the room, and the
 * user asked for it to be said out loud: "the AI should tell the user to upload
 * a photo … by clicking the edit button next to their portrait, since this is
 * used to help identify them."
 *
 * Two properties are pinned, and the second is the load-bearing one. The line
 * must appear once the person EXISTS on every step-1 path (family and both
 * roster variants), and it must never read as an offer: the assistant cannot
 * set a portrait from a chat attachment — the 128-D descriptor that makes a
 * picture recognisable is computed in the browser by face-api.js and posted
 * with the image, and no tool or memory-schema field reaches that path.
 */
describe("student_setup step 1 — the PORTRAIT line", () => {
  const LINE =
    `- Tell them the edit button by the ${GS.PORTRAIT} in the ${GS.SIDE_PANEL} adds a photo; ` +
    `the ${GS.AAC_APP} uses it to recognise who is present.`;

  it("appears on the family block once the child exists", () => {
    const text = sectionFor(makeCtx({ studentId: "s1", basics: PARTIAL_BASICS }));
    expect(text).toContain(`${GS.PORTRAIT} — ${GS.CHILD}`);
    expect(text).toContain(LINE);
  });

  it("appears on both roster variants once the person exists", () => {
    for (const instituteHasStudents of [false, true]) {
      const text = sectionFor(
        makeCtx({ account: "clinic", studentId: "s1", instituteHasStudents, basics: PARTIAL_BASICS }),
      );
      expect(text).toContain(`STEP 1 — ${GS.STEP_ROSTER}`);
      expect(text).toContain(LINE);
    }
  });

  it("says nothing before there is a person to photograph", () => {
    expect(sectionFor(makeCtx())).not.toContain(GS.PORTRAIT);
    expect(sectionFor(makeCtx({ account: "school" }))).not.toContain(GS.PORTRAIT);
  });

  /**
   * It describes what the USER does. The assistant has no path to a portrait,
   * so a line the model could read as "send it to me" produces a promise the
   * system cannot keep.
   */
  it("never offers to do it itself", () => {
    const text = sectionFor(makeCtx({ studentId: "s1", basics: PARTIAL_BASICS }));
    for (const promise of ["I can add", "I will add", "upload it for you", "send me the photo"]) {
      expect(text).not.toContain(promise);
    }
  });
});

/**
 * The second half of the Mira Vance failure (clinic, 2026-09-08): the patient
 * was created and the very next sentence was "does Mira use any AAC?" — step
 * 4, behind the consent gate, with gender and the HOME LANGUAGE still missing.
 * Step 1 said what to collect and nothing about what was NOT yet on the table,
 * so a model that had satisfied the ask in front of it went looking for
 * another. Every step-1 block now carries the boundary.
 */
describe("student_setup step 1 — only step-1 facts may be asked for", () => {
  const ONLY =
    `- Ask only for these facts now. ${GS.STEP_MEDICAL}, ${GS.STEP_PROGRAM}, ${GS.STEP_AAC} and ` +
    `${GS.STEP_CONTACTS} come later, after ${GS.CONSENT}.`;

  it("carries the line on the family basics block", () => {
    expect(sectionFor(makeCtx())).toContain(ONLY);
  });

  it("carries it on both non-pending roster variants", () => {
    for (const account of ["school", "clinic"] as const) {
      expect(sectionFor(makeCtx({ account, instituteHasStudents: false }))).toContain(ONLY);
      expect(sectionFor(makeCtx({ account, instituteHasStudents: true }))).toContain(ONLY);
    }
  });

  it("carries it on the STILL MISSING block, which still names the outstanding items", () => {
    const text = sectionFor(makeCtx({ account: "clinic", studentId: "s1", basics: PARTIAL_BASICS }));
    expect(text).toContain(`STILL MISSING — ${GS.STEP_BASICS}`);
    expect(text).toContain(`This ${GS.PATIENT} is saved but incomplete: gender, ${GS.HOME_LANGUAGE}.`);
    expect(text).toContain("Ask for exactly those, one at a time");
    expect(text).toContain(ONLY);
  });

  /**
   * The pending-roster variant is deliberately exempt: while the review table
   * is open the block's whole job is "write nothing, talk about the rows", and
   * a sixth bullet about later steps would blunt it.
   */
  it("leaves the AWAITING CONFIRMATION variant alone", () => {
    const text = sectionFor(makeCtx({ account: "school", rosterPending: true }));
    expect(text).toContain(`STEP 1 — ${GS.STEP_ROSTER} (AWAITING CONFIRMATION)`);
    expect(text).not.toContain(ONLY);
  });

  it("stays inside the 130-character budget", () => {
    expect(ONLY.length).toBeLessThanOrEqual(MAX_LINE);
  });

  /**
   * docs/PROMPT_WRITING.md: 4-5 bullets is the guidance, 8 the maximum. The
   * extra line must not push a step-1 list past it.
   */
  it("keeps every step-1 list inside the 8-bullet maximum", () => {
    for (const account of ["family", "school", "clinic"] as const) {
      for (const hasStudents of [false, true]) {
        for (const basics of [EMPTY_BASICS, PARTIAL_BASICS]) {
          const lines = sectionFor(
            makeCtx({
              account,
              instituteHasStudents: hasStudents,
              ...(basics === PARTIAL_BASICS ? { studentId: "s1" } : {}),
              basics,
            }),
          ).split("\n");
          for (let i = 0; i < lines.length; i += 1) {
            if (!lines[i].startsWith("STEP 1") && !lines[i].startsWith("STILL MISSING")) continue;
            let bullets = 0;
            for (let j = i + 1; j < lines.length && lines[j].startsWith("- "); j += 1) bullets += 1;
            expect(bullets).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });
});

describe("student_setup — a blocked flow may not go information-gathering", () => {
  const blocked = (over: Partial<StudentSetupCtx> = {}) =>
    sectionFor(makeCtx({ account: "clinic", studentId: "s1", gate: "none", basics: COMPLETE_BASICS, ...over }));

  it("forbids the exact path the Ray Cairo session took", () => {
    const text = blocked();
    expect(text).toContain("communication profile or style");
    expect(text).toContain("notes");
    expect(text).toContain("interests");
    expect(text).toContain(`No Student_* memory writes.`);
  });

  it("still forbids ID numbers, health details and documents", () => {
    expect(blocked()).toContain(
      "- Never collect ID numbers, health details, documents, notes, interests, communication profile or style.",
    );
  });

  it("says nothing beyond step 1 may be RECORDED, not merely collected", () => {
    expect(blocked()).toContain(
      `- Nothing beyond ${GS.STEP_BASICS} may be collected or recorded for this ${GS.PATIENT} until ${GS.CONSENT} is active.`,
    );
  });

  it("closes with a bounded allowance instead of an open invitation", () => {
    const text = blocked();
    expect(text).toContain(
      `You may only finish step 1 facts, explain ${GS.CONSENT} and answer questions.`,
    );
    // The old line that produced the interview.
    expect(text).not.toContain("answer questions about what happens next");
    expect(text).not.toContain("Meanwhile you may correct step 1 facts");
  });

  /**
   * docs/PROMPT_WRITING.md: 4-5 bullets is the guidance, 8 the maximum. The
   * rewritten block explains as well as forbids, so it needs more than five —
   * but 8 is the wall, and the count must be honest: a bullet's wrapped
   * continuation (a line starting with two spaces) belongs to the bullet above
   * it, and the old loop stopped counting at the first one.
   */
  it("keeps the waiting block inside the 8-bullet maximum in every branch", () => {
    const worst: Array<[string, number]> = [];
    for (const account of ["family", "school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["none", "sign_required", "request_sent", "revoked"] as GuidedSetupGate[]) {
        for (const contact of [null, { id: "c1", name: "G", hasEmail: true, hasPhone: false }]) {
          const text = blocked({
            account,
            gate,
            basics: { ...COMPLETE_BASICS, hasGuardian: !!contact, consentContact: contact },
          });
          const lines = text.split("\n");
          const start = lines.findIndex((l) => l === `WAITING FOR ${GS.CONSENT}`);
          expect(start).toBeGreaterThanOrEqual(0);
          let bullets = 0;
          for (let i = start + 1; i < lines.length; i += 1) {
            if (lines[i].startsWith("- ")) bullets += 1;
            else if (!lines[i].startsWith("  ")) break;
          }
          worst.push([`${account}/${gate}/${contact ? "contact" : "none"}`, bullets]);
        }
      }
    }
    expect(worst.filter(([, n]) => n > 8)).toEqual([]);
    // …and the count is real: at least one branch is genuinely above five.
    expect(Math.max(...worst.map(([, n]) => n))).toBeGreaterThan(5);
  });
});

/**
 * WAITING FOR CONSENT, rewritten 2026-09-09 (user): "Flow from adding basic
 * student details to adding guardian contact and solving consent needs to be
 * more clear. Assume the user has no idea what they're doing and needs
 * everything clearly explained."
 *
 * The old block was one imperative — press this button — and it was wrong for
 * two of the five situations it covered: it sent EVERY family user to a "Sign
 * consent" button the rail renders only for `sign_required`/`revoked`, and it
 * told an institution with nobody on file to go and find the Contacts panel
 * rather than simply asking for the guardian in the conversation it was already
 * having.
 *
 * Each branch is pinned on the move it must NAME and the move it must NOT, so a
 * future reword cannot quietly hand one branch another's button.
 */
describe("student_setup WAITING FOR CONSENT — one branch per real situation", () => {
  const CONTACT = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Guardian",
    hasEmail: true,
    hasPhone: false,
  };

  const waiting = (over: Partial<StudentSetupCtx> = {}) =>
    sectionFor(makeCtx({ studentId: "s1", basics: COMPLETE_BASICS, gate: "none", ...over }));

  const withGuardian = (over: Partial<StudentSetupCtx> = {}) =>
    waiting({
      basics: { ...COMPLETE_BASICS, hasGuardian: true, consentContact: CONTACT },
      ...over,
    });

  /** The five situations `resolveGate` can actually produce, as fixtures. */
  const branches: Array<[string, Partial<StudentSetupCtx>]> = [
    ["family/sign_required", { account: "family", gate: "sign_required" }],
    ["family/revoked", { account: "family", gate: "revoked" }],
    ["family/none", { account: "family", gate: "none" }],
    ["institution/no-guardian", { account: "clinic", gate: "none" }],
    [
      "institution/request_sent",
      {
        account: "school",
        gate: "request_sent",
        basics: { ...COMPLETE_BASICS, hasGuardian: true, consentContact: CONTACT },
      },
    ],
    [
      "institution/contactable",
      {
        account: "school",
        gate: "sign_required",
        basics: { ...COMPLETE_BASICS, hasGuardian: true, consentContact: CONTACT },
      },
    ],
  ];

  it("explains WHY the flow stopped in every branch, before naming any button", () => {
    for (const [label, over] of branches) {
      const text = waiting(over);
      const term = termForAccount(over.account ?? "family");
      expect(text).toContain(
        `- EXPLAIN first: a parent or ${GS.GUARDIAN} must approve in writing before anything about this ${term}'s`,
      );
      expect(text).toContain(
        `  health, ${GS.STEP_PROGRAM} or communication is recorded. Only the ${GS.STEP_BASICS} facts from step 1 are stored so far.`,
      );
      // The explanation comes first — a novice reading top-down meets the
      // reason before the instruction.
      const explain = text.indexOf("- EXPLAIN first:");
      const header = text.indexOf(`WAITING FOR ${GS.CONSENT}`);
      expect(`${label}: ${explain > header}`).toBe(`${label}: true`);
    }
  });

  it("says what CONSENT unlocks in every branch", () => {
    for (const [label, over] of branches) {
      expect(`${label}: ${waiting(over).includes(UNLOCKS_LINE)}`).toBe(`${label}: true`);
    }
  });

  /**
   * A family admin IS the guardian: they sign it themselves, in the panel. They
   * are never asked to add a guardian, and never shown the institution's send
   * button.
   */
  it("family + sign_required/revoked: press Sign consent, and no guardian to add", () => {
    for (const gate of ["sign_required", "revoked"] as GuidedSetupGate[]) {
      const text = waiting({ account: "family", gate });
      expect(text).toContain(
        `- Tell them THEY are the ${GS.GUARDIAN} here: press "Sign consent" in the ${GS.SIDE_PANEL} and complete the short form.`,
      );
      expect(text).not.toContain(GS.CONTACTS_PANEL);
      expect(text).not.toContain("Send consent request");
      expect(text).not.toContain("Student_Contacts add");
    }
  });

  /**
   * The failure case the old block could not see. A family student gets its
   * guardian contact auto-created (`autoCreateGuardianContactForFamilyAdmin`),
   * so `gate: "none"` means that write did not land — and the rail renders NO
   * Sign consent button until it does. Telling them to press it is telling them
   * to find something that is not on screen.
   */
  it("family + none: add yourself in the Contacts panel, do not press a button that is not there", () => {
    const text = waiting({ account: "family", gate: "none" });
    expect(text).toContain(
      `- They are not listed as the ${GS.GUARDIAN} yet. Tell them to add themselves in the ${GS.CONTACTS_PANEL}.`,
    );
    expect(text).toContain(
      `- The "Sign consent" button appears in the ${GS.SIDE_PANEL} once they are. Do not send them looking for it yet.`,
    );
    expect(text).not.toContain('press "Sign consent"');
    expect(text).not.toContain("Send consent request");
    expect(text).not.toContain("Student_Contacts add");
  });

  /**
   * An institution student created through the chat has no contacts at all, so
   * there is nothing to send a link TO. The one move that helps is to ask —
   * which is also the one place a `Student_*` write is permitted while the gate
   * is shut.
   */
  it("institution + no contactable guardian: ask for the guardian and save the contact", () => {
    for (const account of ["school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["none", "sign_required", "revoked"] as GuidedSetupGate[]) {
        const text = waiting({ account, gate });
        expect(text).toContain(
          `- ASK for the ${GS.GUARDIAN} now: their name, their ${GS.RELATIONSHIP}, and an email or phone. One at a time.`,
        );
        expect(text).toContain(
          '  Save: Student_Contacts add { name, relationship, role: "parent_guardian", contactEmail, contactPhone }.',
        );
        expect(text).toContain(
          `- Then tell them to press "Send consent request" in the ${GS.SIDE_PANEL}: it sends that ${GS.GUARDIAN} a link to sign.`,
        );
        // The rail has no Sign consent button for an institution at all.
        expect(text).not.toContain("Sign consent");
        expect(text).not.toContain("Send consent requests");
      }
    }
  });

  it("institution + a contactable guardian: send the link, never re-ask for the guardian", () => {
    const text = withGuardian({ account: "school", gate: "sign_required" });
    expect(text).toContain(
      `- Tell them to press "Send consent request" in the ${GS.SIDE_PANEL}: it sends that ${GS.GUARDIAN} a link to sign.`,
    );
    expect(text).not.toContain("Student_Contacts add");
    expect(text).not.toContain(`ASK for the ${GS.GUARDIAN} now`);
    expect(text).not.toContain("Sign consent");
    // The "if they ask, here is the call" line survives, institution-only.
    expect(text).toContain("guidedSetup(requestConsent");
  });

  it("institution + request_sent: we are waiting, and nobody is told to send again", () => {
    const text = withGuardian({ account: "clinic", gate: "request_sent" });
    expect(text).toContain(
      `- A ${GS.CONSENT} request is already pending with the ${GS.GUARDIAN}. Do not offer to send another.`,
    );
    expect(text).toContain(`  Say we are waiting; the ${GS.PATIENT} unlocks the moment it is signed.`);
    expect(text).not.toContain('press "Send consent request"');
    expect(text).not.toContain("Student_Contacts add");
    expect(text).not.toContain(`ASK for the ${GS.GUARDIAN} now`);
    // Nor the tool call itself. The rail withholds a resend here on purpose
    // (GATE_NEEDS_REQUEST: a second link is two live magic links for one
    // child), so "do not offer to send another" followed by the exact call to
    // send another was the prompt contradicting both itself and the button.
    expect(text).not.toContain("guidedSetup(requestConsent");
  });

  /**
   * THE CARVE-OUT, and the reason this suite exists at all.
   *
   * `Student_Contacts` IS a `Student_*` path, and the Ray Cairo session proved
   * nothing at the DB layer refuses a `Student_*` write for a consent-pending
   * student — `requireConsentForMemoryWrite` covers reports, program and
   * incidents only. So the guardian contact is the ONE exception, it is stated
   * as one, and it exists in exactly one branch. Any other branch that grows a
   * `Student_Contacts add` has re-opened the hole.
   */
  it("permits exactly one Student_* write, in exactly one branch, and says so", () => {
    const carveOut =
      `- The ONE exception is that ${GS.GUARDIAN} contact above: add it, and nothing else, ` +
      `while ${GS.CONSENT} is shut.`;
    const asking = waiting({ account: "clinic", gate: "none" });
    expect(asking).toContain("- No Student_* memory writes.");
    expect(asking).toContain(carveOut);

    for (const [label, over] of branches) {
      if (label === "institution/no-guardian") continue;
      const text = waiting(over);
      expect(`${label}: ${text.includes("Student_Contacts")}`).toBe(`${label}: false`);
      expect(`${label}: ${text.includes(carveOut)}`).toBe(`${label}: false`);
      expect(`${label}: ${text.includes("- No Student_* memory writes.")}`).toBe(`${label}: true`);
    }
  });

  it("keeps the blanket prohibitions in every branch", () => {
    for (const [label, over] of branches) {
      const text = waiting(over);
      const term = termForAccount(over.account ?? "family");
      for (const line of [
        `- Nothing beyond ${GS.STEP_BASICS} may be collected or recorded for this ${term} until ${GS.CONSENT} is active.`,
        "- Never collect ID numbers, health details, documents, notes, interests, communication profile or style.",
        `- No Student_* memory writes. You may only finish step 1 facts, explain ${GS.CONSENT} and answer questions.`,
      ]) {
        expect(`${label}: ${text.includes(line)}`).toBe(`${label}: true`);
      }
    }
  });

  it("keeps every branch inside the 130-character prompt budget", () => {
    const offenders: string[] = [];
    for (const [label, over] of branches) {
      for (const line of waiting(over).split("\n")) {
        if (line.length > MAX_LINE) offenders.push(`${label}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * "It also asked 'What would you like to do next?'" — the flow exists so the
 * assistant has a sequence to aim for. Handing the decision back to the user at
 * the end of a turn is the improvisation this whole feature is meant to remove.
 */
describe("student_setup rules — the flow drives the sequence", () => {
  const RULE =
    "- Never end a turn asking what to do next. Say what the next step is and continue. Skip only if asked.";

  const perStep: Array<[string, Partial<StudentSetupCtx>]> = [
    ["basics", {}],
    ["basics (row started)", { studentId: "s1", basics: PARTIAL_BASICS }],
    ["medical", { studentId: "s1", basics: COMPLETE_BASICS }],
    [
      "program",
      {
        studentId: "s1",
        basics: COMPLETE_BASICS,
        reports: { ...EMPTY_REPORTS, hasAnyReport: true },
      },
    ],
    [
      "aac",
      {
        studentId: "s1",
        basics: COMPLETE_BASICS,
        reports: { ...EMPTY_REPORTS, hasAnyReport: true },
        program: { exists: true, hasActiveProgram: true, activeGoalCount: 2, framework: "tala" },
      },
    ],
    ["contacts", THROUGH_AAC],
  ];

  it("carries the rule on every step, every account, locked or not", () => {
    const missing: string[] = [];
    for (const account of ["family", "school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["off", "none", "active", "request_sent"] as GuidedSetupGate[]) {
        for (const [label, stage] of perStep) {
          const text = sectionFor(makeCtx({ account, gate, ...stage }));
          if (!text.includes(RULE)) missing.push(`${account}/${gate}/${label}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves the skip rule intact while dropping it from the advance bullet", () => {
    const open = sectionFor(makeCtx({ studentId: "s1", basics: COMPLETE_BASICS, gate: "active" }));
    expect(open).toContain(`- When the step's checklist is done call ${GUIDED_SETUP_TOOL_NAME}(advance).`);
    expect(open).toContain("Skip only if asked.");
  });

  it("keeps the rule inside the 130-character budget", () => {
    expect(RULE.length).toBeLessThanOrEqual(MAX_LINE);
  });
});

describe("buildPromptAndTools — trailingSection", () => {
  const baseCtx = () => ({
    agent: { name: "t", corePrompt: "CORE", memoryFields: [], tools: {} },
    history: [],
    memoryValues: {},
    memoryState: { visible: [], page: {}, staticPromptMode: true },
    openedTopics: [],
    conversationSummary: "",
    replyType: "text" as const,
  });

  it("appends the section at the very END of the system prompt", () => {
    const section = sectionFor(makeCtx());
    const build = buildPromptAndTools({ ...baseCtx(), trailingSection: section });
    const full = build.instructions + "\n" + (build.endInstructions ?? "");
    expect(full.trimEnd().endsWith(section.trimEnd())).toBe(true);
    // Nothing else may declare a section after it.
    const tail = full.slice(full.indexOf(GUIDED_FLOW_SECTION_HEADER));
    expect(tail.match(/=== Section: /g)).toHaveLength(1);
  });

  it("adds nothing when no section is supplied", () => {
    const build = buildPromptAndTools(baseCtx());
    expect(build.endInstructions ?? "").not.toContain(GUIDED_FLOW_SECTION_HEADER);
  });

  /**
   * THE AI'S INSTRUCTIONS DO NOT TRAVEL THROUGH `memoryValues`.
   *
   * `Context_GuidedSetup` is a CLIENT channel — it carries the chat session's
   * flow signal to the rail and nothing else. The model's copy of the flow is
   * `trailingSection`, resolved and rendered separately. When the view
   * publication was cut back to a signal the obvious way to break the
   * assistant was to assume the two were one path, so both directions are
   * pinned: no key, full section; a key present, byte-identical prompt.
   */
  it("renders with no Context_GuidedSetup in memoryValues at all", () => {
    const section = sectionFor(makeCtx());
    const ctx = baseCtx();
    expect(Object.keys(ctx.memoryValues)).not.toContain(GUIDED_SETUP_CONTEXT_KEY);
    const build = buildPromptAndTools({ ...ctx, trailingSection: section, guidedSetupEnabled: true });
    const full = build.instructions + "\n" + (build.endInstructions ?? "");
    expect(full).toContain(GUIDED_FLOW_SECTION_HEADER);
    expect(full.trimEnd().endsWith(section.trimEnd())).toBe(true);
    expect(
      build.tools.some((t) => t.type === "function" && t.function.name === GUIDED_SETUP_TOOL_NAME),
    ).toBe(true);
  });

  it("is byte-identical whether or not the client's signal is in memoryValues", () => {
    const section = sectionFor(makeCtx());
    const without = buildPromptAndTools({ ...baseCtx(), trailingSection: section });
    const with_ = buildPromptAndTools({
      ...baseCtx(),
      memoryValues: {
        [GUIDED_SETUP_CONTEXT_KEY]: { active: true, instituteId: "i", studentId: null },
      },
      trailingSection: section,
    });
    expect(with_.instructions).toBe(without.instructions);
    expect(with_.endInstructions ?? "").toBe(without.endInstructions ?? "");
  });

  it("offers the guidedSetup tool only when the flow is enabled", () => {
    const off = buildPromptAndTools(baseCtx());
    expect(off.tools.some((t) => t.type === "function" && t.function.name === GUIDED_SETUP_TOOL_NAME)).toBe(false);
    const on = buildPromptAndTools({ ...baseCtx(), guidedSetupEnabled: true });
    expect(on.tools.some((t) => t.type === "function" && t.function.name === GUIDED_SETUP_TOOL_NAME)).toBe(true);
  });
});


/**
 * THE FIFTH STEP (user, 2026-09-08): "There should also be a fifth step, to add
 * student contacts."
 *
 * Three things can go wrong quietly here and each is pinned below:
 *  - the step lands in the wrong PLACE (the four existing ids must keep their
 *    positions, or every `n/N` in the prompt and every rail dot shifts);
 *  - the auto-created guardian silently COMPLETES it, so the step is skipped
 *    past without a question ever being asked — the family form path creates
 *    exactly that row, and it is not `autoAdded`;
 *  - it is not reachable from the tool or from REST because one of the two
 *    hand-kept skippable lists was not updated.
 */
describe("student_setup — CONTACTS is the fifth step", () => {
  const contactsStep = () => studentSetupFlow.steps.find((s) => s.id === "contacts")!;

  it("comes last, and leaves the first four exactly where they were", () => {
    expect(studentSetupFlow.steps.map((s) => s.id)).toEqual([
      "basics",
      "medical",
      "program",
      "aac",
      "contacts",
    ]);
    // The shared contract the client reads is the same order.
    expect([...GUIDED_SETUP_STEP_ORDER]).toEqual(studentSetupFlow.steps.map((s) => s.id));
  });

  it("shows the Contacts panel, and the rail can skip it like steps 2-4", () => {
    expect(contactsStep().panel).toBe("contacts");
    expect(GUIDED_SETUP_PANEL_BY_STEP.contacts).toBe("contacts");
    expect(contactsStep().skippable).toBe(true);
    // Both hand-kept skip lists (tool schema, REST zod) now read this one.
    expect([...GUIDED_SETUP_SKIPPABLE_STEPS]).toEqual(["medical", "program", "aac", "contacts"]);
  });

  it("makes every position n/5, and 5/5 on the contacts step itself", () => {
    const at = (over: Partial<StudentSetupCtx>) => {
      const ctx = makeCtx(over);
      return stepPosition(resolveFlowView(studentSetupFlow, ctx, ctx.record));
    };
    expect(at({})).toBe("1/5");
    expect(at({ studentId: "s1", basics: COMPLETE_BASICS })).toBe("2/5");
    expect(
      at({ studentId: "s1", basics: COMPLETE_BASICS, reports: { ...EMPTY_REPORTS, hasAnyReport: true } }),
    ).toBe("3/5");
    expect(at(THROUGH_PROGRAM)).toBe("4/5");
    expect(at(THROUGH_AAC)).toBe("5/5");
    expect(at({ ...THROUGH_AAC, contacts: { total: 1, peopleAdded: 1 } })).toBe("done");
  });

  /**
   * An unlicensed AAC hides step 4 entirely, so the fifth step becomes the
   * fourth VISIBLE one. `stepPosition` counts visible steps, and the rail draws
   * one dot per visible step — they must agree.
   */
  it("becomes 4/4 when the AAC step is hidden by the license", () => {
    const ctx = makeCtx({ ...THROUGH_PROGRAM, aacLicensed: false });
    const view = resolveFlowView(studentSetupFlow, ctx, ctx.record);
    expect(view.step).toBe("contacts");
    expect(stepPosition(view)).toBe("4/4");
  });

  it("is a single `people` checklist item, done only once a person was added", () => {
    expect(contactsStep().checklist(makeCtx())).toEqual([{ key: "people", done: false }]);
    expect(
      contactsStep().checklist(makeCtx({ contacts: { total: 1, peopleAdded: 1 } })),
    ).toEqual([{ key: "people", done: true }]);
  });

  /**
   * The completion rule, stated three ways because each is a different live
   * shape:
   *  - the family form path leaves ONE contact behind, the signed-in guardian
   *    linked to their own user account. `loadContactFacts` excludes it, so it
   *    arrives here as total 1 / peopleAdded 0;
   *  - the AAC Monitor's `autoAdded` guesses arrive the same way;
   *  - a person the user actually named is peopleAdded ≥ 1.
   */
  it("is NOT completed by the auto-created guardian or by auto-added rows alone", () => {
    expect(contactsStep().isComplete(makeCtx({ contacts: { total: 1, peopleAdded: 0 } }))).toBe(false);
    expect(contactsStep().isComplete(makeCtx({ contacts: { total: 3, peopleAdded: 0 } }))).toBe(false);
  });

  it("is completed by one real contact", () => {
    expect(contactsStep().isComplete(makeCtx({ contacts: { total: 2, peopleAdded: 1 } }))).toBe(true);
  });

  it("counts as finished when skipped, without any contact at all", () => {
    const ctx = makeCtx(THROUGH_AAC);
    const skipped = resolveFlowView(studentSetupFlow, ctx, {
      ...AAC_REVIEWED,
      skipped: ["contacts"],
    });
    expect(skipped.steps.find((s) => s.id === "contacts")?.status).toBe("skipped");
    expect(skipped.step).toBe("done");
  });

  it("sits behind the same consent gate as steps 2-4", () => {
    expect(contactsStep().canEnter(makeCtx({ gate: "off" })).ok).toBe(true);
    expect(contactsStep().canEnter(makeCtx({ gate: "active" })).ok).toBe(true);
    for (const gate of ["none", "sign_required", "request_sent", "revoked"] as GuidedSetupGate[]) {
      expect(contactsStep().canEnter(makeCtx({ gate }))).toEqual({
        ok: false,
        reason: "consentRequired",
      });
    }
  });

  it("renders the WAITING FOR CONSENT block, not the contacts one, while the gate is shut", () => {
    const text = sectionFor(makeCtx({ ...THROUGH_AAC, account: "clinic", gate: "none" }));
    expect(text).toContain(`WAITING FOR ${GS.CONSENT}`);
    expect(text).not.toContain(`STEP 5 — ${GS.STEP_CONTACTS}`);
  });

  it("tells step 1 that CONTACTS come later too", () => {
    const text = sectionFor(makeCtx());
    expect(text).toContain(
      `- Ask only for these facts now. ${GS.STEP_MEDICAL}, ${GS.STEP_PROGRAM}, ${GS.STEP_AAC} and ` +
        `${GS.STEP_CONTACTS} come later, after ${GS.CONSENT}.`,
    );
  });
});

describe("student_setup STEP 5 block — what it asks for", () => {
  const block = (over: Partial<StudentSetupCtx> = {}) =>
    sectionFor(makeCtx({ ...THROUGH_AAC, ...over }));

  it("asks who ELSE is in the person's life, one at a time, with the relationship", () => {
    const text = block();
    expect(text).toContain(`STEP 5 — ${GS.STEP_CONTACTS}`);
    expect(text).toContain(
      `- Ask who ELSE is in the ${GS.CHILD}'s life: family, teachers, therapists. One person per turn.`,
    );
    expect(text).toContain(`- Take a name and their ${GS.RELATIONSHIP}.`);
  });

  it("uses the account's own term", () => {
    expect(block({ account: "clinic" })).toContain(`in the ${GS.PATIENT}'s life`);
    expect(block({ account: "school" })).toContain(`in the ${GS.STUDENT}'s life`);
  });

  /**
   * The save line may only name fields `contacts-memory-schema.ts` actually
   * writes. `isLegalGuardian`, `callable` and the government-ID columns are
   * stripped from every AI write there, so asking for them would collect a
   * sensitive answer and then drop it.
   */
  it("names only AI-writable contact fields, and forbids the three that are not", () => {
    const text = block();
    expect(text).toContain(
      "- Save: Student_Contacts add { name, relationship, role, organization, contactEmail, contactPhone }.",
    );
    for (const field of ["isLegalGuardian", "callable", "governmentId"]) {
      expect(text).not.toContain(field);
    }
    expect(text).toContain(
      "- Never ask for an ID number, for legal guardianship, or for permission to call. Not set here.",
    );
  });

  /**
   * The photo line names the BUTTON and says what the photo is FOR.
   *
   * "Added later in the Contacts panel" told a caretaker neither where to click
   * nor why to bother, and the photo is what lets the assistant tell who is in
   * the room (user request). It must also stay a description of what the USER
   * does: the assistant cannot set a portrait from a chat attachment — the
   * descriptor that makes a picture recognisable is computed in the browser —
   * so a line that reads as an offer is a promise the system cannot keep.
   */
  it("points at the edit button by the PORTRAIT and says what the photo is for", () => {
    const text = block();
    expect(text).toContain(
      `- Photos and voices go in the ${GS.CONTACTS_PANEL}: the edit button by each ${GS.PORTRAIT}. ` +
        `The ${GS.AAC_APP} uses them to recognise people.`,
    );
    // Never an offer to do it itself.
    for (const promise of ["I can add", "I will add", "upload it for you", "send me the photo"]) {
      expect(text).not.toContain(promise);
    }
  });

  it("offers to skip and names the advance call", () => {
    const text = block();
    expect(text).toContain("Offer to skip.");
    expect(text).toContain(`${GUIDED_SETUP_TOOL_NAME}(advance)`);
  });

  it("keeps every line of the step-5 block inside the 130-character budget", () => {
    const offenders: string[] = [];
    for (const account of ["family", "school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["off", "active"] as GuidedSetupGate[]) {
        for (const line of block({ account, gate }).split("\n")) {
          if (line.length > MAX_LINE) offenders.push(`${account}/${gate}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * STEP 4, reordered (user, 2026-09-08): "The AAC Settings step is asking
 * questions one at a time, and isn't prioritizing them well. The first question
 * after asking if they use eyegaze or touch … should be about the personality
 * of the AI companion."
 *
 * The order IS the fix, so the order is what is pinned: input before
 * personality, personality before the name, everything else after. Asserting it
 * by string index rather than by "contains" is deliberate — a block that grew
 * every required phrase but in the old order would pass a contains-only suite
 * and reproduce the complaint exactly.
 */
describe("student_setup STEP 4 block — the question order", () => {
  const aacCtx = (over: Partial<StudentSetupCtx> = {}) => makeCtx({ ...THROUGH_PROGRAM, ...over });
  const block = (over: Partial<StudentSetupCtx> = {}) => sectionFor(aacCtx(over));

  it("sits on the AAC step for this fixture", () => {
    const ctx = aacCtx();
    expect(resolveFlowView(studentSetupFlow, ctx, ctx.record).step).toBe("aac");
  });

  it("numbers the five questions and tells the model to ask one per turn", () => {
    const text = block();
    expect(text).toContain("- Ask ONE numbered question per turn, in this order. Do not run ahead.");
    for (const n of ["1.", "2.", "3.", "4.", "5."]) {
      expect(text).toContain(`\n${n} `);
    }
  });

  it("puts the AAC-user question first and the INPUT METHOD second", () => {
    const text = block();
    const user = text.indexOf(`1. Will the ${GS.CHILD} use the ${GS.AAC_APP}?`);
    const input = text.indexOf("2. Touch or eyegaze?");
    expect(user).toBeGreaterThan(-1);
    expect(input).toBeGreaterThan(user);
    // The minimum needed for the app to be usable is named in full.
    expect(text).toContain("which provider, and how much rest space at the screen edge");
    expect(text).toContain(
      "   Save Context_AACSettings { selectionMethod, eyegazeEnabled, eyegazeProvider, restSpace }.",
    );
  });

  it("asks what the assistant is FOR right after the input method, before anything else", () => {
    const text = block();
    const input = text.indexOf("2. Touch or eyegaze?");
    const purpose = text.indexOf("3. What is the assistant FOR:");
    const name = text.indexOf("4. A name for the assistant.");
    const settings = text.indexOf("5. How long the assistant's sentences should be");
    expect(purpose).toBeGreaterThan(input);
    expect(name).toBeGreaterThan(purpose);
    expect(settings).toBeGreaterThan(name);
  });

  /**
   * Item 5 NAMES ITS COLUMNS.
   *
   * The user asked: "Can the AI see AI name and Language level? I see it's
   * adding them as system prompt lines instead of those fields." Both ARE
   * writable properties of `Context_AACSettings` (`aiName`, `languageLevel` in
   * WRITABLE_COLUMNS), so the model could always have set them — it wrote
   * free-text rules because the block described the SUBJECT and never the
   * FIELD. Items 2 and 4 already named theirs; item 5 did not.
   */
  it("names languageLevel and the voice fields as Context_AACSettings writes", () => {
    const text = block();
    expect(text).toContain(
      "   Save Context_AACSettings { languageLevel, voiceType, studentVoiceType }.",
    );
    expect(text).toContain("Save Context_AACSettings { aiName }.");
    // There is no `language` column in aac_settings — the language itself is
    // step 1's HOME LANGUAGE on the student row, so item 5 must not ask for it
    // and teach a write that would be silently dropped.
    expect(text).not.toContain("5. Language and language level");
  });

  it("offers the three purposes with basic needs as the default", () => {
    expect(block()).toContain(
      "3. What is the assistant FOR: everyday needs (the default), teaching, or company and talk?",
    );
    expect(block()).toContain("Ask for any specific behaviours they want.");
  });

  it("records the answer as Context_AACPrompt rules and says it can be changed later", () => {
    const text = block();
    expect(text).toContain("Save each as one rule in Context_AACPrompt.");
    expect(text).toContain(
      "   Say in the same reply that they can change this any time by asking you here.",
    );
  });

  it("asks for a name and offers three from a FIXED list", () => {
    const text = block();
    expect(text).toContain("4. A name for the assistant. Offer three of these, or take their own:");
    expect(text).toContain(AI_NAME_SUGGESTION_LINE);
    expect(text).toContain("Save Context_AACSettings { aiName }.");
    expect(AI_NAME_SUGGESTIONS.length).toBe(10);
    // No duplicates, and every name is short enough for a child and a TTS voice.
    expect(new Set(AI_NAME_SUGGESTIONS).size).toBe(AI_NAME_SUGGESTIONS.length);
    for (const name of AI_NAME_SUGGESTIONS) expect(name.length).toBeLessThanOrEqual(5);
  });

  /**
   * The list must be a CONSTANT, not a per-render sample: a shuffled list would
   * change the bytes of a block that sits in the cached tail of every clinician
   * turn, turning cache reads into writes.
   */
  it("renders the same name list on every render", () => {
    expect(block()).toBe(block());
    expect(block().indexOf(AI_NAME_SUGGESTION_LINE)).toBe(
      sectionFor(aacCtx()).indexOf(AI_NAME_SUGGESTION_LINE),
    );
  });

  it("names only AAC settings the memory schema can write", () => {
    const text = block();
    for (const field of ["aiName", "languageLevel", "eyegazeEnabled", "eyegazeProvider", "selectionMethod", "restSpace"]) {
      // languageLevel is described in words rather than named; the rest are literal.
      if (field === "languageLevel") continue;
      expect(text).toContain(field);
    }
    // Not writable through manageMemory — naming them teaches a dropped write.
    for (const field of ["enabled:", "knownPeople", "appConfig", "gestures"]) {
      expect(text).not.toContain(field);
    }
  });

  it("keeps the diagnosis and medication prohibition", () => {
    expect(block()).toContain(
      `- Never put a ${GS.DIAGNOSIS} name or a ${GS.MEDICATIONS} name in those rules.`,
    );
  });

  it("still explains the device sign-in and ends on advance", () => {
    const text = block();
    const device = text.indexOf(`- Device: install the ${GS.AAC_APP}`);
    const advance = text.indexOf("- When all five are covered, call guidedSetup(advance).");
    expect(device).toBeGreaterThan(text.indexOf("5. Language and language level"));
    expect(advance).toBeGreaterThan(device);
  });

  it("mirrors the question order in the rail's checklist", () => {
    const items = studentSetupFlow.steps.find((s) => s.id === "aac")!.checklist(aacCtx());
    expect(items.map((i) => i.key)).toEqual(["aacUser", "input", "rules", "voice"]);
  });

  it("keeps every line of the step-4 block inside the 130-character budget", () => {
    const offenders: string[] = [];
    for (const account of ["family", "school", "clinic"] as GuidedSetupAccount[]) {
      for (const gate of ["off", "active"] as GuidedSetupGate[]) {
        for (const line of block({ account, gate }).split("\n")) {
          if (line.length > MAX_LINE) offenders.push(`${account}/${gate}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
