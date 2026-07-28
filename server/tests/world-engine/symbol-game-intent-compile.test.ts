// IntentFrame → Rule/GoalSpec (intent-compile.ts): the bridge from the parsed frame to
// the action layer, binding lazy refs to world ids. Pure — safe in default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";

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

  it("if window.open shut → an EDGE rule toggling the device shut (state rides the head via `.`)", () => {
    const c = compile("if + window.open + shut"); // "window.open" = the open window (glyph modifier)
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.lifetime).toBe("edge");
    expect(c.rule.trigger).toEqual({ kind: "itemState", item: { kind: "window" }, state: "open" });
    // "shut [it]" — the action's implied object is the condition's window (anaphora).
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

  it("bare 'build' → a build order with the default settlement target (the FOUNDING seam)", () => {
    const c = compile("build");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "build", structure: "town", cap: 1 } });
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

  it("you follow i_me → a follow goal targeting the player (party recruit)", () => {
    const c = compile("you + follow + i_me");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "follow", target: "child" } });
  });

  it("you go there → goTo the gaze point when the world supplies it", () => {
    const withGaze = defaultBinder({ player: "child", listener: "bear", gazePlace: { kind: "point", x: 4, y: 9 } });
    const c = compile("you + go + there", withGaze);
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "goTo", place: { kind: "point", x: 4, y: 9 } } });
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

describe("round-2 verbs — drink/wash/tidy/sit/wake_up, throw-away, hug, help, carry", () => {
  it("bare self-care verbs compile to satisfy goals", () => {
    for (const [verb, need] of [
      ["you + drink", "drink"],
      ["you + wash", "wash"],
      ["you + brush_teeth", "brush_teeth"],
      ["you + tidy", "tidy"],
      ["you + sit", "sit"],
      ["you + wake_up", "wake_up"],
      ["you + wear", "wear"], // round 3 — the change-of-clothes command
    ] as const) {
      expect(compile(verb)).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need }, actor: "bear" });
    }
  });

  it("eat/drink WITH a named item CONSUME that item, never the abstract need", () => {
    // "you eat banana" must NOT silently drop the banana into the self-care
    // hunger need (which only household residents can serve) — it targets the
    // named food so the addressed creature actually goes and eats it.
    expect(compile("you + eat + banana")).toMatchObject({
      kind: "goal",
      goal: { kind: "consume", item: { match: { kind: "banana" } } },
    });
    expect(compile("you + drink + water")).toMatchObject({
      kind: "goal",
      goal: { kind: "consume", item: { match: { kind: "water" } } },
    });
    // A descriptor rides along ("eat the hot banana").
    expect(compile("you + eat + banana.hot")).toMatchObject({
      kind: "goal",
      goal: { kind: "consume", item: { match: { kind: "banana", descriptors: ["hot"] } } },
    });
    // BARE eat/drink still raise the founding motive.
    expect(compile("you + eat")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "eat" } });
  });

  it("color + item + colour → a color goal; the colour is the TARGET, not an item filter", () => {
    // "color the shirt red" recolours ANY shirt to red — the colour must NOT
    // restrict which shirt is found (else it would only match one already red).
    const c = compile("color + shirt.color_red");
    expect(c).toMatchObject({
      kind: "goal",
      goal: { kind: "color", item: { match: { kind: "shirt" } }, color: "color_red" },
    });
    if (c.kind === "goal" && c.goal.kind === "color") {
      // the colour is stripped from the item ref's descriptors (no `color_red`
      // filter), so a blue shirt is a valid target to recolour.
      expect((c.goal.item as { match?: { descriptors?: string[] } }).match?.descriptors ?? []).not.toContain("color_red");
    }
    // a color command with no colour named is not a color goal (unclear).
    expect(compile("color + shirt")).not.toMatchObject({ kind: "goal", goal: { kind: "color" } });
  });

  it("wash WITH an object stays a transform (the verb's other life)", () => {
    // `wash` is the ONLY verb that makes a thing clean now — `clean` is the state
    // it arrives at, not a second way to ask for it.
    expect(compile("wash + cup")).toMatchObject({
      kind: "goal",
      goal: { kind: "transform", item: { match: { kind: "cup" } }, state: "clean" },
    });
    expect(compile("wash + table")).toMatchObject({
      kind: "goal",
      goal: { kind: "transform", item: { match: { kind: "table" } }, state: "clean" },
    });
  });

  it("`clean` is a DESCRIPTOR, not an order", () => {
    // The bug this closes: a `{verb: "clean"}` frame spoke "I am clean" —
    // NEED_ACTIVITY had to route the scrub through `wash` to dodge it. Now the
    // word can only BE that reading: "you + clean" is the statement "you are
    // clean", a state frame with no verb, not a command that limps.
    const c = compile("you + clean");
    expect(c).toMatchObject({ kind: "dialogue" });
    expect((c as { frame: { kind: string; verb?: string } }).frame.kind).toBe("state");
    expect((c as { frame: { verb?: string } }).frame.verb).toBeUndefined();
  });

  it("throw with no destination → put it in the BIN (throwing away)", () => {
    expect(compile("throw + sock")).toMatchObject({
      kind: "goal",
      goal: { kind: "putIn", item: { match: { kind: "sock" } }, container: { kind: "named", id: "bin" } },
    });
  });

  it("carry is a fetch synonym", () => {
    expect(compile("carry + ball")).toMatchObject({
      kind: "goal",
      goal: { kind: "fetch", item: { match: { kind: "ball" } } },
    });
  });

  it("hug compiles to a socialAct aimed at the named creature", () => {
    expect(compile("hug + mara")).toMatchObject({
      kind: "goal",
      goal: { kind: "socialAct", target: "mara", act: "hug" },
    });
  });

  it("help compiles to an adoption order on the target", () => {
    expect(compile("help + dog")).toMatchObject({
      kind: "goal",
      goal: { kind: "help", target: "dog" },
    });
  });
});

describe("placement compilation (construction v1) — the relation is preserved", () => {
  const furn: IntentBinder = {
    ...defaultBinder({ player: "child", listener: "bear" }),
    isFurniture: (ref) => ref?.kind === "entity" && ["chair", "table", "bed"].includes(ref.symbol),
  };

  it("put chair near table → a place goal carrying the relation + anchor", () => {
    const c = compileIntent(parseSentence("put + chair + near + table"), furn, { id: "p1" });
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    expect(c.goal).toEqual({
      kind: "place",
      item: { match: { kind: "chair" } },
      at: { relation: "near", anchor: { kind: "named", id: "table" } },
    });
  });

  it("put apple in box stays the classic containment putIn (regression)", () => {
    const c = compileIntent(parseSentence("put + apple + in + box"), furn, { id: "p2" });
    expect(c).toMatchObject({
      kind: "goal",
      goal: { kind: "putIn", item: { match: { kind: "apple" } }, container: { kind: "named", id: "box" } },
    });
  });

  it("put ball near tree → even a non-furniture item PLACES beside a spatial anchor", () => {
    const c = compileIntent(parseSentence("put + ball + near + tree"), furn, { id: "p3" });
    expect(c).toMatchObject({
      kind: "goal",
      goal: { kind: "place", at: { relation: "near", anchor: { kind: "named", id: "tree" } } },
    });
  });

  it("put chair here → a point anchor reads as relation 'at' (the gaze spot)", () => {
    const b: IntentBinder = {
      ...defaultBinder({ player: "child", listener: "bear", gazePlace: { kind: "point", x: 3, y: 4 } }),
      isFurniture: furn.isFurniture!,
    };
    const c = compileIntent(parseSentence("put + chair + here"), b, { id: "p4" });
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    expect(c.goal).toMatchObject({
      kind: "place",
      at: { relation: "at", anchor: { kind: "point", x: 3, y: 4 } },
    });
  });

  it("without the isFurniture hook, put keeps its legacy containment shape", () => {
    const c = compile("put + chair + in + box");
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "putIn" } });
  });
});

// ── Verb × object-CATEGORY dispatch (language-expansion.md phase 2): household
// chores named by their category object route to the matching NEED TEMPLATE,
// never a one-item transform or a structure build.

describe("household chores — verb × category → satisfy", () => {
  it("wash + clothing → the LAUNDRY chore (not an item transform)", () => {
    expect(compile("you + wash + clothing")).toMatchObject({
      kind: "goal",
      goal: { kind: "satisfy", need: "laundry" },
      actor: "bear",
    });
  });

  it("wash and tidy are SEPARATE orders over the same room", () => {
    // `clean` used to be the verb for both, so the scrub and the put-away could
    // not be asked for apart. It is a descriptor now: washing a room runs the
    // `clean` sweep, tidying it runs the `tidy` chore.
    expect(compile("you + wash + home")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "clean" } });
    expect(compile("you + wash + house")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "clean" } });
    expect(compile("you + tidy + home")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "tidy" } });
    expect(compile("you + tidy + room")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "tidy" } });
    expect(compile("you + wash + clothing")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "laundry" } });
  });

  it("cook/make + food → the COOKING chore (never 'build a food structure')", () => {
    expect(compile("you + cook + food")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "cook" } });
    expect(compile("you + make + food")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "cook" } });
  });

  it("bare self-care verbs keep their old readings", () => {
    expect(compile("you + wash")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "wash" } });
    expect(compile("you + tidy")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "tidy" } });
    expect(compile("make + house")).toMatchObject({ kind: "goal", goal: { kind: "build", structure: "house" } });
  });
});

// MAKE vs BUILD (user law, 2026-07-28): the two verbs are INTERCHANGEABLE — both
// reach both kinds of goal, so a child who reaches for the wrong one still gets
// the thing — and differ only in PRIORITY: `make` tries the mobile item first,
// `build` the structure. A word that is only one of the two is reached by both.
describe("make vs build — interchangeable verbs, opposite priorities", () => {
  it("make + ANIMAL makes a TOY of that animal, never a building called 'rabbit'", () => {
    expect(compile("make + rabbit")).toMatchObject({
      kind: "goal",
      goal: { kind: "craft", glyph: "rabbit.toy.material_wood" },
    });
  });

  it("BUILD reaches the same toy — nothing named `rabbit` is a structure", () => {
    expect(compile("build + rabbit")).toMatchObject({
      kind: "goal",
      goal: { kind: "craft", glyph: "rabbit.toy.material_wood" },
    });
  });

  it("make + a structure word still BUILDS — the priority never blocks the other reading", () => {
    expect(compile("make + house")).toMatchObject({ kind: "goal", goal: { kind: "build", structure: "house" } });
    expect(compile("build + house")).toMatchObject({ kind: "goal", goal: { kind: "build", structure: "house" } });
  });

  it("an authored toy and a furniture piece both compile to a craft, either verb", () => {
    for (const verb of ["make", "build"]) {
      expect(compile(`${verb} + ball`)).toMatchObject({
        kind: "goal",
        goal: { kind: "craft", glyph: "ball.material_cloth" },
      });
      expect(compile(`${verb} + chair`)).toMatchObject({
        kind: "goal",
        goal: { kind: "craft", glyph: "furn.chair" },
      });
    }
  });

  it("the priority only decides a word that is BOTH — build wins it, make loses it", () => {
    // No word in the shipped vocabulary is both, so the tie is forced with a
    // binder that CLAIMS the word is structural (the scope-dependent catalog).
    const structural: IntentBinder = { ...binder, isStructure: () => true };
    expect(compile("build + ball", structural)).toMatchObject({
      kind: "goal",
      goal: { kind: "build", structure: "ball" },
    });
    // `make` keeps the mobile reading even when the word is also a structure —
    // that IS the priority.
    expect(compile("make + ball", structural)).toMatchObject({
      kind: "goal",
      goal: { kind: "craft", glyph: "ball.material_cloth" },
    });
  });

  it("bare 'make' stays unbound — only bare 'build' has a default (the founding seam)", () => {
    expect(compile("make")).not.toMatchObject({ kind: "goal" });
    expect(compile("build")).toMatchObject({ kind: "goal", goal: { kind: "build", structure: "town" } });
  });

  it("a category chore still wins over both readings", () => {
    expect(compile("you + make + food")).toMatchObject({ kind: "goal", goal: { kind: "satisfy", need: "cook" } });
  });
});

describe("phase + modal composition through the compiler", () => {
  it("stop + eat compiles to the halt, never a goal for the inner verb", () => {
    expect(compile("you + stop + eat")).toMatchObject({ kind: "goal", goal: { kind: "stay" } });
    expect(compile("stop + eat")).toMatchObject({ kind: "goal", goal: { kind: "stay" } });
  });

  it("want + play stays a conversational move (a desire, not an order)", () => {
    expect(compile("i_me + want + play")).toMatchObject({ kind: "dialogue" });
  });
});
