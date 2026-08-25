// shared/world-engine/planet/state-reveal.ts
//
// THE REVEAL (states round S3 — states-round.md §3/§11): "a map built out
// of real history." A state is walked rarely and traded with constantly, so
// its interior stays abstract until SEEN (ruling §14-⑤, sight law); when it
// is needed, this module generates the internal settlement hierarchy FROM
// the state's own books trajectory and event ledger — founding years from
// the crossings, ruins where the abandonment year says, walls from the war
// era, roads as old as the towns they join. Towns already do the degenerate
// version (buildUp-from-age, `grownDays`); this is the eventful one, and
// `ageYears` is `grownDays`' event-year generalization.
//
// ⚖️ ONE LAW, THREE RUNGS (§1, made literal): stranded demand founds a
// district seat ≡ Stage β spill founds a village ≡ A STATE'S SPILL FOUNDS
// A CITY. The internal candidate scan below IS the spill mechanism one
// rung up — `findFoundingSites` at a relaxed threshold over the state's
// OWN claimed cells, with every capital an occupied fixed point (the
// border.ts capital-projection pattern, generalized). Every eager site is
// already a capital (planetCities founds one at every site that can feed
// itself), so a state's interior towns are BY CONSTRUCTION on land the
// capital bar turned away — which is historically honest, and exactly what
// Stage β's villages already are.
//
// ⚖️ RANK IS THE ADDRESS. Candidates are rank-ordered by the scan (the
// worldgen score — deterministic, append-only in spirit) and the k-th
// founding event attaches to the k-th candidate FOREVER: a town abandoned
// and re-founded rises on the SAME cell with the SAME name (the §9
// identity law — the name chain is cell-keyed, `settlementNameOf`).
//
// ⚖️ PURE AND REPLAYABLE: a reveal is a pure function of (candidates,
// events, year) — same planet, same history, same year ⇒ byte-identical
// map, and two reveals at different years agree on their shared past
// (destiny's whole point: the watched and the warped land on one world).
//
// The VILLAGE lattice is NOT this module's: per-cell refine keeps laying
// villages exactly as it does (chunked substrate, §9 — untouched); this
// scan lays the TOWN tier the food-scale round left unanswered (the
// tier-promotion question dissolves here, §3).

import {
  findFoundingSites, type CellGrid, type FoundingOpts, type FoundingSite,
} from "../kernel/cells/index.js";
import { TIER_POP_CAP } from "../scale.js";
import { SPILL_THRESHOLD_RELAX, settlementNameOf } from "./cities.js";
import type { PlanetStates } from "./states.js";
import type { StateBooksRow, StateEconEvent } from "./state-books.js";

// ── The internal candidate scan (the spill, one rung up) ────────────────────

export interface InternalScanOpts {
  /** The tier-0 substrate (built.grid). */
  grid: CellGrid;
  /** The claim map — only this state's own cells are eligible. */
  states: Pick<PlanetStates, "stateOf">;
  stateIdx: number;
  /** EVERY capital's founding site (built.sites) — occupied fixed points,
   *  exactly as spillFoundingSites holds the first pass out of the second. */
  capitalSites: ReadonlyArray<Pick<FoundingSite, "x" | "y">>;
  /** The planet's own founding scan (planetFoundingOpts) — the derivation
   *  the capitals used; this scan relaxes ITS threshold, never invents one. */
  founding: FoundingOpts;
  /** Threshold relax (default: the Stage β floor — no deeper). */
  relax?: number;
}

/**
 * The state's ranked internal town candidates: spacing-disjoint sites on
 * the state's OWN land, below the capital bar but above the relaxed one,
 * capitals held as fixed points. Deterministic in its inputs; the rank
 * order is the scan's own score order and is the reveal's address space.
 */
export function internalTownCandidates(opts: InternalScanOpts): FoundingSite[] {
  const relax = opts.relax ?? SPILL_THRESHOLD_RELAX;
  const outerEligible = opts.founding.eligible;
  return findFoundingSites(opts.grid, {
    ...opts.founding,
    threshold: opts.founding.threshold * relax,
    occupied: [
      ...(opts.founding.occupied ?? []),
      ...opts.capitalSites.map((s) => [s.x, s.y] as [number, number]),
    ],
    eligible: (cell: number) =>
      opts.states.stateOf[cell] === opts.stateIdx && (outerEligible?.(cell) ?? true),
  });
}

// ── The reveal: events → fabric ─────────────────────────────────────────────

export interface RevealedTown {
  /** WHERE — the candidate site (its cell is the identity, forever). */
  site: FoundingSite;
  /** 1-based rank in the candidate order — the event ledger's address. */
  rank: number;
  /** The one name chain (`settlementNameOf`), cell-keyed — a re-founded
   *  town keeps its name; collisions within one state suffix by rank. */
  name: string;
  /** The year this town (last) rose — the crossing that founded it. */
  foundedYear: number;
  /** Present ⇒ a RUIN at the reveal year: the year it emptied. */
  abandonedYear?: number;
  /** grownDays' event-year form: reveal year − foundedYear for a living
   *  town; abandonedYear − foundedYear for a ruin (how long it LIVED —
   *  what its remains are sized from). */
  ageYears: number;
  /** A war crossed its life (the political ledger's era, worn as walls). */
  walls: boolean;
  /** The road it was founded WITH — to the nearest elder of its own
   *  network (the plan.ts "road to the nearest living city" precedent,
   *  seat included), as old as the town. Null for an unroaded seat-only
   *  network degenerate case. */
  road: { toCell: number; builtYear: number } | null;
}

export interface StateReveal {
  stateIdx: number;
  year: number;
  /** Living towns AND ruins, rank order — the whole remembered interior. */
  towns: RevealedTown[];
  /** Crossings the LAND could not seat (implied count beyond the candidate
   *  list) — never silently capped (the no-silent-caps law). */
  unplaced: number;
}

export interface RevealStateOpts {
  /** `internalTownCandidates()` — the ranked address space. */
  candidates: readonly FoundingSite[];
  /** The S1 economy — the event line and the founding condition. */
  economy: {
    events: readonly StateEconEvent[];
    booksAt(year: number): StateBooksRow[];
  };
  /** War years touching this state (the political ledger's `war` events
   *  whose ceded state is this one) — worn as walls by towns whose lives
   *  they crossed. */
  warYears?: readonly number[];
  stateIdx: number;
  /** The reveal year (books/ledger read up to here, inclusive). */
  year: number;
  /** The capital's cell — the network's root. */
  seatCell: number;
  /** The capital's chart position (roads measure to it). */
  seatAt: { x: number; y: number };
  /** The name chain's base (the geology seed at tier 0 — §9). */
  nameSeed: number;
}

/** One rank's life, replayed from the crossings. */
interface RankLife {
  foundedYear: number;
  abandonedYear?: number;
}

/**
 * Replay the implied-town crossings into per-rank lives. Founding events
 * carry the count AFTER the rise (rank = count); abandonments the count
 * AFTER the fall (the town that emptied is rank count+1). Crossings are a
 * STACK by construction (the books cross one bar at a time), so the
 * latest-founded empties first — which is also the historical truth:
 * the marginal town is the young one.
 */
function rankLives(
  events: readonly StateEconEvent[],
  stateIdx: number,
  year: number,
  initialCount: number,
): { lives: Map<number, RankLife>; maxReached: number; count: number } {
  const lives = new Map<number, RankLife>();
  let count = Math.max(0, initialCount);
  let maxReached = count;
  for (let k = 1; k <= count; k++) lives.set(k, { foundedYear: 0 }); // the founding condition, eventless
  for (const ev of events) {
    if (ev.state !== stateIdx || ev.year > year) continue;
    if (ev.kind === "founding" && ev.count !== undefined) {
      count = ev.count;
      maxReached = Math.max(maxReached, count);
      lives.set(count, { foundedYear: ev.year }); // a re-founding OVERWRITES: same rank, new life
    } else if (ev.kind === "abandonment" && ev.count !== undefined) {
      const fell = ev.count + 1;
      const life = lives.get(fell);
      if (life && life.abandonedYear === undefined) life.abandonedYear = ev.year;
      count = ev.count;
    }
  }
  // Ranks still ≤ count are ALIVE — clear any stale abandonment from an
  // earlier fall that a later re-founding replaced (the overwrite above
  // already minted the new life, so this is belt on braces).
  for (let k = 1; k <= count; k++) {
    const life = lives.get(k);
    if (life) delete life.abandonedYear;
  }
  return { lives, maxReached, count };
}

/**
 * ⚖️ THE REVEAL — the state's interior at `year`, generated from its own
 * recorded history. Pure; deterministic; two reveals agree on their shared
 * past. Ruins stand at their rank's address with the name they died with.
 */
export function revealState(opts: RevealStateOpts): StateReveal {
  const initial = Math.floor(
    (opts.economy.booksAt(0)[opts.stateIdx]?.pop ?? 0) / TIER_POP_CAP.town,
  );
  const { lives, maxReached } = rankLives(
    opts.economy.events, opts.stateIdx, opts.year, initial,
  );
  const placed = Math.min(maxReached, opts.candidates.length);
  const unplaced = maxReached - placed;

  const towns: RevealedTown[] = [];
  const namesTaken = new Set<string>();
  const wars = (opts.warYears ?? []).filter((w) => w <= opts.year);
  // The elder network grows in FOUNDING order: each town roads to the
  // nearest already-standing member (seat included) at its founding year.
  const network: Array<{ cell: number; x: number; y: number; foundedYear: number }> = [
    { cell: opts.seatCell, x: opts.seatAt.x, y: opts.seatAt.y, foundedYear: -Infinity },
  ];

  const ranks = [...Array(placed).keys()].map((i) => i + 1)
    .filter((k) => lives.has(k))
    .sort((a, b) => {
      const fa = lives.get(a)!.foundedYear;
      const fb = lives.get(b)!.foundedYear;
      return fa - fb || a - b; // founding order; ties by rank
    });

  const byRank = new Map<number, RevealedTown>();
  for (const rank of ranks) {
    const life = lives.get(rank)!;
    const site = opts.candidates[rank - 1]!;
    let name = settlementNameOf(opts.nameSeed, site.cell);
    if (namesTaken.has(name)) name = `${name} ${rank}`;
    namesTaken.add(name);
    // The road, at founding, to the nearest elder standing THEN.
    let road: RevealedTown["road"] = null;
    let bestD = Infinity;
    for (const elder of network) {
      if (elder.foundedYear > life.foundedYear) continue;
      const d = (elder.x - site.x) ** 2 + (elder.y - site.y) ** 2;
      if (d < bestD) { bestD = d; road = { toCell: elder.cell, builtYear: life.foundedYear }; }
    }
    network.push({ cell: site.cell, x: site.x, y: site.y, foundedYear: life.foundedYear });
    const endYear = life.abandonedYear ?? opts.year;
    byRank.set(rank, {
      site,
      rank,
      name,
      foundedYear: life.foundedYear,
      ...(life.abandonedYear !== undefined ? { abandonedYear: life.abandonedYear } : {}),
      ageYears: Math.max(0, endYear - life.foundedYear),
      walls: wars.some((w) => w >= life.foundedYear && w <= endYear),
      road,
    });
  }
  for (let k = 1; k <= placed; k++) {
    const t = byRank.get(k);
    if (t) towns.push(t);
  }
  return { stateIdx: opts.stateIdx, year: opts.year, towns, unplaced };
}
