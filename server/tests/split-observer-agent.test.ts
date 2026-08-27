// Verifies the vision-split Observer (split-observer-agent.ts): a Live
// Observer (stubbed) paired with a real HttpObserverAgent (mocked provider).
//   1. A frame reaches the vision pass ONLY — the Live primary never sees image bytes.
//   2. Vision-pass tool calls land on the shared event sink.
//   3. The first frame carries the vision role note; the Live half is told its
//      eyes are delegated once connected (and only once).
//   4. Heard speech drives the primary; the vision pass only buffers it as
//      context (no completion) and reads it with its next frame.
//   5. Context injections fan out; audio, audio clips and mic mute stay on the primary.
//   6. The vision pass never declares set_observation_mode.
//   7. History replay and close reach both halves; isConnected needs both.
//   8. Vision-pass usage bills through its own callback.

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
const { SplitObserverAgent, VISION_PASS_ROLE_NOTE, PRIMARY_EYES_DELEGATED_NOTE } =
  await import("../services/dual-agent/split-observer-agent.js");
type IObserverAgent = import("../services/dual-agent/observer-interface.js").IObserverAgent;
type ObserverCallbacks = import("../services/dual-agent/observer-agent.js").ObserverCallbacks;
type ObserverOutputEvent = import("../services/dual-agent/observer-agent.js").ObserverOutputEvent;
type ObserverStartConfig = import("../services/dual-agent/observer-agent.js").ObserverStartConfig;

const LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
const VISION_MODEL = "gemini-2.5-flash";

function toolCall(name: string, args: Record<string, unknown>) {
  return { name, arguments: JSON.stringify(args) };
}

function startConfig(): ObserverStartConfig {
  return {
    systemPrompt: "SYSTEM PROMPT",
    model: LIVE_MODEL,
    toolConfig: { economyModeEnabled: true },
    useVertex: false,
  };
}

/** A recording stand-in for the Live ObserverAgent. */
type Call = { method: string; args: unknown[] };
function stubPrimary(): IObserverAgent & { calls: Call[]; setConnected(v: boolean): void; startConfigs: ObserverStartConfig[] } {
  const calls: Call[] = [];
  const startConfigs: ObserverStartConfig[] = [];
  let connected = true;
  const rec = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); };
  return {
    calls,
    startConfigs,
    setConnected(v: boolean) { connected = v; },
    get isConnected() { return connected; },
    async start(config) { startConfigs.push(config); calls.push({ method: "start", args: [config] }); },
    async reconnectWithConfig(config) { calls.push({ method: "reconnectWithConfig", args: [config] }); },
    close: rec("close"),
    sendFrame: rec("sendFrame"),
    sendAudio: rec("sendAudio"),
    sendAudioClipTurn: rec("sendAudioClipTurn"),
    sendContextInjection: rec("sendContextInjection"),
    sendUserTurn: rec("sendUserTurn"),
    sendConversationHistory: rec("sendConversationHistory"),
    setMicMuted: rec("setMicMuted"),
    setDebugSessionContext: rec("setDebugSessionContext"),
  };
}

async function makeSplit() {
  const events: ObserverOutputEvent[] = [];
  const visionUsages: any[] = [];
  const visionCallbacks: ObserverCallbacks = {
    onEvent: (e) => events.push(e),
    onError: (e) => { throw e; },
    onUsage: (u) => visionUsages.push(u),
  };
  const primary = stubPrimary();
  const vision = new HttpObserverAgent("gemini", visionCallbacks);
  const split = new SplitObserverAgent(primary, vision, VISION_MODEL);
  await split.start(startConfig());
  return { split, primary, vision, events, visionUsages };
}

const of = (calls: Call[], method: string) => calls.filter((c) => c.method === method);
const lastUserText = (req: ChatRequest) => JSON.stringify(req.messages.at(-1));

beforeEach(() => {
  completeChatCalls.length = 0;
  responseQueue = [];
});

describe("SplitObserverAgent", () => {
  it("routes a frame to the vision pass only — the Live primary never receives image bytes", async () => {
    const { split, primary, vision } = await makeSplit();
    const jpeg = "BASE64FRAME";
    responseQueue = [{ content: null, toolCalls: [] }];

    split.sendFrame(jpeg, "[scene update] React if something here calls for action.");
    await vision.flush();

    expect(completeChatCalls).toHaveLength(1);
    expect(lastUserText(completeChatCalls[0])).toContain(jpeg);
    expect(completeChatCalls[0].model).toBe(VISION_MODEL);
    expect(of(primary.calls, "sendFrame")).toHaveLength(0);
    expect(JSON.stringify(primary.calls)).not.toContain(jpeg);
  });

  it("delivers vision-pass tool calls to the shared event sink", async () => {
    const { split, vision, events } = await makeSplit();
    responseQueue = [{
      content: null,
      toolCalls: [toolCall("update_context", { type: "new_person", key: "Mom", description: "Mom entered from the left" })],
    }];

    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("context_update");
    expect((events[0] as any).updateType).toBe("new_person");
  });

  it("states the vision role on the first frame only, and tells the Live half once it is connected", async () => {
    const { split, primary, vision } = await makeSplit();
    primary.setConnected(false); // Live setupComplete hasn't landed yet
    responseQueue = [{ content: null, toolCalls: [] }, { content: null, toolCalls: [] }, { content: null, toolCalls: [] }];

    split.sendFrame("F1", "[session start] read the room");
    await vision.flush();
    expect(lastUserText(completeChatCalls[0])).toContain(VISION_PASS_ROLE_NOTE);
    expect(lastUserText(completeChatCalls[0])).toContain("read the room");
    // Not connected → the note is held, not lost.
    expect(of(primary.calls, "sendContextInjection")).toHaveLength(0);

    primary.setConnected(true);
    split.sendFrame("F2", "[scene update]");
    split.sendFrame("F3", "[scene update]");
    await vision.flush();
    expect(lastUserText(completeChatCalls[1])).not.toContain(VISION_PASS_ROLE_NOTE);
    expect(lastUserText(completeChatCalls[2])).not.toContain(VISION_PASS_ROLE_NOTE);
    const notes = of(primary.calls, "sendContextInjection").map((c) => c.args[0]);
    expect(notes).toEqual([PRIMARY_EYES_DELEGATED_NOTE]);
  });

  it("drives the primary with heard speech and only informs the vision pass", async () => {
    const { split, primary, vision } = await makeSplit();
    const speech = `[HEARD SPEECH] Mom: "hold up the cup"`;

    split.sendUserTurn(speech);
    await vision.flush();
    expect(of(primary.calls, "sendUserTurn").map((c) => c.args[0])).toEqual([speech]);
    expect(completeChatCalls).toHaveLength(0); // context only buffers on the HTTP side

    responseQueue = [{ content: null, toolCalls: [] }];
    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();
    expect(completeChatCalls).toHaveLength(1);
    expect(lastUserText(completeChatCalls[0])).toContain("hold up the cup");
  });

  it("fans context out to both halves; audio, audio clips and mic mute stay on the primary", async () => {
    const { split, primary, vision } = await makeSplit();

    split.sendContextInjection("[SCENE] people:1 | Sam: facing camera");
    split.sendAudio("PCM", "audio/pcm;rate=16000");
    split.sendAudioClipTurn("CLIP", "audio/wav", "[AUDIO REQUESTED] re-hear");
    split.setMicMuted(true);
    await vision.flush();

    expect(of(primary.calls, "sendContextInjection").map((c) => c.args[0])).toEqual(["[SCENE] people:1 | Sam: facing camera"]);
    expect(of(primary.calls, "sendAudio")).toHaveLength(1);
    expect(of(primary.calls, "sendAudioClipTurn")).toHaveLength(1);
    expect(of(primary.calls, "setMicMuted").map((c) => c.args[0])).toEqual([true]);
    expect(completeChatCalls).toHaveLength(0); // nothing above generates on the vision side

    // …and the [SCENE] line rides into the vision pass's next frame turn.
    responseQueue = [{ content: null, toolCalls: [] }];
    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();
    expect(lastUserText(completeChatCalls[0])).toContain("facing camera");
    expect(lastUserText(completeChatCalls[0])).not.toContain("re-hear");
  });

  it("never declares set_observation_mode to the vision pass, even when the Live half has it", async () => {
    const { split, primary, vision } = await makeSplit();
    expect(primary.startConfigs[0].toolConfig.economyModeEnabled).toBe(true);
    responseQueue = [{ content: null, toolCalls: [] }];

    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();

    const names = (completeChatCalls[0].tools ?? []).map((t) => t.function.name);
    expect(names).toContain("update_context");
    expect(names).toContain("emergency_alarm");
    expect(names).not.toContain("set_observation_mode");
  });

  it("replays history and closes on both halves; isConnected requires both", async () => {
    const { split, primary, vision } = await makeSplit();
    const turns = [{ role: "user" as const, text: "[Mom to Sam] hi" }, { role: "model" as const, text: "transcript(hi)" }];

    split.sendConversationHistory(turns);
    expect(of(primary.calls, "sendConversationHistory")[0].args[0]).toEqual(turns);
    responseQueue = [{ content: null, toolCalls: [] }];
    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();
    expect(JSON.stringify(completeChatCalls[0].messages)).toContain("[Mom to Sam] hi");

    expect(split.isConnected).toBe(true);
    primary.setConnected(false);
    expect(split.isConnected).toBe(false);
    primary.setConnected(true);

    split.close();
    expect(of(primary.calls, "close")).toHaveLength(1);
    expect(vision.isConnected).toBe(false);
    expect(split.isConnected).toBe(false);
  });

  it("bills vision-pass usage through the vision callback", async () => {
    const { split, vision, visionUsages } = await makeSplit();
    responseQueue = [{ content: null, toolCalls: [], usage: { promptTokens: 12000, completionTokens: 40 } }];

    split.sendFrame("FRAME", "[scene update]");
    await vision.flush();

    expect(visionUsages).toEqual([{ promptTokens: 12000, completionTokens: 40 }]);
  });
});
