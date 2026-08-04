// RITUALS (rituals.ts): a social activity as culture data — declared, located,
// prepared for the heads actually coming, performed together. The decider is
// pure (no world coordinates, no clock), so everything here is roster, bill and
// deadline; what a body DOES at the place is its own need template's business.
import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_RITUALS,
  MEAL_RITUAL,
  PLAY_RITUAL,
  declareRitual,
  inRitualWindow,
  resolveRituals,
  ritualAnswer,
  ritualBill,
  ritualCallers,
  ritualJoiners,
  stepRitual,
  type RitualBody,
  type RitualCtx,
  type RitualTemplate,
} from "@shared/world-engine/interaction/behavior/rituals.js";

const body = (id: string, levels: Record<string, number>, extra: Partial<RitualBody> = {}): RitualBody => ({
  id,
  levels,
  eligible: true,
  ...extra,
});
const ctxOf = (bodies: RitualBody[], over: Partial<RitualCtx> = {}): RitualCtx => ({
  bodies,
  ready: 0,
  capacity: 4,
  dayF: 0.5,
  ...over,
});

const hungry = (id: string, extra: Partial<RitualBody> = {}) => body(id, { "hunger:food": 1 }, extra);
const lonely = (id: string, extra: Partial<RitualBody> = {}) => body(id, { social: 0.6 }, extra);

describe("the call — strong declares, weak only joins", () => {
  it("a strong call declares the ritual", () => {
    expect(ritualCallers(MEAL_RITUAL, ctxOf([hungry("a")]))).toEqual(["a"]);
  });
  it("a WEAK call alone never declares one (no window)", () => {
    expect(ritualCallers(MEAL_RITUAL, ctxOf([lonely("a")]))).toEqual([]);
  });
  it("but a weak call JOINS one already declared — the housemate who isn't hungry", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualJoiners(MEAL_RITUAL, live, ctxOf([hungry("a"), lonely("b")]))).toEqual(["b"]);
  });
  it("a body below every call level is neither caller nor joiner", () => {
    const cold = body("c", { "hunger:food": 0.3, social: 0.1 });
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualCallers(MEAL_RITUAL, ctxOf([cold]))).toEqual([]);
    expect(ritualJoiners(MEAL_RITUAL, live, ctxOf([hungry("a"), cold]))).toEqual([]);
  });
  it("INELIGIBLE bodies never take part — the pet whose hunger eats at its bowl", () => {
    const pet = hungry("pet", { eligible: false });
    expect(ritualCallers(MEAL_RITUAL, ctxOf([pet]))).toEqual([]);
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualJoiners(MEAL_RITUAL, live, ctxOf([hungry("a"), pet]))).toEqual([]);
  });
});

describe("the culture window — it LOWERS THE BAR, it never summons", () => {
  const supper: RitualTemplate = { ...MEAL_RITUAL, window: { from: 0.7, to: 0.9 } };
  it("outside the window only a strong call declares", () => {
    expect(ritualCallers(supper, ctxOf([lonely("a")], { dayF: 0.3 }))).toEqual([]);
    expect(ritualCallers(supper, ctxOf([hungry("a")], { dayF: 0.3 }))).toEqual(["a"]);
  });
  it("INSIDE it a weak call is enough — you come to the table because it is suppertime", () => {
    expect(ritualCallers(supper, ctxOf([lonely("a")], { dayF: 0.8 }))).toEqual(["a"]);
  });
  it("a window still never fires a ritual nobody has any call on", () => {
    const nobody = body("a", { "hunger:food": 0.1, social: 0.1 });
    expect(ritualCallers(supper, ctxOf([nobody], { dayF: 0.8 }))).toEqual([]);
  });
  it("a wrapping window spans midnight", () => {
    const night: RitualTemplate = { ...MEAL_RITUAL, window: { from: 0.9, to: 0.1 } };
    expect(inRitualWindow(night, 0.95)).toBe(true);
    expect(inRitualWindow(night, 0.05)).toBe(true);
    expect(inRitualWindow(night, 0.5)).toBe(false);
  });
  it("NO window means always — never 'never'", () => {
    expect(inRitualWindow(MEAL_RITUAL, 0)).toBe(true);
    expect(inRitualWindow(MEAL_RITUAL, 0.42)).toBe(true);
  });
});

describe("the roster and the bill", () => {
  it("the bill is per head — cook for who is coming, not for a cupboard", () => {
    expect(ritualBill(MEAL_RITUAL, 1)).toBe(1);
    expect(ritualBill(MEAL_RITUAL, 3)).toBe(3);
  });
  it("a ritual with nothing to prepare bills nothing", () => {
    expect(ritualBill(PLAY_RITUAL, 4)).toBe(0);
  });
  it("recruiting RESIZES the bill — a joiner gets a portion cooked", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(live.bill).toBe(1);
    const step = stepRitual(MEAL_RITUAL, live, ctxOf([hungry("a"), hungry("b")]), 1);
    expect(step.joined).toEqual(["b"]);
    expect(step.next?.heads).toEqual(["a", "b"]);
    expect(step.next?.bill).toBe(2);
  });
  it("the roster stops at maxHeads", () => {
    const tpl = { ...MEAL_RITUAL, maxHeads: 2 };
    const live = declareRitual(tpl, "table", "a");
    const step = stepRitual(tpl, live, ctxOf([hungry("a"), hungry("b"), hungry("c")]), 1);
    expect(step.next?.heads).toEqual(["a", "b"]);
  });
  it("and at the STATION CAPACITY — a table with two chairs seats two", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    const step = stepRitual(MEAL_RITUAL, live, ctxOf([hungry("a"), hungry("b"), hungry("c")], { capacity: 2 }), 1);
    expect(step.next?.heads).toEqual(["a", "b"]);
  });
});

describe("gather → perform", () => {
  it("waits while the food isn't ready, even with everyone seated", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    const step = stepRitual(MEAL_RITUAL, live, ctxOf([hungry("a", { seated: true })], { ready: 0 }), 1);
    expect(step.next?.phase).toBe("gather");
    expect(step.completed).toEqual([]);
  });
  it("waits while a head is still walking, even with the table laid", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a"), heads: ["a", "b"], bill: 2 };
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { seated: false })], { ready: 2 });
    expect(stepRitual(MEAL_RITUAL, live, ctx, 1).next?.phase).toBe("gather");
  });
  it("STARTS when the bill is met and every head is seated", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a"), heads: ["a", "b"], bill: 2 };
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { seated: true })], { ready: 2 });
    const step = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(step.next?.phase).toBe("perform");
    expect(step.next?.phaseT).toBe(0);
  });
  it("a lone head still lays a place and eats — minHeads 1 is 'may be performed alone'", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    const ctx = ctxOf([hungry("a", { seated: true })], { ready: 1 });
    expect(stepRitual(MEAL_RITUAL, live, ctx, 1).next?.phase).toBe("perform");
  });
  it("minHeads 2 refuses to start solo — some things you cannot do alone", () => {
    const tpl = { ...MEAL_RITUAL, minHeads: 2 };
    const live = declareRitual(tpl, "table", "a");
    const ctx = ctxOf([hungry("a", { seated: true })], { ready: 4 });
    expect(stepRitual(tpl, live, ctx, 1).next?.phase).toBe("gather");
  });
});

describe("THE DEADLINE — one slow housemate must never starve the table", () => {
  const twoHeads = () => ({ ...declareRitual(MEAL_RITUAL, "table", "a"), heads: ["a", "b"], bill: 2 });
  it("starts with whoever is actually seated once gatherS lapses", () => {
    const live = { ...twoHeads(), phaseT: MEAL_RITUAL.gatherS };
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { seated: false })], { ready: 2 });
    const step = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(step.next?.phase).toBe("perform");
    expect(step.next?.heads).toEqual(["a"]);
    expect(step.left).toContain("b");
  });
  it("feeds only as many as the portions that ARRIVED — two of three still eat", () => {
    const live = { ...twoHeads(), heads: ["a", "b", "c"], bill: 3, phaseT: MEAL_RITUAL.gatherS };
    const ctx = ctxOf(
      [hungry("a", { seated: true }), hungry("b", { seated: true }), hungry("c", { seated: true })],
      { ready: 2 },
    );
    const step = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(step.next?.heads).toEqual(["a", "b"]);
    expect(step.next?.bill).toBe(2);
    expect(step.left).toEqual(["c"]);
  });
  it("RETIRES when the deadline finds nothing prepared — never wedges waiting", () => {
    const live = { ...twoHeads(), phaseT: MEAL_RITUAL.gatherS };
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { seated: true })], { ready: 0 });
    const step = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(step.next).toBeNull();
    expect(step.completed).toEqual([]);
    expect(step.left).toEqual(expect.arrayContaining(["a", "b"]));
  });
  it("a ritual with nothing to prepare starts on its heads alone", () => {
    const live = { ...declareRitual(PLAY_RITUAL, "ball_1", "a"), phaseT: PLAY_RITUAL.gatherS };
    const step = stepRitual(PLAY_RITUAL, live, ctxOf([body("a", { fun: 1 }, { seated: true })]), 1);
    expect(step.next?.phase).toBe("perform");
  });
});

describe("performing, and leaving", () => {
  const performing = (heads: string[]) => ({
    key: "meal",
    placeId: "table",
    heads,
    phase: "perform" as const,
    bill: heads.length,
    phaseT: 0,
  });
  it("runs for performS, then COMPLETES its heads — their relieved meters clear", () => {
    const live = performing(["a", "b"]);
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { seated: true })]);
    expect(stepRitual(MEAL_RITUAL, live, ctx, 1).completed).toEqual([]);
    const done = stepRitual(MEAL_RITUAL, { ...live, phaseT: MEAL_RITUAL.performS }, ctx, 1);
    expect(done.next).toBeNull();
    expect(done.completed).toEqual(["a", "b"]);
  });
  it("a body that walked out mid-meal gets NO relief", () => {
    const live = { ...performing(["a", "b"]), phaseT: MEAL_RITUAL.performS };
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { eligible: false })]);
    const done = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(done.completed).toEqual(["a"]);
    expect(done.left).toEqual(["b"]);
  });
  it("a head that leaves during the GATHER shrinks the roster and the bill", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a"), heads: ["a", "b"], bill: 2 };
    const ctx = ctxOf([hungry("a"), hungry("b", { eligible: false })]);
    const step = stepRitual(MEAL_RITUAL, live, ctx, 1);
    expect(step.next?.heads).toEqual(["a"]);
    expect(step.next?.bill).toBe(1);
    expect(step.left).toEqual(["b"]);
  });
  it("losing the last head retires it — no empty ritual holding a table", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a") };
    const step = stepRitual(MEAL_RITUAL, live, ctxOf([hungry("a", { eligible: false })]), 1);
    expect(step.next).toBeNull();
  });
  it("dropping below minHeads mid-performance retires it", () => {
    const tpl = { ...MEAL_RITUAL, minHeads: 2 };
    const live = performing(["a", "b"]);
    const ctx = ctxOf([hungry("a", { seated: true }), hungry("b", { eligible: false })]);
    const step = stepRitual(tpl, live, ctx, 1);
    expect(step.next).toBeNull();
    expect(step.completed).toEqual([]);
  });
});

describe("the culture table", () => {
  it("ships a meal and a play ritual", () => {
    expect(DEFAULT_RITUALS.map((r) => r.key)).toEqual(["meal", "play"]);
  });
  it("no declaration = the kernel defaults", () => {
    expect(resolveRituals().map((r) => r.key)).toEqual(["meal", "play"]);
    expect(resolveRituals(null).map((r) => r.key)).toEqual(["meal", "play"]);
  });
  it("an authored row REPLACES a same-key default IN PLACE (order is meaning)", () => {
    const mine: RitualTemplate = { ...MEAL_RITUAL, gatherS: 99, window: { from: 0.7, to: 0.9 } };
    const out = resolveRituals([mine]);
    expect(out.map((r) => r.key)).toEqual(["meal", "play"]);
    expect(out[0]!.gatherS).toBe(99);
    expect(out[0]!.window).toEqual({ from: 0.7, to: 0.9 });
  });
  it("a new key APPENDS", () => {
    const dance: RitualTemplate = { ...PLAY_RITUAL, key: "dance" };
    expect(resolveRituals([dance]).map((r) => r.key)).toEqual(["meal", "play", "dance"]);
  });
  it("resolving never mutates the defaults", () => {
    resolveRituals([{ ...MEAL_RITUAL, gatherS: 1 }]);
    expect(MEAL_RITUAL.gatherS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// INVITATIONS — group activity syntax (planning-docs/games/world-engine/group-activity-syntax.md)
// ---------------------------------------------------------------------------
// An invitation introduces no new action and no new phase. It is a PER-BODY
// WINDOW: the same bar-lowering a culture's mealtime does for everyone, scoped
// to one body for one gathering.

describe("an invitation is a per-body window", () => {
  it("lets a WEAK call declare — the housemate who was asked along", () => {
    expect(ritualCallers(MEAL_RITUAL, ctxOf([lonely("a")]))).toEqual([]);
    expect(ritualCallers(MEAL_RITUAL, ctxOf([lonely("a", { invited: true })]))).toEqual(["a"]);
  });

  it("does NOT let a body with no call at all declare one out of nothing", () => {
    const cold = body("c", { "hunger:food": 0.1, social: 0.1 }, { invited: true });
    expect(ritualCallers(MEAL_RITUAL, ctxOf([cold]))).toEqual([]);
  });

  it("is never a summons: an INELIGIBLE body stays out however it was asked", () => {
    const pet = hungry("pet", { eligible: false, invited: true });
    expect(ritualCallers(MEAL_RITUAL, ctxOf([pet]))).toEqual([]);
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualJoiners(MEAL_RITUAL, live, ctxOf([hungry("a"), pet]))).toEqual([]);
  });

  it("lets a body with NO call JOIN — 'I'm not hungry, but I'll sit with you'", () => {
    const cold = body("b", { "hunger:food": 0, social: 0 });
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    const heads = ctxOf([hungry("a"), cold]);
    expect(ritualJoiners(MEAL_RITUAL, live, heads)).toEqual([]);
    const asked = ctxOf([hungry("a"), { ...cold, invited: true }]);
    expect(ritualJoiners(MEAL_RITUAL, live, asked)).toEqual(["b"]);
  });

  it("still obeys the roster bounds — an invitation cannot overfill a table", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a"), heads: ["a", "b"] };
    const asked = body("c", {}, { invited: true });
    expect(ritualJoiners(MEAL_RITUAL, live, ctxOf([asked], { capacity: 2 }))).toEqual([]);
  });
});

describe("ritualAnswer — one decision, spoken and acted on alike", () => {
  const asked = (id: string, levels: Record<string, number> = {}) => body(id, levels, { invited: true });

  it("CALLS one when there is none and the bar is cleared", () => {
    expect(ritualAnswer(MEAL_RITUAL, hungry("a"), null, ctxOf([hungry("a")]))).toBe("call");
    expect(ritualAnswer(MEAL_RITUAL, asked("a", { social: 0.6 }), null, ctxOf([]))).toBe("call");
  });

  it("DECLINES when there is nowhere to gather", () => {
    expect(ritualAnswer(MEAL_RITUAL, hungry("a"), null, ctxOf([], { capacity: 0 }))).toBe("decline");
  });

  it("JOINS one already gathering", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualAnswer(MEAL_RITUAL, asked("b"), live, ctxOf([hungry("a")]))).toBe("join");
  });

  it("a body already on the roster answers JOIN — it is already coming", () => {
    const live = declareRitual(MEAL_RITUAL, "table", "a");
    expect(ritualAnswer(MEAL_RITUAL, hungry("a"), live, ctxOf([hungry("a")]))).toBe("join");
  });

  it("DECLINES once the performance has begun — late means the next one", () => {
    const live = { ...declareRitual(MEAL_RITUAL, "table", "a"), phase: "perform" as const };
    expect(ritualAnswer(MEAL_RITUAL, asked("b"), live, ctxOf([hungry("a")]))).toBe("decline");
  });

  it("DECLINES when the roster is full", () => {
    const live = { ...declareRitual(PLAY_RITUAL, "toy", "a"), heads: ["a", "b", "c", "d"] };
    expect(ritualAnswer(PLAY_RITUAL, asked("e"), live, ctxOf([]))).toBe("decline");
  });

  it("DECLINES an ineligible body — the answer and the attendance agree", () => {
    const pet = body("pet", { "hunger:food": 1 }, { invited: true, eligible: false });
    expect(ritualAnswer(MEAL_RITUAL, pet, null, ctxOf([pet]))).toBe("decline");
  });
});
