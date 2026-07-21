// Player-authored standing rules (rules.ts): condition evaluation, binding, and the
// compliance-weighted candidate that keeps rules from being law. Pure — safe in the
// default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import { makeRelation, DEFAULT_RELATION } from "@shared/world-engine/interaction/behavior/relations.js";
import { makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import {
  chooseCandidate,
  conditionHolds,
  DEFAULT_RULE_PRIORITY,
  ruleBinds,
  ruleCandidate,
  type Condition,
  type GoalCandidate,
  type Rule,
  type RuleContext,
} from "@shared/world-engine/interaction/behavior/rules.js";

function ctxFor(worldTokens: string[], opts: Partial<RuleContext> = {}): RuleContext {
  const world = createCreatureWorld(
    [{ id: "bear", condition: "hungry" }, { id: "player" }],
    [
      { id: "apple1", ownerId: "bear", kind: "apple", category: "food" },
      { id: "window1", device: true, states: ["open"], kind: "window" },
    ],
  );
  return {
    self: world.creatures.bear,
    world,
    worldConditions: new Set(worldTokens),
    ...opts,
  };
}

const goHome = (over: Partial<Rule> = {}): Rule => ({
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

describe("conditionHolds — pure predicates", () => {
  it("worldState reads the clock's token set", () => {
    expect(conditionHolds({ kind: "worldState", token: "night" }, ctxFor(["night"]))).toBe(true);
    expect(conditionHolds({ kind: "worldState", token: "night" }, ctxFor(["day"]))).toBe(false);
  });

  it("creatureState reads the creature's own condition", () => {
    expect(conditionHolds({ kind: "creatureState", state: "hungry" }, ctxFor([]))).toBe(true);
    expect(conditionHolds({ kind: "creatureState", state: "cold" }, ctxFor([]))).toBe(false);
  });

  it("possession matches by facet, have and have.not", () => {
    const ctx = ctxFor([]);
    const hasApple: Condition = { kind: "possession", item: { category: "food" }, have: true };
    const lacksToy: Condition = { kind: "possession", item: { kind: "toy" }, have: false };
    expect(conditionHolds(hasApple, ctx)).toBe(true);
    expect(conditionHolds(lacksToy, ctx)).toBe(true); // bear owns no toy → "lacks" holds
  });

  it("itemState matches an item carrying the state (the open window)", () => {
    expect(conditionHolds({ kind: "itemState", item: { kind: "window" }, state: "open" }, ctxFor([]))).toBe(true);
    expect(conditionHolds({ kind: "itemState", item: { kind: "window" }, state: "closed" }, ctxFor([]))).toBe(false);
  });

  it("presence/social fall to resolveExtra (false when absent)", () => {
    expect(conditionHolds({ kind: "presence", place: "home" }, ctxFor([]))).toBe(false);
    const ctx = ctxFor([], { resolveExtra: (c) => c.kind === "presence" });
    expect(conditionHolds({ kind: "presence", place: "home" }, ctx)).toBe(true);
  });
});

describe("ruleBinds — who obeys", () => {
  it("agent binds only its target", () => {
    expect(ruleBinds(goHome({ binding: { kind: "agent", id: "bear" } }), ctxFor([]))).toBe(true);
    expect(ruleBinds(goHome({ binding: { kind: "agent", id: "fox" } }), ctxFor([]))).toBe(false);
  });

  it("all binds everyone", () => {
    expect(ruleBinds(goHome({ binding: { kind: "all" } }), ctxFor([]))).toBe(true);
  });

  it("group binds by LIVE role membership (a new member inherits the law)", () => {
    const rule = goHome({ binding: { kind: "group", role: "farmer" } });
    expect(ruleBinds(rule, ctxFor([]))).toBe(false); // no roles resolver → no members
    const withRole = ctxFor([], { rolesOf: (id) => new Set(id === "bear" ? ["farmer"] : []) });
    expect(ruleBinds(rule, withRole)).toBe(true);
  });
});

describe("ruleCandidate — the compliance-weighted suggestion", () => {
  it("fires at full priority when the author has full compliance (self-authored)", () => {
    const selfRule = goHome({ author: "bear" });
    const cand = ruleCandidate(selfRule, ctxFor(["night"]), DEFAULT_RELATION);
    expect(cand?.weight).toBe(DEFAULT_RULE_PRIORITY);
  });

  it("scales weight by how the creature regards the author", () => {
    const rule = goHome();
    const trusted = ruleCandidate(rule, ctxFor(["night"]), makeRelation({ affinity: 0.7, trust: 0.8, authority: 0.9 }));
    const stranger = ruleCandidate(rule, ctxFor(["night"]), DEFAULT_RELATION);
    expect(trusted!.weight).toBeGreaterThan(stranger!.weight);
  });

  it("the SAME rule + relation weighs less on a stubborn creature (personality tilts it)", () => {
    const rule = goHome();
    const rel = makeRelation({ affinity: 0.4, trust: 0.6, authority: 0.7 });
    const stubborn = ruleCandidate(rule, ctxFor(["night"], { personality: makePersonality({ assertiveness: 1 }) }), rel);
    const neutral = ruleCandidate(rule, ctxFor(["night"]), rel);
    expect(stubborn!.weight).toBeLessThan(neutral!.weight);
  });

  it("returns null when the condition doesn't hold", () => {
    expect(ruleCandidate(goHome(), ctxFor(["day"]), DEFAULT_RELATION)).toBeNull();
  });

  it("returns null when disabled or unbound", () => {
    expect(ruleCandidate(goHome({ enabled: false }), ctxFor(["night"]), DEFAULT_RELATION)).toBeNull();
    expect(ruleCandidate(goHome({ binding: { kind: "agent", id: "fox" } }), ctxFor(["night"]), DEFAULT_RELATION)).toBeNull();
  });

  it("a near-zero-compliance creature yields a weak rule that its own needs can beat", () => {
    // Stranger's rule → tiny weight; a modest need (value 4) should outweigh it.
    const rule = goHome();
    const ruleCand = ruleCandidate(rule, ctxFor(["night"]), DEFAULT_RELATION)!;
    const needCand: GoalCandidate = {
      goal: { kind: "satisfy", need: "eat" },
      weight: 4,
      source: { kind: "need" },
    };
    expect(chooseCandidate([ruleCand, needCand])).toBe(needCand);
  });

  it("a well-regarded commander's rule beats a mild need", () => {
    const rule = goHome();
    const ruleCand = ruleCandidate(rule, ctxFor(["night"]), makeRelation({ affinity: 0.8, trust: 0.9, authority: 1 }))!;
    const needCand: GoalCandidate = {
      goal: { kind: "satisfy", need: "rest" },
      weight: 2,
      source: { kind: "need" },
    };
    expect(chooseCandidate([ruleCand, needCand])).toBe(ruleCand);
  });
});

describe("chooseCandidate — deterministic argmax", () => {
  it("picks highest weight; ties go to the earlier candidate", () => {
    const a: GoalCandidate = { goal: { kind: "goHome" }, weight: 3, source: { kind: "need" } };
    const b: GoalCandidate = { goal: { kind: "stay" }, weight: 3, source: { kind: "need" } };
    expect(chooseCandidate([a, b])).toBe(a);
    expect(chooseCandidate([])).toBeNull();
  });
});
