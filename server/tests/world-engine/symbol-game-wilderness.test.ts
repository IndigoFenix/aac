// WILDERNESS scatter (founding flow): deterministic resource features
// (trees = wood containers, rocks = stone containers) + possessable
// creatures over open ground. Pins determinism, bounds, the spawn
// clearing, the material stacks, and the live-harvest regrow rules
// (step ④: pick/shear/milk — the standing source bears again).

import { describe, it, expect } from "@jest/globals";
import {
  armHarvestRegrow,
  buildWilderness,
  dueHarvestRegrowth,
  wildAnimalBodyId,
  wildFeatureContainerId,
  wildFeatureEmbodied,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";

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

  it("kill-only features carry no harvest capacity or regrow ledger", () => {
    const w = buildWilderness({ seed: 9, trees: 2, rocks: 1, creatures: 0 });
    for (const f of w.features) {
      expect(f.harvestCap).toBeUndefined();
      expect(f.regrowAt).toBeUndefined();
    }
  });

  it("an explicit mix replaces the oak-and-rock default (biome selection seam)", () => {
    const w = buildWilderness({
      seed: 4,
      creatures: 0,
      mix: [
        { species: "apple_tree", count: 2 },
        { species: "rock", count: 1 },
      ],
    });
    expect(w.features.map((f) => f.id)).toEqual([
      "wild:apple_tree_0",
      "wild:apple_tree_1",
      "wild:rock_0",
    ]);
    for (const f of w.features.filter((x) => x.species === "apple_tree")) {
      // A living orchard source: felling wood in the stock, ripe fruit at
      // its rolled bearing capacity, ready to regrow after a pick.
      expect(f.stock.wood).toBeGreaterThanOrEqual(1);
      expect(f.harvestCap!.apple).toBeGreaterThanOrEqual(1);
      expect(f.harvestCap!.apple).toBeLessThanOrEqual(3);
      expect(f.stock.apple).toBe(f.harvestCap!.apple);
    }
  });

  it("an ANIMAL mix entry scatters walking product bodies, not box features", () => {
    const w = buildWilderness({
      seed: 6,
      creatures: 1,
      mix: [
        { species: "sheep", count: 2 },
        { species: "rock", count: 1 },
      ],
    });
    // The sheep are creatures; only the rock stands as a feature.
    expect(w.features.map((f) => f.id)).toEqual(["wild:rock_0"]);
    const sheep = w.creatures.filter((c) => c.species === "sheep");
    expect(sheep.map((c) => c.id)).toEqual(["wild_sheep_0", "wild_sheep_1"]);
    for (const s of sheep) {
      // Meat (kill) + wool at its rolled bearing capacity, ready to regrow.
      expect(s.stock!.meat).toBeGreaterThanOrEqual(1);
      expect(s.stock!.wool).toBe(s.harvestCap!.wool);
      expect(s.harvestCap!.wool).toBeGreaterThanOrEqual(1);
      expect(s.harvestCap!.wool).toBeLessThanOrEqual(2);
      expect(s.icon).toBe(""); // the body comes from the species
      expect(wildAnimalBodyId(s)).toBe(`fauna:sheep:${s.id}`);
    }
    // The legacy possessable local still spawns alongside.
    expect(w.creatures.filter((c) => !c.species).map((c) => c.id)).toEqual(["wild_0"]);
  });

  it("the default mix is byte-identical to the legacy trees/rocks scatter", () => {
    const legacy = buildWilderness({ seed: 11 });
    const viaMix = buildWilderness({
      seed: 11,
      mix: [
        { species: "oak", count: 10 },
        { species: "rock", count: 6 },
      ],
    });
    expect(viaMix).toEqual(legacy);
  });
});

// The regrow calculators are PURE — the host applies their results to its
// live stock copy. An apple tree (regrowDays 1) at day-length 100 s.
const DAY = 100;
const appleTree = (): WildernessFeature => ({
  id: "wild:apple_tree_0",
  species: "apple_tree",
  x: 0,
  y: 0,
  stock: { apple: 2, wood: 1 },
  harvestCap: { apple: 2 },
});

describe("live-harvest regrow (dueHarvestRegrowth / armHarvestRegrow)", () => {
  it("a live take arms the clock one regrow period out; kill glyphs never arm", () => {
    const f = appleTree();
    armHarvestRegrow(f, "wood", 10, DAY); // kill glyph — no-op
    expect(f.regrowAt).toBeUndefined();
    armHarvestRegrow(f, "apple", 10, DAY);
    expect(f.regrowAt).toEqual({ apple: 10 + DAY });
    // A second take during regrowth keeps the standing cadence.
    armHarvestRegrow(f, "apple", 50, DAY);
    expect(f.regrowAt).toEqual({ apple: 10 + DAY });
  });

  it("nothing matures before the deadline; one unit per period after it", () => {
    const f = appleTree();
    armHarvestRegrow(f, "apple", 0, DAY);
    expect(dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY - 1, DAY)).toBeNull();
    const due = dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY, DAY);
    expect(due).not.toBeNull();
    expect(due!.add).toEqual({ apple: 1 });
    // Back at capacity (1 + 1 = cap 2) — the ledger entry retires.
    expect(due!.regrowAt).toEqual({});
  });

  it("a long absence catches up whole periods but stops at capacity", () => {
    const f = appleTree();
    armHarvestRegrow(f, "apple", 0, DAY);
    // Picked clean (live stock 0), away for 10 periods: refills to cap 2, not 10.
    const due = dueHarvestRegrowth(f, { apple: 0, wood: 1 }, 10 * DAY, DAY);
    expect(due!.add).toEqual({ apple: 2 });
    expect(due!.regrowAt).toEqual({});
  });

  it("below capacity, the ledger advances to the next deadline", () => {
    const f = appleTree();
    f.harvestCap = { apple: 3 };
    armHarvestRegrow(f, "apple", 0, DAY);
    // One period elapsed, two units short of cap: one matures, next is due a period later.
    const due = dueHarvestRegrowth(f, { apple: 1, wood: 1 }, DAY, DAY);
    expect(due!.add).toEqual({ apple: 1 });
    expect(due!.regrowAt).toEqual({ apple: 2 * DAY });
  });

  it("an unarmed feature has nothing pending", () => {
    expect(dueHarvestRegrowth(appleTree(), { apple: 2, wood: 1 }, 1e9, DAY)).toBeNull();
  });
});

describe("embodiment rule — bodyHeightM is the data flip", () => {
  it("a plant with bodyHeightM stands as a grown flora body; minerals stay boxes", () => {
    const apple = appleTree();
    expect(wildFeatureEmbodied(apple)).toBe(true);
    expect(wildFeatureContainerId(apple)).toBe("flora:apple_tree:wild:apple_tree_0");
    // OAK embodied (one tree authority, 2026-07-30): a wild oak stands as a
    // real grown body — the same species the flora streaming field renders,
    // so a session twin materializing under a suppressed scenery instance IS
    // the same tree. Still purely the bodyHeightM data flip, never a name rule.
    const oak: WildernessFeature = { id: "wild:oak_0", species: "oak", x: 0, y: 0, stock: { wood: 3 } };
    const rock: WildernessFeature = { id: "wild:rock_0", species: "rock", x: 0, y: 0, stock: { stone: 1 } };
    expect(wildFeatureEmbodied(oak)).toBe(true);
    expect(wildFeatureContainerId(oak)).toBe("flora:oak:wild:oak_0");
    expect(wildFeatureEmbodied(rock)).toBe(false); // minerals never embody
  });
});
