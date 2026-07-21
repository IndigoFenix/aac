// THE AREA DIRECTIVE (city-expansion ③), language side: "area" is a
// LEXICON verb (the build V-factory pattern) — "area + farm + here"
// parses to a command and compiles to the { kind: "area" } GoalSpec the
// host writes as a charter; "area + none" clears; a bare "area" stays
// unbound (the explicit not-understood, never a silent guess). The goal
// is host-routed by design (compileGoal null, like build), never a body
// errand and never announced from the pool. Refusals are speakable with
// the category NAMED (zoneRefusalLine — "that's farmland"). No DOM / GL.
//
// The SPOKEN word is `area` (the registry's territory noun); the zoning
// KERNEL keeps its `zone` geometry names, hence zoneRefusalLine below.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import { compileGoal, type WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import { goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { zoneRefusalLine } from "@shared/world-engine/interaction/dialogue/placement-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const compile = (sentence: string) =>
  compileIntent(parseSentence(sentence), defaultBinder({ player: "__player__" }), { id: "t1" });

const nullResolver: WorldResolver = {
  positionOf: () => null,
  homeOf: () => null,
  place: () => null,
  resolveItem: () => null,
  itemPosition: () => null,
  stationFor: () => null,
};

describe('"area" parses + compiles as a directive verb', () => {
  it('"area + farm + here" → { kind: "area", category: "farm" }', () => {
    const frame = parseSentence("area + farm + here");
    expect(frame.kind).toBe("command");
    expect(frame.verb).toBe("area");
    const compiled = compile("area + farm + here");
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal).toEqual({ kind: "area", category: "farm" });
  });

  it('"area + house + there" carries the category; the AREA never rides the goal (the focus brush is the host\'s)', () => {
    const compiled = compile("area + house + there");
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal).toEqual({ kind: "area", category: "house" });
  });

  it('"area + none" (and a negated area) CLEARS — category null', () => {
    const none = compile("area + none + here");
    expect(none.kind).toBe("goal");
    if (none.kind === "goal") expect(none.goal).toEqual({ kind: "area", category: null });
    const negated = compile("area.not + farm");
    expect(negated.kind).toBe("goal");
    if (negated.kind === "goal") expect(negated.goal).toEqual({ kind: "area", category: null });
  });

  it("a bare \"area\" stays UNBOUND — the explicit not-understood, never a silent guess", () => {
    const compiled = compile("area");
    expect(compiled.kind).toBe("unbound");
  });
});

describe("the area goal is host-routed world policy", () => {
  it("compileGoal returns null (no body errand — the build pattern)", () => {
    const goal: GoalSpec = { kind: "area", category: "farm" };
    expect(compileGoal(goal, "resident_0_1", nullResolver)).toBeNull();
  });

  it("no intent announcement (host-instant, never pooled or claimed)", () => {
    const syms: IntentLineSyms = {
      item: () => "thing",
      place: () => "there",
      creature: (id) => id,
    };
    expect(goalIntentLine({ kind: "area", category: "farm" }, syms)).toBeNull();
  });
});

describe("the zoning refusal speaks with the category NAMED", () => {
  it('zoneRefusalLine("house", "farm") — "I can\'t put the house because the place is farm[land]"', () => {
    const line = zoneRefusalLine("house", "farm");
    expect(line.a).toBe("farm"); // level a: the blocking category itself
    expect(line.b).toContain("because");
    expect(line.b).toContain("farm");
    expect(line.c).toContain("put.not");
    expect(line.c).toContain("house");
    expect(line.c).toContain("place + farm");
  });
});
