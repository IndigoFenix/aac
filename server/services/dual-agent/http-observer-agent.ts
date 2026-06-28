// server/services/dual-agent/http-observer-agent.ts
//
// HTTP (completion-based) Observer backend — the cheap, "economy" half of the
// hybrid Observer. Where ObserverAgent keeps a native-audio Gemini Live session
// open and reacts continuously (responsive but ~3.3x the per-token cost and a
// constant idle keepalive drain), this one runs a stateless `gemini-2.5-flash`
// completion only when something actually happens — a heard-speech turn, a
// scene/escalation frame, a requested audio clip. Between events it costs
// nothing.
//
// It implements the SAME IObserverAgent surface as the Live agent, so the
// Coordinator can swap between them at runtime (Observer's set_observation_mode
// tool, or a forced downgrade to economy at low energy) without changing any
// call site.
//
// Cost discipline (the whole point of this backend):
//   - Frames / audio clips are sent to the model ONLY in the turn they arrive.
//     They are NEVER persisted into the running history — re-sending a base64
//     blob on every subsequent turn would re-bill it each time and defeat the
//     purpose. History keeps a short TEXT placeholder instead.
//   - Context injections ([SCENE], [OWN_SPEECH], [ENERGY], echoes) don't fire a
//     completion; they buffer and ride along with the next real turn.
//   - Turns are serialized so the running history stays consistent.

import type { FunctionDeclaration } from "@google/genai";
import type { LLMProviderKey } from "@shared/llm-options";
import { getChatProvider } from "../providers/provider-factory";
import type {
  ChatProvider,
  ChatTool,
  ChatMessage as ProviderChatMessage,
} from "../providers/streaming-provider";
import type { ToolCall } from "./live-provider";
import {
  parseToolCall,
  type ObserverCallbacks,
  type ObserverOutputEvent,
  type ObserverStartConfig,
} from "./observer-agent";
import { buildObserverToolDeclarations } from "./prompts/observer";
import type { IObserverAgent } from "./observer-interface";
import { flowInput, flowTool, flowNote, type FlowAgent } from "./agent-flow-logger";
import { runInSessionContext } from "./dual-agent-logger";

/** Convert one Gemini-format FunctionDeclaration into the provider-agnostic
 *  ChatTool shape used by the HTTP chat providers. Mirrors the Board Manager's
 *  toChatTool so the economy Observer declares the exact same tools as Live. */
function toChatTool(decl: FunctionDeclaration): ChatTool {
  return {
    type: "function",
    function: {
      name: decl.name!,
      description: decl.description,
      parameters: (decl.parametersJsonSchema as Record<string, any>) ?? { type: "object", properties: {} },
    },
  };
}

/** A multimodal content part understood by the Gemini chat provider
 *  (OpenAI-style; translated to inlineData in gemini-chat.buildRequest). */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export class HttpObserverAgent implements IObserverAgent {
  private readonly provider: ChatProvider;
  private readonly callbacks: ObserverCallbacks;

  private config: ObserverStartConfig | null = null;
  private tools: ChatTool[] = [];
  /** Running text-only conversation history (alternating user/model). Frames
   *  and audio are summarized to text here, never their raw bytes. */
  private history: ProviderChatMessage[] = [];
  /** Context-injection lines awaiting the next real turn. */
  private pendingContext: string[] = [];
  private connected = false;

  /** Serializes turns so history stays consistent under overlapping events. */
  private turnQueue: Promise<void> = Promise.resolve();
  private inFlight: AbortController | null = null;

  private sessionId = "?";
  private debugMode = false;
  private agentLabel: FlowAgent = "OBSERVER";

  /** Keep history bounded so a long session's context (and per-turn input cost)
   *  doesn't grow without limit. Coordinator also caps what it replays. */
  private static readonly HISTORY_CAP = 40;
  /** Observer tool calls are tiny; this is plenty and guards against a runaway. */
  private static readonly MAX_TOKENS = 1000;
  /** Max buffered context lines awaiting the next turn (calm-room backstop). */
  private static readonly PENDING_CONTEXT_CAP = 12;

  constructor(providerKey: LLMProviderKey, callbacks: ObserverCallbacks) {
    this.provider = getChatProvider(providerKey);
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Resolve once all currently-queued turns have run. Turns are serialized,
   *  so awaiting the current queue tail waits out everything enqueued so far.
   *  Used by tests to drain; harmless in production. */
  flush(): Promise<void> {
    return this.turnQueue;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(config: ObserverStartConfig): Promise<void> {
    this.applyConfig(config);
    this.history = [];
    this.pendingContext = [];
    this.connected = true;
  }

  /** Re-open with a fresh prompt/config but KEEP the running history — the
   *  economy backend has no live socket to reconnect, so a profile transition
   *  is just a prompt/tool refresh. (A live↔economy switch rebuilds the agent
   *  and replays history via sendConversationHistory instead.) */
  async reconnectWithConfig(config: ObserverStartConfig): Promise<void> {
    this.applyConfig(config);
    this.connected = true;
  }

  private applyConfig(config: ObserverStartConfig): void {
    this.config = config;
    const decls = buildObserverToolDeclarations(config.toolConfig).flatMap(
      (t) => t.functionDeclarations ?? [],
    );
    this.tools = decls.map(toChatTool);
  }

  close(): void {
    this.connected = false;
    try { this.inFlight?.abort(); } catch { /* ignore */ }
    this.inFlight = null;
    this.pendingContext = [];
    this.callbacks.onClose?.();
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel = "OBSERVER"): void {
    this.sessionId = sessionId;
    this.debugMode = debugMode;
    this.agentLabel = (agentLabel as FlowAgent) || "OBSERVER";
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** Buffered context the Observer should see but not necessarily react to.
   *  Capped: in a calm room no turn fires for a while, so stale [SCENE] lines
   *  would otherwise pile up. Older lines are the least relevant — keep the
   *  most recent few so the next real turn isn't dumped a huge backlog. */
  sendContextInjection(text: string): void {
    if (!this.connected || !text) return;
    flowInput(this.agentLabel, "context", text);
    this.pendingContext.push(text);
    if (this.pendingContext.length > HttpObserverAgent.PENDING_CONTEXT_CAP) {
      this.pendingContext = this.pendingContext.slice(-HttpObserverAgent.PENDING_CONTEXT_CAP);
    }
  }

  /** A turn-completing TEXT message (heard speech, startup prompt). */
  sendUserTurn(text: string): void {
    if (!this.connected || !text) return;
    flowInput(this.agentLabel, "user_turn", text);
    const ctx = this.drainContext();
    const combined = [ctx, text].filter(Boolean).join("\n");
    this.enqueueTurn([{ type: "text", text: combined }], combined);
  }

  /** A frame the Observer should look at and react to. The image is sent THIS
   *  turn only; history records just the prompt text. */
  sendFrame(jpegBase64: string, scenePrompt?: string): void {
    if (!this.connected) return;
    const prompt = scenePrompt || "[scene update] React if something here calls for action.";
    flowInput(this.agentLabel, "image_frame", prompt);
    const ctx = this.drainContext();
    const textPart = [ctx, prompt].filter(Boolean).join("\n");
    const parts: ContentPart[] = [
      { type: "text", text: textPart },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
    ];
    // History placeholder — the image bytes are NOT kept (never re-bill them).
    this.enqueueTurn(parts, `${textPart}\n[image attached]`);
  }

  /** A backlog audio clip the Observer asked to re-hear. Sent THIS turn only. */
  sendAudioClipTurn(audioBase64: string, mimeType: string, prompt: string): void {
    if (!this.connected) return;
    flowInput(this.agentLabel, "audio_clip", prompt);
    const ctx = this.drainContext();
    const textPart = [ctx, prompt].filter(Boolean).join("\n");
    const format = mimeType.replace(/^audio\//, "").split(";")[0] || "wav";
    const parts: ContentPart[] = [
      { type: "text", text: textPart },
      { type: "input_audio", input_audio: { data: audioBase64, format } },
    ];
    this.enqueueTurn(parts, `${textPart}\n[audio attached]`);
  }

  /** Raw mic PCM — Live-only. On the economy path audio always reaches the
   *  Observer pre-transcribed as [HEARD SPEECH] text, so this is a no-op. */
  sendAudio(_audioBase64: string, _mimeType?: string): void {
    /* no-op */
  }

  /** Live-only echo suppression; nothing to mute on the HTTP path. */
  setMicMuted(_muted: boolean): void {
    /* no-op */
  }

  /** Seed history after a backend (re)build so context survives a switch. */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    this.history = turns
      .filter((t) => t.text)
      .map((t) => ({
        role: t.role === "model" ? ("assistant" as const) : ("user" as const),
        content: t.text,
      }));
    this.trimHistory();
  }

  // -------------------------------------------------------------------------
  // Turn execution
  // -------------------------------------------------------------------------

  private drainContext(): string {
    if (this.pendingContext.length === 0) return "";
    const joined = this.pendingContext.join("\n");
    this.pendingContext = [];
    return joined;
  }

  /** Serialize a completion turn. `liveContent` is what's sent to the model
   *  this turn (may include image/audio parts); `historyText` is the text-only
   *  record appended to history afterwards (no raw media). */
  private enqueueTurn(liveContent: ContentPart[], historyText: string): void {
    this.turnQueue = this.turnQueue
      .then(() => this.runTurn(liveContent, historyText))
      .catch((err) => {
        try { this.callbacks.onError(err as Error); } catch { /* ignore */ }
      });
  }

  private async runTurn(liveContent: ContentPart[], historyText: string): Promise<void> {
    if (!this.connected || !this.config) return;
    const config = this.config;
    const abort = new AbortController();
    this.inFlight = abort;

    const userContent: ProviderChatMessage["content"] =
      liveContent.length === 1 && liveContent[0].type === "text"
        ? (liveContent[0] as { text: string }).text
        : (liveContent as any);

    const messages: ProviderChatMessage[] = [
      { role: "system", content: config.systemPrompt },
      ...this.history,
      { role: "user", content: userContent },
    ];

    try {
      const result = await this.provider.completeChat({
        model: config.model,
        messages,
        tools: this.tools,
        // AUTO: the Observer may legitimately do nothing this turn (routine
        // scene with nothing to report) — unlike the Board Manager it has no
        // universal "no_change" sink, so forcing a call would invent actions.
        toolChoice: "auto",
        temperature: 0.7,
        maxTokens: HttpObserverAgent.MAX_TOKENS,
        signal: abort.signal,
      });

      // Bill via the same callback the Live path uses (usage shape matches).
      if (result.usage) {
        try { this.callbacks.onUsage?.(result.usage); } catch { /* ignore */ }
      }

      // Append this turn to history: the user input (text-only) and a compact
      // text record of what the Observer did, so the next turn has continuity
      // without re-billing media or risking functionCall/response pairing.
      this.history.push({ role: "user", content: historyText });
      this.history.push({
        role: "assistant",
        content: summarizeToolCalls(result.toolCalls, result.content),
      });
      this.trimHistory();

      // Parse + emit each tool call as a typed event for the Coordinator.
      const now = Date.now();
      runInSessionContext(this.sessionId, this.debugMode, () => {
        for (const call of result.toolCalls) {
          try {
            flowTool(this.agentLabel, call.name || "?", call.arguments);
            const tc: ToolCall = {
              id: "",
              name: call.name,
              args: safeParseArgs(call.arguments),
            };
            const event: ObserverOutputEvent | null = parseToolCall(tc, now);
            if (event) this.callbacks.onEvent(event);
          } catch (err) {
            console.error(`[HttpObserverAgent] parse failure for ${call.name}:`, (err as Error).message);
          }
        }
        if (result.toolCalls.length === 0) {
          flowNote(this.agentLabel, `economy turn — no action (finish: ${result.finishReason ?? "?"})`);
        }
      });
    } catch (err) {
      if (abort.signal.aborted) return; // superseded / closed — not an error
      console.error("[HttpObserverAgent] completion failed:", (err as Error).message);
      throw err;
    } finally {
      if (this.inFlight === abort) this.inFlight = null;
    }
  }

  private trimHistory(): void {
    if (this.history.length > HttpObserverAgent.HISTORY_CAP) {
      this.history = this.history.slice(-HttpObserverAgent.HISTORY_CAP);
    }
  }
}

/** Compact text record of a turn's tool calls for the running history. */
function summarizeToolCalls(
  toolCalls: Array<{ name: string; arguments: string }>,
  content: string | null,
): string {
  if (toolCalls.length === 0) return content?.trim() || "(no action)";
  return toolCalls
    .map((c) => {
      const args = safeParseArgs(c.arguments);
      // Surface the most salient field so the model recalls what it logged.
      const salient = args.text ?? args.description ?? args.reason ?? args.mode ?? args.level ?? args.gesture;
      return salient ? `${c.name}(${String(salient).slice(0, 120)})` : c.name;
    })
    .join("; ");
}

function safeParseArgs(raw: string): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
