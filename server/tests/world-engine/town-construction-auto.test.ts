// AUTOMATIC EXPANSION (construction v1 §5, construction.ts constructionStep):
// households accrue PROSPERITY from adapter signals (the money-less proxy)
// and spend a full threshold on their next wanted annex — at most one build
// per town per day, center-out, deterministic.
//
// ⑥/⑦ AMENDMENT: the step DESIGNATES, it never raises the room. A building
// never rises by itself — the caller stakes the returned candidate as a
// pending annex, so the town's own growth waits on the same hauls and the
// same banked builder labor a player's order does. (It used to commit the
// annex on the spot, which is how a room appeared on a watched house with
// nobody standing anywhere near it.) Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  PROSPERITY_DAILY_CAP,
  PROSPERITY_THRESHOLD,
  constructionStep,
  createTownDeltas,
  nextAnnexWant,
  requestAnnex,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const mk = (index: number, dx: number, dy: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
  ({ index, dx, dy, w, h, door, color: "#a8875f", floors: 1 });
const plan = () => ({
  houses: [
    mk(0, -6, -5, 12, 10, "south"),
    mk(1, 40 - 4, -4, 8, 8, "north"),
    mk(2, 80 - 4.5, -4, 9, 8, "west"),
  ],
  works: [],
});

/** House 0 earns the cap daily; the others earn nothing. */
const richHouse0 = (houseIndex: number) =>
  houseIndex === 0 ? [{ key: "pantry", value: 99 }] : [];

/** The host's half, in miniature: an emitted order becomes a DESIGNATION
 *  (the builders raise it later), never a room. */
const stake = (deltas: TownDeltas, orders: ReturnType<typeof constructionStep>): void => {
  for (const o of orders) {
    deltas.postAnnexSite({
      buildingKey: o.buildingKey,
      cluster: o.action.cluster,
      candidate: o.action.candidate,
      costs: { wood: 2 },
      pile: {},
      startedDay: 0,
      buildDays: 0.5,
    });
  }
};

describe("constructionStep — prosperity accrual and the one-build day", () => {
  it("accrues capped prosperity, DESIGNATES only past the threshold, one per day", () => {
    const deltas = createTownDeltas();
    const daysToBuild = Math.ceil(PROSPERITY_THRESHOLD / PROSPERITY_DAILY_CAP);
    let builtOn: number | null = null;
    for (let day = 1; day <= daysToBuild + 1; day++) {
      const orders = constructionStep(center, plan(), deltas, richHouse0, day);
      expect(orders.length).toBeLessThanOrEqual(1);
      if (orders.length && builtOn === null) {
        builtOn = day;
        stake(deltas, orders);
      }
    }
    expect(builtOn).toBe(daysToBuild);
    // NOTHING WAS BUILT — the room is a pending designation waiting on hands.
    expect(deltas.get("h_0")?.annexes ?? []).toHaveLength(0);
    expect(deltas.annexSites()).toHaveLength(1);
    expect(deltas.annexSites()[0]!.buildingKey).toBe("h_0");
    // Spending subtracts the threshold — the remainder banks on.
    expect(deltas.get("h_0")!.prosperity!).toBeLessThan(PROSPERITY_THRESHOLD);
    // Idle houses banked nothing.
    expect(deltas.get("h_1")?.prosperity ?? 0).toBe(0);
  });

  it("never re-orders a house whose last designation is still being built", () => {
    // Without this the same house would stake a fresh annex every single day
    // while the first one is still gathering materials.
    const deltas = createTownDeltas();
    let orders = 0;
    for (let day = 1; day <= 40; day++) {
      const out = constructionStep(center, plan(), deltas, richHouse0, day);
      orders += out.length;
      stake(deltas, out); // staked and left pending — nobody ever builds it
    }
    expect(orders).toBe(1);
    expect(deltas.annexSites()).toHaveLength(1);
  });

  it("is deterministic — two runs produce byte-identical overlays", () => {
    const a = createTownDeltas();
    const b = createTownDeltas();
    for (let day = 1; day <= 10; day++) {
      stake(a, constructionStep(center, plan(), a, richHouse0, day));
      stake(b, constructionStep(center, plan(), b, richHouse0, day));
    }
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });

  it("the annex answers the house's next WANT (unmet program first)", () => {
    const deltas = createTownDeltas();
    const h = plan().houses[0]!;
    const want = nextAnnexWant(houseRoomPlan(center, h));
    expect(want).not.toBeNull();
    let ordered: ReturnType<typeof constructionStep>[number] | null = null;
    for (let day = 1; day <= 8 && !ordered; day++) {
      ordered = constructionStep(center, plan(), deltas, richHouse0, day)[0] ?? null;
    }
    expect(ordered!.action.cluster).toBe(want);
    // Once the builders finish it, the plan carries the wanted room.
    expect(requestAnnex(deltas, "h_0", ordered!.action.candidate).ok).toBe(true);
    const after = houseRoomPlan(center, h, deltas.get("h_0"));
    expect(nextAnnexWant(after)).not.toBe(want);
  });

  it("growth is monotone — annex ordinals only append across days", () => {
    // Each designation is raised the day it lands (the builders' half,
    // collapsed) so the house keeps differentiating.
    const deltas = createTownDeltas();
    let lastCount = 0;
    for (let day = 1; day <= 30; day++) {
      for (const o of constructionStep(center, plan(), deltas, richHouse0, day)) {
        requestAnnex(deltas, o.buildingKey, o.action.candidate);
      }
      const n = deltas.get("h_0")?.annexes.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(lastCount);
      lastCount = n;
    }
    expect(lastCount).toBeGreaterThan(0);
    const ords = (deltas.get("h_0")?.annexes ?? []).map((a) => a.ord);
    expect([...ords].sort((x, y) => x - y)).toEqual(ords);
  });
});
