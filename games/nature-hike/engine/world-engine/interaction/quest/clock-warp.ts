// shared/world-engine/interaction/quest/clock-warp.ts
//
// ⏩ THE MID-SESSION CLOCK WARP — the pure half.
//
// THE OBSERVATION THIS EXISTS FOR (user, 2026-08-13): *"for a lot of tests,
// nothing is leaving the clock and it is focusing on ledgers, not physics — so
// the clock can probably be sped up significantly."* The town's economic arm is
// CLOSED-FORM and DAY-EDGE triggered — the goods sawtooth, the export ramp, the
// drift drain, the caravan's cargo bucket, the barter legs, prosperity accrual,
// cohort rates, zoning growth. None of it integrates; all of it fires on an
// edge and reads a formula. Only PHYSICS needs `dt`. A consumer that wants
// seven economy days of books therefore does not need 33 600 frames of the
// sim: it needs seven day edges.
//
// TWO PRECEDENTS, both shipped, both cited by this design:
//
//   ① THE BOOT FAST-FORWARD (`town-play.ts` ~:915). A founding advances the
//      kernel town world day by day with NO physics at all, in 15-day slices,
//      and "slicing the fast-forward is exactly equivalent to one big step" is
//      already a pinned law. This is that lever, moved mid-session.
//   ② THE LOD FOLD LAW (S&D S4, `wild-area.ts`). Ceasing to be simulated FOLDS,
//      it never evaporates: a live stand condenses to a closed-form record and
//      unfolds back with its stock intact. Folding is LEGAL; DISRUPTING is not.
//
// ── THE LAWS ────────────────────────────────────────────────────────────────
//
// ⚖️ ① A WARP IS A JUMP IN THE BOOKS, NEVER IN THE BODIES. Nothing walks, eats,
//    talks or arrives across a warp. A warp that let an errand *complete*
//    abstractly would be the clock disrupting motion instead of owning it
//    ([[feedback_clock_owns_motion_disruption_disrupts]]), so the guard below
//    REFUSES rather than resolving one.
//
// ⚖️ ② THE EDGE IS THE UNIT. A warp runs exactly the sweeps a ticked run's day
//    crossings would run, once per crossing, in the tick order — and it lands
//    the clock on the edge before it runs them, so every sweep reads the clock
//    it would have read. It never invents a sweep and never skips one.
//
// ⚖️ ③ REFUSAL IS AN ANSWER. `refused` names the blockers; it is not an error,
//    not a partial warp, and never a silent no-op. A caller that gets one has
//    learned something true about the session (somebody is mid-errand).
//
// ⚖️ ④ IT IS PURE ARITHMETIC OVER AN ARMS TABLE. This module knows nothing
//    about the host: the caller hands it a clock and the day arms, and it owns
//    the bucket enumeration and nothing else. That is what makes the enumeration
//    testable without the quest-host transform tax (CLAUDE.md §Testing) — and
//    what keeps ONE definition of "how many edges is N days".
//
// ⚖️ ⑤ THE WARP PRIMES BEFORE IT JUMPS — and this law was FOUND, not designed.
//    Several of the sweeps are FIRST-SIGHT edge detectors: `stepDriftDrain`
//    latches `driftDrainDay`, `stepTradeCargo` latches `tradeCargoDay`, and each
//    treats the first bucket it ever sees as "nothing elapsed". A warp that
//    jumped straight to the first day edge would do that latching AT THE EDGE
//    instead of at t₀, and the caravan bucket is the one that catches it:
//    `tradeDay(t) = floor(t/DAY − arriveFrac − walk/DAY)` is phase-shifted OFF
//    the day edge, so its boundary sits mid-day. Measured (dollhouse, seed 12,
//    an orbit-rung town, one day): a ticked run first saw bucket −1 at t ≈ 1 s
//    and LANDED a caravan at t ≈ 216 s; an unprimed warp first saw bucket 0 at
//    the edge and landed nothing — 0.105 book units of granary the export debit
//    never charged. So the warp runs the sweeps ONCE at the clock it starts
//    from, exactly as the ticked run's first task sweep does within its first
//    second, and only then jumps. Pinned by the pure-frame twin.

/** The clock + sweeps a warp drives. Supplied by the host (quest-host.ts
 *  `advanceLedgerDays`); a test may supply a fake to pin the enumeration. */
export interface LedgerWarpArms {
  /** Seconds in one ECONOMY day — `FOOD_DAY_SEC`, the unit every day arm below
   *  counts in (`Math.floor(townClock / FOOD_DAY_SEC)`). Not the scale day: a
   *  session whose scale differs still books on the economy day. */
  readonly dayS: number;
  /** The town clock, now. */
  clockNow(): number;
  /** Put the clocks (town AND task — they run in lockstep for an owner) at
   *  exactly `t`. The one writer; a warp never nudges a clock any other way. */
  setClock(t: number): void;
  /** The once-a-day arm the frame loop runs when `newDay > prevDay`, with the
   *  clock already ON the edge. `day` is the integer economy day. */
  dayArm(day: number): void;
  /** The economy sweeps the task pool runs EVERY sweep (not only on an edge):
   *  due standing transfers, the drift drain, the caravan's cargo, the barter
   *  legs. Each is edge- or due-guarded internally, so running it on the edge
   *  is exactly what a ticked run does. */
  economySweeps(): void;
  /** Lazy catch-up passes that are already closed-form off an absolute clock
   *  deadline (wild harvest regrowth, the timber size-class clock). Run ONCE
   *  at the end: they are idempotent and read the final clock. */
  settleLazyClocks(): void;
}

/** What a warp did, or why it did nothing. */
export interface LedgerWarpResult {
  /** False = nothing moved. `blockers` says who. */
  ok: boolean;
  /** Economy days asked for (as passed, floored at 0). */
  days: number;
  /** Day EDGES actually crossed — the number of times `dayArm` ran. */
  edges: number;
  /** The town clock before / after. Equal when refused. */
  from: number;
  to: number;
  /** Law ③ — the live bodies that made this warp illegal, by id (capped for
   *  a readable message; `blocked` is the true count). */
  blockers: string[];
  blocked: number;
  /** A one-line honest account, safe to print in a transcript. */
  note: string;
}

/** Blockers named in the refusal line before it says "and N more". */
export const WARP_BLOCKERS_SHOWN = 4;

/**
 * ⚖️ ② — THE BUCKET ENUMERATION, and nothing else.
 *
 * `days` economy days pass. The sweeps PRIME at the starting clock (law ⑤).
 * Then every integer day edge strictly inside `(now, now + days·dayS]` is
 * CROSSED: the clock lands exactly on it, the day arm runs for that day, the
 * economy sweeps run behind it. Then the clock lands on the final instant and
 * the sweeps run once more — because a due barter leg or a standing transfer
 * can fall between the last edge and the end, and a ticked run would have fired
 * it there.
 *
 * Phase is preserved: a warp from mid-day t crosses exactly the same edges a
 * ticked run from t would, and ends at exactly `t + days·dayS`.
 */
export function runLedgerWarp(arms: LedgerWarpArms, days: number): LedgerWarpResult {
  const n = Math.max(0, Math.floor(days));
  const from = arms.clockNow();
  const to = from + n * arms.dayS;
  if (n === 0) {
    return { ok: true, days: 0, edges: 0, from, to: from, blockers: [], blocked: 0, note: "warp 0d — nothing to do." };
  }
  // ⚖️ ⑤ PRIME FIRST. Every first-sight edge detector latches HERE, at the
  // clock the warp starts from — which is where a ticked run's first task sweep
  // latches it too. Skipping this loses any bucket whose boundary is not the
  // day edge (the caravan's is not); see the law's note.
  arms.economySweeps();
  // The half-open interval `(from, to]`: a clock already sitting ON an edge has
  // crossed it (the tick that landed there ran its arm), so the first edge is
  // the next one up. `+1e-9` guards the float that `k·dayS` divides back to
  // `k − 1e-16`.
  const firstEdge = Math.floor(from / arms.dayS + 1e-9) + 1;
  const lastEdge = Math.floor(to / arms.dayS + 1e-9);
  let edges = 0;
  for (let e = firstEdge; e <= lastEdge; e++) {
    arms.setClock(e * arms.dayS);
    arms.dayArm(e);
    arms.economySweeps();
    edges++;
  }
  arms.setClock(to);
  arms.economySweeps();
  arms.settleLazyClocks();
  return {
    ok: true,
    days: n,
    edges,
    from,
    to,
    blockers: [],
    blocked: 0,
    note: `warp ${n}d — ${edges} day edge${edges === 1 ? "" : "s"}, books only (no physics).`,
  };
}

/** Law ③ — the refusal, in the same shape a success comes back in. */
export function refuseLedgerWarp(days: number, at: number, blockers: string[]): LedgerWarpResult {
  const shown = blockers.slice(0, WARP_BLOCKERS_SHOWN);
  const more = blockers.length - shown.length;
  return {
    ok: false,
    days: Math.max(0, Math.floor(days)),
    edges: 0,
    from: at,
    to: at,
    blockers: shown,
    blocked: blockers.length,
    note:
      `warp refused — ${blockers.length} body/bodies mid-errand (${shown.join(", ")}` +
      `${more > 0 ? ` and ${more} more` : ""}). An interrupted errand may not complete abstractly.`,
  };
}
