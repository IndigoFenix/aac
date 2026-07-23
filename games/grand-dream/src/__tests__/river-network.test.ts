// RIVER NETWORK EXTRACTION — the flow field traced into drawable polylines.
// The render half (draped ribbons) needs a GL context and lives in world-lab;
// this pins the DATA: that a real planet yields source→mouth river lines that
// run downhill, reach the coast, and cover the trunk without drawing it twice.

import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { extractRiverNetwork, buildRiverRelief } from "@shared/world-engine/planet/rivers";
import { routePointAt } from "@shared/world-engine/planet/routes";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

const game: GameSettings = {
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 48 }, // the flight sim's resolution
    geology: { seed: 7, epochs: 350 },
    settle: true, radius: 6_371_000,
    founding: { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 },
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", canFly: false, creativeMode: false, entities: null,
};

describe("river network extraction", () => {
  const built = buildPlanetWorld(game);
  const rivers = extractRiverNetwork(built);
  const height = built.grid.fields.height as Float64Array;
  const topo = built.topo;

  /** Height at a unit dir, by nearest cell — for downhill/coast checks. */
  const heightAtDir = (d: readonly [number, number, number]): number => height[topo.cellAt!(d)];

  it("a real planet yields a substantial river network", () => {
    expect(rivers.length).toBeGreaterThan(20);
    // Every polyline is a real drapeable route.
    for (const r of rivers) {
      expect(r.route.dirs.length).toBeGreaterThanOrEqual(2);
      expect(r.route.lengthM).toBeGreaterThan(0);
    }
  });

  it("rivers run DOWNHILL from source to mouth", () => {
    // Sample each route head and tail; the tail must not sit above the head.
    // (Per-cell steepest descent guarantees monotonicity; this checks the
    // smoothed polyline didn't wander uphill.) A handful of ties are allowed
    // on near-flat coastal runs.
    let checked = 0, uphill = 0;
    for (const r of rivers) {
      const head = heightAtDir(r.route.dirs[0]);
      const tail = heightAtDir(r.route.dirs[r.route.dirs.length - 1]);
      if (tail > head + 1) uphill++;
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(uphill / checked).toBeLessThan(0.05);
  });

  it("accumulation grows downstream — narrow source, wide mouth", () => {
    // The width signal the renderer ramps along the arc.
    const widening = rivers.filter(r => r.accumMouth >= r.accumSource).length;
    expect(widening / rivers.length).toBeGreaterThan(0.9);
  });

  it("the biggest rivers reach the sea", () => {
    // A trunk (high mouth accumulation) should end at or below the coast, not
    // dead-end on dry land — its final point drains into the ocean.
    const trunks = [...rivers].sort((a, b) => b.accumMouth - a.accumMouth).slice(0, 10);
    const reachSea = trunks.filter(r => {
      const end = r.route.dirs[r.route.dirs.length - 1];
      return heightAtDir(end) < SEA_HEIGHT + 2;
    }).length;
    expect(reachSea).toBeGreaterThan(4);
  });

  it("does not draw the same reach twice — total length is bounded", () => {
    // If tributaries re-drew their shared trunk, total river length would blow
    // up. Each reach claimed once keeps the sum sane relative to the count.
    const total = rivers.reduce((s, r) => s + r.route.lengthM, 0);
    const longest = Math.max(...rivers.map(r => r.route.lengthM));
    // Total is many rivers' worth, but no single planet-spanning duplicate.
    expect(longest).toBeLessThan(2 * Math.PI * built.spec.radius); // under a full circumference
    expect(total).toBeGreaterThan(longest); // it's a network, not one line
  });

  it("raising minAccum thins the network to trunks only", () => {
    const trunksOnly = extractRiverNetwork(built, { minAccum: 100 });
    expect(trunksOnly.length).toBeLessThan(rivers.length);
    expect(trunksOnly.length).toBeGreaterThan(0);
  });

  // ── RIVER RELIEF: the network folded back into the TERRAIN ──────────────
  // Draped ribbons float/bury as the quadtree re-chords valleys per LOD, so
  // the visible river is now terrain paint (riverTintAt) + a sub-cell valley
  // notch in heightAt. These pin the fold, not pixels.
  describe("river relief (paint + notch)", () => {
    const relief = buildRiverRelief(built)!;
    // A test point in the middle of the widest trunk — deep in a channel.
    const trunk = [...rivers].sort((a, b) => b.accumMouth - a.accumMouth)[0];
    const mid: [number, number, number] = [0, 0, 0];
    {
      const { cum, dirs } = trunk.route;
      let lo = 0;
      const target = trunk.route.lengthM / 2;
      while (lo + 1 < cum.length && cum[lo + 1] <= target) lo++;
      mid[0] = dirs[lo][0]; mid[1] = dirs[lo][1]; mid[2] = dirs[lo][2];
    }
    const far: [number, number, number] = [-mid[0], -mid[1], -mid[2]]; // antipode

    it("depthAt: a notch in the channel, nothing at the antipode", () => {
      expect(relief).toBeTruthy();
      expect(relief.depthAt(mid)).toBeGreaterThan(0);
      expect(relief.depthAt(far)).toBe(0);
    });

    it("tintAt: paints the channel toward water, leaves far land alone", () => {
      const inCh: [number, number, number] = [0.2, 0.5, 0.1];
      const before = [...inCh] as [number, number, number];
      relief.tintAt(mid, 0, inCh);
      expect(inCh[2]).toBeGreaterThan(before[2]); // bluer
      expect(inCh[1]).not.toBe(before[1]);
      const away = [...before] as [number, number, number];
      relief.tintAt(far, 0, away);
      expect(away).toEqual(before);
    });

    it("tintAt widens with the caller's vertex spacing — the LOD glyph", () => {
      // A point a few channel-widths off the centerline: invisible to a fine
      // mesh, painted by a coarse one (whose vertices are further apart than
      // the river is wide — without this, coarse LODs lose the line).
      const offM = 5_000;
      const t = offM / built.spec.radius;
      // Nudge perpendicular-ish: any tangent direction works for a distance test.
      const off: [number, number, number] = [mid[0] + t * -mid[1], mid[1] + t * mid[0], mid[2]];
      const m = Math.hypot(off[0], off[1], off[2]);
      off[0] /= m; off[1] /= m; off[2] /= m;
      const fine: [number, number, number] = [0.2, 0.5, 0.1];
      relief.tintAt(off, 100, fine);
      const coarse: [number, number, number] = [0.2, 0.5, 0.1];
      relief.tintAt(off, 50_000, coarse); // clamped internally to the glyph cap
      expect(coarse[2]).toBeGreaterThanOrEqual(fine[2]);
    });

    it("attachRiverRelief folded into the built surface (and kept the LAW)", () => {
      // buildPlanetWorld attaches on construction: the paint hook is live...
      expect(typeof built.surface.riverTintAt).toBe("function");
      // ...the notched ground never dips below the coastal floor...
      expect(built.surface.heightAt(mid)).toBeGreaterThanOrEqual(2);
      // ...and macroHeightAt is NOT notched: the drainage/refinement potential
      // must never see render relief (ground-vs-macro law). The macro at the
      // channel sits at cell scale — far above the notched ground there.
      const macro = built.surface.macroHeightAt!(mid);
      expect(macro).toBeGreaterThanOrEqual(built.surface.heightAt(mid));
    });
  });
});
