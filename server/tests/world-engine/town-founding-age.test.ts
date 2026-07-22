// FOUNDING AGE (city-founding.md init contract): a TOWN scope declarable at
// age 0 with a population ≥ 1 — a town SITE with settlers and a declared
// supply box but NO buildings. The founding-age gate (days ≤ FOUNDING_AGE_DAYS)
// lays no base houses/works whatever the population; declared `stock` seeds
// the builder's yard; established towns are byte-identical legacy. No DOM/GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildTownPlay,
  TOWN_PLAY_STRUCTURES,
} from "@shared/world-engine/interaction/town/town-play.js";
import { buildTownScope, parseTownWorld } from "@shared/world-engine/interaction/town/town-play-game.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";
import { FOUNDING_AGE_DAYS } from "@shared/world-engine/kernel/town/plan.js";
import { createTownDeltas, foundingOptions } from "@shared/world-engine/kernel/town/construction.js";
import { resolveStructure, spendCosts } from "@shared/world-engine/kernel/town/structures.js";
import { buildWilderness } from "@shared/world-engine/interaction/quest/wilderness.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";

describe("an age-0 town with population: settlers, no buildings", () => {
  const config = {
    seed: 11, days: 0, questCount: 0, key: "frontier",
    startPop: 5, stock: { wood: 14, stone: 6 },
  };
  const play = buildTownPlay(config);

  it("lays no houses, no works, no fields — population alone builds nothing", () => {
    expect(play.plan.houses).toHaveLength(0);
    expect(play.plan.works).toHaveLength(0);
    expect(play.plan.fields).toHaveLength(0);
  });

  it("starts at day 0 with the population it declared", () => {
    expect(play.town.day).toBe(0);
    expect(Math.round(play.town.scalar("population"))).toBe(5);
  });

  it("has no phantom founding farm — food must be built, not assumed", () => {
    expect(play.town.scalar("farms")).toBe(0);
  });

  it("seeds the builder's yard with EXACTLY the declared supply box", () => {
    expect(play.deltas.stock).toEqual({ wood: 14, stone: 6 });
  });

  it("still stands as a live session (stage tolerates the empty town)", () => {
    expect(play.stage.spec.engine).toBe("world");
    const f = play.stage.frame({ x: play.stage.center.x, y: play.stage.center.y }, 1);
    expect(f.add).toEqual([]);
  });

  it("is deterministic — the same config builds the identical site again", () => {
    const again = buildTownPlay(config);
    expect(again.plan).toEqual(play.plan);
    expect(again.deltas.stock).toEqual(play.deltas.stock);
  });

  it("can afford and place its first building from the declared stock", () => {
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    const c = foundingOptions({
      seed: config.seed,
      key: config.key,
      footprint: spec.footprint,
      type: spec.type,
      occupied: [],
      claimedSlots: new Set<number>(),
    })[0];
    expect(c).toBeDefined();
    const stock = { ...play.deltas.stock };
    expect(spendCosts(spec, stock)).toBe(true);
    expect(stock.wood).toBe(14 - (spec.costs.wood ?? 0));
  });
});

describe("the founding-age gate", () => {
  it("day one is still founding age (a founding is day one)", () => {
    const play = buildTownPlay({ seed: 9, days: 1, questCount: 0, key: "dayone", startPop: 8 });
    expect(FOUNDING_AGE_DAYS).toBe(1);
    expect(play.plan.houses).toHaveLength(0);
    expect(play.plan.works).toHaveLength(0);
  });

  it("an established town keeps the historical 6-house floor, byte-identically", () => {
    const play = buildTownPlay({ seed: 5, days: 10, questCount: 0, key: "smalltown", startPop: 20 });
    expect(play.plan.houses.length).toBeGreaterThanOrEqual(6);
    // Its declared stock ADDS to the usual yard seed instead of replacing it.
    const stocked = buildTownPlay({
      seed: 5, days: 10, questCount: 0, key: "smalltown", startPop: 20, stock: { wood: 7 },
    });
    expect(stocked.deltas.stock.wood).toBe(play.deltas.stock.wood! + 7);
    expect(stocked.plan).toEqual(play.plan);
  });
});

describe("the town scope's spec gate (city-founding fields)", () => {
  it("maps the author's `population` onto the config's startPop", () => {
    const spec = parseTownWorld({ seed: 3, days: 0, population: 4 }, "world");
    expect(spec.config.startPop).toBe(4);
    expect("population" in spec.config).toBe(false);
  });

  it("accepts age 0 and rejects negative days", () => {
    expect(() => parseTownWorld({ seed: 3, days: 0 }, "world")).not.toThrow();
    expect(() => parseTownWorld({ seed: 3, days: -1 }, "world")).toThrow(/world\.days/);
  });

  it("gates the supply box: glyph → positive integer counts only", () => {
    const spec = parseTownWorld({ seed: 3, stock: { wood: 12, stone: 5 } }, "world");
    expect(spec.config.stock).toEqual({ wood: 12, stone: 5 });
    expect(() => parseTownWorld({ seed: 3, stock: [] }, "world"))
      .toThrow(/expected an object of material stacks/);
    expect(() => parseTownWorld({ seed: 3, stock: { wood: 0 } }, "world"))
      .toThrow(/world\.stock\.wood/);
    expect(() => parseTownWorld({ seed: 3, stock: { wood: 2.5 } }, "world"))
      .toThrow(/world\.stock\.wood/);
  });

  it("accepts the wilderness flag", () => {
    expect(parseTownWorld({ seed: 3, wilderness: true }, "world").config.wilderness).toBe(true);
    expect(() => parseTownWorld({ seed: 3, wilderness: "yes" }, "world")).toThrow(/world\.wilderness/);
  });
});

describe("watched growth: scaffold → doored building (the completion swap)", () => {
  it("an ordered build stands as a door-less scaffold, then swaps to doored rooms when its clock runs out", () => {
    const config = {
      seed: 11, days: 0, questCount: 0, key: "frontier",
      startPop: 5, stock: { wood: 30, stone: 10 },
    };
    const play = buildTownPlay(config);
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    const c = foundingOptions({
      seed: config.seed, key: config.key, footprint: spec.footprint, type: spec.type,
      occupied: [], claimedSlots: new Set<number>(),
    })[0]!;
    // The orderBuild commit (quest-host): founded delta + plan row; the
    // stage reconciles on the version bump.
    const b = play.deltas.foundBuilding(c, 0, 0.5); // half a street-day build
    play.plan.works.push({
      type: spec.type, dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      color: spec.color, program: spec.program, jobs: 0, foundedOrd: b.ord,
    });
    const at = { x: play.stage.center.x, y: play.stage.center.y };
    const f0 = play.stage.frame(at, 0, () => null);
    const scaffold = f0.buildings!.find((x) => x.id === "w_0");
    expect(scaffold).toBeDefined();
    expect(scaffold!.doorways).toHaveLength(0); // walls first — no door yet
    // The build clock passes — the same frame swaps scaffold for real
    // DOORED rooms (the doorless-box-forever failure this test pins).
    const f1 = play.stage.frame(at, 0.6 * FOOD_DAY_SEC, () => null);
    const front = f1.buildings!.find((x) => x.id === "w_0");
    expect(front).toBeDefined();
    expect(front!.doorways.length).toBeGreaterThan(0);
  });
});

describe("a completed founded producer joins the economy books", () => {
  it("rebuilding with a completed farm delta raises the farm count scalar (its food is real)", () => {
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "farm")!;
    const deltas = createTownDeltas();
    const c = foundingOptions({
      seed: 9, key: "granville", footprint: spec.footprint, type: spec.type,
      occupied: [], claimedSlots: new Set<number>(),
    })[0]!;
    const b = deltas.foundBuilding(c, 0, spec.buildDays);
    deltas.completeFounding(b.ord);
    const play = buildTownPlay({
      seed: 9, days: 0, questCount: 0, key: "granville", startPop: 5, deltas: deltas.toJSON(),
    });
    // Age 0 seeds NO phantom farm — the one on the books is the one built.
    expect(play.town.scalar("farms")).toBe(1);
  });
});

describe("settlers — a defined family without a house (city-founding ②)", () => {
  const game = (world: Record<string, unknown>) =>
    parseGameSettings(
      {
        scope: "town" as const,
        world,
        initial_focus: null,
        avatar: "spirit" as const,
        entities: {
          creatures: {
            mode: "all",
            list: [{ name: "Mara", likes: ["apple"] }, { name: "Orrin" }],
          },
        },
      },
      "t",
    );

  it("an AGE-0 town accepts a family with no focused house — they are the settlers", () => {
    const built = buildTownScope(game({ seed: 11, days: 0, population: 2 }), "t");
    expect(built.spec.config.family?.members.map((m) => m.name)).toEqual(["Mara", "Orrin"]);
    expect(built.play.familyHouse).toBeNull(); // no house yet — the camp is the home
    expect(built.play.plan.houses).toHaveLength(0);
  });

  it("an ESTABLISHED town still requires the focused house", () => {
    expect(() => buildTownScope(game({ seed: 11, days: 220 }), "t")).toThrow(/focused household/);
  });
});

describe("wilderness scatter around a town site", () => {
  it("keeps the clearing disc open and stays deterministic", () => {
    const clearAt = { x: 120, y: 120 };
    const clearR = 30;
    const w = buildWilderness({ seed: 11, side: 240, clearAt, clearR });
    expect(w.features.length).toBeGreaterThan(0);
    for (const f of w.features) {
      expect(Math.hypot(f.x - clearAt.x, f.y - clearAt.y)).toBeGreaterThanOrEqual(clearR);
    }
    expect(buildWilderness({ seed: 11, side: 240, clearAt, clearR })).toEqual(w);
  });

  it("defaults are byte-identical to the legacy scatter (no clearing params)", () => {
    expect(buildWilderness({ seed: 7 })).toEqual(buildWilderness({ seed: 7 }));
  });
});
