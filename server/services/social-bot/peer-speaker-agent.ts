// server/services/social-bot/peer-speaker-agent.ts
//
// Director-driven Speaker replacement for the AAC-integrated social
// trainer. Implements ISpeakerAgent so the AgentCoordinator can slot it
// into the Speaker position, but internally it is the SAME deterministic
// engine the standalone game uses: DirectedSession (forced `turn` tool,
// observed-block classification, affect springs, identity moves, ZPD
// challenge probes).
//
// Deliberate constraints (per design):
//   - HTTP ONLY. The director's forced-tool flow needs the chat
//     completion API; the agent runs this path regardless of the
//     session's general AAC speaker mode (live or http).
//   - USER → DEVICE turns are the ONLY input the director consumes.
//     Context injections, system directives, and third-party speech are
//     dropped — the engine models a one-on-one peer conversation with
//     the student. The Coordinator additionally gates non-user speakers
//     before they reach sendUserTurn.
//   - No student memory: the session prefix is built purely from the
//     generated persona; sendConversationHistory is a no-op.

import { DirectedSession, type TurnResult, type TurnUsage } from "./directed-session";
import { buildSocialBotGenAIClient } from "./genai-client";
import type { GeneratedPersona } from "./persona-generator";
import type { LanguageLevel } from "@shared/aac-language-level";
import { DEFAULT_SLP_CONFIG, DEFAULT_DIFFICULTY } from "./persona-generator";
import type { SlpConfig } from "./personality-and-challenge";
import type { SocialPeerDebugSnapshot, SocialPeerParams } from "@shared/social-bot/debug";
import { languageLevelToInt, DEFAULT_LANGUAGE_LEVEL_INT } from "@shared/aac-language-level";
import type { ISpeakerAgent } from "../dual-agent/speaker-interface";
import type { SpeakerStartConfig, SpeakerOutputEvent } from "../dual-agent/speaker-agent";
import type {
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
} from "../dual-agent/agent-events";
import { flowInput, flowOutput, flowNote } from "../dual-agent/agent-flow-logger";
import {
  COMPETENCY_LABEL,
  type BotStatePayload,
  type Competency,
  type CompetencySnapshot,
  type SessionReport,
  type SharedMomentSummary,
} from "@shared/social-bot/state";

// ---------------------------------------------------------------------------
// Input filtering
// ---------------------------------------------------------------------------

/** Coordinator user-turn shapes that represent the STUDENT addressing the
 *  device. Everything else (system directives, guessing directives,
 *  composed-state context) is irrelevant to the director and is dropped.
 *  Returns the raw utterance, or null when the turn isn't a user utterance. */
export function extractUserUtterance(text: string): string | null {
  const trimmed = text.trim();
  const patterns: RegExp[] = [
    // [USER to YOU] "water please"   (button press / direct speech)
    /^\[USER to YOU\]\s*"([\s\S]*)"$/,
    // [BUTTON PRESS] "I want water"  (interpret follow-up re-delivery —
    // tolerate the doubled brackets routeInterpretIntent produces by
    // wrapping the already-bracketed T.tagPress literal)
    /^\[{1,2}BUTTON PRESS\]{1,2}\s*"([\s\S]*)"$/,
    // [TRANSCRIPT] user → device: "hello"  (client user_message path)
    /^\[TRANSCRIPT\] user → device:\s*"([\s\S]*)"$/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) {
      const utterance = m[1].trim();
      return utterance.length > 0 ? utterance : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface SocialPeerCallbacks {
  /** Speech lifecycle events — same bus shape the real Speaker emits. */
  onEvent: (event: SpeakerOutputEvent) => void;
  /** Reply text for the Coordinator's TTS pipeline (peer voice). */
  onSpeakText: (text: string) => void;
  /** Director state after construction and after every turn — the
   *  Coordinator ships it to the client as `social_peer_state`. */
  onState: (state: BotStatePayload) => void;
  /** Per-turn token usage from the director's LLM call. The Coordinator
   *  bills it against the session/student/user via trackHttpUsage. */
  onUsage?: (usage: TurnUsage) => void;
  /** DEBUG-only: full director internals + editable params, after start and
   *  every turn. The Coordinator ships it as `social_peer_debug` in debug mode. */
  onDebug?: (snapshot: SocialPeerDebugSnapshot) => void;
  /** The user wound the conversation down (said goodbye / asked to stop). The
   *  peer's farewell has just been queued; the Coordinator should end the
   *  session after it plays. */
  onConversationEnd?: () => void;
  onError: (error: Error) => void;
}

export interface SocialPeerAgentOptions {
  persona: GeneratedPersona;
  /** Resolved language NAME (e.g. "English", "Hebrew"). */
  languageName: string;
  /** Gemini text model for the director's forced-tool calls. */
  model: string;
  /** Challenge level 0–1; omit for DEFAULT_DIFFICULTY. May be resolved from
   *  the app's startup definition to match the student's readiness. */
  difficulty?: number;
  /** Student's receptive language level (general AAC setting) — caps the
   *  peer's sentence length/complexity. Omit for the default register. */
  languageLevel?: LanguageLevel;
  /** Resolved SLP config — goal/locked dimensions + challenge ceiling, built
   *  from the clinician's per-app defaults and the AI's session focus. Omit
   *  for DEFAULT_SLP_CONFIG (all skills in scope, default ceiling). */
  slpConfig?: SlpConfig;
  /** The STUDENT's grammatical gender, so the peer addresses them with correct
   *  feminine/masculine forms in gendered languages. Omit when unknown. */
  addresseeGender?: "male" | "female";
  callbacks: SocialPeerCallbacks;
}

export class SocialPeerSpeakerAgent implements ISpeakerAgent {
  private session: DirectedSession | null = null;
  private opened = false;
  private readonly startedAt = Date.now();
  /** Serializes turns — the director's springs assume strictly ordered
   *  turn processing, so concurrent presses queue rather than race. */
  private turnChain: Promise<void> = Promise.resolve();
  /** Last in-character line — feeds SessionReport.feedbackSummary. */
  private lastReply = "";

  constructor(private readonly opts: SocialPeerAgentOptions) {}

  get isConnected(): boolean {
    return this.opened && !!this.session;
  }

  /** SpeakerStartConfig is ignored — the director builds its own prompt
   *  (buildSessionPrefix) and always runs the HTTP forced-tool path. */
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
      model: this.opts.model,
      language: this.opts.languageName,
      languageLevel: this.opts.languageLevel,
      addresseeGender: this.opts.addresseeGender,
    });
    this.opened = true;
    flowNote("SPEAKER", `Social peer director started (model=${this.opts.model}, peer=${p.name})`);
    const target = this.session.initialFaceTarget();
    this.opts.callbacks.onState({
      target,
      mode: this.session.initialMode(),
      rapport: target.r,
    });
    this.emitDebug();
  }

  /** Profile transitions never hit the peer (Coordinator gates rest/sleep
   *  during a social session); a stray call just ensures the session exists. */
  async reconnectWithConfig(config: SpeakerStartConfig): Promise<void> {
    if (!this.session) return this.start(config);
  }

  close(): void {
    // Keep `session` so getReport() still works after close — the
    // Coordinator reads the report while tearing the session down.
    this.opened = false;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  sendUserTurn(text: string): void {
    if (!this.opened || !this.session) return;
    flowInput("SPEAKER", "user_turn", text);
    const utterance = extractUserUtterance(text);
    if (!utterance) {
      flowNote("SPEAKER", `peer director dropped non-user-utterance turn: "${text.slice(0, 80)}"`);
      return;
    }
    // Consume any interruption flag the coordinator set for this turn (the
    // user cut in while the peer was speaking, or jumped a handed-over turn).
    const interrupted = this.pendingInterrupted;
    this.pendingInterrupted = false;
    this.turnChain = this.turnChain
      .then(() => this.runTurn(utterance, interrupted))
      .catch(err => {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error("[SocialPeerSpeakerAgent] turn failed:", e.message);
        this.opts.callbacks.onError(e);
      });
  }

  /** The director only consumes user turns — ambient context is dropped. */
  sendContextInjection(text: string): void {
    flowInput("SPEAKER", "context", `(peer director — dropped) ${text.slice(0, 80)}`);
  }

  /** The peer must not see prior session history (no student memory). */
  sendConversationHistory(_turns: Array<{ role: "user" | "model"; text: string }>): void {
    flowNote("SPEAKER", "peer director ignored conversation-history replay (no student memory)");
  }

  setDebugSessionContext(_sessionId: string, _debugMode: boolean, _agentLabel?: string): void {
    // Director logging goes through logLiveSession inside DirectedSession;
    // no provider-level debug context to bind.
  }

  // -------------------------------------------------------------------------
  // Turn execution
  // -------------------------------------------------------------------------

  /** Set by the coordinator before sendUserTurn when this press interrupted
   *  the peer mid-speech or jumped a handed-over turn. Consumed (and reset) on
   *  the next turn so the director can dock turn-taking + lose rapport. */
  private pendingInterrupted = false;

  /** Mark the upcoming turn as a turn-taking violation (user cut in). */
  noteUserInterruption(): void {
    this.pendingInterrupted = true;
  }

  private async runTurn(utterance: string, interrupted: boolean): Promise<void> {
    if (!this.opened || !this.session) return;
    let result: TurnResult;
    try {
      result = await this.session.handleTurn(utterance, {
        eyeContact: false,
        interrupted,
        responseLatencyMs: 0,
        backchannel: false,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[SocialPeerSpeakerAgent] director turn failed:", e.message);
      this.opts.callbacks.onError(e);
      return;
    }
    if (result.usage) this.opts.callbacks.onUsage?.(result.usage);
    if (!this.opened) return; // closed while the LLM call was in flight

    // Short engine summary for the flow log — why the peer replied as it did
    // (mode, affect, the active probe/identity move). The full per-turn engine
    // dump lives in live-session-debug.log ("SOCIAL BOT TURN N engine").
    flowNote(
      "SPEAKER",
      `peer engine: mode=${result.mode} r=${result.vector.rapport.toFixed(2)} v=${result.vector.valence.toFixed(2)} ` +
        `tone=${result.directive.tone} move=${result.ext.identityMove ?? "-"} probe=${result.ext.probe ?? "-"}`,
    );
    this.emitDebug();

    // Face first — the client starts lerping while TTS spins up
    // (mirrors the standalone relay's bot_state-before-audio ordering).
    this.opts.callbacks.onState({
      target: result.faceTarget,
      mode: result.mode,
      rapport: result.vector.rapport,
      text: result.reply.trim(),
    });

    const reply = result.reply.trim();
    if (!reply) return;
    this.lastReply = reply;
    const now = Date.now();

    const startEvent: SpeechStartEvent = {
      type: "speech_start",
      source: "speaker",
      timestamp: now,
      transcript: reply,
    };
    this.opts.callbacks.onEvent(startEvent);

    flowOutput("SPEAKER", "text_finalized", reply);
    const finalizedEvent: SpeechTextFinalizedEvent = {
      type: "speech_text_finalized",
      source: "speaker",
      timestamp: now,
      transcript: reply,
    };
    this.opts.callbacks.onEvent(finalizedEvent);

    // TTS streams out asynchronously via the Coordinator's chain; the
    // synchronous speech_end mirrors HttpSpeakerAgent's behavior.
    this.opts.callbacks.onSpeakText(reply);

    flowOutput("SPEAKER", "speech", reply);
    const endEvent: SpeechEndEvent = {
      type: "speech_end",
      source: "speaker",
      timestamp: Date.now(),
      transcript: reply,
      target: "USER",
    };
    this.opts.callbacks.onEvent(endEvent);

    // The user wound the conversation down — the farewell is now queued for
    // TTS. Tell the Coordinator to end the session once it plays out.
    if (result.ending) {
      flowNote("SPEAKER", "peer detected end-of-conversation — signaling session wind-down");
      this.opts.callbacks.onConversationEnd?.();
    }
  }

  // -------------------------------------------------------------------------
  // Debug snapshot
  // -------------------------------------------------------------------------

  /** The editable parameter set behind this session (debug tool). */
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
      model: this.opts.model,
    };
  }

  /** Full debug snapshot (params + live engine state), or null before start. */
  getDebugSnapshot(): SocialPeerDebugSnapshot | null {
    if (!this.session) return null;
    return { params: this.buildParamsSnapshot(), live: this.session.debugLive() };
  }

  private emitDebug(): void {
    if (!this.opts.callbacks.onDebug) return;
    const snap = this.getDebugSnapshot();
    if (snap) this.opts.callbacks.onDebug(snap);
  }

  // -------------------------------------------------------------------------
  // Session report
  // -------------------------------------------------------------------------

  /** Structured end-of-session report from the director's learner profile.
   *  Same shape the standalone relay ships as `session_report`. */
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
