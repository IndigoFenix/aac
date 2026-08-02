// VISIBLE BUILD STAGES (⑦): construction is watched, not waited out. A
// designation is marked ground while its materials gather, gets a FLOOR the
// moment builders start, PILLARS halfway, and only then walls — and a
// demolition runs the very same ladder in reverse. These pin that the stage is
// a pure read of the labor the pipeline already banks (⑥ — builders make
// buildings): a site with nobody standing at it holds its stage exactly as it
// holds its labor. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  BUILD_PILLARS_AT,
  bankLabor,
  createTownDeltas,
  demolitionStage,
  foundedStage,
  laborFraction,
  pendingAnnexStage,
  type FoundedBuilding,
  type PendingAnnex,
} from "@shared/world-engine/kernel/town/construction.js";

const founded = (over: Partial<FoundedBuilding> = {}): FoundedBuilding => ({
  ord: 0, type: "house", slot: 1, dx: 0, dy: 0, w: 8, h: 6, door: "north",
  startedDay: 10, buildDays: 2,
  ...over,
});

const pending = (over: Partial<PendingAnnex> = {}): PendingAnnex => ({
  ord: 0,
  buildingKey: "h_1",
  cluster: "sleep",
  candidate: { side: "rear", u0: 0, u1: 3, v0: 0, v1: 3, doorAt: { u: 1, v: 0, width: 1 } } as PendingAnnex["candidate"],
  costs: { wood: 2 },
  pile: {},
  startedDay: 10,
  buildDays: 1,
  ...over,
});

describe("a building RISING", () => {
  it("is marked ground until its materials are staked — however long it waits", () => {
    // ⑥'s honesty: an unstaged plot never rises by the clock.
    const b = founded({ costs: { wood: 6 }, pile: {} });
    expect(foundedStage(b, 10)).toBe(0);
    expect(foundedStage(b, 999)).toBe(0);
  });

  it("lays the FLOOR the moment builders start, then raises PILLARS halfway", () => {
    const b = founded({ costs: { wood: 6 }, pile: { wood: 6 }, laborStartDay: 11 });
    expect(foundedStage(b, 11)).toBe(1); // staged, no labor banked yet
    bankLabor(b, b.buildDays * (BUILD_PILLARS_AT - 0.01));
    expect(foundedStage(b, 11)).toBe(1);
    bankLabor(b, b.buildDays * 0.02);
    expect(foundedStage(b, 11)).toBe(2);
  });

  it("reaches walls (3) only when the labor is worked off, and stays there once completed", () => {
    const b = founded({ costs: { wood: 6 }, pile: { wood: 6 }, laborStartDay: 11, labor: 2 });
    expect(foundedStage(b, 11)).toBe(3);
    expect(foundedStage(founded({ completed: true }), 0)).toBe(3);
  });

  it("reads its CLOCK on a legacy no-cost row (growth's collapsed twin)", () => {
    // Those rows bank no labor; a plot that never changed shape would be a
    // worse lie than an approximate one.
    const b = founded(); // startedDay 10, buildDays 2, no costs
    expect(foundedStage(b, 10)).toBe(1);
    expect(foundedStage(b, 11.2)).toBe(2);
    expect(foundedStage(b, 12)).toBe(3);
  });

  it("runs the same ladder one level down, for an annexed room", () => {
    const p = pending();
    expect(pendingAnnexStage(p)).toBe(0);
    p.laborStartDay = 10;
    expect(pendingAnnexStage(p)).toBe(1);
    bankLabor(p, 0.6);
    expect(pendingAnnexStage(p)).toBe(2);
    bankLabor(p, 0.4);
    expect(pendingAnnexStage(p)).toBe(3);
  });
});

describe("a room COMING DOWN", () => {
  it("keeps its walls until the work has really begun, then unbuilds in reverse", () => {
    const deltas = createTownDeltas();
    const p = deltas.postDemolitionSite({ buildingKey: "h_2", roomId: "h_2_r1", startedDay: 4, buildDays: 3 });
    expect(demolitionStage(p)).toBe(3); // walls still standing
    bankLabor(p, 1.2); // 40 %
    expect(demolitionStage(p)).toBe(2); // pillars
    bankLabor(p, 1); // ~73 %
    expect(demolitionStage(p)).toBe(1); // bare floor
    bankLabor(p, 1);
    expect(demolitionStage(p)).toBe(0); // gone
  });

  it("is the build ladder read backwards — the two agree on every step", () => {
    // Rising 0→1→2→3 and falling 3→2→1→0 use the same steps, so a demolition
    // reads as the film of a build played in reverse.
    const rising = [0, 0.25, 0.75, 1].map((f) =>
      foundedStage(founded({ costs: { wood: 1 }, pile: { wood: 1 }, laborStartDay: 1, labor: f * 2 }), 1),
    );
    expect(rising).toEqual([1, 1, 2, 3]);
    const falling = [0, 0.5, 0.8, 1].map((f) =>
      demolitionStage({ ord: 0, buildingKey: "h_1", roomId: "r", startedDay: 0, buildDays: 2, labor: f * 2 }),
    );
    expect(falling).toEqual([3, 2, 1, 0]);
  });
});

describe("laborFraction", () => {
  it("clamps to 0..1 and treats an instant job as done", () => {
    expect(laborFraction({ buildDays: 2, labor: -5 })).toBe(0);
    expect(laborFraction({ buildDays: 2 })).toBe(0);
    expect(laborFraction({ buildDays: 2, labor: 1 })).toBe(0.5);
    expect(laborFraction({ buildDays: 2, labor: 99 })).toBe(1);
    expect(laborFraction({ buildDays: 0 })).toBe(1);
  });
});
