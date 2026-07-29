// TIMED DEMOLITION (the tear-down twin of annex staging), at the pure
// layer — ordering a room down is a DESIGNATION: a PendingDemolition row
// rides the deltas (no costs/pile — unbuilding needs hands, not
// materials), builders bank labor at the doomed room, and the actual
// demolishRoom (with its stow banking) commits only when the labor is
// worked off. The structure board never re-offers a room already spoken
// for by a pending demolition. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  annexOptions,
  bankLabor,
  createTownDeltas,
  demolishCheck,
  demolishRoom,
  demolitionLaborDone,
  requestAnnex,
} from "@shared/world-engine/kernel/town/construction.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { structureActsOf } from "@shared/world-engine/interaction/town/structure-board.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";

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

describe("pending demolitions (designation rows on the deltas)", () => {
  it("posts with monotone ordinals, banks labor, and is done only when worked off", () => {
    const deltas = createTownDeltas();
    const p = deltas.postDemolitionSite({
      buildingKey: "h_2",
      roomId: "h2_r1",
      startedDay: 1,
      buildDays: 0.25,
    });
    expect(p.ord).toBe(0);
    expect(deltas.postDemolitionSite({
      buildingKey: "h_3", roomId: "h3_r2", startedDay: 1, buildDays: 0.25,
    }).ord).toBe(1);
    // Nobody worked it — it never comes down on its own (the ⑥ law,
    // turned downward).
    expect(demolitionLaborDone(p)).toBe(false);
    bankLabor(p, 0.2);
    expect(demolitionLaborDone(p)).toBe(false);
    bankLabor(p, 0.05);
    expect(demolitionLaborDone(p)).toBe(true);
  });

  it("rides the toJSON round-trip mid-work; ordinals stay monotone across reload", () => {
    const deltas = createTownDeltas();
    const p = deltas.postDemolitionSite({
      buildingKey: "h_0", roomId: "h0_a0", startedDay: 3, buildDays: 0.25,
    });
    bankLabor(p, 0.1); // half-torn walls survive a reload
    deltas.removeDemolitionSite(
      deltas.postDemolitionSite({
        buildingKey: "h_1", roomId: "h1_r1", startedDay: 3, buildDays: 0.25,
      }).ord,
    );
    const back = createTownDeltas(deltas.toJSON());
    expect(back.demolitionSites()).toHaveLength(1);
    expect(back.demolitionSites()[0]).toEqual(p);
    expect(back.demolitionSites()[0]!.labor).toBe(0.1);
    // A removed ordinal is never reused downward — the next post stays
    // monotone over everything ever posted that still stands.
    const fresh = back.postDemolitionSite({
      buildingKey: "h_9", roomId: "h9_r1", startedDay: 4, buildDays: 0.25,
    });
    expect(fresh.ord).toBe(1);
  });

  it("removeDemolitionSite drops the row and bumps the version", () => {
    const deltas = createTownDeltas();
    const p = deltas.postDemolitionSite({
      buildingKey: "h_0", roomId: "h0_r1", startedDay: 0, buildDays: 0.25,
    });
    const v = deltas.version;
    deltas.removeDemolitionSite(p.ord);
    expect(deltas.demolitionSites()).toHaveLength(0);
    expect(deltas.version).toBeGreaterThan(v);
    deltas.removeDemolitionSite(p.ord); // idempotent — unknown ord no-ops
  });
});

/** A house with at least one kernel-demolishable room — scans the plan,
 *  and where the base rooms are all load-bearing, grows an annex first
 *  (an annex room always demolishes by spec removal). */
function demolishableHouse(play: ReturnType<typeof buildTownPlay>) {
  for (const house of play.plan.houses) {
    const key = `h_${house.index}`;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    if (plan.rooms.some((r) => demolishCheck(play.deltas, key, plan, r.id).ok)) {
      return { house, key, plan };
    }
  }
  for (const house of play.plan.houses) {
    const key = `h_${house.index}`;
    const plan = houseRoomPlan(play.stage.center, house, play.deltas.get(key));
    const c = annexOptions(
      play.stage.center, house, plan,
      neighborRectsOf(play, house.index), play.deltas.get(key), "sleep",
    )[0];
    if (!c) continue;
    expect(requestAnnex(play.deltas, key, c).ok).toBe(true);
    return { house, key, plan: houseRoomPlan(play.stage.center, house, play.deltas.get(key)) };
  }
  throw new Error("no demolishable room in any house — fixture assumption broke");
}

describe("the structure board and the commit, around a pending demolition", () => {
  it("a room a pending demolition targets leaves the demolish list (no dead re-press)", () => {
    const play = established();
    const { house, plan } = demolishableHouse(play);
    const base = {
      center: play.stage.center,
      house,
      plan,
      deltas: play.deltas,
      neighbors: neighborRectsOf(play, house.index),
      stock: {},
      furnStock: () => 0,
    };
    const before = structureActsOf(base);
    expect(before.demolish.length).toBeGreaterThan(0);
    const doomed = before.demolish[0]!;
    play.deltas.postDemolitionSite({
      buildingKey: `h_${house.index}`,
      roomId: doomed.id,
      startedDay: 0,
      buildDays: 0.25,
    });
    const after = structureActsOf(base);
    expect(after.demolish.map((r) => r.id)).not.toContain(doomed.id);
    // Every other offered room is untouched.
    expect(after.demolish.map((r) => r.id)).toEqual(
      before.demolish.slice(1).map((r) => r.id),
    );
  });

  it("the commit is the SAME kernel demolish the instant order ran — placed pieces stow", () => {
    const play = established();
    const { house, key, plan } = demolishableHouse(play);
    const room = plan.rooms.find((r) => demolishCheck(play.deltas, key, plan, r.id).ok)!;
    play.deltas.mutate(key, (d) => {
      d.placed.push({
        id: `furn_${house.index}_p0`, kind: "chair",
        x: room.rect.x + 1, y: room.rect.y + 1,
        radius: 0.4, facing: 0, openable: false, roomId: room.id,
      });
    });
    const p = play.deltas.postDemolitionSite({
      buildingKey: key, roomId: room.id, startedDay: 0, buildDays: 0.25,
    });
    bankLabor(p, p.buildDays);
    expect(demolitionLaborDone(p)).toBe(true);
    const res = demolishRoom(play.deltas, key, houseRoomPlan(play.stage.center, house, play.deltas.get(key)), room.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stowed.chair).toBe(1);
    play.deltas.removeDemolitionSite(p.ord);
    expect(play.deltas.demolitionSites()).toHaveLength(0);
  });
});
