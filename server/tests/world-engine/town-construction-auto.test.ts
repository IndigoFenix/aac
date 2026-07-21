// AUTOMATIC EXPANSION (construction v1 §5, construction.ts constructionStep):
// households accrue PROSPERITY from adapter signals (the money-less proxy)
// and spend a full threshold on their next wanted annex — at most one build
// per town per day, center-out, deterministic. Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  PROSPERITY_DAILY_CAP,
  PROSPERITY_THRESHOLD,
  constructionStep,
  createTownDeltas,
  nextAnnexWant,
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

describe("constructionStep — prosperity accrual and the one-build day", () => {
  it("accrues capped prosperity, builds only past the threshold, one per day", () => {
    const deltas = createTownDeltas();
    const daysToBuild = Math.ceil(PROSPERITY_THRESHOLD / PROSPERITY_DAILY_CAP);
    let builtOn: number | null = null;
    for (let day = 1; day <= daysToBuild + 1; day++) {
      const orders = constructionStep(center, plan(), deltas, richHouse0, day);
      expect(orders.length).toBeLessThanOrEqual(1);
      if (orders.length && builtOn === null) builtOn = day;
    }
    expect(builtOn).toBe(daysToBuild);
    const d = deltas.get("h_0")!;
    expect(d.annexes).toHaveLength(1);
    // Spending subtracts the threshold — the remainder banks on.
    expect(d.prosperity!).toBeLessThan(PROSPERITY_THRESHOLD);
    // Idle houses banked nothing.
    expect(deltas.get("h_1")?.prosperity ?? 0).toBe(0);
  });

  it("is deterministic — two runs produce byte-identical overlays", () => {
    const a = createTownDeltas();
    const b = createTownDeltas();
    for (let day = 1; day <= 10; day++) {
      constructionStep(center, plan(), a, richHouse0, day);
      constructionStep(center, plan(), b, richHouse0, day);
    }
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });

  it("the annex answers the house's next WANT (unmet program first)", () => {
    const deltas = createTownDeltas();
    const h = plan().houses[0]!;
    const want = nextAnnexWant(houseRoomPlan(center, h));
    expect(want).not.toBeNull();
    for (let day = 1; day <= 8; day++) constructionStep(center, plan(), deltas, richHouse0, day);
    const d = deltas.get("h_0")!;
    expect(d.annexes[0]!.cluster).toBe(want);
    // The realized plan now carries the wanted room.
    const after = houseRoomPlan(center, h, d);
    expect(nextAnnexWant(after)).not.toBe(want);
  });

  it("growth is monotone — annex ordinals only append across days", () => {
    const deltas = createTownDeltas();
    let lastCount = 0;
    for (let day = 1; day <= 30; day++) {
      constructionStep(center, plan(), deltas, richHouse0, day);
      const n = deltas.get("h_0")?.annexes.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(lastCount);
      lastCount = n;
    }
    const ords = (deltas.get("h_0")?.annexes ?? []).map((a) => a.ord);
    expect([...ords].sort((x, y) => x - y)).toEqual(ords);
  });
});
