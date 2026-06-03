// server/services/dual-agent/speaker-agent.ts
//
// Speaker Agent for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Speaker wraps a Gemini Live session in a voice-only role:
//   - Receives text turns from the Coordinator (button presses, transcripts
//     from Observer, sentence-builder plays, context updates).
//   - Produces audio output (native audio path) OR text → server TTS
//     (fallback path, gated by `useDirectAudio`).
//   - Emits SpeechStart / SpeechEnd / EmoteChange / ModeChange /
//     InterpretIntent / AppOpen/Close/WebsiteOpen / call_monitor / private_note.
//
// Speaker does NOT receive mic audio or video frames — Observer holds
// the perception channel. Speaker doesn't touch the button board —
// Board Manager handles that surface separately.

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
  buildSpeakerToolDeclarations,
  type SpeakerToolConfig,
} from "./tool-declarations-speaker";
import { flowInput, flowTool, flowOutput } from "./agent-flow-logger";
import type {
  SpeakerEvent,
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  EmoteChangeEvent,
  ModeChangeEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
} from "./agent-events";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpeakerOutputEvent =
  | SpeakerEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent;

export interface SpeakerCallbacks {
  /** Called for every parsed event the Coordinator should dispatch. */
  onEvent: (event: SpeakerOutputEvent) => void;
  /** Native-audio path: raw PCM audio chunks (base64). Coordinator
   *  buffers + wraps in WAV before forwarding to client; also mutes
   *  Observer's mic until SpeechEnd fires (echo suppression).
   *  No-op on the fallback path. */
  onAudioChunk?: (data: { mimeType: string; data: string }) => void;
  /** Streaming text deltas from Gemini's outputAudioTranscription —
   *  one event per emitted text fragment. Coordinator forwards each to
   *  the client as a `text` WS message so the avatar mouth and the
   *  optional subtitle update live with the audio. */
  onTranscriptionDelta?: (text: string) => void;
  /** Fallback path: text Speaker wants the server TTS to voice. The
   *  Coordinator routes through the existing ttsFacade. */
  onSpeakText?: (text: string) => void;
  /** Connection / provider error. */
  onError: (error: Error) => void;
  /** Per-turn usage stats for cost tracking. */
  onUsage?: (usage: LiveUsage) => void;
  /** Provider closed. */
  onClose?: (code?: number, reason?: string) => void;
  /** Provider reconnecting (10-min ceiling). */
  onReconnecting?: () => void;
  /** Session resumption failed — Coordinator must replay history. */
  onReconnectFailed?: () => Promise<void>;
}

export interface SpeakerStartConfig {
  systemPrompt: string;
  model: string;
  toolConfig: SpeakerToolConfig;
  useVertex: boolean;
  /** Native voice name for AUDIO modality (e.g. "Puck", "Zephyr"). */
  voiceName?: string;
  /** Native audio output (true) vs. tool-driven speak() + server TTS (false). */
  useDirectAudio: boolean;
  /** Token threshold that triggers context-window compression. */
  compressionTriggerTokens?: number;
  /** Target token count after compression. */
  compressionTargetTokens?: number;
}

// ---------------------------------------------------------------------------
// SpeakerAgent
// ---------------------------------------------------------------------------

export class SpeakerAgent {
  private provider: LiveProvider | null = null;
  private readonly callbacks: SpeakerCallbacks;
  private readonly providerKey: LLMProviderKey;
  private useDirectAudio = true;

  // Per-turn accumulators for native-audio SpeechEnd transcript.
  private currentTurnTranscript = "";
  private currentTurnHadAudio = false;
  private speechStartEmittedThisTurn = false;
  /** One-shot target the model can set via set_speech_target() before
   *  speaking. Defaults to "USER" — applied to the next SpeechEnd event
   *  and reset by resetTurnAccumulators(). */
  private pendingSpeechTarget: string | undefined;

  constructor(providerKey: LLMProviderKey, callbacks: SpeakerCallbacks) {
    this.providerKey = providerKey;
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.provider?.isConnected ?? false;
  }

  async start(config: SpeakerStartConfig): Promise<void> {
    if (this.provider) {
      this.provider.close();
      this.provider = null;
    }
    this.useDirectAudio = config.useDirectAudio;
    this.resetTurnAccumulators();

    const liveCallbacks: LiveProviderCallbacks = {
      onText: (text) => this.handleOutputText(text),
      onTurnComplete: (reason) => this.handleTurnComplete(reason),
      onInterrupted: () => this.handleInterrupted(),
      onToolCall: (calls) => this.handleToolCalls(calls),
      onUsage: this.callbacks.onUsage,
      onError: this.callbacks.onError,
      onClose: this.callbacks.onClose,
      onReconnecting: this.callbacks.onReconnecting,
      onReconnectFailed: this.callbacks.onReconnectFailed,
      onAudioData: (data) => this.handleAudioData(data),
      onOutputTranscription: (text) => this.handleOutputTranscription(text),
      onOutputTranscriptionFinished: () => this.handleOutputTranscriptionFinished(),
    };

    if (this.providerKey !== "gemini") {
      throw new Error(`[SpeakerAgent] Unsupported provider for Live: ${this.providerKey}`);
    }

    const provider = new GeminiLiveProvider(liveCallbacks, config.useVertex);
    this.provider = provider;

    const providerConfig: LiveProviderConfig = {
      model: config.model,
      temperature: 0.7,
      tools: buildSpeakerToolDeclarations(config.toolConfig),
      responseModality: config.useDirectAudio ? "AUDIO" : "TEXT",
      // proactiveAudio ON. Lets Speaker DECIDE whether to react to a
      // context_injection (turnComplete=false) — required so meaningful
      // observations (a gesture, a new person, an environmental change)
      // can trigger a brief comment when the model judges it
      // appropriate. The Speaker prompt's <proactive_speech> rule
      // narrowly scopes this to keep MALFORMED_FUNCTION_CALL bursts
      // down: stay silent for routine context, speak only when there's
      // something genuinely worth saying.
      proactiveAudio: true,
      voiceName: config.voiceName,
      compressionTriggerTokens: config.compressionTriggerTokens,
      compressionTargetTokens: config.compressionTargetTokens,
    };

    await provider.connect(config.systemPrompt, providerConfig);
  }

  async reconnectWithConfig(config: SpeakerStartConfig): Promise<void> {
    if (!this.provider) return this.start(config);
    if (typeof this.provider.reconnectWithConfig !== "function") {
      this.provider.close();
      this.provider = null;
      return this.start(config);
    }
    this.useDirectAudio = config.useDirectAudio;
    this.resetTurnAccumulators();
    const providerConfig: LiveProviderConfig = {
      model: config.model,
      temperature: 0.7,
      tools: buildSpeakerToolDeclarations(config.toolConfig),
      responseModality: config.useDirectAudio ? "AUDIO" : "TEXT",
      // See start() — proactiveAudio ON. Lets Speaker react to context
      // injections selectively (gesture, environmental change) without
      // forcing a turn on every one. The prompt's <proactive_speech>
      // rule keeps this narrow.
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

  /** Deliver a user-role text turn (button press, transcribed speech,
   *  composed sentence). Speaker will respond on the next turn — or
   *  choose to stay silent in native-audio mode with proactiveAudio. */
  sendUserTurn(text: string): void {
    flowInput("SPEAKER", "user_turn", text);
    this.provider?.sendMessage(text, "user", /* turnComplete */ true);
  }

  /** Inject context without provoking a response. Used for downward
   *  state notes (mode changes, mute toggles, [BUILDER STATE] from
   *  the client when Speaker doesn't need to react). */
  sendContextInjection(text: string): void {
    flowInput("SPEAKER", "context", text);
    this.provider?.sendContextInjection(text);
  }

  /** Replay history after reconnection. */
  sendConversationHistory(turns: Array<{ role: "user" | "model"; text: string }>): void {
    this.provider?.sendConversationHistory(turns);
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, agentLabel = "SPEAKER"): void {
    this.provider?.setDebugSessionContext(sessionId, debugMode, agentLabel);
  }

  // -------------------------------------------------------------------------
  // Internal handlers
  // -------------------------------------------------------------------------

  private resetTurnAccumulators(): void {
    this.currentTurnTranscript = "";
    this.currentTurnHadAudio = false;
    this.speechStartEmittedThisTurn = false;
    this.pendingSpeechTarget = undefined;
  }

  private maybeEmitSpeechStart(): void {
    if (this.speechStartEmittedThisTurn) return;
    this.speechStartEmittedThisTurn = true;
    // Snapshot whatever transcript has accumulated by now. In native
    // audio, Gemini typically emits the full outputTranscription text
    // BEFORE the first audio chunk, so this is effectively the complete
    // utterance. BoardManager uses it to build follow-up buttons on the
    // speech_start trigger instead of waiting for turnComplete.
    const transcriptSoFar = this.currentTurnTranscript.trim();
    const event: SpeechStartEvent = {
      type: "speech_start",
      source: "speaker",
      timestamp: Date.now(),
      transcript: transcriptSoFar || undefined,
    };
    this.callbacks.onEvent(event);
  }

  private handleAudioData(data: { mimeType: string; data: string }): void {
    if (!this.useDirectAudio) return;
    this.currentTurnHadAudio = true;
    this.maybeEmitSpeechStart();
    this.callbacks.onAudioChunk?.(data);
  }

  private handleOutputTranscription(text: string): void {
    // Gemini native audio surfaces a streaming transcript of what the
    // model is currently speaking. Accumulate for the SpeechEnd event,
    // AND forward each delta to the Coordinator so the client can
    // stream subtitle text + animate the avatar mouth alongside the audio.
    if (!this.useDirectAudio) return;
    this.currentTurnTranscript += text;
    if (text.trim()) this.callbacks.onTranscriptionDelta?.(text);
  }

  /** Fires when the text portion of the model's turn is complete
   *  (audio may still be streaming). Emit SpeechTextFinalized so the
   *  Coordinator can kick off BoardManager with the FULL transcript
   *  while audio is still playing out. */
  private handleOutputTranscriptionFinished(): void {
    if (!this.useDirectAudio) return;
    const transcript = this.currentTurnTranscript.trim();
    if (!transcript) return;
    flowOutput("SPEAKER", "text_finalized", transcript);
    const event: SpeechTextFinalizedEvent = {
      type: "speech_text_finalized",
      source: "speaker",
      timestamp: Date.now(),
      transcript,
    };
    this.callbacks.onEvent(event);
  }

  private handleOutputText(text: string): void {
    // In TEXT modality (fallback), the model's text output is its
    // speech. We don't auto-emit SpeechEnd from streamed text — the
    // speak() tool call carries the canonical version. But if no
    // speak() call lands and text trickled through, fall back to that.
    if (this.useDirectAudio) return;
    this.currentTurnTranscript += text;
  }

  private handleTurnComplete(reason?: string): void {
    if (reason && reason !== "STOP") {
      console.warn(`[SpeakerAgent] Turn ended abnormally: ${reason}`);
    }

    // Native-audio path: emit SpeechEnd if any audio was produced this turn.
    // The Coordinator uses SpeechEnd to:
    //   1. Lift mic mute on Observer (with ~300ms tail)
    //   2. Inject [OWN_SPEECH]: <transcript> into Observer for context
    //   3. Trigger Board Manager rebuild for the follow-up surface
    if (this.useDirectAudio && this.currentTurnHadAudio) {
      const transcript = this.currentTurnTranscript.trim();
      flowOutput("SPEAKER", "speech", transcript || "(no transcript)");
      const event: SpeechEndEvent = {
        type: "speech_end",
        source: "speaker",
        timestamp: Date.now(),
        transcript,
        target: this.pendingSpeechTarget ?? "USER",
      };
      this.callbacks.onEvent(event);
    }

    this.resetTurnAccumulators();
  }

  private handleInterrupted(): void {
    // Native-audio interrupt — Speaker was stopped mid-utterance.
    // Still emit SpeechEnd so Observer's mic mute lifts and Board
    // Manager gets a chance to rebuild for the interrupted state.
    if (this.useDirectAudio && this.currentTurnHadAudio) {
      const event: SpeechEndEvent = {
        type: "speech_end",
        source: "speaker",
        timestamp: Date.now(),
        transcript: this.currentTurnTranscript.trim() + " [interrupted]",
      };
      this.callbacks.onEvent(event);
    }
    this.resetTurnAccumulators();
  }

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------

  private handleToolCalls(calls: ToolCall[]): void {
    // Acknowledge tool calls so the Live session doesn't hang. Speaker's
    // tools are mostly fire-and-forget (no return value); "ok" suffices.
    if (this.provider) {
      this.provider.sendToolResponseAsContent(
        calls.map(c => ({
          id: c.id,
          name: c.name || "unknown",
          response: { output: "ok" },
        })),
      );
    }

    const now = Date.now();
    for (const call of calls) {
      try {
        flowTool("SPEAKER", call.name || "?", JSON.stringify(call.args ?? {}));
        const events = this.parseToolCall(call, now);
        for (const event of events) {
          this.callbacks.onEvent(event);
        }
      } catch (err) {
        console.error(`[SpeakerAgent] parse failure for ${call.name}:`, (err as Error).message);
      }
    }
  }

  /** A single tool call may produce multiple events (e.g. speak() emits
   *  SpeechStart + SpeechEnd in fallback mode). Returns an array. */
  private parseToolCall(call: ToolCall, now: number): SpeakerOutputEvent[] {
    const args = call.args || {};
    const asString = (v: unknown): string | undefined =>
      typeof v === "string" ? v : undefined;

    switch (call.name) {
      case "speak": {
        // Fallback path only. Text is fed to server TTS by the Coordinator.
        const text = asString(args.text);
        if (!text) return [];
        // Notify Coordinator to send the text through TTS.
        this.callbacks.onSpeakText?.(text);
        // Emit SpeechStart + SpeechEnd in one go — fallback path doesn't
        // stream; the entire utterance is decided in this tool call.
        this.maybeEmitSpeechStart();
        const end: SpeechEndEvent = {
          type: "speech_end",
          source: "speaker",
          timestamp: now,
          transcript: text,
        };
        // Reset accumulators since this synthetic SpeechEnd doesn't go
        // through handleTurnComplete's native-audio path.
        this.resetTurnAccumulators();
        return [end];
      }

      // `interpret` lives on Board Manager now — Speaker doesn't have
      // this tool declared. If the model somehow tries to call it, we
      // ignore the call (return no events). The acknowledgement still
      // flows back via the tool-response handler so the session doesn't
      // hang.

      case "emote": {
        const emotion = asString(args.emotion) as EmoteChangeEvent["emote"] | undefined;
        if (!emotion) return [];
        const event: EmoteChangeEvent = {
          type: "emote_change",
          source: "speaker",
          timestamp: now,
          emote: emotion,
        };
        return [event];
      }

      case "set_interaction_mode": {
        // set_interaction_mode moved to Observer (camera + mic context
        // makes it the right judge of interact vs. assist). The tool is
        // no longer declared on Speaker's surface, but the parser keeps
        // a defensive case in case a stale model call shows up — drop
        // it silently. Speaker learns the current mode from [MODE]
        // context injections forwarded by Coordinator.
        return [];
      }

      case "set_speech_target": {
        // Stash for the next SpeechEnd event. Not an event itself — the
        // target rides along on the next speech the model produces and
        // is reset by resetTurnAccumulators() afterwards.
        const target = asString(args.target);
        if (target) this.pendingSpeechTarget = target;
        return [];
      }

      case "open_app": {
        const appId = asString(args.app_id);
        if (!appId) return [];
        const event: AppOpenRequestedEvent = {
          type: "app_open_requested",
          source: "speaker",
          timestamp: now,
          appId,
          data: asString(args.data),
        };
        return [event];
      }

      case "close_app": {
        const event: AppCloseRequestedEvent = {
          type: "app_close_requested",
          source: "speaker",
          timestamp: now,
        };
        return [event];
      }

      case "open_website": {
        const url = asString(args.url);
        if (!url) return [];
        const event: WebsiteOpenRequestedEvent = {
          type: "website_open_requested",
          source: "speaker",
          timestamp: now,
          url,
          label: asString(args.label),
        };
        return [event];
      }

      case "call_monitor": {
        const event: MonitorCallRequestedEvent = {
          type: "monitor_call_requested",
          source: "speaker",
          timestamp: now,
          reason: asString(args.reason) ?? "(no reason provided)",
        };
        return [event];
      }

      case "private_note": {
        const event: PrivateNoteEvent = {
          type: "private_note",
          source: "speaker",
          timestamp: now,
          note: asString(args.note) ?? "",
        };
        return [event];
      }

      case "debug_message":
        return [];

      case "rebuild_board":
      case "add_context_button":
      case "show_binary_choice":
      case "no_change":
      case "press_button":
      case "set_board":
      case "suggest_construction_buttons":
      case "set_construction_memory_chips":
      case "interpret":
        // Legacy single-agent tools the model hallucinates from training.
        // Speaker doesn't own the board — Board Manager does. Drop the
        // call; Speaker's native-audio speech goes out independently.
        return [];

      default:
        console.warn(`[SpeakerAgent] Unknown tool call: ${call.name}`);
        return [];
    }
  }
}
