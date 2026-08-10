// REST AT A STATION, and the give family's third word (build order L3b + L8).
//
// A posture verb that NAMES where the body settles is an order about THAT
// fixture: "sit on the chair" / "sleep in the bed" / "rest at the bench" all
// compile to `rest` (rules.ts:146 — walk to the station, occupy it, dwell there
// posed), where they used to compile to a bare `satisfy` that dropped the one
// word the child chose. Bare, the same verbs are still the self-need, and
// COMPANY still outranks the station ("sleep together" is a shared need — the
// only goal shape that carries a companion).
//
// L8: `share` joins give/bring — one frame, one primitive, and the sentence
// stops answering "I don't understand". `teach` deliberately stays unbound: no
// goal in the closed set means it, and this engine never guesses. (`show` was
// unbound here too until L11 gave it one — an ATTENTION act on `socialAct`,
// pinned in `show-item.test.ts`; the pin below moved with it.)
//
// Pure — no DOM/GL/DB.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  asIntent,
  commandEcho,
  goalIntentLine,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// A classifier-backed binder, like the host's: bodies bind on the creature
// channel, furniture and rooms on the place channel. The kind-blind
// `defaultBinder` reads EVERY name as a creature, which is exactly why the
// station reading needs a classifier to be seen apart from a companion.
const CREATURES = new Set(["mara", "bear", "dog"]);
const PLACES = new Set(["bed", "chair", "bench", "box", "bedroom", "tree", "table"]);
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  CREATURES.has(sym) ? "creature" : PLACES.has(sym) ? "place" : "item";
const makeBinder = (): IntentBinder => {
  const b = defaultBinder({ player: "child", listener: "bear" });
  const inner = b.creature.bind(b);
  b.creature = (ref) => (ref?.kind === "entity" && !CREATURES.has(ref.symbol) ? null : inner(ref));
  return b;
};

const compile = (sentence: string, binder: IntentBinder = makeBinder()) =>
  compileIntent(parseSentence(sentence, { classifyEntity: classify }), binder, { id: "t1" });

const goalOf = (sentence: string, binder?: IntentBinder): GoalSpec => {
  const c = compile(sentence, binder);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error(`not a goal: ${sentence}`);
  return c.goal;
};

describe("a NAMED station makes a posture verb a `rest`", () => {
  it("'sleep + in + bed' rests AT the bed — the station is not dropped", () => {
    expect(goalOf("you + sleep + in + bed")).toEqual({
      kind: "rest",
      place: { kind: "named", id: "bed" },
    });
  });

  it("'sit + on + chair' rests at the chair (the relation binds the target)", () => {
    expect(goalOf("sit + on + chair")).toEqual({
      kind: "rest",
      place: { kind: "named", id: "chair" },
    });
  });

  it("a BARE second noun is the station too — 'rest + bed', 'sit + chair'", () => {
    // No relation word: the parser hands the fixture over as the OBJECT, and a
    // posture verb's object is where it settles, never a thing it acts on.
    expect(goalOf("rest + bed")).toEqual({ kind: "rest", place: { kind: "named", id: "bed" } });
    expect(goalOf("you + sit + chair")).toEqual({
      kind: "rest",
      place: { kind: "named", id: "chair" },
    });
  });

  it("every LOCATIVE names a station, not just in/on", () => {
    expect(goalOf("you + sleep + under + tree")).toEqual({
      kind: "rest",
      place: { kind: "named", id: "tree" },
    });
    expect(goalOf("you + sit + near + table")).toEqual({
      kind: "rest",
      place: { kind: "named", id: "table" },
    });
  });

  it("the goal carries NO pose and NO dwellS — the fixture and the command default say those", () => {
    // `pose` only OVERRIDES the executor's fixture-derived reading (a bed
    // sleeps, a box plays, else sit), and a spoken order knows less about the
    // furniture than the executor does. The exact-equality pins above are the
    // real guard; this states the law it is guarding.
    const goal = goalOf("you + sleep + in + bed");
    expect(goal).not.toHaveProperty("pose");
    expect(goal).not.toHaveProperty("dwellS");
  });

  it("the addressed creature is the actor", () => {
    const c = compile("you + sleep + in + bed");
    expect(c).toMatchObject({ kind: "goal", actor: "bear" });
  });

  it("a NAMED BODY is a station too — its own spot ('sit next to Mara')", () => {
    // PlaceRef's `creature` kind IS "where that body is", and creature-first is
    // how every other endpoint in the compiler resolves a name (take FROM the
    // dog names the dog's hands). So the least surprising reading of "sit next
    // to Mara" is: go to Mara and settle there.
    expect(goalOf("you + sit + next_to + mara")).toEqual({
      kind: "rest",
      place: { kind: "creature", id: "mara" },
    });
  });
});

describe("bare posture verbs are UNCHANGED — still the self-need", () => {
  it("'you + sleep' / 'you + sit' / 'you + rest' compile to satisfy, exactly as before", () => {
    for (const [sentence, need] of [
      ["you + sleep", "sleep"],
      ["you + sit", "sit"],
      ["you + rest", "rest"],
    ] as const) {
      expect(goalOf(sentence)).toEqual({ kind: "satisfy", need });
    }
  });

  it("a kind-blind binder does not invent a station out of nothing", () => {
    // The plain defaultBinder (no classifier) still leaves a bare verb bare —
    // the station reading needs a NAMED word, not a permissive binder.
    expect(goalOf("you + sleep", defaultBinder({ player: "child", listener: "bear" }))).toEqual({
      kind: "satisfy",
      need: "sleep",
    });
  });
});

describe("COMPANY outranks the station — a shared act stays a shared satisfy", () => {
  it("'sleep + together' is the group need (a rest carries no companion)", () => {
    expect(goalOf("sleep + together")).toEqual({
      kind: "satisfy",
      need: "sleep",
      with: { kind: "group" },
    });
  });

  it("'sleep + with + mara' names the companion — `with` is never a place", () => {
    expect(goalOf("you + sleep + with + mara")).toEqual({
      kind: "satisfy",
      need: "sleep",
      with: { kind: "creatures", ids: ["mara"] },
    });
  });

  it("station AND company → the shared need, because only it can serve the person", () => {
    // "sleep in the bed with Mara": `rest` has no companion field, so compiling
    // this to a rest would silently drop Mara. Losing the named body is the
    // worse loss, and the gathering machinery can still find a bed.
    expect(goalOf("sleep + in + bed + with + mara")).toEqual({
      kind: "satisfy",
      need: "sleep",
      with: { kind: "creatures", ids: ["mara"] },
    });
  });
});

describe("a rule's anaphora never borrows a station", () => {
  it("'when + night + sleep' stays a bedtime rule, not a sleep AT the night", () => {
    // The condition's entity is borrowed as the action's object for TRANSITIVE
    // verbs ("if window.open, shut [it]"). A posture verb is complete bare, so
    // the borrow is skipped — otherwise "night" would have read as the station.
    const c = compile("when + night + sleep");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.trigger).toEqual({ kind: "worldState", token: "night" });
    expect(c.rule.action).toEqual({ kind: "satisfy", need: "sleep" });
  });

  it("a rule CAN still install a station rest when the sentence names one", () => {
    const c = compile("when + night + sleep + in + bed");
    expect(c.kind).toBe("rule");
    if (c.kind !== "rule") return;
    expect(c.rule.action).toEqual({ kind: "rest", place: { kind: "named", id: "bed" } });
  });
});

describe("the obeying creature can SAY a rest back", () => {
  const syms: IntentLineSyms = {
    item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
    place: (p) =>
      p.kind === "named" ? p.id : p.kind === "home" ? "home" : p.kind === "creature" ? p.id : "there",
    creature: (id) => id,
  };

  it("'sleep in the bed' echoes as the ACT the station serves", () => {
    const line = goalIntentLine(goalOf("you + sleep + in + bed"), syms)!;
    expect(line).not.toBeNull();
    // Level a is the teaching slot — the STATION, the word the order turned on.
    expect(line.a).toBe("bed");
    expect(translateGlyph(asIntent(line).b, "en")).toBe("I will sleep.");
  });

  it("every station a spoken rest can name produces a line (never silence)", () => {
    for (const sentence of [
      "you + sleep + in + bed",
      "sit + on + chair",
      "rest + bed",
      "you + sit + next_to + mara",
    ]) {
      const line = goalIntentLine(goalOf(sentence), syms);
      expect(line).not.toBeNull();
      for (const level of [line!.a, line!.b, line!.c]) {
        expect(level.trim()).not.toBe("");
        expect(level).not.toContain("undefined");
      }
    }
  });

  it("the echo is the INTENT syntax, not the order's imperative", () => {
    const goal = goalOf("you + sleep + in + bed");
    const { line, perfect } = commandEcho({ raw: ["you", "sleep", "in", "bed"] }, goal, syms);
    expect(line).not.toBeNull();
    // The child's glyphs name the station; the canonical line speaks the act,
    // so the reserved bare "ok" is NOT earned — the creature says its own line.
    expect(perfect).toBe(false);
    expect(asIntent(line!).b).toContain("sleep");
  });
});

describe("`share` compiles like the give family (L8)", () => {
  it("'share + apple + mara' hands the apple to Mara", () => {
    expect(goalOf("share + apple + mara")).toEqual({
      kind: "give",
      item: { match: { kind: "apple" } },
      to: "mara",
    });
  });

  it("an explicit 'to' reads the same — the frame's intrinsic endpoint", () => {
    expect(goalOf("share + apple + to + mara")).toEqual({
      kind: "give",
      item: { match: { kind: "apple" } },
      to: "mara",
    });
  });

  it("no recipient → the SPEAKER, exactly as 'give + apple' does", () => {
    expect(goalOf("you + share + apple")).toEqual({
      kind: "give",
      item: { match: { kind: "apple" } },
      to: "child",
    });
    expect(goalOf("you + share + apple")).toEqual(goalOf("you + give + apple"));
  });

  it("a place recipient stays containment, like give/bring", () => {
    expect(goalOf("share + apple + to + box")).toEqual({
      kind: "putIn",
      item: { match: { kind: "apple" } },
      container: { kind: "named", id: "box" },
    });
  });
});

describe("`teach` stays UNBOUND — no primitive means it", () => {
  it("'teach + mara' is the explicit not-understood, never a guess", () => {
    expect(compile("teach + mara").kind).toBe("unbound");
  });

  // ⤳ MOVED PIN (L11, 2026-08-10). "show + ball + mara" used to sit beside
  // `teach` as an explicit not-understood, on the reasoning that no goal in the
  // closed set meant it. L11 gave it one — `socialAct` with an optional item,
  // an ATTENTION act that holds the thing up and NEVER hands it over — so the
  // sentence now compiles. What must NOT drift is the thing that pin was really
  // protecting: it is still not a `give`.
  it("'show + ball + mara' compiles to the attention act, and STILL never a give", () => {
    const goal = goalOf("show + ball + mara");
    expect(goal).toEqual({
      kind: "socialAct",
      target: "mara",
      act: "show",
      item: { match: { kind: "ball" } },
    });
    expect(goal.kind).not.toBe("give");
  });
});
