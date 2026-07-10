/**
 * Gate 6 — the tri-layer acceptance world (world-content.md §6), and the
 * many-settlements stress world flagged in unified-world-model.md §10.
 *
 * Acceptance arc: a settled ridge+valley substrate proposes cities in both
 * biomes; Riverton (valley) and Kragholm (ridge) are founded by HARVESTING
 * their crowds (cross-layer conservation at the transaction); charters are
 * asymmetric by geography; food and metal counterflow over the pass;
 * populations grow toward the economy's carrying capacity; Kragholm's
 * separatists secede and the border turns hostile; mining draws the
 * mountain down. Deterministically.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri, type TriCharter } from "../tri";
import { TREELINE, TIERS, MERGE, COLONIZE, FOUNDING, ridgeValley, villageSeed, triBase, buildAcceptanceTri, buildGenesisTri, stripes, CITIZEN, buildings, pickBiomes } from "../tri-worlds";

interface AcceptanceRun {
  summary: string;
  tri: Awaited<ReturnType<typeof foundTri>>;
  charter0: { riverton: TriCharter; kragholm: TriCharter };
  gridOre0: number;
}

async function runAcceptance(days: number): Promise<AcceptanceRun> {
  const { tri, gridPeople0, gridOre0 } = await buildAcceptanceTri(1206);

  // The founding transaction conserves across layers, at scale 25.
  expect(tri.gridPeople()).toBe(gridPeople0 - tri.harvestedTotal());
  expect(tri.dual.totalPop()).toBe(tri.harvestedTotal() * 25);

  const charter0 = { riverton: tri.charterOf("riverton"), kragholm: tri.charterOf("kragholm") };

  await tri.advanceDays(days);

  const d = tri.dual;
  const summary = JSON.stringify([
    d.totalPop(), d.vitalLedger(), d.breakaways(),
    d.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
    tri.gridOre(), tri.gridPeople(),
    d.settlementFlow(0, "food").toFixed(9), d.settlementFlow(0, "metal").toFixed(9),
  ]);
  return { summary, tri, charter0, gridOre0 };
}

describe("tri-layer acceptance world (§6)", () => {
  it("runs the whole arc: charter, counterflow, growth, secession, depletion", { timeout: 120000 }, async () => {
    const { tri, charter0, gridOre0 } = await runAcceptance(120);
    const d = tri.dual;

    // Geography wrote the charters: farm country vs mine country.
    const riverton = tri.cities.find(c => c.key === "riverton")!;
    const kragholm = tri.cities.find(c => c.key === "kragholm")!;
    expect(charter0.riverton.farmland).toBeGreaterThan(5 * Math.max(1, charter0.kragholm.farmland));
    expect(charter0.riverton.ore_access).toBe(0);
    expect(charter0.kragholm.ore_access).toBeGreaterThan(50);
    expect(kragholm.harvested).toBeGreaterThan(0);
    expect(riverton.harvested).toBeGreaterThan(kragholm.harvested);

    // The §6 picture: food and metal COUNTERFLOW over the pass.
    const foodFlow = d.settlementFlow(0, "food");
    const metalFlow = d.settlementFlow(0, "metal");
    expect(foodFlow).not.toBe(0);
    expect(metalFlow).not.toBe(0);
    expect(Math.sign(foodFlow)).toBe(-Math.sign(metalFlow));

    // Life: populations grew toward the economy's ceiling, books balanced.
    const { births, deaths } = d.vitalLedger();
    expect(births).toBeGreaterThan(0);
    expect(d.totalPop()).toBe(tri.harvestedTotal() * 25 + births - deaths);
    expect(d.totalPop()).toBeGreaterThan(tri.harvestedTotal() * 25);

    // Politics: Kragholm's coherent separatists seceded; the border armed.
    expect(d.breakaways().length).toBe(1);
    expect(d.civOf("kragholm")?.trait).toBe("member_y");
    expect(d.civOf("riverton")?.trait).toBe("member_x");
    expect(d.settlementEdgeAttr(0, "hostility")).toBe(1);

    // Geology: the mines drew the mountain down, and the charter follows.
    expect(tri.gridOre()).toBeLessThan(gridOre0);
    expect(tri.charterOf("kragholm").ore_access).toBeLessThan(charter0.kragholm.ore_access);

    // Both layers agree on every city, still.
    for (const s of d.sites()) {
      expect(d.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
  });

  it("the whole tri-layer run is deterministic", { timeout: 180000 }, async () => {
    const a = await runAcceptance(60);
    const b = await runAcceptance(60);
    expect(b.summary).toBe(a.summary);
  });
});

// ---------------------------------------------------------------------------
// Genesis: civilization emerges from bare terrain (the sandbox merge).
// ---------------------------------------------------------------------------

describe("genesis world: cities found themselves", () => {
  it("boots empty, then terrain → rivers → fertility → crowds → cities, deterministically", { timeout: 240000 }, async () => {
    const run = async () => {
      const { tri } = await buildGenesisTri(31);
      // Truly from nothing: no cities, no sites, raw substrate.
      expect(tri.cities.length).toBe(0);
      expect(tri.dual.sites().length).toBe(0);
      expect(tri.dual.totalPop()).toBe(0);

      await tri.advanceDays(200);
      return {
        tri,
        summary: JSON.stringify([
          tri.cities, tri.dual.totalPop(), tri.dual.vitalLedger(),
          tri.dual.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
          tri.gridOre(), tri.gridPeople(),
        ]),
      };
    };

    const a = await run();
    // Civilization happened, unscripted: crowds pooled and founded cities.
    expect(a.tri.cities.length).toBeGreaterThanOrEqual(2);
    expect(a.tri.dual.totalPop()).toBeGreaterThan(0);
    // The ledger spans all of it: harvested crowds + births − deaths.
    const { births, deaths } = a.tri.dual.vitalLedger();
    expect(a.tri.dual.totalPop()).toBe(a.tri.harvestedTotal() * 25 + births - deaths);
    // Layers agree for every emergent city — the CIVIC contract now:
    // genesis founds with the content's species mix, so the population
    // scalar carries the sapient souls while the composition also holds
    // the flocks (step 6e).
    for (const s of a.tri.dual.sites()) {
      expect(a.tri.dual.settlementPop(s.key)).toBe(a.tri.dual.civicPop(s.key));
      const total = s.pops.reduce((x, p) => x + p.pop, 0);
      expect(total).toBeGreaterThanOrEqual(a.tri.dual.settlementPop(s.key));
    }
    // And the herds actually walked in with the founders somewhere.
    const flocks = a.tri.dual.sites()
      .reduce((x, s) => x + a.tri.dual.settlementScalar(s.key, "sheep_count"), 0);
    expect(flocks).toBeGreaterThan(0);
    // The same seed grows the same civilization, city for city.
    const b = await run();
    expect(b.summary).toBe(a.summary);
  });

  it("founds VILLAGES that grow their buildings from surplus and tier up (step 1)", { timeout: 240000 }, async () => {
    const { tri } = await buildGenesisTri(31);
    const d = tri.dual;

    // Advance until the first founding fires (crowds must pool first).
    let guard = 0;
    while (tri.cities.length === 0 && guard++ < 40) await tri.advanceDays(5);
    expect(tri.cities.length).toBeGreaterThanOrEqual(1);
    const first = tri.cities[0].key;

    // Found SMALL: the harvested crowd plus SUBSISTENCE farms (enough to
    // feed the founding crowd, nothing more) — no charter-sized grant,
    // no mines, no smelters, tier "village". The HARVEST CAP keeps even
    // a fat MIXED box (step 6f — the dwarven field stacked on the human
    // one) inside the village band: found small applies to the crowd
    // now, not just the stock.
    const seedFarms = Math.max(1, Math.ceil((tri.cities[0].harvested * 25 * 0.001) / 5));
    expect(tri.cities[0].harvested).toBeLessThanOrEqual(FOUNDING.maxHarvest);
    expect(d.settlementScalar(first, "farms")).toBe(seedFarms);
    expect(d.settlementScalar(first, "mines")).toBe(0);
    expect(d.settlementScalar(first, "smelters")).toBe(0);
    expect(tri.tierOf(first)).toBe("village");

    // Construction GROWS the stock the old cityFactory used to grant.
    // The growth arc needs a FARM village — with the dwarven field live
    // (step 6f) the FIRST founding is usually a farmland-0 ridge camp,
    // which stands alone (no road partner yet) and starves; the later
    // mountain camps live off valley bread over the roads, which is the
    // §6 counterflow working. Track the first farmland-majority city.
    let fguard = 0;
    const farmCity = (): (typeof tri.cities)[number] | undefined =>
      tri.cities.find(c => {
        const ch = tri.charterOf(c.key);
        return ch.farmland > ch.ore_access;
      });
    while (!farmCity() && fguard++ < 80) await tri.advanceDays(5);
    const fc = farmCity()!;
    expect(fc).toBeDefined();
    const farms0 = d.settlementScalar(fc.key, "farms");
    const farmCap = Math.max(1, Math.ceil(tri.charterOf(fc.key).farmland / 60));
    await tri.advanceDays(200);
    const farms = d.settlementScalar(fc.key, "farms");
    expect(farms).toBeGreaterThan(farms0);
    expect(farms).toBeLessThanOrEqual(farmCap);
    // Production follows the built stock, not the founding grant.
    expect(d.settlementScalar(fc.key, "food_out")).toBeGreaterThan(farms0 * 5);

    // Tiers are thresholds over LIVE population — the label the lab shows
    // must agree with the declared ladder at whatever size growth reached.
    for (const c of tri.cities) {
      const pop = d.settlementPop(c.key);
      let want = TIERS[0].key;
      for (const t of TIERS) if (pop >= t.min) want = t.key;
      expect(tri.tierOf(c.key)).toBe(want);
    }
    // And growth actually crossed a tier boundary somewhere on the map.
    expect(tri.cities.some(c => tri.tierOf(c.key) !== "village")).toBe(true);
  });

  it("records civilization keyframes: cadence, prefix-stable rosters, live head (step 5)", { timeout: 240000 }, async () => {
    const run = async (): Promise<{ tri: Awaited<ReturnType<typeof foundTri>>; json: string }> => {
      const { tri } = await buildGenesisTri(31);
      expect(tri.historyFrames()).toBe(1); // the day-0 baseline
      await tri.advanceDays(100);
      return { tri, json: JSON.stringify(tri.history()) };
    };

    const a = await run();
    const hist = a.tri.history()!;

    // Cadence: the baseline plus one frame every 5 days.
    expect(hist.frames.length).toBe(21);
    expect(hist.frames[0].day).toBe(0);
    expect(hist.frames[20].day).toBe(100);

    // Rosters are prefix-stable: frames only ever append cities/edges,
    // and every per-city/per-edge array agrees with its roster size.
    let prevCities = 0;
    let prevEdges = 0;
    for (const f of hist.frames) {
      expect(f.pop.length).toBeGreaterThanOrEqual(prevCities);
      expect(f.edgeCount).toBeGreaterThanOrEqual(prevEdges);
      prevCities = f.pop.length;
      prevEdges = f.edgeCount;
      expect(f.civ.length).toBe(f.pop.length);
      expect(f.dead.length).toBe(f.pop.length);
      expect(f.road.length).toBe(f.edgeCount);
      expect(f.hostility.length).toBe(f.edgeCount);
    }
    // Genesis grew cities during the span, and the final roster covers
    // them all (foundings land on scan days, before that day's capture).
    expect(prevCities).toBeGreaterThanOrEqual(2);
    expect(prevCities).toBe(a.tri.cities.length);
    expect(hist.cities.length).toBe(a.tri.cities.length);

    // The head frame IS the live world.
    const last = hist.frames[hist.frames.length - 1];
    a.tri.cities.forEach((c, i) => {
      expect(last.pop[i]).toBe(a.tri.dual.settlementPop(c.key));
      expect(last.dead[i]).toBe(!!c.dead);
      expect(last.civ[i]).toBe(a.tri.dual.civOf(c.key)?.trait ?? "");
    });

    // A recorded history is a fact: same seed, same frames, byte for byte.
    const b = await run();
    expect(b.json).toBe(a.json);
  });

  it("sculpting a canyon carves a river and greens land that was stone-dry", { timeout: 120000 }, async () => {
    // Pure substrate mechanics — a small bare world is enough.
    const { worldStep, injectTile } = await import("@cells/index");
    const prep = prepareSubstrate({
      cols: 24, rows: 24,
      height: (x, y) => (x < 10 ? 50 : Math.min(63, Math.max(3, 20 - (x - 10)) + Math.abs(y - 12))),
      treeline: TREELINE, founding: { threshold: 150, radius: 2, minSpacing: 6 }, oreSeed: 7,
    });
    const { grid } = prep;

    // The flat plateau (x < 10, height 50): every tile its own sink —
    // no drainage, no fertility, above the treeline besides.
    const cut: number[] = [];
    for (let y = 4; y <= 20; y++) for (let x = 2; x <= 5; x++) cut.push(y * grid.cols + x);
    expect(cut.every(c => grid.fields.fertility[c] === 0)).toBe(true);
    const riverBefore = new Map(cut.map(c => [c, grid.fields.river[c]]));

    // Carve a SLOPED canyon — a full unit per row: integer heights round,
    // and a sub-unit slope becomes alternating flats that break the
    // drainage thread (a flat dig is a puddle).
    for (let y = 4; y <= 20; y++) {
      const target = Math.max(3, 19 - (y - 4));
      for (let x = 2; x <= 5; x++) {
        const cell = y * grid.cols + x;
        injectTile(grid, cell, "height", -(grid.fields.height[cell] - target));
      }
    }
    for (let i = 0; i < 800; i++) worldStep(grid);

    // The mountain drains into the cut: a real river forms...
    const gained = cut.filter(c => grid.fields.river[c] > 15 && riverBefore.get(c)! <= 15);
    expect(gained.length).toBeGreaterThan(3);
    // ...and fertility follows the new water into the canyon.
    expect(cut.filter(c => grid.fields.fertility[c] > 0).length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Merge — economic absorption (civilization-emergence.md §2b, step 2).
// ---------------------------------------------------------------------------

describe("merge: a stalled village folds into its bigger neighbor (step 2)", () => {
  // Two river towns with honestly different land: farmland 401 vs 336, so
  // their Malthusian ceilings sit ~1.19 apart. Both grow, both stall
  // (fill* < stallFill at equilibrium — §2b's point: EVERY mature
  // settlement stalls), and once the better-landed one outgrows the gate
  // the smaller folds into it. Gates here are test-tuned (ratio 1.15 —
  // valley siblings differ by land quality, not by kind); the production
  // MERGE profile keeps ratio 3 for genuinely outgrown neighbors.
  const runMerge = async (): Promise<{
    tri: Awaited<ReturnType<typeof foundTri>>;
    mergedAtDay: number;
    summary: string;
  }> => {
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const big = prep.sites.find(s => s.x === 29 && s.y === 15);
    const small = prep.sites.find(s => s.x === 17 && s.y === 14);
    if (!big || !small) throw new Error("engineered sites missing — did the map change?");

    const tri = await foundTri(prep, {
      base: triBase({ construction: true }),
      cities: [
        { at: big, key: "big", name: "Bigton", scalars: villageSeed, site: CITIZEN },
        { at: small, key: "small", name: "Smallton", scalars: villageSeed, site: CITIZEN },
      ],
      edges: [["big", "small"]],
      peopleScale: 25,
      seed: 7,
      tiers: TIERS,
      merge: { ...MERGE, ratio: 1.15, range: 17 },
    });

    let mergedAtDay = -1;
    for (let day = 0; day < 600 && mergedAtDay < 0; day += 10) {
      await tri.advanceDays(10);
      if (tri.cities[1].dead) mergedAtDay = tri.cities[1].dead.day;
    }
    const d = tri.dual;
    const summary = JSON.stringify([
      mergedAtDay, tri.cities, d.totalPop(), d.vitalLedger(), d.tombstones(),
      d.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
    ]);
    return { tri, mergedAtDay, summary };
  };

  it("people walk, a ruin remains, the books balance — deterministically", { timeout: 240000 }, async () => {
    const a = await runMerge();
    const d = a.tri.dual;
    expect(a.mergedAtDay).toBeGreaterThan(0);

    // The loser is a RUIN: dead-flagged, tier "ruin", empty on both layers.
    expect(a.tri.cities[1].dead).toBeTruthy();
    expect(a.tri.tierOf("small")).toBe("ruin");
    expect(d.settlementPop("small")).toBe(0);
    expect(d.tombstones().length).toBe(1);
    expect(d.tombstones()[0].key).toBe("small");
    expect(d.tombstones()[0].pop).toBe(a.tri.cities[1].dead!.pop);

    // The winner holds EVERYONE — absorption conserved across layers, and
    // the lifetime ledger still spans harvest + births − deaths exactly.
    expect(d.settlementPop("big")).toBe(d.totalPop());
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop()).toBe(a.tri.harvestedTotal() * 25 + births - deaths);
    for (const s of d.sites()) {
      expect(d.settlementPop(s.key)).toBe(s.pops.reduce((x, p) => x + p.pop, 0));
    }

    // Nothing ships to a ruin; the winner is now a singleton economy.
    expect(d.settlementFlow(0, "food")).toBe(0);

    // Same seed, same fall of Smallton, byte for byte.
    const b = await runMerge();
    expect(b.summary).toBe(a.summary);
  });
});

// ---------------------------------------------------------------------------
// Colonization — scarcity founds daughters (civilization-emergence.md §2c,
// step 3). The ship gate: the §6 acceptance picture (farm valley + mine
// ridge, food/metal counterflow) assembles from ONE seeded valley village —
// no mountain crowd is ever harvested.
// ---------------------------------------------------------------------------

describe("colonization: scarcity founds daughters (step 3)", () => {
  const runColonize = async (): Promise<{
    tri: Awaited<ReturnType<typeof foundTri>>;
    valleyPopAtColony: number;
    summary: string;
  }> => {
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const { valley } = pickBiomes(prep);

    const tri = await foundTri(prep, {
      base: triBase({ construction: true }),
      cities: [{ at: valley, key: "valley", name: "Valleyton", scalars: villageSeed, site: CITIZEN }],
      edges: [],
      peopleScale: 25,
      seed: 11,
      tiers: TIERS,
      colonize: COLONIZE,
      mining: { oreOutScalar: "ore_out", rate: 0.3 },
    });

    // Grow until the town colonizes (tier + window + funded), then let the
    // camp dig long enough for metal to flow home.
    let valleyPopAtColony = 0;
    for (let day = 0; day < 400 && tri.cities.length < 2; day += 10) {
      await tri.advanceDays(10);
      if (tri.cities.length === 2 && valleyPopAtColony === 0) {
        valleyPopAtColony = tri.dual.settlementPop("valley");
      }
    }
    if (tri.cities.length >= 2) await tri.advanceDays(150);

    const d = tri.dual;
    const summary = JSON.stringify([
      tri.cities, d.totalPop(), d.vitalLedger(), tri.gridOre(),
      d.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
      d.settlementFlow(0, "food").toFixed(9), d.settlementFlow(0, "metal").toFixed(9),
    ]);
    return { tri, valleyPopAtColony, summary };
  };

  it("a metal-starved town founds a mining camp; the two-biome economy assembles", { timeout: 240000 }, async () => {
    const a = await runColonize();
    const d = a.tri.dual;
    expect(a.tri.cities.length).toBe(2);
    const camp = a.tri.cities[1];

    // The colony is the PLANNED tendril: parent recorded, nothing
    // harvested (its people WALKED), sited on ore, not on farmland.
    expect(camp.colonyOf).toBe("valley");
    expect(camp.harvested).toBe(0);
    const campCharter = a.tri.charterOf(camp.key);
    expect(campCharter.ore_access).toBeGreaterThanOrEqual(40);
    expect(campCharter.ore_access).toBeGreaterThan(campCharter.farmland);

    // The tier gate held: only a TOWN may found colonies. (The reading is
    // post-migration — the expedition already left when we look.)
    expect(a.valleyPopAtColony).toBeGreaterThanOrEqual(TIERS[1].min - COLONIZE.colonists);

    // Born inside the civ: uniform colonist migration carried membership.
    expect(d.civOf(camp.key)?.trait).toBe("member_x");
    expect(d.civOf(camp.key)?.trait).toBe(d.civOf("valley")?.trait);

    // Conserving: totalPop is still harvest + births − deaths — the
    // colony minted nobody.
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop()).toBe(a.tri.harvestedTotal() * 25 + births - deaths);
    for (const s of d.sites()) {
      expect(d.settlementPop(s.key)).toBe(s.pops.reduce((x, p) => x + p.pop, 0));
    }

    // The camp DIGS (carried stores built its mine and smelter) and the
    // §6 counterflow assembles: metal flows home, food flows out to the
    // camp, opposite directions on the same road.
    expect(d.settlementScalar(camp.key, "mines")).toBeGreaterThan(0);
    expect(d.settlementScalar(camp.key, "smelters")).toBeGreaterThan(0);
    expect(d.settlementScalar("valley", "metal_got")).toBeGreaterThan(0);
    const foodFlow = d.settlementFlow(0, "food");
    const metalFlow = d.settlementFlow(0, "metal");
    expect(metalFlow).not.toBe(0);
    expect(foodFlow).not.toBe(0);
    expect(Math.sign(foodFlow)).toBe(-Math.sign(metalFlow));

    // And the mountain is being drawn down (mining depletion at the camp).
    expect(a.tri.gridOre()).toBeLessThan(48 * 32 * 15);

    // Same seed, same expedition, byte for byte.
    const b = await runColonize();
    expect(b.summary).toBe(a.summary);
  });
});

// ---------------------------------------------------------------------------
// Goods v2 — the widened reagent economy (world-content.md §3d,
// civilization-emergence.md step 5b): planks milled where the trees are,
// tools smithed from metal + planks, demand summed, deliveries allocated,
// a second stockpile part-paying construction — all growing from villages.
// ---------------------------------------------------------------------------

describe("goods v2: reagents, fan-in, fan-out (step 5b)", () => {
  // The step-3 arc, widened: ONE fed valley village builds out, tiers up,
  // colonizes the ore ridge — and now also mills planks, banks them, and
  // smiths tools from the camp's metal. (Founding a barren camp
  // SIMULTANEOUSLY starves the whole component from day 0 — no fed
  // transient, no construction, ever. Sequence is the mechanism.)
  const runGoods = async (): Promise<{
    tri: Awaited<ReturnType<typeof foundTri>>;
    summary: string;
  }> => {
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const { valley } = pickBiomes(prep);
    const tri = await foundTri(prep, {
      base: triBase({ construction: true, goods2: true }),
      cities: [{ at: valley, key: "valley", name: "Valleyton", scalars: villageSeed, site: CITIZEN }],
      edges: [],
      peopleScale: 25,
      seed: 11,
      tiers: TIERS,
      colonize: COLONIZE,
      mining: { oreOutScalar: "ore_out", rate: 0.3 },
    });
    for (let day = 0; day < 400 && tri.cities.length < 2; day += 10) {
      await tri.advanceDays(10);
    }
    if (tri.cities.length >= 2) await tri.advanceDays(150);
    const d = tri.dual;
    const scal = (k: string, s: string): number => d.settlementScalar(k, s);
    const summary = JSON.stringify([
      tri.cities, d.totalPop(), d.vitalLedger(),
      ["sawmills", "smithies", "tools_out", "planks_got", "metal_got", "metal_for_pop", "metal_for_smiths", "plank_store"]
        .map(s => [scal("valley", s), scal("camp0", s)]),
      d.settlementFlow(0, "tools").toFixed(9), d.settlementFlow(0, "metal").toFixed(9),
    ]);
    return { tri, summary };
  };

  it("the reagent economy grows from one village and every relay holds its contract", { timeout: 240000 }, async () => {
    const a = await runGoods();
    const d = a.tri.dual;
    const scal = (k: string, s: string): number => d.settlementScalar(k, s);
    expect(a.tri.cities.length).toBe(2); // the camp founded (metal scarcity)

    // Industry rose where its anchor is: sawmills on the timbered valley
    // (charter anchor), none on the bare ridge camp; smithies follow
    // people — INDUSTRY AFTER SUBSISTENCE (the base stock completed
    // first; cumulative thresholds above the base stack are unreachable
    // once the fed transient closes).
    expect(scal("valley", "sawmills")).toBeGreaterThan(0);
    expect(scal("camp0", "sawmills")).toBe(0);
    expect(scal("valley", "smithies")).toBeGreaterThan(0);

    // The smithies were part-paid in banked planks (multi-stockpile cost:
    // a smithy exists ⇒ the plank stockpile funded it).
    // FAN-IN: the settlement's metal want is households + smithies, summed.
    const fanIn = scal("valley", "metal_want_pop") + scal("valley", "smith_metal_draw");
    expect(scal("valley", "metal_need")).toBeCloseTo(fanIn, 9);
    expect(scal("valley", "smith_metal_draw")).toBeGreaterThan(0);

    // FAN-OUT: the delivered metal divides smiths-first (priority is
    // data — households-first starves the tool chain), conserving.
    const got = scal("valley", "metal_got");
    const forPop = scal("valley", "metal_for_pop");
    const forSmiths = scal("valley", "metal_for_smiths");
    expect(forPop + forSmiths).toBeLessThanOrEqual(got + 1e-9);
    expect(forSmiths).toBeCloseTo(Math.min(scal("valley", "smith_metal_draw"), got), 9);
    expect(forSmiths).toBeGreaterThan(0);

    // The MULTI-REAGENT chain runs end to end: metal from the ridge and
    // planks from the valley become tools, and tools ship back over the
    // pass to the camp that mined the metal.
    expect(scal("valley", "planks_got")).toBeGreaterThan(0);
    expect(scal("valley", "tools_out")).toBeGreaterThan(0);
    expect(scal("camp0", "tools_got")).toBeGreaterThan(0);
    expect(Math.abs(d.settlementFlow(0, "tools"))).toBeGreaterThan(0.01);

    // Wider goods, same books: the vital ledger still spans everything.
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop()).toBe(a.tri.harvestedTotal() * 25 + births - deaths);
    for (const s of d.sites()) {
      expect(d.settlementPop(s.key)).toBe(s.pops.reduce((x, p) => x + p.pop, 0));
    }

    // Same seed, same economy, byte for byte.
    const b = await runGoods();
    expect(b.summary).toBe(a.summary);
  });
});

// ---------------------------------------------------------------------------
// The many-settlements stress world (unified-world-model.md §10 flag).
// ---------------------------------------------------------------------------

interface StressRun {
  summary: string;
  cityCount: number;
  msPerDay: number;
  tri: Awaited<ReturnType<typeof foundTri>>;
}

async function runStress(days: number, withLife: boolean): Promise<StressRun> {
  const founding = { threshold: 150, radius: 2, minSpacing: 8 };
  const prep = prepareSubstrate({ cols: 72, rows: 32, height: stripes, treeline: TREELINE, founding, oreSeed: 11 });
  const picks = prep.sites.slice(0, 14);
  expect(picks.length).toBeGreaterThanOrEqual(8);

  const base = triBase();
  if (!withLife) {
    delete (base.coupling as { vitals?: unknown }).vitals;
  }
  const placed: Array<{ key: string; x: number; y: number }> = [];
  const edges: Array<[string, string]> = [];
  const cities = picks.map((at, i) => {
    const key = `c${i}`;
    if (i > 0) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < placed.length; j++) {
        const d2 = (placed[j].x - at.x) ** 2 + (placed[j].y - at.y) ** 2;
        if (d2 < bestD) { bestD = d2; best = j; }
      }
      edges.push([key, placed[best].key]);
    }
    placed.push({ key, x: at.x, y: at.y });
    return { at, key, name: key, site: CITIZEN, scalars: buildings };
  });

  const tri = await foundTri(prep, {
    base, cities, edges, peopleScale: 25, seed: 72,
    mining: withLife ? { oreOutScalar: "ore_out", rate: 0.3 } : undefined,
  });

  const t0 = performance.now();
  const { stepped, skipped } = await tri.advanceDays(days);
  const elapsed = performance.now() - t0;

  const d = tri.dual;
  const summary = JSON.stringify([
    d.totalPop(), d.vitalLedger(),
    d.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
    tri.gridOre(), tri.gridPeople(), stepped, skipped,
  ]);
  return { summary, cityCount: cities.length, msPerDay: elapsed / Math.max(1, stepped), tri };
}

describe("many-settlements stress world", () => {
  it("a living 14-city world runs 100 days deterministically at sane cost", { timeout: 300000 }, async () => {
    const a = await runStress(100, true);
    console.log(`stress: ${a.cityCount} cities, ${a.msPerDay.toFixed(1)} ms/day`);

    // Every layer pair still agrees, for every city.
    for (const s of a.tri.dual.sites()) {
      expect(a.tri.dual.settlementPop(s.key)).toBe(s.pops.reduce((x, p) => x + p.pop, 0));
    }
    // The ledger holds at scale.
    const { births, deaths } = a.tri.dual.vitalLedger();
    expect(a.tri.dual.totalPop()).toBe(a.tri.harvestedTotal() * 25 + births - deaths);
    expect(births).toBeGreaterThan(0);
    // Mining bit into at least one ridge.
    expect(a.tri.gridOre()).toBeLessThan(72 * 32 * 15);
    // Cost stays workable (very loose ceiling — this is a smoke bound).
    expect(a.msPerDay).toBeLessThan(250);

    const b = await runStress(100, true);
    expect(b.summary).toBe(a.summary); // bit-identical at scale
  });

  it("the same world without vitals or mining rests at scale — in motion", { timeout: 300000 }, async () => {
    // The tight fertility band means small food flows, so roads crawl to
    // their clamps (~0.001/day): convergence takes a couple thousand days.
    // At ~1.5 ms/day that is still seconds of wall time.
    const run = await runStress(3000, false);
    const [, , , , , stepped, skipped] = JSON.parse(run.summary) as number[];

    // The grown world converged and jumped the idle tail in O(1)...
    expect(skipped).toBeGreaterThan(0);
    expect(run.tri.dual.isResting()).toBe(true);
    expect(stepped + skipped).toBe(3000);
    // ...while the flow fields still ship goods somewhere on the map.
    let moving = 0;
    for (let e = 0; e < run.cityCount - 1; e++) {
      if (Math.abs(run.tri.dual.settlementFlow(e, "food")) > 0.01) moving++;
    }
    if (moving === 0) {
      const d = run.tri.dual;
      console.log("flows:", Array.from({ length: run.cityCount - 1 }, (_, e) => d.settlementFlow(e, "food").toFixed(3)).join(","));
      console.log("out/need:", d.sites().map(s => `${s.key}:${d.settlementScalar(s.key, "food_out").toFixed(1)}/${d.settlementScalar(s.key, "food_need").toFixed(1)}`).join(" "));
    }
    expect(moving).toBeGreaterThan(0);
  });
});
