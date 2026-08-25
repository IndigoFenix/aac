// shared/world-engine/planet/state-books.ts
//
// THE STATE'S BOOKS (states round S1 — states-round.md §11, rulings §14).
// A state stops being a purely political index and becomes an economic
// abstraction: population, potential, imports/exports — a yearly closed-form
// trajectory over the SAME tier-0 states the court (history.ts) relabels,
// emitting economic events on the SAME year line as the political ledger.
//
// ⚖️ THE REPLAY CONTRACT (the polities discipline, generalized to economy):
//    books-at-year is DERIVED, never serialized. One simulate call walks the
//    whole span once and keeps an in-memory trajectory so `booksAt`/`
//    stateWeight` are O(1), but that cache is a memo of a pure function —
//    recomputing from the same inputs yields the same bytes, and nothing
//    here may ever be written to a save.
//
// ⚖️ MARKOV, NOT A TIMELINE (§4 law 4): destiny is preordained CONDITIONAL
//    on no coarse intervention. `interventions` is the declared flow through
//    which a genuine actor (the player; a live session's outcome) moves a
//    coarse variable; the trajectory before the intervention year is
//    byte-identical to the unperturbed run, and everything after simply
//    recomputes forward from the new state. Registered on the destiny
//    membrane as `state-books:intervention`.
//
// ⚖️ IMPORTS ARE GEOGRAPHY'S CHOICE (§3, the T5 direction): a state whose
//    population exceeds its own potential is DEFINITIONALLY an importer —
//    the deficit IS the derived import demand. No authored import constants.
//    The trade net is `statePairs` — the same adjacency the roads pave: the
//    road topology IS the trade topology.
//
// ⚖️ THE GRAIN LADDER'S FIRST RUNG (ruling §14-⑧): this module steps in
//    whole GAME-YEARS, the political ledger's own unit ("deep history runs
//    above the one canonical day"). The year↔day handoff has ONE home
//    already — `scale.ts yearGameDays(scale)`, a ratio of declared spin and
//    orbit — and this module cites it rather than minting a constant. The
//    finer handoff (day ↔ frame-seconds) is the clock-warp's, unchanged.
//
// ⚖️ POTENTIAL IS THE ENGINE'S OWN ACCOUNTING: a state's carrying potential
//    is the sum of its claimed founding sites' crowds under the SAME
//    formula founding and spill use — `min(2000, round(density × 5))`
//    (planet/cities.ts startPop / spillBudget; Stage β's "the lattice IS
//    the carrying capacity"). Sites are worldgen's eager, ranked,
//    spacing-disjoint set, so the books need no refinement to exist.
//    The land-lattice upgrade (claimed area / townSpacingM²) is the
//    recorded refinement path, not this.
//
// Vitals are the FLOAT Malthus form (kernel/civ/plan.ts:406-419 — the
// closed-form twin's arm; the integer-carry twin is dual.ts), at YEARLY
// rates anchored to pre-modern crude rates rather than the town rung's
// gameplay-compressed daily ones. What must agree across the grain
// handoff is the EQUILIBRIUM (population follows capacity — Stage β's
// law), never the transient's speed; the S4 pin compares year-edge
// enumerations at THIS rung.
//
// Data only, THREE-free, deterministic — same inputs, same books. No
// draws in v1: every event is a pure threshold crossing (a seeded-draw
// term joins with harvest variance, S5 content).

import { TIER_POP_CAP } from "../scale.js";
import { registerCoarseChannel } from "../kernel/destiny.js";
import { statePairs, type PlanetStates, type StatePairOpts } from "./states.js";

registerCoarseChannel({
  id: "state-books:intervention",
  description:
    "A genuine coarse actor (player, live-session outcome) moves a state's population at a year; destiny recomputes forward (Markov).",
});

/** Yearly vital rates — crude birth/death per soul per game-year, plus the
 *  starvation surcharge on the unfed fraction. Pre-modern anchors (growth
 *  ≈ 0.5%/yr at full fill), NOT the town rung's compressed dailies. */
export interface StateVitals {
  birthRate: number;
  deathRate: number;
  starvation: number;
}

export const STATE_VITALS: StateVitals = {
  birthRate: 0.033,
  deathRate: 0.028,
  starvation: 0.25,
};

/** A declared coarse intervention (the `state-books:intervention` channel):
 *  at the START of `year`, before that year's flows, the state's population
 *  moves by `popDelta` (clamped at zero). */
export interface StateIntervention {
  year: number;
  state: number;
  popDelta: number;
}

/** One economic event on the shared year line. `founding`/`abandonment`
 *  are implied-settlement crossings (the reveal attaches them to ranked
 *  sites — S3); `trade-open`/`trade-close` are pair-flow transitions
 *  (state < partner, the adjacency's canonical order). */
export interface StateEconEvent {
  year: number;
  kind: "founding" | "abandonment" | "trade-open" | "trade-close";
  state: number;
  /** trade events: the other crown of the pair. */
  partner?: number;
  /** founding/abandonment: the implied town count AFTER the crossing. */
  count?: number;
}

/** The books of one state at one year. `fill` is the fed fraction after
 *  trade; imports/exports are souls-fed moved that year (lossless v1 —
 *  freight loss is content for later). */
export interface StateBooksRow {
  pop: number;
  potential: number;
  fill: number;
  imports: number;
  exports: number;
}

export interface StateBooksOpts {
  /** The seats, state i = seats[i] (planet/cities.ts order). Only the
   *  founding crowd is read. */
  seats: ReadonlyArray<{ startPop: number }>;
  /** The claim map + political graph (planet/states.ts). */
  states: Pick<PlanetStates, "stateOf" | "adjacency">;
  /** Worldgen's eager founding sites (built.sites) — the potential map. */
  sites: ReadonlyArray<{ cell: number; density: number }>;
  /** Whole game-years to walk. */
  years: number;
  vitals?: Partial<StateVitals>;
  /** Trade-net capping (statePairs' own option). */
  pairs?: StatePairOpts;
  /** Declared coarse interventions, any order; out-of-range years or
   *  state indices THROW — a typoed intervention must fail loudly. */
  interventions?: readonly StateIntervention[];
}

export interface StateEconomy {
  years: number;
  /** Append-only, ascending year — the economic half of the shared line. */
  events: readonly StateEconEvent[];
  /** Static geography: carrying potential per state, in souls. */
  potentials: readonly number[];
  /** Books at year t (clamped to [0, years]) — derived, fresh rows. */
  booksAt(year: number): StateBooksRow[];
  /** The simulateHistory bridge: plug straight into `opts.stateWeight` —
   *  political strength rides the books (floor 1, the court's own floor). */
  stateWeight(stateIdx: number, year: number): number;
}

/** The founding/spill crowd formula, verbatim (cities.ts startPop and
 *  spillBudget both): what one site's density seats, souls. */
const sitePotential = (density: number): number =>
  Math.max(0, Math.min(2000, Math.round(density * 5)));

/**
 * Walk the books forward `years` game-years. Pure in its inputs;
 * deterministic; O(years × (states + pairs)) once, then O(states) reads.
 */
export function simulateStateBooks(opts: StateBooksOpts): StateEconomy {
  const n = opts.seats.length;
  const years = Math.max(0, Math.floor(opts.years));
  const vitals: StateVitals = { ...STATE_VITALS, ...(opts.vitals ?? {}) };
  const { stateOf } = opts.states;

  // Static geography: claimed sites' crowds, by claim label.
  const potentials = new Float64Array(n);
  for (const site of opts.sites) {
    const s = site.cell >= 0 && site.cell < stateOf.length ? stateOf[site.cell]! : -1;
    if (s >= 0 && s < n) potentials[s] += sitePotential(site.density);
  }

  // The trade net is the road net (statePairs' cost cap), fixed for the run.
  const pairs = statePairs(opts.states, opts.pairs);

  // Interventions grouped by year, validated loudly.
  const byYear = new Map<number, StateIntervention[]>();
  for (const iv of opts.interventions ?? []) {
    if (!Number.isInteger(iv.year) || iv.year < 1 || iv.year > years) {
      throw new Error(`state-books: intervention year ${iv.year} outside 1..${years}`);
    }
    if (!Number.isInteger(iv.state) || iv.state < 0 || iv.state >= n) {
      throw new Error(`state-books: intervention names unknown state ${iv.state}`);
    }
    let list = byYear.get(iv.year);
    if (!list) { list = []; byYear.set(iv.year, list); }
    list.push(iv);
  }

  /** ONE definition of a year's trade + fill, used by the walk AND by
   *  booksAt — the two can never disagree. Greedy over the pair list in
   *  its canonical order; lossless (Σ imports ≡ Σ exports). */
  const yearFlows = (pop: Float64Array): { imports: Float64Array; exports: Float64Array; flow: Float64Array } => {
    const spare = new Float64Array(n);
    const deficit = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      spare[s] = Math.max(0, potentials[s]! - pop[s]!);
      deficit[s] = Math.max(0, pop[s]! - potentials[s]!);
    }
    const imports = new Float64Array(n);
    const exports = new Float64Array(n);
    const flow = new Float64Array(pairs.length);
    for (let p = 0; p < pairs.length; p++) {
      const [a, b] = pairs[p]!;
      let f = Math.min(spare[a]!, deficit[b]!);
      if (f > 0) {
        spare[a]! -= f; deficit[b]! -= f;
        exports[a]! += f; imports[b]! += f;
        flow[p] = f;
        continue;
      }
      f = Math.min(spare[b]!, deficit[a]!);
      if (f > 0) {
        spare[b]! -= f; deficit[a]! -= f;
        exports[b]! += f; imports[a]! += f;
        flow[p] = f;
      }
    }
    return { imports, exports, flow };
  };

  const fillOf = (pop: number, potential: number, imports: number, exports: number): number =>
    pop > 0 ? Math.min(1, (potential + imports - exports) / pop) : 1;

  // --- The walk: one pass, events recorded, trajectory memoized. -----------
  const traj: Float64Array[] = [new Float64Array(n)];
  for (let s = 0; s < n; s++) traj[0]![s] = Math.max(0, opts.seats[s]!.startPop);

  const events: StateEconEvent[] = [];
  const implied = new Int32Array(n);
  for (let s = 0; s < n; s++) implied[s] = Math.floor(traj[0]![s]! / TIER_POP_CAP.town);
  let prevFlow = new Float64Array(pairs.length);

  for (let year = 1; year <= years; year++) {
    const pop = Float64Array.from(traj[year - 1]!);

    // 1. Declared interventions land at the year's start (Markov: the
    //    walk before this year never saw them).
    for (const iv of byYear.get(year) ?? []) {
      pop[iv.state] = Math.max(0, pop[iv.state]! + iv.popDelta);
    }

    // 2. Trade — geography chooses the importers.
    const { imports, exports, flow } = yearFlows(pop);
    for (let p = 0; p < pairs.length; p++) {
      const opened = prevFlow[p]! === 0 && flow[p]! > 0;
      const closed = prevFlow[p]! > 0 && flow[p]! === 0;
      if (opened || closed) {
        const [a, b] = pairs[p]!;
        events.push({ year, kind: opened ? "trade-open" : "trade-close", state: a, partner: b });
      }
    }
    prevFlow = flow;

    // 3. Vitals — the float Malthus arm (plan.ts:406-419), yearly rates.
    for (let s = 0; s < n; s++) {
      const p0 = pop[s]!;
      if (p0 <= 0) continue;
      const fill = fillOf(p0, potentials[s]!, imports[s]!, exports[s]!);
      const births = p0 * vitals.birthRate * fill;
      const deaths = p0 * (vitals.deathRate + vitals.starvation * (1 - fill));
      pop[s] = Math.max(0, p0 + births - deaths);
    }

    // 4. Implied-settlement crossings — the reveal's founding years (S3
    //    attaches count k's year to the k-th ranked internal site).
    for (let s = 0; s < n; s++) {
      const now = Math.floor(pop[s]! / TIER_POP_CAP.town);
      let cur = implied[s]!;
      while (cur < now) {
        cur += 1;
        events.push({ year, kind: "founding", state: s, count: cur });
      }
      while (cur > now) {
        cur -= 1;
        events.push({ year, kind: "abandonment", state: s, count: cur });
      }
      implied[s] = cur;
    }

    traj.push(pop);
  }

  const clampYear = (year: number): number =>
    Math.max(0, Math.min(years, Math.floor(year)));

  return {
    years,
    events,
    potentials: [...potentials],
    booksAt(year) {
      const pop = traj[clampYear(year)]!;
      const { imports, exports } = yearFlows(pop);
      const rows: StateBooksRow[] = [];
      for (let s = 0; s < n; s++) {
        rows.push({
          pop: pop[s]!,
          potential: potentials[s]!,
          fill: fillOf(pop[s]!, potentials[s]!, imports[s]!, exports[s]!),
          imports: imports[s]!,
          exports: exports[s]!,
        });
      }
      return rows;
    },
    stateWeight(stateIdx, year) {
      const pop = traj[clampYear(year)]!;
      return Math.max(1, stateIdx >= 0 && stateIdx < n ? pop[stateIdx]! : 1);
    },
  };
}
