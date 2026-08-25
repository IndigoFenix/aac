/**
 * town-world.ts — a STANDALONE LIVING TOWN: one settlement's books,
 * booted from a compiled economy and a charter, with no composition
 * layer above it. This is the engine's smallest inhabited world — the
 * piece a fixed-area game (the symbol-learning town) hosts directly.
 *
 * What the four-layer worlds get from PopuSim, this replaces with the
 * minimal settlement-scale forms, written at day start exactly where
 * the dual coupling writes them:
 *
 *   demand     — primary-species per-head rows × population, into the
 *                same demand scalars the coupling would fill (popScalar
 *                fan-in included, so needSum economies work unchanged).
 *   population — one Malthusian policy (the economy's civic vitals):
 *                growth = birth − death − starvation×(1 − diet fill),
 *                with the same pen-capacity headroom domestic herds use
 *                when the policy declares one. Scarcity self-limits the
 *                town — Malthus needs no artificial cap. A host that KNOWS
 *                its seat count may still declare a crowding ceiling
 *                (`opts.capacity`), and that number is not artificial
 *                either: it is derived from the street-tree capacity the
 *                settlement's tier actually houses (scale.ts
 *                `TIER_POP_CAP` — measured frontage slots × HOUSEHOLD —
 *                amplified so equilibrium lands ON the seats;
 *                food-scale-round.md STAGE β1/β1b). A host that declares
 *                none gets the pre-β world byte-identically.
 *
 * Everything else IS the compiled economy: the same vars/rules/processes
 * /flow nets the tri settlements run, gated by the same idle-safety
 * validator. No demography (named residents, migration, herds, politics)
 * — those arrive with the demography module, not before.
 *
 * Time: `step(days)` advances day by day while anything moves, then
 * REST-JUMPS the remainder (worldFastForward) once the settlement rests
 * and the population is stable — a persistent town catches up cheaply
 * after any absence.
 */

import { createWorld, stepWorld, worldFastForward, type EntityWorld } from "../cells/entities";
import type { WorldSpec } from "../cells/spec";
import { validateWorldSpec } from "../cells/world-validate";
import type { CompiledEconomy, VitalsSpec } from "../modules/economy/economy";
import { townRoadBearingsOf, townRoadSeedsOf, type TownHost } from "./host";
import type { GrowSeed } from "./streets";

export interface TownWorldOpts {
  economy: CompiledEconomy;
  /** The site's endowment — what the substrate would have chartered. */
  charter: { farmland: number; ore_access: number; timberland?: number; pasture?: number };
  /** Founding population (primary species). */
  startPop: number;
  /** THE SETTLEMENT'S CROWDING CEILING, in souls (food-scale-round.md STAGE
   *  β1/β1b) — the population at which births taper to ZERO, which is NOT
   *  the number the town settles on: the logistic taper
   *  (`births *= 1 − pop/cap`) equilibrates at
   *  `capacity × (1 − deathRate/birthRate)`. A caller that wants
   *  equilibrium ON a seat count therefore passes
   *  `seats ÷ (1 − death/birth)` — town-play does exactly that from
   *  `TIER_POP_CAP[config.tier]` (the MEASURED street-tree seats of the
   *  tier's extent), so population converges to the seats the streets
   *  actually hold. Present ⇒ the Malthus integrator's `vitals.capacity`
   *  binds to it through the tri worlds' own ceiling scalar ("pop_ceiling"
   *  — kernel/civ/tri.ts `ceilings` convention). Absent ⇒ NOTHING is
   *  declared: no scalar, no vitals.capacity entry — the uncapped world
   *  stays byte-identical (the dollhouse bench replay and the deliberately
   *  tierless planet capitals both stand on that; tier-0 capitals are a
   *  standing design call). */
  capacity?: number;
  /** Founding building/stock grants (content's call — a world seeded
   *  with nothing that produces its staple starves, honestly; see
   *  grand-dream's villageSeed for the standard founding farm). */
  seedScalars?: Record<string, number>;
  key?: string;
  /** TRUE approach bearings of the site's incident roads (TownHost
   *  seam). Absent = whatever provideTownRoadBearings registered under
   *  `key` (the handoff for hosts built from a plain config). */
  roadBearings?: readonly number[];
  /** WHAT THE TOWN GREW AROUND (growth phase B §2.1) — the incident roads
   *  as town-local growth seeds (TownHost seam; supersedes `roadBearings`
   *  where the host has the geometry). Absent = whatever
   *  provideTownRoadSeeds registered under `key`. */
  roadSeeds?: readonly GrowSeed[];
}

export interface TownWorld extends TownHost {
  key: string;
  economy: CompiledEconomy;
  /** Days lived so far. */
  day: number;
  /** The settlement books, directly (single entity). */
  scalar(name: string): number;
  /** An EXTERNAL write into the books (quest outcomes, gifts, disasters):
   *  adds `delta`, clamped to the var's declared bounds. The idle-safety
   *  contract holds — an injection is an input edge, exactly like the
   *  lab's injectTile, and the world re-settles from it. */
  inject(name: string, delta: number): void;
  /** Advance the town. Steps daily while anything moves; rest-jumps the
   *  remainder once the books and the population are both still. */
  step(days?: number): void;
  /** Richer than TownHost's dual: the entity world rides along so the
   *  street layer's ledger checks (hasLedger) read the real books. */
  dual: { settlementScalar(siteKey: string, scalar: string): number; entityWorld: EntityWorld };
}

/** The ceiling anchor's name — the tri worlds' own convention
 *  (kernel/civ/tri.ts `ceilings`: default "pop_ceiling"; a STRUCTURAL
 *  scalar in economy.ts, so no compiled economy ever declares it itself
 *  and the name is free in every TownWorld's namespace). */
const CAPACITY_SCALAR = "pop_ceiling";

/** The structural vars every settlement carries beside its economy —
 *  the same list the tri worlds declare (population written by the
 *  layer above, charter attrs, the unrest input). `withCapacity` adds
 *  the ceiling anchor ONLY when the host declared a seat count — an
 *  undeclared capacity must leave the spec byte-identical, not merely
 *  equivalent (STAGE β1's absent-path law). */
function settlementSpec(eco: CompiledEconomy, withCapacity: boolean): WorldSpec {
  const v = (name: string, max: number): { name: string; min: number; max: number; initial: number } =>
    ({ name, min: 0, max, initial: 0 });
  return {
    id: "town-settlement",
    entity: {
      id: "town",
      vars: [
        v("population", 1_000_000), v("farmland", 2000), v("ore_access", 2000), v("timberland", 2000),
        v("pasture", 2000),
        ...(withCapacity ? [v(CAPACITY_SCALAR, 1_000_000)] : []),
        ...eco.vars,
        v("unrest", 1),
      ],
      rules: eco.rules,
    },
    edge: { vars: [{ name: "road", min: 0.05, max: 1, initial: 0.05 }, { name: "hostility", min: 0, max: 1, initial: 0 }] },
    processes: eco.processes,
    ...(eco.sums.length ? { sums: eco.sums } : {}),
    ...(eco.allocates.length ? { allocates: eco.allocates } : {}),
    flownets: eco.flownets,
    roads: eco.roads,
  } as WorldSpec;
}

export function createTownWorld(opts: TownWorldOpts): TownWorld {
  const eco = opts.economy;
  const key = opts.key ?? "town";
  const charter = { timberland: 0, pasture: 0, ...opts.charter };
  // Snapshot at construction: the registry is a handoff, not live state —
  // a later (re)registration must never re-lay a running town's streets.
  const roadBearings = opts.roadBearings ?? townRoadBearingsOf(key);
  const roadSeeds = opts.roadSeeds ?? townRoadSeedsOf(key);

  const capacity = opts.capacity;
  const spec = settlementSpec(eco, capacity !== undefined);
  const valid = validateWorldSpec(spec);
  if (!valid.ok) {
    throw new Error(`town: settlement spec rejected: ${valid.errors.join("; ")}`);
  }
  const ew = createWorld(spec, 1, []);

  const write = (name: string, value: number): void => {
    const arr = ew.scalars[name];
    if (!arr) throw new Error(`town: settlement spec has no scalar '${name}'`);
    arr[0] = value;
  };
  const read = (name: string): number => ew.scalars[name]?.[0] ?? 0;
  const bounds = new Map((spec.entity.vars ?? []).map(v => [v.name, v] as const));
  const inject = (name: string, delta: number): void => {
    const b = bounds.get(name);
    if (!b) throw new Error(`town: settlement spec has no scalar '${name}'`);
    write(name, Math.max(b.min, Math.min(b.max, read(name) + delta)));
  };

  write("farmland", charter.farmland);
  write("ore_access", charter.ore_access);
  write("timberland", charter.timberland);
  write("pasture", charter.pasture);
  if (capacity !== undefined) write(CAPACITY_SCALAR, capacity);
  for (const [k, v] of Object.entries(opts.seedScalars ?? {})) write(k, v);

  // The primary (civic-first) Malthusian policy and its species' demand
  // rows — the standalone's whole composition layer. A declared crowding
  // ceiling binds the policy's births-taper to the ceiling anchor
  // (`births *= max(0, 1 − pop/cap)`, the pen-capacity headroom domestic
  // herds already run) — the host's ceiling, derived from its MEASURED
  // body, outranks whatever the doc may have bound, because the host is
  // the one that built the streets. Undeclared ⇒ the doc's own vitals
  // object, untouched (byte-identical absent path; food-scale-round.md
  // STAGE β1).
  const docVitals: VitalsSpec = eco.vitals[0] ?? { birthRate: 0.02, deathRate: 0.01 };
  const vitals: VitalsSpec = capacity !== undefined
    ? { ...docVitals, capacity: { scalar: CAPACITY_SCALAR, perUnit: 1 } }
    : docVitals;
  const scalarFor = new Map(eco.demandInputs.map(d => [d.resource, d.scalar] as const));
  const demand = (eco.speciesTraits[0]?.demand ?? []).map(row => ({
    scalar: scalarFor.get(row.resource) ?? `${row.resource}_need`,
    perHead: row.value,
  }));

  let pop = Math.max(0, opts.startPop);
  let day = 0;

  // Day-0 books (city-founding): an AGE-0 town is never fast-forwarded, so
  // the composition slots must be readable before the first step — its
  // founding population is real people, not a 0 until tomorrow. Any stepped
  // town overwrites these at its first day start, byte-identically.
  write("population", pop);
  for (const d of demand) write(d.scalar, pop * d.perHead);

  const stepOne = (): boolean => {
    // Day start: the composition writes (population, demand) — exactly
    // the coupling's slots, minimally filled.
    write("population", pop);
    for (const d of demand) write(d.scalar, pop * d.perHead);
    const changed = stepWorld(ew);

    // Day end: vitals on the diet fill the settlement just delivered.
    const need = vitals.foodNeed ? read(vitals.foodNeed) : 0;
    const fill = need > 0 ? Math.max(0, Math.min(1, read(vitals.foodGot ?? "") / need)) : 1;
    let births = pop * vitals.birthRate;
    if (vitals.capacity) {
      const cap = read(vitals.capacity.scalar) * vitals.capacity.perUnit;
      births *= cap > 0 ? Math.max(0, 1 - pop / cap) : 0;
    }
    const deaths = pop * (vitals.deathRate + (vitals.starvation ?? 0) * (1 - fill));
    const next = Math.max(0, pop + births - deaths);
    const stable = Math.abs(next - pop) < 1e-9;
    pop = next;
    day++;
    return changed || !stable;
  };

  const step = (days = 1): void => {
    for (let d = 0; d < days; d++) {
      const moved = stepOne();
      if (!moved && d < days - 1) {
        // The books rest and the population is still: the remaining
        // days are one rest-jump (exact — nothing external will move).
        const remaining = days - 1 - d;
        worldFastForward(ew, remaining);
        day += remaining;
        return;
      }
    }
  };

  const world: TownWorld = {
    key,
    economy: eco,
    get day() { return day; },
    cities: [{ key, x: 0, y: 0 }],
    charterOf: siteKey => {
      if (siteKey !== key) throw new Error(`town: unknown city "${siteKey}"`);
      return charter;
    },
    grid: undefined,
    roadBearings: siteKey => (siteKey === key ? roadBearings : null),
    roadSeeds: siteKey => (siteKey === key ? roadSeeds : null),
    dual: {
      settlementScalar: (siteKey, scalar) => (siteKey === key ? read(scalar) : 0),
      entityWorld: ew,
    },
    scalar: read,
    inject,
    step,
  };
  return world;
}
