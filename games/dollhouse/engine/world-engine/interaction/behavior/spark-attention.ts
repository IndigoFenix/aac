// shared/world-engine/interaction/behavior/spark-attention.ts
//
// SOFT CONTROL VIA THE SPARK — the attention field (planning-docs/games/world-engine/
// attention-spark.md). The player's spark is an ABSTRACT CREATURE: pointing or
// looking at a thing to draw others' interest to it is a behavior every creature
// shares, not a spark power. Hovering near an object draws nearby creatures'
// attention TOWARD THE MOTIVE THAT OBJECT SERVES; hovering near a creature
// amplifies that one creature's responsiveness for a short while. This never
// COMMANDS — it only nudges a need that is already climbing to fire a little
// early, and the fulfilment then rides the ordinary self-assigned-command path
// (a need IS a self-assigned command — action-consolidation S2).
//
// This module is PURE and time-passed-in: the attention field is spatial and
// timed, so it lives in the SESSION layer (like needMeters/pursuits), never on
// CreatureState (creatures.ts is coordinate-free and time-free). The host owns
// the wiring; this owns the mapping, the ramp/decay, and the meter bonus.
//
// THE AFFORDANCE LAW (feedback: needs bind to affordances). The motive an object
// draws attention to is read from the object's OWN FUNCTION — a bed affords rest
// (energy), a toy affords play (fun), food affords eating (hunger) — never from a
// special-cased fixture table beyond reading the affordance/station role it
// already declares.

/** The motive keys the attention field can nudge — each is the PREFIX of a
 *  meter-driven need template's key (hunger:<good>, thirst:water, energy, waste,
 *  hygiene, fun). Stock/mess motives (provision, tidy) don't respond to a meter
 *  bonus and are out of this (Phase-1) slice by construction. */
export type AttentionMotive = "hunger" | "thirst" | "energy" | "waste" | "hygiene" | "fun";

/** The semantic signals a hovered object exposes, read from the spec side
 *  (propertiesOf / the concept library / the station registry). The host fills
 *  these in from the concrete world object; the mapping below is pure. */
export interface ObjectAffordances {
  /** Concept-library affordance tags on the object's glyph head ("play"…). */
  affords: readonly string[];
  /** Object properties (propertiesOf): "food", "toy", "clothing"… */
  properties: readonly string[];
  /** The built-world station kind, when the object is a fixture ("bed",
   *  "toilet", "bath", "table", "bowl", "barrel", "well"…); null for a loose prop. */
  stationKind: string | null;
  /** Is this a WATER good (drink)? Water is a good key, not an object property,
   *  so it is passed as its own signal. */
  isWater: boolean;
}

/**
 * The motive a hovered object draws attention to, or null when the object serves
 * no meter-driven motive (a wall, a chest — a container's fill-check is a stock
 * motive, deferred). Affordance-first: the object's own function wins over its
 * fixture role, so a toy left on a table draws PLAY, not dining.
 */
export function objectMotive(a: ObjectAffordances): AttentionMotive | null {
  if (a.affords.includes("play") || a.properties.includes("toy")) return "fun";
  if (a.isWater) return "thirst";
  if (a.properties.includes("food")) return "hunger";
  switch (a.stationKind) {
    case "bed":
      return "energy";
    case "toilet":
      return "waste";
    case "bath":
      return "hygiene";
    case "barrel":
    case "well":
      return "thirst";
    case "table":
    case "bowl":
      return "hunger"; // the dining surface — food is served here
    default:
      return null;
  }
}

/** The spark's current DRAW: attention aimed at a target. `motive` null = a bare
 *  AREA (a ground point the spark rested on, no object) — used only by the
 *  idle-move nudge, never by the need bonus (which requires a motive). */
export interface SparkDraw {
  motive: AttentionMotive | null;
  x: number;
  y: number;
  /** The SPECIFIC world object the attention rests on (null for a bare area) —
   *  a fired act targets THIS instance, never "the nearest of its kind". */
  objId: string | null;
  /** 0..1 — ramps up while hovering, decays when the gaze leaves. */
  strength: number;
}

/** The spark's current ENGAGEMENT: the ONE creature the player has drawn into
 *  attention — by talking to it, hovering it, or oscillating gaze between it and
 *  a point. Engagement is THE gate: only an engaged creature responds to what the
 *  spark then indicates, and it responds STRONGLY. An unengaged creature is never
 *  pulled in (that was the "way too strong" failure). Decays over a few seconds
 *  so the engagement outlives the gaze that set it ("look at them, then point"). */
export interface SparkFocus {
  cid: string;
  /** 0..1 — ramps while hovered / set to 1 by a conversation or an oscillation,
   *  decays once the player disengages. */
  strength: number;
}

// Tunables. The model: ENGAGEMENT gates, and an engaged creature responds
// clearly. There is NO ambient response — a creature the player hasn't engaged
// never reacts, so nobody is pulled in from outside or interrupted.
export const SPARK = {
  /** Seconds of steady hover on a creature to reach full engagement. */
  rampS: 0.3,
  /** Seconds for an object DRAW to fade once the gaze leaves it. */
  drawDecayS: 2,
  /** Seconds for ENGAGEMENT to fade after the player disengages — long enough to
   *  "leave a conversation, then select an object" and have it still land. */
  engageDecayS: 6,
  /** Effective-meter bonus at full strength AND full engagement. Deliberately
   *  STRONG (≥ the fire threshold of 1): an engaged creature the player points a
   *  thing at should actually go use it, not merely feel a nudge. */
  bonus: 1,
} as const;

/** Ramp a strength toward 1 (one steady hover frame). Pure. */
export function ramp(prev: number, dt: number): number {
  return Math.min(1, prev + dt / SPARK.rampS);
}

/** Decay a strength toward 0 over `overS` seconds. Pure. */
export function decayStrength(prev: number, dt: number, overS: number): number {
  return Math.max(0, prev - dt / overS);
}

/**
 * How ATTENTIVE creature `cid` is to the spark right now, 0..1 — just its
 * ENGAGEMENT. Only the one engaged creature is attentive; everyone else is 0, so
 * an object the spark indicates reaches exactly the creature the player selected
 * and no one else. Pure.
 */
export function attentiveness(engage: SparkFocus | null, cid: string): number {
  return engage && engage.cid === cid && engage.strength > 0 ? engage.strength : 0;
}

/**
 * The effective-meter bonus for creature `cid`'s template `tplKey`. Zero unless a
 * motive draw is live, the template belongs to the drawn motive, AND the creature
 * is ENGAGED (attentiveness > 0). No distance gate: an engaged creature the player
 * points food at should come eat it — firing the need walks it over. Pure.
 */
export function attentionBonus(
  draw: SparkDraw | null,
  engage: SparkFocus | null,
  cid: string,
  tplKey: string,
): number {
  if (!draw || !draw.motive || draw.strength <= 0) return 0;
  if (!tplKey.startsWith(draw.motive)) return 0;
  return SPARK.bonus * draw.strength * attentiveness(engage, cid);
}

// ---------------------------------------------------------------------------
// The ATTENTION-ACTION TABLE — what indicating a thing ASKS OF a creature
// ---------------------------------------------------------------------------

/** What the host knows about an indicated object, beyond its affordances:
 *  transient states, garment-ness, ownership and placement. All spec-side or
 *  session-side reads — the table itself stays pure. */
export interface AttentionTargetInfo extends ObjectAffordances {
  /** Transient state facets on the instance ("dirty", "hot"…). */
  states: readonly string[];
  /** Is the object a garment (wearable)? */
  isClothing: boolean;
  /** No creature/household owns it — free to take. */
  unclaimed: boolean;
  /** A loose prop out of any container (clutter — a tidy candidate). */
  loose: boolean;
  /** A storage container currently below its stock buffer. */
  stockLow: boolean;
}

/** One candidate act. `motive` set = gated by the creature's OWN meter (it
 *  must actually be hungry/tired/… — else it refuses); absent = an anytime
 *  act (wearing clean clothes, taking a free thing, tidying clutter). */
export interface AttentionAction {
  kind:
    | "eat" // food while hungry
    | "drink" // drink while thirsty
    | "play" // toy while bored
    | "sleep" // bed while tired
    | "use" // toilet while needing it
    | "wash" // bath while dirty
    | "washItem" // a dirty ITEM → launder it
    | "wear" // clean clothing, any time
    | "get" // an unclaimed item, any time
    | "tidy" // a loose item, any time
    | "getMore"; // a low stockpile, any time
  motive?: AttentionMotive;
}

/**
 * The ordered candidate acts for an indicated object — first WILLING act wins
 * (the host walks the list, checking each motive-gated act against the
 * creature's meter and falling through to the anytime acts). Empty = the
 * object asks nothing. Affordance-first like objectMotive: the object's own
 * function outranks housekeeping readings, and a dirty thing wants washing
 * before anything else.
 */
export function attentionActions(info: AttentionTargetInfo): AttentionAction[] {
  const acts: AttentionAction[] = [];
  const dirty = info.states.includes("dirty");
  if (dirty) acts.push({ kind: "washItem" });
  const motive = objectMotive(info);
  if (motive && !dirty) {
    const MOTIVE_ACT: Record<AttentionMotive, AttentionAction["kind"]> = {
      hunger: "eat",
      thirst: "drink",
      fun: "play",
      energy: "sleep",
      waste: "use",
      hygiene: "wash",
    };
    acts.push({ kind: MOTIVE_ACT[motive], motive });
  }
  if (info.isClothing && !dirty) acts.push({ kind: "wear" });
  if (info.stockLow) acts.push({ kind: "getMore" });
  if (info.loose && info.unclaimed) acts.push({ kind: "get" });
  if (info.loose) acts.push({ kind: "tidy" });
  return acts;
}
