// The TOWN STAGE (shared/symbol-game/town-stage.ts): a certified, sparse
// world-engine spec — OPEN town, no gate, no star — with the quest cast at
// its real anchors and the SHARED RESIDENT MODEL streaming the population
// (shared/engine/town/residents.ts — the same mechanics the 2D canvas
// manager runs: indoor homebodies, embodiment radii and ranking, the
// no-blink-out lock, door-bracketed trips). Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan, townPlaza, type TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import { roadDistance } from "@shared/world-engine/kernel/town/streets.js";
import { HOUSEHOLD, houseDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { equilibriumExportScale, exportSpareScale } from "@shared/world-engine/kernel/town/complementary.js";
import {
  IDLE_EMBODY_R, PEOPLE_EVICT_MIN, STREET_NPCS, residentId,
} from "@shared/world-engine/kernel/town/residents.js";
import { houseRoomPlan, livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import { bookUnitsPerStreetUnit, buildTownQuestGame } from "@shared/world-engine/interaction/town/town-quests.js";
import {
  INTERIOR_LOAD_R, createTownStage,
} from "@shared/world-engine/interaction/town/town-stage.js";
import {
  AWAY_DISTANCE_M, RARE_IMPORT_KIND, TRADE_IMPORT_KINDS, rarePerVisit,
} from "@shared/world-engine/kernel/town/trade.js";
import { barterLegSeconds, type BarterSignals } from "@shared/world-engine/kernel/town/barter.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import {
  annexOptions, bankLabor, createTownDeltas, requestAnnex,
} from "@shared/world-engine/kernel/town/construction.js";

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

  it("exposes the street tree as ground-ribbon roads in world coords — the BASELINE is pavement like every other street", () => {
    const { plan, stage } = setup();
    // RE-PINNED (growth-phase-B): the plaza RING died. It was the one
    // street excluded from the ribbons, because a painted circle at every
    // town's heart read as artificial (user, 2026-07-22). Street 0 is now
    // the BASELINE — the real road the town formed around — so it is drawn
    // like the road it is, and NOTHING is excluded.
    const drawn = plan.streets.streets.filter(s => s.pts.length >= 2);
    expect(stage.roads).toHaveLength(drawn.length);
    expect(stage.roads.length).toBeGreaterThan(0);
    for (const r of stage.roads) {
      expect(r.points.length).toBeGreaterThanOrEqual(2);
      expect(r.width).toBeGreaterThan(0);
    }
    // The baseline's OWN ribbon is among them, at arterial width.
    const base = plan.streets.streets.find(s => s.baseline)!;
    const want = { x: stage.center.x + base.pts[0].x, y: stage.center.y + base.pts[0].y };
    const baseRoad = stage.roads.find(
      r => Math.abs(r.points[0].x - want.x) < 1e-6 && Math.abs(r.points[0].y - want.y) < 1e-6,
    );
    expect(baseRoad).toBeDefined();
    expect(baseRoad!.width).toBe(3.4);
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
    // house's fixtures stream in (the goods box + cupboard + table for the
    // 1-good town, plus the household stations: 2 beds, 2 chairs, per-member
    // boxes — and whichever round-2 stations FIT: bath/toilet/barrel/bin/bowl) —
    // the interior we kept abstracted while outside. This town sells only
    // FOOD, so its goods box is the refrigerator, not a plain chest.
    const kinds = fHome.addObjects.map(o => o.fixture).sort();
    for (const core of ["bed", "chair", "refrigerator", "cupboard", "table", "box"]) {
      expect(kinds).toContain(core);
    }
    expect(kinds.filter(k => k === "bed")).toHaveLength(2);
    expect(kinds.filter(k => k === "chair")).toHaveLength(2);
    // `refrigerator` — the food good's box (the other goods keep plain chests).
    const ALLOWED = new Set(["bed", "chair", "chest", "cupboard", "table", "box", "bath", "toilet", "barrel", "bin", "bowl", "oven", "refrigerator"]);
    for (const k of kinds) expect(ALLOWED.has(k as string)).toBe(true);
    for (const o of fHome.addObjects) {
      expect(o.fixture).toBeDefined();
      expect(o.interactions).toHaveLength(0);
      expect(o.contains?.[0]?.relation).toBe(o.fixture === "table" || o.fixture === "bowl" ? "on" : "in");
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

    // The historical gradient: the town rises from its CENTRE outward —
    // every multi-storey house is nearer the plaza than the farthest
    // single-storey one. RE-PINNED (growth-phase-B): "nearer" is now the
    // STREET WALK to the plaza the network founded, not the radius from
    // the frame origin — accessibility is what the ranking reads, and the
    // origin stopped being the middle of anything when the ring died.
    const sq = townPlaza(tall);
    const r = (h: TownHouse) => roadDistance(tall.streets, houseDoorstep({ x: 0, y: 0 }, h), sq);
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

describe("goods clock RE-ANCHOR (§13 demote) — the schedule resumes from reality", () => {
  it("pantry(house,t) reads the anchored units, repeatably, and lands in the HOME phase", () => {
    const { plan, stage } = setup();
    const g = stage.goods[0]!;
    const house = plan.houses[0]!;
    const t = 500;
    // The representable band is fill-scaled; sample a period for its real min/max.
    const { period } = g.cycle(house);
    let lo = Infinity, hi = -Infinity;
    for (let dt = 0; dt < period; dt += period / 200) {
      const p = g.pantry(house, t + dt);
      lo = Math.min(lo, p); hi = Math.max(hi, p);
    }
    expect(hi).toBeGreaterThan(lo);
    const mid = (lo + hi) / 2;
    g.reanchor(house, mid, t);
    expect(g.pantry(house, t)).toBeCloseTo(mid, 5);
    expect(g.errand(house, t).phase).toBe("home");
    // Shifts ACCUMULATE — a second episode re-anchors just as exactly.
    const other = lo + (hi - lo) * 0.8;
    g.reanchor(house, other, t + 40);
    expect(g.pantry(house, t + 40)).toBeCloseTo(other, 5);
    expect(g.errand(house, t + 40).phase).toBe("home");
  });

  it("a topped-up box defers the next trip; a drained one makes it imminent", () => {
    const { plan, stage } = setup();
    const g = stage.goods[0]!;
    const house = plan.houses[0]!;
    const t = 500;
    const { period } = g.cycle(house);
    const departure = (from: number): number => {
      for (let dt = 0; dt < period * 1.5; dt += period / 400) {
        if (g.errand(house, from + dt).phase !== "home") return dt;
      }
      return period * 1.5;
    };
    g.reanchor(house, g.boxCap * 2, t); // clamped to FULL — just refilled
    const afterTopUp = departure(t);
    g.reanchor(house, 0, t); // clamped to the surplus floor — trip nearly due
    const afterDrain = departure(t);
    expect(afterDrain).toBeLessThan(afterTopUp);
    // Topped up ⇒ (almost) a whole draining segment away; drained ⇒ within a few steps.
    expect(afterTopUp).toBeGreaterThan(period * 0.5);
    expect(afterDrain).toBeLessThan(period * 0.1);
  });
});

describe("supply flow — producer piles + dawn-cart hauls (goods.ts)", () => {
  it("produceAt: fills across the street day at producer works, resets at dawn; 0 elsewhere", () => {
    const { stage } = setup();
    const g = stage.goods[0]!;
    const producers = g.producerWorks();
    expect(producers.length).toBeGreaterThan(0);
    const w = producers[0]!;
    // Strictly non-decreasing within a window, and it must RESET somewhere in a day.
    let resets = 0;
    let prev = g.produceAt(w, 1000);
    for (let dt = 6; dt <= 240; dt += 6) {
      const v = g.produceAt(w, 1000 + dt);
      if (v < prev) resets++;
      prev = v;
    }
    expect(resets).toBe(1); // exactly one dawn per day
    expect(g.produceAt(99999, 1000)).toBe(0);
  });

  it("haul: shelved sources get a daily round trip (out, unload, back), gate sellers none", () => {
    const { stage } = setup();
    const g = stage.goods[0]!;
    const shelved = g.sources.filter((s) => g.good.shelved.includes(s.kind) && !g.good.producers.includes(s.kind));
    // brookmill food is market-channel: at least one stall is cart-stocked.
    expect(shelved.length).toBeGreaterThan(0);
    const src = shelved[0]!;
    const phases = new Set<string>();
    let sawWalkTo = false;
    for (let t = 0; t < 240; t += 2) {
      const trip = g.haul(src, t);
      if (!trip) continue;
      phases.add(trip.phase);
      if (trip.phase !== "idle" && trip.walkTo && trip.walkTo.length > 0) sawWalkTo = true;
    }
    expect(phases.has("idle")).toBe(true);
    expect(phases.has("to_market")).toBe(true);
    expect(phases.has("unloading")).toBe(true);
    expect(phases.has("to_producer")).toBe(true);
    expect(sawWalkTo).toBe(true);
    // An unshelved gate seller (the farm) hauls nothing.
    const gate = g.sources.find((s) => !g.good.shelved.includes(s.kind));
    if (gate) expect(g.haul(gate, 50)).toBeNull();
  });
});

describe("intercity trade v1 — the abstract-partner caravan (trade.ts)", () => {
  it("the town has a trade line: a gate on the road out, a route to the hall depot", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    expect(tr).toBeTruthy();
    expect(tr.route.partnerKey).toMatch(/^away:/); // binds to a (region,cell) address later
    expect(tr.route.route.length).toBeGreaterThanOrEqual(2);
    expect(tr.route.imports.length).toBeGreaterThan(0);
    expect(tr.route.exports).toEqual(["food"]);
    // The gate is the farthest street tip — well outside the plaza.
    const d = Math.hypot(tr.route.gate.x - stage.center.x, tr.route.gate.y - stage.center.y);
    expect(d).toBeGreaterThan(30);
  });

  it("one visit a day: away -> arriving -> trading -> leaving; walkTo mid-visit; buckets tick per visit", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    const phases = new Set<string>();
    let sawWalkTo = false;
    for (let t = 0; t < 240; t += 2) {
      const trip = tr.caravan(t);
      phases.add(trip.phase);
      if (trip.phase !== "away" && trip.walkTo && trip.walkTo.length > 0) sawWalkTo = true;
    }
    expect([...phases].sort()).toEqual(["arriving", "away", "leaving", "trading"]);
    expect(sawWalkTo).toBe(true);
    expect(tr.tradeDay(1000 + 240)).toBe(tr.tradeDay(1000) + 1);
  });

  it("the export pile fills between departures and resets when the caravan takes it", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    let resets = 0;
    let prev = tr.exportPile(500);
    for (let dt = 3; dt <= 240; dt += 3) {
      const v = tr.exportPile(500 + dt);
      if (v < prev) resets++;
      prev = v;
    }
    expect(resets).toBe(1); // one departure per day
    expect(Math.max(prev, tr.exportPile(500))).toBeGreaterThan(0);
  });

  // ⚖️ batch 2 · G2 → batch 3 · B4 — the stage's export scale, wired to the
  // goods layer, AT ITS FIXED POINT.
  it("🚨 the pile is scaled by what the town can SPARE, read off its own goods", () => {
    const { town, plan, stage } = setup();
    const tr = stage.trade!;
    const food = stage.goods.find((g) => g.good.key === "food")!;
    // THE PREMISE, unchanged and re-measured: this town is FED, so the town's
    // PRE-EXPORT shortage S₀ is 0 and batch 2's slope reads exactly 1.
    // (Same on the shipped dollhouse — food shortage 0 at every age probed.)
    expect(food.fill()).toBe(1);
    expect(exportSpareScale(1 - food.fill())).toBe(1);
    // ⚖️ RE-PINNED (batch 3 · B4). The peak used to be one WHOLE day's authored
    // surplus, because the lane's own load was invisible to the books it was
    // drawn from: the town shipped a third of its draw away every day and its
    // shortage read 0 forever (free lunch #3). B3 makes that shipment an `owed`
    // term on the books, so the shortage the valve reads is partly caused by
    // the valve's own answer — and `equilibriumExportScale` solves the loop
    // instead of chasing it. THE PIN IS THE FIXED POINT, measured off this
    // fixture's own books, not a typed constant.
    const daily = plan.houses.length * HOUSEHOLD * food.good.perCapitaDaily * 0.3;
    const burden = (daily * bookUnitsPerStreetUnit(ECO, "food")) / town.scalar("food_need");
    // A fed exporter's burden is 0.3 × (houses × HOUSEHOLD) / pop — 0.3 exactly
    // where the plan's beds and the books' souls agree, and this town has grown
    // past its houses (1430 souls in 278 houses), so it comes out a little under.
    // RE-PINNED (growth-phase-B): the town re-laid, so its bed count moved
    // 277 → 278 and every number below moved with it. The SHAPE of the pin —
    // a fixed point measured off this fixture's own books — is untouched.
    // RE-PINNED AGAIN (growth phase C §1.4): the district pass now sites a
    // service point where it costs its quarter the fewest STREET metres
    // instead of nearest a chord centroid, and on this fixture that founds one
    // stall fewer. A stall CONVERTS a house, so two beds came back and the
    // bed count moved 278 → 280. Same shape, same fixture, one more house.
    expect(burden).toBeCloseTo(0.2938, 4);
    const sStar = equilibriumExportScale(1 - food.fill(), burden);
    expect(sStar).toBeCloseTo(0.338, 4);
    // …and the equilibrium the town settles at is just under the want gate:
    // S₀ + s*·burden ≈ 0.099 against BARTER_WANT_MIN 0.15. It ships a third and
    // feels a tenth — neither the old free lunch nor a cliff.
    expect(1 - food.fill() + sStar * burden).toBeCloseTo(0.0993, 4);
    let peak = 0;
    for (let t = 0; t < 240; t += 2) peak = Math.max(peak, tr.exportPile(500 + t));
    expect(peak).toBeGreaterThan(sStar * daily * 0.9);
    expect(peak).toBeLessThanOrEqual(sStar * daily);
    // ONE definition: `exportDailyUnits` is the ramp's own ceiling, and it is
    // what the caravan debit (B5) charges the books.
    expect(tr.exportDailyUnits()).toBeCloseTo(sStar * daily, 9);
  });
});

describe("the VIEW GUARD — nobody spawns or despawns where the camera can see", () => {
  it("first frame populates freely; every later spawn/cull is out of view or hidden indoors", () => {
    const { plan, stage } = setup();
    const plaza = { x: stage.center.x, y: stage.center.y + 8 };
    const R = 120; // the camera's world reach (visibleR)
    const live = new Map<string, { x: number; y: number }>();
    const bodyPos = (id: string) => live.get(id) ?? null;
    const apply = (f: ReturnType<typeof stage.frame>) => {
      for (const n of f.add) live.set(n.id, { x: n.x, y: n.y });
      for (const id of f.remove) live.delete(id);
    };
    // No isVisible passed + the observer on open ground ⇒ every interior is
    // CONCEALED, so "hidden" here = inside any building footprint.
    const hiddenIndoors = (pt: { x: number; y: number }) =>
      plan.houses.some(
        (h) =>
          pt.x > stage.center.x + h.dx && pt.x < stage.center.x + h.dx + h.w &&
          pt.y > stage.center.y + h.dy && pt.y < stage.center.y + h.dy + h.h,
      ) ||
      plan.works.some(
        (wk) =>
          pt.x > stage.center.x + wk.dx && pt.x < stage.center.x + wk.dx + wk.w &&
          pt.y > stage.center.y + wk.dy && pt.y < stage.center.y + wk.dy + wk.h,
      );
    const outOfView = (pt: { x: number; y: number }) =>
      Math.hypot(pt.x - plaza.x, pt.y - plaza.y) >= R || hiddenIndoors(pt);

    // FIRST FRAME: the town starts POPULATED — mid-errand clocks put people
    // on the lanes at minute zero (in view is fine; nothing is on show yet).
    const f0 = stage.frame(plaza, 0, bodyPos, R);
    apply(f0);
    expect(f0.add.length).toBeGreaterThan(0);

    // EVERY LATER FRAME: a body may only MATERIALIZE out of view or inside a
    // concealed building, and may only be CULLED from out of view or hidden
    // indoors — a spawn or pop-out the camera can watch is a teleport.
    for (let t = 2; t <= 120; t += 2) {
      const before = new Map(live);
      const f = stage.frame(plaza, t, bodyPos, R);
      for (const n of f.add) {
        expect(outOfView({ x: n.x, y: n.y })).toBe(true);
      }
      for (const id of f.remove) {
        const at = before.get(id);
        if (at) expect(outOfView(at)).toBe(true);
      }
      apply(f);
    }
  });
});

describe("the FAMILY LOCK — a watched house's members never lose their bodies", () => {
  // The reported dollhouse teleport: a watched member out at a far workplace
  // lost its body slot to closer street residents (plain distance rank),
  // finished the shift ABSTRACTLY, and re-entered by MATERIALIZING at its own
  // doorstep. Members of a visible-interior house now claim slots FIRST.
  it("holds an embodied member at any distance while its interior is on show", () => {
    const { plan, stage } = setup();
    const house = plan.houses[0]!;
    const isVisible = (hi: number) => hi === house.index;
    const inside = {
      x: stage.center.x + house.dx + house.w / 2,
      y: stage.center.y + house.dy + house.h / 2,
    };
    const live = new Map<string, { x: number; y: number }>();
    const bodyPos = (id: string) => live.get(id) ?? null;
    const apply = (f: ReturnType<typeof stage.frame>) => {
      for (const n of f.add) live.set(n.id, { x: n.x, y: n.y });
      for (const id of f.remove) live.delete(id);
    };
    apply(stage.frame(inside, 0, bodyPos, undefined, isVisible));
    const famIds = [...live.keys()].filter((id) => Number(id.split("_")[1]) === house.index);
    expect(famIds.length).toBeGreaterThan(0); // the watched interior embodies its household
    // Drag one member FAR out (a long commute, way past every embodiment
    // radius) and stream on: the watched member must never despawn — that
    // despawn is exactly what turned its homecoming into a door teleport.
    const walker = famIds[0]!;
    live.set(walker, { x: stage.center.x + 400, y: stage.center.y + 400 });
    for (let t = 1; t <= 40; t++) {
      const f = stage.frame(inside, t * 6, bodyPos, undefined, isVisible);
      // NO watched member ever despawns — not the far walker (the original
      // doorstep teleport) and not the ones at home (the budget-boundary
      // THRASH: spawn → despawn → doorstep respawn, every frame).
      for (const id of famIds) expect(f.remove).not.toContain(id);
      apply(f);
      live.set(walker, { x: stage.center.x + 400, y: stage.center.y + 400 });
    }
    for (const id of famIds) expect(live.has(id)).toBe(true);
  });
});

describe("the VIEW GUARD at ROOM granularity — re-entering a house (round 5c)", () => {
  // The reported avatar-mode regression: rooms-as-buildings made "house
  // visible" (any room occupied/revealed) conceal NOTHING indoors, so the
  // spawn guard relocated a re-entered house's at-home members a whole
  // view-radius up the road — the family seemed to have vanished. The fix:
  // concealment is per ROOM — a visible house's unrevealed back rooms are
  // legitimate spawn cover, and that's exactly where the family reappears.
  it("members of a freshly-entered house spawn inside its CONCEALED rooms, never at the view edge", () => {
    const { plan, stage } = setup();
    const R = 120; // the camera's world reach (visibleR)
    const house = plan.houses.find(h => houseRoomPlan(stage.center, h).partitioned)!;
    expect(house).toBeDefined();
    const lr = livingRect(stage.center, house);
    const inside = { x: lr.x + lr.w / 2, y: lr.y + lr.h / 2 }; // standing in the living room
    const plaza = { x: stage.center.x, y: stage.center.y + 8 };
    const live = new Map<string, { x: number; y: number }>();
    const bodyPos = (id: string) => live.get(id) ?? null;
    // Visibility as the 3D host reports it: the HOUSE is visible once the
    // player occupies any of its rooms; per ROOM, only the living room
    // (under the player's feet) is revealed — back rooms stay closed.
    let occupied = false;
    const isVisible = (hi: number) => occupied && hi === house.index;
    const isRoomVisible = (id: string) => occupied && id === `h_${house.index}`;

    // Prime elsewhere (spends the first-frame exemption), then step inside.
    const f0 = stage.frame(plaza, 0, bodyPos, R, isVisible, isRoomVisible);
    for (const n of f0.add) live.set(n.id, { x: n.x, y: n.y });
    occupied = true;
    const f = stage.frame(inside, 1, bodyPos, R, isVisible, isRoomVisible);
    const fam = f.add.filter(n => Number(n.id.split("_")[1]) === house.index);
    const inHouse = (pt: { x: number; y: number }) =>
      pt.x > stage.center.x + house.dx && pt.x < stage.center.x + house.dx + house.w &&
      pt.y > stage.center.y + house.dy && pt.y < stage.center.y + house.dy + house.h;
    const inLiving = (pt: { x: number; y: number }) =>
      pt.x > lr.x && pt.x < lr.x + lr.w && pt.y > lr.y && pt.y < lr.y + lr.h;
    // The family REAPPEARS at home: at least one at-home member materializes
    // inside the house (the allocator always keeps ≥1 soul home)...
    const home = fam.filter(n => inHouse(n));
    expect(home.length).toBeGreaterThan(0);
    // ...and every indoor spawn is in a room the player CANNOT SEE — never
    // popped into the living room in front of them.
    for (const n of home) {
      expect(`${n.id} in living: ${inLiving(n)}`).toBe(`${n.id} in living: false`);
    }
    // And nobody was relocated to the view edge to trek in (the regression:
    // spawns at visibleR+8 walking home from ~130 m away).
    for (const n of fam) {
      expect(Math.hypot(n.x - inside.x, n.y - inside.y)).toBeLessThan(R);
    }
  });
});

describe("INTERIOR STAGING — far houses are shells, near/watched houses full rooms (round 5c)", () => {
  it("a far house stages ONE shell; entering swaps in the room plan; leaving swaps back", () => {
    const { plan, stage } = setup();
    const plaza = { x: stage.center.x, y: stage.center.y + 8 };
    // A partitioned house beyond the interior-unload radius but within wall
    // range of the plaza.
    const house = plan.houses.find(h => {
      const d = Math.hypot(
        stage.center.x + h.dx + h.w / 2 - plaza.x,
        stage.center.y + h.dy + h.h / 2 - plaza.y,
      );
      return d > 65 && d < 95 && houseRoomPlan(stage.center, h).partitioned;
    })!;
    expect(house).toBeDefined();
    let occupied = false;
    const isVisible = (hi: number) => occupied && hi === house.index;

    // Far: exactly one building for the house — the SHELL, whole footprint,
    // under the historical id.
    const f0 = stage.frame(plaza, 0, () => null, undefined, isVisible);
    const of0 = f0.buildings!.filter(b => b.id === `h_${house.index}` || b.id.startsWith(`h_${house.index}_`));
    expect(of0.map(b => b.id)).toEqual([`h_${house.index}`]);
    expect(of0[0]!.footprint.w).toBeCloseTo(house.w);
    expect(of0[0]!.footprint.h).toBeCloseTo(house.h);

    // Inside (watched): the FULL room plan swaps in — the living room keeps
    // the shell's id, now over the living rect only.
    occupied = true;
    const lr = livingRect(stage.center, house);
    const inside = { x: lr.x + lr.w / 2, y: lr.y + lr.h / 2 };
    const f1 = stage.frame(inside, 1, () => null, undefined, isVisible);
    expect(f1.buildings).not.toBeNull();
    const rooms = houseRoomPlan(stage.center, house).rooms;
    const staged = f1.buildings!.filter(b => b.id === `h_${house.index}` || b.id.startsWith(`h_${house.index}_`));
    expect(staged.map(b => b.id).sort()).toEqual(rooms.map(r => r.id).sort());
    expect(staged.find(b => b.id === `h_${house.index}`)!.footprint).toEqual(lr);
    expect(staged.length).toBeGreaterThanOrEqual(3); // living + bedroom(s) + bath

    // Concealed and far again: back to the shell (the swap is unseen).
    occupied = false;
    const f2 = stage.frame(plaza, 2, () => null, undefined, isVisible);
    expect(f2.buildings).not.toBeNull();
    const of2 = f2.buildings!.filter(b => b.id === `h_${house.index}` || b.id.startsWith(`h_${house.index}_`));
    expect(of2.map(b => b.id)).toEqual([`h_${house.index}`]);
    // A house within the interior radius of the player stages FULL even
    // unwatched (pre-loaded before the player could reach its door).
    const near = plan.houses.find(h => {
      const d = Math.hypot(
        stage.center.x + h.dx + h.w / 2 - plaza.x,
        stage.center.y + h.dy + h.h / 2 - plaza.y,
      );
      return d <= INTERIOR_LOAD_R && houseRoomPlan(stage.center, h).partitioned;
    });
    if (near) {
      const nearStaged = f2.buildings!.filter(
        b => b.id === `h_${near.index}` || b.id.startsWith(`h_${near.index}_`),
      );
      expect(nearStaged.length).toBe(houseRoomPlan(stage.center, near).rooms.length);
    }
  });
});

describe("trade v1.5 — a REAL partner, distance-priced rarity (trade.ts bindPartner)", () => {
  it("unbound: the abstract partner reads far and carries the fewest rares", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    expect(tr.route.partnerKey).toMatch(/^away:/);
    expect(tr.route.distanceM).toBe(AWAY_DISTANCE_M);
    expect(tr.route.rare).toEqual({ kind: RARE_IMPORT_KIND, perVisit: rarePerVisit(AWAY_DISTANCE_M) });
    expect(tr.route.rare.perVisit).toBe(1);
  });

  it("binding a near hamlet re-keys the line, re-aims the gate, and raises the rare allotment", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    // A partner ~700m east of the town center.
    const partnerAt = { x: stage.center.x + 700, y: stage.center.y };
    tr.bindPartner({ key: "hamlet-1", at: partnerAt });
    expect(tr.route.partnerKey).toBe("hamlet-1");
    expect(tr.route.distanceM).toBeCloseTo(700, 0);
    expect(tr.route.rare.perVisit).toBe(rarePerVisit(700));
    expect(tr.route.rare.perVisit).toBeGreaterThan(rarePerVisit(AWAY_DISTANCE_M));
    // The gate leans TOWARD the partner: its bearing from center points east-ish.
    const g = tr.route.gate;
    expect(g.x - stage.center.x).toBeGreaterThan(0);
    // The caravan still cycles a full visit on the new route.
    const phases = new Set<string>();
    for (let t = 0; t < 240; t += 2) phases.add(tr.caravan(t).phase);
    expect(phases.has("trading")).toBe(true);
    expect(phases.has("away")).toBe(true);
  });

  // ── R&T ⑤ T1: the bind RECORDS the partner, so nothing downstream has to
  //    guess whether the road is real (the host used to re-push this line as a
  //    place-less stub and price every caravan at the flat fallback day).
  it("🔒 T1 — an UNBOUND line declares no partner place: the flat leg is the honest one", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    expect(tr.route.partnerAt).toBeUndefined();
    expect(tr.route.partnerGeo).toBeUndefined();
    // Its `gate` is OUR OWN street tip, never the partner's place — which is
    // exactly why a reader must not measure it.
    expect(Math.hypot(tr.route.gate.x - stage.center.x, tr.route.gate.y - stage.center.y))
      .toBeLessThan(AWAY_DISTANCE_M);
  });

  it("🔒 T1 — a BOUND partner carries its place AND its road, and its leg is NOT the flat fallback", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    const partnerAt = { x: stage.center.x + 700, y: stage.center.y };
    // A road that goes round something: longer than the 700 m line of sight.
    tr.bindPartner({ key: "hamlet-1", at: partnerAt, distanceM: 920 });
    expect(tr.route.partnerAt).toEqual(partnerAt);
    expect(tr.route.distanceM).toBe(920);
    const flat = barterLegSeconds(DOLLHOUSE_SCALE, null);
    const bound = barterLegSeconds(DOLLHOUSE_SCALE, tr.route.distanceM);
    expect(bound).toBeGreaterThan(flat); // the whole point of T1
    // …and it is the ROAD that was priced, not the chord.
    expect(bound).toBeCloseTo(barterLegSeconds(DOLLHOUSE_SCALE, 920), 9);
    expect(bound).not.toBeCloseTo(barterLegSeconds(DOLLHOUSE_SCALE, 700), 6);
  });

  it("🔒 T5 — the partner's terrain reading rides the bind (absent ⇒ nothing is invented)", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    tr.bindPartner({ key: "city:9", at: { x: stage.center.x + 400, y: stage.center.y } });
    expect(tr.route.partnerGeo).toBeUndefined();
    tr.bindPartner({
      key: "city:9",
      at: { x: stage.center.x + 400, y: stage.center.y },
      geo: { node: "surplus", farmland: 260, ore: 4 },
    });
    expect(tr.route.partnerGeo).toEqual({ node: "surplus", farmland: 260, ore: 4 });
  });

  // ── R&T ⑤ T2: the cargo lists stop being constants once both books are read.
  it("🔒 T2 — binding WITHOUT scarcity reads leaves the authored lists byte-identical", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    tr.bindPartner({ key: "hamlet-1", at: { x: stage.center.x + 700, y: stage.center.y } });
    expect(tr.route.imports).toEqual(TRADE_IMPORT_KINDS);
    expect(tr.route.exports).toEqual(["food"]);
  });

  it("🔒 T2 — binding WITH both books derives the pair's own cargo (their surplus ∩ our shortage)", () => {
    const { stage } = setup();
    const tr = stage.trade!;
    const sig = (m: Record<string, number>): BarterSignals => ({ shortage: (g) => m[g] ?? 0 });
    tr.bindPartner({
      key: "hamlet-1",
      at: { x: stage.center.x + 700, y: stage.center.y },
      distanceM: 700,
      scarcity: {
        // We are short of cloth and clothing; they are short of food and wood.
        us: sig({ cloth: 0.8, clothing: 0.5, food: 0, wood: 0 }),
        them: sig({ cloth: 0, clothing: 0, food: 0.9, wood: 0.4 }),
        goods: ["food", "wood", "cloth", "clothing"],
      },
    });
    expect(tr.route.imports).toEqual(["cloth", "clothing"]); // ranked by OUR need
    expect(tr.route.exports).toEqual(["food", "wood"]); // ranked by THEIRS
    // The authored trinkets are gone — they were the unbound fallback, never a
    // floor under a derived list.
    for (const k of TRADE_IMPORT_KINDS) expect(tr.route.imports).not.toContain(k);
  });
});

describe("construction deltas: the stage re-plans a bumped house mid-session", () => {
  it("staked order → marked site climbing courses; commit → doored room the SAME frame (no scaffold timer)", () => {
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
    const deltas = createTownDeltas();
    const stage = createTownStage(town, ECO, plan, bundle, { seed: 11, deltas });

    // Stand INSIDE house h — the isVisible fallback (inside the footprint)
    // marks it watched, so it stages FULL and furnishes.
    const h = plan.houses[0]!;
    const key = `h_${h.index}`;
    const p = { x: stage.center.x + h.dx + h.w / 2, y: stage.center.y + h.dy + h.h / 2 };
    const f0 = stage.frame(p, 0);
    expect(f0.buildings).not.toBeNull();
    const oldIds = f0.addObjects.filter(o => o.id.startsWith(`furn_${h.index}_`)).map(o => o.id);
    expect(oldIds.length).toBeGreaterThan(0);

    // STAKE a STORE annex order (phase 3 — the designation IS the visible
    // construction): a marked SITE stands on the growth rect while the
    // room is pending; no walls exist yet.
    const opts = annexOptions(stage.center, h, houseRoomPlan(stage.center, h), [], deltas.get(key), "store");
    expect(opts.length).toBeGreaterThan(0);
    const row = deltas.postAnnexSite({
      buildingKey: key, cluster: "store", candidate: opts[0]!,
      costs: { block: 1 }, pile: {}, startedDay: 0, buildDays: 0.5,
    });
    const f1 = stage.frame(p, 1);
    const annexSite = (f1.sites ?? []).find(s => s.id === `site_pa_${row.ord}`);
    expect(annexSite).toBeDefined();
    expect(annexSite).toMatchObject({ type: "annex", stage: 0, progress: 0 });
    expect(f1.buildings?.find(b => b.id === `${key}_a0`)).toBeUndefined();

    // Materials stage and builders bank — the site CLIMBS: pillars at the
    // ⑦ bar, and `progress` carries the wall-course fraction (the renderer
    // stacks courses off it — worked pieces, never a timer).
    row.pile.block = 1;
    deltas.stageAnnexSite(row.ord, 1);
    bankLabor(row, 0.4);
    const f2 = stage.frame(p, 2);
    const climbing = (f2.sites ?? []).find(s => s.id === `site_pa_${row.ord}`);
    expect(climbing).toMatchObject({ stage: 2 });
    expect(climbing!.progress).toBeCloseTo(0.8);

    // COMMIT (the one order loop's executor path): the doored room lands
    // the SAME frame — the courses were the walls, so there is no scaffold
    // window, no timer, and the furniture refurnishes at once.
    expect(requestAnnex(deltas, key, opts[0]!)).toEqual({ ok: true });
    deltas.removeAnnexSite(row.ord);
    const f3 = stage.frame(p, 3);
    expect(f3.buildings).not.toBeNull();
    const real = f3.buildings!.find(b => b.id === `${key}_a0`);
    expect(real).toBeDefined();
    expect(real!.doorways.length).toBeGreaterThan(0);
    expect((f3.sites ?? [])).toEqual([]);
    for (const id of oldIds) expect(f3.removeObjects).toContain(id);
    expect(f3.addObjects.length).toBeGreaterThan(0); // the full set re-lands
  });
});
