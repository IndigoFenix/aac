/**
 * GUIDED SETUP end-to-end: a scripted LLM drives the REAL chat turn loop.
 *
 * server/tests/integration/guided-setup.test.ts pins the flow engine against
 * real rows and guided-setup-actions.test.ts pins the three host actions. Both
 * call the service DIRECTLY. Nothing pinned the wiring in between — and the
 * wiring is where this feature is fragile, because every one of these joints
 * fails SILENTLY:
 *
 *  - The guided block lives inside its OWN try/catch in getMessageManager: a
 *    throw in `resolveForChat` is a `console.warn` and the turn continues with
 *    no section, no `Context_GuidedSetup`, and no tool. The chat still answers,
 *    so the only symptom is a flow that quietly stops guiding. Asserting the
 *    view is present on EVERY turn is the only way to see that.
 *  - The section must be the LAST system section. It changes every turn (step,
 *    gate), so anywhere but the tail it invalidates the cached prefix and turns
 *    cache READS (0.1x) into WRITES (1.25x) on every clinician turn. That is
 *    pinned against `buildPromptAndTools` in guided-flow/prompt-section.test.ts;
 *    here it is pinned against what actually REACHES the provider, since the
 *    manager concatenates instructions + endInstructions itself
 *    (chat-handler.ts:955) and nothing else checks that seam.
 *  - THE DIAGNOSIS MUST NEVER ENTER THE GUIDED BLOCK. Step 4 asks the AI to
 *    write AAC prompt rules "from steps 2-3 in FUNCTIONAL wording". The facts
 *    the block is built from are booleans by construction (`StudentReportFacts`
 *    is hasAnyReport/hasDiagnosis/hasAlerts/hasMedications), and that is load-
 *    bearing: the moment someone "helpfully" passes the diagnosis text through
 *    so the model can write better rules, a condition name is pasted into a
 *    cached system prompt on every turn, and the rules it produces name the
 *    diagnosis instead of the behaviour. A sentinel diagnosis is written in
 *    step 2 and every later prompt is checked for it.
 *  - The kickoff message is HIDDEN, not absent. The client never renders it but
 *    the server must persist it with its metadata, or a resumed session replays
 *    a flow whose opening user turn has vanished from the log.
 *  - The student id crosses a turn boundary. Inside a turn `selectStudent` is a
 *    no-op on the non-streaming path and `chatState.guidedSetup.studentId` is
 *    not updated, so an `advance` in the SAME turn as the create would act on a
 *    null student. The real client re-sends with `studentId` on the NEXT turn;
 *    this suite does exactly that, so the null→value fill-in in
 *    getMessageManager stays covered.
 *  - THE SESSION'S FLOW STATE MUST REACH THE CLIENT, and it only does because
 *    the TOOL ROUTER publishes it. ChatMessageManager DEEP-CLONES the memory
 *    values it is handed (chat-handler.ts:222, `JSON.parse(JSON.stringify(...))`)
 *    and `onMessage` merges the manager's copy OVER the original, so anything
 *    written to the outer object mid-turn is silently discarded. That is why
 *    the `guidedSetup` case in tool-router.ts publishes through
 *    `memoryValuesRef.current` + `onUpdateMemoryValues`, exactly like every
 *    memory tool: that path reassigns `this.memoryValues`, so it survives the
 *    merge. Lose it and the symptom is not an error — it is a rail that never
 *    learns the turn ended, and a refusal the user never sees. Both are
 *    asserted here: the signal on EVERY turn, and the refusal on turn 2.
 *
 * WHAT RIDES THE TURN IS A `GuidedSetupSignal`, NOT THE VIEW. The rail fetches
 * the view from `GET /api/guided-setup/students/:id` and refetches when a turn
 * ends, so every DERIVED field (step, gate, parked, record) is asserted here
 * against the service — `serverStep` / `guided.resolveView`, which is literally
 * the function that endpoint calls. The signal carries only what a refetch
 * cannot reproduce: `active`, the bound `studentId`, the `panel` (which tracks
 * the step, so the per-turn progression is still visible on the wire) and the
 * turn-local `refused`.
 *
 * The consent gate is OFF here (family account, no consent collected) so the
 * flow is exercised end to end; the gate itself is pinned in guided-setup.test.ts.
 *
 * Nothing in this file may send a real email or SMS: the test environment
 * carries live SES credentials (memory: feedback_test_env_has_live_ses), so the
 * two senders are mocked at module scope before anything imports them. The
 * family flow with the gate off never reaches a sender — the mocks are there so
 * a future step that does cannot mail a stranger from a test run.
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, jest } from "@jest/globals";

const sendEmail = jest.fn(async () => ({ success: true, messageId: "test" }));
const sendSms = jest.fn(async () => ({ success: true }));

jest.unstable_mockModule("../../services/emailService", () => ({
  emailService: { sendEmail, isReady: () => true, verifyConnection: async () => true },
  EmailService: class {},
}));
jest.unstable_mockModule("../../services/smsService", () => ({
  smsService: { send: sendSms, sendOtp: sendSms, isConfigured: () => true },
}));

import { truncateAll, db } from "../helpers/db.js";
import {
  makeUser,
  makeInstitute,
  makeLicense,
  makeStudent,
  enrollStudent,
  licenseService,
} from "../helpers/factories.js";
import { installFakeLlm, uninstallFakeLlm, type FakeLlmHandles } from "../helpers/llm-mock.js";
import {
  aacSettings,
  goals,
  medicalRecords,
  programs,
  students,
  studentContacts,
  chatSessions,
} from "@shared/schema";
import type { ChatMessage } from "@shared/schema";
import {
  GUIDED_SETUP_DONE_PANEL,
  GUIDED_SETUP_KICKOFF,
  GUIDED_SETUP_PANEL_BY_STEP,
  type GuidedSetupStepId,
} from "@shared/guided-setup";
import { GUIDED_FLOW_SECTION_HEADER } from "../../services/guided-setup/flow-prompt-section.js";
import { eq } from "drizzle-orm";

type SessionModule = typeof import("../../services/sessionService.js");
type StateModule = typeof import("../../services/guided-setup/student-setup-state.js");
type ServiceModule = typeof import("../../services/guided-setup/student-setup-service.js");

let sessionService: SessionModule;
let state: StateModule;
let guided: ServiceModule;

beforeAll(async () => {
  // Dynamic, so the mocked senders are already registered: `jest.mock` is inert
  // under ESM (memory: feedback_jest_mock_inert_under_esm) and a statically
  // imported sessionService would drag the real SES client in with it.
  sessionService = await import("../../services/sessionService.js");
  state = await import("../../services/guided-setup/student-setup-state.js");
  guided = await import("../../services/guided-setup/student-setup-service.js");
});

const ENV_FLAG = "CONSENT_GATE_ENABLED";

/**
 * The diagnosis written in step 2. Distinctive on purpose: it must be findable
 * by substring anywhere in a system prompt, and it must never be a word the
 * guided block could legitimately contain for another reason.
 */
const DIAGNOSIS_SENTINEL = "Rett syndrome";

/** Distinctive enough to find the row the AI created without knowing its id. */
const STUDENT_FIRST_NAME = "Noa";
const STUDENT_LAST_NAME = "GuidedSetupE2E";

let llm: FakeLlmHandles;

// ---------------------------------------------------------------------------
// Scripting helpers
// ---------------------------------------------------------------------------

let callId = 0;
/**
 * How many responses have been scripted. The provider replays FIFO and THROWS
 * when a call arrives with nothing queued, so a short queue fails loudly — but
 * a queue that is never fully drained fails silently (a turn ended earlier than
 * the script expected). Counting both sides catches that direction too.
 */
let enqueued = 0;

/** One `function_call` item as the provider layer hands them to the router. */
function toolCall(name: string, args: Record<string, unknown>) {
  callId += 1;
  return {
    type: "function_call" as const,
    call_id: `call_${callId}`,
    name,
    arguments: JSON.stringify(args),
  };
}

/**
 * Queue one LLM response that makes tool calls. `updateConversation` recurses
 * after every tool round, so each of these consumes one queued response AND
 * causes another provider call — the queue must line up exactly or
 * FakeStructuredProvider throws.
 */
function enqueueTools(...calls: ReturnType<typeof toolCall>[]): void {
  enqueued += 1;
  llm.structured.enqueue({
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    content: null,
    toolCalls: calls,
    refused: false,
  });
}

/** Queue the response that ENDS a turn. `uponGPTResponse` JSON.parses it. */
function enqueueText(text: string): void {
  enqueued += 1;
  llm.structured.enqueue({
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    content: JSON.stringify({ text }),
    toolCalls: [],
    refused: false,
  });
}

/**
 * Queue the response for one history-compression summary (see
 * `isInternalUtilityCall`). Shaped like any other structured reply; only its
 * position in the FIFO queue matters.
 */
function enqueueSummary(): void {
  enqueueText("Earlier setup: basics, medical info, program and AAC were completed.");
}

/**
 * `manageMemory` is advertised to the model as a BATCH envelope
 * (memory-system.ts buildMemoryTool: top level MUST be `{ ops: [...] }`), and
 * tool-router passes the parsed arguments through verbatim. Getting this
 * wrapper wrong is a silent no-op, not an error.
 */
function memoryOps(...ops: Array<Record<string, unknown>>) {
  return toolCall("manageMemory", { ops });
}

// ---------------------------------------------------------------------------
// Prompt assertions
// ---------------------------------------------------------------------------

/**
 * What the provider actually received as the system prompt. The manager builds
 * it as `instructions + "\n" + endInstructions` (chat-handler.ts:955) and the
 * guided section is appended to endInstructions, so this is the only place the
 * two halves are visible together.
 */
function instructionsFor(callIndex: number): string {
  return String(llm.structured.calls[callIndex]?.instructions ?? "");
}

/**
 * A provider call the CHAT did not make: history compression.
 *
 * `ChatMessageManager.autoCompress` spends one structured call summarising the
 * oldest messages once the session's history passes `cullMessagesThreshold`,
 * and it does so on the SAME FIFO queue this script feeds. It is not a
 * conversational turn — it carries its own tiny system prompt and therefore no
 * guided section — so it must be both queued for (see `enqueueSummary`) and
 * excluded from the section check below. Told apart by SIZE: the clinician
 * system prompt is tens of thousands of characters, the utility one is a
 * sentence, so this can never mistake a real turn that lost its section for an
 * internal call.
 */
const CLINICIAN_PROMPT_MIN_CHARS = 5000;

function isInternalUtilityCall(index: number): boolean {
  return instructionsFor(index).length < CLINICIAN_PROMPT_MIN_CHARS;
}

/** The guided-setup block only: everything from its header to the end. */
function guidedBlock(instructions: string): string {
  const at = instructions.indexOf(GUIDED_FLOW_SECTION_HEADER);
  return at < 0 ? "" : instructions.slice(at);
}

/**
 * Every provider call made since `from` carried the guided section, and carried
 * it LAST. "Last" is checked the way prompt-section.test.ts checks it: slice
 * from the header and count section markers — exactly one may remain, its own.
 */
function expectGuidedSectionLastOnEveryCall(from: number, label: string): void {
  expect(llm.structured.calls.length).toBeGreaterThan(from);
  const missing: string[] = [];
  const notLast: string[] = [];
  for (let i = from; i < llm.structured.calls.length; i++) {
    if (isInternalUtilityCall(i)) continue;
    const tail = guidedBlock(instructionsFor(i));
    if (!tail) {
      missing.push(`${label} call ${i}`);
      continue;
    }
    // Exactly one marker may remain from the header onwards: its own.
    const markers = tail.match(/=== Section: /g) ?? [];
    if (markers.length !== 1) notLast.push(`${label} call ${i} (${markers.length} sections)`);
  }
  expect(missing).toEqual([]);
  expect(notLast).toEqual([]);
}

/**
 * The mirror image, for a turn AFTER the flow has finished.
 *
 * A completed flow must stop claiming the session: the tool call that finishes
 * it deactivates `chatState.guidedSetup`, and the stamped record then keeps
 * `hasUnfinishedRecord` from resuming it. Before that, the section rode one
 * extra turn — a finished flow still instructing the model to guide.
 */
function expectNoGuidedSectionOnAnyCall(from: number, label: string): void {
  expect(llm.structured.calls.length).toBeGreaterThan(from);
  const lingering: string[] = [];
  for (let i = from; i < llm.structured.calls.length; i++) {
    if (isInternalUtilityCall(i)) continue;
    if (guidedBlock(instructionsFor(i))) lingering.push(`${label} call ${i}`);
  }
  expect(lingering).toEqual([]);
}

// ---------------------------------------------------------------------------
// Flow-state readers
// ---------------------------------------------------------------------------

/**
 * The step the SERVICE derives from the rows right now. This is the flow's own
 * truth and it is what the next turn's prompt will be built from, so the
 * turn-by-turn progression is asserted against THIS rather than against
 * whatever survived the response merge (see the `contextData` note below).
 */
async function serverStep(
  userId: string,
  instituteId: string,
  studentId: string,
): Promise<string> {
  const { view } = await guided.resolveView({ userId, instituteId, studentId });
  return view.step;
}

/**
 * The last `guidedSetup` tool result the MODEL saw. Tool results are appended
 * to the session history, so this is literally the JSON handed back to the LLM
 * — the only place a refusal is observable, and the thing the AI is supposed to
 * read instead of retrying blindly.
 */
function lastGuidedToolView(turn: { chatState?: unknown }): Record<string, unknown> | null {
  const history = ((turn.chatState as { history?: ChatMessage[] })?.history ?? []) as ChatMessage[];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      if (parsed?.flow === "student_setup") return parsed;
    } catch {
      /* not a JSON tool result */
    }
  }
  return null;
}

function lastToolRefusal(turn: { chatState?: unknown }): unknown {
  return lastGuidedToolView(turn)?.refused ?? null;
}

/**
 * Every `guidedSetup` tool result the MODEL saw during one turn, in call order.
 * A turn can make several host-action calls (e.g. turn4's activateProgram
 * THEN advance) and only the LAST one survives onto `contextData.guidedsetup`
 * — a refusal on an earlier call would otherwise be invisible to a check that
 * only ever reads the final client view. Scanning full history is how we
 * catch "which action got refused" instead of just "the turn ended on the
 * wrong step".
 */
function guidedToolViewsInOrder(turn: { chatState?: unknown }): Record<string, unknown>[] {
  const history = ((turn.chatState as { history?: ChatMessage[] })?.history ?? []) as ChatMessage[];
  const views: Record<string, unknown>[] = [];
  for (const m of history) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      if (parsed?.flow === "student_setup") views.push(parsed);
    } catch {
      /* not a JSON tool result */
    }
  }
  return views;
}

/**
 * Assert one `guidedSetup` call's refusal reason (if any) is among the ones
 * that call is allowed to produce — usually `[null]` (must succeed outright),
 * but sometimes `[null, "someBenignReason"]`.
 *
 * `chatState.history` is the WHOLE session's history, not just this turn's,
 * so calls are addressed by `offsetFromEnd` (0 = the last `guidedSetup` tool
 * result anywhere in history so far, 1 = the one before it, …) rather than by
 * absolute index — that keeps this turn's checks blind to how many calls
 * earlier turns made.
 *
 * A failure names the turn AND the call, and prints the actual refusal
 * reason next to what was allowed — the exact information turn5's bare
 * "step=aac vs step=done" mismatch could not give us.
 */
function expectGuidedCallOutcome(
  turn: { chatState?: unknown },
  label: string,
  offsetFromEnd: number,
  allowedReasons: Array<string | null>,
): void {
  const all = guidedToolViewsInOrder(turn);
  const view = all[all.length - 1 - offsetFromEnd];
  expect(`${label}: guidedSetup call present`).toBe(
    view ? `${label}: guidedSetup call present` : `${label}: MISSING guidedSetup call`,
  );
  const reason = ((view?.refused as { reason?: string } | undefined)?.reason ?? null) as
    | string
    | null;
  const ok = allowedReasons.includes(reason);
  expect(`${label} refusal reason: ${JSON.stringify(reason)}`).toBe(
    ok
      ? `${label} refusal reason: ${JSON.stringify(reason)}`
      : `${label} refusal reason: one of ${JSON.stringify(allowedReasons)}`,
  );
}

/** The full view the client's own GET would return right now. */
async function serverView(
  userId: string,
  instituteId: string,
  studentId: string,
): Promise<Record<string, unknown>> {
  const { view } = await guided.resolveView({ userId, instituteId, studentId });
  return view as unknown as Record<string, unknown>;
}

/**
 * The signal the CLIENT receives on one turn: present at all, and naming the
 * panel of exactly the step this turn should have left the flow on.
 *
 * `expectedStep` is the POST-action step — what the last `guidedSetup` call of
 * the turn produced, not what the turn opened on. The signal does not carry
 * the step (the client refetches the view for that), but it carries the
 * step's PANEL, which is derived from it — so this is still the regression
 * guard for the publishing path described in the docblock: a signal that never
 * arrives, or one carrying the pre-action panel, fails here.
 */
function expectGuidedSignal(
  turn: { contextData?: Record<string, unknown> },
  label: string,
  expectedStep: GuidedSetupStepId | "done",
): Record<string, unknown> {
  const signal = turn.contextData?.guidedsetup as Record<string, unknown> | undefined;
  // Named so a missing signal says WHICH turn dropped it: the guided block is
  // wrapped in its own try/catch and would otherwise vanish without a sound.
  expect(`${label}: ${signal ? "has guided signal" : "NO Context_GuidedSetup"}`).toBe(
    `${label}: has guided signal`,
  );
  const expectedPanel =
    expectedStep === "done"
      ? GUIDED_SETUP_DONE_PANEL
      : GUIDED_SETUP_PANEL_BY_STEP[expectedStep];
  expect(`${label} panel=${String(signal!.panel)}`).toBe(`${label} panel=${expectedPanel}`);
  return signal!;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setupFamilyAccount() {
  const owner = await makeUser({ firstName: "Dana", lastName: "Cohen" });
  const { institute } = await makeInstitute(owner.id, { type: "family" });
  await makeLicense({
    instituteId: institute.id,
    permissions: { maxStudents: 5, aacEnabled: true, dashboardLevel: 1 },
  });
  return { owner, institute };
}

// ---------------------------------------------------------------------------

describe("Guided Setup — a scripted LLM walks the family flow end to end", () => {
  let original: string | undefined;

  beforeEach(async () => {
    // The gate is read at call time and the repo `.env` ships it ON; a family
    // account with no consent on file would be refused out of step 2.
    original = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
    callId = 0;
    enqueued = 0;
    llm = installFakeLlm();
    await truncateAll();
  });

  afterEach(async () => {
    uninstallFakeLlm();
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("walks basics → medical → program → aac → contacts → done, keeping the block last and the diagnosis out", async () => {
    const { owner, institute } = await setupFamilyAccount();
    /** The panel the CLIENT was handed on each turn, in order — the step's
     *  own panel, and the only step-shaped thing the signal carries. */
    const clientPanels: string[] = [];
    const base = {
      userId: owner.id,
      instituteId: institute.id,
      // Any non-AAC feature: `isAACFeature` must be false or the guided block
      // is skipped entirely (getMessageManager guards on it).
      activeFeature: "students" as const,
      replyType: "text" as const,
      language: "he",
    };

    // =====================================================================
    // TURN 1 — kickoff. No studentId yet; the AI creates the student.
    // =====================================================================
    let mark = llm.structured.calls.length;
    enqueueTools(
      memoryOps({
        action: "add",
        path: "/Context_Students",
        // `Context_Students` is a MAP, so `add` requires a key. The DB
        // generates the real id and the bridge aliases this placeholder to it.
        key: "new-child",
        value: {
          name: `${STUDENT_FIRST_NAME} ${STUDENT_LAST_NAME}`,
          firstName: STUDENT_FIRST_NAME,
          lastName: STUDENT_LAST_NAME,
          gender: "female",
          birthDate: "2018-04-02",
          country: "IL",
          primaryLanguage: "he",
          framework: "personal",
          instituteIds: [institute.id],
        },
      }),
    );
    // The id the model would echo here is only knowable AFTER the previous tool
    // round, and the queue is filled up front — but on the non-streaming path
    // `selectStudent` has no `onSelectStudent` callback and returns
    // {success:false} without reading the argument. It is scripted anyway
    // because a refusal reaching the model mid-flow must not derail the turn.
    enqueueTools(toolCall("selectStudent", { studentId: "assigned-by-the-client" }));
    enqueueText("יצרתי את הפרופיל.");

    const turn1 = await sessionService.onMessage({
      ...base,
      guidedSetup: { start: true },
      messages: [
        {
          role: "user",
          content: GUIDED_SETUP_KICKOFF,
          timestamp: Date.now(),
          metadata: { hidden: true },
        },
      ],
    });

    // onMessage swallows everything and answers `error:UNEXPECTED_ERROR`, so
    // assert the turn actually succeeded before assuming anything about it.
    expect(turn1.message.content).not.toBe("error:UNEXPECTED_ERROR");
    // No guidedSetup call this turn. The view resolved at the TOP of the turn
    // was step 1 unbound — but the flow no longer waits a turn to bind. The
    // server discovers the child it just created at the end of the memory
    // write and republishes, so what the client is handed already reflects a
    // complete step 1 and the pointer standing on medical.
    //
    // That is the fix for the Mira Vance failure (clinic, 2026-09-08): the
    // model never called `selectStudent`, the flow stayed unbound, and with no
    // student in the ctx nothing could tell it which identity facts were still
    // outstanding. Binding may not depend on the model making a UI call.
    const signal1 = expectGuidedSignal(turn1, "turn1", "medical");
    clientPanels.push(String(signal1.panel));
    // Bound on the CREATING turn, with no studentId on the request at all.
    // This is the whole reason the signal carries a studentId: the client has
    // no other way to learn who the flow attached itself to, and it is what
    // points its refetch at the right patient.
    expect(signal1.studentId).toBeTruthy();
    expect(signal1.active).toBe(true);
    expectGuidedSectionLastOnEveryCall(mark, "turn1");

    const sessionId = turn1.sessionId!;
    expect(sessionId).toBeTruthy();

    // The student really was created THROUGH manageMemory, with the birthDate
    // step 1 derives its completion from.
    const [student] = await db
      .select({ id: students.id, birthDate: students.birthDate })
      .from(students)
      .where(eq(students.firstName, STUDENT_FIRST_NAME));
    expect(student?.id).toBeTruthy();
    expect(student.birthDate).toBe("2018-04-02");

    // THE SETUP CONVERSATION BELONGS TO THE CHILD IT SET UP.
    //
    // The flow starts unbound and the client sends no `studentId` for it, so
    // this row was INSERTED with `studentId: null`. Binding the flow used to
    // write `chat_state.guidedSetup.studentId` and nothing else, so the whole
    // setup conversation stayed unattached and never appeared under the child's
    // chat history (user report). Binding now performs the same null→value
    // fill-in the subject rule describes, on the CREATING turn — before the
    // client has ever sent this student's id — which is why the assertion sits
    // here on turn 1 and not after turn 2's explicit selection.
    const [sessionAfterTurn1] = await db
      .select({ studentId: chatSessions.studentId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    expect(`turn1 chat_sessions.studentId: ${sessionAfterTurn1?.studentId ?? "null"}`).toBe(
      `turn1 chat_sessions.studentId: ${student.id}`,
    );

    // =====================================================================
    // TURN 2 — the client re-sends WITH the new studentId (what it does after
    // selectStudent). Step 1 is derived-complete, so the pointer sits on
    // medical and `advance` reports the step it cannot leave yet. The explicit
    // fill-in is still the preferred source and still has to work on its own.
    // =====================================================================
    mark = llm.structured.calls.length;
    enqueueTools(toolCall("guidedSetup", { action: "advance" }));
    enqueueText("נעבור למידע רפואי.");

    const turn2 = await sessionService.onMessage({
      ...base,
      sessionId,
      studentId: student.id,
      messages: [{ role: "user", content: "בואי נמשיך", timestamp: Date.now() }],
    });

    expect(turn2.message.content).not.toBe("error:UNEXPECTED_ERROR");
    const signal2 = expectGuidedSignal(turn2, "turn2", "medical");
    clientPanels.push(String(signal2.panel));
    expect(signal2.studentId).toBe(student.id);
    expectGuidedSectionLastOnEveryCall(mark, "turn2");

    // A REFUSAL MUST REACH BOTH AUDIENCES. Nothing has been collected for step
    // 2 yet, so `advance` is refused — the model reads it in the tool result to
    // know it must keep asking rather than retry blindly, and the rail renders
    // it to tell the user what is missing. The client half travels the
    // publishing path, so it is the direct guard on that regression.
    const refusal = { action: "advance", reason: "stepIncomplete" };
    expect(lastToolRefusal(turn2)).toEqual(refusal);
    // The rail's half. A refusal is produced by the tool action and persisted
    // NOWHERE, so it is the one thing a refetch could never bring back — this
    // is the direct guard on it still riding the turn that caused it.
    expect(signal2.refused).toEqual(refusal);

    // The step the client's own refetch will report is DERIVED from the rows,
    // not merely echoed back by the tool the model just called.
    expect(await serverStep(owner.id, institute.id, student.id)).toBe("medical");
    // The account facts the rail renders come from that same refetch.
    const view2 = await serverView(owner.id, institute.id, student.id);
    expect(view2.account).toBe("family");
    expect(view2.term).toBe("CHILD");

    // =====================================================================
    // TURN 3 — the medical record, then advance. `Context_Reports` is an object
    // with no studentId segment: the student comes from the session's base
    // context, which is exactly why turn 2 had to carry the id.
    // =====================================================================
    mark = llm.structured.calls.length;
    enqueueTools(
      memoryOps({
        action: "set",
        path: "/Context_Reports/medicalRecord",
        value: {
          primaryDiagnosis: DIAGNOSIS_SENTINEL,
          alertsSeizures: ["absence seizures, morning"],
          medications: ["Keppra 250mg"],
        },
      }),
    );
    enqueueTools(toolCall("guidedSetup", { action: "advance" }));
    enqueueText("רשמתי את המידע הרפואי.");

    const turn3 = await sessionService.onMessage({
      ...base,
      sessionId,
      studentId: student.id,
      messages: [{ role: "user", content: "יש לה אבחנה", timestamp: Date.now() }],
    });

    expect(turn3.message.content).not.toBe("error:UNEXPECTED_ERROR");
    clientPanels.push(String(expectGuidedSignal(turn3, "turn3", "program").panel));
    // The medical write already completed step 2, so the derived step is
    // "program" before `advance` even runs — `advance` then legitimately
    // refuses `programMissing` (nothing created yet) rather than silently
    // failing; that is not the same as an unexpected refusal like
    // `consentRequired` or `aacNotLicensed`.
    expectGuidedCallOutcome(turn3, "turn3 advance", 0, [null, "programMissing"]);
    expect(await serverStep(owner.id, institute.id, student.id)).toBe("program");
    expectGuidedSectionLastOnEveryCall(mark, "turn3");

    // Non-vacuity for the diagnosis guard below: the sentinel really did land
    // in the record, so "the prompt never contains it" is a fact about the
    // prompt and not about a write that silently failed.
    const [record] = await db
      .select({ primaryDiagnosis: medicalRecords.primaryDiagnosis })
      .from(medicalRecords)
      .where(eq(medicalRecords.studentId, student.id));
    expect(record?.primaryDiagnosis).toBe(DIAGNOSIS_SENTINEL);

    // =====================================================================
    // TURN 4 — a program, then a goal, then activateProgram, then advance.
    // Parent and child are deliberately in SEPARATE tool rounds: the goal's
    // `programId` is derived from the LOADED program value, so a goal added in
    // the same batch as the program has no parent to hang from.
    // =====================================================================
    mark = llm.structured.calls.length;
    enqueueTools(
      memoryOps({
        action: "set",
        path: "/Context_Program",
        value: {
          framework: "personal",
          title: "Communication program",
          status: "draft",
        },
      }),
    );
    enqueueTools(
      memoryOps(
        // `view` first so the program is loaded and its id is available as the
        // child context the nested `goals` map needs.
        { action: "view", path: "/Context_Program" },
        {
          action: "add",
          path: "/Context_Program/goals",
          key: "goal-1",
          value: {
            goalStatement: "Noa will request a break using her board",
            status: "draft",
          },
        },
      ),
    );
    // A program activated with DRAFT goals is invisible to the AAC, which is
    // why this is a host action and not four manageMemory writes.
    enqueueTools(toolCall("guidedSetup", { action: "activateProgram" }));
    enqueueTools(toolCall("guidedSetup", { action: "advance" }));
    enqueueText("התוכנית פעילה.");

    const turn4 = await sessionService.onMessage({
      ...base,
      sessionId,
      studentId: student.id,
      messages: [{ role: "user", content: "בואי נבנה תוכנית", timestamp: Date.now() }],
    });

    expect(turn4.message.content).not.toBe("error:UNEXPECTED_ERROR");
    clientPanels.push(String(expectGuidedSignal(turn4, "turn4", "aac").panel));
    // activateProgram AND advance both ran in this turn; only the LAST one
    // reaches contextData.guidedsetup, so check both individually. The host
    // action (activateProgram) must succeed outright. The trailing `advance`
    // is a different story: activating the program already completed step 3,
    // so `advance` is now evaluating step 4 (aac) — nothing has been done for
    // it yet, so a `stepIncomplete` refusal there is expected, not a bug.
    expectGuidedCallOutcome(turn4, "turn4 activateProgram", 1, [null]);
    expectGuidedCallOutcome(turn4, "turn4 advance", 0, [null, "stepIncomplete"]);
    expect(await serverStep(owner.id, institute.id, student.id)).toBe("aac");
    expectGuidedSectionLastOnEveryCall(mark, "turn4");

    const [program] = await db
      .select({ id: programs.id, status: programs.status })
      .from(programs)
      .where(eq(programs.studentId, student.id));
    expect(program?.status).toBe("active");
    const goalRows = await db
      .select({ status: goals.status })
      .from(goals)
      .where(eq(goals.programId, program.id));
    expect(goalRows).toHaveLength(1);
    expect(goalRows[0].status).toBe("active");

    // =====================================================================
    // TURN 5 — setAacUser, an AAC prompt rule, then advance off the AAC step.
    // `aac_settings.enabled` is deliberately NOT writable through manageMemory
    // (plan decision 6), so the host action is the only way in.
    // =====================================================================
    // `aacNotLicensed` is one of the two silent refusal reasons `setAacUser`
    // and `advance` can hit here — check the exact fact the host action reads
    // (`loadAacLicensed` -> `licenseService.getInstitutePermissions`) BEFORE
    // the turn runs, so a licensing regression can never masquerade as a
    // step-mismatch failure lower down.
    const permsBeforeTurn5 = await licenseService.getInstitutePermissions(institute.id, false);
    expect(`institute aacEnabled before turn5: ${JSON.stringify(permsBeforeTurn5.aacEnabled)}`).toBe(
      "institute aacEnabled before turn5: true",
    );

    mark = llm.structured.calls.length;
    enqueueTools(toolCall("guidedSetup", { action: "setAacUser", value: true }));
    enqueueTools(
      memoryOps({
        action: "add",
        // A LIST of bare strings — no key, no object wrapper.
        path: "/Context_AACPrompt",
        // FUNCTIONAL wording. The rule describes what to watch for and what to
        // do; it never names the condition. That is the shape step 4 asks for.
        value: "If she looks away and goes still for more than a minute, pause and offer a rest.",
      }),
    );
    enqueueTools(toolCall("guidedSetup", { action: "advance" }));
    // STEP 5 — CONTACTS. This walk SKIPS it, and the choice is deliberate.
    //
    // Adding a contact instead needs its own turn: a `Student_Contacts` write
    // is not visible to a `guidedSetup` call made LATER IN THE SAME TURN (its
    // row and its own tool result both land at the end of the turn, unlike the
    // `Context_*` writes in turns 3-4, which the very next tool call already
    // sees). A seventh turn pushes this session past
    // `cullMessagesThreshold`, at which point the manager spends a provider
    // call compressing history — off the SAME FIFO queue this script feeds,
    // which desynchronises every later turn. So the add path is pinned where
    // it costs nothing, against real rows, in guided-setup-actions.test.ts
    // ("step 5 completion reads real contact rows"), and what is pinned HERE
    // is the wiring: that the fifth step really is reached, refuses to close
    // itself while nobody has been added, and is skippable by the AI.
    enqueueTools(toolCall("guidedSetup", { action: "skip", step: "contacts" }));
    enqueueText("סיימנו את ההגדרה.");

    const turn5 = await sessionService.onMessage({
      ...base,
      sessionId,
      studentId: student.id,
      messages: [{ role: "user", content: "כן, היא משתמשת באפליקציה", timestamp: Date.now() }],
    });

    expect(turn5.message.content).not.toBe("error:UNEXPECTED_ERROR");
    // setAacUser AND advance both ran in this turn; check each host action's
    // own result before falling back to the step-level assertion below, so a
    // refusal on either one names itself instead of hiding behind
    // "turn5 step=aac" (the exact symptom the in-band sweep produced).
    // `setAacUser` must succeed outright. The trailing `advance` auto-stamps
    // `aacReviewedAt` (applyFlowAction, when aac.enabled is true) in the same
    // call that checks completeness — which finishes step 4 and immediately
    // starts evaluating step 5, CONTACTS, where nobody has been added yet. A
    // `stepIncomplete` there is the healthy outcome, not a bug: it is how the
    // model learns it has one more question to ask.
    expectGuidedCallOutcome(turn5, "turn5 setAacUser", 2, [null]);
    expectGuidedCallOutcome(turn5, "turn5 advance", 1, [null, "stepIncomplete"]);
    expectGuidedCallOutcome(turn5, "turn5 skip", 0, [null]);

    // The advance closed step 4 and landed the flow on the FIFTH step, which
    // then refused to close itself because nobody had been added. Read off the
    // tool results the model actually saw, in order, so the intermediate state
    // is evidence and not an inference from the final view.
    const turn5Views = guidedToolViewsInOrder(turn5);
    const afterAdvance = turn5Views[turn5Views.length - 2];
    const afterSkip = turn5Views[turn5Views.length - 1];
    expect(`turn5 advance landed on: ${String(afterAdvance?.step)}`).toBe(
      "turn5 advance landed on: contacts",
    );
    expect(`turn5 skip landed on: ${String(afterSkip?.step)}`).toBe("turn5 skip landed on: done");

    // THE TURN THAT FINISHES THE FLOW SAYS SO, ON THE SAME TURN.
    //
    // The view for this turn is published by the TOOL ACTION, not by the chat
    // resolution that ran before the model spoke — and the tool paths used to
    // build it with `toGuidedSetupView`'s default `active: true`, on a record
    // nobody had stamped. So the completing turn shipped
    // `{ step: "done", active: true, completedAt: undefined }` and the setup
    // header stayed up until the user pressed "finish later" (user report).
    // The client retires the rail on `step === "done" || record.completedAt`,
    // so both signals are checked, on the tool result the model saw AND on the
    // view the client received.
    expect(`turn5 skip active: ${JSON.stringify(afterSkip?.active)}`).toBe(
      "turn5 skip active: false",
    );
    const signal5 = expectGuidedSignal(turn5, "turn5", "done");
    expect(`turn5 signal active: ${JSON.stringify(signal5.active)}`).toBe(
      "turn5 signal active: false",
    );
    // The stamp is on the ROW, not just in a payload — this is the turn that
    // wrote it, one turn earlier than it used to be written, and it is what
    // the client's refetch reads back as `record.completedAt`.
    expect(typeof (await state.readRecord(student.id, institute.id))?.completedAt).toBe("string");
    const view5 = await serverView(owner.id, institute.id, student.id);
    expect(`turn5 refetched active: ${JSON.stringify(view5.active)}`).toBe(
      "turn5 refetched active: false",
    );
    expect(typeof (view5.record as { completedAt?: unknown } | null)?.completedAt).toBe("string");

    clientPanels.push(String(signal5.panel));
    // The last step really is finished — derived from the rows, the record and
    // the recorded skip, not from anything the model asserted about itself.
    expect(await serverStep(owner.id, institute.id, student.id)).toBe("done");
    expectGuidedSectionLastOnEveryCall(mark, "turn5");
    // The skip is PERSISTED, not merely reported. `coerceRecord` used to filter
    // the stored list against a hand-written set of three step ids, so a
    // `contacts` skip was written and then silently dropped on read — the view
    // said "done" and the very next turn reopened the step.
    expect((await state.readRecord(student.id, institute.id))?.skipped).toEqual(["contacts"]);

    const [settings] = await db
      .select({ enabled: aacSettings.enabled, prompt: aacSettings.chatAgentPrompt })
      .from(aacSettings)
      .where(eq(aacSettings.studentId, student.id));
    expect(`turn5 aac_settings.enabled: ${JSON.stringify(settings?.enabled ?? null)}`).toBe(
      "turn5 aac_settings.enabled: true",
    );
    expect(JSON.stringify(settings.prompt)).toContain("offer a rest");
    // The rule the AI wrote is functional, not a condition name — the same
    // property the prompt guard below protects, checked on the OUTPUT side.
    expect(JSON.stringify(settings.prompt)).not.toContain(DIAGNOSIS_SENTINEL);

    // =====================================================================
    // TURN 6 — the ordinary turn AFTER the flow finished. It must be an
    // ordinary turn: no section, no view, nothing claiming the session.
    //
    // This used to be the turn that stamped completion, because only
    // `resolveForChat` stamped and the tool action did not. Now the tool
    // action stamps and deactivates on the turn it finishes, so turn 6's job
    // is the opposite — to prove the flow let go.
    // =====================================================================
    mark = llm.structured.calls.length;
    // The session's history has now passed `cullMessagesThreshold`, so the
    // manager spends one provider call compressing it before this turn's reply.
    // Queued because the queue is FIFO and shared: leave it out and the
    // compression eats the reply below, and the turn finds an empty queue.
    enqueueSummary();
    enqueueText("בכיף, נדבר עוד.");

    const turn6 = await sessionService.onMessage({
      ...base,
      sessionId,
      studentId: student.id,
      messages: [{ role: "user", content: "תודה", timestamp: Date.now() }],
    });

    expect(turn6.message.content).not.toBe("error:UNEXPECTED_ERROR");
    // No view and no section. The session flow was deactivated by turn 5's
    // completing tool call, and the stamped record stops `hasUnfinishedRecord`
    // from resuming it — the two halves of "it let go", checked together
    // because either one alone would keep the block alive.
    expect(`turn6 guided signal: ${turn6.contextData?.guidedsetup ? "present" : "none"}`).toBe(
      "turn6 guided signal: none",
    );
    expectNoGuidedSectionOnAnyCall(mark, "turn6");

    // =====================================================================
    // The whole walk as the CLIENT saw it, in one line. Every step appears, in
    // order, on the turn that produced it — no lag, no skipped step, no step
    // repeated because a mid-turn view was dropped on the way out.
    // =====================================================================
    // By PANEL, which is derived from the step (GUIDED_SETUP_PANEL_BY_STEP) and
    // is what the signal carries. Turn 1 is the medical step's panel, not step
    // 1's: the whole of step 1 landed in that turn's single `add`, and the rail
    // no longer lags a turn behind the rows. Five entries, not six: turn 6
    // publishes nothing because the flow ended on turn 5, which is the point.
    expect(clientPanels).toEqual(["reports", "reports", "progress", "aacsettings", "students"]);

    const finalRecord = await state.readRecord(student.id, institute.id);
    expect(typeof finalRecord?.completedAt).toBe("string");
    expect(typeof finalRecord?.aacReviewedAt).toBe("string");

    // =====================================================================
    // THE REGRESSION GUARD — no rendered guided block, on any turn, ever
    // carried the diagnosis. Sliced from the section header on purpose: the
    // diagnosis may legitimately appear EARLIER in the prompt — the memory
    // dump is what a clinician's assistant is there to read. What must never
    // happen is it being folded into the volatile, every-turn, cached-tail
    // block that tells the model how to write step 4's rules.
    // =====================================================================
    expect(llm.structured.calls.length).toBeGreaterThan(10);
    const leaks = llm.structured.calls
      .map((_, i) => i)
      .filter((i) => guidedBlock(instructionsFor(i)).includes(DIAGNOSIS_SENTINEL));
    expect(leaks).toEqual([]);

    // =====================================================================
    // The hidden kickoff turn is PERSISTED, metadata intact.
    // =====================================================================
    const [row] = await db
      .select({ log: chatSessions.log, studentId: chatSessions.studentId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    // Still attached at the end of the walk. Six turns of state and log writes
    // go through `updateSession`, and the whole point of the fill-in is that it
    // survives them — a later `set` that carried the subject columns would put
    // the row back to null on the first turn the request omitted the student.
    expect(`final chat_sessions.studentId: ${row?.studentId ?? "null"}`).toBe(
      `final chat_sessions.studentId: ${student.id}`,
    );
    const log = (row?.log ?? []) as ChatMessage[];
    const kickoff = log.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content === GUIDED_SETUP_KICKOFF,
    );
    expect(kickoff).toBeTruthy();
    expect(kickoff?.metadata?.hidden).toBe(true);

    // Exactly one internal (non-conversational) provider call happened in the
    // whole walk, and it is the history compression queued in turn 6. If the
    // threshold ever moves, this says so instead of surfacing as an empty-queue
    // throw in whichever turn happens to follow it.
    const internalCalls = llm.structured.calls.map((_, i) => i).filter(isInternalUtilityCall);
    expect(`internal provider calls: ${internalCalls.length}`).toBe("internal provider calls: 1");

    // No tool call the model made anywhere in the walk came back an
    // `error:*` string (the generic tool-router failure shape) — cheap to
    // check here since the full log is already in hand.
    const toolErrors = log
      .filter((m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("error:"))
      .map((m) => m.content);
    expect(toolErrors).toEqual([]);

    // The whole queue was consumed — no turn silently stopped early, and no
    // scripted call went unused.
    expect(llm.structured.calls).toHaveLength(enqueued);
  }, 120_000);
});

/**
 * THE RAIL MUST NOT LAG BEHIND A PLAIN MEMORY WRITE.
 *
 * The rail refetches its view when a turn ends, so what this pins is the two
 * halves that make that refetch land on the right answer: the turn PUBLISHES A
 * SIGNAL (without one the client never invalidates, and a `staleTime: Infinity`
 * cache is stale forever), and the service resolves the NEW gate off the rows
 * the write just created.
 *
 * Neither is free. The refresh hook in getMessageManager's
 * `onUpdateMemoryValues` used to be installed only while the flow was UNBOUND —
 * so a bound flow's turn that wrote a fact and called no host action left the
 * rail a whole turn stale, and the only reason that was survivable is that the
 * model habitually calls `guidedSetup` after a write.
 *
 * Reproduced live (clinic, 2026-09-09): a patient at gate `none`, step 2
 * consent-locked, so the only legal move was `manageMemory` writing the
 * guardian. The write flipped the gate to `sign_required` — a direct GET said
 * so — while the rail still rendered "No guardian contact yet" and the
 * assistant's reply pointed at a "Send consent request" button the stale view
 * was not drawing. Only a page reload fixed it.
 *
 * The gate is ON here (the whole point) and the account is an institution, so
 * `sign_required` is reached the way a clinic reaches it. Nothing may send:
 * the guardian gets a CONTACT ROW, never a request.
 */
describe("Guided Setup — a memory write republishes the view on a BOUND flow", () => {
  let original: string | undefined;

  beforeEach(async () => {
    original = process.env[ENV_FLAG];
    process.env[ENV_FLAG] = "true";
    callId = 0;
    enqueued = 0;
    sendEmail.mockClear();
    sendSms.mockClear();
    llm = installFakeLlm();
    await truncateAll();
  });

  afterEach(async () => {
    uninstallFakeLlm();
    if (original === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = original;
    await truncateAll();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  /**
   * A clinic patient with step 1's facts on file and no guardian at all —
   * exactly the row the live failure sat on. `withRecord` decides whether a
   * guided flow exists to resume: without one, no flow is active on the turn
   * and nothing may resolve a view.
   */
  async function setupClinicPatient(opts: { withRecord: boolean }) {
    const owner = await makeUser({ firstName: "Yael", lastName: "Clinician" });
    const { institute } = await makeInstitute(owner.id, { type: "clinic" });
    await makeLicense({
      instituteId: institute.id,
      permissions: { maxStudents: 5, aacEnabled: true, dashboardLevel: 1 },
    });
    const { student } = await makeStudent(owner.id, {
      firstName: "Sam",
      lastName: "Nella",
      country: "IL",
      gender: "male",
      primaryLanguage: "he",
    });
    await enrollStudent(institute.id, student.id, owner.id);
    await db
      .update(students)
      .set({ birthDate: "2016-05-05" })
      .where(eq(students.id, student.id));
    if (opts.withRecord) {
      // A resumable record is what makes the NEXT turn's flow active AND
      // bound: `hasUnfinishedRecord` finds it and the request's studentId is
      // adopted, with no `guidedSetup` field on the request at all.
      await state.writeRecord(
        student.id,
        institute.id,
        state.newRecord({ userId: owner.id }),
      );
    }
    return { owner, institute, student };
  }

  /** The guardian write the assistant makes when the consent prompt asks for one. */
  function guardianOp() {
    return memoryOps({
      action: "add",
      path: "/Student_Contacts",
      key: "guardian",
      value: {
        name: "Dana Nella",
        relationship: "mother",
        role: "parent_guardian",
        contactEmail: "dana.nella@test.local",
      },
    });
  }

  it("a guardian written with manageMemory moves the published gate none → sign_required in the SAME turn", async () => {
    const { owner, institute, student } = await setupClinicPatient({ withRecord: true });
    const base = {
      userId: owner.id,
      instituteId: institute.id,
      activeFeature: "students" as const,
      replyType: "text" as const,
      language: "he",
    };

    // Non-vacuity: the flow really is standing at the closed gate with nobody
    // to sign, which is the state that renders "No guardian contact yet".
    const before = await guided.resolveView({
      userId: owner.id,
      instituteId: institute.id,
      studentId: student.id,
    });
    expect(before.view.gate).toBe("none");
    const beforeRow = (before.view.parked ?? []).find((p) => p.studentId === student.id);
    expect(beforeRow?.consentContactId ?? null).toBeNull();

    const mark = llm.structured.calls.length;
    // ONE memory write and a reply. No `guidedSetup` action anywhere in the
    // turn — that is the whole scenario: the tool router never runs, so the
    // refresh hook is the only thing that can republish.
    enqueueTools(guardianOp());
    enqueueText("שמרתי את פרטי האפוטרופוס.");

    const turn = await sessionService.onMessage({
      ...base,
      studentId: student.id,
      messages: [{ role: "user", content: "אמא שלו היא דנה", timestamp: Date.now() }],
    });

    expect(turn.message.content).not.toBe("error:UNEXPECTED_ERROR");

    // The write really landed — otherwise "the gate moved" would be a fact
    // about a view resolved over nothing.
    const [contact] = await db
      .select({ id: studentContacts.id, email: studentContacts.contactEmail })
      .from(studentContacts)
      .where(eq(studentContacts.studentId, student.id));
    expect(contact?.email).toBe("dana.nella@test.local");

    // HALF ONE: the turn told the client something happened. No signal, no
    // invalidation, and a `staleTime: Infinity` cache never asks again.
    const signal = turn.contextData?.guidedsetup as Record<string, unknown> | undefined;
    expect(`published signal: ${signal ? "present" : "MISSING"}`).toBe(
      "published signal: present",
    );
    expect(signal!.active).toBe(true);
    // The id the client's refetch is keyed on. A signal naming nobody sends the
    // rail to the wrong patient's view, or to none at all.
    expect(signal!.studentId).toBe(student.id);

    // HALF TWO: what that refetch now returns — `resolveView` is literally the
    // function GET /api/guided-setup/students/:id calls.
    //
    // THE REGRESSION. Before the fix this was still "none" with a null
    // contact id — the rail's "Add guardian contact" state — for the whole
    // turn that created the guardian.
    const view = await serverView(owner.id, institute.id, student.id);
    expect(view.flow).toBe("student_setup");
    expect(view.studentId).toBe(student.id);
    expect(`refetched gate: ${String(view.gate)}`).toBe("refetched gate: sign_required");
    // The contact id the "Send consent request" button needs. The rail reads
    // it off the BOUND student's own row in `parked` (GuidedSetupRail:
    // `boundParked`) — `consentContactId` lives nowhere else on the view — so
    // that is where a stale view shows up as a button with nothing to send.
    const parkedRows = (view.parked ?? []) as Array<Record<string, unknown>>;
    const boundRow = parkedRows.find((p) => p.studentId === student.id);
    expect(`bound parked row: ${boundRow ? "present" : "MISSING"}`).toBe(
      "bound parked row: present",
    );
    expect(`parked gate: ${String(boundRow!.gate)}`).toBe("parked gate: sign_required");
    expect(boundRow!.consentContactId).toBe(contact.id);
    expect(view.step).toBe(await serverStep(owner.id, institute.id, student.id));
    // The flow is still guiding, and its block is still last.
    expectGuidedSectionLastOnEveryCall(mark, "guardian turn");
    expect(llm.structured.calls).toHaveLength(enqueued);
  }, 60_000);

  it("no guided flow on the turn: the same write publishes no view and resolves nothing", async () => {
    const { owner, institute, student } = await setupClinicPatient({ withRecord: false });
    const base = {
      userId: owner.id,
      instituteId: institute.id,
      activeFeature: "students" as const,
      replyType: "text" as const,
      language: "he",
    };

    enqueueTools(guardianOp());
    enqueueText("שמרתי.");

    const turn = await sessionService.onMessage({
      ...base,
      studentId: student.id,
      messages: [{ role: "user", content: "אמא שלו היא דנה", timestamp: Date.now() }],
    });

    expect(turn.message.content).not.toBe("error:UNEXPECTED_ERROR");
    // The write still happened — this is an ordinary clinician turn.
    const [contact] = await db
      .select({ id: studentContacts.id })
      .from(studentContacts)
      .where(eq(studentContacts.studentId, student.id));
    expect(contact?.id).toBeTruthy();

    // No flow, so no signal…
    expect(`guided signal: ${turn.contextData?.guidedsetup ? "present" : "none"}`).toBe(
      "guided signal: none",
    );
    // …and no resolution AT ALL. `resolveForChat` creates the onboarding
    // record when a student has none, so a record appearing here would be the
    // fingerprint of a refresh that fired on a session with no wizard running
    // — the cost this hook must never impose on ordinary turns.
    expect(await state.readRecord(student.id, institute.id)).toBeNull();
    expect(llm.structured.calls).toHaveLength(enqueued);
  }, 60_000);
});
