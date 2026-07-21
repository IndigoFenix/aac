// The ONE shared mid-task-phase function (activity.ts): composes the SHOP schedule with an
// EAT schedule so "where is this creature mid-task" (spawn a shopper mid-trip OR a diner
// mid-meal) is answered in a single pure place. Time-only + deterministic. Pure.

import { describe, it, expect } from "@jest/globals";
import {
  creatureActivityAt,
  mealOffset,
  scheduledHunger,
  MEAL_SEC,
  MEAL_PERIOD_SEC,
  type ActivityCtx,
} from "@shared/world-engine/kernel/town/activity.js";
import type { HouseErrand } from "@shared/world-engine/kernel/town/goods.js";

const errand = (phase: HouseErrand["phase"]): HouseErrand => ({
  phase,
  pos: { x: 7, y: 7 },
  walkTo: phase === "home" ? null : [{ x: 1, y: 1 }],
  cycle: 0,
  source: { kind: "market", x: 3, y: 3 },
  home: { x: 0, y: 0 },
});

const table = { x: 10, y: 10 };
const homeSpot = { x: 5, y: 5 };
const ctx = (over: Partial<ActivityCtx>): ActivityCtx => ({
  shop: null,
  mealOff: 0,
  tablePos: table,
  homeSpot,
  t: 0,
  ...over,
});

describe("creatureActivityAt — an OUT shopping trip wins", () => {
  it("to_source/at_source/to_home → task SHOP, carrying the errand and its position", () => {
    for (const phase of ["to_source", "at_source", "to_home"] as const) {
      const a = creatureActivityAt(ctx({ shop: errand(phase) }));
      expect(a.task).toBe("shop");
      expect(a.phase).toBe(phase);
      expect(a.pos).toEqual({ x: 7, y: 7 });
      expect(a.errand).toBeTruthy();
    }
  });

  it("a HOME-phase shopper is NOT out — it falls through to eat/idle", () => {
    // At t=0 with offset 0, t lands inside the meal window → eating, not shopping.
    const a = creatureActivityAt(ctx({ shop: errand("home"), t: 0 }));
    expect(a.task).toBe("eat");
  });
});

describe("creatureActivityAt — the meal window puts a member AT THE TABLE", () => {
  it("inside the meal window → task EAT at the table, progress 0..1", () => {
    const a0 = creatureActivityAt(ctx({ t: 0 }));
    expect(a0).toMatchObject({ task: "eat", phase: "eating", pos: table });
    expect(a0.progress).toBeCloseTo(0, 5);
    const aMid = creatureActivityAt(ctx({ t: MEAL_SEC / 2 }));
    expect(aMid.progress).toBeCloseTo(0.5, 5);
  });

  it("outside the meal window → IDLE at the home spot", () => {
    const a = creatureActivityAt(ctx({ t: MEAL_SEC + 10 }));
    expect(a).toMatchObject({ task: "idle", phase: "home", pos: homeSpot });
  });

  it("the meal recurs once per period (staggered by the member offset)", () => {
    // Same phase one full period later.
    expect(creatureActivityAt(ctx({ t: 0 })).task).toBe("eat");
    expect(creatureActivityAt(ctx({ t: MEAL_PERIOD_SEC })).task).toBe("eat");
  });
});

describe("mealOffset — deterministic + staggered", () => {
  it("is stable per (seed, house, member) and within one period", () => {
    const a = mealOffset(7, 3, 1);
    expect(mealOffset(7, 3, 1)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(MEAL_PERIOD_SEC);
  });

  it("different members of a house usually get different offsets (they don't all eat at once)", () => {
    const offs = new Set([0, 1, 2, 3, 4].map((m) => Math.round(mealOffset(7, 3, m))));
    expect(offs.size).toBeGreaterThan(1);
  });
});

describe("scheduledHunger — a seed so the crowd isn't all at zero", () => {
  it("is ~0 during the meal window and climbs toward 1 before the next", () => {
    expect(scheduledHunger(0, 0)).toBeCloseTo(0, 5); // just eaten
    expect(scheduledHunger(0, MEAL_PERIOD_SEC - 1)).toBeGreaterThan(0.9); // about to eat
  });
});

describe("creatureActivityAt — a JOB shift claims the body (roster duty)", () => {
  // The street day and the meal period are the same clock (MEAL_PERIOD_SEC = FOOD_DAY_SEC).
  const day = MEAL_PERIOD_SEC;
  const job = { window: { start: 0.25, len: 0.4 }, workPos: { x: 20, y: 20 } };

  it("mid-shift -> task WORK at the workplace, progress through the window", () => {
    const t = (0.25 + 0.4 * 0.5) * day; // the middle of the shift
    const a = creatureActivityAt(ctx({ job, t }));
    expect(a).toMatchObject({ task: "work", phase: "working", pos: job.workPos });
    expect(a.progress).toBeCloseTo(0.5, 5);
  });

  it("an OUT shopping trip still outranks the shift (the body is already committed)", () => {
    const t = (0.25 + 0.1) * day;
    expect(creatureActivityAt(ctx({ job, t, shop: errand("to_source") })).task).toBe("shop");
  });

  it("outside the window -> falls through to meal/idle as before", () => {
    const t = 0.8 * day; // after the shift, outside the meal window (mealOff 0)
    expect(creatureActivityAt(ctx({ job, t })).task).toBe("idle");
    expect(creatureActivityAt(ctx({ job: null, t: (0.3) * day })).task).toBe("idle");
  });
});
