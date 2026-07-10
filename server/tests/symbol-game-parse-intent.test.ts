// The concept parser (parse-intent.ts): AAC glyph sentences → Intent Frames, no LLM.
// Covers the whole conversational surface, not just commands. Pure — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { parseSentence, type ParseContext } from "@shared/symbol-game/parse-intent.js";

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
