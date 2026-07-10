// The living-sim goal chooser (goal-selection.ts): need→goal mapping, the weighted
// need-vs-rule contest with hard tiers, the lifetime/cooldown state machine, and the
// compileGoal world adapter. Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld } from "@shared/symbol-game/creatures.js";
import { makeRelation, DEFAULT_RELATION } from "@shared/symbol-game/relations.js";
import { makePersonality, personalityFromPreset } from "@shared/symbol-game/personality.js";
import type { Rule, RuleContext } from "@shared/symbol-game/rules.js";
import {
  compileGoal,
  DEFAULT_GOAL_SELECTION_CONFIG,
  freshRuntime,
  needToGoal,
  selectGoal,
  stepRuleLifetime,
  type RuleRuntime,
  type WorldResolver,
} from "@shared/symbol-game/goal-selection.js";

// A world: bear (optionally with a need) + player, an apple bear owns, an open window.
function world(bearNeeds: { itemId: string; value: number }[] = []) {
  return createCreatureWorld(
    [{ id: "bear", needs: bearNeeds }, { id: "player" }],
    [
      { id: "apple1", ownerId: "bear", kind: "apple", category: "food" },
      { id: "window1", device: true, states: ["open"], kind: "window" },
    ],
  );
}

function ctxFor(w = world(), tokens: string[] = ["night"], over: Partial<RuleContext> = {}): RuleContext {
  return { self: w.creatures.bear, world: w, worldConditions: new Set(tokens), ...over };
}

const goHomeRule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  author: "player",
  binding: { kind: "agent", id: "bear" },
  trigger: { kind: "worldState", token: "night" },
  lifetime: "while",
  action: { kind: "goHome" },
  enabled: true,
  order: 0,
  ...over,
});

describe("needToGoal — a creature pursues its own needs", () => {
  it("maps possession → fetch, presence → goTo, device → toggle", () => {
    expect(needToGoal({ itemId: "apple1", value: 3 })).toEqual({ kind: "fetch", item: { id: "apple1" } });
    expect(needToGoal({ itemId: "home", value: 3, atPlace: "home" })!.kind).toBe("goTo");
    expect(needToGoal({ itemId: "lamp", value: 3, deviceState: "on" })!.kind).toBe("toggle");
  });

  it("a loose (predicate) need fetches by match, not by id", () => {
    expect(needToGoal({ itemId: "x", value: 3, target: { category: "food" } })).toEqual({
      kind: "fetch",
      item: { match: { category: "food" } },
    });
  });
});

describe("selectGoal — the weighted contest (rules are not law)", () => {
  const runtimes = () => new Map<string, RuleRuntime>();

  it("a BONDED creature obeys 'when night go home' over idle", () => {
    const res = selectGoal({
      ctx: ctxFor(),
      rules: [goHomeRule()],
      relationTo: () => makeRelation({ affinity: 0.8, trust: 0.9, authority: 1 }),
      runtimes: runtimes(),
      now: 0,
    });
    expect(res.chosen?.goal).toEqual({ kind: "goHome" });
    expect(res.chosen?.source).toMatchObject({ kind: "rule", ruleId: "r1" });
  });

  it("a WILD creature ignores the same rule and pursues its own need", () => {
    const res = selectGoal({
      ctx: ctxFor(world([{ itemId: "apple1", value: 4 }]), ["night"], {
        personality: personalityFromPreset("wildcreature"),
      }),
      rules: [goHomeRule()],
      relationTo: () => DEFAULT_RELATION, // a stranger
      runtimes: runtimes(),
      now: 0,
    });
    expect(res.chosen?.source).toMatchObject({ kind: "need" });
  });

  it("a DRONE weighs a stranger's rule at FULL priority (obedience floor removes the penalty)", () => {
    // Same stranger, same rule: the wild creature's rule weight is negligible, the
    // drone's is the full priority (3) — so with a modest need (2) the drone obeys and
    // the wild one doesn't. Obedience maxes COMPLIANCE, not the rule's intrinsic priority.
    const opts = (preset: "drone" | "wildcreature") => ({
      ctx: ctxFor(world([{ itemId: "apple1", value: 2 }]), ["night"], {
        personality: personalityFromPreset(preset),
      }),
      rules: [goHomeRule({ priority: 3 })],
      relationTo: () => DEFAULT_RELATION, // a total stranger
      runtimes: runtimes(),
      now: 0,
    });
    expect(selectGoal(opts("drone")).chosen?.source).toMatchObject({ kind: "rule" });
    expect(selectGoal(opts("wildcreature")).chosen?.source).toMatchObject({ kind: "need" });
  });

  it("the rule drops out by day (while-condition false) → back to idle/needs", () => {
    const res = selectGoal({
      ctx: ctxFor(world(), ["day"]),
      rules: [goHomeRule()],
      relationTo: () => makeRelation({ authority: 1, trust: 1 }),
      runtimes: runtimes(),
      now: 0,
    });
    expect(res.chosen).toBeNull();
  });

  it("HARD TIER: an active conversation partner outranks any rule", () => {
    const res = selectGoal({
      ctx: ctxFor(),
      rules: [goHomeRule({ urgent: true })],
      relationTo: () => makeRelation({ authority: 1, trust: 1 }),
      runtimes: runtimes(),
      now: 0,
      activePartner: "player",
    });
    expect(res.chosen?.source).toMatchObject({ kind: "react", partner: "player" });
  });

  it("HARD TIER: a survival-level need wins outright over a strong rule", () => {
    const res = selectGoal({
      ctx: ctxFor(world([{ itemId: "apple1", value: 9 }]), ["night"]), // ≥ survivalValue 8
      rules: [goHomeRule({ priority: 100 })],
      relationTo: () => makeRelation({ authority: 1, trust: 1 }),
      runtimes: runtimes(),
      now: 0,
    });
    expect(res.chosen?.source).toMatchObject({ kind: "need" });
  });

  it("an URGENT rule outranks an ordinary need (still compliance-scaled)", () => {
    const res = selectGoal({
      ctx: ctxFor(world([{ itemId: "apple1", value: 4 }]), ["night"]),
      rules: [goHomeRule({ urgent: true })],
      relationTo: () => makeRelation({ affinity: 0.8, trust: 0.9, authority: 1 }),
      runtimes: runtimes(),
      now: 0,
    });
    expect(res.chosen?.source).toMatchObject({ kind: "rule", urgent: true });
  });
});

describe("stepRuleLifetime — while / edge / until", () => {
  const cfg = DEFAULT_GOAL_SELECTION_CONFIG;
  const rule = (lifetime: Rule["lifetime"]): Rule => goHomeRule({ lifetime });

  it("while — active exactly while the condition holds", () => {
    expect(stepRuleLifetime(rule("while"), freshRuntime(), true, 0, false, cfg).active).toBe(true);
    expect(stepRuleLifetime(rule("while"), freshRuntime(), false, 0, false, cfg).active).toBe(false);
  });

  it("edge — fires on the rising edge, latches, then cools down after goalDone", () => {
    let rt = freshRuntime();
    // condition false → armed, inactive
    ({ rt } = stepRuleLifetime(rule("edge"), rt, false, 0, false, cfg));
    expect(rt.armed).toBe(true);
    // rising edge → active
    let s = stepRuleLifetime(rule("edge"), rt, true, 1, false, cfg);
    expect(s.active).toBe(true);
    rt = s.rt;
    // still true, goal completes → disarm + cooldown, inactive
    s = stepRuleLifetime(rule("edge"), rt, true, 2, true, cfg);
    expect(s.active).toBe(false);
    rt = s.rt;
    // condition still true but already fired → stays inactive (no re-fire)
    expect(stepRuleLifetime(rule("edge"), rt, true, 3, false, cfg).active).toBe(false);
  });

  it("until — active until the condition becomes true, then self-removes", () => {
    let s = stepRuleLifetime(rule("until"), freshRuntime(), false, 0, false, cfg);
    expect(s.active).toBe(true); // stop-condition not yet met → keep going
    s = stepRuleLifetime(rule("until"), s.rt, true, 1, false, cfg);
    expect(s.active).toBe(false);
    expect(s.rt.removed).toBe(true);
    // removed stays removed
    expect(stepRuleLifetime(rule("until"), s.rt, false, 2, false, cfg).active).toBe(false);
  });
});

describe("compileGoal — the world adapter", () => {
  const resolver: WorldResolver = {
    positionOf: (id) => (id === "player" ? { x: 10, y: 0 } : { x: 0, y: 0 }),
    homeOf: () => ({ x: 5, y: 5 }),
    place: (p) => (p.kind === "home" ? { x: 5, y: 5 } : p.kind === "named" ? { x: 3, y: 3 } : { x: 0, y: 0 }),
    resolveItem: (ref) => ("id" in ref ? ref.id : "apple1"),
    itemPosition: (id) => (id === "apple1" ? { x: 2, y: 2 } : null),
    stationFor: () => ({ x: 7, y: 7 }),
  };

  it("goHome → a single moveTo the home point", () => {
    expect(compileGoal({ kind: "goHome" }, "bear", resolver)).toEqual({
      steps: [{ kind: "moveTo", pos: { x: 5, y: 5 } }],
    });
  });

  it("fetch → moveTo the item then pick it", () => {
    const plan = compileGoal({ kind: "fetch", item: { id: "apple1" } }, "bear", resolver);
    expect(plan?.steps).toEqual([
      { kind: "moveTo", pos: { x: 2, y: 2 } },
      { kind: "pick", itemId: "apple1" },
    ]);
  });

  it("toggle → moveTo the device then toggle it", () => {
    const plan = compileGoal({ kind: "toggle", device: { id: "apple1" }, state: "closed" }, "bear", resolver);
    expect(plan?.steps[1]).toEqual({ kind: "toggle", deviceId: "apple1", state: "closed" });
  });

  it("returns null when the target can't be resolved (world falls back to idle)", () => {
    const blind: WorldResolver = { ...resolver, itemPosition: () => null };
    expect(compileGoal({ kind: "fetch", item: { id: "apple1" } }, "bear", blind)).toBeNull();
  });

  it("build is not a body errand → null (civ-scope world order)", () => {
    expect(compileGoal({ kind: "build", structure: "house", cap: 1 }, "bear", resolver)).toBeNull();
  });
});
