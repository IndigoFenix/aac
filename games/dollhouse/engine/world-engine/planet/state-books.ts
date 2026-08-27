// shared/world-engine/planet/state-books.ts
//
// THE STATE'S BOOKS (states round S1 — states-round.md §11, rulings §14;
// PER-KIND BOOKS round §15–§20, task #40). A state stops being a purely
// political index and becomes an economic abstraction: population, per-kind
// potentials, imports/exports — a yearly closed-form trajectory over the
// SAME tier-0 states the court (history.ts) relabels, emitting economic
// events on the SAME year line as the political ledger.
//
// ⚖️ THE REPLAY CONTRACT (the polities discipline, generalized to economy):
//    books-at-year is DERIVED, never serialized. One simulate call walks the
//    whole span once and keeps an in-memory trajectory so `booksAt`/
//    `stateWeight` are O(1) lookups plus a fresh-row derive, but that cache
//    is a memo of a pure function — recomputing from the same inputs yields
//    the same bytes, and nothing here may ever be written to a save.
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
//    demand for a kind exceeds its own supply is DEFINITIONALLY an importer
//    of that kind — the deficit IS the derived import demand. No authored
//    import constants. The trade net is `statePairs` — the same adjacency
//    the roads pave: the road topology IS the trade topology, per kind.
//
// ⚖️ PRIMITIVES ONLY (user ruling §20, 2026-08-26): the engine bakes
//    SHAPES — a good is a `StateGoodSpec` row (its charter axis, its one
//    conversion dial, flow vs finite, whether it feeds the vitals) and
//    every arm below is generic over the row. `DEFAULT_STATE_GOODS` is
//    CONTENT (S5-tunable); no logic in this module names a kind id, and
//    the id namespace is sized for the tech-tree future (the eventual
//    grain is the freight good — "new glyph when it trades separately").
//
// ⚖️ THE UNIT LAW (ruling ⑩): one unit of every kind = one PERSON-YEAR of
//    that kind's demand, so demand ≡ pop × demandPerCapita (default 1) and
//    S1's spare/deficit/greedy-pair trade shape repeats per kind unchanged,
//    lossless per kind. Real per-capita anchors (wood m³/soul·yr, iron
//    kg/soul·yr) live in dial comments, never in the arithmetic.
//
// ⚖️ FINITE KINDS (ruling ⑪; tri.ts's "ore is the substrate's one finite
//    budget", lifted to the year grain): `reserveYears` on the spec row ⇒
//    reserve₀ = potential × reserveYears, extraction DEMAND-DRIVEN (local
//    use + exports — the ground is never drawn to waste), and `depletion`
//    fires ONCE when a state's reserve reaches exact zero. This is the
//    FIRST shape mineral depletion has anywhere in the tree
//    (tech-trees-content records the finer per-field shape as open).
//
// ⚖️ THE GRAIN LADDER'S FIRST RUNG (ruling §14-⑧): this module steps in
//    whole GAME-YEARS, the political ledger's own unit. The year↔day
//    handoff has ONE home — `scale.ts yearGameDays(scale)` — and this
//    module cites it rather than minting a constant.
//
// ⚖️ POTENTIAL IS THE ENGINE'S OWN ACCOUNTING: the `foundingCrowd` arm is
//    the founding/spill formula verbatim — `min(2000, round(density × 5))`
//    (planet/cities.ts startPop / spillBudget; Stage β's "the lattice IS
//    the carrying capacity"). Axis-read kinds sum the radius-3 charter box
//    founding already reads (`PlanetCity.charter`) × the spec's dial.
//    Sites without charter data leave those kinds' books inert — graceful.
//
// ⚖️ THE FLUX QUOTE + THE θ ROUTER (rulings ② + ④ — the state rung's
//    first memory producers, closing S4's recorded exemption): each kind's
//    books row quotes the locale's own churn (`flux` = production drawn +
//    consumption met, books units per YEAR — the caller-clock flux
//    destiny's `memoryLifespan` wants). `routeStateDelta` makes the
//    membrane-facing decision in ONE place: a delta at or above
//    θ = flux × STATE_THETA_FRACTION returns a coarse intervention (the
//    declared channel; Markov recompute forward); below θ it returns a
//    stamped `DestinyMemory` that fades on the locale's own flux. Zero
//    flux ⇒ θ = 0 ⇒ every real delta writes coarse — the rare-kind /
//    wilderness case: impact is durable BECAUSE nothing there churns.
//    Memory STORAGE stays the caller's; the books stay derived.
//
// Vitals are the FLOAT Malthus form (kernel/civ/plan.ts:406-419 — the
// closed-form twin's arm) at pre-modern crude yearly rates. The fed
// fraction entering the arm is the MINIMUM over `feedsPopulation` kinds'
// fills (Liebig — the binding constraint, `constraintCeiling`'s own
// philosophy); exactly one feeder reproduces the S1 bytes. What must agree
// across the grain handoff is the EQUILIBRIUM (population follows
// capacity — Stage β's law), never the transient's speed.
//
// Data only, THREE-free, deterministic — same inputs, same books. No
// draws in v1: every event is a pure threshold crossing (a seeded-draw
// term joins with harvest variance, S5 content).

import { TIER_POP_CAP } from "../scale.js";
import {
  registerCoarseChannel, stampMemory, type DestinyMemory,
} from "../kernel/destiny.js";
import { statePairs, type PlanetStates, type StatePairOpts } from "./states.js";

registerCoarseChannel({
  id: "state-books:intervention",
  description:
    "A genuine coarse actor (player, live-session outcome) moves a state's population, a kind's year-flow, or a finite kind's reserve at a year; destiny recomputes forward (Markov).",
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

// ── The goods catalogue: primitive SHAPES; the rows are CONTENT ────────────

/** ONE KIND, as a data row (§20 primitives-only law — every arm of the
 *  walk is generic over this shape; nothing below names an id). */
export interface StateGoodSpec {
  /** Plain-string id — the namespace the future glyph→kind bridge maps
   *  onto (tech-trees-content: the eventual grain is the freight good). */
  id: string;
  /** How one claimed site's potential derives:
   *    { foundingCrowd: true } — the founding/spill crowd formula over the
   *      site's density (S1's food arm, verbatim);
   *    { axis, perAxis }       — `site.charter[axis] × perAxis`, the ONE
   *      conversion dial per kind (world-size realism law). */
  potential: { foundingCrowd: true } | { axis: string; perAxis: number };
  /** Person-years of demand per soul per year (⑩ unit law: default 1 —
   *  the UNIT absorbs the real per-capita rate, so this dial is for kinds
   *  whose churn per soul genuinely differs, e.g. durables ≪ 1).
   *  Non-population demand drivers (industry-demanded goods) are a
   *  RECORDED seam on this row, not built. */
  demandPerCapita?: number;
  /** Present ⇒ the kind is FINITE: reserve₀ = potential × reserveYears,
   *  drawn down demand-driven, `depletion` event at exact zero. Absent ⇒
   *  renewable flow. */
  reserveYears?: number;
  /** This kind's fill enters the vitals arm. Multiple feeders combine by
   *  MINIMUM (Liebig); a catalogue with NO feeder leaves fill = 1 —
   *  population uncoupled from land, the caller's content decision. */
  feedsPopulation?: boolean;
}

/** The v1 catalogue — CONTENT, not law (S5-tunable; callers override via
 *  `opts.goods`). Three rows on the three charter axes the tree already
 *  sums everywhere (cities.ts charterBox, tri.ts TriCharter). The axis
 *  dials are UNANCHORED PLACEHOLDERS until worldgen callers thread real
 *  charter data (S5 dials) — only tests exercise them today. */
export const DEFAULT_STATE_GOODS: readonly StateGoodSpec[] = [
  { id: "food", potential: { foundingCrowd: true }, feedsPopulation: true },
  { id: "timber", potential: { axis: "timberland", perAxis: 40 } },
  // tri.ts: "exhausted mountains are a real long-arc event" — the reserve
  // dial is what makes exhaustion a CENTURIES story, not a decade one.
  { id: "ore", potential: { axis: "ore_access", perAxis: 50 }, reserveYears: 250 },
];

/** A declared coarse intervention (the `state-books:intervention` channel),
 *  landing at the START of `year` before that year's flows. `popDelta`
 *  moves souls (clamped at zero). A kind delta (`good` + `delta`) moves:
 *  FLOW kinds — that one year's supply (a grain fleet feeds year Y only);
 *  FINITE kinds — the reserve (a seam gifted or stripped), clamped at
 *  zero. Unknown goods, empty interventions and out-of-range years all
 *  THROW — a typoed intervention must fail loudly. */
export interface StateIntervention {
  year: number;
  state: number;
  popDelta?: number;
  good?: string;
  delta?: number;
}

/** One economic event on the shared year line. `founding`/`abandonment`
 *  are implied-settlement crossings (the reveal attaches them to ranked
 *  sites — S3); `trade-open`/`trade-close` are pair-flow transitions per
 *  kind (state < partner, the adjacency's canonical order); `depletion`
 *  is a finite kind's reserve reaching exact zero. */
export interface StateEconEvent {
  year: number;
  kind: "founding" | "abandonment" | "trade-open" | "trade-close" | "depletion";
  state: number;
  /** trade events: the other crown of the pair. */
  partner?: number;
  /** founding/abandonment: the implied town count AFTER the crossing. */
  count?: number;
  /** trade/depletion events: the kind, by catalogue id. */
  good?: string;
}

/** One kind's books in one state at one year (units: person-years, ⑩). */
export interface GoodBooksRow {
  /** Annual capacity — the RATE the claimed land supports. For finite
   *  kinds this caps extraction; it is NOT the remaining reserve. */
  potential: number;
  /** What the land could actually yield that year: min(potential, reserve)
   *  for finite kinds, potential for flows. */
  supply: number;
  imports: number;
  exports: number;
  /** Fed fraction of demand after trade. */
  fill: number;
  /** THE LOCALE'S CHURN for this kind (ruling ② — the noise floor):
   *  production actually drawn + consumption actually met, books units
   *  per year. Zero where the kind neither moves nor is used — a delta
   *  there is durable BECAUSE nothing metabolizes it. */
  flux: number;
  /** Finite kinds only: stock remaining at this snapshot. */
  reserve?: number;
}

/** The books of one state at one year. ⚖️ The top-level scalars are the
 *  POPULATION-FEEDING PROJECTION (Σ potential/imports/exports and MIN fill
 *  over `feedsPopulation` kinds — never a named kind, §20); `goods` holds
 *  every kind's row by catalogue id. */
export interface StateBooksRow {
  pop: number;
  potential: number;
  fill: number;
  imports: number;
  exports: number;
  goods: Record<string, GoodBooksRow>;
}

export interface StateBooksOpts {
  /** The seats, state i = seats[i] (planet/cities.ts order). Only the
   *  founding crowd is read. */
  seats: ReadonlyArray<{ startPop: number }>;
  /** The claim map + political graph (planet/states.ts). */
  states: Pick<PlanetStates, "stateOf" | "adjacency">;
  /** Worldgen's eager founding sites (built.sites) — the potential map.
   *  `charter` is the radius-3 box founding read (`PlanetCity.charter`
   *  satisfies it) — axis-read kinds sum from it; absent ⇒ those kinds'
   *  potential at this site is 0. */
  sites: ReadonlyArray<{
    cell: number;
    density: number;
    charter?: Readonly<Record<string, number>>;
  }>;
  /** Whole game-years to walk. */
  years: number;
  vitals?: Partial<StateVitals>;
  /** Trade-net capping (statePairs' own option). */
  pairs?: StatePairOpts;
  /** The goods catalogue — CONTENT (default `DEFAULT_STATE_GOODS`).
   *  Duplicate ids throw. */
  goods?: readonly StateGoodSpec[];
  /** Declared coarse interventions, any order; out-of-range years, state
   *  indices or unknown goods THROW. */
  interventions?: readonly StateIntervention[];
}

export interface StateEconomy {
  years: number;
  /** Append-only, ascending year — the economic half of the shared line. */
  events: readonly StateEconEvent[];
  /** Static geography, population-feeding projection: Σ feeder potential
   *  per state, in souls. */
  potentials: readonly number[];
  /** Static geography per kind, by catalogue id. */
  goodPotentials: Readonly<Record<string, readonly number[]>>;
  /** The resolved catalogue (for consumers walking the kinds). */
  goods: readonly StateGoodSpec[];
  /** The resolved vital rates (the θ router's pop-churn quote). */
  vitals: StateVitals;
  /** Books at year t (clamped to [0, years]) — derived, fresh rows. */
  booksAt(year: number): StateBooksRow[];
  /** The locale's churn for one kind at one year (ruling ②'s noise
   *  floor) — `booksAt(year)[state].goods[good].flux`, validated loudly. */
  fluxAt(state: number, good: string, year: number): number;
  /** The simulateHistory bridge: plug straight into `opts.stateWeight` —
   *  political strength rides the books (floor 1, the court's own floor). */
  stateWeight(stateIdx: number, year: number): number;
}

/** The founding/spill crowd formula, verbatim (cities.ts startPop and
 *  spillBudget both): what one site's density seats, souls. */
const sitePotential = (density: number): number =>
  Math.max(0, Math.min(2000, Math.round(density * 5)));

const EMPTY_F64 = new Float64Array(0);

/**
 * Walk the books forward `years` game-years. Pure in its inputs;
 * deterministic; O(years × kinds × (states + pairs)) once, then
 * O(kinds × (states + pairs)) reads.
 */
export function simulateStateBooks(opts: StateBooksOpts): StateEconomy {
  const n = opts.seats.length;
  const years = Math.max(0, Math.floor(opts.years));
  const vitals: StateVitals = { ...STATE_VITALS, ...(opts.vitals ?? {}) };
  const { stateOf } = opts.states;

  // The catalogue, validated loudly (a duplicate id is two laws, one name).
  const goods = opts.goods ?? DEFAULT_STATE_GOODS;
  const kindIndex = new Map<string, number>();
  goods.forEach((g, k) => {
    if (kindIndex.has(g.id)) throw new Error(`state-books: goods catalogue repeats id '${g.id}'`);
    if (g.reserveYears !== undefined && !(g.reserveYears >= 0)) {
      throw new Error(`state-books: good '${g.id}' reserveYears must be ≥ 0`);
    }
    if (g.demandPerCapita !== undefined && !(g.demandPerCapita >= 0)) {
      throw new Error(`state-books: good '${g.id}' demandPerCapita must be ≥ 0`);
    }
    kindIndex.set(g.id, k);
  });

  // Static geography per kind: claimed sites' yields, by claim label.
  const kindPotentials: Float64Array[] = goods.map(() => new Float64Array(n));
  for (const site of opts.sites) {
    const s = site.cell >= 0 && site.cell < stateOf.length ? stateOf[site.cell]! : -1;
    if (s < 0 || s >= n) continue;
    for (let k = 0; k < goods.length; k++) {
      const pot = goods[k]!.potential;
      kindPotentials[k]![s] += "foundingCrowd" in pot
        ? sitePotential(site.density)
        : Math.max(0, (site.charter?.[pot.axis] ?? 0) * pot.perAxis);
    }
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
    if ((iv.good === undefined) !== (iv.delta === undefined)) {
      throw new Error(`state-books: intervention pairs good and delta — got one without the other`);
    }
    if (iv.good !== undefined && !kindIndex.has(iv.good)) {
      throw new Error(`state-books: intervention names unknown good '${iv.good}'`);
    }
    if (iv.popDelta === undefined && iv.good === undefined) {
      throw new Error(`state-books: intervention moves nothing (no popDelta, no good)`);
    }
    let list = byYear.get(iv.year);
    if (!list) { list = []; byYear.set(iv.year, list); }
    list.push(iv);
  }

  const perCapOf = (k: number): number => goods[k]!.demandPerCapita ?? 1;

  /** ONE definition of one KIND's year — demand, supply, trade, extraction
   *  — used by the walk AND by booksAt (the two can never disagree).
   *  Greedy over the pair list in its canonical order; lossless per kind.
   *  `reserveBefore` is null for flow kinds; `bump` is the year's flow
   *  intervention (walk only — a bump is an event OF its year, never part
   *  of a snapshot's implied flows). */
  const kindYear = (
    k: number, pop: Float64Array,
    reserveBefore: Float64Array | null, bump: Float64Array | null,
  ) => {
    const perCap = perCapOf(k);
    const potential = kindPotentials[k]!;
    const demand = new Float64Array(n);
    const supply = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      demand[s] = pop[s]! * perCap;
      const cap = Math.max(0, potential[s]! + (bump ? bump[s]! : 0));
      supply[s] = reserveBefore ? Math.min(cap, reserveBefore[s]!) : cap;
    }
    const spare = new Float64Array(n);
    const deficit = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      spare[s] = Math.max(0, supply[s]! - demand[s]!);
      deficit[s] = Math.max(0, demand[s]! - supply[s]!);
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
    // Demand-driven extraction (finite kinds, ruling ⑪): what actually
    // leaves the ground = local use + exports — never drawn to waste.
    let extraction: Float64Array | null = null;
    if (reserveBefore) {
      extraction = new Float64Array(n);
      for (let s = 0; s < n; s++) {
        extraction[s] = Math.min(demand[s]!, supply[s]!) + exports[s]!;
      }
    }
    return { demand, supply, imports, exports, flow, extraction };
  };

  const fillOf = (demand: number, supply: number, imports: number, exports: number): number =>
    demand > 0 ? Math.min(1, (supply + imports - exports) / demand) : 1;

  // --- The walk: one pass, events recorded, trajectory memoized. -----------
  const traj: Float64Array[] = [new Float64Array(n)];
  for (let s = 0; s < n; s++) traj[0]![s] = Math.max(0, opts.seats[s]!.startPop);

  const reserveTraj: Float64Array[][] = [goods.map((g, k) =>
    g.reserveYears !== undefined
      ? Float64Array.from(kindPotentials[k]!, (v) => v * g.reserveYears!)
      : EMPTY_F64,
  )];

  const events: StateEconEvent[] = [];
  const implied = new Int32Array(n);
  for (let s = 0; s < n; s++) implied[s] = Math.floor(traj[0]![s]! / TIER_POP_CAP.town);
  const prevFlowByKind: Float64Array[] = goods.map(() => new Float64Array(pairs.length));

  for (let year = 1; year <= years; year++) {
    const pop = Float64Array.from(traj[year - 1]!);
    const reservesBefore = reserveTraj[year - 1]!.map((r) =>
      r === EMPTY_F64 ? EMPTY_F64 : Float64Array.from(r));

    // 1. Declared interventions land at the year's start (Markov: the
    //    walk before this year never saw them).
    let bumps: (Float64Array | null)[] | null = null;
    for (const iv of byYear.get(year) ?? []) {
      if (iv.popDelta !== undefined) {
        pop[iv.state] = Math.max(0, pop[iv.state]! + iv.popDelta);
      }
      if (iv.good !== undefined) {
        const k = kindIndex.get(iv.good)!;
        if (goods[k]!.reserveYears !== undefined) {
          reservesBefore[k]![iv.state] = Math.max(0, reservesBefore[k]![iv.state]! + iv.delta!);
        } else {
          if (!bumps) bumps = goods.map(() => null);
          let arr = bumps[k];
          if (!arr) { arr = new Float64Array(n); bumps[k] = arr; }
          arr[iv.state]! += iv.delta!;
        }
      }
    }

    // 2. Per kind, catalogue order: trade — geography chooses the
    //    importers — then extraction and the depletion crossing.
    const feederFill = new Float64Array(n).fill(1);
    const reservesAfter: Float64Array[] = [];
    for (let k = 0; k < goods.length; k++) {
      const spec = goods[k]!;
      const finite = spec.reserveYears !== undefined;
      const rBefore = finite ? reservesBefore[k]! : null;
      const ky = kindYear(k, pop, rBefore, bumps ? bumps[k] : null);

      const prev = prevFlowByKind[k]!;
      for (let p = 0; p < pairs.length; p++) {
        const opened = prev[p]! === 0 && ky.flow[p]! > 0;
        const closed = prev[p]! > 0 && ky.flow[p]! === 0;
        if (opened || closed) {
          const [a, b] = pairs[p]!;
          events.push({
            year, kind: opened ? "trade-open" : "trade-close",
            state: a, partner: b, good: spec.id,
          });
        }
      }
      prevFlowByKind[k] = ky.flow;

      if (spec.feedsPopulation) {
        for (let s = 0; s < n; s++) {
          const f = fillOf(ky.demand[s]!, ky.supply[s]!, ky.imports[s]!, ky.exports[s]!);
          if (f < feederFill[s]!) feederFill[s] = f;
        }
      }

      if (finite) {
        const after = new Float64Array(n);
        for (let s = 0; s < n; s++) {
          const next = rBefore![s]! - ky.extraction![s]!;
          after[s] = next > 0 ? next : 0;
          if (rBefore![s]! > 0 && after[s]! === 0) {
            events.push({ year, kind: "depletion", state: s, good: spec.id });
          }
        }
        reservesAfter.push(after);
      } else {
        reservesAfter.push(EMPTY_F64);
      }
    }

    // 3. Vitals — the float Malthus arm (plan.ts:406-419), yearly rates,
    //    fed on the Liebig minimum over feeder kinds.
    for (let s = 0; s < n; s++) {
      const p0 = pop[s]!;
      if (p0 <= 0) continue;
      const fill = feederFill[s]!;
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
    reserveTraj.push(reservesAfter);
  }

  const clampYear = (year: number): number =>
    Math.max(0, Math.min(years, Math.floor(year)));

  // Static per-kind geography, frozen for consumers.
  const goodPotentials: Record<string, readonly number[]> = {};
  goods.forEach((g, k) => { goodPotentials[g.id] = [...kindPotentials[k]!]; });

  /** The snapshot's implied flows: booksAt quotes the year's population
   *  and reserves and derives the trade they imply — the same stance S1
   *  took with one kind (a flow bump is its own year's event, never part
   *  of a snapshot). */
  const rowsAt = (year: number): StateBooksRow[] => {
    const y = clampYear(year);
    const pop = traj[y]!;
    const reserves = reserveTraj[y]!;
    const perKind = goods.map((g, k) =>
      kindYear(k, pop, g.reserveYears !== undefined ? reserves[k]! : null, null));
    const rows: StateBooksRow[] = [];
    for (let s = 0; s < n; s++) {
      const goodsRec: Record<string, GoodBooksRow> = {};
      let potSum = 0, impSum = 0, expSum = 0, fillMin = 1;
      for (let k = 0; k < goods.length; k++) {
        const spec = goods[k]!;
        const ky = perKind[k]!;
        const fill = fillOf(ky.demand[s]!, ky.supply[s]!, ky.imports[s]!, ky.exports[s]!);
        const produced = Math.min(ky.demand[s]!, ky.supply[s]!) + ky.exports[s]!;
        const consumed = Math.min(ky.demand[s]!, ky.supply[s]! + ky.imports[s]!);
        goodsRec[spec.id] = {
          potential: kindPotentials[k]![s]!,
          supply: ky.supply[s]!,
          imports: ky.imports[s]!,
          exports: ky.exports[s]!,
          fill,
          flux: produced + consumed,
          ...(spec.reserveYears !== undefined ? { reserve: reserves[k]![s]! } : {}),
        };
        if (spec.feedsPopulation) {
          potSum += kindPotentials[k]![s]!;
          impSum += ky.imports[s]!;
          expSum += ky.exports[s]!;
          if (fill < fillMin) fillMin = fill;
        }
      }
      rows.push({
        pop: pop[s]!,
        potential: potSum,
        fill: fillMin,
        imports: impSum,
        exports: expSum,
        goods: goodsRec,
      });
    }
    return rows;
  };

  // Population-feeding projection of the static geography.
  const potentials = new Float64Array(n);
  goods.forEach((g, k) => {
    if (g.feedsPopulation) {
      for (let s = 0; s < n; s++) potentials[s]! += kindPotentials[k]![s]!;
    }
  });

  return {
    years,
    events,
    potentials: [...potentials],
    goodPotentials,
    goods,
    vitals,
    booksAt: rowsAt,
    fluxAt(state, good, year) {
      if (!kindIndex.has(good)) {
        throw new Error(`state-books: fluxAt names unknown good '${good}'`);
      }
      if (!Number.isInteger(state) || state < 0 || state >= n) {
        throw new Error(`state-books: fluxAt names unknown state ${state}`);
      }
      return rowsAt(year)[state]!.goods[good]!.flux;
    },
    stateWeight(stateIdx, year) {
      const pop = traj[clampYear(year)]!;
      return Math.max(1, stateIdx >= 0 && stateIdx < n ? pop[stateIdx]! : 1);
    },
  };
}

// ── The θ router (rulings ② + ④): coarse write or fading memory ────────────

/** The θ dial — CONTENT (S5-tunable, ④ "the first θ sets the tone"): a
 *  kind delta below this fraction of the locale's ANNUAL churn never
 *  writes coarse — it becomes a fading memory on the locale's own flux.
 *  Population deltas use the same fraction of the state's POPULATION
 *  (ruling ④'s flat-% arm for non-item coarse variables). */
export const STATE_THETA_FRACTION = 0.01;

/** The router's own tag for population memories (a DestinyMemory.kind is
 *  the stamping caller's vocabulary — this is NOT a goods id). */
export const STATE_POP_KIND = "state:pop";

/** A candidate write against a state's books — exactly ONE variable:
 *  either `popDelta`, or a kind delta (`good` + `delta`). */
export interface StateDelta {
  year: number;
  state: number;
  popDelta?: number;
  good?: string;
  delta?: number;
}

export type StateDeltaRoute =
  | { route: "coarse"; intervention: StateIntervention }
  | { route: "memory"; memory: DestinyMemory };

/**
 * THE MEMBRANE-FACING DECISION, made in ONE place so no write site ever
 * improvises the θ test (rulings ② + ④):
 *
 *   at/above θ  →  a coarse intervention for the caller to append to
 *                  `opts.interventions` and re-simulate — the declared
 *                  `state-books:intervention` channel, Markov recompute;
 *   below θ     →  a `DestinyMemory` stamped on the locale's own flux
 *                  (destiny's `stampMemory` — lifespan = magnitude
 *                  relative to churn), for the caller to STORE; the books
 *                  never see it, and a century-warp is a filter by date.
 *
 * Zero flux ⇒ θ = 0 ⇒ every real delta is coarse — the rare-kind /
 * wilderness case: durable impact BECAUSE nothing there churns. The
 * router WRITES nothing itself; both arms are return values.
 */
export function routeStateDelta(
  econ: StateEconomy, d: StateDelta,
  thetaFraction: number = STATE_THETA_FRACTION,
): StateDeltaRoute {
  const hasPop = d.popDelta !== undefined;
  const hasGood = d.good !== undefined || d.delta !== undefined;
  if (hasPop === hasGood) {
    throw new Error("state-books: routeStateDelta takes exactly one variable (popDelta XOR good+delta)");
  }
  if (hasGood && (d.good === undefined || d.delta === undefined)) {
    throw new Error("state-books: routeStateDelta pairs good and delta — got one without the other");
  }

  if (hasGood) {
    const magnitude = Math.abs(d.delta!);
    const flux = econ.fluxAt(d.state, d.good!, d.year);
    if (magnitude < flux * thetaFraction) {
      return { route: "memory", memory: stampMemory(d.good!, magnitude, d.year, flux) };
    }
    return {
      route: "coarse",
      intervention: { year: d.year, state: d.state, good: d.good!, delta: d.delta! },
    };
  }

  const magnitude = Math.abs(d.popDelta!);
  const row = econ.booksAt(d.year)[d.state];
  if (!row) throw new Error(`state-books: routeStateDelta names unknown state ${d.state}`);
  // Flat-% θ on the books (④'s non-item arm); the STAMP still fades on
  // the honest churn — the year's births + deaths at the quoted fill.
  const v = econ.vitals;
  const churn = row.pop * (v.birthRate * row.fill + v.deathRate + v.starvation * (1 - row.fill));
  if (magnitude < row.pop * thetaFraction) {
    return { route: "memory", memory: stampMemory(STATE_POP_KIND, magnitude, d.year, churn) };
  }
  return {
    route: "coarse",
    intervention: { year: d.year, state: d.state, popDelta: d.popDelta! },
  };
}
