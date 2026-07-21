/**
 * Sphere tectonics (shared/engine/geology/sphere-tectonics.ts) — the
 * Euler-pole drift kernel on the cube-sphere lattice, sharing tectonics.ts's
 * geology (constants, event grammar, erosion/exhumation, bake contract).
 *
 * Mirrors tectonics.test.ts's invariants where they translate:
 *   - determinism (same opts ⇒ bit-identical history);
 *   - plates genuinely travel (rigid rotation, no rounding drift);
 *   - mountains and ore are CAUSED (collision events), not painted;
 *   - continents survive a whole history (the OROGENY_DAMP contract);
 *   - the provider seam: baked fields are ints in range, ore is only
 *     visible where exhumed and above the sea.
 */
import { describe, it, expect } from "vitest";
import { makeCubeSphereTopology } from "@cells/index";
import {
  createSphereTectonics, sphereTectonicEpoch, runSphereTectonics,
  bakeHeight, bakeOre, bakeCellAuthors,
} from "@shared/world-engine/kernel/geology/sphere-tectonics";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";

const topo = makeCubeSphereTopology(16);

describe("sphere tectonics — determinism and drift", () => {
  it("same opts ⇒ bit-identical history; different seed ⇒ different world", () => {
    const a = createSphereTectonics({ topo, seed: 5 });
    const b = createSphereTectonics({ topo, seed: 5 });
    for (let e = 0; e < 120; e++) { sphereTectonicEpoch(a); sphereTectonicEpoch(b); }
    expect(Array.from(a.thick)).toEqual(Array.from(b.thick));
    expect(Array.from(a.ore)).toEqual(Array.from(b.ore));
    expect(Array.from(a.plate)).toEqual(Array.from(b.plate));
    expect(a.events.length).toBe(b.events.length);

    const c = createSphereTectonics({ topo, seed: 6 });
    for (let e = 0; e < 120; e++) sphereTectonicEpoch(c);
    expect(Array.from(c.thick)).not.toEqual(Array.from(a.thick));
  });

  it("plates rotate rigidly across the sphere (continents genuinely travel)", () => {
    const w = createSphereTectonics({ topo, seed: 1 });
    const plate0 = Array.from(w.plate);
    for (let e = 0; e < 200; e++) sphereTectonicEpoch(w);
    for (const p of w.plates) expect(p.moved).toBeGreaterThan(1); // ≥ a cell pitch each
    let changedOwner = 0;
    for (let c = 0; c < topo.n; c++) if (w.plate[c] !== plate0[c]) changedOwner++;
    expect(changedOwner).toBeGreaterThan(topo.n * 0.1); // boundaries really moved
  });
});

describe("sphere tectonics — mountains and ore are caused, not painted", () => {
  const { world } = runSphereTectonics({ topo, seed: 42, epochs: 350 });

  it("a whole history produces continents, oceans, and collision ranges", () => {
    let land = 0;
    let sea = 0;
    let maxH = 0;
    for (let c = 0; c < topo.n; c++) {
      const h = bakeHeight(world, c);
      if (h >= SEA_HEIGHT) land++; else sea++;
      if (h > maxH) maxH = h;
    }
    expect(land / topo.n).toBeGreaterThan(0.2);
    expect(sea / topo.n).toBeGreaterThan(0.2);
    expect(maxH).toBeGreaterThan(SEA_HEIGHT + 20); // real ranges, not noise bumps
    const kinds = new Set(world.events.map(e => e.kind));
    expect(kinds.has("orogeny")).toBe(true);
    expect(kinds.has("arc")).toBe(true);
    expect(kinds.has("rift")).toBe(true);
  });

  it("continental crust survives the history (sutured continents stop)", () => {
    const fresh = createSphereTectonics({ topo, seed: 42 });
    let conti0 = 0;
    let contiNow = 0;
    for (let c = 0; c < topo.n; c++) {
      if (fresh.conti[c]) conti0++;
      if (world.conti[c]) contiNow++;
    }
    expect(contiNow).toBeGreaterThan(conti0 * 0.3);
  });

  it("ore is emplaced at depth and only mining-visible once exhumed", () => {
    let buried = 0;
    let exposed = 0;
    for (let c = 0; c < topo.n; c++) {
      const visible = bakeOre(world, c);
      if (visible > 0) {
        exposed++;
        expect(world.cover[c]).toBeLessThanOrEqual(0); // never through rock
        expect(bakeHeight(world, c)).toBeGreaterThanOrEqual(SEA_HEIGHT); // never undersea
      } else if (world.ore[c] > 0 && world.cover[c] > 0) {
        buried++; // a lode still waiting for erosion
      }
    }
    expect(exposed).toBeGreaterThan(20); // old worn ranges are mining country
    expect(buried).toBeGreaterThan(0); // young ranges still hide theirs
  });

  it("bakes the provider contract: ints in range, cell-indexed authors", () => {
    const authors = bakeCellAuthors(world);
    for (let c = 0; c < topo.n; c++) {
      const h = authors.height(c);
      const o = authors.ore(c);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(63);
      expect(Number.isInteger(o)).toBe(true);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(15);
    }
  });
});

describe("sphere tectonics — the watchable history", () => {
  it("collects scrubbable keyframes: epoch 0 first, final epoch last, monotone", () => {
    const { world, frames } = runSphereTectonics({ topo, seed: 7, epochs: 100, keyframeEvery: 20 });
    expect(frames[0].epoch).toBe(0);
    expect(frames[frames.length - 1].epoch).toBe(world.epoch);
    for (let i = 1; i < frames.length; i++) expect(frames[i].epoch).toBeGreaterThan(frames[i - 1].epoch);
    for (const f of frames) {
      expect(f.height.length).toBe(topo.n);
      expect(f.ore.length).toBe(topo.n);
      expect(f.plate.length).toBe(topo.n);
    }
  });
});
