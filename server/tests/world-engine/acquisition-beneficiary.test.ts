// THE BENEFICIARY `for` ON THE ACQUISITION FAMILY (build order L9).
//
// "get + apple + for + mara" has PARSED since `for` became a relation — the
// frame carries `bound: [{for, mara}]` and always did. What it did not have was
// a READING: the acquisition arm looked only at `to` and `from`, so the marker
// fell off the end of the compile and the creature fetched the apple for
// ITSELF. The sentence compiled, the order was obeyed, and the one person the
// child named never got the apple — the quietest failure mode this layer has.
//
// THE READING: fetching for somebody else ENDS IN THEIR HANDS, so a
// `for`-marked PERSON turns the fetch into a DELIVERY — `{give, item, to}`,
// whose plan already regresses the pickup, so "fetch then hand over" is free.
//
// THE DECISION TABLE this file pins (the three sentences where two markers meet):
//   for + CREATURE          → give to them            (the delivery)
//   for + PLACE             → plain fetch             (a place cannot benefit)
//   to + X … for + Y        → give to X               (`to` is the endpoint)
//   from + X … for + Y      → give to Y               (a named body outranks
//                                                      a hint about where it is)
//   trade + G + for + T     → the trade goal          (a DIFFERENT arm's `for`)
//
// Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileIntent,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  asIntent,
  goalIntentLine,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

// The host's binder, mirrored (as-built §3.3): a spoken PLACE or ITEM never
// binds on the creature channel. That channel is the whole gate here — a
// beneficiary must be a BODY, and the kind-blind `defaultBinder` reads every
// bare noun as one (pinned honestly at the bottom of the first block).
const CREATURES = new Set(["mara", "pip", "bear"]);
const PLACES = new Set(["house", "box", "yard"]);
const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
  CREATURES.has(sym) ? "creature" : PLACES.has(sym) ? "place" : "item";
const makeBinder = (): IntentBinder => {
  const b = defaultBinder({ player: "child", listener: "bear" });
  const inner = b.creature.bind(b);
  b.creature = (ref) => (ref?.kind === "entity" && !CREATURES.has(ref.symbol) ? null : inner(ref));
  return b;
};

const compile = (sentence: string, binder: IntentBinder = makeBinder()) =>
  compileIntent(parseSentence(sentence, { classifyEntity: classify }), binder, { id: "b1" });

const goalOf = (sentence: string, binder?: IntentBinder): GoalSpec => {
  const c = compile(sentence, binder);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error(`not a goal: ${sentence}`);
  return c.goal;
};

const APPLE = { match: { kind: "apple" } };

describe("a `for`-marked PERSON turns the fetch into a delivery", () => {
  it("'get + apple + for + mara' hands Mara the apple", () => {
    expect(goalOf("get + apple + for + mara")).toEqual({ kind: "give", item: APPLE, to: "mara" });
  });

  it("…and the parse always carried it — this is a COMPILE gain, not a parse one", () => {
    // Stated so a future reader does not go looking for a parser change: the
    // marked pair has ridden `bound` since `for` became a relation.
    const frame = parseSentence("get + apple + for + mara", { classifyEntity: classify });
    expect(frame.bound).toEqual([{ relation: "for", ref: { kind: "entity", symbol: "mara", modifiers: [] } }]);
  });

  it("the WHOLE family reads it — one primitive, four words", () => {
    // get/take = possession, pick_up = the lift, carry = hold-and-move. They
    // share the acquisition arm, so they share the beneficiary.
    for (const verb of ["get", "take", "pick_up", "carry"]) {
      expect(goalOf(`${verb} + apple + for + mara`)).toEqual({ kind: "give", item: APPLE, to: "mara" });
    }
  });

  it("descriptors ride into the item match, like every other item slot", () => {
    expect(goalOf("get + apple.big + for + mara")).toMatchObject({
      kind: "give",
      item: { match: { kind: "apple", descriptors: ["big"] } },
    });
  });

  it("'get + apple + for + i_me' is the same law `give + apple` states", () => {
    // Deixis is animate by construction, so the speaker is a beneficiary like
    // any other — and "get me the apple" lands where "give me the apple" does.
    expect(goalOf("get + apple + for + i_me")).toEqual({ kind: "give", item: APPLE, to: "child" });
    expect(goalOf("get + apple + for + i_me")).toEqual(goalOf("give + apple"));
  });

  it("under a classifier-less binder every bare noun reads as a body", () => {
    // The known cost of the kind-blind `defaultBinder` (the same one `show`
    // pays): with nothing to tell a house from a person, "for + house" binds a
    // creature called "house". Pinned so the behaviour is a decision, not a
    // surprise — the live host always supplies the classifier.
    const naive = defaultBinder({ player: "child", listener: "bear" });
    expect(compileIntent(parseSentence("get + apple + for + house"), naive, { id: "b2" })).toMatchObject({
      goal: { kind: "give", item: APPLE, to: "house" },
    });
  });
});

describe("the decision table — where two markers meet", () => {
  it("a `for`-bound PLACE stays a PLAIN FETCH ('get + wood + for + house')", () => {
    // `give`'s endpoint rule turns a non-creature TO into a stock `putIn`, and
    // this deliberately does NOT mirror it: `to` names a destination, `for`
    // names a PURPOSE, and the goal vocabulary has no field for one. The fetch
    // is exactly what was asked; stowing the wood inside the house would be a
    // second act nobody ordered.
    expect(goalOf("get + wood + for + house")).toEqual({
      kind: "fetch",
      item: { match: { kind: "wood" } },
    });
    // …and the contrast that makes it a decision: the SAME noun under `to` is
    // the stock move, because that marker is an endpoint.
    expect(goalOf("carry + wood + to + house")).toEqual({
      kind: "putIn",
      item: { match: { kind: "wood" } },
      container: { kind: "named", id: "house" },
    });
  });

  it("an explicit `to` OUTRANKS `for` ('take + ball + to + mara + for + pip')", () => {
    // Two people, one `give`. The endpoint the verb frame is built around wins:
    // it is the marker the goal set can carry, and it keeps the child's own
    // preposition. The benefit is what has nowhere to ride.
    expect(goalOf("take + ball + to + mara + for + pip")).toEqual({
      kind: "give",
      item: { match: { kind: "ball" } },
      to: "mara",
    });
  });

  it("a named BODY outranks a named SOURCE ('get + apple + from + box + for + mara')", () => {
    // `give` carries no `from`, so something is dropped either way. The box is
    // a hint about where the apple IS — which give's own pickup regression
    // finds anyway — while Mara is a person the child chose. Same law the rest
    // arm states: dropping a named body is the worse loss.
    expect(goalOf("get + apple + from + box + for + mara")).toEqual({
      kind: "give",
      item: APPLE,
      to: "mara",
    });
  });

  it("an ANIMACY-DENYING binder keeps the fetch, exactly as company does", () => {
    // `isCompanion` is the second opinion `companionsOf` asks before letting a
    // named noun be company ("trade wood WITH the city" is a partner, not a
    // friend). The beneficiary asks the same question of the same channel, so a
    // binder that answers it is obeyed on both markers.
    const b = makeBinder();
    b.creature = () => "mara"; // deliberately permissive — only the hook may refuse
    b.isCompanion = () => false;
    expect(goalOf("get + apple + for + mara", b)).toEqual({ kind: "fetch", item: APPLE });
  });
});

describe("what did NOT change", () => {
  it("the bare fetch and the from-fetch are byte-identical to pre-L9", () => {
    expect(goalOf("get + apple")).toEqual({ kind: "fetch", item: APPLE });
    expect(goalOf("take + apple + from + box")).toEqual({
      kind: "fetch",
      item: APPLE,
      from: { kind: "named", id: "box" },
    });
    expect(goalOf("take + apple + from + mara")).toEqual({
      kind: "fetch",
      item: APPLE,
      from: { kind: "creature", id: "mara" },
    });
  });

  it("the OBJECTLESS take-from keeps its wildcard fetch even with a beneficiary", () => {
    // "take from the dog for Mara" — there is no named thing to hand over, and
    // the delivery reading is about a THING ending in somebody's hands. The arm
    // is gated on a bound item for exactly that reason.
    expect(goalOf("take + from + bear + for + mara")).toEqual({
      kind: "fetch",
      item: { match: {} },
      from: { kind: "creature", id: "bear" },
    });
  });

  it("the delivery `to` reading is untouched", () => {
    expect(goalOf("take + ball + to + mara")).toEqual({
      kind: "give",
      item: { match: { kind: "ball" } },
      to: "mara",
    });
    expect(goalOf("carry + wood + to + yard")).toEqual({
      kind: "putIn",
      item: { match: { kind: "wood" } },
      container: { kind: "named", id: "yard" },
    });
  });

  it("🚨 TRADE'S `for` IS A DIFFERENT ARM — the take-good, never a beneficiary", () => {
    // `trade` reads its own `for` as WHAT WE WANT BACK (city-expansion ⑤) and
    // owns a separate case with its own bound-ref reader. The two markers share
    // a word and nothing else; this is the pin that keeps them apart.
    expect(goalOf("trade + wood + for + food")).toEqual({
      kind: "trade",
      give: "wood",
      take: "food",
      partner: null,
    });
    expect(goalOf("trade + wood + for + food + with + bear")).toEqual({
      kind: "trade",
      give: "wood",
      take: "food",
      partner: "bear",
    });
  });

  it("a bare `for` binds nobody — an unbindable marker is dropped, never guessed", () => {
    // No noun after the relation ⇒ nothing bound ⇒ the ordinary fetch. The
    // engine's standing law: unbindable stays null.
    expect(goalOf("get + apple + for")).toEqual({ kind: "fetch", item: APPLE });
  });
});

describe("the creature SAYS the delivery back", () => {
  const syms: IntentLineSyms = {
    item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? "thing")),
    place: (p) => (p.kind === "named" ? p.id : p.kind === "home" ? "home" : "there"),
    creature: (id) => id,
  };

  it("the echo names BOTH the thing and the person — a fetch echo could not", () => {
    // The whole point of compiling to `give`: the announcement shape comes with
    // it, so the child hears the beneficiary in the answer. A `fetch` line
    // ("I get the apple") had no slot to say Mara at all.
    const line = goalIntentLine(goalOf("get + apple + for + mara"), syms)!;
    expect(line.c).toBe("give + apple + to + mara");
    expect(line.a).toBe("apple");
    expect(asIntent(line).c).toBe("give.will + apple + to + mara");
    expect(translateGlyph(line.c, "en", { names: new Map([["mara", "f"]]) })).toBe(
      "Give the apple to Mara.",
    );
  });
});
