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
//     InterpretIntent / AppOpen/Close/WebsiteOpen / call_monitor / private_thought.
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
  SPEAKER_TOOL_ACK,
} from "./prompts/speaker";
import { flowInput, flowTool, flowOutput } from "./agent-flow-logger";
import {
  LeadingTagStripper,
  stripLeadingTags,
  extractLeadingTags,
} from "./leading-tag-stripper";
import type {
  SpeakerEvent,
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  EmoteChangeEvent,
  CallPersonEvent,
  ModeChangeEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  MonitorCallRequestedEvent,
  PrivateNoteEvent,
  RemainSilentEvent,
  ThoughtLeakEvent,
} from "./agent-events";
import type { ISpeakerAgent } from "./speaker-interface";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpeakerOutputEvent =
  | SpeakerEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent
  | RemainSilentEvent
  | ThoughtLeakEvent;

/** Marker the native-audio model leaks when it VOICES its private-thought
 *  tool instead of calling it. An underscore-joined token like
 *  `private_thought` never occurs in natural speech, so matching it (and
 *  the legacy `private_note`) case-insensitively is false-positive-safe
 *  anywhere in the transcript. */
const THOUGHT_LEAK_TOKEN_RE = /private_(?:thought|note)/i;
/** The same marker, but space- or hyphen-separated ("private thought",
 *  "private-note") — the form the model actually voices most often, since
 *  the transcriber doesn't always preserve the underscore. The natural
 *  phrase "private thought" DOES occur in speech ("that was a private
 *  thought of mine"), so unlike the underscore form this is only treated
 *  as a leak when it LEADS the utterance (optionally after a leaked
 *  bracket tag the model also echoed). Mirrors the leading-only rule the
 *  bracketed-tag stripper uses. */
const THOUGHT_LEAK_LEADING_RE =
  /^\s*(?:\[[^\]\n]{1,200}\]\s*)*private[\s_-](?:thought|note)\b/i;
/** Self-invented bare label the model drifts into once a leak goes
 *  uncaught (observed in production). Case-SENSITIVE all-caps + must LEAD
 *  the utterance, so ordinary "Thought you'd…" / "thought…" speech is safe.
 *  Tolerates a leaked bracket tag in front of it. */
const THOUGHT_LEAK_LABEL_RE = /^\s*(?:\[[^\]\n]{1,200}\]\s*)*THOUGHT\b/;

/** True when `transcript` (the accumulated streaming transcript so far)
 *  shows a leaked private-thought prefix. */
export function isLeakedThought(transcript: string): boolean {
  return THOUGHT_LEAK_TOKEN_RE.test(transcript)
    || THOUGHT_LEAK_LEADING_RE.test(transcript)
    || THOUGHT_LEAK_LABEL_RE.test(transcript);
}

/** Strip the leaked marker (and any leaked leading bracket tag before it),
 *  returning the reasoning text that followed — to record as a private
 *  thought. Falls back to the trimmed original if nothing follows. */
export function stripThoughtLeakMarker(transcript: string): string {
  // Drop any leaked leading bracket tags ("[USER to YOU] …") first.
  const noTags = transcript.replace(/^(?:\s*\[[^\]\n]{1,200}\]\s*)+/, "");
  const m =
    noTags.match(/^\s*private[\s_-](?:thought|note)\b[:\-\s]*/i)
    ?? noTags.match(/private_(?:thought|note)\b[:\-\s]*/i)
    ?? noTags.match(/^\s*THOUGHT\b[:\-\s]*/);
  const stripped = m ? noTags.slice((m.index ?? 0) + m[0].length).trim() : "";
  return stripped || noTags.trim() || transcript.trim();
}

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
  /** Native-audio path: the streaming transcript shows the model is
   *  voicing its reasoning ("private_thought …"). Fired ONCE per turn the
   *  instant a leak is detected so the Coordinator can drop the buffered
   *  PCM and interrupt client playback before the child hears more. The
   *  turn's captured reasoning still arrives later as a ThoughtLeakEvent. */
  onSuppressAudio?: () => void;
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

export class SpeakerAgent implements ISpeakerAgent {
  private provider: LiveProvider | null = null;
  private readonly callbacks: SpeakerCallbacks;
  private readonly providerKey: LLMProviderKey;
  private useDirectAudio = true;

  // Per-turn accumulators for native-audio SpeechEnd transcript.
  private currentTurnTranscript = "";
  private currentTurnHadAudio = false;
  private speechStartEmittedThisTurn = false;
  /** Set once per turn when the streaming transcript reveals the model is
   *  voicing its private reasoning. While true, transcription deltas and
   *  audio are suppressed and the turn resolves to a ThoughtLeakEvent
   *  instead of speech_text_finalized / speech_end. */
  private leakedThoughtThisTurn = false;
  /** One-shot target the model can set via set_speech_target() before
   *  speaking. Defaults to "USER" — applied to the next SpeechEnd event
   *  and reset by resetTurnAccumulators(). */
  private pendingSpeechTarget: string | undefined;
  /** Incrementally strips a leaked leading meta-tag ("[USER to YOU]", …)
   *  off the streaming subtitle so the child never sees it. A fresh
   *  instance per turn (resetTurnAccumulators). */
  private subtitleStripper = new LeadingTagStripper();
  /** The leading tag the model leaked into its spoken output this turn
   *  (empty when none). Drives the Coordinator's one-shot corrective. */
  private leakedLeadingTagThisTurn = "";

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
    this.leakedThoughtThisTurn = false;
    this.subtitleStripper = new LeadingTagStripper();
    this.leakedLeadingTagThisTurn = "";
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

    // Already suppressing this turn — swallow the rest of the leaked
    // reasoning so it neither reaches the client subtitle nor the avatar.
    if (this.leakedThoughtThisTurn) return;

    // Detect the model voicing its private reasoning. The leak marker
    // ("private_thought …") leads the utterance, so this fires on the
    // first delta — before meaningful audio has played out. Tell the
    // Coordinator to kill the audio immediately; the captured reasoning
    // is emitted as a ThoughtLeakEvent at turn end.
    if (isLeakedThought(this.currentTurnTranscript)) {
      this.leakedThoughtThisTurn = true;
      flowOutput("SPEAKER", "thought_leak_detected", this.currentTurnTranscript.trim());
      this.callbacks.onSuppressAudio?.();
      return;
    }

    // Strip a leaked leading meta-tag ("[USER to YOU]", "[MODE …]") off the
    // FRONT of the utterance before it reaches the client subtitle / avatar
    // mouth. The stripper withholds deltas while the bracket is still open,
    // then passes cleaned text through unchanged for the rest of the turn.
    const cleaned = this.subtitleStripper.push(text);
    if (this.subtitleStripper.stripped && !this.leakedLeadingTagThisTurn) {
      this.leakedLeadingTagThisTurn = this.subtitleStripper.strippedTag;
    }
    if (cleaned.trim()) this.callbacks.onTranscriptionDelta?.(cleaned);
  }

  /** Fires when the text portion of the model's turn is complete
   *  (audio may still be streaming). Emit SpeechTextFinalized so the
   *  Coordinator can kick off BoardManager with the FULL transcript
   *  while audio is still playing out. */
  private handleOutputTranscriptionFinished(): void {
    if (!this.useDirectAudio) return;
    // Suppressed turn — don't surface the leaked text as a real reply.
    // The ThoughtLeakEvent is emitted from handleTurnComplete instead, so
    // BoardManager never rebuilds from it and it's never echoed back.
    if (this.leakedThoughtThisTurn) return;
    // Strip a leaked leading meta-tag so BoardManager builds replies from
    // the real utterance, not "[USER to YOU] …".
    const transcript = stripLeadingTags(this.currentTurnTranscript).trim();
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

    // Suppressed turn: the model voiced its reasoning. Emit a ThoughtLeakEvent
    // carrying the captured note (marker stripped) INSTEAD of SpeechEnd. The
    // Coordinator records it to supervisor channels, lifts audio suppression,
    // and injects a corrective — but never echoes it back to the model or
    // rebuilds the board from it (that's the self-reinforcing loop we're killing).
    if (this.useDirectAudio && this.leakedThoughtThisTurn) {
      const note = stripThoughtLeakMarker(this.currentTurnTranscript);
      flowOutput("SPEAKER", "thought_leak", note);
      const event: ThoughtLeakEvent = {
        type: "thought_leak",
        source: "speaker",
        timestamp: Date.now(),
        note,
      };
      this.callbacks.onEvent(event);
      this.resetTurnAccumulators();
      return;
    }

    // Native-audio path: emit SpeechEnd if any audio was produced this turn.
    // The Coordinator uses SpeechEnd to:
    //   1. Lift mic mute on Observer (with ~300ms tail)
    //   2. Inject [OWN_SPEECH]: <transcript> into Observer for context
    //   3. Trigger Board Manager rebuild for the follow-up surface
    if (this.useDirectAudio && this.currentTurnHadAudio) {
      // Strip a leaked leading meta-tag off the final transcript that gets
      // echoed back into Speaker's own context + Observer + the
      // conversation log — otherwise the tag teaches the model the prefix
      // is expected and the behavior compounds.
      const rawTranscript = this.currentTurnTranscript.trim();
      const transcript = stripLeadingTags(rawTranscript).trim();
      const leakedLeadingTag =
        this.leakedLeadingTagThisTurn || extractLeadingTags(rawTranscript);
      if (leakedLeadingTag) {
        flowOutput("SPEAKER", "leading_tag_stripped", leakedLeadingTag);
      }
      flowOutput("SPEAKER", "speech", transcript || "(no transcript)");
      const event: SpeechEndEvent = {
        type: "speech_end",
        source: "speaker",
        timestamp: Date.now(),
        transcript,
        target: this.pendingSpeechTarget ?? "USER",
        strippedLeadingTag: leakedLeadingTag || undefined,
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
        transcript: stripLeadingTags(this.currentTurnTranscript).trim() + " [interrupted]",
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
          response: SPEAKER_TOOL_ACK,
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
        const rawText = asString(args.text);
        if (!rawText) return [];
        // Strip a leaked leading meta-tag ("[USER to YOU] …") so the TTS
        // never voices it and it never re-enters the transcript.
        const text = stripLeadingTags(rawText).trim() || rawText;
        const leakedLeadingTag = extractLeadingTags(rawText);
        if (leakedLeadingTag) {
          flowOutput("SPEAKER", "leading_tag_stripped", leakedLeadingTag);
        }
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
          strippedLeadingTag: leakedLeadingTag || undefined,
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

      case "call_person": {
        const contactId = asString(args.contactId);
        if (!contactId) return [];
        const event: CallPersonEvent = {
          type: "call_person",
          source: "speaker",
          timestamp: now,
          contactId,
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

      case "private_thought":
      case "private_note": {
        // Tool renamed to `private_thought`; `private_note` kept as an alias
        // for stale model calls. Internal event type stays `private_note`.
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
