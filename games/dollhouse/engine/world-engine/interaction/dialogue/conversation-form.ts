// shared/world-engine/interaction/dialogue/conversation-form.ts
//
// HOW A CIRCLE FORMS — who opens, who is let in, where they stand, and which
// circle the camera belongs to.
// (planning-docs/games/world-engine/multi-entity-conversations.md §3f.)
//
// ═══ THE HOST COLLECTS, THIS DECIDES ═════════════════════════════════════════
// Same division of labour as talk-target.ts: the host knows who is nearby, who
// is idle, who is off cooldown and where every body is standing; it hands the
// candidates over and this module answers the question. Nothing here reads a
// world, a clock or a coordinate — an angle and a radius are geometry, not
// position — and nothing here owns randomness. Every stochastic function takes
// an injected seeded stream, so two devices watching the same conversation form
// see the same conversation form.
//
// ═══ WHY FORMATION IS A DRAW ═════════════════════════════════════════════════
// "The nearest two idle NPCs talk" is what the old `runNpcExchange` did, and it
// reads as machinery: the same pair, every nine seconds, forever. The dial that
// should decide who starts talking is the one a person would name — *who is
// lonely, and who is the sort that speaks*. So the opener is a seeded softmax
// over social-need × expressiveness. Softmax and not argmax because the tail has
// to stay live: the quiet creature who occasionally starts something is the
// difference between a town and a clockwork toy.
//
// Joining is the same shape one dial-set down. Overhearing is a CLOSER act than
// starting — you have to be near enough to follow it — and the disposition it
// asks about is openness (quick to connect) lifted by warmth (wants company at
// all), never a relation: a bystander does not necessarily know the people in
// the circle.
//
// ═══ THE RING HAS EXACTLY ONE LAW ════════════════════════════════════════════
// `separateBodies` (stand-points.ts) shoves apart any pair closer than the sum
// of their girths, every frame, forever. A ring that seats bodies inside that
// distance is therefore not a ring — it is a slow-motion explosion. So:
//
//   FOR THE CHOSEN ringR, EVERY NEIGHBOUR PAIR'S CHORD ≥ r_a + r_b + margin.
//
// Chord between two bodies at angular distance Δ on a ring of radius R is
// `2·R·sin(Δ/2)`, so the requirement inverts to `R ≥ (r_a + r_b + margin) /
// (2·sin(Δ/2))` — evaluated for every adjacent pair, and the largest wins. The
// `ringRadius(n)` formula is the FLOOR (a conversational distance, tuned for the
// camera and for how a group of people actually stands); the clearance law is
// the CEILING that a girth mix or a lopsided ring can push past it. A bear in a
// circle of children makes the circle wider. That is not a special case in the
// code; it falls out of one inequality.
//
// ═══ NEVER A DANCE ═══════════════════════════════════════════════════════════
// A newcomer takes the LARGEST ANGULAR GAP and existing members keep the angles
// they already have. Re-optimising the whole circle on every join would look
// like a folk dance and would fight `walkTo` for control of four bodies at once.
// The ring may BREATHE — growing `ringR` moves everyone outward along their own
// spoke — but nobody ever swaps places with anybody.
//
// ═══ WHAT THIS MODULE IS NOT ═════════════════════════════════════════════════
// It holds no state and starts nothing. The cadence (a formation attempt every
// 9 s), the dwell timers, the walk to the slot, the greeting on arrival and the
// dispersal are the host's — `quest-host.ts`'s "GROUP CONVERSATIONS" block,
// phase ⑧, which needs the session's meters, bodies and errand queue and so
// lives inside the host closure rather than in a module of its own. The tunables
// it reads live in `CONV_FORM` below, so the whole shape of a group conversation
// can still be read in one block.

import type { Rng } from "@shared/world-engine/interaction/behavior/willingness.js";
import { isPlayerCid } from "@shared/world-engine/interaction/quest/player-identity.js";

const TWO_PI = Math.PI * 2;
const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);
/** Total-by-construction number reader: this runs on the sim tick over data a
 *  host assembled from live bodies, and a NaN girth must not take a town down. */
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------------------
// The tuning block
// ---------------------------------------------------------------------------

/**
 * Every dial group conversations turn, in one place (the `ARBITRATION` /
 * world-tunables convention). Several are read only by the host glue — they are
 * here because a conversation's shape is one design, and splitting its numbers
 * across two files is how two files end up disagreeing about what a conversation
 * is.
 */
export const CONV_FORM = {
  // ── WHO IS IN ────────────────────────────────────────────────────────────
  /** A bystander this close to the circle's centroid may be drawn in. Tighter
   *  than the host's 6 m pair radius on purpose: OVERHEARING IS A CLOSER ACT
   *  THAN STARTING — you can call across a yard to somebody, but you cannot
   *  follow a conversation you can barely hear. (Host glue: ⑧.) */
  joinRadiusM: 4,
  /** Seconds inside `joinRadiusM` before the join is even rolled. A dwell, not
   *  an instant: walking PAST a conversation is not joining it, and without this
   *  every errand that crosses a circle would roll the dice. (Host glue: ⑧.) */
  joinDwellS: 2,
  /** Roster cap. Five fits the camera span at `ringRadius(5)`, and response urge
   *  is O(n) per utterance, so a circle is also a per-tick cost. PLAYERS ARE
   *  ALWAYS ADMITTED (`mayJoin`) — a child who wants in is never told the room
   *  is full; the cap exists to stop NPCs filling it. */
  maxMembers: 5,
  /** Seconds of every urge under the answer threshold before the circle breaks
   *  up — one bubble TTL of collective disinterest, so the end of a conversation
   *  is visible as the last words fading rather than as bodies teleporting apart.
   *  (Host glue: ⑧.) */
  boreS: 6,
  /** Metres from the centroid at which a member has left, whatever it thinks it
   *  is doing. ≈ the host's 7 m CONVO_RADIUS + 1: a leash slightly longer than
   *  the distance at which a conversation could have started, so drifting a step
   *  while thinking never ejects anybody. (Host glue: ⑧.) */
  driftLeaveM: 8,

  // ── THE OPENER'S SOFTMAX ─────────────────────────────────────────────────
  /**
   * Temperature of the opener draw over `social × expressiveness` (both 0..1, so
   * scores run 0..1). 0.35 puts a lonely, talkative creature (0.81) about 8× the
   * weight of a contented quiet one (0.09) — a clear favourite, with a tail that
   * never closes. Lower it toward 0 and the same creature opens every single
   * conversation; raise it and who speaks first stops meaning anything.
   */
  openerTemp: 0.35,

  // ── THE BYSTANDER'S JOIN ROLL ────────────────────────────────────────────
  /** Join chance for a bystander at rock bottom on both dials. Never 0: a
   *  guarded, cold creature standing in a conversation for two full seconds is
   *  occasionally drawn in anyway, and a hard 0 would make whole personalities
   *  structurally invisible in group scenes. */
  joinBase: 0.05,
  /** Join chance at the top of both dials. Never 1: an ALWAYS-joining bystander
   *  turns every passer-by into a crowd and fills the roster in one pass. Joining
   *  strangers mid-sentence stays something a creature MIGHT do. */
  joinCeil: 0.65,
  /** Openness's share of the span (warmth takes the rest). Openness is literally
   *  the "quick to connect and disclose" dial (personality.ts) — the temperament
   *  that walks up to a conversation in progress — while warmth says only that
   *  company is welcome, so openness leads. Two dials, one weighted sum, in the
   *  same shape as `attend`. */
  joinOpennessShare: 0.6,

  // ── THE RING ─────────────────────────────────────────────────────────────
  /**
   * The FLOOR under the ring radius, by member count. At n=2 this is 1.4 m, i.e.
   * bodies 2.8 m apart — today's conversational pair distance, comfortably inside
   * the host's 3.5 m converse contact gate and nowhere near the ~0.8 m at which
   * `separateBodies` starts pushing. Growth is deliberately sub-linear in visual
   * terms: each extra member adds 0.35 m of radius, which is roughly the arc one
   * more person occupies, so a circle of five is a circle and not a stadium.
   */
  ringRadius: (n: number): number => Math.max(1.4, 0.4 + 0.35 * n),
  /** Breathing room ON TOP of two neighbours' combined girths, so a ring seats
   *  bodies just OUTSIDE the separation rule rather than exactly on its trigger —
   *  float drift and a step of walking slack must not be enough to start a shove.
   *  Small, because a conversation is meant to look close. */
  ringMarginM: 0.15,
  /**
   * Hard ceiling on `ringR`. Half the drift leash: a ring wider than this is a
   * crowd standing in a field, and a member on its rim is one distracted step
   * from lapsing out of the conversation it is standing in. The ceiling binds
   * only when neighbours share an angle (a host that seated two bodies on one
   * spoke), and there the clearance guarantee yields to the leash — that overlap
   * is `separateBodies`' problem, which is exactly what it is for.
   */
  ringMaxRadiusM: 4,

  // ── FOCUS ────────────────────────────────────────────────────────────────
  /** Seconds a conversation stays the camera's / TTS's business after its last
   *  word. Mirrors the host's CHAT_FOCUS_S: long enough for the last bubble to
   *  fade plus a beat, so focus tracks THE FICTION (are they still talking?) and
   *  not the renderer. */
  focusHoldS: 7,
} as const;

// ---------------------------------------------------------------------------
// Who opens
// ---------------------------------------------------------------------------

export interface FormCandidate {
  id: string;
  /** 0..1 social need meter — how much this creature wants company right now. */
  social: number;
  /** 0..1 personality dial — how much this creature says out loud at all. */
  expressiveness: number;
}

/**
 * How much this creature wants to be the one who starts something: social need
 * × expressiveness.
 *
 * A PRODUCT, and both halves earn their place. Need alone would have the
 * loneliest creature in town open every conversation regardless of whether it is
 * the sort that speaks; expressiveness alone would have the chattiest one open
 * them all whether or not it wanted company. Multiplying means a creature has to
 * be both, which is what "the lonely and the talkative start conversations"
 * actually says.
 */
export function openerScore(c: FormCandidate): number {
  return clamp01(finite(c?.social)) * clamp01(finite(c?.expressiveness));
}

/**
 * Who opens a conversation — one seeded softmax draw over `openerScore`.
 *
 * Exactly ONE `rng()` call per invocation whatever the candidate count (and zero
 * when there is nobody), so a host stepping a shared stream stays in step with
 * every device replaying it — the same discipline `arbitrateResponse` keeps.
 * Null means nobody: an empty list, which is not a failure, just a quiet town.
 */
export function pickOpener(cands: readonly FormCandidate[], rng: Rng): string | null {
  if (!cands || cands.length === 0) return null;
  const weights = cands.map((c) => Math.exp(openerScore(c) / CONV_FORM.openerTemp));
  return cands[roulette(weights, rng)]!.id;
}

/**
 * Will a bystander who has stood by the circle for `joinDwellS` join it?
 *
 * `p = joinBase + (joinCeil − joinBase)·(0.6·openness + 0.4·warmth)`, drawn
 * against the injected stream. Strictly monotone in BOTH dials and bounded away
 * from both certainties — see `joinBase` / `joinCeil` for why neither end is
 * allowed to be absolute.
 *
 * Deliberately relation-FREE, unlike `willingnessToJoin` (willingness.ts), which
 * gates being invited to an activity BY SOMEBODY. Nobody asked here: this is a
 * creature deciding whether to insert itself into a conversation among people it
 * may not know, so the only honest inputs are its own dials.
 */
export function bystanderJoins(openness: number, warmth: number, rng: Rng): boolean {
  const disposition =
    CONV_FORM.joinOpennessShare * clamp01(finite(openness)) +
    (1 - CONV_FORM.joinOpennessShare) * clamp01(finite(warmth));
  const p = CONV_FORM.joinBase + (CONV_FORM.joinCeil - CONV_FORM.joinBase) * disposition;
  // Strict `<` against a [0,1) stream: p = 0 would never pass and p = 1 always
  // would, which is what makes the two bounds above meaningful.
  return clamp01(finite(rng?.() ?? 1, 1)) < p;
}

// ---------------------------------------------------------------------------
// Who is admitted
// ---------------------------------------------------------------------------

/**
 * May this roster admit this candidate?
 *
 * Three answers, in order, and only the last one is arithmetic:
 *   1. ALREADY A MEMBER → yes. Rejoining is a no-op (conversation.ts), and a
 *      caller that re-asks about a member it already has must not be told to
 *      throw them out.
 *   2. A PLAYER → yes, always, cap or no cap. A child who dwells on a
 *      conversation is asking to be in it; "the room is full" is not an answer
 *      this product may give, and a player who cannot join cannot be taught
 *      anything by the circle they are standing in.
 *   3. AN NPC → only under `maxMembers`. The cap is a camera and cost budget,
 *      and NPCs are the ones there are an unbounded supply of.
 */
export function mayJoin(memberIds: readonly string[], candidateId: string): boolean {
  if (!candidateId) return false;
  if (memberIds?.includes(candidateId)) return true;
  if (isPlayerCid(candidateId)) return true;
  return (memberIds?.length ?? 0) < CONV_FORM.maxMembers;
}

// ---------------------------------------------------------------------------
// Where they stand
// ---------------------------------------------------------------------------

export interface RingBody {
  id: string;
  /** This member's slot angle in radians, as a PREVIOUS call assigned it. Absent
   *  = never seated (see `ringSlotFor`). */
  angle?: number;
  /** Body girth in metres (`npcRadiusOf`). A body whose girth the host cannot
   *  name is read as girthless rather than guessed at — the species registry owns
   *  that number, and inventing one here would silently widen every ring. */
  radiusM: number;
}

export interface RingSlot {
  /** Where the newcomer stands, radians in [0, 2π) about the ring's centre. */
  angle: number;
  /** The radius the WHOLE ring now uses. Existing members keep their angles and
   *  move along their own spokes — the circle breathes, nobody swaps places. */
  ringR: number;
}

/**
 * The slot for a newcomer: the bisector of the LARGEST ANGULAR GAP, on a ring
 * sized so that every neighbouring pair clears its combined girths plus
 * `ringMarginM` (the module header states the law and the inversion).
 *
 * ONE BODY PER CALL. Only the newcomer's angle comes back, because only the
 * newcomer's angle is allowed to change; the host records it and passes it back
 * in as `RingBody.angle` next time. A member handed in WITHOUT an angle has
 * never been seated, so this seats it — in input order, by the same rule — which
 * keeps a host that forgets from producing a ring with everybody on one spoke.
 * That is a floor under a caller mistake, not a second way to use this: the
 * caller learns none of those angles.
 *
 * Pure and total: an empty roster, a NaN angle, a missing girth and coincident
 * neighbours all return a finite slot rather than throwing.
 */
export function ringSlotFor(existing: readonly RingBody[], newcomer: { radiusM: number }): RingSlot {
  const seats: Seat[] = [];
  for (const b of existing ?? []) {
    const radiusM = girth(b?.radiusM);
    const angle = b?.angle !== undefined && Number.isFinite(b.angle) ? norm(b.angle) : nextAngle(seats);
    seats.push({ angle, radiusM });
  }
  const angle = nextAngle(seats);
  return { angle, ringR: ringRadiusFor([...seats, { angle, radiusM: girth(newcomer?.radiusM) }]) };
}

interface Seat {
  angle: number;
  radiusM: number;
}

/**
 * The bisector of the largest gap between seated members — the one spot on the
 * ring that disturbs the standing circle least, which is why "step into the gap"
 * is what a person walking up to a group actually does.
 *
 * An empty ring opens at 0 (the ring's reference direction; there is nothing to
 * be relative to), and a single member is opposite by construction — its one
 * "gap" is the whole circle, so the second body lands at angle + π and reproduces
 * the pair. Ties go to the gap that starts EARLIEST, so the answer is a function
 * of the angles alone and never of the order they arrived in.
 */
function nextAngle(seats: readonly Seat[]): number {
  if (seats.length === 0) return 0;
  const angles = seats.map((s) => s.angle).sort((a, b) => a - b);
  let bestStart = angles[0]!;
  let bestGap = -1;
  for (let i = 0; i < angles.length; i++) {
    const from = angles[i]!;
    const gap = angles.length === 1 ? TWO_PI : norm(angles[(i + 1) % angles.length]! - from);
    if (gap > bestGap) {
      bestGap = gap;
      bestStart = from;
    }
  }
  return norm(bestStart + bestGap / 2);
}

/**
 * The radius the ring has to run at: the `ringRadius(n)` floor, raised to
 * whatever the tightest neighbour pair demands, capped at `ringMaxRadiusM`.
 *
 * Growing the radius is the ONLY lever available — the angles belong to the
 * members standing on them — and it is a lever that helps every pair at once:
 * chord `2·R·sin(Δ/2)` is monotone in R, so satisfying the worst pair satisfies
 * all of them. The cap can only bind when `sin(Δ/2)` is ~0, i.e. two members
 * share a spoke, which no sequence of calls to this function can produce.
 */
function ringRadiusFor(seats: readonly Seat[]): number {
  let needed = CONV_FORM.ringRadius(seats.length);
  if (seats.length >= 2) {
    const sorted = [...seats].sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[(i + 1) % sorted.length]!;
      const half = Math.sin(norm(b.angle - a.angle) / 2);
      const chord = a.radiusM + b.radiusM + CONV_FORM.ringMarginM;
      // Coincident spokes (half ≈ 0) demand an infinite ring; the cap below is
      // the answer, and separation sorts the overlap out on the next frame.
      const r = half > 1e-6 ? chord / (2 * half) : Infinity;
      if (r > needed) needed = r;
    }
  }
  return Math.min(needed, CONV_FORM.ringMaxRadiusM);
}

/** A body's girth, or none at all when the host could not name one. Negative and
 *  NaN both read as 0 — see `RingBody.radiusM`. */
function girth(r: number | undefined): number {
  return Math.max(0, finite(Number(r)));
}

/** Radians into [0, 2π). A non-finite angle reads as 0 rather than poisoning
 *  every downstream comparison with NaN. */
function norm(a: number): number {
  const m = finite(a) % TWO_PI;
  return m < 0 ? m + TWO_PI : m;
}

// ---------------------------------------------------------------------------
// Which conversation the camera is for
// ---------------------------------------------------------------------------

export interface FocusCandidate {
  id: string;
  /** Is the LOCAL device's player one of this conversation's members? */
  hasLocalPlayer: boolean;
  /** Distance from the camera / the player, in metres. */
  distM: number;
  /** Seconds since this conversation's last utterance. */
  lastWordsAgoS: number;
}

/**
 * Which conversation the camera holds and the TTS voices — a pure ranking, so
 * the dolly latch and the speech queue can be driven from the same answer.
 *
 * THE PLAYER'S OWN CONVERSATION ALWAYS WINS, silent or not. A child mid-exchange
 * whose creature is thinking about its reply must not have the camera swing away
 * to a livelier circle across the square; their conversation is the one they are
 * having. Only when the player is in none of them does the world get to compete,
 * and then it is the NEAREST one WITH WORDS ON SCREEN — a conversation that has
 * said nothing for `holdS` is over as far as the camera is concerned, and
 * pointing at it would be pointing at nothing.
 *
 * Null = focus on none, which is a real answer (an empty square, or every circle
 * gone quiet) and not a fallback to the least bad option.
 */
export function pickConversationFocus(
  cands: readonly FocusCandidate[],
  holdS: number = CONV_FORM.focusHoldS,
): string | null {
  if (!cands || cands.length === 0) return null;
  const mine = cands.filter((c) => c?.hasLocalPlayer);
  const pool = mine.length > 0 ? mine : cands.filter((c) => finite(c?.lastWordsAgoS, Infinity) <= holdS);

  // Nearest wins; ties go to the earlier candidate (strict `<`), so the answer is
  // a function of the host's own deterministic conversation order.
  let best: FocusCandidate | undefined;
  let bestDist = Infinity;
  for (const c of pool) {
    const d = finite(c.distM, Infinity);
    if (!best || d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

/** Weighted index over a non-empty list, one draw. Float drift at the very top
 *  of the range falls to the last entry rather than off the end, and a strict
 *  `<` means a zero-weight entry can never win even on a roll of 0. (Same
 *  routine as `arbitrateResponse`'s, which has no SILENCE slot to spare here —
 *  somebody always opens once the host has decided a conversation may start.) */
function roulette(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return weights.length - 1;
  let roll = clamp01(finite(rng?.() ?? 0)) * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]! > 0 ? weights[i]! : 0;
    roll -= w;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}
