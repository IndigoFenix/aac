// The concept parser (parse-intent.ts): AAC glyph sentences → Intent Frames, no LLM.
// Covers the whole conversational surface, not just commands. Pure — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { parseSentence, type ParseContext } from "@shared/world-engine/interaction/intent/parse-intent.js";

const p = (s: string, ctx?: ParseContext) => parseSentence(s, ctx);

describe("social acts — self-contained moves", () => {
  it("greets, affirms, declines, thanks, claims", () => {
    expect(p("hi").kind).toBe("greet");
    expect(p("yes").kind).toBe("affirm");
    expect(p("no").kind).toBe("decline");
    expect(p("thanks").kind).toBe("thank");
    expect(p("mine").kind).toBe("claim");
    expect(p("bye").kind).toBe("farewell");
  });
});

describe("questions — querying the world / the listener", () => {
  it("where + ball → ask, object ball", () => {
    const f = p("where + ball");
    expect(f.kind).toBe("ask");
    expect(f.question).toBe("where");
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
  });

  it("why + you + want + ball → ask why, subject listener, verb want", () => {
    const f = p("why + you + want + ball");
    expect(f.kind).toBe("ask");
    expect(f.question).toBe("why");
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.verb).toBe("want");
  });

  it("a #question operator with no wh-word is a polar (yes/no) question", () => {
    const f = p("you + have + ball #question");
    expect(f.kind).toBe("ask");
    expect(f.polar).toBe(true);
  });
});

describe("statements — need, feeling, knowledge", () => {
  it("i_me + want + ball → request", () => {
    const f = p("i_me + want + ball");
    expect(f.kind).toBe("request");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
  });

  it("verbless want defaults the speaker as subject", () => {
    expect(p("want + apple").subject).toEqual({ kind: "player" });
    expect(p("want + apple").kind).toBe("request");
  });

  it("i_me + have + ball → state (knowledge about self)", () => {
    expect(p("i_me + have + ball").kind).toBe("state");
  });

  it("i_me + sad → state, feeling carried as a modifier", () => {
    const f = p("i_me + sad");
    expect(f.kind).toBe("state");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.modifiers).toContain("sad");
  });

  it("attaches glyph modifiers to their entity (ball.big)", () => {
    expect(p("i_me + want + ball.big").object).toEqual({ kind: "entity", symbol: "ball", modifiers: ["big"] });
  });
});

describe("commands + transfers (deixis assigns roles, not order)", () => {
  it("you + go + home → command, subject listener", () => {
    const f = p("you + go + home");
    expect(f.kind).toBe("command");
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.verb).toBe("go");
  });

  it("bare imperative 'go' addresses the listener", () => {
    expect(p("go").kind).toBe("command");
    expect(p("go").subject).toEqual({ kind: "listener" });
  });

  it("give i_me ball → request (recipient = me), subject defaults to listener", () => {
    const f = p("give + i_me + ball");
    expect(f.kind).toBe("request");
    expect(f.target).toEqual({ kind: "player" });
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
  });

  it("i_me + give + ball + to + you → offer, recipient you via 'to'", () => {
    const f = p("i_me + give + ball + to + you");
    expect(f.kind).toBe("offer");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.target).toEqual({ kind: "listener" });
    expect(f.relation).toBe("to");
  });

  it("out of order: ball + want + i_me → request (deixis wins over position)", () => {
    const f = p("ball + want + i_me");
    expect(f.kind).toBe("request");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
  });

  it("subject-before-object among plain nouns; verb floats (cat + dog + chase)", () => {
    const f = p("cat + dog + chase");
    expect(f.subject).toEqual({ kind: "entity", symbol: "cat", modifiers: [] });
    expect(f.object).toEqual({ kind: "entity", symbol: "dog", modifiers: [] });
    // verb-first order gives the same roles
    const g = p("chase + cat + dog");
    expect(g.subject).toEqual({ kind: "entity", symbol: "cat", modifiers: [] });
    expect(g.object).toEqual({ kind: "entity", symbol: "dog", modifiers: [] });
  });

  it("animacy overrides position: apple + i_me + eat = I eat the apple", () => {
    const f = p("apple + i_me + eat");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.object).toEqual({ kind: "entity", symbol: "apple", modifiers: [] });
  });

  it("a state verb keeps the noun as object even reversed (apple + want)", () => {
    const f = p("apple + want");
    expect(f.kind).toBe("request");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.object).toEqual({ kind: "entity", symbol: "apple", modifiers: [] });
  });

  it("movement verb: you + follow + i_me → command, subject listener, destination me", () => {
    const f = p("you + follow + i_me");
    expect(f.kind).toBe("command");
    expect(f.verb).toBe("follow");
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.target).toEqual({ kind: "player" }); // follow ME
  });

  it("movement verb: you + go + there → command toward the gaze point", () => {
    const f = p("you + go + there");
    expect(f.kind).toBe("command");
    expect(f.verb).toBe("go");
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.target).toEqual({ kind: "gaze", of: "point" });
  });

  it("gaze deixis: put + this + in + here", () => {
    const f = p("put + this + in + here");
    expect(f.object).toEqual({ kind: "gaze", of: "entity" });
    expect(f.target).toEqual({ kind: "gaze", of: "point" });
    expect(f.relation).toBe("in");
  });
});

describe("rules — a condition connective makes a standing rule", () => {
  it("when + night + go + home → rule, while, action go home, condition night", () => {
    const f = p("when + night + go + home");
    expect(f.kind).toBe("rule");
    expect(f.connective).toBe("when");
    expect(f.lifetime).toBe("while");
    expect(f.verb).toBe("go");
    expect(f.condition?.object).toEqual({ kind: "entity", symbol: "night", modifiers: [] });
  });

  it("the reverse order parses identically: go + home + when + night", () => {
    const f = p("go + home + when + night");
    expect(f.kind).toBe("rule");
    expect(f.verb).toBe("go");
    expect(f.lifetime).toBe("while");
  });

  it("if → edge, until → until", () => {
    expect(p("if + hungry + eat").lifetime).toBe("edge");
    expect(p("build + house + until + town").lifetime).toBe("until");
  });
});

describe("word-order conformance — a teaching signal, not a gate", () => {
  it("well-ordered SVO scores 1 (no confusion)", () => {
    const f = p("i_me + want + ball");
    expect(f.order?.score).toBe(1);
    expect(f.order?.confusion).toBe(0);
    expect(f.order?.actual).toEqual(["subject", "verb", "object"]);
  });

  it("reversed order still PARSES but scores low (NPC shows confusion)", () => {
    const f = p("ball + want + i_me"); // understood as a request, but O V S vs SVO
    expect(f.kind).toBe("request"); // still understood
    expect(f.order!.score).toBeLessThan(0.5); // but flagged as disordered
    expect(f.order!.confusion).toBeGreaterThan(0.5);
  });

  it("only explicitly-placed roles count (implied subject isn't 'misordered')", () => {
    const f = p("want + ball"); // VO, subject implied → verb<object is correct for SVO
    expect(f.order?.score).toBe(1);
  });

  it("the SAME utterance scores against the DESIGNATED language's order", () => {
    const svo = p("i_me + ball + want", { wordOrder: "svo" }); // S O V
    const sov = p("i_me + ball + want", { wordOrder: "sov" }); // S O V — canonical for SOV
    expect(sov.order!.score).toBeGreaterThan(svo.order!.score);
    expect(sov.order!.score).toBe(1);
  });
});

describe("sequences + verbless defaults", () => {
  it("go + home + then + rest → sequence of two clauses", () => {
    const f = p("go + home + then + rest");
    expect(f.kind).toBe("sequence");
    expect(f.clauses).toHaveLength(2);
    expect(f.clauses![0].verb).toBe("go");
    expect(f.clauses![1].verb).toBe("rest");
  });

  it("a verbless place noun → go (adventure); an item → want", () => {
    const classifyEntity = (s: string) => (s === "market" ? "place" : "item") as "place" | "item";
    expect(p("market", { classifyEntity }).kind).toBe("command"); // go to the market
    expect(p("apple", { classifyEntity }).kind).toBe("request"); // want the apple
  });

  it("a verbless item in BUILDING mode → build it", () => {
    const classifyEntity = () => "item" as const;
    expect(p("house", { classifyEntity, mode: "building" }).kind).toBe("command");
  });
});

describe("verb argument frames — bare second nouns fill the verb's implied role", () => {
  // The classifier a world host supplies (names → creatures, furniture → places).
  const classify = (sym: string): "place" | "item" | "creature" | "unknown" =>
    ["mara", "pip", "dog"].includes(sym) ? "creature"
    : ["bin", "box", "bed", "table", "home"].includes(sym) ? "place"
    : ["apple", "ball", "sock"].includes(sym) ? "item"
    : "unknown";
  const p = (s: string) => parseSentence(s, { classifyEntity: classify });

  it("give apple mara → apple is the object, mara the implied-to recipient", () => {
    const f = p("give + apple + mara");
    expect(f.kind).toBe("command");
    expect(f.object).toMatchObject({ kind: "entity", symbol: "apple" });
    expect(f.target).toMatchObject({ kind: "entity", symbol: "mara" });
    expect(f.relation).toBe("to");
  });

  it("the classifier picks roles regardless of order: give mara apple", () => {
    const f = p("give + mara + apple");
    expect(f.object).toMatchObject({ symbol: "apple" });
    expect(f.target).toMatchObject({ symbol: "mara" });
    expect(f.relation).toBe("to");
  });

  it("throw apple bin → bin is the implied-in destination, never the agent", () => {
    const f = p("throw + apple + bin");
    expect(f.kind).toBe("command");
    expect(f.subject).toEqual({ kind: "listener" }); // NOT "the apple throws the bin"
    expect(f.object).toMatchObject({ symbol: "apple" });
    expect(f.target).toMatchObject({ symbol: "bin" });
    expect(f.relation).toBe("in");
  });

  it("put ball box → the place noun is the destination even without 'in'", () => {
    const f = p("put + ball + box");
    expect(f.object).toMatchObject({ symbol: "ball" });
    expect(f.target).toMatchObject({ symbol: "box" });
    expect(f.relation).toBe("in");
  });

  it("an explicit relation still wins: give apple to mara", () => {
    const f = p("give + apple + to + mara");
    expect(f.object).toMatchObject({ symbol: "apple" });
    expect(f.target).toMatchObject({ symbol: "mara" });
    expect(f.relation).toBe("to");
  });

  it("without a classifier, position decides: object first, argument last", () => {
    const f = parseSentence("give + apple + mara");
    expect(f.object).toMatchObject({ symbol: "apple" });
    expect(f.target).toMatchObject({ symbol: "mara" });
  });

  it("animacy over position: a NAMED creature before the verb is the agent", () => {
    const f = p("mara + give + apple");
    expect(f.subject).toMatchObject({ kind: "entity", symbol: "mara" });
    expect(f.object).toMatchObject({ symbol: "apple" });
    const g = p("mara + hug + pip");
    expect(g.subject).toMatchObject({ symbol: "mara" });
    expect(g.object).toMatchObject({ symbol: "pip" });
  });

  it("movement to furniture: you go bed keeps bed as the destination noun", () => {
    const f = p("you + go + bed");
    expect(f.kind).toBe("command");
    expect(f.subject).toEqual({ kind: "listener" });
    expect(f.object).toMatchObject({ symbol: "bed" });
  });
});

describe("verb composition — several verbs compose, never silently last-win", () => {
  it("stop + {V} is a PHASE operator: cease the activity, never do it", () => {
    const f = p("stop + eat");
    expect(f.kind).toBe("command");
    expect(f.phase).toBe("stop");
    expect(f.verb).toBe("eat");
    // Order-free like every other role assignment.
    expect(p("eat + stop")).toMatchObject({ phase: "stop", verb: "eat" });
  });

  it("bare stop stays the plain stop command (no phase)", () => {
    const f = p("stop");
    expect(f.kind).toBe("command");
    expect(f.verb).toBe("stop");
    expect(f.phase).toBeUndefined();
  });

  it("go/come beside another action is a redundant motion auxiliary", () => {
    const f = p("go + wash + clothes");
    expect(f.verb).toBe("wash");
    expect(f.object).toMatchObject({ symbol: "clothes" });
    expect(f.phase).toBeUndefined();
    expect(p("come + play").verb).toBe("play");
  });

  it("want + {V} is a MODAL desire — a request to do, never an order", () => {
    const f = p("want + play");
    expect(f.kind).toBe("request");
    expect(f.modal).toBe("want");
    expect(f.verb).toBe("play");
    expect(f.subject).toEqual({ kind: "player" });
  });

  it("i_me + want + go + home keeps the destination and the speaker subject", () => {
    const f = p("i_me + want + go + home");
    expect(f.kind).toBe("request");
    expect(f.modal).toBe("want");
    expect(f.verb).toBe("go");
    expect(f.subject).toEqual({ kind: "player" });
    expect(f.object).toMatchObject({ symbol: "home" });
  });

  it("a negation on either composed verb negates the frame", () => {
    expect(p("want.not + play")).toMatchObject({ kind: "request", modal: "want", verb: "play", negated: true });
  });

  it("what + you + do is the broad activity ask", () => {
    const f = p("what + you + do");
    expect(f.kind).toBe("ask");
    expect(f.question).toBe("what");
    expect(f.verb).toBe("do");
    expect(f.subject).toEqual({ kind: "listener" });
  });
});
