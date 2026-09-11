// shared/world-engine/interaction/behavior/body-needs.ts
//
// THE NEED PRIMITIVE ON THE BODY ROW — a lazily-timestamped meter
// (planning-docs/games/world-engine/body-needs-round.md, design point D1; the
// user's direction in `pull-labor-round.md` design point 9: "a need primitive on
// the BODY row, ticked lazily by timestamp (evaluated at wake/decision — never
// per-frame)").
//
// PURE, like `needs.ts` beside it: no host, no world geometry, no RNG, no
// ambient clock. Every function takes the time it should read. The five laws
// this file is written under, each of which is the OPPOSITE of the obvious
// implementation:
//
//  ① LAZY BY TIMESTAMP, NEVER TICKED. `BodyNeedRow` is `{ level, at }` — the
//    level AS OF sim-second `at`, and the level at any later second is a CLOSED
//    FORM (`bodyNeedLevel`). Nothing advances it; a body streamed out of the
//    world, a settler nobody has looked at for four game-days, and a body
//    standing in front of the camera all read the same function. "Idle is idle,
//    shown or not" — the cost of a body's hunger is one multiply at the moment
//    somebody asks, not O(bodies × rows) every frame. (Contrast the resident
//    accumulator, quest-host `stepNeeds`' tick block, which ticks only while the
//    house is SHOWN and DELETES the row when it is not — a storage discipline
//    that cannot represent a body with no household. Residents keep it this
//    round, U3.)
//
//  ② EVALUATED AT DECISION ONLY. There is no "step" here and there must never
//    be one. The read sites are the decide, the credit, the HUD and the
//    why-chain — every one of them a moment somebody ASKED. That is also what
//    makes the dormancy exact: `bodyNeedCrossingAt` says the second the row
//    fires, so a lazy body sleeps until its own earliest crossing instead of
//    re-deciding on a 1.5 s cap.
//
//  ③ NO NEW PACING CONSTANT. Every rate comes from `needRate(scale, key)`
//    (scale.ts, `NEED_FILL_DAYS` ÷ metabolism × dayLengthS) — the ONE rate
//    source the resident meters, the civ-tier bands and this file all share.
//    `FOOD_DAY_SEC` is indicted (`feedback_transaction_time_from_needs`) and is
//    not read here. The only new NUMBER in this file is a satisfier PROPERTY
//    (`REST_QUALITY`), which is not pacing: it says how much of the deficit a
//    given place clears, not how fast the deficit grows.
//
//  ④ THE GROUND IS A SATISFIER, of quality 0.5 — not a missing bed. A body
//    that sleeps rough wakes HALF rested and fires again in half the fill time;
//    bad rest is MORE OF THE DAY SPENT SLEEPING, not a longer nap (the dwell is
//    world physics: `restDwellS(scale)`). `restClear` is the arithmetic, and it
//    is deliberately `ingestMeterAfter`'s shape (goods-kinds.ts) — the engine's
//    one partial-satisfaction precedent, so there is one owner for "a satisfier
//    that only half-answers". A bed is quality 1 ⇒ a full clear ⇒ every
//    existing bed-arrival site is byte-identical through this function.
//
//  ⑤ REST/WAKE IS AN IDENTITY, not a transformation. `wake(rest(p, t), t) ≡ p`
//    (fold.ts's persistence-arm law): `rest` rebases `at` RELATIVE to now,
//    `wake` puts it back, and LEVELS NEVER MOVE THROUGH EITHER — a fold is time
//    travel, and conservation is untouched by time travel. (Float caveat, stated
//    rather than hidden: `(at − now) + now` is exact only while no rounding
//    happens in the subtraction. Sim clocks are small positive seconds and stamps
//    ride the same clock, so it holds for every payload this engine makes; a
//    payload rebased against an absolute epoch would need a different unit, not a
//    different formula.)
//
// THE ACT-BY-ANOTHER SLOT is NOT defined here: a need whose satisfier is
// another entity's ACT (standing, security — interpersonal-politics.md) is
// declared on `SatisfySpec`'s social arm in needs.ts as an optional `good`, and
// its credit comes through the host's one `creditNeed` door, exactly as every
// satisfier here does. The politics round filled that slot: `bodyNeedTemplates`
// can now CARRY those rows, under an explicit `social` opt-in, and the only
// thing this file adds is the two RATE scalings (assertiveness, exposure) —
// which are rates, not a second meter and not a branch.

import {
  energyTemplate,
  hungerTemplate,
  provisionTemplate,
  relieveTemplate,
  securityTemplate,
  socialTemplate,
  standingTemplate,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import type { Personality } from "@shared/world-engine/interaction/behavior/personality.js";
import { needRate, type WorldScale } from "@shared/world-engine/scale.js";

/** ONE BODY-ANCHORED NEED, as of one moment.
 *
 *  `level` is in THRESHOLD UNITS — 1 = firing — identical to the resident
 *  `needMeters` value, so the accessors can hand either to the same walker and
 *  the same HUD. `at` is a SIM second (`session.townClock`), never wall-clock:
 *  the lazy read must be a pure function of the sim, or two peers stepping the
 *  same world disagree about who is hungry (the multiplayer determinism law). */
export interface BodyNeedRow {
  level: number;
  at: number;
}

/** A body's whole row set, keyed by need-template key — the shape a fold
 *  payload carries (plain JSON; the live session keeps a `Map` of the same). */
export type BodyNeedRows = Readonly<Record<string, BodyNeedRow>>;

/** THE LAZY READ — the level at sim-second `now`, in threshold units.
 *
 *  `row.level + rate × max(0, now − at)`. The clamp is not defensive tidiness:
 *  a `now` BEFORE the stamp means somebody is asking about the past, and the
 *  honest answer for a monotone deficit is the level it was stamped at, never a
 *  negative advance that would un-eat a meal. */
export function bodyNeedLevel(row: BodyNeedRow, rate: number, now: number): number {
  if (!(rate > 0)) return row.level;
  return row.level + rate * Math.max(0, now - row.at);
}

/** SATISFY — pin the row at `levelAfter` and STAMP IT. The write half of the
 *  lazy discipline: a satisfy writes a TIMESTAMP, because "cleared" without a
 *  clock is a level that starts rising again from whenever the row happened to
 *  be read last.
 *
 *  `rate` is accepted so every door in this file reads `(row, rate, now, …)` —
 *  the seam D and C import — and is deliberately UNREAD: a satisfy pins the
 *  level, it does not integrate. */
export function bodyNeedSatisfy(
  row: BodyNeedRow,
  _rate: number,
  now: number,
  levelAfter: number,
): BodyNeedRow {
  return { level: Math.max(0, levelAfter), at: now };
}

/** ADVANCE — re-anchor to `now` WITHOUT changing what the row says.
 *
 *  `{ level: bodyNeedLevel(row, rate, now), at: now }`: the same deficit,
 *  quoted at a later clock. Nothing about the body changed; only the stamp did.
 *  Used where a row must be handed across a boundary (a graduation, a fold)
 *  quoted at one agreed moment. */
export function bodyNeedAdvance(row: BodyNeedRow, rate: number, now: number): BodyNeedRow {
  return { level: bodyNeedLevel(row, rate, now), at: Math.max(row.at, now) };
}

/** THE CROSSING — the sim second at which this row reaches `threshold`.
 *
 *  Closed form, so dormancy is exact: `at + (threshold − level) / rate`. Two
 *  answers are deliberately NOT clamped to the present:
 *   • a row already at or past the threshold returns a second in the PAST, which
 *     every caller compares as `townClock < due` ⇒ decide now. Clamping it to
 *     `now` would need a `now`, and this function does not take one — a crossing
 *     is a property of the row, not of when you asked.
 *   • `rate ≤ 0` returns `Infinity`: a DUTY row (rate 0) never crosses, and a
 *     dormancy that treats it as "due immediately" would pin the body at a
 *     re-decide every frame. */
export function bodyNeedCrossingAt(row: BodyNeedRow, rate: number, threshold: number): number {
  if (!(rate > 0)) return Number.POSITIVE_INFINITY;
  return row.at + (threshold - row.level) / rate;
}

/** FOLD ARM ①: put a body's rows TO REST — rebase every stamp RELATIVE to
 *  `now`. Levels never move (conservation is untouched by time travel). */
export function restBodyNeeds(rows: BodyNeedRows, now: number): BodyNeedRows {
  const out: Record<string, BodyNeedRow> = {};
  for (const key of Object.keys(rows)) {
    const row = rows[key]!;
    out[key] = { level: row.level, at: row.at - now };
  }
  return out;
}

/** FOLD ARM ②: WAKE a rested payload at `now`. The identity law
 *  `wakeBodyNeeds(restBodyNeeds(p, t), t) ≡ p` is the pin (see header ⑤). */
export function wakeBodyNeeds(rows: BodyNeedRows, now: number): BodyNeedRows {
  const out: Record<string, BodyNeedRow> = {};
  for (const key of Object.keys(rows)) {
    const row = rows[key]!;
    out[key] = { level: row.level, at: row.at + now };
  }
  return out;
}

/** WHAT A PLACE TO SLEEP IS WORTH — the satisfier's own property, in threshold
 *  units of deficit cleared per sleep (U2, ledger D1).
 *
 *  `bed: 1` — the proper fixture answers the whole need, which is exactly what
 *  every rest-arrival site does today, so a housed body is byte-identical.
 *  `ground: 0.5` — a body with nowhere to lie down still sleeps (needs bind to
 *  AFFORDANCES; the ground affords bad rest) and wakes half-rested. A bedroll,
 *  when someone builds one, is a `bed`-kind station of a quality between the
 *  two — a spec row, not a new branch here. */
export const REST_QUALITY = { bed: 1, ground: 0.5 } as const;

/** The level a rest LEAVES BEHIND. `quality ≥ 1` clears; anything less takes
 *  `quality` off the top and leaves the remainder — `ingestMeterAfter`'s shape
 *  (goods-kinds.ts), the engine's one partial-satisfaction precedent. */
export function restClear(level: number, quality: number): number {
  if (quality >= 1) return 0;
  return Math.max(0, level - quality);
}

/**
 * 🪨 WHAT THE CAMP EATS IN A DAY, and what it wants standing by (ruling 2 of
 * piles-not-boxes-round.md).
 *
 * ⚖️ TWO CLOCKS (`feedback_two_clocks_metabolic_vs_solar`, user 2026-09-08).
 * The draw is `bodyNeedRate("hunger") × dayLengthS × bodies` — the METABOLIC
 * rate against the solar day, which is exactly the horizon `noteEnablerDemand`
 * already computes for ONE body (`dayWant`). Nothing here is a new pacing
 * constant and nothing multiplies a need by `dayLengthS` a second time: a 24-min
 * day changes WHEN the camp restocks, never HOW MUCH it eats.
 *
 * `below` = ONE day's draw — the floor the pile must not fall through, which is
 * the same statement a household's `surplusUnits` buffer makes about its pantry.
 * `upTo` = TWO days' — the cap a provisioning trip fills to, so a settler that
 * has walked to a stand comes back with a day in hand rather than a bite.
 *
 * Floored at one whole ration: a larder that wants less than a meal is the
 * single-berry trip defect restated one rung up.
 */
export function campLarderDraw(scale: WorldScale, bodies: number): { below: number; upTo: number } {
  const perDay = needRate(scale, "hunger") * scale.dayLengthS * Math.max(0, bodies);
  const below = Math.max(1, Math.ceil(perDay));
  return { below, upTo: below * 2 };
}

/** THE HOMELESS BODY'S ROWS — what a settler at a camp wants, as data.
 *
 *  Deliberately the SAME template factories a resident carries, at the SAME
 *  priorities (hunger 5, energy 4, relieve 0.8): one behavior model for
 *  creatures, and a rung is a flag, never a second model. Two differences, both
 *  of them the absence of a household rather than a new mechanism:
 *
 *   • hunger eats IN PLACE (`at: []` — no table, because there is no dining
 *     room). Its acquire branches are the template's own and unchanged, so the
 *     forage arm is a matter of WHAT THE CALLER RESOLVES into `ctx.sources`
 *     (wild food containers in reach) — "forage when there is no market, buy
 *     when there is" falls out of `acquireFrom`'s argmax with no new branching.
 *   • rest has no `requireStation`, so a camp with no bed doses in place
 *     (`restHere`) and `restClear(level, REST_QUALITY.ground)` prices it.
 *
 *  `pullOn` adds the relieve row for the same reason a non-dollhouse resident
 *  gets one (quest-host `residentNeedTemplates`): a body that hauls for a bill
 *  ends up holding things, and putting a thing down is the ladder's bottom rung.
 *
 *  ⚠️ LIVELOCK INVARIANT (needs.ts): hunger (5) ACQUIRES food units and
 *  outranks every deposit-shaped row for food here — relieve (0.8) has no
 *  acquire branches at all, so the pair cannot spin. */
export function bodyNeedTemplates(
  scale: WorldScale,
  opts: {
    pullOn: boolean;
    /** ⚖️ THE SOCIAL THIRD, OPT-IN (interpersonal-politics.md §8.5). Absent or
     *  false returns EXACTLY the rows this function has always returned — same
     *  templates, same order, same numbers — so a world that has not asked for
     *  politics cannot have its decide ladder moved by it. The frontier asks;
     *  the dollhouse never does. */
    social?: boolean;
    /** The body's own dials. Only `assertiveness` is read, and only to scale the
     *  STANDING rate: personality shapes HOW OFTEN a body wants to be looked up
     *  to, never a second meter and never a branch. Absent = the neutral 0.5. */
    personality?: Personality;
    /** EXPOSURE — the body's highest `fear` toward anyone in its book, 0..1.
     *  Scales the SECURITY rate: living among people you are afraid of is what
     *  makes you need an ally, and that is a fact about the book, which this
     *  pure module cannot read. The caller walks it. Absent = 0 (nobody scares
     *  me ⇒ the base rate). */
    maxFear?: number;
    /**
     * 🪨 THE CAMP'S LARDER, OPT-IN (piles-not-boxes-round.md ruling 2). Present
     * ⇒ this body carries the EXISTING `provisionTemplate` row for the good its
     * hunger row eats, against the camp's ground pile: *fetch until the pile
     * holds a day's draw, fill to two*. Absent returns EXACTLY the rows this
     * function has always returned, so a world that has not asked for a camp
     * larder (the dollhouse, nature-hike) cannot have its decide ladder moved.
     *
     * `bodies` is how many mouths the camp is feeding — the caller counts them
     * (this module has no session).
     *
     * 🚫 AND IT NAMES NO GOOD. The head comes off the HUNGER ROW this function
     * just built (`item.category`), so a world whose bodies eat something else
     * provisions that instead, with no change here and none at the call site.
     */
    larder?: { bodies: number };
  },
): NeedTemplate[] {
  const out: NeedTemplate[] = [
    hungerTemplate("food", needRate(scale, "hunger"), []),
    energyTemplate(needRate(scale, "energy")),
  ];
  if (opts.larder) {
    // ⚖️ THE ROW IS THE RESIDENTS' ROW, UNCHANGED — same shape, same acquire
    // order (source, then storage, then loose), same priority 3, which is
    // BELOW hunger's 5 by construction, so the LIVELOCK INVARIANT above holds
    // for a settler exactly as it holds for a family: hunger acquires food and
    // outranks every deposit-shaped row for it, so the pair cannot spin.
    // `exclusive` keeps ONE provisioner per good at a time, as it does in a
    // house — five settlers must not all walk out for the same larder.
    const goodKey = out.find((t) => t.key.startsWith("hunger:"))?.item.category ?? "";
    if (goodKey) {
      const { below, upTo } = campLarderDraw(scale, opts.larder.bodies);
      out.push({ ...provisionTemplate(goodKey, below, upTo), exclusive: true });
    }
  }
  if (opts.pullOn) out.push(relieveTemplate());
  if (opts.social) {
    // ⚠️ RATE-SCALED, NEVER THRESHOLD-SCALED. `0.5 + dial` spans ×0.5 … ×1.5 of
    // the table rate, so the ONE pacing table (`NEED_FILL_DAYS`) still owns the
    // period and personality only says how much faster or slower THIS body runs
    // through it — the same discipline metabolism follows for the whole set.
    const assertiveness = clamp01(opts.personality?.assertiveness ?? 0.5);
    const exposure = clamp01(opts.maxFear ?? 0);
    out.push(socialTemplate(needRate(scale, "social")));
    out.push(standingTemplate(needRate(scale, "standing") * (0.5 + assertiveness)));
    out.push(securityTemplate(needRate(scale, "security") * (0.5 + exposure)));
  }
  return out;
}

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);
