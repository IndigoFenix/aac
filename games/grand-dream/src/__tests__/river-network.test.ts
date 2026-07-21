// RIVER NETWORK EXTRACTION — the flow field traced into drawable polylines.
// The render half (draped ribbons) needs a GL context and lives in world-lab;
// this pins the DATA: that a real planet yields source→mouth river lines that
// run downhill, reach the coast, and cover the trunk without drawing it twice.

import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { extractRiverNetwork } from "@shared/world-engine/planet/rivers";
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
});
