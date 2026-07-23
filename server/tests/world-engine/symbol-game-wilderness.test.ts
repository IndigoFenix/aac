// WILDERNESS scatter (founding flow): deterministic resource features
// (trees = wood containers, rocks = stone containers) + possessable
// creatures over open ground. Pins determinism, bounds, the spawn
// clearing, and the material stacks.

import { describe, it, expect } from "@jest/globals";
import { buildWilderness } from "@shared/world-engine/interaction/quest/wilderness.js";

describe("buildWilderness", () => {
  it("is deterministic in the seed", () => {
    const a = buildWilderness({ seed: 11 });
    const b = buildWilderness({ seed: 11 });
    expect(a).toEqual(b);
    const c = buildWilderness({ seed: 12 });
    expect(c).not.toEqual(a);
  });

  it("lays the requested counts with the right material stacks", () => {
    const w = buildWilderness({ seed: 3, trees: 5, rocks: 4, creatures: 2 });
    const trees = w.features.filter((f) => f.species === "oak");
    const rocks = w.features.filter((f) => f.species === "rock");
    expect(trees).toHaveLength(5);
    expect(rocks).toHaveLength(4);
    expect(w.creatures).toHaveLength(2);
    for (const t of trees) {
      expect(Object.keys(t.stock)).toEqual(["wood"]);
      expect(t.stock.wood).toBeGreaterThanOrEqual(2);
      expect(t.stock.wood).toBeLessThanOrEqual(4);
    }
    for (const r of rocks) {
      expect(Object.keys(r.stock)).toEqual(["stone"]);
      expect(r.stock.stone).toBeGreaterThanOrEqual(1);
      expect(r.stock.stone).toBeLessThanOrEqual(2);
    }
  });

  it("keeps everything inside the manifold and out of the spawn clearing", () => {
    const w = buildWilderness({ seed: 7, side: 240 });
    expect(w.spawn).toEqual({ x: 120, y: 120 });
    for (const e of [...w.features, ...w.creatures]) {
      expect(e.x).toBeGreaterThanOrEqual(8);
      expect(e.x).toBeLessThanOrEqual(232);
      expect(e.y).toBeGreaterThanOrEqual(8);
      expect(e.y).toBeLessThanOrEqual(232);
      expect(Math.hypot(e.x - w.spawn.x, e.y - w.spawn.y)).toBeGreaterThanOrEqual(6);
    }
  });

  it("ids follow the session protocols (features wild:<species>_<n>, creatures wild_<n>)", () => {
    const w = buildWilderness({ seed: 5, trees: 2, rocks: 1, creatures: 2 });
    expect(w.features.map((f) => f.id)).toEqual(["wild:oak_0", "wild:oak_1", "wild:rock_0"]);
    expect(w.creatures.map((c) => c.id)).toEqual(["wild_0", "wild_1"]);
  });

  it("floors the side at 60 m", () => {
    expect(buildWilderness({ seed: 1, side: 10 }).side).toBe(60);
  });
});
