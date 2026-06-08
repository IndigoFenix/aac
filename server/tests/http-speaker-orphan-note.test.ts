// Verifies the HttpSpeakerAgent's orphan-note rollover loop:
//   1. private_note(s) with no speech and no remain_silent → re-prompt
//      with the accumulated notes as system context
//   2. private_note + speech → real reply emits speech_end; the note is
//      NOT persisted in history (so it can't be echoed on later turns)
//   3. remain_silent terminates without re-prompting and without a
//      speech_end event
//   4. Re-prompt cap is honored

import type { ChatProvider, ChatRequest, StreamChunk, ChatCompletionResult } from "../services/providers/streaming-provider";

// ---- Mock the provider factory before requiring the agent --------------
const providerStub: { streamChat: (req: ChatRequest) => AsyncGenerator<StreamChunk> } = {
  streamChat: async function* () {
    // Overridden per-test.
    return;
  },
};

jest.mock("../services/providers/provider-factory", () => ({
  getChatProvider: () => providerStub as unknown as ChatProvider,
}));

// Suppress the agent-flow debug log to stdout during tests.
jest.mock("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: () => {},
  flowNote: () => {},
}));

// Required after the mocks are in place.
import { HttpSpeakerAgent } from "../services/dual-agent/http-speaker-agent";
import type { SpeakerCallbacks, SpeakerOutputEvent } from "../services/dual-agent/speaker-agent";

// ---- Helpers -----------------------------------------------------------

type Turn = {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
};

/** Push a sequence of completion-turns onto the provider stub. Each call
 *  to streamChat consumes one turn from the queue. */
function queueTurns(turns: Turn[]): void {
  let i = 0;
  providerStub.streamChat = async function* (_req: ChatRequest): AsyncGenerator<StreamChunk> {
    const turn = turns[i++] ?? { text: "" };
    if (turn.text) {
      yield { type: "text_delta", text: turn.text };
    }
    if (turn.toolCalls) {
      for (let idx = 0; idx < turn.toolCalls.length; idx++) {
        const c = turn.toolCalls[idx];
        yield {
          type: "tool_call_delta",
          index: idx,
          name: c.name,
          arguments: JSON.stringify(c.args),
        };
      }
    }
    yield {
      type: "done",
      usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 0 },
    };
  };
}

function makeAgent(): {
  agent: HttpSpeakerAgent;
  events: SpeakerOutputEvent[];
  errors: Error[];
} {
  const events: SpeakerOutputEvent[] = [];
  const errors: Error[] = [];
  const callbacks: SpeakerCallbacks = {
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  };
  const agent = new HttpSpeakerAgent("gemini", callbacks);
  return { agent, events, errors };
}

async function startedAgent() {
  const ctx = makeAgent();
  await ctx.agent.start({
    systemPrompt: "system",
    model: "gemini-2.5-flash",
    toolConfig: {
      useDirectAudio: true,
      enabledApps: [],
      availableCustomApps: [],
      permittedWebsites: [],
    },
    useVertex: false,
    useDirectAudio: true,
  });
  return ctx;
}

/** Tiny tick helper — the agent uses queueMicrotask to schedule the
 *  re-prompt, and tool-calls emit via callbacks during the async loop.
 *  setImmediate inside an awaited Promise drains both. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ---- Tests -------------------------------------------------------------

describe("HttpSpeakerAgent — orphan-note rollover", () => {
  test("orphan private_note re-prompts and then real reply finalizes", async () => {
    queueTurns([
      // Pass 1: only a private_note, no text, no remain_silent.
      { toolCalls: [{ name: "private_note", args: { note: "I should greet warmly" } }] },
      // Pass 2: real reply.
      { text: "Hello there!" },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("[BUTTON PRESS] hi");
    await flush();

    const noteEvents = events.filter((e) => e.type === "private_note");
    const speechEnds = events.filter((e) => e.type === "speech_end");

    expect(noteEvents).toHaveLength(1);
    expect(speechEnds).toHaveLength(1);
    if (speechEnds[0].type === "speech_end") {
      expect(speechEnds[0].transcript).toBe("Hello there!");
    }
  });

  test("remain_silent terminates cleanly with no speech_end", async () => {
    queueTurns([
      { toolCalls: [{ name: "remain_silent", args: { reason: "ambient noise" } }] },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("[AMBIENT] background chatter");
    await flush();

    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(0);
    expect(events.filter((e) => e.type === "remain_silent")).toHaveLength(1);
  });

  test("note + reply: speech_end emitted, note NOT persisted in history", async () => {
    queueTurns([
      // Pass 1: note alone — triggers re-prompt
      { toolCalls: [{ name: "private_note", args: { note: "first thought" } }] },
      // Pass 2: another note alone — triggers another re-prompt
      { toolCalls: [{ name: "private_note", args: { note: "second thought" } }] },
      // Pass 3: reply
      { text: "I am ready." },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("hi");
    await flush();

    const notes = events.filter((e) => e.type === "private_note");
    const speechEnds = events.filter((e) => e.type === "speech_end");
    expect(notes).toHaveLength(2);
    expect(speechEnds).toHaveLength(1);

    // The agent's history must not contain "private_note" tool calls —
    // those are dropped so the model can't echo them back.
    const history: any[] = (agent as any).history;
    const hasPrivateNoteInHistory = history.some(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc: any) => tc.name === "private_note"),
    );
    expect(hasPrivateNoteInHistory).toBe(false);
  });

  test("emote-only turn (no text, no remain_silent) re-prompts until reply", async () => {
    queueTurns([
      // Pass 1: emote alone — no text, no remain_silent → orphan
      { toolCalls: [{ name: "emote", args: { emotion: "happy" } }] },
      // Pass 2: real reply (no further emote — model heeded "don't repeat")
      { text: "Great to see you!" },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("[BUTTON PRESS] hi");
    await flush();

    // Emote DID fire (committed immediately so user sees it).
    const emoteEvents = events.filter((e) => e.type === "emote_change");
    expect(emoteEvents).toHaveLength(1);
    // And the reply followed via re-prompt.
    const speechEnds = events.filter((e) => e.type === "speech_end");
    expect(speechEnds).toHaveLength(1);
    if (speechEnds[0].type === "speech_end") {
      expect(speechEnds[0].transcript).toBe("Great to see you!");
    }
  });

  test("emote + reply on first pass does NOT re-prompt (normal happy path)", async () => {
    queueTurns([
      {
        text: "Hi there!",
        toolCalls: [{ name: "emote", args: { emotion: "happy" } }],
      },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("[BUTTON PRESS] hi");
    await flush();

    // Exactly one emote and one speech_end — no re-prompt fired.
    expect(events.filter((e) => e.type === "emote_change")).toHaveLength(1);
    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(1);
  });

  test("call_monitor-only orphan turn also re-prompts", async () => {
    queueTurns([
      { toolCalls: [{ name: "call_monitor", args: { reason: "checking in" } }] },
      { text: "I'm here, what's up?" },
    ]);

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("[BUTTON PRESS] hi");
    await flush();

    expect(events.filter((e) => e.type === "monitor_call_requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(1);
  });

  test("re-prompt cap halts the loop even if model never replies", async () => {
    // Always-note provider — every call returns just a private_note.
    let calls = 0;
    providerStub.streamChat = async function* (): AsyncGenerator<StreamChunk> {
      calls++;
      yield {
        type: "tool_call_delta",
        index: 0,
        name: "private_note",
        arguments: JSON.stringify({ note: `note ${calls}` }),
      };
      yield {
        type: "done",
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      };
    };

    const { agent, events } = await startedAgent();
    agent.sendUserTurn("hi");
    await flush();

    // 1 initial fire + MAX_NOTE_REPROMPTS (3) re-fires = 4 total
    expect(calls).toBe(4);
    expect(events.filter((e) => e.type === "speech_end")).toHaveLength(0);
    // Notes were buffered + emitted as PrivateNoteEvent for the log
    expect(events.filter((e) => e.type === "private_note")).toHaveLength(4);
  });

  // Regression test for the byte-identical-note bug observed in
  // agent-flow-debug.log:4980 — model emitted the same private_note text 4
  // times in a row during the orphan loop. Root cause: it had no record of
  // its own past notes in the API history. Fix: orphanLoopMessages buffer
  // injects a fake assistant tool_call + tool ack for each note onto the
  // messages array WITHOUT touching this.history.
  test("orphan loop appends fake private_note tool_call to next-pass API messages", async () => {
    const seenMessages: any[][] = [];
    let pass = 0;
    providerStub.streamChat = async function* (req: ChatRequest): AsyncGenerator<StreamChunk> {
      seenMessages.push(req.messages.slice());
      pass++;
      if (pass === 1) {
        // First pass: orphan note, no reply
        yield {
          type: "tool_call_delta",
          index: 0,
          name: "private_note",
          arguments: JSON.stringify({ note: "thinking" }),
        };
      } else {
        // Second pass: real reply
        yield { type: "text_delta", text: "Hello!" };
      }
      yield { type: "done", usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 } };
    };

    const { agent } = await startedAgent();
    agent.sendUserTurn("hi");
    await flush();

    expect(seenMessages.length).toBe(2);

    // Pass 1 should NOT yet have the fake note in messages (the model is
    // ABOUT to call private_note for the first time).
    const pass1HasFakeNote = seenMessages[0].some(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc: any) => tc.name === "private_note"),
    );
    expect(pass1HasFakeNote).toBe(false);

    // Pass 2 MUST include the fake note tool_call + its ack BEFORE the
    // re-prompt user message. Otherwise the model has no record of its
    // own past note and re-derives the same note from the user turn.
    const pass2 = seenMessages[1];
    const fakeNoteIdx = pass2.findIndex(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc: any) => tc.name === "private_note"),
    );
    expect(fakeNoteIdx).toBeGreaterThan(-1);

    // Tool ack follows immediately after.
    expect(pass2[fakeNoteIdx + 1]?.role).toBe("tool");

    // Re-prompt user message comes after the ack.
    const repromptIdx = pass2.findIndex(
      (m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[SYSTEM]"),
    );
    expect(repromptIdx).toBeGreaterThan(fakeNoteIdx);

    // The note's argument value matches the actual call from pass 1.
    const noteCall = (pass2[fakeNoteIdx] as any).toolCalls.find((tc: any) => tc.name === "private_note");
    expect(noteCall.arguments).toContain("thinking");

    // Sanity: the agent's `this.history` must NOT contain the note —
    // orphanLoopMessages is supposed to be ephemeral.
    const history: any[] = (agent as any).history;
    const noteInHistory = history.some(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc: any) => tc.name === "private_note"),
    );
    expect(noteInHistory).toBe(false);
  });

  // A real reply closes the orphan loop and clears orphanLoopMessages.
  // The next user turn must NOT carry stale fake-note entries into its
  // API messages.
  test("orphanLoopMessages clears after a successful reply", async () => {
    let pass = 0;
    const seenMessages: any[][] = [];
    providerStub.streamChat = async function* (req: ChatRequest): AsyncGenerator<StreamChunk> {
      seenMessages.push(req.messages.slice());
      pass++;
      if (pass === 1) {
        yield {
          type: "tool_call_delta",
          index: 0,
          name: "private_note",
          arguments: JSON.stringify({ note: "first thought" }),
        };
      } else if (pass === 2) {
        yield { type: "text_delta", text: "First reply." };
      } else {
        yield { type: "text_delta", text: "Second reply." };
      }
      yield { type: "done", usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 } };
    };

    const { agent } = await startedAgent();
    agent.sendUserTurn("first");
    await flush();
    agent.sendUserTurn("second");
    await flush();

    expect(seenMessages.length).toBe(3);

    // Pass 3 (after the second sendUserTurn) must NOT include the fake
    // note from the prior turn's orphan loop.
    const pass3 = seenMessages[2];
    const fakeNoteIdx = pass3.findIndex(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc: any) => tc.name === "private_note"),
    );
    expect(fakeNoteIdx).toBe(-1);

    // Pass 3 also shouldn't have any stale [SYSTEM] re-prompts.
    const stalePrompt = pass3.find(
      (m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[SYSTEM]"),
    );
    expect(stalePrompt).toBeUndefined();
  });
});
