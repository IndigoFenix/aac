// Verifies the HttpObserverAgent (economy Observer backend):
//   1. A heard-speech turn runs ONE completion and emits the transcript event.
//   2. set_observation_mode tool call → observation_mode_change event.
//   3. Context injections coalesce into the NEXT turn (and don't fire their own
//      completion).
//   4. A frame is sent as an image part THIS turn but is NOT persisted into
//      history (no base64 re-billing on later turns).
//   5. A turn with no tool calls produces no events (economy no-op).
//   6. Usage is reported via the onUsage callback; sendAudio is a no-op.

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
  usages: any[];
}> {
  const events: ObserverOutputEvent[] = [];
  const usages: any[] = [];
  const callbacks: ObserverCallbacks = {
    onEvent: (e) => events.push(e),
    onError: (e) => { throw e; },
    onUsage: (u) => usages.push(u),
  };
  const agent = new HttpObserverAgent("gemini", callbacks);
  await agent.start(startConfig());
  return { agent, events, usages };
}

beforeEach(() => {
  completeChatCalls.length = 0;
  responseQueue = [];
});

describe("HttpObserverAgent", () => {
  it("runs one completion for a heard-speech turn and emits the transcript", async () => {
    const { agent, events } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("transcript", { text: "are you hungry?", speaker: "Mom", target: "Sam", targetIsUser: true })],
      usage: { promptTokens: 100, completionTokens: 10 },
    }];

    agent.sendUserTurn(`[HEARD SPEECH] "are you hungry?"`);
    await agent.flush();

    expect(completeChatCalls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("transcribed");
    expect((events[0] as any).text).toBe("are you hungry?");
    const msgs = completeChatCalls[0].messages;
    expect(msgs[0]).toMatchObject({ role: "system", content: "SYSTEM PROMPT" });
    expect(JSON.stringify(msgs[msgs.length - 1])).toContain("are you hungry?");
  });

  it("parses set_observation_mode into an observation_mode_change event", async () => {
    const { agent, events } = await makeAgent();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("set_observation_mode", { mode: "live", reason: "she turned to the device" })],
    }];

    agent.sendUserTurn("[SCENE] she turns toward the screen");
    await agent.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("observation_mode_change");
    expect((events[0] as any).mode).toBe("live");
  });

  it("coalesces context injections into the next turn without firing their own completion", async () => {
    const { agent } = await makeAgent();
    responseQueue = [{ content: null, toolCalls: [] }];

    agent.sendContextInjection("[SCENE] calm room, Mom present");
    agent.sendContextInjection("[OWN_SPEECH] hello there");
    expect(completeChatCalls).toHaveLength(0); // context only buffers

    agent.sendUserTurn(`[HEARD SPEECH] "hi"`);
    await agent.flush();

    expect(completeChatCalls).toHaveLength(1);
    const lastMsg = JSON.stringify(completeChatCalls[0].messages.at(-1));
    expect(lastMsg).toContain("calm room");
    expect(lastMsg).toContain("OWN_SPEECH");
    expect(lastMsg).toContain("HEARD SPEECH");
    expect(lastMsg).toContain("hi");
  });

  it("sends a frame as an image part this turn but never persists base64 into history", async () => {
    const { agent } = await makeAgent();
    const fakeJpeg = "BASE64IMAGEDATA";
    responseQueue = [
      { content: null, toolCalls: [toolCall("update_context", { type: "new_object", key: "ball", description: "a red ball" })] },
      { content: null, toolCalls: [] },
    ];

    agent.sendFrame(fakeJpeg, "[FOCUS FRAME] look closely");
    await agent.flush();

    const firstUser = completeChatCalls[0].messages.at(-1)!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    expect(JSON.stringify(firstUser.content)).toContain(fakeJpeg);

    agent.sendUserTurn(`[HEARD SPEECH] "what is that"`);
    await agent.flush();
    const secondMsgs = completeChatCalls[1].messages;
    expect(JSON.stringify(secondMsgs)).not.toContain(fakeJpeg);
    expect(JSON.stringify(secondMsgs)).toContain("[image attached]");
  });

  it("produces no events and reports usage for an economy no-op turn", async () => {
    const { agent, events, usages } = await makeAgent();
    responseQueue = [{ content: null, toolCalls: [], usage: { promptTokens: 50, completionTokens: 2 } }];

    agent.sendUserTurn("[SCENE] nothing happening");
    await agent.flush();

    expect(events).toHaveLength(0);
    expect(usages).toEqual([{ promptTokens: 50, completionTokens: 2 }]);
  });

  it("is a no-op for sendAudio (audio reaches the economy Observer as text)", async () => {
    const { agent } = await makeAgent();
    agent.sendAudio("PCMDATA", "audio/pcm");
    await agent.flush();
    expect(completeChatCalls).toHaveLength(0);
  });
});
