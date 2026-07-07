/**
 * Plate tectonics provider (tectonics.ts) — the Geology→Substrate seam.
 *
 * What must hold: the history is bit-deterministic; continents actually
 * drift; mountains stand where collisions happened (not where noise was
 * tall); ore is finite, emplaced by geologic events, and exposed only by
 * erosion; and the baked fields feed the ordinary substrate pipeline so
 * the civ layers cannot tell a tectonic world from an authored one.
 */
import { describe, it, expect } from "vitest";
import {
  createTectonics, tectonicEpoch, runTectonics, bakeAuthors, bakeHeight, bakeOre,
  SEA_HEIGHT, type TectonicWorld,
} from "../tectonics";
import { prepareSubstrate } from "../tri";
import { TREELINE, FOUNDING, buildTectonicTri } from "../tri-worlds";

const OPTS = { cols: 72, rows: 32, seed: 42, plates: 5 };
const N = OPTS.cols * OPTS.rows;

function run(seed = OPTS.seed, epochs = 350): { world: TectonicWorld; frames: ReturnType<typeof runTectonics>["frames"] } {
  return runTectonics({ ...OPTS, seed, epochs, keyframeEvery: 50 });
}

/** Torus distance between two cells. */
function tdist(a: number, b: number): number {
  let dx = Math.abs((a % OPTS.cols) - (b % OPTS.cols));
  let dy = Math.abs(Math.floor(a / OPTS.cols) - Math.floor(b / OPTS.cols));
  if (dx > OPTS.cols / 2) dx = OPTS.cols - dx;
  if (dy > OPTS.rows / 2) dy = OPTS.rows - dy;
  return Math.sqrt(dx * dx + dy * dy);
}

describe("tectonics — determinism and drift", () => {
  it("same seed ⇒ bit-identical history; different seed ⇒ a different world", () => {
    const a = run();
    const b = run();
    expect(Array.from(a.world.thick)).toEqual(Array.from(b.world.thick));
    expect(Array.from(a.world.ore)).toEqual(Array.from(b.world.ore));
    expect(Array.from(a.world.plate)).toEqual(Array.from(b.world.plate));
    expect(a.world.events.length).toBe(b.world.events.length);

    const c = run(43);
    expect(Array.from(c.world.thick)).not.toEqual(Array.from(a.world.thick));
  });

  it("continents genuinely drift: plates rack up shifts and ownership moves", () => {
    const { world, frames } = run();
    const totalMoved = world.plates.reduce((a, p) => a + p.moved, 0);
    expect(totalMoved).toBeGreaterThan(20);
    // Ownership at the end differs from the start over a large area.
    const first = frames[0];
    let changed = 0;
    for (let c = 0; c < N; c++) if (world.plate[c] !== first.plate[c]) changed++;
    expect(changed / N).toBeGreaterThan(0.2);
  });

  it("keyframes are monotone and the landscape visibly evolves", () => {
    const { frames } = run();
    for (let i = 1; i < frames.length; i++) expect(frames[i].epoch).toBeGreaterThan(frames[i - 1].epoch);
    const first = frames[0];
    const last = frames[frames.length - 1];
    let moved = 0;
    for (let c = 0; c < N; c++) if (Math.abs(last.height[c] - first.height[c]) > 2) moved++;
    expect(moved / N).toBeGreaterThan(0.1);
  });
});

describe("tectonics — mountains and ore are caused, not painted", () => {
  it("high ground stands nearer collision events than average ground does", () => {
    const { world } = run();
    const eventCells = world.events
      .filter(e => e.kind === "orogeny" || e.kind === "arc")
      .map(e => e.cell);
    expect(eventCells.length).toBeGreaterThan(10);
    const nearest = (c: number): number => {
      let best = Infinity;
      for (const e of eventCells) { const d = tdist(c, e); if (d < best) best = d; }
      return best;
    };
    const heights: number[] = [];
    for (let c = 0; c < N; c++) heights.push(bakeHeight(world, c));
    const highCells: number[] = [];
    for (let c = 0; c < N; c++) if (heights[c] >= TREELINE) highCells.push(c);
    expect(highCells.length).toBeGreaterThan(5); // the world HAS mountains
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const allCells = Array.from({ length: N }, (_, c) => c);
    expect(mean(highCells.map(nearest))).toBeLessThan(mean(allCells.map(nearest)));
  });

  it("ore is a finite budget: in range, none under the sea, buried lodes stay hidden", () => {
    const { world } = run();
    let exposed = 0;
    let emplaced = 0;
    for (let c = 0; c < N; c++) {
      const o = bakeOre(world, c);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(15);
      expect(Number.isInteger(o)).toBe(true);
      if (bakeHeight(world, c) < SEA_HEIGHT) expect(o).toBe(0);
      exposed += o;
      emplaced += world.ore[c];
    }
    expect(exposed).toBeGreaterThan(0); // erosion exhumed some lodes
    expect(exposed).toBeLessThan(emplaced); // ...and left others buried
  });

  it("erosion is the exhumation mechanism: cover strips only where relief sheds", () => {
    // A single buried lode on a steep peak gets exposed; the same lode on
    // flat lowland stays buried forever (nothing erodes a plain).
    const w = createTectonics({ cols: 16, rows: 16, seed: 1, plates: 1, hotspots: 0, continentR: 10 });
    w.plates[0].vx = 0;
    w.plates[0].vy = 0; // freeze drift: only erosion acts
    const peak = 8 * 16 + 8;
    const flat = 2 * 16 + 2;
    w.thick[peak] = 60; // a mountain spike
    w.ore[peak] = 10;
    w.cover[peak] = 5;
    w.ore[flat] = 10;
    w.cover[flat] = 5;
    for (let e = 0; e < 200; e++) tectonicEpoch(w);
    expect(bakeOre(w, peak)).toBeGreaterThan(0); // exhumed
    expect(bakeOre(w, flat)).toBe(0); // still buried
  });
});

describe("tectonics — the seam (provenance-independence)", () => {
  it("baked fields feed prepareSubstrate and the ordinary world grows on top", () => {
    const { world } = run();
    const authors = bakeAuthors(world);
    const prep = prepareSubstrate({
      cols: OPTS.cols, rows: OPTS.rows, height: authors.height, ore: authors.ore,
      treeline: TREELINE, founding: FOUNDING,
    });
    const g = prep.grid;
    // Interface bounds hold on the grid itself.
    for (let c = 0; c < N; c++) {
      expect(g.fields.height[c]).toBeGreaterThanOrEqual(0);
      expect(g.fields.height[c]).toBeLessThanOrEqual(63);
      expect(g.fields.ore[c]).toBeLessThanOrEqual(15);
    }
    // The settled world has fertile land AND exposed ore — both biomes.
    let fertile = 0;
    let oreTiles = 0;
    let both = 0;
    for (let c = 0; c < N; c++) {
      if (g.fields.fertility[c] >= 8) fertile++;
      if (g.fields.ore[c] >= 3) oreTiles++;
      if (g.fields.fertility[c] >= 8 && g.fields.ore[c] >= 3) both++;
    }
    expect(fertile).toBeGreaterThan(10);
    expect(oreTiles).toBeGreaterThan(5);
    // Farm country and mine country are mostly different places (the
    // anti-correlation now EMERGES from orogeny vs drainage — overlaps
    // are allowed; they are the interesting old-eroded-range towns).
    expect(both / Math.max(1, oreTiles)).toBeLessThan(0.5);
    // Nobody lives in the sea.
    for (let c = 0; c < N; c++) {
      if (g.fields.height[c] < SEA_HEIGHT) expect(g.fields.people[c]).toBe(0);
    }
    // And crowds pooled somewhere worth founding.
    expect(prep.sites.length).toBeGreaterThan(0);
  });

  it("the tectonic tri-world boots, founds cities, and replays bit-identically", async () => {
    const a = await buildTectonicTri(7);
    await a.tri.advanceDays(40);
    expect(a.tri.cities.length).toBeGreaterThanOrEqual(2);
    expect(a.frames.length).toBeGreaterThan(3);

    const b = await buildTectonicTri(7);
    await b.tri.advanceDays(40);
    expect(b.tri.cities.map(c => [c.key, c.x, c.y, c.harvested]))
      .toEqual(a.tri.cities.map(c => [c.key, c.x, c.y, c.harvested]));
    expect(b.tri.gridOre()).toBe(a.tri.gridOre());

    // REGRESSION: the seamless world must certify at continental scale —
    // 144 km × 1000 m/tile tripped the engine's old 100 km manifold
    // bound ("clicking a town fails on tectonic worlds"). The bound now
    // admits a planet.
    const { generateWorld } = await import("../zoom");
    const world = generateWorld(a.tri, { seed: 7, atCity: a.tri.cities[0].key });
    expect(world.spec.manifold.kind).toBe("flat");
    expect(world.spawnIndexOf.size).toBeGreaterThan(0);
  }, 30_000);
});
