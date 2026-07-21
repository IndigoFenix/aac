// FOUNDED BUILDINGS (city-expansion ①b): the whole-building analogue of the
// annex delta. Pins: feasibility INSIDE the enumeration (foundingOptions —
// street-slot candidates, clearance, claimed slots, the bound), RNG-free
// determinism (multiplayer law), the TownDeltas founded/stock mutation layer
// (ord assignment, completion fact, toJSON round-trip), and the plan-level
// replay (applyFoundedBuildings materializes the exact serialized rects).
// Pure logic — no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  foundedBuildingDone,
  foundingOptions,
  FOUNDING_CLEARANCE,
  type FoundingCandidate,
} from "@shared/world-engine/kernel/town/construction.js";
import { growStreets } from "@shared/world-engine/kernel/town/streets.js";
import {
  applyFoundedBuildings,
  TOWN_PLAY_STRUCTURES,
} from "@shared/world-engine/interaction/town/town-play.js";
import type { TownPlan } from "@shared/world-engine/kernel/town/plan.js";

const SEED = 77;
const KEY = "outpost";
const HOUSE = { w: 9, d: 8 };

const enumerate = (over?: Partial<Parameters<typeof foundingOptions>[0]>) =>
  foundingOptions({
    seed: SEED,
    key: KEY,
    footprint: HOUSE,
    type: "house",
    occupied: [],
    claimedSlots: new Set<number>(),
    ...over,
  });

describe("foundingOptions — feasibility inside the enumeration", () => {
  it("yields street-frontage candidates, best-first, on an empty site", () => {
    const opts = enumerate();
    expect(opts.length).toBeGreaterThan(0);
    const net = growStreets(SEED, KEY, 12);
    for (const c of opts) {
      const slot = net.slots[c.slot]!;
      // The lot is CENTERED on its claimed slot (flush to the frontage) and
      // faces the frontage anchor.
      expect(c.dx + c.w / 2).toBeCloseTo(slot.x, 6);
      expect(c.dy + c.h / 2).toBeCloseTo(slot.y, 6);
      expect(["north", "south", "east", "west"]).toContain(c.door);
    }
    // Best-first = the prefix-stable slot order.
    const slots = opts.map((c) => c.slot);
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
  });

  it("is deterministic — the same input always enumerates the same candidates", () => {
    expect(enumerate()).toEqual(enumerate());
  });

  it("skips claimed slots (a founded building holds its frontage)", () => {
    const first = enumerate()[0]!;
    const next = enumerate({ claimedSlots: new Set([first.slot]) });
    expect(next.every((c) => c.slot !== first.slot)).toBe(true);
  });

  it("keeps clearance from occupied footprints — a blocked lot never reaches the caller", () => {
    const first = enumerate()[0]!;
    const blockers = [{ x: first.dx - 0.5, y: first.dy - 0.5, w: first.w + 1, h: first.h + 1 }];
    const next = enumerate({ occupied: blockers });
    for (const c of next) {
      const gapX = Math.max(blockers[0]!.x - (c.dx + c.w), c.dx - (blockers[0]!.x + blockers[0]!.w));
      const gapY = Math.max(blockers[0]!.y - (c.dy + c.h), c.dy - (blockers[0]!.y + blockers[0]!.h));
      expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(FOUNDING_CLEARANCE - 1e-9);
    }
  });

  it("respects the manifold bound (no lot off the world)", () => {
    const opts = enumerate({ bound: 60 });
    for (const c of opts) {
      expect(c.dx).toBeGreaterThanOrEqual(-60);
      expect(c.dy).toBeGreaterThanOrEqual(-60);
      expect(c.dx + c.w).toBeLessThanOrEqual(60);
      expect(c.dy + c.h).toBeLessThanOrEqual(60);
    }
    // An impossible bound refuses honestly: empty, never a bad lot.
    expect(enumerate({ bound: 4 })).toEqual([]);
  });
});

describe("TownDeltas — the founded/stock mutation layer", () => {
  const candidate: FoundingCandidate = {
    type: "house", slot: 3, dx: 10, dy: -20, w: 9, h: 8, door: "south",
  };

  it("foundBuilding assigns ordinals, stamps the clock, bumps the version", () => {
    const d = createTownDeltas();
    const v0 = d.version;
    const a = d.foundBuilding(candidate, 2, 1.5);
    const b = d.foundBuilding({ ...candidate, slot: 4 }, 2.2, 1);
    expect(a.ord).toBe(0);
    expect(b.ord).toBe(1);
    expect(a.startedDay).toBe(2);
    expect(a.buildDays).toBe(1.5);
    expect(d.version).toBeGreaterThan(v0);
    expect(d.founded().map((f) => f.ord)).toEqual([0, 1]);
  });

  it("completion: the clock decides until the COMPLETED fact is written; the fact survives a clock reset", () => {
    const d = createTownDeltas();
    const b = d.foundBuilding(candidate, 1, 2);
    expect(foundedBuildingDone(b, 1.5)).toBe(false);
    expect(foundedBuildingDone(b, 3)).toBe(true);
    d.completeFounding(b.ord);
    expect(b.completed).toBe(true);
    // A rebooted session's clock restarts at 0 — the fact keeps it built.
    expect(foundedBuildingDone(b, 0)).toBe(true);
    const v = d.version;
    d.completeFounding(b.ord); // idempotent — no version churn
    expect(d.version).toBe(v);
  });

  it("founded + stock round-trip through toJSON (the TownDeltas transport)", () => {
    const d = createTownDeltas();
    d.foundBuilding(candidate, 0, 1);
    d.stock.wood = 7;
    d.stock["wood.wet"] = 2;
    const restored = createTownDeltas(d.toJSON());
    expect(restored.founded()).toEqual(d.founded());
    expect(restored.stock).toEqual({ wood: 7, "wood.wet": 2 });
    // Deep-cloned, never aliased.
    restored.stock.wood = 0;
    expect(d.stock.wood).toBe(7);
  });
});

describe("applyFoundedBuildings — replay materializes the EXACT serialized rects", () => {
  const bareLot = (): TownPlan => ({
    key: KEY, biome: "farmland", groundColor: "#8fae62", radius: 45,
    want: 0, built: 0, houses: [], works: [], fields: [],
    streets: growStreets(SEED, KEY, 0),
  });

  it("appends work rows with delta geometry + catalog program/jobs", () => {
    const d = createTownDeltas();
    const c = enumerate()[0]!;
    const b = d.foundBuilding(c, 0, 2);
    const plan = bareLot();
    applyFoundedBuildings(plan, d.founded(), TOWN_PLAY_STRUCTURES);
    expect(plan.works).toHaveLength(1);
    const row = plan.works[0]!;
    expect(row).toMatchObject({ type: "house", dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door });
    expect(row.foundedOrd).toBe(b.ord);
    expect(row.program).toEqual(TOWN_PLAY_STRUCTURES.find((s) => s.type === "house")!.program);
    // Under construction ⇒ no staff yet; completed ⇒ the spec's jobs.
    expect(row.jobs).toBe(0);
    d.completeFounding(b.ord);
    const plan2 = bareLot();
    applyFoundedBuildings(plan2, d.founded(), TOWN_PLAY_STRUCTURES);
    expect(plan2.works[0]!.jobs).toBe(0); // a house never hires
    expect(plan2.radius).toBeGreaterThanOrEqual(plan.radius);
  });

  it("a completed FARM row carries the spec's roster jobs", () => {
    const d = createTownDeltas();
    const c = enumerate({ footprint: { w: 18, d: 12 }, type: "farm" })[0]!;
    const b = d.foundBuilding(c, 0, 2);
    d.completeFounding(b.ord);
    const plan = bareLot();
    applyFoundedBuildings(plan, d.founded(), TOWN_PLAY_STRUCTURES);
    expect(plan.works[0]!.jobs).toBe(TOWN_PLAY_STRUCTURES.find((s) => s.type === "farm")!.jobs);
  });
});
