// server/services/dual-agent/observer-agent.ts
//
// Observer Agent for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Observer wraps a Gemini Live session in a perception-only role:
//   - Consumes audio + video frames from the mic/camera (forwarded by
//     the Coordinator, with mic mute applied while Speaker is talking).
//   - Receives downward context injections (e.g. `[OWN_SPEECH]: ...` so
//     it knows what Speaker just said).
//   - Emits Observer events (Transcribed, ContextUpdate, EngagementChange,
//     FocusRequest, MonitorCallRequested, PrivateNote) parsed from its
//     tool calls.
//
// Observer never produces audio output (responseModality: "TEXT") and
// never sends messages to Speaker / Board Manager directly — the
// Coordinator does that based on its routing table.

import type { LLMProviderKey } from "@shared/llm-options";
import { GeminiLiveProvider } from "./gemini-live-provider";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  LiveUsage,
  ToolCall,
} from "./live-provider";
import {
  buildObserverToolDeclarations,
  type ObserverToolConfig,
} from "./tool-declarations-observer";
import type {
  ObserverEvent,
  TranscribedEvent,
  ContextUpdateEvent,
  EngagementChangeEvent,
  FocusRequestEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
  ContextUpdateType,
  SpeechDirection,
} from "./agent-events";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything Observer can emit — its own events plus the shared
 *  cross-agent ones. The Coordinator dispatches each. */
export type ObserverOutputEvent =
  | ObserverEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent;

export interface ObserverCallbacks {
  /** Called for every parsed event the Coordinator should dispatch. */
  onEvent: (event: ObserverOutputEvent) => void;
  /** Connection / provider error. */
  onError: (error: Error) => void;
  /** Optional: per-turn usage stats for cost tracking. */
  onUsage?: (usage: LiveUsage) => void;
  /** Optional: provider closed (Coordinator decides whether to reconnect). */
  onClose?: (code?: number, reason?: string) => void;
  /** Optional: provider is reconnecting (10-min ceiling). */
  onReconnecting?: () => void;
  /** Optional: session resumption failed; Coordinator must replay history. */
  onReconnectFailed?: () => Promise<void>;
}

export interface ObserverStartConfig {
  systemPrompt: string;
  model: string;
  toolConfig: ObserverToolConfig;
  /** Whether to authenticate via Vertex (true) or GEMINI_API_KEY (false). */
  useVertex: boolean;
  /**
   * Gemini native-audio voice name. Observer never produces audio that
   * reaches the client (no onAudioChunk handler), but the native-audio
   * model requires a voice in AUDIO modality — leaving it undefined
   * can produce subtle config-validation issues. Mirrors the
   * single-agent path which always sets this.
   */
  voiceName?: string;
  /** Token threshold that triggers context-window compression. */
  compressionTriggerTokens?: number;
  /** Target token count after compression. */
  compressionTargetTokens?: number;
}

// ---------------------------------------------------------------------------
// Tool-call → typed-event parser
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseToolCall(call: ToolCall, now: number): ObserverOutputEvent | null {
  const args = call.args || {};

  switch (call.name) {
    case "transcript": {
      const text = asString(args.text);
      const speaker = asString(args.speaker);
      if (!text || !speaker) return null;
      // The tool no longer carries a `direction` arg (reverted — see note
      // in tool-declarations-observer). Default to "user" so the
      // coordinator routes every transcript to Speaker as a user turn,
      // matching the single-agent's behavior of always letting the model
      // decide whether to respond.
      const direction: SpeechDirection = "user";
      const confidence = (asString(args.confidence) as TranscribedEvent["confidence"] | undefined) ?? "medium";
      const event: TranscribedEvent = {
        type: "transcribed",
        source: "observer",
        timestamp: now,
        text,
        speaker,
        direction,
        confidence,
      };
      return event;
    }

    case "update_context": {
      const updateType = asString(args.type) as ContextUpdateType | undefined;
      const key = asString(args.key);
      const description = asString(args.description);
      if (!updateType || !key || !description) return null;
      const relevance = asString(args.relevance) === "builder-candidate" ? "builder-candidate" as const : undefined;
      const event: ContextUpdateEvent = {
        type: "context_update",
        source: "observer",
        timestamp: now,
        updateType,
        key,
        description,
        relevance,
      };
      return event;
    }

    case "request_focus": {
      const reason = asString(args.reason);
      if (!reason) return null;
      const event: FocusRequestEvent = {
        type: "focus_request",
        source: "observer",
        timestamp: now,
        reason,
      };
      return event;
    }

    case "rest":
    case "wake_up":
    case "sleep":
    case "end_session": {
      const event: EngagementChangeEvent = {
        type: "engagement_change",
        source: "observer",
        timestamp: now,
        state: call.name as EngagementChangeEvent["state"],
        reason: asString(args.reason),
      };
      return event;
    }

    case "call_monitor": {
      const event: MonitorCallRequestedEvent = {
        type: "monitor_call_requested",
        source: "observer",
        timestamp: now,
        reason: asString(args.reason) ?? "(no reason provided)",
      };
      return event;
    }

    case "private_note": {
      const event: PrivateNoteEvent = {
        type: "private_note",
        source: "observer",
        timestamp: now,
        note: asString(args.note) ?? "",
      };
      return event;
    }

    case "debug_message":
      // Debug-introspection only; not a routed event.
      return null;

    default:
      console.warn(`[ObserverAgent] Unknown tool call: ${call.name}`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// ObserverAgent
// ---------------------------------------------------------------------------

export class ObserverAgent {
  private provider: LiveProvider | null = null;
  private readonly callbacks: ObserverCallbacks;
  private readonly providerKey: LLMProviderKey;
  /** When true, the Coordinator has muted Observer's mic input. Audio
   *  forwarded via sendAudio() is silently dropped. Coordinator flips
   *  this around Speaker's audio output to suppress echo. */
  private micMuted = false;

  constructor(providerKey: LLMProviderKey, callbacks: ObserverCallbacks) {
    this.providerKey = providerKey;
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.provider?.isConnected ?? false;
  }

  async start(config: ObserverStartConfig): Promise<void> {
    if (this.provider) {
      this.provider.close();
      this.provider = null;
    }

    const liveCallbacks: LiveProviderCallbacks = {
      onText: () => {
        // Observer is text-modality so the model may stream stray text
        // (transcription previews, function-call planning). We ignore
        // raw text — only structured tool calls are routed.
      },
      onTurnComplete: (reason) => {
        if (reason && reason !== "STOP") {
          // Surface abnormal completions for diagnosis but don't error.
          console.warn(`[ObserverAgent] Turn completed abnormally: ${reason}`);
        }
      },
      onInterrupted: () => {
        // Observer doesn't speak, so interrupts are effectively no-ops.
      },
      onToolCall: (calls) => this.handleToolCalls(calls),
      onUsage: this.callbacks.onUsage,
      onError: this.callbacks.onError,
      onClose: this.callbacks.onClose,
      onReconnecting: this.callbacks.onReconnecting,
      onReconnectFailed: this.callbacks.onReconnectFailed,
    };

    if (this.providerKey !== "gemini") {
      // Live wrapping for non-Gemini providers can be added later; for
      // now Observer is Gemini-only because that's the only provider
      // with native multimodal Live input.
      throw new Error(`[ObserverAgent] Unsupported provider for Live: ${this.providerKey}`);
    }

    const provider = new GeminiLiveProvider(liveCallbacks, config.useVertex);
    this.provider = provider;

    // Mirror the single-agent provider config — same temperature, same
    // modality, same proactiveAudio, same voiceName. Native-audio models
    // reject responseModality=TEXT (close=1007), so we run AUDIO and
    // discard any audio Observer produces (no onAudioChunk handler).
    const providerConfig: LiveProviderConfig = {
      model: config.model,
      temperature: 0.7,
      tools: buildObserverToolDeclarations(config.toolConfig),
      responseModality: "AUDIO",
      proactiveAudio: true,
      voiceName: config.voiceName,
      compressionTriggerTokens: config.compressionTriggerTokens,
      compressionTargetTokens: config.compressionTargetTokens,
    };

    await provider.connect(config.systemPrompt, providerConfig);
  }

  /** Reconnect with a new prompt + config — used on session-profile
   *  transitions (awake ↔ resting). */
  async reconnectWithConfig(config: ObserverStartConfig): Promise<void> {
    if (!this.provider) {
      // No live session — just start fresh.
      return this.start(config);
    }
    if (typeof this.provider.reconnectWithConfig !== "function") {
      // Provider doesn't support live reconfigure — fall back to close + start.
      this.provider.close();
      this.provider = null;
      return this.start(config);
    }
    const providerConfig: LiveProviderConfig = {
      model: config.model,
      temperature: 0.7,
      tools: buildObserverToolDeclarations(config.toolConfig),
      responseModality: "AUDIO",
      proactiveAudio: true,
      voiceName: config.voiceName,
      compressionTriggerTokens: config.compressionTriggerTokens,
      compressionTargetTokens: config.compressionTargetTokens,
    };
    await this.provider.reconnectWithConfig(config.systemPrompt, providerConfig);
  }

  close(): void {
    this.provider?.close();
    this.provider = null;
  }

  // -------------------------------------------------------------------------
  // Sending data
  // -------------------------------------------------------------------------

  /**
   * Deliver a frame to Observer's Live session. Unlike a bare sendFrame
   * (which the model treats as silent background context), this routes
   * through sendFrameWithPrompt with a `[scene update]` text so the
   * model gets a turn opportunity — it can call transcript/update_context
   * if something in the frame warrants it, or stay silent via
   * proactiveAudio. Mirrors the legacy single-agent path's behavior;
   * without this, the model never gets a "react now" trigger and ends
   * up malforming when audio finally lands.
   */
  sendFrame(jpegBase64: string, scenePrompt?: string): void {
    const prompt = scenePrompt || "[scene update] React if something here calls for action.";
    this.provider?.sendFrameWithPrompt(jpegBase64, prompt);
  }

  /** Legacy/edge cases: deliver a frame without prompting the model to
   *  react. Used for focus_frame which has its own prompt embedded. */
  sendFrameSilent(jpegBase64: string): void {
    this.provider?.sendFrame(jpegBase64, /* turnComplete */ false);
  }

  /** Forward an audio chunk to Observer. No-op when the Coordinator has
   *  muted Observer's mic (echo suppression around Speaker's output). */
  sendAudio(audioBase64: string, mimeType?: string): void {
    if (this.micMuted) return;
    this.provider?.sendAudio(audioBase64, mimeType);
  }

  /** Coordinator-controlled mute flag. True while Speaker is producing
   *  audio (+ ~300ms tail); false otherwise. */
  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
  }

  /** Inject context that Observer should see but not respond to (e.g.
   *  `[OWN_SPEECH]: <transcript>` after Speaker's turn ends). */
  sendContextInjection(text: string): void {
    this.provider?.sendContextInjection(text);
  }

  /** Replay history after reconnection. Each turn is text-only since
   *  Observer never produces audio output of its own. */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    this.provider?.sendConversationHistory(turns);
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel = "OBSERVER"): void {
    this.provider?.setDebugSessionContext(sessionId, debugMode, agentLabel);
  }

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------

  private handleToolCalls(calls: ToolCall[]): void {
    const now = Date.now();

    // 1. Acknowledge each tool call so the Live session doesn't hang.
    //    Observer's tools are observational — there's no return value to
    //    feed back; "ok" suffices. We deliver via sendToolResponseAsContent
    //    so it lands as a functionResponse part without triggering a new
    //    turn — Observer's purpose is to KEEP observing, not to produce a
    //    follow-up generation each time it logs something.
    if (this.provider) {
      this.provider.sendToolResponseAsContent(
        calls.map(c => ({
          id: c.id,
          name: c.name || "unknown",
          response: { output: "ok" },
        })),
      );
    }

    // 2. Parse and emit each event for Coordinator dispatch.
    for (const call of calls) {
      try {
        const event = parseToolCall(call, now);
        if (event) this.callbacks.onEvent(event);
      } catch (err) {
        console.error(`[ObserverAgent] parse failure for ${call.name}:`, (err as Error).message);
      }
    }
  }
}
