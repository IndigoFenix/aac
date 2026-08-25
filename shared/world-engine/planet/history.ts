// shared/world-engine/planet/history.ts
//
// THE COURT (nations arc P5) — the layer polities.ts refused to be: it
// decides WHY relabels happen. Two providers, one land register:
//
//   1. DEEP HISTORY (`simulateHistory`) — a deterministic, coarse,
//      centuries-scale political simulation over the tier-0 states:
//      the dispute machine's channels (kernel/civ/dual.ts, P4) in CLOSED
//      FORM. Nonviolent channels are the strong closed forms (prestige
//      and union ride smooth scalars; war was always the weak
//      path-dependent claim — nations-and-empires.md §7), so a world
//      whose culture taboos violence still grows and breaks empires.
//      Output is an append-only event ledger; ownership at any year is
//      REPLAY, never stored per-year (the polities discipline: derived
//      state stays derived).
//
//   2. THE LIVE BINDING (`applyResolutions`) — project a running dual
//      world's dispute resolutions (P4 `resolutions()`) onto the polity
//      ledger: political/physical falls cede the loser's state, unions
//      merge crowns. This replaces the P1 "the hook decides" stopgap.
//
// planHistory (kernel/civ/plan.ts) stays politically silent by design;
// this module is the "mix providers" politics layer coarse-simulated on
// top (civilization-emergence §3).
//
// Data only, THREE-free, deterministic — same inputs, same history.

import type { PlanetStates } from "./states.js";
import type { PlanetCity } from "./cities.js";
import type { PlanetPolities } from "./polities.js";
import type { DisputeChannelId } from "../kernel/civ/dual.js";
// The draw moved to the destiny module (states round S0) — one definition
// of the coordinate-keyed hash for every rung; this court re-imports it.
import { hash01 } from "../kernel/destiny.js";

/** One relabel with its cause. `year` is whole game-years since founding
 *  (deep history runs above the one canonical day — playback maps years
 *  to the scrubber, not to the live clock). */
export interface PolityEvent {
  year: number;
  /** cede = one state changes crowns; merge = the loser's WHOLE holding
   *  joins the winner; secede = a state reverts to its own founding
   *  crown (fission — polity id = state index, so no new row is ever
   *  needed). */
  kind: "cede" | "merge" | "secede";
  /** The dispute channel that produced it ("strain" is secession's
   *  internal cause — the empire crumbling under its own size). */
  channel: DisputeChannelId | "strain";
  /** cede/secede: the state relabeled. Absent on merge. */
  state?: number;
  /** Losing polity id. */
  from: number;
  /** Gaining polity id (secede: the reborn founding crown). */
  to: number;
}

export interface PoliticalHistory {
  /** Simulated span in whole years. */
  years: number;
  /** Append-only, ascending year. */
  events: readonly PolityEvent[];
  /** Ownership at year t (clamped to [0, years]): state index → polity
   *  id, replayed from founding. A fresh array every call. */
  ownerAt(year: number): Int32Array;
  /** Living polity ids at year t, ascending. */
  livingAt(year: number): number[];
  /** Relabel a LIVE ledger to match year t — cede-only diffs (the
   *  unions ledger stays reserved for real consented merges), one
   *  version bump per changed state. Returns how many states moved. */
  applyTo(polities: PlanetPolities, year?: number): number;
}

export interface HistoryTuning {
  /** Yearly hostility accrual on polity borders (± noise). */
  hostilityAccrual: number;
  /** Hostility that arms the hot channels. */
  hostilityAt: number;
  /** War: conqueror strength ≥ ratio × defender. */
  warRatio: number;
  /** Prestige: luster-weighted strength ≥ ratio × the other's. */
  prestigeRatio: number;
  /** Union: yearly affinity accrual on COLD borders (± noise). */
  affinityAccrual: number;
  /** Affinity that consummates a union. */
  affinityAt: number;
  /** Yearly strain per extra held state (± noise); at 1, secession. */
  strainPerState: number;
}

export const HISTORY_TUNING: HistoryTuning = {
  hostilityAccrual: 0.18,
  hostilityAt: 1,
  warRatio: 1.5,
  prestigeRatio: 1.8,
  affinityAccrual: 0.11,
  affinityAt: 1,
  strainPerState: 0.02,
};

export interface SimulateHistoryOpts {
  cities: readonly PlanetCity[];
  states: PlanetStates;
  seed: number;
  /** Whole game-years to simulate. */
  years: number;
  /** Channels the world's culture forbids (nations §6 — feed
   *  `channelTaboos(culture.absolutes)` from kernel/civ/dual). A
   *  violence-taboo world writes a BLOODLESS history: fusion through
   *  prestige and union only, fission through strain. */
  taboos?: readonly DisputeChannelId[];
  /** Per-state strength weight. Default: the founding capital's
   *  `startPop` (floor 1) — bigger cities anchor stronger crowns. The
   *  YEAR is passed so political strength can ride the state's BOOKS
   *  (state-books.ts `StateEconomy.stateWeight` plugs in directly —
   *  states round S1); a year-blind function still typechecks and the
   *  default path is byte-identical to before the parameter existed. */
  stateWeight?: (stateIdx: number, year: number) => number;
  tuning?: Partial<HistoryTuning>;
}

/** Per-state neighbor lists from the derived `states.adjacency` pairs
 *  (a < b, unique) — the tier-0 graph the political layer runs on
 *  (§7 "disputes live on tier-0 edges"). */
export function stateAdjacency(states: PlanetStates, stateCount: number): number[][] {
  const adj: number[][] = Array.from({ length: stateCount }, () => []);
  for (const { a, b } of states.adjacency) {
    if (a < 0 || b < 0 || a >= stateCount || b >= stateCount) continue;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  for (const list of adj) list.sort((x, y) => x - y);
  return adj;
}

/** Replay events (≤ year when given) onto founding ownership. Exported
 *  shape of the polities founding rule: state i belongs to polity i. */
function replayOwners(stateCount: number, events: readonly PolityEvent[], year?: number): Int32Array {
  const owner = new Int32Array(stateCount);
  for (let i = 0; i < stateCount; i++) owner[i] = i;
  for (const ev of events) {
    if (year !== undefined && ev.year > year) break;
    if (ev.kind === "merge") {
      for (let s = 0; s < stateCount; s++) if (owner[s] === ev.from) owner[s] = ev.to;
    } else {
      owner[ev.state!] = ev.to;
    }
  }
  return owner;
}

/**
 * Deep political history: centuries of fusion and fission over the
 * tier-0 states, deterministic in (cities, states, seed, years, taboos).
 *
 * Per year, per adjacent crown pair: hostility (or, when cold, affinity)
 * accrues with hash noise; the first channel at threshold resolves —
 * union merges the smaller crown into the larger, war cedes one border
 * state to a sufficiently stronger neighbor, prestige (luster-weighted
 * strength, luster drifting on ~16-year noise so leaders CHANGE — the
 * fall half of rise-and-fall) defects one border state without a body
 * count. Independently, strain grows with a crown's size and secedes a
 * peripheral state back to its founding crown when it fires. Empires
 * assemble while small, crumble when vast — the imperial cycle at
 * planetary grain.
 */
export function simulateHistory(opts: SimulateHistoryOpts): PoliticalHistory {
  const { cities, states, seed, years } = opts;
  const tune: HistoryTuning = { ...HISTORY_TUNING, ...(opts.tuning ?? {}) };
  const taboo = new Set(opts.taboos ?? []);
  const n = cities.length;
  const weight = (s: number, year: number): number =>
    opts.stateWeight ? opts.stateWeight(s, year) : Math.max(1, cities[s]?.startPop ?? 1);
  const adj = stateAdjacency(states, n);

  const events: PolityEvent[] = [];
  // Running political state — never serialized, replay is the contract.
  const owner = new Int32Array(n);
  for (let i = 0; i < n; i++) owner[i] = i;
  const hostility = new Map<number, number>(); // pair key → pressure
  const affinity = new Map<number, number>();  // pair key → warmth
  const strain = new Map<number, number>();    // polity id → fission pressure

  const pairKey = (a: number, b: number): number => (a < b ? a * n + b : b * n + a);

  /** Luster: a crown's prestige multiplier, drifting on ~16-year value
   *  noise — deterministic, smooth, and different per crown, so which
   *  neighbor outshines which CHANGES over the centuries. */
  const luster = (p: number, year: number): number => {
    const block = Math.floor(year / 16);
    const t = (year - block * 16) / 16;
    const a = hash01(seed, p, block, 0, 101);
    const b = hash01(seed, p, block + 1, 0, 101);
    return 0.6 + 0.8 * (a + (b - a) * t);
  };

  /** First state of `loser` bordering `winner`, ascending — the border
   *  town that falls/defects. */
  const borderStateOf = (loser: number, winner: number): number => {
    for (let s = 0; s < n; s++) {
      if (owner[s] !== loser) continue;
      for (const nb of adj[s]!) if (owner[nb] === winner) return s;
    }
    return -1;
  };

  /** The most peripheral state of a crown (fewest same-crown neighbors,
   *  never the capital while an alternative exists) — where secession
   *  starts. */
  const peripheralStateOf = (p: number): number => {
    let best = -1;
    let bestScore = Infinity;
    for (let s = 0; s < n; s++) {
      if (owner[s] !== p) continue;
      let same = 0;
      for (const nb of adj[s]!) if (owner[nb] === p) same++;
      const score = same + (s === p ? 1000 : 0); // the capital resists
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  };

  for (let year = 1; year <= years; year++) {
    // Crown strengths this year (Σ state weights over the holding).
    const strength = new Map<number, number>();
    for (let s = 0; s < n; s++) strength.set(owner[s]!, (strength.get(owner[s]!) ?? 0) + weight(s, year));

    // Adjacent crown pairs, canonical order, deterministic scan.
    const pairs: Array<[number, number]> = [];
    {
      const seen = new Set<number>();
      for (let s = 0; s < n; s++) {
        for (const nb of adj[s]!) {
          const a = owner[s]!;
          const b = owner[nb]!;
          if (a === b) continue;
          const key = pairKey(a, b);
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push(a < b ? [a, b] : [b, a]);
        }
      }
      pairs.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
      // Pressure on pairs no longer adjacent evaporates with the border.
      for (const key of [...hostility.keys()]) if (!seen.has(key)) hostility.delete(key);
      for (const key of [...affinity.keys()]) if (!seen.has(key)) affinity.delete(key);
    }

    for (const [a, b] of pairs) {
      // A pair resolved earlier this year may have dissolved one side.
      if (!strength.has(a) || !strength.has(b)) continue;
      const key = pairKey(a, b);
      const sa = strength.get(a)!;
      const sb = strength.get(b)!;

      // Disposition drifts on ~16-year eras, per pair: in a friendly era
      // affinity grows while hostility cools; in a quarrelsome one (most)
      // the reverse — so SOME neighbors court union while others arm.
      // Without eras hostility always outraces affinity and unions never
      // happen; with them, relationships change over the centuries.
      const era = Math.floor(year / 16);
      const friendly = hash01(seed, era, Math.min(a, b), Math.max(a, b), 21) < 0.35;
      let hot = hostility.get(key) ?? 0;
      let warm = affinity.get(key) ?? 0;
      if (friendly) {
        warm += tune.affinityAccrual * (0.5 + hash01(seed, year, a, b, 7));
        hot = Math.max(0, hot - tune.hostilityAccrual);
      } else {
        hot += tune.hostilityAccrual * (0.5 + hash01(seed, year, a, b, 3));
        warm = Math.max(0, warm - tune.affinityAccrual);
      }

      // UNION — both heads consent on a cold, warm border.
      if (!taboo.has("union") && warm >= tune.affinityAt && hot < tune.hostilityAt / 2) {
        const winner = sa >= sb ? a : b;
        const loser = winner === a ? b : a;
        events.push({ year, kind: "merge", channel: "union", from: loser, to: winner });
        for (let s = 0; s < n; s++) if (owner[s] === loser) owner[s] = winner;
        strength.set(winner, sa + sb);
        strength.delete(loser);
        affinity.delete(key);
        hostility.delete(key);
        continue;
      }
      affinity.set(key, warm);
      if (hot < tune.hostilityAt) { hostility.set(key, hot); continue; }

      // HOT: the first armed channel resolves the year the clamp lands.
      // War — one border state falls to a sufficiently stronger crown.
      if (!taboo.has("war") && (sa >= sb * tune.warRatio || sb >= sa * tune.warRatio)) {
        const winner = sa >= sb ? a : b;
        const loser = winner === a ? b : a;
        const s = borderStateOf(loser, winner);
        if (s >= 0) {
          events.push({ year, kind: "cede", channel: "war", state: s, from: loser, to: winner });
          owner[s] = winner;
          strength.set(winner, strength.get(winner)! + weight(s, year));
          strength.set(loser, strength.get(loser)! - weight(s, year));
          if (strength.get(loser)! <= 0) strength.delete(loser);
          hostility.delete(key);
          continue;
        }
      }
      // Prestige — the flip without the siege: luster-weighted strength.
      if (!taboo.has("prestige")) {
        const pa = sa * luster(a, year);
        const pb = sb * luster(b, year);
        if (pa >= pb * tune.prestigeRatio || pb >= pa * tune.prestigeRatio) {
          const winner = pa >= pb ? a : b;
          const loser = winner === a ? b : a;
          const s = borderStateOf(loser, winner);
          if (s >= 0) {
            events.push({ year, kind: "cede", channel: "prestige", state: s, from: loser, to: winner });
            owner[s] = winner;
            strength.set(winner, strength.get(winner)! + weight(s, year));
            strength.set(loser, strength.get(loser)! - weight(s, year));
            if (strength.get(loser)! <= 0) strength.delete(loser);
            hostility.delete(key);
            continue;
          }
        }
      }
      // Matched crowns, nothing armed: the border stays hot at the clamp
      // (the frozen stalemate — cold war at planetary grain).
      hostility.set(key, tune.hostilityAt);
    }

    // STRAIN — fission. Big crowns accumulate it; when it fires, the
    // most peripheral state reverts to its own founding crown.
    for (const p of [...strength.keys()].sort((x, y) => x - y)) {
      let count = 0;
      for (let s = 0; s < n; s++) if (owner[s] === p) count++;
      if (count < 2) { strain.delete(p); continue; }
      const st = (strain.get(p) ?? 0)
        + tune.strainPerState * (count - 1) * (0.5 + hash01(seed, year, p, 0, 13));
      if (st >= 1) {
        const s = peripheralStateOf(p);
        if (s >= 0 && s !== p) {
          events.push({ year, kind: "secede", channel: "strain", state: s, from: p, to: s });
          owner[s] = s;
        }
        strain.set(p, 0);
      } else {
        strain.set(p, st);
      }
    }
  }

  return {
    years,
    events,
    ownerAt: (year) => replayOwners(n, events, Math.max(0, Math.min(years, Math.floor(year)))),
    livingAt(year) {
      const o = replayOwners(n, events, Math.max(0, Math.min(years, Math.floor(year))));
      return [...new Set(o)].sort((x, y) => x - y);
    },
    applyTo(polities, year) {
      const target = replayOwners(n, events, year === undefined ? years : Math.max(0, Math.min(years, Math.floor(year))));
      let moved = 0;
      for (let s = 0; s < n; s++) {
        if (polities.polityOfState(s) !== target[s] && polities.cede(s, target[s]!)) moved++;
      }
      return moved;
    },
  };
}

// ---------------------------------------------------------------------------
// The LIVE binding — disputes decide relabels (the P1 stopgap retired).
// ---------------------------------------------------------------------------

/** One dual-world resolution row (kernel/civ/dual.ts `resolutions()`). */
export interface DisputeResolutionRow {
  day: number;
  edge: number;
  channel: DisputeChannelId;
  loser: string;
  winner: string;
  civ: string;
  mode: "political" | "physical" | "award";
  casualties: number;
}

/**
 * Project a running dual world's dispute resolutions onto the polity
 * ledger. `siteState` maps a civ-graph site key to its tier-0 state
 * index (-1/undefined = a site the planet doesn't claim — ignored).
 *
 *   political/physical → the loser site's state cedes to the crown
 *                        holding the winner site's state
 *   union              → the loser crown merges into the winner crown
 *   award              → claims stand — nothing to write
 *
 * Rows are append-only; pass `fromIndex` = how many were already applied
 * and the return value is the new high-water mark (the caller keeps it).
 */
export function applyResolutions(
  polities: PlanetPolities,
  rows: readonly DisputeResolutionRow[],
  siteState: (siteKey: string) => number | undefined,
  fromIndex = 0,
): number {
  for (let i = fromIndex; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.mode === "award") continue;
    const loserState = siteState(r.loser) ?? -1;
    const winnerState = siteState(r.winner) ?? -1;
    if (loserState < 0 || winnerState < 0) continue;
    const winnerPolity = polities.polityOfState(winnerState);
    const loserPolity = polities.polityOfState(loserState);
    if (winnerPolity < 0 || loserPolity < 0 || winnerPolity === loserPolity) continue;
    if (r.channel === "union") {
      polities.merge(winnerPolity, loserPolity);
    } else {
      polities.cede(loserState, winnerPolity);
    }
  }
  return rows.length;
}
