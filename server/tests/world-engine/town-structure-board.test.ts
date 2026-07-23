// STRUCTURE-SCOPED CONTROLS (city-founding ③), at the pure layer — the
// exact pieces quest-host wires: the spirit ladder's focused-building frame
// resolves back to its plan lot (both providers hand sim-coords rects) →
// structureActsOf answers what THAT house can do right now (annex clusters
// with ground + materials, kernel-accepted demolitions, stored furniture) →
// demolishCheck is the no-mutation twin of demolishRoom (the board never
// shows a dead button) → the annex/demolish acts round-trip through the
// deltas. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  ANNEX_ORDER,
  ROOM_GLYPH,
  resolveStructureFocus,
  structureActsOf,
} from "@shared/world-engine/interaction/town/structure-board.js";
import {
  ANNEX_COSTS,
  createTownDeltas,
  annexOptions,
  demolishCheck,
  demolishRoom,
  requestAnnex,
} from "@shared/world-engine/kernel/town/construction.js";
import { ANNEX_ROOM_KIND, furnitureGlyph } from "@shared/world-engine/kernel/town/stations.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { costsMet, spendCosts } from "@shared/world-engine/kernel/town/structures.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

function established() {
  const play = buildTownPlay(CONFIG);
  expect(play.plan.houses.length).toBeGreaterThanOrEqual(6);
  return play;
}

function neighborRectsOf(play: ReturnType<typeof buildTownPlay>, index: number) {
  const c = play.stage.center;
  return [
    ...play.plan.houses
      .filter((h) => h.index !== index)
      .map((h) => ({ x: c.x + h.dx, y: c.y + h.dy, w: h.w, h: h.h })),
    ...play.plan.works.map((w) => ({ x: c.x + w.dx, y: c.y + w.dy, w: w.w, h: w.h })),
  ];
}

describe("resolveStructureFocus — the ladder's frame finds its plan lot", () => {
  const play = established();
  const c = play.stage.center;

  it("a house frame (center + dx/dy, exact w/h) resolves to that house", () => {
    const h = play.plan.houses[2]!;
    const focus = resolveStructureFocus(
      { x: c.x + h.dx, y: c.y + h.dy, w: h.w, h: h.h },
      c,
      play.plan,
    );
    expect(focus).toEqual({ kind: "house", index: h.index });
  });

  it("a work frame resolves to the work, never a house", () => {
    const w = play.plan.works[0]!;
    const focus = resolveStructureFocus(
      { x: c.x + w.dx, y: c.y + w.dy, w: w.w, h: w.h },
      c,
      play.plan,
    );
    expect(focus).toEqual({ kind: "work", index: 0 });
  });

  it("a frame over open ground resolves to nothing — town scope holds", () => {
    expect(
      resolveStructureFocus({ x: c.x + 4000, y: c.y + 4000, w: 9, h: 8 }, c, play.plan),
    ).toBeNull();
  });
});

describe("structureActsOf — what the focused house can DO right now", () => {
  it("annex clusters need ground AND materials; no wood ⇒ no annex words", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const plan = houseRoomPlan(play.stage.center, house, undefined);
    const base = {
      center: play.stage.center,
      house,
      plan,
      deltas: play.deltas,
      neighbors: neighborRectsOf(play, house.index),
      furnStock: () => 0,
    };
    const funded = structureActsOf({ ...base, stock: { wood: 5 } });
    expect(funded.annex.length).toBeGreaterThan(0);
    for (const cl of funded.annex) expect(ANNEX_ORDER).toContain(cl);
    const broke = structureActsOf({ ...base, stock: {} });
    expect(broke.annex).toEqual([]);
  });

  it("never lists the living room for demolition, and every listed room passes the kernel check", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const plan = houseRoomPlan(play.stage.center, house, undefined);
    const acts = structureActsOf({
      center: play.stage.center,
      house,
      plan,
      deltas: play.deltas,
      neighbors: neighborRectsOf(play, house.index),
      stock: {},
      furnStock: () => 0,
    });
    const living = plan.rooms[0]!;
    expect(acts.demolish.map((r) => r.id)).not.toContain(living.id);
    for (const r of acts.demolish) {
      expect(demolishCheck(play.deltas, `h_${house.index}`, plan, r.id).ok).toBe(true);
      expect(ROOM_GLYPH[r.kind]).toBeDefined();
    }
  });

  it("reads deltas without writing them (pure — no version bump, no empty-delta creation)", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const plan = houseRoomPlan(play.stage.center, house, undefined);
    const before = JSON.stringify(play.deltas.toJSON());
    const v = play.deltas.version;
    structureActsOf({
      center: play.stage.center,
      house,
      plan,
      deltas: play.deltas,
      neighbors: neighborRectsOf(play, house.index),
      stock: { wood: 5 },
      furnStock: () => 0,
    });
    expect(play.deltas.version).toBe(v);
    expect(JSON.stringify(play.deltas.toJSON())).toBe(before);
  });

  it("furnish words come from the house's own stacks", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const plan = houseRoomPlan(play.stage.center, house, undefined);
    const stacks: Record<string, number> = { [furnitureGlyph("chair")]: 1 };
    const acts = structureActsOf({
      center: play.stage.center,
      house,
      plan,
      deltas: play.deltas,
      neighbors: neighborRectsOf(play, house.index),
      stock: {},
      furnStock: (g) => stacks[g] ?? 0,
    });
    expect(acts.furnish).toEqual(["chair"]);
  });
});

describe("demolishCheck ⇔ demolishRoom parity (the no-dead-buttons pin)", () => {
  it("agrees with the mutating act on EVERY room of the plan", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const plan = houseRoomPlan(play.stage.center, house, undefined);
    for (const r of plan.rooms) {
      const check = demolishCheck(play.deltas, `h_${house.index}`, plan, r.id);
      const clone = createTownDeltas(play.deltas.toJSON());
      const act = demolishRoom(clone, `h_${house.index}`, plan, r.id);
      expect(act.ok).toBe(check.ok);
      if (!check.ok && !act.ok) expect(act.reason).toBe(check.reason);
    }
  });
});

describe("the annex act round-trips: order → room stands → break → room gone", () => {
  it("requestAnnex realizes the cluster's room; demolishing the annex shrinks back", () => {
    const play = established();
    const house = play.plan.houses[0]!;
    const key = `h_${house.index}`;
    const center = play.stage.center;
    const plan0 = houseRoomPlan(center, house, undefined);
    const neighbors = neighborRectsOf(play, house.index);

    // The board's affordability gate, then the exact order the host runs.
    const stock: Record<string, number> = { wood: 3 };
    expect(costsMet({ costs: { ...ANNEX_COSTS } }, stock)).toBe(true);
    const cluster = ANNEX_ORDER.find(
      (c) => annexOptions(center, house, plan0, neighbors, undefined, c).length > 0,
    )!;
    expect(cluster).toBeDefined();
    const candidate = annexOptions(center, house, plan0, neighbors, undefined, cluster)[0]!;
    expect(requestAnnex(play.deltas, key, candidate).ok).toBe(true);
    expect(spendCosts({ costs: { ...ANNEX_COSTS } }, stock)).toBe(true);
    expect(stock.wood).toBe(3 - (ANNEX_COSTS.wood ?? 0));

    const plan1 = houseRoomPlan(center, house, play.deltas.get(key));
    const annexRoom = plan1.rooms.find((r) => /_a0$/.test(r.id))!;
    expect(annexRoom).toBeDefined();
    expect(annexRoom.kind).toBe(ANNEX_ROOM_KIND[cluster]);

    // The annex's demolition is a spec removal — footprint shrinks back.
    const check = demolishCheck(play.deltas, key, plan1, annexRoom.id);
    expect(check).toEqual({ ok: true, into: null });
    const res = demolishRoom(play.deltas, key, plan1, annexRoom.id);
    expect(res.ok).toBe(true);
    expect(play.deltas.get(key)?.annexes ?? []).toHaveLength(0);
    const plan2 = houseRoomPlan(center, house, play.deltas.get(key));
    expect(plan2.rooms.map((r) => r.id)).toEqual(plan0.rooms.map((r) => r.id));
  });
});
