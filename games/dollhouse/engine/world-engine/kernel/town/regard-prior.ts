/**
 * regard-prior.ts — WHAT A RELATION BOOK BECOMES WHEN ITS HOUSEHOLD DEMOTES TO
 * A STATISTIC (politics-substrate round, design points F-1/F-2/F-3).
 *
 * PURE arithmetic: no host, no clock, no RNG, no world — the `cohort-needs.ts`
 * precedent, and for the same reason: BOTH DOORS LIVE IN ONE MODULE so the
 * fold and the unfold cannot drift apart. `cohort-needs.ts` does this for a
 * body METER; this does it for the four-axis directed book
 * (`interaction/behavior/relations.ts`).
 *
 * 🚨 A `RegardPrior` IS NOT A REPUTATION. There is no `reputation: number` in
 * this engine and this is not one sneaking in (⚠️ ruling: "no `reputation:
 * number` — derived (book + facts), askable"). A prior is a FOLDED SUMMARY OF
 * A SCOPE'S OWN BOOK — what a whole household, collectively, came to feel
 * about one subject — held only while that household is a statistic and
 * spent the moment it becomes people again. Nobody carries one; nothing reads
 * one as a score; it is the cohort tier's answer to "the books have to go
 * somewhere", exactly as `CohortHouse.needs` is its answer for meters.
 *
 * ⚖️ WHY A SCALAR + A ROUTE, and not four means. Four axes folded to four
 * means would re-project four averages onto every member and claim more than
 * the tier knows: a pooled household has no per-person book any more, so the
 * honest payload is ONE net number (how well this household regards you) plus
 * ONE structural fact (whether that regard runs through recognition or
 * through fear) — owner's ruling ①, "folded prior = ONE regard scalar +
 * route". The route is what keeps `authority` and `fear` from collapsing into
 * each other on the way back out, which is the whole reason they are separate
 * axes (relations.ts: "the two earn and decay from opposite events").
 *
 * ⚖️ AND WHY THE FOLD IS LOSSY BY DESIGN. It projects a 4-D book onto a
 * 2-parameter prior; the members whose books the projection CANNOT rebuild
 * are PINNED verbatim instead (F-3, `foldHouseRegard`). That is ruling ④'s
 * "pin when they deviate — no scope is special" at the only rung the tree has
 * a fold for. A pinned soul is still a member: `Σpops + pinned = const`.
 */

import {
  makeRelation,
  type Relation,
} from "../../interaction/behavior/relations.js";
import type { CreatureId } from "../../interaction/behavior/creatures.js";

// ---------------------------------------------------------------------------
// The prior
// ---------------------------------------------------------------------------

/** One scope's folded regard toward ONE subject. */
export interface RegardPrior {
  /** Net regard, −1 (as bad as this tier can express) … +1. */
  regard: number;
  /**
   * WHICH ROUTE the regard runs through — prestige (recognition: authority
   * outweighs fear) or dominance (coercion: fear outweighs authority). Owner's
   * ruling ③'s two routes, folded: the scalar says how much, the route says
   * which axes the re-projection is allowed to spend it on.
   */
  route: "prestige" | "dominance";
  /** How many live rows folded into this prior (provenance, never a weight). */
  n: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Every axis of one row, or `null` if any of them is not a real number.
 *  NaN-dropping is the `foldNeedMeans` discipline: a NaN reaching a payload
 *  poisons every consumer downstream, so it never enters. */
function finiteAxes(rel: Relation): { a: number; t: number; u: number; f: number } | null {
  if (
    !Number.isFinite(rel.affinity) ||
    !Number.isFinite(rel.trust) ||
    !Number.isFinite(rel.authority) ||
    !Number.isFinite(rel.fear)
  ) {
    return null;
  }
  return {
    a: clamp(rel.affinity, -1, 1),
    t: clamp01(rel.trust),
    u: clamp01(rel.authority),
    f: clamp01(rel.fear),
  };
}

/**
 * THE FOLD FORM (F-1, verbatim — this half is FIXED and nothing below tunes it):
 *
 *   0.5·affinity + 0.25·(trust − 0.3)/0.7 + 0.25·authority − 0.5·fear
 *
 * `(trust − 0.3)/0.7` re-centres trust on `DEFAULT_RELATION.trust`, so a
 * stranger's default book contributes exactly 0 and the prior of a household
 * that never met anybody is 0 rather than "mildly positive".
 */
function regardOfRow(ax: { a: number; t: number; u: number; f: number }): number {
  return 0.5 * ax.a + (0.25 * (ax.t - 0.3)) / 0.7 + 0.25 * ax.u - 0.5 * ax.f;
}

/**
 * FOLD: N directed rows toward ONE subject → one prior. `null` for an empty
 * (or all-NaN) set — a household with no opinion has no prior, and inventing a
 * neutral one would make "never met" indistinguishable from "indifferent".
 */
export function foldRegard(rels: readonly Relation[]): RegardPrior | null {
  let sum = 0;
  let sumFear = 0;
  let sumAuth = 0;
  let n = 0;
  for (const rel of rels) {
    const ax = finiteAxes(rel);
    if (!ax) continue;
    sum += regardOfRow(ax);
    sumFear += ax.f;
    sumAuth += ax.u;
    n += 1;
  }
  if (n === 0) return null;
  return {
    regard: clamp(sum / n, -1, 1),
    // ⚖️ TIES GO TO PRESTIGE. `fear === authority` (the overwhelmingly common
    // 0 === 0) must not read as coercion: dominance is the claim that fear is
    // doing the work, and a tie is not that claim.
    route: sumFear / n > sumAuth / n ? "dominance" : "prestige",
    n,
  };
}

// ---------------------------------------------------------------------------
// The unfold, and the two bands it can reach
// ---------------------------------------------------------------------------

/** Everything the POSITIVE half of the form can buy from affinity + trust
 *  alone: `0.5·1 + 0.25·(1 − 0.3)/0.7`. */
const POS_BUDGET = 0.75;
/** …and the NEGATIVE half: `0.5·1 + 0.25·(0.3/0.7)` (affinity −1, trust 0). */
const NEG_BUDGET = 0.5 + (0.25 * 0.3) / 0.7; // 0.6071428571428571
/** The smallest fear a dominance prior may re-project with. Strictly positive
 *  so the route SURVIVES the round trip (`fear > authority`); as small as it
 *  can be so the route's ceiling sits within ε of the fold's own supremum. */
const DOMINANCE_FEAR_MIN = 0.02;
/** How far φ may spread affinity either side of the prior (±0.1). */
const PHI_SPREAD = 0.2;

/**
 * 🚨 THE REACHABLE BAND OF EACH ROUTE — a fact about the FOLD, not a choice of
 * the unfold. With `route` decided by `fear ≷ authority`, the linear form
 * above is bounded per route:
 *
 *   prestige  (fear ≤ authority): min at affinity −1, trust 0, fear = authority = 1
 *                                 ⇒ −0.5 − 0.107142857 − 0.25 = −0.857142857 ; max 1
 *   dominance (fear >  authority): max as fear → 0⁺ with affinity 1, trust 1
 *                                 ⇒ sup 0.75 (never attained) ; min −1
 *
 * So `{ regard: −1, route: "prestige" }` and `{ regard: 1, route: "dominance" }`
 * are pairs NO relation set can produce, and `foldRegard` therefore never emits
 * one. `unfoldRegard` clamps into the band rather than pretending; the round-trip
 * LAW is total on the fold's OWN IMAGE, which is the only thing the fold seat
 * ever hands it.
 */
export const REGARD_BAND: Readonly<Record<RegardPrior["route"], readonly [number, number]>> = {
  prestige: [-(NEG_BUDGET + 0.25), 1],
  dominance: [-1, POS_BUDGET - 0.5 * DOMINANCE_FEAR_MIN],
};

/** Split a net budget `v` across affinity and trust together — the two axes a
 *  prior always spends first, in the same proportion, so the re-projected book
 *  reads as one attitude rather than as an arbitrary corner of the box. */
function spendOnAffinityAndTrust(v: number): { affinity: number; trust: number } {
  if (v >= 0) {
    const k = Math.min(1, v / POS_BUDGET);
    return { affinity: k, trust: 0.3 + 0.7 * k };
  }
  const w = Math.min(1, -v / NEG_BUDGET);
  return { affinity: -w, trust: 0.3 * (1 - w) };
}

/**
 * UNFOLD one prior into one member's row, staggered by `phi` (0..1).
 *
 * The shape, by route:
 *
 *  · PRESTIGE — `authority = max(0, regard)`, `fear = 0`, and affinity/trust
 *    carry the rest. Recognition is the whole story: nothing is afraid of a
 *    prestige patron. Only BELOW the affinity/trust floor (regard < −0.607,
 *    which is the one corner where the fold's own route rule requires
 *    `authority ≥ fear > 0`) does the deep arm spend a TIED `fear = authority`
 *    term — the boundary of the route itself, and the only book shape that
 *    could have folded that low under this route.
 *
 *  · DOMINANCE — `authority = 0` (⚖️ coerced compliance NEVER earns authority,
 *    so a fear-carried prior may not re-project any), and `fear` takes its
 *    PROPORTIONAL share of however negative the regard is, falling to a bare
 *    floor once the regard is positive — which is exactly what "fear barely
 *    exceeds authority" means at the top of the band.
 *
 * φ SPREADS AFFINITY ONLY, and it is applied AFTER the solve: the structural
 * axes (trust, authority, fear) are the household's, identical for every
 * member, and only how much each member happens to LIKE the subject is
 * staggered. ±0.1 on affinity is ±0.05 on the re-fold, which is the round-trip
 * ε — the spread can never move a household out of its own prior.
 *
 * Byte-deterministic in `(p, phi)`: pure arithmetic, no map order, no clock.
 */
export function unfoldRegard(p: RegardPrior, phi: number): Relation {
  const dominance = p.route === "dominance";
  const band = REGARD_BAND[dominance ? "dominance" : "prestige"];
  const raw = Number.isFinite(p.regard) ? p.regard : 0;
  const r = clamp(raw, band[0], band[1]);

  let authority = 0;
  let fear = 0;
  let v: number;
  if (dominance) {
    // Fear takes its PROPORTIONAL share of however negative the regard is —
    // `NEG_BUDGET + 0.5` is everything the two negative carriers (affinity+trust,
    // and fear) can express together — and drops to the floor once the regard is
    // positive at all. A dominance prior at regard 0 is a household that fears
    // its subject barely more than it recognises it, which is exactly what the
    // fold's own route rule (`fear > authority`) said when it chose the route.
    //
    // ⚠️ NOT "fear at maximum until affinity and trust saturate": that shape
    // reaches the same band and round-trips just as exactly, but it re-projects
    // an ordinary wary book (fear 0.5) as terror (fear 1) — a 0.42 deviation on
    // affinity — so every mildly-fearful household PINNED and the fold did
    // nothing. Proportional fear reproduces that same book to within 0.06.
    const s = Math.min(1, -r / (NEG_BUDGET + 0.5));
    fear = Math.max(DOMINANCE_FEAR_MIN, s);
    v = r + 0.5 * fear;
  } else if (r >= -NEG_BUDGET) {
    authority = Math.max(0, r);
    v = r - 0.25 * authority;
  } else {
    // The deep prestige arm: affinity and trust are already spent.
    const q = clamp01((-r - NEG_BUDGET) / 0.25);
    authority = q;
    fear = q;
    v = -NEG_BUDGET;
  }

  const { affinity, trust } = spendOnAffinityAndTrust(v);
  const ph = Number.isFinite(phi) ? clamp01(phi) : 0.5;
  return makeRelation({
    affinity: affinity + PHI_SPREAD * (ph - 0.5),
    trust,
    authority,
    fear,
  });
}

/**
 * HOW FAR a live row sits from what its household's prior would re-project —
 * the largest absolute difference on any single axis. Measured at `phi = 0.5`
 * (the un-staggered projection) so the answer is about the BOOK, not about
 * where in the stagger this member happened to land.
 */
export function regardDeviation(rel: Relation, p: RegardPrior): number {
  const at = unfoldRegard(p, 0.5);
  const ax = finiteAxes(rel);
  if (!ax) return Infinity; // a row nothing can reconstruct is maximally deviant
  return Math.max(
    Math.abs(ax.a - at.affinity),
    Math.abs(ax.t - at.trust),
    Math.abs(ax.u - at.authority),
    Math.abs(ax.f - at.fear),
  );
}

/**
 * ⚖️ F-3's THRESHOLD — how far a member's book may sit from its household's
 * prior before the fold gives up and keeps the rows verbatim. A quarter of an
 * axis: wide enough that the whole family sharing one attitude folds cleanly
 * (a `FAMILY_RELATION` household deviates by 0.17), narrow enough that a body
 * the player actually changed comes back as itself.
 */
export const PIN_EPS = 0.25;

// ---------------------------------------------------------------------------
// The household rung — the two doors the fold seat calls (F-2, F-3)
// ---------------------------------------------------------------------------

export interface HouseRegardFold {
  /** subject → the household's folded prior toward it (sorted keys). */
  regard: Record<CreatureId, RegardPrior>;
  /** observer → its VERBATIM book, for the members the prior cannot rebuild. */
  pinned: Record<CreatureId, Record<CreatureId, Relation>>;
  /** The live-map keys the caller must DELETE — exactly the rows folded here,
   *  and nothing else. Sorted, so the deletion order is replay-stable. */
  keys: string[];
}

/**
 * FOLD a household's outgoing books (F-2).
 *
 * `rows` is the whole live `"observer|subject"` map; only rows whose OBSERVER
 * is one of `members` are touched, split on the FIRST `|` (the graduation
 * re-key's precedent — a subject id may contain the separator, an observer's
 * never does because it is always the left half of the key).
 *
 * 🚨 THE SUBJECT-SIDE ROWS ARE NOT FOLDED AND NOT DELETED. `x|resident_<h>_m`
 * is somebody ELSE's opinion of this household, and it lives in THAT
 * observer's book — the observer did not demote, its memory did not end, and a
 * fold that swallowed those rows would erase the town's memory of a family
 * every time the family stepped off screen. Only the outgoing half folds.
 *
 * `spokenTo` names members the player has actually talked to; those are pinned
 * whatever their deviation (F-3: a person the player has met is a person, not
 * a statistic).
 */
export function foldHouseRegard(
  rows: Iterable<readonly [string, Relation]>,
  members: readonly CreatureId[],
  spokenTo?: ReadonlySet<CreatureId>,
): HouseRegardFold {
  const memberSet = new Set(members);
  const books = new Map<CreatureId, Map<CreatureId, Relation>>();
  const keys: string[] = [];
  for (const [key, rel] of rows) {
    const bar = key.indexOf("|");
    if (bar <= 0 || bar >= key.length - 1) continue;
    const observer = key.slice(0, bar);
    if (!memberSet.has(observer)) continue;
    const subject = key.slice(bar + 1);
    keys.push(key);
    const book = books.get(observer) ?? new Map<CreatureId, Relation>();
    book.set(subject, rel);
    books.set(observer, book);
  }
  keys.sort();
  const observers = [...books.keys()].sort();

  /** The priors a given set of members produces, per subject, sorted. */
  const priorsOf = (from: readonly CreatureId[]): Map<CreatureId, RegardPrior> => {
    const bySubject = new Map<CreatureId, Relation[]>();
    for (const observer of from) {
      for (const [subject, rel] of books.get(observer)!) {
        const rels = bySubject.get(subject) ?? [];
        rels.push(rel);
        bySubject.set(subject, rels);
      }
    }
    const out = new Map<CreatureId, RegardPrior>();
    for (const subject of [...bySubject.keys()].sort()) {
      const prior = foldRegard(bySubject.get(subject)!);
      if (prior) out.set(subject, prior);
    }
    return out;
  };

  /**
   * 🚨 THE PRIOR DESCRIBES THE MEMBERS IT RE-PROJECTS ONTO — which is why the
   * pin test TRIMS instead of testing once.
   *
   * Tested once against the whole household's mean, ONE wild outlier drags the
   * centre far enough that every ordinary member fails too, and the pin becomes
   * contagious: a single terrified resident pins the whole family (measured —
   * five members, four identical, one afraid ⇒ 5 pins). So the loop pins the
   * SINGLE WORST deviant, re-folds the prior from the members that remain, and
   * asks again — the standard trim, and it converges in at most one pass per
   * member. Order-free: every round measures every candidate against the SAME
   * prior and ties break on the sorted cid, so the outcome cannot depend on the
   * live map's insertion history (the multiplayer law).
   *
   * `spokenTo` members start pinned, and are therefore out of the prior from the
   * first round: a person the player has actually met is not part of the
   * statistic that stands in for the people it never met.
   */
  const pinnedSet = new Set<CreatureId>();
  for (const observer of observers) if (spokenTo?.has(observer)) pinnedSet.add(observer);
  let priors = priorsOf(observers.filter((o) => !pinnedSet.has(o)));
  for (let pass = 0; pass < observers.length; pass++) {
    let worst: { observer: CreatureId; dev: number } | null = null;
    for (const observer of observers) {
      if (pinnedSet.has(observer)) continue;
      let dev = 0;
      for (const [subject, rel] of books.get(observer)!) {
        const prior = priors.get(subject);
        // No prior for a subject this candidate holds an opinion about can only
        // mean every reading of it was non-finite — unreconstructable, so pin.
        dev = Math.max(dev, prior ? regardDeviation(rel, prior) : Infinity);
      }
      if (dev > PIN_EPS && (worst === null || dev > worst.dev)) worst = { observer, dev };
    }
    if (!worst) break;
    pinnedSet.add(worst.observer);
    priors = priorsOf(observers.filter((o) => !pinnedSet.has(o)));
  }

  const regard: Record<CreatureId, RegardPrior> = {};
  for (const [subject, prior] of priors) regard[subject] = prior;

  const pinned: Record<CreatureId, Record<CreatureId, Relation>> = {};
  for (const observer of observers) {
    if (!pinnedSet.has(observer)) continue;
    const book = books.get(observer)!;
    const verbatim: Record<CreatureId, Relation> = {};
    for (const subject of [...book.keys()].sort()) verbatim[subject] = { ...book.get(subject)! };
    pinned[observer] = verbatim;
  }

  return { regard, pinned, keys };
}

export interface ProjectedRegardRow {
  /** The live-map key `"observer|subject"`. */
  key: string;
  observer: CreatureId;
  subject: CreatureId;
  rel: Relation;
  /** True when this row came back VERBATIM off a pin rather than off the prior. */
  pinned: boolean;
}

/**
 * RE-PROJECT a pooled household's books (F-2).
 *
 * A member with a PINNED book gets its rows back byte-for-byte — the pin exists
 * precisely because the prior could not rebuild them. Every other member is
 * projected from the prior, staggered by `phi` (the caller supplies the same
 * seeded hash the meter unfold's `SEED_SPREAD` stagger uses, so a frozen prior
 * re-projects byte-identically on every replay: the field is the memory, and
 * people do not flicker).
 *
 * Rows come out in `(member index, subject)` order — no map-insertion history
 * reaches the live map.
 */
export function projectHouseRegard(
  house: {
    regard?: Record<CreatureId, RegardPrior>;
    pinned?: Record<CreatureId, Record<CreatureId, Relation>>;
  },
  members: readonly CreatureId[],
  phi: (member: CreatureId, subject: CreatureId, index: number) => number,
): ProjectedRegardRow[] {
  const out: ProjectedRegardRow[] = [];
  const subjects = house.regard ? Object.keys(house.regard).sort() : [];
  for (let i = 0; i < members.length; i++) {
    const observer = members[i]!;
    const book = house.pinned?.[observer];
    if (book) {
      for (const subject of Object.keys(book).sort()) {
        out.push({
          key: `${observer}|${subject}`,
          observer,
          subject,
          rel: makeRelation(book[subject]!),
          pinned: true,
        });
      }
      continue;
    }
    for (const subject of subjects) {
      out.push({
        key: `${observer}|${subject}`,
        observer,
        subject,
        rel: unfoldRegard(house.regard![subject]!, phi(observer, subject, i)),
        pinned: false,
      });
    }
  }
  return out;
}
