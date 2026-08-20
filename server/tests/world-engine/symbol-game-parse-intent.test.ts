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
    // `goodbye`, not `bye`: the duplicate alias was deleted under the NO
    // SYNONYMS law (2026-08-20) — one key per social act.
    expect(p("goodbye").kind).toBe("farewell");
  });
});

// A vocative names WHOM the utterance is addressed to. It is not a subject and
// not an object: in "hi + mara" Mara neither greets nor is greeted-at like a
// thing — she is the one being spoken to. Binding the addressee is the world's
// job (multi-entity-conversations.md §3b); the parser only has to record it.
describe("vocatives — a social act that NAMES someone addresses them", () => {
  // The classifier a world host supplies (names → creatures, toys → items).
  const classifyEntity = (sym: string): "place" | "item" | "creature" | "unknown" =>
    ["mara", "pip"].includes(sym) ? "creature" : ["ball", "apple"].includes(sym) ? "item" : "unknown";
  const p = (s: string) => parseSentence(s, { classifyEntity });

  it("hi + mara → greet addressed TO mara", () => {
    const f = p("hi + mara");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("order-free: mara + hi parses identically", () => {
    const f = p("mara + hi");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("bye + mara → FAREWELL (not a greeting) addressed to mara", () => {
    const f = p("goodbye + mara");
    expect(f.kind).toBe("farewell");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("naming a creature and nothing else already addresses it", () => {
    const f = p("mara");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("hi + you → the listener, a well-formed no-op referent", () => {
    const f = p("hi + you");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toEqual({ kind: "listener" });
  });

  it("a bare hi addresses nobody in particular", () => {
    const f = p("hi");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toBeUndefined();
  });

  it("an ITEM is never an addressee — hi + ball keeps its old shape", () => {
    const f = p("hi + ball");
    expect(f.vocative).toBeUndefined();
    expect(f.kind).toBe("request"); // unchanged: the verbless item reads as a want
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
  });

  it("without a classifier a name is opaque — no animacy is guessed", () => {
    const f = parseSentence("hi + mara"); // no ctx: the host always passes one, tests need not
    expect(f.vocative).toBeUndefined();
    expect(f.kind).toBe("state"); // unchanged: a bare mention, the world decides
    expect(f.object).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("a non-social frame is untouched: mara + eat keeps mara as the SUBJECT", () => {
    const f = p("mara + eat");
    expect(f.kind).toBe("command");
    expect(f.verb).toBe("eat");
    expect(f.subject).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
    expect(f.vocative).toBeUndefined();
    expect(p("mara + hug + pip").vocative).toBeUndefined();
  });

  // Only greet/farewell may LABEL the move; every other social act beside a
  // name keeps the naming's own reading (a greeting), which then addresses.
  it("a non-addressing social never re-labels the naming: yes + mara stays a greet", () => {
    const f = p("yes + mara");
    expect(f.kind).toBe("greet");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
    expect(p("thanks").vocative).toBeUndefined(); // no name, nobody addressed
  });

  it("the slot is ADDITIVE — raw and every other field keep today's values", () => {
    const f = p("hi + mara");
    expect(f.raw).toEqual(["hi", "mara"]);
    expect(f.verb).toBeUndefined();
    expect(f.object).toBeUndefined();
    expect(f.target).toBeUndefined();
    expect(f.modifiers).toEqual([]);
    // The noun still fills whatever role it filled before the vocative existed
    // (the addressee stack, not the parser, is what reads it).
    expect(f.subject).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });
});

// ⑫ (conversation-in-motion.md law ②) — THE NAME CHANNEL. Naming somebody who is
// standing in your conversation is ADDRESSING them; naming somebody who is not is
// talking ABOUT them. Only the roster can tell those apart, which is why it is a
// parse CONTEXT and not a syntax rule.
describe("⑫ the name channel — a roster turns a name into an addressee", () => {
  const classifyEntity = (sym: string): "place" | "item" | "creature" | "unknown" =>
    ["mara", "pip"].includes(sym) ? "creature" : ["ball", "apple"].includes(sym) ? "item" : "unknown";
  /** In a conversation with Mara (and nobody else). */
  const inConvo = (s: string) => parseSentence(s, { classifyEntity, addressees: ["mara"] });
  /** No conversation at all — today's reading, which must not move. */
  const alone = (s: string) => parseSentence(s, { classifyEntity });

  it("a FELLOW MEMBER named on a command is the addressee", () => {
    const f = inConvo("mara + give + apple");
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("…and it is ADDITIVE — the subject reading is untouched", () => {
    // The whole reason this is safe: for a directive the imperative's subject and
    // the utterance's addressee are already the same creature.
    const f = inConvo("mara + give + apple");
    expect(f.subject).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
    expect(f.object).toEqual({ kind: "entity", symbol: "apple", modifiers: [] });
    expect(alone("mara + give + apple").subject).toEqual(f.subject);
    expect(alone("mara + give + apple").object).toEqual(f.object);
  });

  it("a name OUTSIDE the roster is somebody spoken ABOUT, never addressed", () => {
    expect(alone("mara + give + apple").vocative).toBeUndefined();
    // Pip is not in this conversation, so naming Pip is not addressing Pip.
    expect(inConvo("pip + give + apple").vocative).toBeUndefined();
  });

  it("a RECIPIENT behind the verb is never the addressee", () => {
    const f = parseSentence("pip + give + apple + to + mara", {
      classifyEntity,
      addressees: ["mara", "pip"],
    });
    expect(f.vocative).toEqual({ kind: "entity", symbol: "pip", modifiers: [] });
  });

  it("no roster ⇒ every frame is byte-identical to today", () => {
    for (const s of ["mara + give + apple", "mara + eat", "mara + sad", "give + apple + to + mara"]) {
      expect(alone(s).vocative).toBeUndefined();
    }
  });

  it("an ITEM is never an addressee, roster or no roster", () => {
    expect(parseSentence("ball + give", { classifyEntity, addressees: ["ball"] }).vocative)
      .toBeUndefined();
  });
});

// The defect this chapter had to fix before the name channel could ship: with a
// STATE verb the animacy rule deliberately declines to promote a noun to subject,
// which left a named creature unclaimed — and the object rule took the FIRST
// unclaimed noun. "Mara, I want an apple" came out as wanting MARA, with the
// apple silently dropped. A named person is never the thing wanted.
describe("⑫ a named person is never the THING WANTED (state-verb object drop)", () => {
  const classifyEntity = (sym: string): "place" | "item" | "creature" | "unknown" =>
    ["mara", "pip"].includes(sym) ? "creature" : ["ball", "apple"].includes(sym) ? "item" : "unknown";

  it("mara + want + apple keeps the APPLE as the object", () => {
    const f = parseSentence("mara + want + apple", { classifyEntity });
    expect(f.object).toEqual({ kind: "entity", symbol: "apple", modifiers: [] });
  });

  it("…and in a conversation with Mara, it is addressed to her", () => {
    const f = parseSentence("mara + want + apple", { classifyEntity, addressees: ["mara"] });
    expect(f.vocative).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
    expect(f.object).toEqual({ kind: "entity", symbol: "apple", modifiers: [] });
  });

  it("a LONE named creature after a state verb is still the object (nothing to displace)", () => {
    // "i_me + want + mara" is wanting Mara's company — there is no other noun, so
    // the consumption rule must not fire and leave the frame empty.
    const f = parseSentence("i_me + want + mara", { classifyEntity });
    expect(f.object).toEqual({ kind: "entity", symbol: "mara", modifiers: [] });
  });

  it("two ITEMS after a state verb are untouched by the rule", () => {
    const f = parseSentence("ball + want + apple", { classifyEntity });
    expect(f.object).toEqual({ kind: "entity", symbol: "ball", modifiers: [] });
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

  // THE SHAPE THE ATTENTION GATE KEYS ON. Naming a thing and nothing else is the
  // spoken twin of settling the gaze on it (quest-host `attendTo`), so the host
  // has to be able to tell a bare noun from a full request: both are `request`
  // frames, and the VERB is the only difference. Without the classifier a bare
  // noun reads as a `state` instead — which is why the host always passes one.
  it("a bare item noun is a VERBLESS request; a said one keeps its verb", () => {
    const classifyEntity = () => "item" as const;
    const bare = p("apple", { classifyEntity });
    expect(bare.kind).toBe("request");
    expect(bare.verb).toBeUndefined();
    expect(bare.object).toMatchObject({ kind: "entity", symbol: "apple" });
    expect(bare.relation).toBeUndefined();
    expect(bare.modifiers).toHaveLength(0);

    const said = p("i_me + want + apple", { classifyEntity });
    expect(said.kind).toBe("request");
    expect(said.verb).toBe("want");

    expect(p("apple", {}).kind).toBe("state"); // no classifier — not what the game sees
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
