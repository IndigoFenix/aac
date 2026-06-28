// server/services/social-bot/live-peer-speaker-agent.ts
//
// Live-audio variant of the AAC-integrated social-trainer peer (decoupled
// hybrid). Implements ISpeakerAgent so the AgentCoordinator can slot it into
// the Speaker position, exactly like the HTTP SocialPeerSpeakerAgent — but the
// reply is authored and spoken by a persistent Gemini Live native-audio session
// (no per-utterance TTS warm-up), while the SAME deterministic DirectedSession
// engine runs IN PARALLEL purely as analyzer/steerer.
//
// Per turn (decoupled — engine off the critical speak path):
//   (a) forward the user's utterance to the live session → it speaks NOW,
//       guided by the standing directive injected after the previous turn;
//   (b) concurrently run DirectedSession.analyzeTurn() → classify the turn,
//       step springs/profile/probe, then inject the directive for the NEXT
//       reply as standing guidance into the live session.
// The live session's actually-spoken line is captured (speech_text_finalized)
// and fed back into the engine via recordPeerReply() so the next analysis sees
// what the peer really said. Engine semantics are identical to handleTurn: the
// directive guiding each reply is a single random draw, reused by the analysis
// that processes the user's response to it.
//
// Constraints mirror the HTTP peer: only USER → DEVICE turns reach the engine
// (context injections / third-party speech are dropped); no student memory.

import { DirectedSession, type AnalysisResult, type TurnUsage } from "./directed-session";
import { buildSocialBotGenAIClient } from "./genai-client";
import { buildLivePeerPrompt } from "./prompt-assembly";
import { extractUserUtterance } from "./peer-speaker-agent";
import type { GeneratedPersona } from "./persona-generator";
import { DEFAULT_SLP_CONFIG, DEFAULT_DIFFICULTY } from "./persona-generator";
import type { SlpConfig } from "./personality-and-challenge";
import type { LanguageLevel } from "@shared/aac-language-level";
import { languageLevelToInt, DEFAULT_LANGUAGE_LEVEL_INT } from "@shared/aac-language-level";
import type { SocialPeerDebugSnapshot, SocialPeerParams } from "@shared/social-bot/debug";
import type { ISpeakerAgent } from "../dual-agent/speaker-interface";
import { SpeakerAgent, type SpeakerOutputEvent, type SpeakerStartConfig } from "../dual-agent/speaker-agent";
import type { LiveUsage } from "../dual-agent/live-provider";
import { flowInput, flowNote } from "../dual-agent/agent-flow-logger";
import {
  COMPETENCY_LABEL,
  type BotStatePayload,
  type Competency,
  type CompetencySnapshot,
  type SessionReport,
  type SharedMomentSummary,
} from "@shared/social-bot/state";

export interface LiveSocialPeerCallbacks {
  /** Speech lifecycle events from the live session — same bus shape the real
   *  Speaker emits, routed to the Coordinator's onSpeakerEvent (drives board
   *  rebuilds off the peer's transcript, just like the companion). */
  onEvent: (event: SpeakerOutputEvent) => void;
  /** Native-audio PCM chunks (base64) → Coordinator onSpeakerAudioChunk. */
  onAudioChunk: (data: { mimeType: string; data: string }) => void;
  /** Thought-leak suppression → Coordinator onSpeakerSuppressAudio. */
  onSuppressAudio: () => void;
  /** Director state after construction and after every analyzed turn. The
   *  `text` field carries the peer's spoken caption — the social UI reads its
   *  caption from `social_peer_state.text`, NOT the normal subtitle channel. */
  onState: (state: BotStatePayload) => void;
  /** Per-turn usage from the live SPEAKING session → bill via trackLiveUsage. */
  onLiveUsage?: (usage: LiveUsage) => void;
  /** Per-turn usage from the director's ANALYSIS HTTP call → bill via trackHttpUsage. */
  onAnalysisUsage?: (usage: TurnUsage) => void;
  /** DEBUG-only: full director internals + editable params, each turn. */
  onDebug?: (snapshot: SocialPeerDebugSnapshot) => void;
  /** The user wound the conversation down — wind the session down after the
   *  last spoken line plays out. */
  onConversationEnd?: () => void;
  onError: (error: Error) => void;
}

export interface LiveSocialPeerAgentOptions {
  persona: GeneratedPersona;
  /** Resolved language NAME (e.g. "English", "Hebrew"). */
  languageName: string;
  /** Gemini text model for the director's analysis (HTTP forced-tool) calls. */
  analysisModel: string;
  /** Gemini Live native-audio model that voices the peer. */
  liveModel: string;
  /** Gemini native voice the peer speaks with (distinct from the companion). */
  voiceName: string;
  /** Vertex vs. Google AI Studio for the live session. */
  useVertex: boolean;
  difficulty?: number;
  languageLevel?: LanguageLevel;
  slpConfig?: SlpConfig;
  /** The STUDENT's grammatical gender, so the live peer addresses them with
   *  correct feminine/masculine forms in gendered languages. Omit when unknown. */
  addresseeGender?: "male" | "female";
  compressionTriggerTokens?: number;
  compressionTargetTokens?: number;
  callbacks: LiveSocialPeerCallbacks;
}

export class LiveSocialPeerSpeakerAgent implements ISpeakerAgent {
  private session: DirectedSession | null = null;
  private live: SpeakerAgent | null = null;
  private opened = false;
  private readonly startedAt = Date.now();
  /** Serializes the engine analysis chain — the springs assume ordered turns. */
  private turnChain: Promise<void> = Promise.resolve();
  /** The live session's last finalized spoken line — feeds the SessionReport. */
  private lastReply = "";
  /** Last face state (target/mode/rapport) from the engine — reused so the
   *  spoken caption can update without waiting for a fresh analysis turn. */
  private lastFace: Pick<BotStatePayload, "target" | "mode" | "rapport"> | null = null;
  /** The current turn's spoken caption, accumulated from transcription deltas
   *  and shipped via social_peer_state.text (the social UI's caption source). */
  private currentCaption = "";
  /** The live reply awaiting flush into the engine's history. Pushed at the
   *  start of the NEXT user turn so the conversation log keeps [user, model]
   *  order for the analysis call. */
  private pendingPeerReply: string | null = null;
  /** Set by the coordinator when this press interrupted the peer mid-speech. */
  private pendingInterrupted = false;

  constructor(private readonly opts: LiveSocialPeerAgentOptions) {}

  get isConnected(): boolean {
    return this.opened && !!this.session && !!this.live?.isConnected;
  }

  /** SpeakerStartConfig is ignored — the engine + live session build their own
   *  prompts from the persona. */
  async start(_config?: SpeakerStartConfig): Promise<void> {
    const p = this.opts.persona;
    this.session = new DirectedSession(buildSocialBotGenAIClient(), {
      name: p.name,
      gender: p.gender,
      genome: p.genome,
      identity: p.identity,
      appearance: p.appearance,
      humorStyle: p.humorStyle,
      slp: this.opts.slpConfig ?? DEFAULT_SLP_CONFIG,
      difficulty: this.opts.difficulty ?? DEFAULT_DIFFICULTY,
      model: this.opts.analysisModel,
      language: this.opts.languageName,
      languageLevel: this.opts.languageLevel,
      addresseeGender: this.opts.addresseeGender,
    });

    this.live = new SpeakerAgent("gemini", {
      onEvent: (e) => this.onLiveEvent(e),
      onAudioChunk: (d) => this.opts.callbacks.onAudioChunk(d),
      // Accumulate the spoken caption and ship it via social_peer_state.text
      // (the social UI's caption source). We deliberately do NOT forward to the
      // normal `text` subtitle channel — the social surface ignores it, and it
      // would otherwise leak into the companion's conversation bubble.
      onTranscriptionDelta: (t) => {
        this.currentCaption += t;
        this.emitState();
      },
      onSuppressAudio: () => this.opts.callbacks.onSuppressAudio(),
      onError: (err) => this.opts.callbacks.onError(err),
      onUsage: (u) => this.opts.callbacks.onLiveUsage?.(u),
      onClose: () => flowNote("SPEAKER", "live peer speaking session closed"),
    });

    const systemPrompt = buildLivePeerPrompt(
      p.name, p.gender, p.genome, p.identity, p.humorStyle, this.opts.languageName, this.opts.languageLevel, this.opts.addresseeGender,
    );
    await this.live.start({
      systemPrompt,
      model: this.opts.liveModel,
      // Native-audio, no tools — buildSpeakerToolDeclarations suppresses the
      // whole tool surface for native-audio non-muted, so the peer just talks.
      toolConfig: { useDirectAudio: true, isMutedMode: false, enabledApps: [] },
      useVertex: this.opts.useVertex,
      voiceName: this.opts.voiceName,
      useDirectAudio: true,
      compressionTriggerTokens: this.opts.compressionTriggerTokens,
      compressionTargetTokens: this.opts.compressionTargetTokens,
    });

    this.opened = true;
    flowNote("SPEAKER", `Live social peer started (live=${this.opts.liveModel} analysis=${this.opts.analysisModel} voice=${this.opts.voiceName} peer=${p.name})`);

    const target = this.session.initialFaceTarget();
    this.lastFace = { target, mode: this.session.initialMode(), rapport: target.r };
    this.currentCaption = "";
    this.emitState();

    // Inject the standing directive for the FIRST reply, then wait silently for
    // the student to open the conversation (the prompt forbids greeting first).
    this.live.sendContextInjection(this.session.prepareNextDirective());
    this.emitDebug();
  }

  /** Profile transitions are gated by the coordinator during a social session,
   *  so this shouldn't fire; a stray call just ensures the session exists. */
  async reconnectWithConfig(_config: SpeakerStartConfig): Promise<void> {
    if (!this.session || !this.live) return this.start();
  }

  close(): void {
    // Keep `session` so getReport() still works after close.
    this.opened = false;
    try { this.live?.close(); } catch {}
    this.live = null;
  }

  /** Mark the upcoming turn as a turn-taking violation (user cut in). */
  noteUserInterruption(): void {
    this.pendingInterrupted = true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  sendUserTurn(text: string): void {
    if (!this.opened || !this.session || !this.live) return;
    flowInput("SPEAKER", "user_turn", text);
    const utterance = extractUserUtterance(text);
    if (!utterance) {
      flowNote("SPEAKER", `live peer dropped non-user-utterance turn: "${text.slice(0, 80)}"`);
      return;
    }
    const interrupted = this.pendingInterrupted;
    this.pendingInterrupted = false;

    // Flush the previous spoken reply into the engine's history BEFORE this
    // turn's analysis pushes the new user turn — preserves [user, model] order.
    if (this.pendingPeerReply) {
      this.session.recordPeerReply(this.pendingPeerReply);
      this.pendingPeerReply = null;
    }

    // (a) Speak NOW via the live session, using the standing directive.
    this.live.sendUserTurn(utterance);

    // (b) Analyze concurrently (serialized) and re-arm the directive.
    this.turnChain = this.turnChain
      .then(() => this.runAnalysis(utterance, interrupted))
      .catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error("[LiveSocialPeerSpeakerAgent] analysis failed:", e.message);
        this.opts.callbacks.onError(e);
      });
  }

  /** The engine consumes only user turns; ambient context is dropped (the live
   *  session manages its own conversational context). */
  sendContextInjection(text: string): void {
    flowInput("SPEAKER", "context", `(live peer — dropped) ${text.slice(0, 80)}`);
  }

  /** No student memory: the session starts fresh from the generated persona. */
  sendConversationHistory(_turns: Array<{ role: "user" | "model"; text: string }>): void {
    flowNote("SPEAKER", "live peer ignored conversation-history replay (no student memory)");
  }

  setDebugSessionContext(sessionId: string, debugMode: boolean, _agentLabel?: string): void {
    this.live?.setDebugSessionContext(sessionId, debugMode, "SOCIAL-PEER-LIVE");
  }

  // -------------------------------------------------------------------------
  // Live session events
  // -------------------------------------------------------------------------

  private onLiveEvent(event: SpeakerOutputEvent): void {
    if (event.type === "speech_start") {
      // New turn — reset the caption so deltas accumulate fresh.
      this.currentCaption = "";
    } else if (event.type === "speech_text_finalized" && typeof event.transcript === "string") {
      // Capture the spoken line: feeds the next analysis (contingency) + the
      // SessionReport, and finalizes the caption (in case deltas under-ran).
      const t = event.transcript.trim();
      if (t) {
        this.lastReply = t;
        this.pendingPeerReply = t;
        this.currentCaption = t;
        this.emitState();
      }
    }
    // Forward all events to the coordinator — same handling the HTTP peer's
    // manually-emitted speech events already get (board rebuild, echoes, etc.).
    this.opts.callbacks.onEvent(event);
  }

  /** Ship the current face + spoken caption to the client as social_peer_state. */
  private emitState(): void {
    if (this.lastFace) this.opts.callbacks.onState({ ...this.lastFace, text: this.currentCaption });
  }

  // -------------------------------------------------------------------------
  // Engine analysis (off the critical speak path)
  // -------------------------------------------------------------------------

  private async runAnalysis(utterance: string, interrupted: boolean): Promise<void> {
    if (!this.opened || !this.session) return;
    let result: AnalysisResult;
    try {
      result = await this.session.analyzeTurn(utterance, {
        eyeContact: false,
        interrupted,
        responseLatencyMs: 0,
        backchannel: false,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[LiveSocialPeerSpeakerAgent] director analysis failed:", e.message);
      this.opts.callbacks.onError(e);
      return;
    }
    if (result.usage) this.opts.callbacks.onAnalysisUsage?.(result.usage);
    if (!this.opened || !this.live) return; // closed while the call was in flight

    flowNote(
      "SPEAKER",
      `live peer engine: mode=${result.mode} r=${result.vector.rapport.toFixed(2)} v=${result.vector.valence.toFixed(2)} ` +
        `move=${result.ext.identityMove ?? "-"} probe=${result.ext.probe ?? "-"}`,
    );
    this.emitDebug();

    // Face update from the engine. Keep the current caption (the spoken line is
    // owned by the live session and updates via transcription deltas) so this
    // doesn't blank it mid-utterance.
    this.lastFace = { target: result.faceTarget, mode: result.mode, rapport: result.vector.rapport };
    this.emitState();

    // Re-arm: inject the directive for the peer's NEXT reply as standing
    // guidance. turnComplete=false → buffers without provoking a turn.
    this.live.sendContextInjection(result.guidance);

    if (result.ending) {
      flowNote("SPEAKER", "live peer detected end-of-conversation — signaling session wind-down");
      this.opts.callbacks.onConversationEnd?.();
    }
  }

  // -------------------------------------------------------------------------
  // Debug snapshot + report (mirror the HTTP peer)
  // -------------------------------------------------------------------------

  private buildParamsSnapshot(): SocialPeerParams {
    const p = this.opts.persona;
    const slp = this.opts.slpConfig ?? DEFAULT_SLP_CONFIG;
    return {
      name: p.name,
      gender: p.gender,
      archetype: p.archetype,
      genome: { ...p.genome },
      interests: { ...p.identity.interests },
      stances: Object.fromEntries(
        Object.entries(p.identity.stances).map(([k, v]) => [k, { position: v.position, conviction: v.conviction }]),
      ),
      humorStyle: p.humorStyle,
      difficulty: this.opts.difficulty ?? DEFAULT_DIFFICULTY,
      languageLevelInt: this.opts.languageLevel ? languageLevelToInt(this.opts.languageLevel) : DEFAULT_LANGUAGE_LEVEL_INT,
      slp: {
        goalDimensions: [...slp.goalDimensions],
        lockedDimensions: [...slp.lockedDimensions],
        maxChallengeIntensity: slp.maxChallengeIntensity,
        challengeRatio: slp.challengeRatio,
      },
      model: this.opts.analysisModel,
    };
  }

  getDebugSnapshot(): SocialPeerDebugSnapshot | null {
    if (!this.session) return null;
    return { params: this.buildParamsSnapshot(), live: this.session.debugLive() };
  }

  private emitDebug(): void {
    if (!this.opts.callbacks.onDebug) return;
    const snap = this.getDebugSnapshot();
    if (snap) this.opts.callbacks.onDebug(snap);
  }

  getReport(): SessionReport {
    const inspect = this.session?.inspect();
    const competencyKeys = Object.keys(COMPETENCY_LABEL) as Competency[];
    const competencies: CompetencySnapshot[] = inspect
      ? competencyKeys.map((c) => ({
          competency: c,
          value: inspect.profile.skills[c].value,
          samples: inspect.profile.skills[c].samples,
        }))
      : [];
    const moments: SharedMomentSummary[] = inspect
      ? inspect.moments.map((m) => ({ kind: m.kind, summary: m.summary, weight: m.weight }))
      : [];
    return {
      characterName: this.opts.persona.name,
      durationMs: Date.now() - this.startedAt,
      turnIndex: inspect?.turnIndex ?? 0,
      finalMode: (inspect?.mode as BotStatePayload["mode"]) ?? "NEUTRAL",
      finalRapport: inspect?.vector.rapport ?? 0,
      competencies,
      moments,
      feedbackSummary: this.lastReply,
    };
  }
}
