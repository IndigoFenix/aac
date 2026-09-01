/**
 * The invariant: a [HEARD SPEECH] turn NEVER ends in silence.
 *
 * The Observer is the only path by which spoken words reach the Speaker and
 * the Board Manager. When a speech turn ends with no tool call, the utterance
 * is gone and the flow log is indistinguishable from "nothing was said" —
 * session bccf9576 lost an entire bank-teller roleplay that way (six
 * high-confidence utterances, six turns that returned prose instead of
 * transcript(), so the matching pre-built board was never even considered).
 *
 * The guarantee has three parts, all covered here:
 *   1. `ignore_speech(reason)` exists as a universal sink, so forcing a call
 *      can never trap the model (the role `no_change` plays for BoardManager).
 *   2. The economy backend forces a call on speech turns and ONLY on speech
 *      turns — scene/frame turns stay AUTO so routine frames cost nothing.
 *   3. Whatever the outcome, it lands in the flow log with a reason: the
 *      ignore reason, or the prose the model emitted instead of calling.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
} from "../services/providers/streaming-provider";

// ---- ESM module mocks — registered before the dynamic imports below ----
const completeChatCalls: ChatRequest[] = [];
let responseQueue: ChatCompletionResult[] = [];
const flowNotes: string[] = [];
const flowTools: Array<{ name: string; args: string }> = [];

const providerStub: ChatProvider = {
  completeChat: async (req: ChatRequest): Promise<ChatCompletionResult> => {
    completeChatCalls.push(req);
    return responseQueue.shift() ?? { content: null, toolCalls: [] };
  },
  streamChat: async function* (): AsyncGenerator<StreamChunk> {
    return;
  },
};

jest.unstable_mockModule("../services/providers/provider-factory", () => ({
  getChatProvider: () => providerStub,
}));
jest.unstable_mockModule("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: (_agent: string, name: string, args: string) => { flowTools.push({ name, args }); },
  flowNote: (_agent: string, note: string) => { flowNotes.push(note); },
}));
jest.unstable_mockModule("../services/dual-agent/dual-agent-logger", () => ({
  runInSessionContext: (_s: string, _d: boolean, fn: () => unknown) => fn(),
  logLiveSession: () => {},
  logDualAgent: () => {},
  sessionContextStore: { getStore: () => undefined, run: (_v: unknown, fn: () => unknown) => fn() },
}));

// ---- Dynamic imports (after mocks) -------------------------------------
const { HttpObserverAgent } = await import("../services/dual-agent/http-observer-agent.js");
const { buildObserverToolDeclarations } = await import("../services/dual-agent/tool-declarations-observer.js");
const { parseToolCall } = await import("../services/dual-agent/observer-agent.js");
const { buildHeardSpeechTurn, isHeardSpeechTurn } = await import("../services/dual-agent/speech-text.js");
type ObserverCallbacks = import("../services/dual-agent/observer-agent.js").ObserverCallbacks;
type ObserverOutputEvent = import("../services/dual-agent/observer-agent.js").ObserverOutputEvent;
type ObserverStartConfig = import("../services/dual-agent/observer-agent.js").ObserverStartConfig;

function toolCall(name: string, args: Record<string, unknown>) {
  return { name, arguments: JSON.stringify(args) };
}

function startConfig(): ObserverStartConfig {
  return {
    systemPrompt: "SYSTEM PROMPT",
    model: "gemini-2.5-flash",
    toolConfig: {},
    useVertex: false,
  };
}

async function makeAgent(): Promise<{
  agent: InstanceType<typeof HttpObserverAgent>;
  events: ObserverOutputEvent[];
}> {
  const events: ObserverOutputEvent[] = [];
  const callbacks: ObserverCallbacks = {
    onEvent: (e) => events.push(e),
    onError: (e) => { throw e; },
    onUsage: () => {},
  };
  const agent = new HttpObserverAgent("gemini", callbacks);
  await agent.start(startConfig());
  return { agent, events };
}

/** A real speech turn, built by the same helper the Coordinator uses — so this
 *  suite fails if the [HEARD SPEECH] wording and the detector ever drift. */
const HEARD_HIGH = buildHeardSpeechTurn("Hi, welcome to the bank. How can I help you?", 0.88)!;
const HEARD_LOW = buildHeardSpeechTurn("mmhm sh", 0.2)!;

beforeEach(() => {
  completeChatCalls.length = 0;
  flowNotes.length = 0;
  flowTools.length = 0;
  responseQueue = [];
});

describe("ignore_speech — the sink that makes a forced call safe", () => {
  it("is declared alongside transcript, taking a reason string", () => {
    const decls = buildObserverToolDeclarations()[0]?.functionDeclarations ?? [];
    const names = decls.map((d) => d.name);
    expect(names).toContain("ignore_speech");
    expect(names).toContain("transcript");

    const schema = decls.find((d) => d.name === "ignore_speech")
      ?.parametersJsonSchema as Record<string, unknown>;
    expect(schema.required).toEqual(["reason"]);
    expect((schema.properties as Record<string, { type: string }>).reason.type).toBe("string");
  });

  it("scopes itself to a closed list of cases, and is marked terminal", () => {
    const decl = (buildObserverToolDeclarations()[0]?.functionDeclarations ?? [])
      .find((d) => d.name === "ignore_speech");
    expect(decl?.description).toMatch(/TERMINAL/);

    // "Closed list" is the whole point: this tool is the model's licence to drop
    // a child's words, so the description must ENUMERATE when that is allowed
    // rather than describe it. Match the enumeration, not one phrase of prose —
    // the wording has been rewritten once already and the phrasing is not what
    // matters here.
    const bullets = (decl?.description ?? "").split("\n").filter((l) => /^\s*-\s/.test(l));
    expect(bullets).toHaveLength(4);
    expect(decl?.description).toMatch(/in the following cases:/i);
    // Each case must be identifiable from context the Observer actually has,
    // so a reason can be checked rather than taken on trust.
    expect(bullets.join("\n")).toMatch(/BUTTON PRESS/);
    expect(bullets.join("\n")).toMatch(/\[AI to/);
    expect(bullets.join("\n")).toMatch(/confidence/i);
    expect(bullets.join("\n")).toMatch(/already transcribed/i);
  });

  it("parses to no routed event — it is terminal, not an observation", () => {
    const event = parseToolCall(
      { id: "", name: "ignore_speech", args: { reason: "device playing back a button press" } },
      Date.now(),
    );
    expect(event).toBeNull();
  });

  it("reaches the flow log with its reason when the model calls it", async () => {
    const { agent, events } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("ignore_speech", { reason: "AI playback from the room speakers" })],
    }];

    agent.sendUserTurn(HEARD_HIGH);
    await agent.flush();

    expect(events).toHaveLength(0); // nothing routed downstream
    expect(flowTools).toHaveLength(1);
    expect(flowTools[0].name).toBe("ignore_speech");
    expect(flowTools[0].args).toContain("AI playback");
    // Not a dropped turn — the decision was recorded, so no fault is logged.
    expect(flowNotes.join("\n")).not.toMatch(/SPEECH DROPPED/);
  });
});

describe("forced tool call on speech turns", () => {
  it("forces a call on a heard-speech turn", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("transcript", {
        text: "Hi, welcome to the bank. How can I help you?",
        speaker: "Shahaf", target: "Opher", targetIsUser: true,
      })],
    }];

    agent.sendUserTurn(HEARD_HIGH);
    await agent.flush();

    expect(completeChatCalls[0].toolChoice).toBe("required");
  });

  it("forces a call on LOW-confidence speech too — ignoring is a decision, not a default", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("ignore_speech", { reason: "recogniser misfire on room noise" })],
    }];

    agent.sendUserTurn(HEARD_LOW);
    await agent.flush();

    expect(completeChatCalls[0].toolChoice).toBe("required");
  });

  it("leaves scene turns on AUTO so a routine frame can still cost nothing", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{ content: null, toolCalls: [] }];

    agent.sendUserTurn("[SCENE] people:1 | Opher: looking left");
    await agent.flush();

    expect(completeChatCalls[0].toolChoice).toBe("auto");
  });

  it("leaves an image frame turn on AUTO", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{ content: null, toolCalls: [] }];

    agent.sendFrame("BASE64", "[scene update] React if something here calls for action.");
    await agent.flush();

    expect(completeChatCalls[0].toolChoice).toBe("auto");
  });

  it("routes the speech turn through when the model complies", async () => {
    const { agent, events } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("transcript", {
        text: "Hi, welcome to the bank. How can I help you?",
        speaker: "Shahaf", target: "Opher", targetIsUser: true,
      })],
    }];

    agent.sendUserTurn(HEARD_HIGH);
    await agent.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("transcribed");
    expect((events[0] as any).targetIsUser).toBe(true);
  });
});

describe("a silent turn is logged with its reason", () => {
  it("names a forced speech turn that produced nothing as a DROP, with the prose it emitted", async () => {
    const { agent } = await makeAgent();
    // The exact bccf9576 failure: prose instead of a tool call on real speech.
    responseQueue = [{
      content: "This sounds like the AI's own voice, so I will not transcribe it.",
      toolCalls: [],
      finishReason: "STOP",
    }];

    agent.sendUserTurn(HEARD_HIGH);
    await agent.flush();

    const note = flowNotes.join("\n");
    expect(note).toMatch(/SPEECH DROPPED/);
    expect(note).toContain("STOP");
    expect(note).toContain("This sounds like the AI's own voice");
  });

  it("carries the model's prose into an ordinary no-action note as well", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{
      content: "Nothing worth reporting in this frame.",
      toolCalls: [],
      finishReason: "STOP",
    }];

    agent.sendUserTurn("[SCENE] calm room");
    await agent.flush();

    const note = flowNotes.join("\n");
    expect(note).toMatch(/economy turn — no action/);
    expect(note).toContain("Nothing worth reporting");
    expect(note).not.toMatch(/SPEECH DROPPED/);
  });

  it("says so explicitly when the model returned neither a call nor any text", async () => {
    const { agent } = await makeAgent();
    // Observed in bccf9576: completion=0 tokens, no finishReason at all.
    responseQueue = [{ content: null, toolCalls: [] }];

    agent.sendUserTurn("[SCENE] calm room");
    await agent.flush();

    expect(flowNotes.join("\n")).toMatch(/returned no text either/);
  });
});

describe("speech-turn detection", () => {
  it("recognizes a turn built by buildHeardSpeechTurn, at any confidence", () => {
    expect(isHeardSpeechTurn(HEARD_HIGH)).toBe(true);
    expect(isHeardSpeechTurn(HEARD_LOW)).toBe(true);
  });

  it("still recognizes it once buffered context is prepended", () => {
    // sendUserTurn joins drained [SCENE]/[ENERGY] lines ahead of the tag.
    expect(isHeardSpeechTurn(`[SCENE] people:1\n[ENERGY 94%]\n${HEARD_HIGH}`)).toBe(true);
  });

  it("does not fire on scene, frame, or requested-audio turns", () => {
    expect(isHeardSpeechTurn("[SCENE] people:1 | Opher: looking left")).toBe(false);
    expect(isHeardSpeechTurn("[scene update] React if something here calls for action.")).toBe(false);
    expect(isHeardSpeechTurn("[REQUESTED AUDIO] You asked to hear this")).toBe(false);
  });
});
