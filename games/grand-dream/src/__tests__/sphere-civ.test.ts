/**
 * Civilization on a PLANET — the whole causal chain on the cube-sphere
 * lattice: sphere tectonics bakes a world (mountains from collisions, ore
 * under cover), prepareSubstrateOn settles it (rivers, fertility, wild
 * crowds), crowds propose founding sites, and the full tri stack runs on
 * top — harvest founding, asymmetric charters, dual coupling with PopuSim,
 * mining depletion drawing the mountains down. The flat acceptance arc
 * (tri.test.ts), on a sphere.
 */
import { describe, it, expect } from "vitest";
import { makeCubeSphereTopology } from "@cells/index";
import { runSphereTectonics, bakeCellAuthors } from "@shared/engine/geology/sphere-tectonics";
import { prepareSubstrateOn, foundTri, type TriWorld } from "../tri";
import { triBase, triEconomy, CITIZEN, buildings, TREELINE } from "../tri-worlds";

const FACE_N = 16;
const GEO_SEED = 7; // probed: gives both a pure farm site and real ore country
const FOUNDING = { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 };

interface SphereRun {
  tri: TriWorld;
  gridPeople0: number;
  gridOre0: number;
}

async function buildSphereTri(seed: number): Promise<SphereRun> {
  const topo = makeCubeSphereTopology(FACE_N);
  const { world } = runSphereTectonics({ topo, seed: GEO_SEED, epochs: 350 });
  const authors = bakeCellAuthors(world);
  const prep = prepareSubstrateOn({
    topology: { kind: "cube-sphere", faceN: FACE_N },
    height: authors.height,
    ore: authors.ore,
    treeline: TREELINE,
    founding: FOUNDING,
  });
  const g = prep.grid;
  const box = (field: string, cell: number): number => {
    let s = 0;
    g.topo.disk(cell, 3, c => { s += g.fields[field][c]; });
    return s;
  };
  // Geography picks the cast: the greenest ore-free crowd farms, the
  // richest-charter crowd mines — both DISCOVERED, not authored.
  const farm = prep.sites
    .filter(s => box("ore", s.cell) === 0)
    .sort((a, b) => box("fertility", b.cell) - box("fertility", a.cell))[0];
  const mine = prep.sites.slice().sort((a, b) => box("ore", b.cell) - box("ore", a.cell))[0];
  expect(farm).toBeDefined();
  expect(mine).toBeDefined();

  const gridPeople0 = g.fields.people.reduce((a, b) => a + b, 0);
  const gridOre0 = g.fields.ore.reduce((a, b) => a + b, 0);

  const tri = await foundTri(prep, {
    base: triBase(),
    economy: triEconomy(),
    cities: [
      { at: farm, key: "seaford", name: "Seaford", site: CITIZEN, scalars: buildings },
      { at: mine, key: "orehold", name: "Orehold", site: CITIZEN, scalars: buildings },
    ],
    edges: [["seaford", "orehold"]],
    peopleScale: 25,
    seed,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    history: { every: 10 },
  });
  return { tri, gridPeople0, gridOre0 };
}

describe("civilization on a sphere", () => {
  it("runs the tri arc on a tectonic planet: harvest, charters, coupling, mining", { timeout: 180000 }, async () => {
    const { tri, gridPeople0, gridOre0 } = await buildSphereTri(1206);
    const d = tri.dual;

    // The founding transaction conserves across layers, at scale 25.
    expect(tri.harvestedTotal()).toBeGreaterThan(0);
    expect(tri.gridPeople()).toBe(gridPeople0 - tri.harvestedTotal());
    expect(d.totalPop()).toBe(tri.harvestedTotal() * 25);

    // Tectonic geography wrote the charters: farm country vs mine country.
    const seaford0 = tri.charterOf("seaford");
    const orehold0 = tri.charterOf("orehold");
    expect(seaford0.ore_access).toBe(0);
    expect(seaford0.farmland).toBeGreaterThan(0);
    expect(orehold0.ore_access).toBeGreaterThan(50);

    await tri.advanceDays(60);

    // Both layers agree on every city (the §4 write-back contract).
    for (const s of d.sites()) {
      expect(d.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }
    // The ledger identity holds through vitals.
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop() + d.histfigCount()).toBe(tri.harvestedTotal() * 25 + births - deaths);

    // Geology is a finite budget on a sphere too: the mines drew the
    // mountain down, and the charter follows the depletion.
    expect(tri.gridOre()).toBeLessThan(gridOre0);
    expect(tri.charterOf("orehold").ore_access).toBeLessThan(orehold0.ore_access);

    // The recorded history is scrubbable.
    expect(tri.historyFrames()).toBeGreaterThan(2);
  });

  it("the whole planet run is deterministic", { timeout: 240000 }, async () => {
    const run = async (): Promise<string> => {
      const { tri } = await buildSphereTri(1206);
      await tri.advanceDays(30);
      const d = tri.dual;
      return JSON.stringify([
        d.totalPop(), d.vitalLedger(), tri.gridOre(), tri.gridPeople(),
        d.sites().map(s => [s.key, s.pops.reduce((a, p) => a + p.pop, 0)]),
        d.settlementFlow(0, "food").toFixed(9),
      ]);
    };
    expect(await run()).toBe(await run());
  });
});
