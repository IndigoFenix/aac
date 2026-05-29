/* ============================================================================
   CONVERSATION DIRECTOR
   ----------------------------------------------------------------------------
   The deterministic core. The LLM is a service it calls, never the decider.

       client signals ─┐
                        ├─► DIRECTOR ──► response directive ──► LLM (express)
       LLM perception ─┘     │
                          affect springs + context trackers (auditable state)

   Per turn, ONE LLM call does two jobs: it classifies the user's turn (forced
   function call -> UserTurnFeatures) AND generates the reply under the directive
   computed from the PREVIOUS turn. The classification updates the engine for the
   NEXT directive. The one-turn lag is intentional — mood has momentum.

   Stub boundaries are marked LLM_CALL and CLIENT_SIGNAL. Wire those to your
   interactive agent and your MediaPipe/VAD layer respectively.
   ========================================================================== */

// ---------------------------------------------------------------------------
// 1. THE TWO CONTRACTS
// ---------------------------------------------------------------------------

/** PERCEPTION (LLM -> director). Only the *pragmatic* features the model is
 *  uniquely good at. Perceptual signals (gaze, interruption, latency) do NOT
 *  live here — they come off the client and merge in separately. */
export interface UserTurnFeatures {
  wasQuestion: boolean;
  contingency: number;   // 0..1  how much it built on the character's last turn
  disclosure: number;    // 0..1  did the user reveal something about themselves
  topicShift: number;    // 0..1  abruptness of subject change
  addressedBid: boolean; // did it answer the open bid the character just made?
  repairAttempt: boolean;// apology / circling back after a misstep
  userAffect: { valence: number; arousal: number }; // -1..1, read from text+prosody
}

/** Hard perceptual signals straight from the client. No LLM involved. */
export interface ClientSignals {
  eyeContact: boolean;
  interrupted: boolean;
  responseLatencyMs: number; // long gaps read as disengagement
  backchannel: boolean;      // "mm-hm", nods while character spoke
}

/** EXPRESSION (director -> LLM). How to respond, never the words themselves. */
export interface ResponseDirective {
  tone: "warm" | "neutral" | "flat" | "playful" | "guarded" | "curt";
  energy: number;            // 0..1 -> TTS rate/pitch, avatar liveliness
  pragmaticMove:
    | "open_bid"          // emit something the user must respond to
    | "follow_up"         // build on what they said
    | "answer_then_bid"   // reciprocate, then hand the turn back
    | "disclose"          // give something of itself (balance fix)
    | "minimal"           // short, low-effort (withdrawn)
    | "repair";           // de-escalate / warm back up
  gaze: "engaged" | "intermittent" | "averted" | "sleepy";
  lengthHint: "brief" | "normal";
  mayDisclose: boolean;
}

// ---------------------------------------------------------------------------
// 2. THE AFFECT CORE (compact spring-damper; see AffectEngine for full version)
// ---------------------------------------------------------------------------

type AxisState = { x: number; vel: number };
type Vector = { valence: AxisState; arousal: AxisState; rapport: AxisState };
const DT = 0.04, NEG_RAPPORT_BIAS = 2.0;
const SPRING = {
  valence: { k: 2.2 ** 2, c: 2 * 0.65 * 2.2 },
  arousal: { k: 2.6 ** 2, c: 2 * 0.60 * 2.6 },
  rapport: { k: 0.7 ** 2, c: 2 * 0.90 * 0.7 },
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function stepAxis(key: keyof Vector, s: AxisState, baseline: number, kick: number): AxisState {
  const { k, c } = SPRING[key];
  let imp = kick;
  if (key === "rapport" && imp < 0) imp *= NEG_RAPPORT_BIAS;
  let vel = s.vel + imp;
  vel = clamp(vel + (-k * (s.x - baseline) - c * vel) * DT, -8, 8);
  return { x: clamp(s.x + vel * DT, -1, 1), vel };
}

// ---------------------------------------------------------------------------
// 3. CONTEXT LAYER — makes the same action worth more/less by situation.
//    This is what defeats question-spamming: gain decays and can go negative.
// ---------------------------------------------------------------------------

interface Trackers {
  askShare: number;     // EMA of ask-vs-disclose balance, 0..1 (1 = only asking)
  recentMoves: string[];// for novelty / habituation
}

/** Turn raw features into a state-aware impulse vector (velocity kicks). */
function contextualImpulse(f: UserTurnFeatures, sig: ClientSignals, t: Trackers) {
  // base value of the move
  let v = 0, a = 0, r = 0;

  // CONTINGENCY: responding to the character's last turn is the high-value act.
  // A question that ignored the character's bid is worth little or negative.
  const responsive = f.contingency - (f.wasQuestion && !f.addressedBid ? 0.4 : 0);
  r += 0.6 * responsive;
  v += 0.4 * responsive;

  // BALANCE: marginal value of asking falls as ask-share skews; past ~0.75 it flips.
  if (f.wasQuestion) {
    const balanceGain = 0.5 * (0.75 - t.askShare); // positive when balanced, negative when lopsided
    r += balanceGain;
  }
  if (f.disclosure > 0) { r += 0.4 * f.disclosure; v += 0.3 * f.disclosure; }

  // NOVELTY: habituate repeated identical moves.
  const moveKey = f.wasQuestion ? "Q" : f.disclosure > 0.3 ? "D" : "x";
  const reps = t.recentMoves.filter((m) => m === moveKey).length;
  const novelty = Math.max(0.3, 1 - 0.2 * reps);
  r *= novelty; v *= novelty;

  // hard signals (cheap, no LLM)
  if (sig.interrupted) { r -= 0.6; a += 0.5; v -= 0.6; }
  if (sig.eyeContact) { v += 0.2; r += 0.15; }
  if (sig.backchannel) { r += 0.2; }
  if (sig.responseLatencyMs > 4000) { a -= 0.5; r -= 0.15; }
  if (f.topicShift > 0.6) { v -= 0.4; r -= 0.4 * f.topicShift; }
  if (f.repairAttempt) { v += 0.55; r += 0.5; }

  // arousal also tracks the user's own energy (attunement input)
  a += 0.4 * f.userAffect.arousal;

  return { valence: v, arousal: a, rapport: r, moveKey };
}

// ---------------------------------------------------------------------------
// 4. MODE GATING (negatives win; hysteresis handled by the dwell counter)
// ---------------------------------------------------------------------------

type Mode = "WITHDRAWN" | "GUARDED" | "PLAYFUL" | "OPEN" | "NEUTRAL";
function classifyMode(v: Vector): Mode {
  const a = v.arousal.x, val = v.valence.x, r = v.rapport.x;
  if (a < -0.3) return "WITHDRAWN";
  if (r < 0.0) return "GUARDED";
  if (val > 0.35 && a > 0.25 && r > 0.25) return "PLAYFUL";
  if (r > 0.2 && val > 0.05) return "OPEN";
  return "NEUTRAL";
}

// ---------------------------------------------------------------------------
// 5. DIRECTIVE POLICY — mode + state -> how to respond. The anti-gaming logic
//    lives here: skewed balance / thin rapport => command a bid or a disclosure.
// ---------------------------------------------------------------------------

function deriveDirective(v: Vector, mode: Mode, t: Trackers): ResponseDirective {
  const energy = clamp((v.arousal.x + 1) / 2, 0.1, 1);
  const base: ResponseDirective = {
    tone: "neutral", energy, pragmaticMove: "follow_up",
    gaze: "engaged", lengthHint: "normal", mayDisclose: true,
  };
  switch (mode) {
    case "WITHDRAWN": return { ...base, tone: "flat", pragmaticMove: "minimal", gaze: "sleepy", lengthHint: "brief", mayDisclose: false };
    case "GUARDED":   return { ...base, tone: "guarded", pragmaticMove: "answer_then_bid", gaze: "intermittent", mayDisclose: false };
    case "PLAYFUL":   return { ...base, tone: "playful", pragmaticMove: "open_bid" };
    case "OPEN":      return { ...base, tone: "warm", pragmaticMove: "follow_up" };
    default:          break;
  }
  // NEUTRAL: if the user has been all-questions, force reciprocity back at them.
  if (t.askShare > 0.7) return { ...base, pragmaticMove: "disclose" };
  return base;
}

// ---------------------------------------------------------------------------
// 6. THE TURN LOOP — one LLM call, classification + generation together.
// ---------------------------------------------------------------------------

export interface TurnPacket { transcript: string; signals: ClientSignals; }
export interface TurnResult { utterance: string; directive: ResponseDirective; mode: Mode; }

export class ConversationDirector {
  private vector: Vector;
  private trackers: Trackers = { askShare: 0.5, recentMoves: [] };
  private directive: ResponseDirective;
  private mode: Mode = "NEUTRAL";

  constructor(
    private baseline: { valence: number; arousal: number; rapport: number },
    /** LLM_CALL: your interactive agent. Must (a) generate a reply obeying the
     *  directive, (b) return a forced function call matching UserTurnFeatures. */
    private llm: (args: {
      transcript: string;
      directive: ResponseDirective;
    }) => Promise<{ utterance: string; features: UserTurnFeatures }>,
  ) {
    this.vector = {
      valence: { x: baseline.valence, vel: 0 },
      arousal: { x: baseline.arousal, vel: 0 },
      rapport: { x: baseline.rapport, vel: 0 },
    };
    this.directive = deriveDirective(this.vector, this.mode, this.trackers);
  }

  async handleTurn(turn: TurnPacket): Promise<TurnResult> {
    // (1) ONE call: reply is shaped by the CURRENT directive (from last turn);
    //     classification describes THIS turn (feeds the NEXT directive).
    const { utterance, features } = await this.llm({
      transcript: turn.transcript,
      directive: this.directive,
    });

    // (2) merge hard client signals + classified features into an impulse
    const imp = contextualImpulse(features, turn.signals, this.trackers);

    // (3) step the springs
    this.vector = {
      valence: stepAxis("valence", this.vector.valence, this.baseline.valence, imp.valence),
      arousal: stepAxis("arousal", this.vector.arousal, this.baseline.arousal, imp.arousal),
      rapport: stepAxis("rapport", this.vector.rapport, this.baseline.rapport, imp.rapport),
    };

    // (4) update trackers (balance EMA + novelty window)
    const askSignal = features.wasQuestion ? 1 : features.disclosure > 0.3 ? 0 : this.trackers.askShare;
    this.trackers.askShare = 0.7 * this.trackers.askShare + 0.3 * askSignal;
    this.trackers.recentMoves = [...this.trackers.recentMoves, imp.moveKey].slice(-6);

    // (5) recompute mode + directive for the NEXT turn
    this.mode = classifyMode(this.vector);
    this.directive = deriveDirective(this.vector, this.mode, this.trackers);

    // (6) the feature record is your scoring log — aggregate at session end for
    //     responsiveness / balance / attunement / recovery pointers.
    return { utterance, directive: this.directive, mode: this.mode };
  }

  /** Snapshot for an SLP-facing trace / debugging. */
  inspect() {
    return {
      valence: +this.vector.valence.x.toFixed(2),
      arousal: +this.vector.arousal.x.toFixed(2),
      rapport: +this.vector.rapport.x.toFixed(2),
      mode: this.mode,
      askShare: +this.trackers.askShare.toFixed(2),
    };
  }
}