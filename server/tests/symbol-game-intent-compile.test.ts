// IntentFrame → Rule/GoalSpec (intent-compile.ts): the bridge from the parsed frame to
// the action layer, binding lazy refs to world ids. Pure — safe in default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/symbol-game/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/symbol-game/intent-compile.js";

// The child "child" speaks to the creature "bear"; "farmer" is a role.
const binder: IntentBinder = defaultBinder({ player: "child", listener: "bear", roles: ["farmers"] });
const compile = (s: string, b: IntentBinder = binder, id = "r1") =>
  compileIntent(parseSentence(s), b, { id });

describe("rule compilation — when/if/until → Rule", () => {
  it("when night go home → an agent rule the child authored", () => {
    const c = compile("when + night + go + home");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule).toMatchObject({
      author: "child",
      binding: { kind: "agent", id: "bear" },
      trigger: { kind: "worldState", token: "night" },
      lifetime: "while",
      action: { kind: "goHome" },
      enabled: true,
    });
    expect(c.rule.sourceGlyph).toContain("night");
  });

  it("farmers eat when hungry → a GROUP rule with a creatureState trigger", () => {
    const c = compile("farmers + eat + when + hungry");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.binding).toEqual({ kind: "group", role: "farmers" });
    expect(c.rule.trigger).toEqual({ kind: "creatureState", state: "hungry" });
    expect(c.rule.action).toEqual({ kind: "satisfy", need: "eat" });
  });

  it("if window.open close → an EDGE rule toggling the device shut (state rides the head via `.`)", () => {
    const c = compile("if + window.open + close"); // "window.open" = the open window (glyph modifier)
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.lifetime).toBe("edge");
    expect(c.rule.trigger).toEqual({ kind: "itemState", item: { kind: "window" }, state: "open" });
    // "close [it]" — the action's implied object is the condition's window (anaphora).
    expect(c.rule.action).toEqual({ kind: "toggle", device: { match: { kind: "window" } }, state: "closed" });
  });

  it("build house until town → an UNTIL rule with a capped build", () => {
    const c = compile("build + house + until + town");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.lifetime).toBe("until");
    expect(c.rule.action).toEqual({ kind: "build", structure: "house", cap: 1 });
    expect(c.rule.trigger).toEqual({ kind: "worldState", token: "town" });
  });
});

describe("command compilation — imperative → GoalSpec", () => {
  it("you go home → a goHome goal for the listener", () => {
    const c = compile("you + go + home");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "goHome" }, actor: "bear" });
  });

  it("go to market → goTo a named place", () => {
    const c = compile("go + to + market");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "goTo", place: { kind: "named", id: "market" } } });
  });

  it("give ball to bear → a give goal with a match item + recipient", () => {
    const c = compile("give + ball + to + bear");
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    expect(c.goal).toEqual({ kind: "give", item: { match: { kind: "ball" } }, to: "bear" });
  });

  it("descriptors ride into the item match (get ball.big)", () => {
    const c = compile("get + ball.big");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "fetch", item: { match: { kind: "ball", descriptors: ["big"] } } } });
  });
});

describe("conversational kinds pass through as dialogue (not goals)", () => {
  it("a request is a dialogue move, not an action", () => {
    expect(compile("i_me + want + ball").kind).toBe("dialogue");
  });
  it("a greeting and a question pass through too", () => {
    expect(compile("hi").kind).toBe("dialogue");
    expect(compile("where + ball").kind).toBe("dialogue");
  });
});

describe("sequence + binding fallbacks", () => {
  it("a sequence compiles each clause", () => {
    const c = compile("go + home + then + rest");
    expect(c.kind).toBe("sequence");
    if (c.kind !== "sequence") return;
    expect(c.items[0]).toMatchObject({ kind: "goal", goal: { kind: "goHome" } });
    expect(c.items[1]).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "rest" } });
  });

  it("a rule that can't bind its action reports unbound (no world for a gaze item)", () => {
    // "get this" — a gaze item with no gaze resolution → the fetch can't bind.
    const c = compile("get + this");
    expect(c.kind).toBe("unbound");
  });

  it("a gaze item resolves when the world supplies the fixation", () => {
    const withGaze = defaultBinder({ player: "child", listener: "bear", gazeItem: "apple7" });
    const c = compile("get + this", withGaze);
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "fetch", item: { id: "apple7" } } });
  });
});
