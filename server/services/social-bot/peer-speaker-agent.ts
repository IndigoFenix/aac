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
import { DEFAULT_SLP_CONFIG, DEFAULT_DIFFICULTY } from "./persona-generator";
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
  onError: (error: Error) => void;
}

export interface SocialPeerAgentOptions {
  persona: GeneratedPersona;
  /** Resolved language NAME (e.g. "English", "Hebrew"). */
  languageName: string;
  /** Gemini text model for the director's forced-tool calls. */
  model: string;
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
      slp: DEFAULT_SLP_CONFIG,
      difficulty: DEFAULT_DIFFICULTY,
      model: this.opts.model,
      language: this.opts.languageName,
    });
    this.opened = true;
    flowNote("SPEAKER", `Social peer director started (model=${this.opts.model}, peer=${p.name})`);
    const target = this.session.initialFaceTarget();
    this.opts.callbacks.onState({
      target,
      mode: this.session.initialMode(),
      rapport: target.r,
    });
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
    this.turnChain = this.turnChain
      .then(() => this.runTurn(utterance))
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

  private async runTurn(utterance: string): Promise<void> {
    if (!this.opened || !this.session) return;
    let result: TurnResult;
    try {
      result = await this.session.handleTurn(utterance);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error("[SocialPeerSpeakerAgent] director turn failed:", e.message);
      this.opts.callbacks.onError(e);
      return;
    }
    if (result.usage) this.opts.callbacks.onUsage?.(result.usage);
    if (!this.opened) return; // closed while the LLM call was in flight

    // Face first — the client starts lerping while TTS spins up
    // (mirrors the standalone relay's bot_state-before-audio ordering).
    this.opts.callbacks.onState({
      target: result.faceTarget,
      mode: result.mode,
      rapport: result.vector.rapport,
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
