// THE SEEDED NETWORK KERNEL (growth-phase-b-seeded-network.md §1, stage 1):
// the plaza ring is dead and a town grows from its SEEDS around an open
// BASELINE. What must hold:
//
//   §1.1  seeds in, seeds echoed; the legacy `bearings` input still works
//         through the one adapter and still round-trips.
//   §1.2  street 0 is an open path (span > spine > stub), flagged
//         `baseline`, with NO ring wrap anywhere; nothing re-crosses it
//         within MIN_GAP except at its own junction mouths.
//   §1.3  one event stream, prefix-stable: a bigger town replays the same
//         events further.
//   §1.4  standing footprints are avoided; coverage re-seeding opens new
//         roads into the ground the network does not reach.
//   §1.5  the built area fits inside the DECLARED extent by construction.
//   §1.6  junctions rank by the traffic they carry (the civic anchor).
//
// Pure geometry — no DB, no LLM, no GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";
import {
  growStreets, networkJunctions, rankJunctions, townPorts,
  type GrowSeed, type TownStreets, type Vec2,
} from "@shared/world-engine/kernel/town/streets.js";

const MIN_GAP = TOWN_DIMS.streetMinGap;

/** Every sampled point of every street, tagged with its street. */
function allPoints(net: TownStreets): Array<{ x: number; y: number; street: number; arc: number }> {
  const out: Array<{ x: number; y: number; street: number; arc: number }> = [];
  for (const s of net.streets) {
    for (let i = 0; i < s.pts.length; i++) out.push({ ...s.pts[i]!, street: s.id, arc: s.cum[i]! });
  }
  return out;
}

const SPAN: Vec2[] = [
  { x: -380, y: -120 }, { x: -140, y: -30 }, { x: 60, y: 40 }, { x: 300, y: 150 },
];

describe("§1.1 seeds — the input, the echo and the legacy adapter", () => {
  it("echoes its seeds and regrows byte-identically from the echo", () => {
    const seeds: GrowSeed[] = [{ kind: "span", pts: SPAN, portA: true, portB: true }];
    const net = growStreets(7, "spantown", 150, { seeds });
    expect(net.seeds).toEqual(seeds);
    const again = growStreets(7, "spantown", 150, { seeds: net.seeds });
    expect(JSON.stringify(again)).toBe(JSON.stringify(net));
  });

  it("compiles the LEGACY bearings input to stub seeds — one adapter, same town", () => {
    const viaBearings = growStreets(7, "stubtown", 120, { bearings: [0.5, -1.9] });
    expect(viaBearings.seeds).toEqual([
      { kind: "stub", bearing: 0.5 },
      { kind: "stub", bearing: -1.9 },
    ]);
    expect(viaBearings.bearings).toEqual([0.5, -1.9]); // the echo deltas carry
    const viaSeeds = growStreets(7, "stubtown", 120, { seeds: viaBearings.seeds });
    expect(JSON.stringify(viaSeeds.slots)).toBe(JSON.stringify(viaBearings.slots));
  });

  it("keeps the compass dedup and the cap of six on the legacy input", () => {
    const many = growStreets(7, "hubtown", 60, {
      bearings: [0, 0.1, 1, 2, 3, -3, -2, -1, -0.5],
    });
    expect(many.seeds.length).toBeLessThanOrEqual(6);
    expect(many.seeds).not.toContainEqual({ kind: "stub", bearing: 0.1 }); // same bucket as 0
  });

  it("sorts seeds into CANONICAL order: spans (longest first), spines, stubs", () => {
    const short: GrowSeed = { kind: "span", pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const long: GrowSeed = { kind: "span", pts: [{ x: -300, y: 0 }, { x: 300, y: 0 }] };
    const spine: GrowSeed = { kind: "spine", lanes: [[{ x: 0, y: 200 }, { x: 80, y: 240 }]] };
    const stub: GrowSeed = { kind: "stub", bearing: 1 };
    const net = growStreets(7, "mixed", 40, { seeds: [stub, short, spine, long] });
    expect(net.seeds.map(s => s.kind)).toEqual(["span", "span", "spine", "stub"]);
    expect((net.seeds[0] as { pts: Vec2[] }).pts).toEqual((long as { pts: Vec2[] }).pts);
  });
});

describe("§1.2 the baseline — an open path, no ring anywhere", () => {
  it("street 0 is the SPAN, flagged baseline at gen 0, and its ends are the ports", () => {
    const net = growStreets(7, "spantown", 150, {
      seeds: [{ kind: "span", pts: SPAN, portA: true, portB: true }],
    });
    const base = net.streets[0]!;
    expect(base.baseline).toBe(true);
    expect(base.gen).toBe(0);
    expect(base.parent).toBe(-1);
    // The span's own vertices survive densification, in order.
    expect(base.pts[0]).toEqual(SPAN[0]);
    expect(base.pts[base.pts.length - 1]).toEqual(SPAN[SPAN.length - 1]);
    expect(net.ports).toEqual([{ street: 0, end: 0 }, { street: 0, end: 1 }]);
    const ports = townPorts(net);
    expect(ports.map(p => ({ x: p.x, y: p.y }))).toEqual([SPAN[0], SPAN[SPAN.length - 1]]);
    // No street anywhere still claims to wrap.
    for (const s of net.streets) expect((s as { ring?: boolean }).ring).toBeUndefined();
  });

  it("a STUB baseline is a short segment on the seed bearing, ~2×PLAZA_R, and it GROWS its ports", () => {
    const net = growStreets(7, "stubtown", 120, { bearings: [0] });
    const base = net.streets[0]!;
    expect(base.baseline).toBe(true);
    const len = base.cum[base.cum.length - 1]!;
    expect(len).toBeGreaterThanOrEqual(2 * TOWN_DIMS.plazaR);
    expect(len).toBeLessThan(4 * TOWN_DIMS.plazaR);
    // Along the bearing (due east) and centred on the frame origin.
    expect(base.pts[0]!.y).toBeCloseTo(0, 6);
    expect(base.pts[0]!.x).toBeCloseTo(-len / 2, 6);
    // The arterials that CONTINUE it past its ends are the town's gates.
    expect(net.ports.length).toBeGreaterThan(0);
    for (const p of net.ports) expect(net.streets[p.street]!.gen).toBe(0);
  });

  it("BASELINE CLEARANCE: nothing re-crosses street 0 inside MIN_GAP away from its own junctions", () => {
    const net = growStreets(7, "riverton", 400);
    const base = net.streets[0]!;
    // Junction mouths on the baseline: where its children attach.
    const mouths = net.streets.filter(s => s.parent === 0).map(s => s.parentArc);
    for (const p of allPoints(net)) {
      if (p.street === 0) continue;
      const own = net.streets[p.street]!;
      for (let i = 0; i < base.pts.length; i++) {
        const d = Math.hypot(base.pts[i]!.x - p.x, base.pts[i]!.y - p.y);
        if (d >= MIN_GAP) continue;
        // Legal only near the junction this street's own chain hangs off.
        const nearMouth = mouths.some(m => Math.abs(m - base.cum[i]!) < MIN_GAP + TOWN_DIMS.streetStep);
        expect({ street: own.id, d, nearMouth }).toMatchObject({ nearMouth: true });
      }
    }
  });
});

describe("§1.3 one event stream — deterministic and prefix-stable", () => {
  it("same input ⇒ byte-identical output, and a bigger town only extends", () => {
    const small = growStreets(7, "riverton", 120);
    expect(JSON.stringify(growStreets(7, "riverton", 120))).toBe(JSON.stringify(small));
    const big = growStreets(7, "riverton", 500);
    expect(big.slots.length).toBeGreaterThan(small.slots.length);
    expect(JSON.stringify(big.slots.slice(0, small.slots.length))).toBe(JSON.stringify(small.slots));
    for (const s of small.streets) {
      const b = big.streets[s.id]!;
      expect(b.parent).toBe(s.parent);
      expect(JSON.stringify(b.pts.slice(0, s.pts.length))).toBe(JSON.stringify(s.pts));
    }
  });

  it("the high street carries frontage of its own: the baseline emits lots", () => {
    const net = growStreets(7, "spantown", 200, {
      seeds: [{ kind: "span", pts: SPAN, portA: true, portB: true }],
    });
    expect(net.slots.filter(s => s.street === 0).length).toBeGreaterThan(4);
    // …and they lead the sequence — the road was there before the town.
    expect(net.slots[0]!.street).toBe(0);
  });
});

describe("§1.4 obstacles and coverage re-seeding", () => {
  it("streets bend around STANDING FOOTPRINTS instead of through them", () => {
    const box = { x: 60, y: -40, w: 90, h: 90 };
    const net = growStreets(7, "annexed", 200, { obstacles: [box] });
    for (const p of allPoints(net)) {
      const inside =
        p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h;
      expect({ x: p.x, y: p.y, inside }).toMatchObject({ inside: false });
    }
    // The obstacle is a real constraint, not a no-op: the town differs.
    const free = growStreets(7, "annexed", 200);
    expect(JSON.stringify(net.slots)).not.toBe(JSON.stringify(free.slots));
  });

  it("coverage re-seeding opens roads the initial seeds never asked for", () => {
    const net = growStreets(7, "riverton", 900);
    const gen0 = net.streets.filter(s => s.gen === 0);
    // baseline + the seeded arterials (≤ 4 for a one-stub town) + re-seeds.
    expect(gen0.length).toBeGreaterThan(4);
  });
});

describe("§1.5 extent — plan.radius is an OUTPUT that fits inside", () => {
  it("street growth holds the BUILT MARGIN back from the declared extent", () => {
    const net = growStreets(7, "riverton", 2000); // grow until full
    let maxR = 0;
    for (const p of allPoints(net)) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
    expect(maxR).toBeLessThanOrEqual(TOWN_DIMS.townRMax - TOWN_DIMS.builtMargin);
    // The margin is exactly what a tip-capping work plus the plan's own
    // padding adds, so nothing the plan places can leave the extent.
    expect(TOWN_DIMS.builtMargin).toBe(
      TOWN_DIMS.workTipOut + TOWN_DIMS.workPad + TOWN_DIMS.planPad,
    );
  });

  it("honours a DECLARED extent handed in (phase C derives it; the seat is here)", () => {
    const net = growStreets(7, "riverton", 2000, { extentM: 200 });
    let maxR = 0;
    for (const p of allPoints(net)) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
    expect(maxR).toBeLessThanOrEqual(200 - TOWN_DIMS.builtMargin);
  });
});

describe("§1.5/§1.6 the PLAN's own extent and centre", () => {
  const ECO = compileEconomy([{
    stockpiles: [{ key: "granary", max: 400, construction: true }],
    commodities: [{
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations",
        producers: ["farm"], market: true, stockColor: "#e0b25c",
        boxLabel: "Pantry", errandName: "shopping",
      },
    }],
    buildings: [{
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 },
    }],
  }], { construction: true });
  const bigTown = () => {
    const t = createTownWorld({
      economy: ECO, charter: { farmland: 420, ore_access: 0 },
      startPop: 400, seedScalars: { farms: 2 }, key: "wideburg",
    });
    t.step(260);
    return t;
  };

  it("a FULL town's radius stays inside the declared extent (the 495 > 450 defect)", () => {
    const plan = townPlan(bigTown(), ECO, "wideburg", 11);
    expect(plan.want).toBeGreaterThan(plan.built); // it really did run out of ground
    expect(plan.radius).toBeLessThanOrEqual(TOWN_DIMS.townRMax);
    // …and the radius is an honest OUTPUT: every building is inside it.
    for (const h of plan.houses) {
      expect(Math.hypot(h.dx + h.w / 2, h.dy + h.h / 2)).toBeLessThanOrEqual(plan.radius);
    }
    for (const w of plan.works) {
      expect(Math.hypot(w.dx + w.w / 2, w.dy + w.h / 2)).toBeLessThanOrEqual(plan.radius);
    }
  });

  it("the CENTRE is an output: the plaza is a junction, and the civic buildings front it", () => {
    const plan = townPlan(bigTown(), ECO, "wideburg", 11);
    const sq = plan.plaza!;
    expect(sq).toBeDefined();
    // It IS one of the network's junctions, not a decreed berth.
    const js = networkJunctions(plan.streets);
    expect(js.some(j => Math.hypot(j.x - sq.x, j.y - sq.y) < 1e-6)).toBe(true);
    // The hall and the plaza market stand on street frontage beside it…
    const hall = plan.works.find(w => w.type === "hall")!;
    const market = plan.works.find(w => w.type === "market")!;
    for (const w of [hall, market]) {
      expect(Math.hypot(w.dx + w.w / 2 - sq.x, w.dy + w.h / 2 - sq.y)).toBeLessThan(60);
    }
    // …and NO house was laid inside them.
    for (const h of plan.houses) {
      for (const w of [hall, market]) {
        const clash =
          h.dx < w.dx + w.w && h.dx + h.w > w.dx && h.dy < w.dy + w.h && h.dy + h.h > w.dy;
        expect({ house: h.index, clash }).toMatchObject({ clash: false });
      }
    }
  });

  it("the plaza STAYS PUT as the town grows (prefix stability at the civic rung)", () => {
    const town = bigTown();
    const small = townPlan(town, ECO, "wideburg", 11);
    const town2 = createTownWorld({
      economy: ECO, charter: { farmland: 420, ore_access: 0 },
      startPop: 400, seedScalars: { farms: 2 }, key: "wideburg",
    });
    town2.step(120); // a younger, smaller version of the same town
    const young = townPlan(town2, ECO, "wideburg", 11);
    expect(young.houses.length).toBeLessThan(small.houses.length);
    expect(young.plaza).toEqual(small.plaza);
  });
});

describe("§1.6 junctions — the accessibility nodes the centre comes from", () => {
  it("enumerates every attachment point with the streets that meet there", () => {
    const net = growStreets(7, "riverton", 300);
    const js = networkJunctions(net);
    expect(js.length).toBe(net.streets.length - 1); // one per non-root street, deduped
    for (const j of js) {
      expect(j.incident[0]).toBe(j.street);
      expect(j.incident.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("ranks junctions by the traffic on the streets that meet there", () => {
    const net = growStreets(7, "riverton", 300);
    // A synthetic load: everything rides street 0 (the baseline).
    const traffic = new Map<number, number>([[0, 100]]);
    const ranked = rankJunctions(net, traffic);
    expect(ranked[0]!.street).toBe(0);
    expect(ranked[0]!.traffic).toBe(100);
    // Ties break deterministically, so the centre never wanders.
    expect(JSON.stringify(rankJunctions(net, traffic))).toBe(JSON.stringify(ranked));
    // Loading one arterial instead moves the top junction onto it.
    const arterial = net.streets.find(s => s.gen === 0 && s.parent === 0)!;
    const top = rankJunctions(net, new Map([[arterial.id, 500]]))[0]!;
    expect(top.incident).toContain(arterial.id);
  });
});
