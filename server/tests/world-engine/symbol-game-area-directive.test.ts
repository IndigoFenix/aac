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

// ── "area" IS ONE WORD WITH ONE MEANING — the ③ charter verb. It was briefly
// tempting to re-read "put + chair + AREA + table" as "near the table", since
// the board had no proximity word and composers improvised with the place word
// they had. The vocabulary was the bug, not the parser: `next_to` and `near`
// are speakable now (see the placement tests), so `area` keeps its one job.
// These assertions PIN that — the charter, the local area, and the harmless
// way a stray `area` composes inside a verb phrase.

describe("area keeps its single charter meaning wherever it appears", () => {
  it("the ③ charter parses and compiles unchanged", () => {
    for (const sentence of ["area + farm + here", "area + house + there", "area + farm"]) {
      const frame = parseSentence(sentence);
      expect(frame.verb).toBe("area");
      expect(frame.relation).toBeUndefined();
      expect(frame.bound).toBeUndefined();
    }
    const compiled = compile("area + farm + here");
    expect(compiled.kind).toBe("goal");
    if (compiled.kind === "goal") expect(compiled.goal).toEqual({ kind: "area", category: "farm" });
  });

  it("a BARE area still means the local area — never a spatial relation", () => {
    expect(compile("area").kind).toBe("unbound");
    const here = parseSentence("area + here");
    expect(here.verb).toBe("area");
    expect(here.relation).toBeUndefined();
  });

  it("area inside a put sentence binds NOTHING — the verb composition drops it", () => {
    // "you + put + chair + area + table": `put` wins the composition and its
    // implied "in" takes the trailing noun. `area` never becomes a relation.
    const frame = parseSentence("you + put + chair + area + table");
    expect(frame.verb).toBe("put");
    expect(frame.object).toEqual({ kind: "entity", symbol: "chair", modifiers: [] });
    expect(frame.target).toEqual({ kind: "entity", symbol: "table", modifiers: [] });
    expect(frame.relation).toBe("in");
    expect(frame.bound).toBeUndefined();
  });

  it('"area + none" still CLEARS, in a clause of its own', () => {
    const none = compile("area + none + here");
    expect(none.kind).toBe("goal");
    if (none.kind === "goal") expect(none.goal).toEqual({ kind: "area", category: null });
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
