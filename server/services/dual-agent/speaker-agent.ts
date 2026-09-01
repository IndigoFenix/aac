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
import { flowInput, flowTool, flowOutput, flowNote } from "./agent-flow-logger";
import { SpokenTurnGate, sanitizeSpokenTurn } from "./spoken-turn-gate";
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
  ContextLeakEvent,
} from "./agent-events";
import type { ISpeakerAgent } from "./speaker-interface";
import type { DisclosureContext } from "../processorDisclosure";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpeakerOutputEvent =
  | SpeakerEvent
  | MonitorCallRequestedEvent
  | PrivateNoteEvent
  | RemainSilentEvent
  | ThoughtLeakEvent
  | ContextLeakEvent;

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

/**
 * How long an `open_app` functionResponse may be withheld before we answer
 * "ok" anyway.
 *
 * 🚨 SIZED FROM MEASUREMENT, NOT FROM A GUESS. It was 2500ms, justified as
 * "the slowest leg is one startup-resolver call (~1.5s observed)". That was
 * wrong, and the failure was silent: on 2026-08-27 three consecutive
 * `open_app("restaurant")` calls took 2.84s, 3.95s and 3.91s end to end — the
 * AI-open decision alone runs ~2.4s and the app's own resolution follows it.
 * Every one of them blew the budget, so the model was handed "ok" a second
 * before the real answer arrived and told a child "opening the restaurant app"
 * when nothing was going to open. A timeout that always fires is not a backstop,
 * it IS the behaviour.
 *
 * 4500ms covers the measured worst case with headroom. It is a long time to be
 * silent, and that is the trade: Live blocks generation for the whole hold, so
 * the cost of erring long is dead air and the cost of erring short is a broken
 * promise nobody can retract. The "opening…" cue (ProcessingActivity "app",
 * armed at 250ms) exists to make that silence read as work rather than failure.
 *
 * If this needs raising again, fix the LATENCY instead — the decision call and
 * the app's own resolution do not depend on each other and run in series today.
 */
export const APP_OPEN_ACK_TIMEOUT_MS = 4500;

export class SpeakerAgent implements ISpeakerAgent {
  /** AKIM §18.5 — ids for the disclosure log. Handed to the Live provider in
   *  the connect config, because the SDK's send/callback paths run outside
   *  the AsyncLocalStorage chain this session was opened on. */
  private disclosureCtx: DisclosureContext | null = null;
  setDisclosureContext(ctx: DisclosureContext | null): void {
    this.disclosureCtx = ctx;
  }

  private provider: LiveProvider | null = null;
  /** Held `open_app` functionResponses, keyed by live tool-call id. */
  private pendingAppOpenAcks = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
  /**
   * Opens the BACKSTOP answered before the server had a verdict.
   *
   * 🚨 Without this the timeout SWALLOWED the note. `resolveAppOpen` returned
   * early on "already settled", so the whole point of the note — telling the
   * Speaker what actually appeared — was lost precisely in the case where the
   * model had already spoken and most needed correcting. Observed 2026-09-01:
   * three restaurant opens in a row, and the Speaker was never told what was on
   * screen for any of them.
   *
   * An id lands here on timeout and is consumed by the late settle, which
   * delivers the note the pre-hold way — as a context injection. That is safe
   * HERE and nowhere else in this flow: the backstop already answered the
   * functionResponse, so nothing is outstanding and pushing client content
   * cannot strand generation (which is what an injection mid-hold does).
   */
  private timedOutAppOpenAcks = new Set<string>();
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
  /** THE gate on what this turn is allowed to have said — the one place
   *  that decides what reaches the caption, the audio, the Board Manager,
   *  the Observer echo and the model's own context. A fresh instance per
   *  turn (resetTurnAccumulators). See spoken-turn-gate.ts. */
  private turnGate = new SpokenTurnGate();
  /** A single benign leading group the model leaked this turn (empty when
   *  none) — drives the Coordinator's one-shot corrective. The turn still
   *  reaches the child; only the prefix is removed. */
  private leakedLeadingTagThisTurn = "";
  /** Set once per turn when the gate disqualifies the utterance outright:
   *  the model recited its own input rather than replying. While true,
   *  transcription deltas and audio are suppressed and the turn resolves
   *  to a ContextLeakEvent instead of speech_text_finalized / speech_end.
   *  Same shape as leakedThoughtThisTurn. */
  private leakedContextThisTurn = false;

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
      disclosure: this.disclosureCtx ?? undefined,
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
      disclosure: this.disclosureCtx ?? undefined,
    };
    await this.provider.reconnectWithConfig(config.systemPrompt, providerConfig);
  }

  close(): void {
    // Held acks die with the session — their timers would otherwise fire against
    // a torn-down provider, and a reconnect issues fresh tool-call ids anyway.
    this.clearPendingAppOpenAcks();
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

  /** Barge-in: abandon the turn being generated. The Live API has no
   *  standalone cancel — generation is cut only when the next client content
   *  lands — so there is nothing to send here. The Coordinator has already
   *  dropped the buffered PCM and cleared the client's avatar queue, so the
   *  child hears nothing more; the model finishes into the void and the next
   *  user turn supersedes it. Kept as an explicit no-op so the barge-in path
   *  reads the same for both backends. */
  cancelTurn(reason: string): void {
    flowNote("SPEAKER", `Turn cancelled (${reason}) — Live generation runs out silently; audio already dropped.`);
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
    this.turnGate = new SpokenTurnGate();
    this.leakedLeadingTagThisTurn = "";
    this.leakedContextThisTurn = false;
  }

  private maybeEmitSpeechStart(): void {
    if (this.speechStartEmittedThisTurn) return;
    this.speechStartEmittedThisTurn = true;
    // Snapshot whatever transcript has accumulated by now. In native
    // audio, Gemini typically emits the full outputTranscription text
    // BEFORE the first audio chunk, so this is effectively the complete
    // utterance. BoardManager uses it to build follow-up buttons on the
    // speech_start trigger instead of waiting for turnComplete.
    // Through the gate like every other consumer — BoardManager must never
    // see recited context, not even in the early snapshot.
    const transcriptSoFar = sanitizeSpokenTurn(this.currentTurnTranscript).speech;
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
    // reasoning / recited context so it reaches neither the client subtitle
    // nor the avatar.
    if (this.leakedThoughtThisTurn || this.leakedContextThisTurn) return;

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

    // THE gate. It withholds deltas while a bracket / paren group is still
    // open, removes what the policy removes, and flips `severe` the moment
    // the utterance stops being a reply and becomes the model reciting its
    // own input. Nothing downstream sees text this call didn't pass.
    const cleaned = this.turnGate.push(text);
    if (this.turnGate.severe) {
      // Disqualified turn. Same treatment as a thought leak: kill the audio
      // NOW — the gate fires on the first offending group, before the child
      // has heard the recitation play out. The turn resolves to a
      // ContextLeakEvent in handleTurnComplete.
      this.leakedContextThisTurn = true;
      flowOutput("SPEAKER", "context_leak_detected", this.currentTurnTranscript.trim());
      this.callbacks.onSuppressAudio?.();
      return;
    }
    const verdict = this.turnGate.result();
    if (verdict.verdict === "mild" && !this.leakedLeadingTagThisTurn) {
      this.leakedLeadingTagThisTurn = verdict.leaked;
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
    // Disqualified turn — the ContextLeakEvent replaces this event too, so
    // BoardManager never rebuilds from recited context.
    const gated = sanitizeSpokenTurn(this.currentTurnTranscript);
    if (this.leakedContextThisTurn || gated.verdict === "severe") {
      this.leakedContextThisTurn = true;
      return;
    }
    const transcript = gated.speech;
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

    // Disqualified turn: the model recited its input instead of replying.
    // Emit a ContextLeakEvent INSTEAD of SpeechEnd — same contract as the
    // thought leak above. The Coordinator lifts audio suppression, records
    // the recitation on supervisor channels and injects a corrective, but
    // never echoes it back to the model or rebuilds the board from it.
    if (this.useDirectAudio && this.leakedContextThisTurn) {
      const gated = sanitizeSpokenTurn(this.currentTurnTranscript);
      flowOutput("SPEAKER", "context_leak", gated.leaked);
      const event: ContextLeakEvent = {
        type: "context_leak",
        source: "speaker",
        timestamp: Date.now(),
        recited: gated.leaked,
        speech: gated.speech,
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
      const gated = sanitizeSpokenTurn(rawTranscript);
      const transcript = gated.speech;
      const leakedLeadingTag =
        this.leakedLeadingTagThisTurn
        || (gated.verdict === "mild" ? gated.leaked : "");
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
    // Manager gets a chance to rebuild for the interrupted state — unless
    // the turn was already disqualified, in which case there is no speech
    // to report and echoing the fragment is the loop we're breaking.
    if (
      this.useDirectAudio
      && this.currentTurnHadAudio
      && !this.leakedThoughtThisTurn
      && !this.leakedContextThisTurn
    ) {
      const event: SpeechEndEvent = {
        type: "speech_end",
        source: "speaker",
        timestamp: Date.now(),
        transcript: sanitizeSpokenTurn(this.currentTurnTranscript).speech + " [interrupted]",
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
    //
    // `open_app` is the ONE exception: it is a request the server can refuse,
    // so its ack is HELD until routeAppOpen has decided (see holdAppOpenAck).
    // Everything else is acked immediately, exactly as before.
    if (this.provider) {
      const immediate = calls.filter(c => !this.willHoldAck(c));
      if (immediate.length) {
        this.provider.sendToolResponseAsContent(
          immediate.map(c => ({
            id: c.id,
            name: c.name || "unknown",
            response: SPEAKER_TOOL_ACK,
          })),
        );
      }
      for (const call of calls) {
        if (this.willHoldAck(call)) this.holdAppOpenAck(call);
      }
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

  /**
   * Should this call's functionResponse be withheld until the server decides?
   *
   * Only `open_app`, and only when it carries an id to answer. A call with no
   * id cannot be answered later, so it takes the immediate-ack path rather than
   * being held forever.
   */
  private willHoldAck(call: ToolCall): boolean {
    return call.name === "open_app" && !!call.id;
  }

  /**
   * Withhold `open_app`'s functionResponse until `resolveAppOpen` supplies the
   * verdict, with a fail-open backstop.
   *
   * 🚨 THE BACKSTOP IS NOT OPTIONAL. Gemini Live blocks generation while a
   * functionResponse is outstanding, so a hold that never settles is a Speaker
   * that never speaks again — worse than the promise this replaces. If
   * routeAppOpen throws, hangs, or the coordinator simply forgets a path, the
   * timer answers "ok" and the session carries on.
   */
  private holdAppOpenAck(call: ToolCall): void {
    const id = call.id!;
    const existing = this.pendingAppOpenAcks.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      flowNote("SPEAKER", `open_app ack timed out after ${APP_OPEN_ACK_TIMEOUT_MS}ms — answering "ok" so the turn can continue.`);
      // Remember that this one went out blind, so the verdict still reaches the
      // model when it arrives (see timedOutAppOpenAcks).
      this.timedOutAppOpenAcks.add(id);
      this.answerAppOpen(id, SPEAKER_TOOL_ACK);
    }, APP_OPEN_ACK_TIMEOUT_MS);
    this.pendingAppOpenAcks.set(id, { name: call.name || "open_app", timer });
  }

  /**
   * The server settled an `open_app`. Hand the model the real outcome so it can
   * compose its sentence knowing whether the app is actually there.
   *
   * `note` is written FOR the model — it is the same guidance that used to be
   * injected as `[APP OPEN BLOCKED]` after the fact, delivered early enough to
   * change what gets said instead of contradicting it.
   */
  resolveAppOpen(callId: string | undefined, verdict: { opened: boolean; note?: string }): void {
    if (!callId) return;               // student press / Board Manager open — nothing was held
    if (!this.pendingAppOpenAcks.has(callId)) {
      // The backstop already answered this one. The ack cannot be taken back,
      // but the note is still the only thing that tells the model what is on
      // the screen — so deliver it the way every open delivered it before the
      // hold existed. `delete` makes this once-only: routeAppOpen's `finally`
      // settles a second time on every open, and a repeated injection would
      // read to the model as the app having opened twice.
      if (this.timedOutAppOpenAcks.delete(callId) && verdict.note) {
        flowNote("SPEAKER", `open_app verdict arrived after the backstop — sending "${verdict.opened ? "opened" : "refused"}" as context instead.`);
        this.sendContextInjection(verdict.note);
      }
      return;
    }
    this.answerAppOpen(callId, {
      output: verdict.opened ? "opened" : "refused",
      ...(verdict.note ? { detail: verdict.note } : {}),
    });
  }

  /** Send the held response and retire the pending entry. */
  private answerAppOpen(callId: string, response: Record<string, unknown>): void {
    const pending = this.pendingAppOpenAcks.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAppOpenAcks.delete(callId);
    // 🚨 sendToolResponse, NOT sendToolResponseAsContent. The as-content path
    // (sendClientContent, turnComplete:false) resolves the call WITHOUT
    // triggering generation — fine for a 1ms ack that beats the model's own
    // turn end, but after a hold the model has already closed its turn and
    // would simply never speak again. Measured both ways on 2026-08-24;
    // as-content produced total silence, sendToolResponse resumed correctly.
    // See scripts/test-live-toolcall-blocking.ts.
    this.provider?.sendToolResponse([{ id: callId, name: pending.name, response }]);
  }

  /** Drop every held ack (teardown / reconnect) so no timer outlives the session. */
  private clearPendingAppOpenAcks(): void {
    for (const { timer } of this.pendingAppOpenAcks.values()) clearTimeout(timer);
    this.pendingAppOpenAcks.clear();
    this.timedOutAppOpenAcks.clear();
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
        // Through the same gate as the native-audio path — the fallback
        // TTS is just as capable of voicing recited context.
        const gated = sanitizeSpokenTurn(rawText);
        if (gated.verdict === "severe") {
          // Disqualified: nothing is spoken, nothing is echoed back.
          flowOutput("SPEAKER", "context_leak", gated.leaked);
          const leak: ContextLeakEvent = {
            type: "context_leak",
            source: "speaker",
            timestamp: now,
            recited: gated.leaked,
            speech: gated.speech,
          };
          this.resetTurnAccumulators();
          return [leak];
        }
        const text = gated.speech || rawText;
        const leakedLeadingTag = gated.verdict === "mild" ? gated.leaked : "";
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
        if (!appId) {
          // No app id to route — nothing will ever settle the held ack, so
          // release it here rather than making the model wait out the backstop.
          if (call.id) this.answerAppOpen(call.id, SPEAKER_TOOL_ACK);
          return [];
        }
        const event: AppOpenRequestedEvent = {
          type: "app_open_requested",
          source: "speaker",
          timestamp: now,
          appId,
          data: asString(args.data),
          // Carries the held functionResponse through to routeAppOpen, which
          // answers it with the real verdict. Only set when we actually held.
          toolCallId: this.willHoldAck(call) ? call.id : undefined,
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
