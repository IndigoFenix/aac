// server/services/social-bot/directed-session.ts
//
// Per-WS-session orchestrator. Owns the persona, the deterministic affect
// state (vector + trackers + mode), the user model, the shared history,
// and the learner profile. Each turn:
//
//   1. Build the prompt (cacheable prefix + volatile tail).
//   2. Call the LLM with the forced `turn` tool.
//   3. Validate the returned `observed` block.
//   4. Run impulses (context + identity + humor), step the springs.
//   5. Update trackers, user model, shared history, learner profile.
//   6. Recompute mode + derive next directive, augment with identity moves
//      and any active probe.
//   7. Return the reply + face params for the relay to render + ship.

import type { GoogleGenAI } from "@google/genai";
import { Type } from "@google/genai";
import { logLiveSession } from "../dual-agent/dual-agent-logger";
import {
  buildSessionPrefix,
  buildTurnTail,
  TURN_TOOL_SCHEMA,
  type DirectiveExtensions,
  type TurnTailInputs,
} from "./prompt-assembly";
import {
  augmentDirective,
  emptyUserModel,
  identityImpulse,
  type CharacterIdentity,
  type ContentFeatures,
  type FullTurn,
  type UserModel,
} from "./identity-layer";
import {
  humorImpulse,
  SharedHistory,
  type HumorFeatures,
  type HumorStyle,
} from "./humor-and-history";
import {
  deriveParams,
  emptyProfile,
  selectChallenge,
  updateProfile,
  type EngineParams,
  type LearnerProfile,
  type PersonalityGenome,
  type SlpConfig,
} from "./personality-and-challenge";
import type {
  ClientSignals,
  ResponseDirective,
  UserTurnFeatures,
} from "./conversation-director";
import type { FaceAppearance, FaceTarget } from "@shared/social-bot/ProceduralFace";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const DT = 0.04;

// ── Spring step (uses EngineParams instead of conversation-director's hardcoded SPRING) ──

type AxisState = { x: number; vel: number };
type Vector = { valence: AxisState; arousal: AxisState; rapport: AxisState };

function stepAxis(
  s: AxisState,
  baseline: number,
  kick: number,
  omega: number,
  zeta: number,
  negBiasIfRapport = 1,
): AxisState {
  const k = omega * omega;
  const c = 2 * zeta * omega;
  const imp = kick < 0 ? kick * negBiasIfRapport : kick;
  let vel = s.vel + imp;
  vel = clamp(vel + (-k * (s.x - baseline) - c * vel) * DT, -8, 8);
  return { x: clamp(s.x + vel * DT, -1, 1), vel };
}

type Mode = "WITHDRAWN" | "GUARDED" | "PLAYFUL" | "OPEN" | "NEUTRAL";
function classifyMode(v: Vector): Mode {
  const a = v.arousal.x, val = v.valence.x, r = v.rapport.x;
  if (a < -0.3) return "WITHDRAWN";
  if (r < 0.0) return "GUARDED";
  if (val > 0.35 && a > 0.25 && r > 0.25) return "PLAYFUL";
  if (r > 0.2 && val > 0.05) return "OPEN";
  return "NEUTRAL";
}

function deriveBaseDirective(
  v: Vector,
  mode: Mode,
  askShare: number,
  balanceFlipAt: number,
): ResponseDirective {
  const energy = clamp((v.arousal.x + 1) / 2, 0.1, 1);
  const base: ResponseDirective = {
    tone: "neutral",
    energy,
    pragmaticMove: "follow_up",
    gaze: "engaged",
    lengthHint: "normal",
    mayDisclose: true,
  };
  switch (mode) {
    case "WITHDRAWN":
      return { ...base, tone: "flat", pragmaticMove: "minimal", gaze: "sleepy", lengthHint: "brief", mayDisclose: false };
    case "GUARDED":
      return { ...base, tone: "guarded", pragmaticMove: "answer_then_bid", gaze: "intermittent", mayDisclose: false };
    case "PLAYFUL":
      return { ...base, tone: "playful", pragmaticMove: "open_bid" };
    case "OPEN":
      return { ...base, tone: "warm", pragmaticMove: "follow_up" };
    default:
      break;
  }
  if (askShare > balanceFlipAt) return { ...base, pragmaticMove: "disclose" };
  return base;
}

// ── Trackers ───────────────────────────────────────────────────────────

interface Trackers {
  askShare: number;
  recentMoves: string[];
}

// ── Context impulse (re-implemented locally so it uses EngineParams) ──

function contextualImpulse(
  f: UserTurnFeatures,
  sig: ClientSignals,
  t: Trackers,
  params: EngineParams,
) {
  let v = 0, a = 0, r = 0;
  const responsive = f.contingency - (f.wasQuestion && !f.addressedBid ? 0.4 : 0);
  r += 0.6 * responsive;
  v += 0.4 * responsive;

  if (f.wasQuestion) {
    const balanceGain = 0.5 * (params.balanceFlipAt - t.askShare);
    r += balanceGain;
  }
  if (f.disclosure > 0) {
    r += 0.4 * f.disclosure;
    v += 0.3 * f.disclosure;
  }

  const moveKey = f.wasQuestion ? "Q" : f.disclosure > 0.3 ? "D" : "x";
  const reps = t.recentMoves.filter((m) => m === moveKey).length;
  const novelty = Math.max(0.3, 1 - params.habituationRate * reps);
  r *= novelty;
  v *= novelty;

  if (sig.interrupted) { r -= 0.6; a += 0.5; v -= 0.6; }
  if (sig.eyeContact) { v += 0.2; r += 0.15; }
  if (sig.backchannel) { r += 0.2; }
  if (sig.responseLatencyMs > 4000) { a -= 0.5; r -= 0.15; }
  if (f.topicShift > 0.6) { v -= 0.4; r -= 0.4 * f.topicShift; }
  if (f.repairAttempt) { v += 0.55; r += 0.5; }
  a += 0.4 * f.userAffect.arousal;

  return { valence: v, arousal: a, rapport: r, moveKey };
}

// ── Observed → typed FullTurn (validation + defaults) ─────────────────

function defaulted<T>(x: T | undefined | null, fallback: T): T {
  return x === undefined || x === null ? fallback : x;
}

function parseObserved(raw: any): FullTurn & HumorFeatures {
  const o = (raw && typeof raw === "object") ? raw : {};
  const ua = (o.userAffect && typeof o.userAffect === "object") ? o.userAffect : {};
  return {
    // pragmatic
    wasQuestion: !!o.wasQuestion,
    contingency: clamp(defaulted(o.contingency, 0.5), 0, 1),
    disclosure: clamp(defaulted(o.disclosure, 0), 0, 1),
    topicShift: clamp(defaulted(o.topicShift, 0), 0, 1),
    addressedBid: !!o.addressedBid,
    repairAttempt: !!o.repairAttempt,
    userAffect: {
      valence: clamp(defaulted(ua.valence, 0), -1, 1),
      arousal: clamp(defaulted(ua.arousal, 0), -1, 1),
    },
    // content
    topic: typeof o.topic === "string" && o.topic.length ? o.topic : null,
    stanceProp: typeof o.stanceProp === "string" && o.stanceProp.length ? o.stanceProp : null,
    alignment: clamp(defaulted(o.alignment, 0), -1, 1),
    manner: clamp(defaulted(o.manner, 0.5), 0, 1),
    engagedOurView: !!o.engagedOurView,
    compliment: !!o.compliment,
    complimentSpecific: clamp(defaulted(o.complimentSpecific, 0), 0, 1),
    complimentSincere: clamp(defaulted(o.complimentSincere, 0), 0, 1),
    // humor
    userAttemptedHumor: !!o.userAttemptedHumor,
    humorFitMood: clamp(defaulted(o.humorFitMood, 0.5), 0, 1),
    userPlayedAlong: !!o.userPlayedAlong,
    registeredJoke: !!o.registeredJoke,
    wasTease: !!o.wasTease,
    calledBackBit: !!o.calledBackBit,
  };
}

// ── Public types ───────────────────────────────────────────────────────

export interface TurnResult {
  reply: string;
  faceTarget: FaceTarget;
  mode: Mode;
  vector: { valence: number; arousal: number; rapport: number };
  directive: ResponseDirective;
  ext: DirectiveExtensions;
}

export interface SessionConfig {
  name: string;
  /** Drives gendered language conjugation in the identity prose. */
  gender: "male" | "female";
  genome: PersonalityGenome;
  identity: CharacterIdentity;
  appearance: FaceAppearance;
  humorStyle: HumorStyle;
  slp: SlpConfig;
  difficulty: number;
  /** Gemini text model to use. Defaults to gemini-2.5-flash. */
  model?: string;
  /** Resolved language NAME (e.g. "English"). null = mirror the user. */
  language: string | null;
}

export class DirectedSession {
  private vector: Vector;
  private trackers: Trackers = { askShare: 0.5, recentMoves: [] };
  private mode: Mode = "NEUTRAL";
  private directive: ResponseDirective;
  private userModel: UserModel = emptyUserModel();
  private history: SharedHistory = new SharedHistory();
  private profile: LearnerProfile = emptyProfile();
  private params: EngineParams;
  private scaffolding: number;
  private turnIndex = 0;
  /** Cacheable system prefix (built once at construction). */
  private readonly sessionPrefix: string;
  /** Conversation log (user turn + bot reply pairs) for the LLM. */
  private conversation: Array<{ role: "user" | "model"; text: string }> = [];

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly cfg: SessionConfig,
  ) {
    const { params, scaffolding } = deriveParams(cfg.genome, cfg.difficulty);
    this.params = params;
    this.scaffolding = scaffolding;

    this.vector = {
      valence: { x: params.baseline.valence, vel: 0 },
      arousal: { x: params.baseline.arousal, vel: 0 },
      rapport: { x: params.baseline.rapport, vel: 0 },
    };
    this.directive = deriveBaseDirective(this.vector, this.mode, this.trackers.askShare, params.balanceFlipAt);

    this.sessionPrefix = buildSessionPrefix(cfg.name, cfg.gender, cfg.genome, cfg.identity, cfg.humorStyle, cfg.language);

    // Log the full session prefix once so a debugger can see exactly what
    // persona/identity/safety the LLM is being given. Big block; gated
    // behind its own section so it's easy to grep but doesn't drown the
    // per-turn signal.
    logLiveSession(
      "SOCIAL BOT PROMPT (session prefix)",
      `length=${this.sessionPrefix.length} chars\n${this.sessionPrefix}`,
    );
  }

  /** Initial face target (before any turns) so the client can render at connect. */
  initialFaceTarget(): FaceTarget {
    return this.snapshotFaceTarget();
  }

  initialMode(): Mode {
    return this.mode;
  }

  /**
   * Handle a single user turn.
   *
   * Steps mirror procedural-prompt.md §4 (assembly) + the director loop.
   */
  async handleTurn(
    transcript: string,
    signals: ClientSignals = { eyeContact: false, interrupted: false, responseLatencyMs: 0, backchannel: false },
  ): Promise<TurnResult> {
    this.turnIndex += 1;

    // 1. Decide directive extensions (identity moves + challenge probes) for THIS turn.
    const baseDir = this.directive;
    const withIdentity = augmentDirective(
      baseDir,
      this.cfg.identity,
      this.userModel,
      this.vector.rapport.x,
      this.turnIndex,
    );

    const challenge = selectChallenge(this.profile, this.cfg.slp, this.turnIndex);

    const ext: DirectiveExtensions = {
      identityMove: withIdentity.identityMove,
      topicHint: withIdentity.topicHint,
      stanceHint: withIdentity.stanceHint,
      probe: challenge.probe === "none" ? undefined : challenge.probe,
      probeHint: challenge.dim === "interestEngagement"
        ? Object.entries(this.cfg.identity.interests).sort((a, b) => b[1] - a[1])[0]?.[0]
        : challenge.dim === "assertiveness"
          ? Object.keys(this.cfg.identity.stances)[0]
          : undefined,
    };

    // 2. Build the volatile tail.
    const tail: TurnTailInputs = {
      vector: { valence: this.vector.valence.x, arousal: this.vector.arousal.x, rapport: this.vector.rapport.x },
      mode: this.mode,
      directive: withIdentity,
      ext,
      moments: this.history.list(),
      transcript,
      interrupted: signals.interrupted,
    };
    const turnTail = buildTurnTail(tail);

    // Log the volatile per-turn command we're about to send. This is
    // the dynamic part the director computes — directive + mood + the
    // user's transcript. Useful for diffing "what we told the LLM" with
    // "what the LLM did".
    logLiveSession(
      `SOCIAL BOT TURN ${this.turnIndex} → LLM`,
      `length=${turnTail.length} chars\n${turnTail}`,
    );

    // 3. LLM call — forced `turn` tool.
    const llmReply = await this.callLLM(turnTail);

    // Log the structured reply + observed block exactly as the LLM
    // emitted them. The springs and trackers are about to consume these.
    logLiveSession(
      `SOCIAL BOT TURN ${this.turnIndex} ← LLM`,
      `reply="${llmReply.reply}"\nobserved=${JSON.stringify(llmReply.observed, null, 2)}`,
    );

    // 4. Validate observed.
    const parsed = parseObserved(llmReply.observed);

    // 5. Compute impulses.
    const ci = contextualImpulse(parsed, signals, this.trackers, this.params);
    const ii = identityImpulse(parsed, this.cfg.identity, this.userModel, this.vector.rapport.x, this.turnIndex);
    const hi = humorImpulse(parsed, this.vector.rapport.x);

    const dV = ci.valence + ii.valence + hi.valence;
    const dA = ci.arousal + ii.arousal + hi.arousal;
    const dR = ci.rapport + ii.rapport + hi.rapport;

    // 6. Step springs.
    const sp = this.params.spring;
    this.vector = {
      valence: stepAxis(this.vector.valence, this.params.baseline.valence, dV, sp.valence.omega, sp.valence.zeta),
      arousal: stepAxis(this.vector.arousal, this.params.baseline.arousal, dA, sp.arousal.omega, sp.arousal.zeta),
      rapport: stepAxis(this.vector.rapport, this.params.baseline.rapport, dR, sp.rapport.omega, sp.rapport.zeta, this.params.negRapportBias),
    };

    // 7. Trackers.
    const askSignal = parsed.wasQuestion ? 1 : parsed.disclosure > 0.3 ? 0 : this.trackers.askShare;
    this.trackers.askShare = 0.7 * this.trackers.askShare + 0.3 * askSignal;
    this.trackers.recentMoves = [...this.trackers.recentMoves, ci.moveKey].slice(-6);

    // 8. Record any nominated moment for shared history.
    if ((llmReply.observed as any)?.newMoment) {
      const nm = (llmReply.observed as any).newMoment;
      if (nm.kind && nm.summary) {
        this.history.record({
          kind: nm.kind,
          summary: nm.summary,
          turnIndex: this.turnIndex,
          weight: clamp(Number(nm.weight ?? 0.5), 0, 1),
        });
      }
    }

    // 9. Update learner profile.
    updateProfile(this.profile, {
      contingency: parsed.contingency,
      addressedBid: parsed.addressedBid,
      askShare: this.trackers.askShare,
      disclosed: parsed.disclosure > 0.3,
      affectTracksCharacter: Math.sign(parsed.userAffect.valence) === Math.sign(this.vector.valence.x) && Math.abs(parsed.userAffect.valence) > 0.1,
      repaired: parsed.repairAttempt ? true : null,
      tookOwnStance: !!parsed.stanceProp && Math.abs(parsed.alignment) < 0.6,
      sycophantic: this.userModel.agreementTracking > this.params.sycophancyAt,
      complimentSpecific: parsed.compliment ? parsed.complimentSpecific : null,
      initiatedBid: parsed.disclosure > 0.4 || (parsed.wasQuestion && parsed.contingency < 0.4),
      engagedCharacterInterest: parsed.topic ? (this.cfg.identity.interests[parsed.topic] ?? 0) > 0.4 : null,
    });

    // 10. Recompute mode + base directive for NEXT turn.
    this.mode = classifyMode(this.vector);
    this.directive = deriveBaseDirective(this.vector, this.mode, this.trackers.askShare, this.params.balanceFlipAt);

    // 11. Persist into conversation log so the LLM sees its own prior reply.
    this.conversation.push({ role: "user", text: transcript });
    this.conversation.push({ role: "model", text: llmReply.reply });
    // Cap log length to keep prompt size sane.
    if (this.conversation.length > 30) this.conversation = this.conversation.slice(-30);

    return {
      reply: llmReply.reply,
      faceTarget: this.snapshotFaceTarget(),
      mode: this.mode,
      vector: { valence: this.vector.valence.x, arousal: this.vector.arousal.x, rapport: this.vector.rapport.x },
      directive: this.directive,
      ext,
    };
  }

  /** Snapshot for SessionReport at end. */
  inspect() {
    return {
      mode: this.mode,
      vector: { valence: this.vector.valence.x, arousal: this.vector.arousal.x, rapport: this.vector.rapport.x },
      askShare: this.trackers.askShare,
      profile: this.profile,
      userModel: this.userModel,
      scaffolding: this.scaffolding,
      turnIndex: this.turnIndex,
      moments: this.history.list(),
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private snapshotFaceTarget(): FaceTarget {
    return {
      v: this.vector.valence.x,
      a: this.vector.arousal.x,
      r: this.vector.rapport.x,
      // Smirk derived from playful tone + opinionated assertiveness.
      smirk: this.directive.tone === "playful" ? 0.4 : this.cfg.genome.assertiveness > 0.7 ? 0.2 : 0,
      // Gaze: averted on guarded/withdrawn, slight follow on engaged.
      gx: this.directive.gaze === "averted" ? 0.5 : 0,
      gy: this.directive.gaze === "sleepy" ? 0.3 : 0,
    };
  }

  private async callLLM(turnTail: string): Promise<{ reply: string; observed: unknown }> {
    const model = this.cfg.model || "gemini-2.5-flash";

    // Build contents: prior conversation + the volatile tail as the current user turn.
    const priorContents = this.conversation.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    }));
    const contents = [
      ...priorContents,
      { role: "user" as const, parts: [{ text: turnTail }] },
    ];

    // Stream the generation. For a forced tool call the args usually arrive
    // in one chunk near the end, but using the streaming API:
    //   - lets us start handling the response the moment it lands (vs.
    //     waiting for the SDK's full-response buffer);
    //   - keeps the door open for splitting reply/observed in the future.
    //
    // thinkingBudget: 0 disables Gemini 2.5's deliberation pass for this
    // call. The director already does the deliberation deterministically;
    // letting the model "think" again adds 1-3s of latency for no benefit
    // and sometimes degrades the directive-following.
    const stream = await this.ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: { parts: [{ text: this.sessionPrefix }] },
        thinkingConfig: { thinkingBudget: 0 } as any,
        tools: [
          {
            functionDeclarations: [
              {
                name: TURN_TOOL_SCHEMA.name,
                description: TURN_TOOL_SCHEMA.description,
                parametersJsonSchema: TURN_TOOL_SCHEMA.parametersJsonSchema,
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            // ANY = force a tool call; ALLOWED limits to our single tool.
            mode: "ANY" as any,
            allowedFunctionNames: [TURN_TOOL_SCHEMA.name],
          },
        },
      },
    });

    let fnCall:
      | { name?: string; args?: { reply?: string; observed?: unknown } }
      | undefined;
    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      const found = parts.find((p: any) => p.functionCall)?.functionCall as typeof fnCall;
      if (found) {
        fnCall = found;
        // Atomic tool-call chunk — we have everything we need.
        break;
      }
    }
    if (!fnCall || fnCall.name !== TURN_TOOL_SCHEMA.name || typeof fnCall.args?.reply !== "string") {
      throw new Error(
        `[DirectedSession] Expected forced 'turn' tool call but got: ${JSON.stringify(fnCall).slice(0, 200)}`,
      );
    }
    return {
      reply: fnCall.args.reply,
      observed: fnCall.args.observed,
    };
  }
}
