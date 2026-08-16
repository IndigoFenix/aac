// shared/world-engine/planet/polities.ts
//
// THE POLITY LEDGER (nations arc P1) — the mutation layer states.ts
// reserved: "a future merge (two player-rulers joining crowns) is a relabel
// in the MUTATION layer, not new geometry here." A STATE is still the
// derived cost-Voronoi claim of its founding capital (states.ts, pure,
// recomputed every boot); a POLITY is who holds it — a serializable relabel
// table over state indices, TownDeltas-pattern (toJSON round-trip, no RNG,
// append-only event ledger).
//
// Founding condition: every state is its own polity — a planet of
// city-states. Nations and empires are RELABELS accreted through the
// resolution channels (union, conquest, capitulation — the dispute machine,
// P4); fission relabels back. Nothing here decides WHY a relabel happens —
// this module is the land register, not the court.
//
// Data only, THREE-free, deterministic.

import type { PlanetStates } from "./states.js";
import type { PlanetCity } from "./cities.js";

export interface PolityRow {
  /** Stable ordinal — polity k founded on this planet, forever. */
  id: number;
  /** Display name (the founding capital's name at birth — a merged crown
   *  keeps the winner's name; renames are a future court concern). */
  name: string;
  /** Map ink, "#rrggbb" — deterministic in the founding order. */
  color: string;
  /** The founding capital's STATE index (= its index in the cities array).
   *  A dormant polity (no states held) keeps it as a historical fact. */
  capitalState: number;
}

export interface PolityUnion {
  /** Winner/loser polity ids — the loser's whole holding relabeled. */
  winner: number;
  loser: number;
}

export interface SerializedPolities {
  rows: PolityRow[];
  /** State index → polity id. */
  polityOfState: number[];
  /** Whole-polity merges, oldest first (append-only). */
  unions: PolityUnion[];
}

export interface PlanetPolities {
  /** Bumped on every relabel — renderers watch it (TownDeltas.version). */
  version: number;
  rows(): readonly PolityRow[];
  get(id: number): PolityRow | undefined;
  /** Polity id holding a STATE, or -1 for an unknown state index.
   *  (Cell → polity goes through `claimReader` — the ledger never stores
   *  derived geometry.) */
  polityOfState(stateIdx: number): number;
  /** State indices a polity holds, ascending. */
  statesOf(id: number): number[];
  /** Polities holding at least one state (the living map). */
  living(): PolityRow[];
  /** Relabel ONE state (the general op — arbitration awards, border
   *  cessions). False when the state/polity is unknown. */
  cede(stateIdx: number, toPolity: number): boolean;
  /** Relabel the loser's WHOLE holding to the winner and record the union
   *  (append-only). False on unknown ids, self-merge, or a loser already
   *  landless. */
  merge(winnerId: number, loserId: number): boolean;
  unions(): readonly PolityUnion[];
  /** states.borderCells filtered to pairs whose POLITIES differ — the
   *  polity map's border ink (internal state lines vanish when crowns
   *  join). */
  claimBorderCells(states: PlanetStates): Array<[number, number]>;
  toJSON(): SerializedPolities;
}

/** Deterministic map ink: golden-angle hue walk, fixed sat/light — spaced,
 *  stable, and never dependent on Math.random. */
export function polityColor(index: number): string {
  const h = (index * 137.50776405) % 360;
  const s = 0.58;
  const l = 0.52;
  // HSL → RGB (compact, exact enough for ink).
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`;
}

/**
 * Found (or restore) the polity ledger for a claimed planet. Founding is
 * deterministic in the cities array: state i (the cost-Voronoi claim of
 * cities[i]) belongs to polity i, named for its capital. A serialized
 * ledger restores relabels exactly; a restored ledger whose row count
 * TRAILS the city list (new founded sites claimed states since the save)
 * founds the missing city-states on top, prefix-stable.
 */
export function createPolities(
  cities: readonly PlanetCity[],
  json?: SerializedPolities,
): PlanetPolities {
  const rows: PolityRow[] = (json?.rows ?? []).map(r => ({ ...r }));
  const polityOfState: number[] = [...(json?.polityOfState ?? [])];
  const unions: PolityUnion[] = (json?.unions ?? []).map(u => ({ ...u }));
  // Found city-states for any state the save doesn't cover (prefix-stable:
  // restored rows keep their ids; new states extend).
  for (let i = rows.length; i < cities.length; i++) {
    rows.push({ id: i, name: cities[i]!.name, color: polityColor(i), capitalState: i });
  }
  for (let i = polityOfState.length; i < cities.length; i++) polityOfState.push(i);

  const byId = new Map<number, PolityRow>(rows.map(r => [r.id, r]));

  const store: PlanetPolities = {
    version: 0,
    rows: () => rows,
    get: id => byId.get(id),
    polityOfState: s => (s >= 0 && s < polityOfState.length ? polityOfState[s]! : -1),
    statesOf(id) {
      const out: number[] = [];
      for (let s = 0; s < polityOfState.length; s++) if (polityOfState[s] === id) out.push(s);
      return out;
    },
    living() {
      const held = new Set(polityOfState);
      return rows.filter(r => held.has(r.id));
    },
    cede(stateIdx, toPolity) {
      if (stateIdx < 0 || stateIdx >= polityOfState.length) return false;
      if (!byId.has(toPolity)) return false;
      if (polityOfState[stateIdx] === toPolity) return false;
      polityOfState[stateIdx] = toPolity;
      store.version++;
      return true;
    },
    merge(winnerId, loserId) {
      if (winnerId === loserId) return false;
      if (!byId.has(winnerId) || !byId.has(loserId)) return false;
      let moved = 0;
      for (let s = 0; s < polityOfState.length; s++) {
        if (polityOfState[s] === loserId) {
          polityOfState[s] = winnerId;
          moved++;
        }
      }
      if (!moved) return false; // a landless loser has nothing to join with
      unions.push({ winner: winnerId, loser: loserId });
      store.version++;
      return true;
    },
    unions: () => unions,
    claimBorderCells(states) {
      const out: Array<[number, number]> = [];
      for (const [a, b] of states.borderCells) {
        const pa = store.polityOfState(states.stateOf[a]!);
        const pb = store.polityOfState(states.stateOf[b]!);
        if (pa !== pb) out.push([a, b]);
      }
      return out;
    },
    toJSON: () => ({
      rows: rows.map(r => ({ ...r })),
      polityOfState: [...polityOfState],
      unions: unions.map(u => ({ ...u })),
    }),
  };
  return store;
}

/** Claim reader bound to a specific derived claim map: cell → polity id
 *  (-1 unclaimed). Kept OUTSIDE the ledger so serialized state never
 *  carries derived geometry. */
export function claimReader(
  polities: PlanetPolities,
  states: PlanetStates,
): (cell: number) => number {
  return cell => {
    const s = cell >= 0 && cell < states.stateOf.length ? states.stateOf[cell]! : -1;
    return s < 0 ? -1 : polities.polityOfState(s);
  };
}
