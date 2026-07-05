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
import { TREELINE, triBase, buildAcceptanceTri, buildGenesisTri, stripes, CITIZEN, buildings } from "../tri-worlds";

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
    // Layers agree for every emergent city.
    for (const s of a.tri.dual.sites()) {
      expect(a.tri.dual.settlementPop(s.key)).toBe(s.pops.reduce((x, p) => x + p.pop, 0));
    }
    // The same seed grows the same civilization, city for city.
    const b = await run();
    expect(b.summary).toBe(a.summary);
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
