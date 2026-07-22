// THE TRANSPORT ENDPOINT RULE (semantic-gaps.md §To and From): every transfer
// verb moves a theme between a SOURCE and a DESTINATION. The verb's argument
// frame fills its intrinsic endpoint (take ⇒ from, give ⇒ to); an explicit
// marker of the OTHER direction adds the second endpoint ("take ball TO dog"
// delivers), a marker repeating the intrinsic one changes nothing ("give ball
// from dog" ≡ "give ball dog"). Plus the batch riding the same rule: movement
// gaits (walk/run), stop-a-device, play-with, the command echo, and the
// goal→activity introspection. Pure — no DOM/GL.

import { describe, it, expect } from "@jest/globals";
import {
  canonicalVerb,
  parseSentence,
} from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  commandEcho,
  goalActivity,
  goalIntentLine,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// A classifier-backed binder, like the host's: dog is a creature, box/home are
// not (they bind through the place channel), ball is an item.
const CREATURES = new Set(["dog", "bear", "mara"]);
const PLACES = new Set(["box", "home", "market", "store", "bin"]);
const makeBinder = (): IntentBinder => {
  const b = defaultBinder({ player: "__player__", listener: "bear" });
  const inner = b.creature.bind(b);
  b.creature = (ref) =>
    ref?.kind === "entity" && !CREATURES.has(ref.symbol) ? null : inner(ref);
  return b;
};
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  CREATURES.has(sym) ? "creature" : PLACES.has(sym) ? "place" : "item";

const compile = (sentence: string, binder: IntentBinder = makeBinder()) =>
  compileIntent(parseSentence(sentence, { classifyEntity: classify }), binder, { id: "t1" });

const goalOf = (sentence: string, binder?: IntentBinder): GoalSpec => {
  const c = compile(sentence, binder);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error("not a goal");
  return c.goal;
};

describe("take — the implied SOURCE frame", () => {
  it("'take + ball + from + box' → fetch restricted to the source", () => {
    expect(goalOf("take + ball + from + box")).toEqual({
      kind: "fetch",
      item: { match: { kind: "ball" } },
      from: { kind: "named", id: "box" },
    });
  });

  it("a bare second noun is the source: 'take + ball + dog' = from the dog", () => {
    expect(goalOf("take + ball + dog")).toEqual({
      kind: "fetch",
      item: { match: { kind: "ball" } },
      from: { kind: "creature", id: "dog" },
    });
  });

  it("a person after take is the source too: 'take + ball + i_me' = from me", () => {
    expect(goalOf("take + ball + i_me")).toEqual({
      kind: "fetch",
      item: { match: { kind: "ball" } },
      from: { kind: "creature", id: "__player__" },
    });
  });

  it("objectless 'take + from + dog' takes whatever the source holds", () => {
    expect(goalOf("take + from + dog")).toEqual({
      kind: "fetch",
      item: { match: {} },
      from: { kind: "creature", id: "dog" },
    });
  });

  it("'take + ball' stays the classic unscoped fetch", () => {
    expect(goalOf("take + ball")).toEqual({ kind: "fetch", item: { match: { kind: "ball" } } });
  });
});

describe("the opposite marker flips acquisition into delivery", () => {
  it("'take + ball + to + dog' delivers (give), the opposite of take-from", () => {
    expect(goalOf("take + ball + to + dog")).toEqual({
      kind: "give",
      item: { match: { kind: "ball" } },
      to: "dog",
    });
  });

  it("'get + ball + to + box' stows it there (putIn)", () => {
    expect(goalOf("get + ball + to + box")).toEqual({
      kind: "putIn",
      item: { match: { kind: "ball" } },
      container: { kind: "named", id: "box" },
    });
  });

  it("'carry + ball + from + box' fetches from the source (carry's from-reading)", () => {
    expect(goalOf("carry + ball + from + box")).toEqual({
      kind: "fetch",
      item: { match: { kind: "ball" } },
      from: { kind: "named", id: "box" },
    });
  });

  it("'give + ball + from + dog' ≡ 'give + ball + dog' — the frame slot absorbs a redundant marker", () => {
    expect(goalOf("give + ball + from + dog")).toEqual({
      kind: "give",
      item: { match: { kind: "ball" } },
      to: "dog",
    });
  });
});

describe("give with no recipient defaults to the speaker", () => {
  it("'give + ball' → hand it to me", () => {
    expect(goalOf("give + ball")).toEqual({
      kind: "give",
      item: { match: { kind: "ball" } },
      to: "__player__",
    });
  });
});

describe("movement gaits are one primitive", () => {
  it("'walk + home' and 'run + home' both go home", () => {
    expect(goalOf("walk + home")).toEqual({ kind: "goHome" });
    expect(goalOf("run + home")).toEqual({ kind: "goHome" });
  });

  it("'run + market' → goTo the named place", () => {
    expect(goalOf("run + market")).toEqual({ kind: "goTo", place: { kind: "named", id: "market" } });
  });

  it("'go + ball' → goTo the object's spot (a named lookup the world resolves)", () => {
    expect(goalOf("go + ball")).toEqual({ kind: "goTo", place: { kind: "named", id: "ball" } });
  });

  it("'chase + dog' rides the follow primitive", () => {
    expect(goalOf("chase + dog")).toEqual({ kind: "follow", target: "dog" });
  });

  it("the canonical verb family collapses the synonyms", () => {
    expect(canonicalVerb("walk")).toBe("go");
    expect(canonicalVerb("run")).toBe("go");
    expect(canonicalVerb("take")).toBe("get");
    expect(canonicalVerb("bring")).toBe("give");
    expect(canonicalVerb("eat")).toBe("eat");
  });
});

describe("stop {device} turns the active thing off", () => {
  it("with an isDevice binder, 'stop + lamp' → toggle off", () => {
    const b = makeBinder();
    b.isDevice = (ref) => ref?.kind === "entity" && ref.symbol === "lamp";
    expect(goalOf("stop + lamp", b)).toEqual({
      kind: "toggle",
      device: { match: { kind: "lamp" } },
      state: "off",
    });
  });

  it("without the hook, 'stop + lamp' stays the plain halt (legacy)", () => {
    expect(goalOf("stop + lamp")).toEqual({ kind: "stay", place: undefined });
  });
});

describe("play with a partner is a social act", () => {
  it("'play + with + dog' → socialAct play toward the partner", () => {
    expect(goalOf("play + with + dog")).toEqual({ kind: "socialAct", target: "dog", act: "play" });
  });

  it("bare 'play' stays the fun self-care motive", () => {
    expect(goalOf("play")).toEqual({ kind: "satisfy", need: "play" });
  });
});

// ---------------------------------------------------------------------------
// The command echo + goal introspection
// ---------------------------------------------------------------------------

const syms: IntentLineSyms = {
  item: (ref) =>
    "id" in ref ? ref.id : [ref.match.kind ?? ref.match.category ?? "thing", ...(ref.match.descriptors ?? [])].join("."),
  place: (p) =>
    p.kind === "named" ? p.id : p.kind === "home" ? "home" : p.kind === "creature" ? p.id : "there",
  creature: (cid) => (cid === "__player__" ? "you" : cid),
};

describe("commandEcho — speak the order as understood; 'ok' is earned", () => {
  it("a telegraphic command echoes the full line ('wash clothes' → 'I will wash the clothing')", () => {
    const frame = parseSentence("wash + clothing", { classifyEntity: classify });
    const c = compile("wash + clothing");
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    const { line, perfect } = commandEcho(frame, c.goal, syms);
    expect(perfect).toBe(false);
    expect(line?.c).toBe("i_me + wash + clothing");
  });

  it("a canonical command earns the bare ok ('you get ball' matches 'i_me get ball')", () => {
    const frame = parseSentence("you + get + ball", { classifyEntity: classify });
    const c = compile("you + get + ball");
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    const { perfect } = commandEcho(frame, c.goal, syms);
    expect(perfect).toBe(true);
  });

  it("the from-endpoint is spoken back ('take ball dog' → 'I get the ball from the dog')", () => {
    const frame = parseSentence("take + ball + dog", { classifyEntity: classify });
    const c = compile("take + ball + dog");
    expect(c.kind).toBe("goal");
    if (c.kind !== "goal") return;
    const { line, perfect } = commandEcho(frame, c.goal, syms);
    expect(perfect).toBe(false);
    // phrase()'s 4-slot brevity rule drops the subject when a tail rides the
    // line — the same shape the give announcements use.
    expect(line?.c).toBe("get + ball + from + dog");
  });
});

describe("planner — the from-authorized hand-to-hand take", () => {
  const resolver = {
    positionOf: (id: string) => (id === "dog" ? { x: 5, y: 0 } : { x: 0, y: 0 }),
    homeOf: () => null,
    place: () => null,
    resolveItem: () => "ball1",
    itemPosition: () => ({ x: 5, y: 0 }),
    stationFor: () => null,
    carrierOf: (id: string) => (id === "ball1" ? "dog" : null),
  };

  it("'take ball from dog' plans a walk to the holder + an authorized pick", async () => {
    const { planGoal } = await import(
      "@shared/world-engine/interaction/behavior/action-planner.js"
    );
    const plan = planGoal(
      { kind: "fetch", item: { match: { kind: "ball" } }, from: { kind: "creature", id: "dog" } },
      "helper",
      resolver,
    );
    expect(plan?.steps).toEqual([
      { kind: "moveTo", pos: { x: 5, y: 0 } },
      { kind: "pick", itemId: "ball1", from: "dog" },
    ]);
  });

  it("without the named source, a held item stays not-snatchable (blocked)", async () => {
    const { planGoal } = await import(
      "@shared/world-engine/interaction/behavior/action-planner.js"
    );
    const plan = planGoal({ kind: "fetch", item: { match: { kind: "ball" } } }, "helper", resolver);
    expect(plan).toBeNull();
  });
});

describe("goalActivity — a pursued goal reads back in command words", () => {
  it("maps the errand family", () => {
    expect(goalActivity({ kind: "fetch", item: { match: { kind: "ball" } } }, syms)).toEqual({
      verb: "get",
      object: "ball",
    });
    expect(goalActivity({ kind: "goHome" }, syms)).toEqual({ verb: "go", object: "home" });
    expect(goalActivity({ kind: "consume", item: { match: { kind: "apple" } } }, syms)).toEqual({
      verb: "eat",
      object: "apple",
    });
    expect(goalActivity({ kind: "satisfy", need: "laundry" }, syms)).toEqual({
      verb: "wash",
      object: "clothing",
    });
    expect(
      goalActivity({ kind: "processUnits", at: { kind: "named", id: "tub" }, category: "clothing" }, syms),
    ).toEqual({ verb: "wash", object: "clothing" });
  });

  it("the satisfy intent line speaks the chore's words, not the template key", () => {
    expect(goalIntentLine({ kind: "satisfy", need: "laundry" }, syms)?.c).toBe(
      "i_me + wash + clothing",
    );
  });
});
