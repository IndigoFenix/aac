// ZERO-BUILDING GROWTH (city-expansion ①b, the hard requirement): a founded
// site's town (siteTownConfig → buildTownPlay, startPop 0) starts at ZERO
// buildings — no houses, no hall, no farm, no fields — and grows
// building-by-building through FOUNDED DELTAS: same seed + same deltas ⇒ the
// identical grown town (determinism stays the transport). Established towns
// keep their historical 6-house floor, byte-identically. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { foundSite, siteTownConfig } from "@shared/world-engine/interaction/town/founding.js";
import {
  buildTownPlay,
  townStockSeed,
  TOWN_PLAY_STRUCTURES,
} from "@shared/world-engine/interaction/town/town-play.js";
import { foundingOptions } from "@shared/world-engine/kernel/town/construction.js";
import { resolveStructure, spendCosts } from "@shared/world-engine/kernel/town/structures.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";

describe("a founded site's town starts at ZERO buildings", () => {
  const site = foundSite({ seed: 77, at: { x: 100, y: 100 }, key: "outpost" });
  const play = buildTownPlay(siteTownConfig(site));

  it("lays no houses, no works, no fields — bare ground and streets", () => {
    expect(play.plan.houses).toHaveLength(0);
    expect(play.plan.works).toHaveLength(0);
    expect(play.plan.fields).toHaveLength(0);
  });

  it("still stands as a live session (stage, goods, quests all tolerate empty)", () => {
    expect(play.stage.spec.engine).toBe("world");
    expect(play.structures).toBe(TOWN_PLAY_STRUCTURES);
    // The stage frames without a crash on the empty town.
    const f = play.stage.frame({ x: play.stage.center.x, y: play.stage.center.y }, 1);
    expect(f.add).toEqual([]);
  });

  it("carries the site's gathered materials as the town stock", () => {
    const stocked = foundSite({ seed: 9, at: { x: 0, y: 0 } });
    stocked.stock.wood = 12;
    stocked.stock.stone = 3;
    const cfg = siteTownConfig(stocked);
    expect(cfg.deltas?.stock).toEqual({ wood: 12, stone: 3 });
    // …and an established town seeds a builder's yard of its own.
    expect(townStockSeed(24).wood).toBeGreaterThan(0);
    expect(townStockSeed(0)).toEqual({});
  });
});

describe("building-by-building growth through founded deltas", () => {
  it("founding a house then a farm grows the town 0 → 1 → 2 buildings, deterministically", () => {
    const site = foundSite({ seed: 77, at: { x: 100, y: 100 }, key: "outpost" });
    site.stock.wood = 40;
    site.stock.stone = 10;

    const grow = (type: string) => {
      const spec = resolveStructure(TOWN_PLAY_STRUCTURES, type)!;
      const founded = site.deltas.founded();
      const c = foundingOptions({
        seed: site.seed,
        key: site.key,
        footprint: spec.footprint,
        type: spec.type,
        occupied: founded.map((b) => ({ x: b.dx, y: b.dy, w: b.w, h: b.h })),
        claimedSlots: new Set(founded.map((b) => b.slot)),
      })[0]!;
      expect(c).toBeDefined();
      expect(spendCosts(spec, site.stock)).toBe(true);
      const b = site.deltas.foundBuilding(c, 0, spec.buildDays);
      site.deltas.completeFounding(b.ord);
      return b;
    };

    grow("house");
    const one = buildTownPlay(siteTownConfig(site));
    expect(one.plan.houses).toHaveLength(0);
    expect(one.plan.works).toHaveLength(1);
    expect(one.plan.works[0]!.type).toBe("house");

    const farm = grow("farm");
    const two = buildTownPlay(siteTownConfig(site));
    expect(two.plan.works.map((w) => w.type)).toEqual(["house", "farm"]);
    // Replay determinism: the delta's exact rect materializes, byte for byte.
    expect(two.plan.works[1]).toMatchObject({
      dx: farm.dx, dy: farm.dy, w: farm.w, h: farm.h, door: farm.door, foundedOrd: farm.ord,
    });
    // The completed farm is a staffed workplace (per-spec jobs, not the flat 2).
    expect(two.plan.works[1]!.jobs).toBe(
      TOWN_PLAY_STRUCTURES.find((s) => s.type === "farm")!.jobs,
    );
    // Same site ⇒ identical grown town (the multiplayer transport law).
    const replay = buildTownPlay(siteTownConfig(site));
    expect(replay.plan.works).toEqual(two.plan.works);
    expect(replay.plan.radius).toBe(two.plan.radius);
  });
});

describe("visible construction on the stage (board words change the world)", () => {
  it("an ordered building stands as a door-less scaffold, then completes into doored rooms + furniture on the clock", () => {
    const site = foundSite({ seed: 77, at: { x: 100, y: 100 }, key: "outpost" });
    site.stock.wood = 40;
    site.stock.stone = 10;
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "workshop")!;
    const c = foundingOptions({
      seed: site.seed, key: site.key, footprint: spec.footprint, type: spec.type,
      occupied: [], claimedSlots: new Set(),
    })[0]!;
    spendCosts(spec, site.stock);
    site.deltas.foundBuilding(c, 0, spec.buildDays); // NOT completed — mid-build
    const play = buildTownPlay(siteTownConfig(site));
    const at = {
      x: play.stage.center.x + c.dx + c.w / 2,
      y: play.stage.center.y + c.dy + c.h / 2,
    };

    // Mid-build: ONE door-less scaffold box on the lot; no furniture.
    const f0 = play.stage.frame(at, 1);
    const scaffold = (f0.buildings ?? []).find((b) => b.id === "w_0");
    expect(scaffold).toBeDefined();
    expect(scaffold!.doorways).toEqual([]);
    expect(f0.addObjects).toEqual([]);

    // The build clock runs out: the SAME session swaps in the doored
    // building and its furniture the frame the day passes.
    const done = play.stage.frame(at, spec.buildDays * FOOD_DAY_SEC + 1);
    const front = (done.buildings ?? []).find((b) => b.id === "w_0");
    expect(front).toBeDefined();
    expect(front!.doorways.length).toBeGreaterThan(0);
    expect(front!.color).toBe(spec.color);
    expect(done.addObjects.length).toBeGreaterThan(0); // the counter/stock arrive
  });

  it("a build committed MID-SESSION registers live (the deltas version bump)", () => {
    const site = foundSite({ seed: 77, at: { x: 100, y: 100 }, key: "outpost" });
    site.stock.wood = 40;
    const play = buildTownPlay(siteTownConfig(site));
    const center = play.stage.center;
    play.stage.frame({ x: center.x, y: center.y }, 1); // settle the empty town

    // The executor's commit: spend, found, append the plan row (jobs 0).
    const spec = resolveStructure(play.structures, "house")!;
    const c = foundingOptions({
      seed: play.config.seed, key: play.plan.key, bearings: play.plan.streets.bearings,
      footprint: spec.footprint, type: spec.type,
      occupied: [], claimedSlots: new Set(),
    })[0]!;
    expect(spendCosts(spec, play.deltas.stock)).toBe(true);
    const b = play.deltas.foundBuilding(c, 0, spec.buildDays);
    play.plan.works.push({
      type: spec.type, dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      color: spec.color, program: spec.program, jobs: 0, foundedOrd: b.ord,
    });

    const f = play.stage.frame({ x: center.x + b.dx + b.w / 2, y: center.y + b.dy + b.h / 2 }, 2);
    const scaffold = (f.buildings ?? []).find((x) => x.id === "w_0");
    expect(scaffold).toBeDefined();
    expect(scaffold!.doorways).toEqual([]); // walls first — doors when done
  });
});

describe("established towns are untouched by the zero floor", () => {
  it("a populated town keeps its 6-house floor and its hall", () => {
    const play = buildTownPlay({ seed: 5, days: 10, questCount: 0, key: "smalltown", startPop: 20 });
    expect(play.plan.houses.length).toBeGreaterThanOrEqual(6);
    expect(play.plan.works.some((w) => w.type === "hall")).toBe(true);
    // Base houses keep slot === index (no founded claims — legacy identity).
    for (const h of play.plan.houses) expect(h.slot).toBe(h.index);
    // The fresh overlay seeded the builder's yard.
    expect(play.deltas.stock.wood).toBeGreaterThan(0);
  });
});
