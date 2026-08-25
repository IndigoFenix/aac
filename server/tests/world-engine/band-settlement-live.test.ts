// ⚖️ B-③ "THE STORE RIDES" — the LIVE ARM
// (planning-docs/games/world-engine/band-settlement-round.md).
//
// The unit arm pins `settleBand` returning `{total, mix, store}` and
// `settledTownStack`'s rations→units identity in isolation. THIS suite pins
// the same law where it actually has to hold: inside a REAL `foundTri`,
// driven day by day, with a band that gathers on the grid, LIVES on the
// land's offer, banks against spoilage, and settles under Gate A. Nothing
// here mints a store — the number asserted on the founded city's record is
// the integral of days the band survived.
//
// ── THE FAKE-BOOT HONESTY BOUNDARY ───────────────────────────────────────
// `foundTri` takes its composition backend as an explicit parameter
// (composition.ts `CompositionBoot`); PopuSim lives in grand-dream and
// cannot be imported into a server jest suite. So this file supplies a
// minimal STATIC composition: sites hold the population they were founded
// with, routes exist, the day counter ticks. Populations here neither grow,
// die, nor migrate — there is no demography under this test and no
// assertion pretends there is.
//
// That boundary is safe because the arc under test is entirely GRID-SIDE
// and it is REAL, not faked: the substrate, `gatherBand`, `stepBandDay`'s
// yield/eat/bank/spoil cycle, `bandPressure`'s circumscription scan,
// `gateASettles`, and `commitFounding`'s `condenseTown` mint are all the
// shipped code. The composition layer's only job in this arc is to ACCEPT
// the founding (`dual.foundSettlement` → `ops.addSite`), which the fake
// does honestly — and refusing would keep the band standing, so a fake that
// lied by refusing would fail the suite rather than pass it vacuously.
//
// The CENSUS CONTROL at the bottom pins the other arm of the same law: a
// founding with no band behind it carries the same record shape with an
// EMPTY shelf. The record is not a band artifact; the STORE is.
//
// DB-free, GL-free, LLM-free.

import { describe, it, expect } from "@jest/globals";
import { REAL_PORTER_BULK, freightOf } from "@shared/world-engine/freight.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";
import {
  prepareSubstrate, foundTri, type TriWorld,
} from "@shared/world-engine/kernel/civ/tri.js";
import type { DualSpec } from "@shared/world-engine/kernel/civ/dual.js";
import type {
  CompositionBoot, CompositionOps, CompositionRouteInfo, CompositionSite,
  CompositionWorld,
} from "@shared/world-engine/kernel/civ/composition.js";

// ───────────────────────────────────── the fake composition backend

interface FakeRoute { key: string; a: string | null; b: string | null; strength: number; migration: number }

/** A STATIC composition world: it holds the graph the dual layer authored,
 *  accepts foundings and routes, and ticks a day counter. No births, no
 *  deaths, no ranged sheds — see the header's honesty boundary. */
const staticBoot: CompositionBoot = async (scenario): Promise<CompositionWorld> => {
  const sites: CompositionSite[] = [];
  const routes: FakeRoute[] = [];
  let day = 0;

  const siteOf = (key: string): CompositionSite | null => sites.find(s => s.key === key) ?? null;

  const addSiteRow = (json: Record<string, unknown>): CompositionSite => {
    const pop = Number(json.pop ?? 0);
    const row: CompositionSite = {
      key: String(json.key),
      name: String(json.name ?? json.key),
      pop,
      pops: [{ pop, syndrome: { key: "base", trait_keys: [] } }],
    };
    sites.push(row);
    return row;
  };
  const addRouteRow = (json: Record<string, unknown>): FakeRoute => {
    const pair = (json.sites as string[] | undefined) ?? [];
    const row: FakeRoute = {
      key: String(json.key), a: pair[0] ?? null, b: pair[1] ?? null,
      strength: Number(json.strength ?? 0), migration: Number(json.migration ?? 0),
    };
    routes.push(row);
    return row;
  };

  for (const s of (scenario.site as Array<Record<string, unknown>> | undefined) ?? []) addSiteRow(s);
  for (const r of (scenario.route as Array<Record<string, unknown>> | undefined) ?? []) addRouteRow(r);

  const ops: CompositionOps = {
    routes,
    isCompositionAtRest: () => true, // a static composition genuinely is
    skipDays: (n: number) => n,
    breakaways_fired: [],
    histfigs: [],
    sampleIndividual: () => null,
    pinHistfig: () => null,
    releaseHistfig: () => false,
    histfigShed: () => 0,
    siteResourceDemand: () => ({}),
    applyVitals: () => ({ born: 0, died: 0 }),
    births_total: 0,
    deaths_total: 0,
    addSite: async (json: Record<string, unknown>) => addSiteRow(json),
    addRoute: (json: Record<string, unknown>) => addRouteRow(json),
    // CONSERVING, even though nothing in this configuration drives it:
    // a lie here would be a lie about people.
    applyExternalMigration: (moves) => {
      let moved = 0;
      for (const m of moves) {
        const from = siteOf(m.from);
        const to = siteOf(m.to);
        if (!from || !to) continue;
        const n = Math.min(m.count, from.pops[0].pop);
        if (n <= 0) continue;
        from.pops[0].pop -= n; from.pop -= n;
        to.pops[0].pop += n; to.pop += n;
        moved += n;
      }
      return moved;
    },
    applyTraitFlip: () => 0,
  };

  return {
    sites: () => sites,
    routes: (): CompositionRouteInfo[] => routes.map(r => ({
      key: r.key,
      site_a: r.a ? { key: r.a } : null,
      site_b: r.b ? { key: r.b } : null,
      strength: r.strength,
      migration: r.migration,
    })),
    day: () => day,
    totalPop: () => sites.reduce((a, s) => a + s.pops.reduce((x, p) => x + p.pop, 0), 0),
    popOnSiteWithTrait: (siteKey, traitKey) => {
      const s = siteOf(siteKey);
      if (!s) return 0;
      return s.pops
        .filter(p => p.syndrome.trait_keys.includes(traitKey))
        .reduce((a, p) => a + p.pop, 0);
    },
    traitKeys: () => [],
    step: async () => { day++; },
    ops,
  };
};

// ───────────────────────────────────── the smallest world foundTri accepts

/** The settlement spec, stripped to what `foundTri`/`bootDual` REQUIRE: the
 *  coupling's population scalar plus the four charter scalars
 *  `commitFounding` writes. No rules, no economy, no flow nets — every
 *  optional block omitted is fake-ops surface removed. */
const bareVar = (name: string, max: number): { name: string; min: number; max: number; initial: number } =>
  ({ name, min: 0, max, initial: 0 });

const bareBase = (): Omit<DualSpec, "nodes" | "edges"> => ({
  settlement: {
    id: "band-settlement-live",
    entity: {
      id: "city",
      vars: [
        bareVar("population", 10_000_000),
        bareVar("farmland", 1_000_000),
        bareVar("ore_access", 1_000_000),
        bareVar("timberland", 1_000_000),
        bareVar("pasture", 1_000_000),
      ],
      rules: [],
    },
    edge: { vars: [{ name: "road", min: 0.05, max: 1, initial: 0.05 }] },
  } as DualSpec["settlement"],
  composition: { name: "BandLive", start_age: 0, use_date: false },
  coupling: { populationScalar: "population" },
});

// The ridge-valley map the shipped Gate A arc is calibrated on (grand-dream
// tri-worlds: west ridge over an eastward valley, channel at y=16).
const COLS = 48;
const ROWS = 32;
const TREELINE = 40;
const FOUNDING = { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 };
const SEED = 1206;
const MAX_BAND = 150;

const ridgeValley = (x: number, y: number): number =>
  (x < 8 ? 50 : Math.min(63, Math.max(3, 26 - (x - 8)) + Math.abs(y - 16)));

const substrate = () => prepareSubstrate({
  cols: COLS, rows: ROWS, height: ridgeValley,
  treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
});

/** GATE A ARMED: cornered (pressureFloor 0 — settle on the store alone). */
async function bandWorld(): Promise<TriWorld> {
  return foundTri(substrate(), {
    base: bareBase(),
    cities: [],
    edges: [],
    peopleScale: 25,
    seed: SEED,
    autoFound: {
      every: 5,
      maxCities: 1,
      cityFactory: (_site, i) => ({ key: `bandton_${i}`, name: `Bandton ${i}` }),
    },
    bandFounding: {
      scale: REAL_SCALE,
      searchCells: 8,
      pressureFloor: 0,
      // FOUND SMALL: the band must be smaller than the box that feeds it.
      maxBand: MAX_BAND,
    },
  }, staticBoot);
}

/** THE CENSUS PATH: the same map and cadence with NO `bandFounding` — the
 *  density-threshold founding that shipped before Gate A. */
async function censusWorld(): Promise<TriWorld> {
  return foundTri(substrate(), {
    base: bareBase(),
    cities: [],
    edges: [],
    peopleScale: 25,
    seed: SEED,
    autoFound: {
      every: 5,
      maxCities: 1,
      cityFactory: (_site, i) => ({ key: `censusville_${i}`, name: `Censusville ${i}` }),
    },
  }, staticBoot);
}

const FOOD = freightOf("food");

describe("B-③ live arm — a settling band's banked store rides onto the founded city's record", () => {
  it("the shelf a Gate-A founding stands on is BANKED, not minted: store > what its founders could carry", async () => {
    const tri = await bandWorld();

    // Walk the days. Observe the band LIVING (banking) before any city.
    let sawBandBanking = false;
    let maxBandStore = 0;
    let settledOnDay = -1;
    for (let day = 1; day <= 200 && settledOnDay < 0; day++) {
      await tri.advanceDays(1);
      for (const b of tri.bands()) {
        if (b.store > 0) sawBandBanking = true;
        if (b.store > maxBandStore) maxBandStore = b.store;
      }
      if (tri.cities.length > 0) settledOnDay = day;
    }

    // (1) A city stands, and it carries a condensed town record.
    expect(settledOnDay).toBeGreaterThan(0);
    expect(tri.cities.length).toBeGreaterThan(0);
    const city = tri.cities[0];
    expect(city.record).toBeDefined();
    expect(city.record!.key).toBe(city.key);

    // (2) The record's shelf holds the staple — the store did NOT evaporate
    //     at `settleBand` (the standing F-① violation B-③ closed).
    const shelf = city.record!.stack;
    expect(shelf.food).toBeGreaterThan(0);

    // (3) THE LAW — the founding shelf exceeds what the founders could carry.
    //     This is Gate A's left side read back off the record: `store >
    //     size × REAL_PORTER_BULK × valueDensity`, with `size` the crowd
    //     that walked in (`harvested`) and the rations→units bridge the
    //     IDENTITY for the staple (valueDensity ≡ 1 — the caloric anchor).
    //     `portableBulk` is deliberately NOT overridden, so the number below
    //     is literally the gate the engine evaluated.
    expect(FOOD.valueDensity).toBe(1);
    const founderCarry = city.harvested * REAL_PORTER_BULK * FOOD.valueDensity;
    expect(founderCarry).toBeGreaterThan(0);
    expect(shelf.food).toBeGreaterThan(founderCarry);

    // FOUND SMALL held: the band was smaller than the box that fed it.
    expect(city.harvested).toBeGreaterThan(0);
    expect(city.harvested).toBeLessThanOrEqual(MAX_BAND);

    // (4) The store came from LIVED DAYS, not a mint: a band was observed
    //     standing and banking on an earlier day, the settle is an
    //     accumulation rather than a census reading, and the band that
    //     settled left the band list (it is spent — an entity state change).
    expect(sawBandBanking).toBe(true);
    expect(maxBandStore).toBeGreaterThan(0);
    expect(settledOnDay).toBeGreaterThan(5); // later than the first cadence
    expect(tri.bands().some(b => b.cell === city.cell)).toBe(false);

    // THE SHELF IS THAT SAME PILE, one day on. `advanceDays` samples at the
    // DAY BOUNDARY, and the settle happens inside the last day (the cadence
    // runs after `stepBands`), so the biggest store this test can SEE is the
    // one from the day before — the shelf must sit just above it, never below
    // it, and nowhere near a fresh mint of some unrelated magnitude.
    expect(shelf.food).toBeGreaterThanOrEqual(maxBandStore);
    expect(shelf.food).toBeLessThan(maxBandStore * 2);
    // MEASURED on this map/seed: settles on day 15 (the third cadence) with
    // 150 grid persons banked to 3186.37 rations against a 3000.00 carry —
    // the gate fires just past the crossing, which is what "you settle when
    // you own more than you can carry" looks like when it is not a census.
  }, 180_000);

  it("census control — a founding with no band behind it carries the SAME record shape with an EMPTY shelf", async () => {
    const tri = await censusWorld();

    let foundedOnDay = -1;
    for (let day = 1; day <= 40 && foundedOnDay < 0; day++) {
      await tri.advanceDays(1);
      if (tri.cities.length > 0) foundedOnDay = day;
    }

    // The census path founds on DENSITY, so it fires at the first cadence —
    // no accumulation, and no bands ever stand.
    expect(foundedOnDay).toBeGreaterThan(0);
    expect(tri.bands().length).toBe(0);

    const city = tri.cities[0];
    expect(city.record).toBeDefined();
    expect(city.record!.key).toBe(city.key);
    // THE EMPTY SHELF: same record shape, no rows — `settledTownStack`
    // answers {} for a store of 0, and the mint is not allowed to invent one.
    expect(Object.values(city.record!.stack).filter(u => u > 0)).toEqual([]);
    expect(city.record!.stack.food ?? 0).toBe(0);
    // A never-run town: the closed form is its only scarcity reading (F-⑤).
    expect(city.record!.shortages).toBeNull();
  }, 120_000);
});
