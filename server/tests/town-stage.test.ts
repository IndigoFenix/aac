// The TOWN STAGE (shared/symbol-game/town-stage.ts): a certified, sparse
// world-engine spec — OPEN town, no gate, no star — with the quest cast at
// its real anchors and the SHARED RESIDENT MODEL streaming the population
// (shared/engine/town/residents.ts — the same mechanics the 2D canvas
// manager runs: indoor homebodies, embodiment radii and ranking, the
// no-blink-out lock, door-bracketed trips). Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/engine/modules/economy/index.js";
import { createTownWorld } from "@shared/engine/town/town-world.js";
import { townPlan } from "@shared/engine/town/plan.js";
import { houseDoorstep } from "@shared/engine/town/goods.js";
import {
  IDLE_EMBODY_R, PEOPLE_EVICT_MIN, STREET_NPCS, residentId,
} from "@shared/engine/town/residents.js";
import { buildTownQuestGame } from "@shared/symbol-game/town-quests.js";
import { createTownStage } from "@shared/symbol-game/town-stage.js";

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
  ],
};

const ECO = compileEconomy([DOC], { construction: true });

const setup = () => {
  const town = createTownWorld({
    economy: ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop: 120,
    seedScalars: { farms: 1 },
    key: "haywick",
  });
  town.step(250);
  const plan = townPlan(town, ECO, "haywick", 11);
  const bundle = buildTownQuestGame(town, ECO, plan, "haywick", { seed: 11, questCount: 1 });
  const stage = createTownStage(town, ECO, plan, bundle, { seed: 11 });
  return { town, plan, bundle, stage };
};

describe("town-stage: the open town", () => {
  it("certifies sparse — ground + plaza + cast; NO gate, NO star staged", () => {
    const { plan, bundle, stage } = setup();
    expect(stage.spec.structures ?? []).toHaveLength(0); // walls stream in later
    expect(stage.spec.objects).toHaveLength(0);          // no door, no star prop
    // The cast IS the spec's population, each at a real anchor.
    expect(stage.spec.npcs!.map(n => n.id).sort()).toEqual(
      bundle.cast.map(c => c.npcEntityId).sort(),
    );
    const wanter = bundle.cast.find(c => c.role === "wanter")!;
    const home = plan.houses.find(h => h.index === wanter.house)!;
    const door = houseDoorstep(stage.center, home);
    const npc = stage.spec.npcs!.find(n => n.id === wanter.npcEntityId)!;
    expect(npc.x).toBeCloseTo(door.x);
    expect(npc.y).toBeCloseTo(door.y);
    expect(stage.castSpawns.get(wanter.nodeId)).toEqual(door);
  });

  it("exposes the street tree as ground-ribbon roads in world coords", () => {
    const { plan, stage } = setup();
    // One ribbon per non-trivial street, positioned around the town centre.
    const drawn = plan.streets.streets.filter(s => s.pts.length >= 2);
    expect(stage.roads).toHaveLength(drawn.length);
    expect(stage.roads.length).toBeGreaterThan(0);
    for (const r of stage.roads) {
      expect(r.points.length).toBeGreaterThanOrEqual(2);
      expect(r.width).toBeGreaterThan(0);
    }
    // Points are town-local lifted by centre: the plaza ring's ribbon starts at
    // centre + the ring's first town-local point.
    const ring = plan.streets.streets.find(s => s.ring)!;
    const want = { x: stage.center.x + ring.pts[0].x, y: stage.center.y + ring.pts[0].y };
    const ringRoad = stage.roads.find(
      r => Math.abs(r.points[0].x - want.x) < 1e-6 && Math.abs(r.points[0].y - want.y) < 1e-6,
    );
    expect(ringRoad).toBeDefined();
    expect(ringRoad!.width).toBeCloseTo(2.8);
  });

  it("streams by the SHARED mechanics: homebodies indoors, budgeted, no churn", () => {
    const { plan, stage } = setup();
    const plaza = { x: stage.center.x, y: stage.center.y + 8 };
    const live = new Map<string, { x: number; y: number }>();
    const bodyPos = (id: string) => live.get(id) ?? null;
    const apply = (f: ReturnType<typeof stage.frame>) => {
      for (const n of f.add) live.set(n.id, { x: n.x, y: n.y });
      for (const id of f.remove) live.delete(id);
    };

    const f0 = stage.frame(plaza, 0, bodyPos);
    apply(f0);
    expect(f0.buildings!.length).toBeGreaterThan(0); // the plaza hall at least
    expect(f0.buildings!.every(b => typeof b.floors === "number")).toBe(true); // volumes, not flattened walls

    // FURNITURE stays abstracted while you're OUTSIDE: a house you merely walk
    // past streams only its exterior walls — no interior fixtures materialize
    // (that per-house model-build is the churn we don't want as the town
    // scrolls by). The room furnishes only once you step inside it (below).
    expect(f0.addObjects).toHaveLength(0);
    expect(f0.add.length).toBeLessThanOrEqual(STREET_NPCS);
    expect(f0.add.every(n => /^resident_\d+_\d+$/.test(n.id))).toBe(true);

    // NOBODY parks on a doorstep: a spawn is either INSIDE its own house
    // (home phase / homebody — the staggered cycles put most people home)
    // or mid-errand WITH its trip issued (on-route pop-in). Never a body
    // standing idle on open ground.
    const houseOf = new Map(plan.houses.map(h => [h.index, h] as const));
    const walkerIds = new Set(f0.errands.map(e => e.npcId));
    let indoors = 0;
    for (const n of f0.add) {
      const houseIdx = Number(n.id.split("_")[1]);
      const h = houseOf.get(houseIdx)!;
      const inside =
        n.x > stage.center.x + h.dx && n.x < stage.center.x + h.dx + h.w &&
        n.y > stage.center.y + h.dy && n.y < stage.center.y + h.dy + h.h;
      expect(inside || walkerIds.has(n.id)).toBe(true);
      if (inside) {
        indoors++;
        // Homebodies only embody up close (they're hidden indoors).
        expect(Math.hypot(n.x - plaza.x, n.y - plaza.y)).toBeLessThanOrEqual(IDLE_EMBODY_R + 20);
      }
      // The tether: wander anchored at home, indoor radius.
      expect(n.behavior?.wanderRadius).toBeLessThanOrEqual(3);
      expect(n.behavior?.home).toBeDefined();
    }
    // At the plaza the budget buys STREET LIFE (walkers out-rank hidden
    // homebodies) — `indoors` may be 0 here; the lived-in check runs
    // with the player standing inside a house, below.
    void indoors;

    // Same spot, same instant: streaming is idempotent (no churn).
    const f1 = stage.frame(plaza, 0, bodyPos);
    expect(f1.buildings).toBeNull(); // hysteresis — nothing crossed a radius
    expect(f1.add).toHaveLength(0);
    expect(f1.remove).toHaveLength(0);

    // THE LOCK: a small step never VISIBLY blinks anyone out. A nearby
    // body may only be evicted while hidden INSIDE its own house (the
    // indoor-cull exception — turnover the player cannot see).
    const step = { x: plaza.x + 10, y: plaza.y };
    const f2before = new Map(live);
    const f2 = stage.frame(step, 0.5, bodyPos);
    for (const id of f2.remove) {
      const at = f2before.get(id)!;
      if (Math.hypot(at.x - step.x, at.y - step.y) < PEOPLE_EVICT_MIN) {
        const h = houseOf.get(Number(id.split("_")[1]))!;
        expect(at.x).toBeGreaterThan(stage.center.x + h.dx);
        expect(at.x).toBeLessThan(stage.center.x + h.dx + h.w);
        expect(at.y).toBeGreaterThan(stage.center.y + h.dy);
        expect(at.y).toBeLessThan(stage.center.y + h.dy + h.h);
      }
    }
    apply(f2);

    // THE HOUSES ARE LIVED IN: stand inside a home — its family embodies
    // indoors (the rank penalty is waived for the house you're in).
    const lot = plan.houses[0]!;
    const inHome = {
      x: stage.center.x + lot.dx + lot.w / 2,
      y: stage.center.y + lot.dy + lot.h / 2,
    };
    const fHome = stage.frame(inHome, 2, bodyPos);
    apply(fHome);
    const family = [...live.entries()].filter(([id]) => id.startsWith(`resident_${lot.index}_`));
    expect(family.length).toBeGreaterThan(0);
    // At least one member is HOME, indoors (the runner may be out
    // shopping — that's the errand clock, not an empty house).
    const homebodies = family.filter(([, at]) =>
      at.x > stage.center.x + lot.dx && at.x < stage.center.x + lot.dx + lot.w &&
      at.y > stage.center.y + lot.dy && at.y < stage.center.y + lot.dy + lot.h);
    expect(homebodies.length).toBeGreaterThan(0);
    // ...AND stepping inside is what FURNISHES the room: exactly this one
    // house's fixtures stream in (chest + cupboard + table for the 1-good
    // town) — the interior we kept abstracted while outside.
    expect(fHome.addObjects).toHaveLength(3);
    for (const o of fHome.addObjects) {
      expect(o.fixture).toBeDefined();
      expect(o.interactions).toHaveLength(0);
      expect(o.contains?.[0]?.relation).toBe(o.fixture === "table" ? "on" : "in");
    }

    // STEP BACK OUTSIDE (still well within PEOPLE_R of the house — this is the
    // cull, not a distance eviction): the family you were just standing with
    // ABSTRACTS. A body that has finished its tasks and is back inside its own
    // house, with you no longer in it, is culled on the spot instead of left
    // embodied indoors — returning shoppers piling up at home is what dragged
    // the frame. Its furniture is abstracted with it.
    const fLeave = stage.frame(plaza, 2.1, bodyPos);
    apply(fLeave);
    const lingeringIndoors = [...live.entries()].filter(([id, at]) =>
      id.startsWith(`resident_${lot.index}_`) &&
      at.x > stage.center.x + lot.dx && at.x < stage.center.x + lot.dx + lot.w &&
      at.y > stage.center.y + lot.dy && at.y < stage.center.y + lot.dy + lot.h);
    expect(lingeringIndoors).toHaveLength(0);
    expect(fLeave.removeObjects.length).toBeGreaterThan(0);
  });

  it("residents run the errand clock: cycles emit door-bracketed trips", () => {
    const { stage } = setup();
    const plaza = { x: stage.center.x, y: stage.center.y + 8 };
    const live = new Map<string, { x: number; y: number }>();
    const bodyPos = (id: string) => live.get(id) ?? null;

    const f0 = stage.frame(plaza, 0, bodyPos);
    for (const n of f0.add) live.set(n.id, { x: n.x, y: n.y });
    const ids = new Set(f0.add.map(n => n.id));

    // Sweep past a full shopping period (capDays 3 × FOOD_DAY_SEC 240 =
    // 720 s between trips): runners head out, each trip bracketed by
    // door transits and ending AT the box (≥ 3 waypoints, all finite).
    const seen = new Set<string>();
    for (let t = 5; t <= 1500; t += 5) {
      const f = stage.frame(plaza, t, bodyPos);
      for (const n of f.add) live.set(n.id, { x: n.x, y: n.y });
      for (const id of f.remove) live.delete(id);
      for (const e of f.errands) {
        expect(e.points.length).toBeGreaterThanOrEqual(3);
        for (const pt of e.points) {
          expect(Number.isFinite(pt.x)).toBe(true);
          expect(Number.isFinite(pt.y)).toBe(true);
        }
        if (ids.has(e.npcId)) seen.add(e.npcId);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(residentId(3, 0)).toBe("resident_3_0");
  });
});

describe("build-up: overflow housing becomes storeys, by the knob", () => {
  const bigTown = (days: number) => {
    const town = createTownWorld({
      economy: ECO,
      charter: { farmland: 420, ore_access: 0 },
      startPop: 400,
      seedScalars: { farms: 2 },
      key: "highburg",
    });
    town.step(days);
    return town;
  };

  it("knob 0 only spreads; knob 2 raises the center first, monotonically", () => {
    const town = bigTown(260); // pop ≈ 5,000 — want far beyond the lots
    const flat = townPlan(town, ECO, "highburg", 11, 0);
    expect(flat.houses.every(h => h.floors === 1)).toBe(true);
    // At knob 0, capacity is exactly the placed lots (homes + the lots
    // stalls converted) — and the town is FULL: it ran out of ground.
    expect(flat.built).toBeGreaterThanOrEqual(flat.houses.length);
    expect(flat.want).toBeGreaterThan(flat.built);

    const tall = townPlan(town, ECO, "highburg", 11, 2);
    // Same lots, same positions — the knob never moves a house.
    expect(tall.houses.length).toBe(flat.houses.length);
    for (let i = 0; i < tall.houses.length; i++) {
      expect(tall.houses[i]!.dx).toBe(flat.houses[i]!.dx);
      expect(tall.houses[i]!.dy).toBe(flat.houses[i]!.dy);
    }
    // Storeys rose, capacity grew by exactly the added floors.
    const extra = tall.houses.reduce((a, h) => a + h.floors - 1, 0);
    expect(extra).toBeGreaterThan(0);
    expect(tall.built).toBe(flat.built + extra);
    expect(tall.houses.every(h => h.floors >= 1 && h.floors <= 3)).toBe(true); // knob 2 ⇒ ≤ 3 storeys

    // The historical gradient: the town rises from the center outward —
    // every multi-storey house is nearer the plaza than the farthest
    // single-storey one.
    const r = (h: { dx: number; dy: number; w: number; h: number }) =>
      Math.hypot(h.dx + h.w / 2, h.dy + h.h / 2);
    const tallest = Math.max(...tall.houses.map(h => h.floors));
    const outermostTall = Math.max(...tall.houses.filter(h => h.floors === tallest).map(r));
    const outermostFlat = Math.max(...tall.houses.filter(h => h.floors === 1).map(r));
    expect(outermostTall).toBeLessThan(outermostFlat);
  });

  it("floors are monotone under growth: more pressure only ever rises", () => {
    const young = townPlan(bigTown(230), ECO, "highburg", 11, 2);
    const old = townPlan(bigTown(280), ECO, "highburg", 11, 2);
    const youngFloors = new Map(young.houses.map(h => [h.index, h.floors] as const));
    for (const h of old.houses) {
      const before = youngFloors.get(h.index);
      if (before !== undefined) expect(h.floors).toBeGreaterThanOrEqual(before);
    }
  });
});
