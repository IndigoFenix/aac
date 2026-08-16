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
// PER-AUTHOR ATTENTION — the end of the spark singleton
// ---------------------------------------------------------------------------
//
// THERE IS MORE THAN ONE SPARK NOW (multi-entity-conversations.md §3f). Two
// students on two devices share one sim, and each has their own gaze, their own
// engaged creature and their own indicated thing. A single `sparkFocus` on the
// session was the same singleton bug as `PLAYER_CREATURE_ID`: whichever device
// hovered last owned everybody's attention, and the other child's engagement
// vanished under it.
//
// ONE PAIRING LAW. A draw is only ever read together with the engagement OF THE
// SAME AUTHOR. Crossing them is the failure this shape exists to make
// unwritable: Ann engages Mara, Ben looks at the bread, and a crossed read sends
// MARA to eat — an instruction neither child gave. So both halves are keyed by
// author, and `attentionBonusOf` reaches into ONE author's row for both.
//
// THE ASYMMETRY, DELIBERATELY KEPT VISIBLE. Engagement is durable (it decays
// over `engageDecayS` and survives looking away), so every author's row is
// meaningful on every device. A DRAW is the live local gaze — hovers are not on
// the wire, so in practice a device holds a draw for the LOCAL author only, and
// the remote rows stay empty. That is a WIRING fact, not a shape fact: the map
// is per-author because the pairing law demands it, and a future hover-sync
// fills the other rows without touching a line of this file.

/** Every author's ENGAGED creature, keyed by the author's creature id (the
 *  `player[:<personId>]` cid — player-identity.ts). One row per author, one
 *  engaged creature per row: the spark still engages exactly one body at a time,
 *  it just is no longer the world's only spark. The host owns the map and
 *  mutates it, so the alias is the mutable `Map`; every function here takes the
 *  read-only view, which a `Map` satisfies. */
export type AuthorAttention = Map<string, SparkFocus>;

/** Every author's live DRAW, keyed the same way. Sparse by construction — see
 *  THE ASYMMETRY above. */
export type AuthorDraws = Map<string, SparkDraw>;

/** How attentive `cid` is TO ONE AUTHOR's spark — that author's row and nobody
 *  else's. Author A's engagement never answers for author B, which is the whole
 *  point of the map. Pure. */
export function attentivenessOf(
  attention: ReadonlyMap<string, SparkFocus> | null | undefined,
  authorCid: string,
  cid: string,
): number {
  return attentiveness(attention?.get(authorCid) ?? null, cid);
}

/** How attentive `cid` is to ANY spark — the strongest author's hold on it.
 *  For the questions that are about the creature rather than about an author
 *  ("is anybody's attention on this body", the engagement ring): a creature two
 *  children are both looking at is engaged, not half-engaged. Max, so the answer
 *  cannot depend on map order. Pure. */
export function attentivenessAny(
  attention: ReadonlyMap<string, SparkFocus> | null | undefined,
  cid: string,
): number {
  let best = 0;
  if (!attention) return best;
  for (const focus of attention.values()) {
    const a = attentiveness(focus, cid);
    if (a > best) best = a;
  }
  return best;
}

/** The effective-meter bonus ONE author's spark gives `cid`'s template — that
 *  author's draw paired with that author's engagement, never a crossed pair (the
 *  PAIRING LAW above). Pure. */
export function attentionBonusOf(
  draws: ReadonlyMap<string, SparkDraw> | null | undefined,
  attention: ReadonlyMap<string, SparkFocus> | null | undefined,
  authorCid: string,
  cid: string,
  tplKey: string,
): number {
  return attentionBonus(draws?.get(authorCid) ?? null, attention?.get(authorCid) ?? null, cid, tplKey);
}

/** The strongest bonus any author's spark gives `cid`'s template — the drop-in
 *  for the need loop, which asks about a CREATURE and does not care whose gaze
 *  moved it. Walks the ENGAGEMENT rows: no engagement ⇒ no bonus (attentiveness
 *  gates it to zero), so an author holding only a draw can be skipped. Max, so
 *  it is order-independent. Pure. */
export function attentionBonusAny(
  draws: ReadonlyMap<string, SparkDraw> | null | undefined,
  attention: ReadonlyMap<string, SparkFocus> | null | undefined,
  cid: string,
  tplKey: string,
): number {
  let best = 0;
  if (!attention) return best;
  for (const authorCid of attention.keys()) {
    const b = attentionBonusOf(draws, attention, authorCid, cid, tplKey);
    if (b > best) best = b;
  }
  return best;
}

/** A conversation member as this module needs to read it — `ConvoMember`
 *  (dialogue/conversation.ts) satisfies it structurally. Taken by shape rather
 *  than by import because the import direction runs dialogue → behavior, and one
 *  helper is not worth reversing it. */
export interface EngagedMember {
  id: string;
  /** 0..1 — how much of this member's attention the conversation holds. */
  engagement: number;
}

/**
 * How much of `targetCid`'s attention `authorCid` holds right now, 0..1 — the
 * ONE question the response gates ask, answered from whichever record actually
 * knows.
 *
 * ROSTER-IS-ENGAGEMENT (§3f). Being in a conversation together IS mutual
 * attention. Nobody stares at the person they are talking to, and a member who
 * glanced at the floor mid-sentence has not stopped listening — so for two
 * FELLOW MEMBERS the roster answers FIRST, with the target's own
 * `ConvoMember.engagement` (`DEFAULT_ENGAGEMENT` = 1 on joining, decayed by the
 * idle-lapse rule), never the spark's fading hover. Reading the hover there is
 * exactly the bug this replaces: it made a listener less and less answerable the
 * longer the conversation went on.
 *
 * The SPARK answers second, and only outside a shared roster — there the gaze is
 * the only evidence of attention there is, and it is the author's OWN row that
 * is read (the pairing law).
 *
 * And when neither record knows them, the answer is ZERO — THE NO-AMBIENT-
 * RESPONSE LAW survives intact. A creature the author never engaged and never
 * sat down with is not listening, is not nudged, and is never pulled into
 * somebody else's business. That was the "way too strong" failure, and no
 * amount of roster machinery is allowed to reintroduce it.
 *
 * Both branches are clamped to 0..1: a roster row carrying a wild value is a
 * caller's bug, and `attend` already refuses to let one through. Pure.
 */
export function engagementToward(
  members: readonly EngagedMember[] | null | undefined,
  attention: ReadonlyMap<string, SparkFocus> | null | undefined,
  authorCid: string,
  targetCid: string,
): number {
  if (members && members.length) {
    const target = members.find((m) => m.id === targetCid);
    // BOTH must be in the circle: a roster says nothing about the hold an
    // outsider has on one of its members, so that pair falls to the spark.
    if (target && members.some((m) => m.id === authorCid)) return clamp01(target.engagement);
  }
  return clamp01(attentivenessOf(attention, authorCid, targetCid));
}

function clamp01(v: number): number {
  return v < 0 || Number.isNaN(v) ? 0 : v > 1 ? 1 : v;
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
