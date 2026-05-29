/* ============================================================================
   HUMOR & SHARED HISTORY  (extends identity-layer.ts)
   ----------------------------------------------------------------------------
   HUMOR  is a high-variance bid: big when it lands AND fits the mood, costly
          when it misfires into a serious moment. Coupled to attunement.
          Teasing is rapport-gated like compliments.

   SHARED HISTORY is the strongest "we have something" signal — and the exact
          mechanism that builds attachment. So it is SESSION-SCOPED: the
          character builds & calls back to moments within a session, then
          forgets. Persistence lives in the LearnerProfile, never the character.
   ========================================================================== */

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// HUMOR — trait, derived style, perception, impulse
// ---------------------------------------------------------------------------

/** 7th genome trait. style is derived from playfulness + warmth + assertiveness. */
export type HumorStyle = "dry" | "silly" | "teasing" | "wry";
export function humorStyle(playfulness: number, warmth: number, assertiveness: number): HumorStyle {
  if (assertiveness > 0.6 && warmth > 0.5) return "teasing";
  if (playfulness > 0.6 && warmth > 0.6) return "silly";
  if (assertiveness > 0.55) return "wry";
  return "dry";
}

export interface HumorFeatures {
  userAttemptedHumor: boolean;
  humorFitMood: number;     // 0 wrong moment .. 1 well-timed (vs character's current affect)
  userPlayedAlong: boolean; // reception: did they engage the character's joke
  registeredJoke: boolean;  // did they recognize it WAS a joke (literal-interp signal)
  wasTease: boolean;
  calledBackBit: boolean;   // referenced an established running bit
}

/** Humor impulse. Landing + fit is rewarded; a misfire into a serious moment
 *  costs valence/rapport. Teasing is gated by current rapport. */
export function humorImpulse(h: HumorFeatures, rapportNow: number) {
  let v = 0, a = 0, r = 0; const notes: string[] = [];

  if (h.userAttemptedHumor) {
    const landed = h.humorFitMood;                 // 0..1, the room-reading term
    if (landed > 0.55) { v += 0.7 * landed; a += 0.6 * landed; r += 0.45 * landed; notes.push("joke landed"); }
    else { v -= 0.35 * (1 - landed); r -= 0.3 * (1 - landed); notes.push("joke misfired (wrong moment)"); }

    if (h.wasTease) {
      // affectionate once safe, mean when cold — same gate shape as compliments
      const gate = clamp((rapportNow + 0.1) / 1.0, -0.5, 1);
      r += 0.4 * gate; if (gate <= 0) notes.push("tease landed before there was trust");
    }
    if (h.calledBackBit) { r += 0.5; v += 0.4; notes.push("revived a running bit"); } // inside-joke = strong bond
  }

  // reception (the character was funny): playing along builds warmth;
  // missing that it was a joke is a flag, not a penalty.
  if (h.userPlayedAlong) { v += 0.4; r += 0.35; }
  if (!h.registeredJoke && !h.userAttemptedHumor) notes.push("did not register the joke as a joke");

  return { valence: v, arousal: a, rapport: r, notes };
}

// ---------------------------------------------------------------------------
// SHARED HISTORY — session-scoped moment store + callback selection
// ---------------------------------------------------------------------------

export type MomentKind =
  | "joke" | "disclosure" | "resolved_disagreement" | "shared_interest" | "attuned_moment";

export interface SharedMoment {
  kind: MomentKind;
  summary: string;     // short handle: "the train collection", "the bad pun"
  turnIndex: number;
  weight: number;      // how resonant — drives callback priority + rapport on recall
}

/** SESSION-SCOPED. Created fresh per session; discarded at session end. */
export class SharedHistory {
  private moments: SharedMoment[] = [];
  private bits: Record<string, number> = {}; // running bits -> times revived

  record(m: SharedMoment) {
    this.moments.push(m);
    if (m.kind === "joke") this.bits[m.summary] = (this.bits[m.summary] ?? 0);
  }

  /** Read-only view for prompt assembly. Returns a copy so callers can't mutate. */
  list(): SharedMoment[] {
    return this.moments.slice();
  }

  /** Pick a moment worth referencing now: resonant, not too recent, not overused. */
  selectCallback(turnIndex: number): SharedMoment | null {
    const ranked = this.moments
      .filter((m) => turnIndex - m.turnIndex > 4)            // let it breathe
      .map((m) => ({ m, score: m.weight - 0.05 * (this.bits[m.summary] ?? 0) }))
      .filter((x) => x.score > 0.3)
      .sort((a, b) => b.score - a.score);
    return ranked.length ? ranked[0].m : null;
  }

  reviveBit(summary: string) { this.bits[summary] = (this.bits[summary] ?? 0) + 1; }

  /** Referencing shared history is a strong rapport move; it decays if overused. */
  callbackImpulse(m: SharedMoment) {
    const overuse = this.bits[m.summary] ?? 0;
    const r = clamp(m.weight - 0.15 * overuse, 0, 1) * 0.6;
    return { valence: 0.4 * r, arousal: 0.2, rapport: r };
  }

  /** EXPLICIT: persistence stops here. The character does not carry across sessions. */
  endSession() { this.moments = []; this.bits = {}; }
}

// ---------------------------------------------------------------------------
// New competencies + directive moves
// ---------------------------------------------------------------------------

export type HumorCompetency = "humorProduction" | "humorReception";

export type HumorMove =
  | "attempt_humor"     // tries a joke in its style
  | "tease"             // rapport-gated affectionate tease
  | "callback_moment"   // reference a SharedMoment
  | "run_bit"           // revive an established running bit
  | "attempt_light_joke"; // PROBE for weak humorReception — gentle, unmistakably warm

/** Probe gate for reception practice (literal-interpretation support).
 *  Must be obviously warm and never read as mockery; back off on repeated miss. */
export function shouldProbeReception(
  receptionSkill: number, rapportNow: number, slpGoal: boolean, maxIntensity: number,
): { probe: HumorMove | "none"; intensity: number } {
  if (!slpGoal || rapportNow < 0.25 || receptionSkill > 0.6) return { probe: "none", intensity: 0 };
  const gap = 0.6 - receptionSkill;
  return { probe: "attempt_light_joke", intensity: clamp(lerp(0.15, 0.4, gap), 0, maxIntensity) };
}