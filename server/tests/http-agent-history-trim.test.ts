// Verifies chunked history trimming in the HTTP agents (implicit-cache fix):
//   1. HttpObserverAgent: once HISTORY_CAP is exceeded, a whole TRIM_CHUNK is
//      dropped at once, so the request prefix stays byte-identical across the
//      following calls (a per-call slide would shift it every request,
//      permanently busting Gemini implicit prefix caching).
//   2. HttpSpeakerAgent: same chunked behavior, and a trim never leaves an
//      orphaned tool-ack message at the front of history (its assistant
//      tool-call message must survive with it).

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
} from "../services/providers/streaming-provider";

// ---- ESM module mocks — registered before the dynamic imports below ----
const completeChatCalls: ChatRequest[] = [];
const streamChatCalls: ChatRequest[] = [];
let speakerTurns: Array<{ text: string; emotes: number }> = [];
let speakerTurnIdx = 0;

const providerStub: ChatProvider = {
  completeChat: async (req: ChatRequest): Promise<ChatCompletionResult> => {
    completeChatCalls.push(req);
    return { content: null, toolCalls: [] };
  },
  streamChat: async function* (req: ChatRequest): AsyncGenerator<StreamChunk> {
    streamChatCalls.push(req);
    const turn = speakerTurns[speakerTurnIdx++] ?? { text: "reply", emotes: 0 };
    yield { type: "text_delta", text: turn.text };
    for (let i = 0; i < turn.emotes; i++) {
      yield { type: "tool_call_delta", index: i, name: "emote", arguments: JSON.stringify({ emotion: "happy" }) };
    }
    yield { type: "done", usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0 } };
  },
};

jest.unstable_mockModule("../services/providers/provider-factory", () => ({
  getChatProvider: () => providerStub,
}));
jest.unstable_mockModule("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: () => {},
  flowNote: () => {},
}));
jest.unstable_mockModule("../services/dual-agent/dual-agent-logger", () => ({
  runInSessionContext: (_s: string, _d: boolean, fn: () => unknown) => fn(),
  logLiveSession: () => {},
  logDualAgent: () => {},
  sessionContextStore: { getStore: () => undefined, run: (_v: unknown, fn: () => unknown) => fn() },
}));

// ---- Dynamic imports (after mocks) -------------------------------------
const { HttpObserverAgent } = await import("../services/dual-agent/http-observer-agent.js");
const { HttpSpeakerAgent } = await import("../services/dual-agent/http-speaker-agent.js");
type ObserverCallbacks = import("../services/dual-agent/observer-agent.js").ObserverCallbacks;
type SpeakerCallbacks = import("../services/dual-agent/speaker-agent.js").SpeakerCallbacks;

beforeEach(() => {
  completeChatCalls.length = 0;
  streamChatCalls.length = 0;
  speakerTurns = [];
  speakerTurnIdx = 0;
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("HttpObserverAgent history trimming", () => {
  it("trims a chunk at once so the request prefix stays stable between trims", async () => {
    const callbacks: ObserverCallbacks = {
      onEvent: () => {},
      onError: (e) => { throw e; },
    };
    const agent = new HttpObserverAgent("gemini", callbacks);
    await agent.start({ systemPrompt: "SYSTEM PROMPT", model: "gemini-2.5-flash", toolConfig: {}, useVertex: false });

    // Each turn adds 2 history messages (user + assistant summary). Cap is
    // 40, chunk is 12: turn 21 pushes history to 42 → trimmed to 28.
    for (let n = 1; n <= 23; n++) {
      agent.sendUserTurn(`[HEARD SPEECH] "turn ${n}"`);
      await agent.flush();
    }

    // Turn 21's request still carries the full 40-message history.
    expect(completeChatCalls[20].messages).toHaveLength(42); // system + 40 + user
    // Turn 22 runs right after the chunked trim: 28 retained messages.
    expect(completeChatCalls[21].messages).toHaveLength(30); // system + 28 + user
    // Prefix stability: the oldest retained message is identical across the
    // calls following a trim. (The old slice(-CAP) per call shifted it every
    // request once the cap was reached.)
    expect(completeChatCalls[22].messages[1]).toEqual(completeChatCalls[21].messages[1]);
  });
});

describe("HttpSpeakerAgent history trimming", () => {
  it("trims in chunks and never leaves a tool ack at the front of history", async () => {
    const callbacks: SpeakerCallbacks = {
      onEvent: () => {},
      onError: (e) => { throw e; },
    };
    const agent = new HttpSpeakerAgent("gemini", callbacks);
    await agent.start({
      systemPrompt: "system",
      model: "gemini-2.5-flash",
      toolConfig: { useDirectAudio: true, enabledApps: [], availableCustomApps: [], permittedWebsites: [] },
      useVertex: false,
      useDirectAudio: true,
    });

    // Alternate 1 and 2 emote side-calls per reply so turns persist 3 or 4
    // history messages (user, assistant+toolCalls, tool ack ×N) and the trim
    // boundary lands at varying alignments, including inside ack runs.
    const TURNS = 40;
    speakerTurns = Array.from({ length: TURNS }, (_, i) => ({
      text: `reply ${i + 1}`,
      emotes: (i % 2) + 1,
    }));
    for (let n = 1; n <= TURNS; n++) {
      agent.sendUserTurn(`user turn ${n}`);
      await tick();
    }

    expect(streamChatCalls).toHaveLength(TURNS);
    // No request may begin its history with an orphaned tool ack.
    for (const req of streamChatCalls) {
      expect(req.messages[0].role).toBe("system");
      expect(req.messages[1].role).not.toBe("tool");
      // Cap respected (with the current-turn user message on top).
      expect(req.messages.length).toBeLessThanOrEqual(62);
    }
    // Prefix stability: after the first trim, the oldest retained message
    // must stay identical across a run of consecutive requests. The old
    // trim-to-exactly-cap slid the front every request once at cap.
    const firsts = streamChatCalls.map((r) => JSON.stringify(r.messages[1]));
    const capReached = firsts.findIndex((_, i) => streamChatCalls[i].messages.length > 55);
    let longestRun = 1;
    let run = 1;
    for (let i = capReached + 1; i < firsts.length; i++) {
      run = firsts[i] === firsts[i - 1] ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeGreaterThanOrEqual(3);
  });
});
