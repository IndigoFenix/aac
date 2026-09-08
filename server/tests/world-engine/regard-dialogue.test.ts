// ⚖️ THE REGARD CHANNEL, SPOKEN (politics-substrate-round.md S-6,
// interpersonal-politics.md §4b/§4c).
//
// Three board words — `nice`, `mean`, `leader` — and the two things a child can
// do with each: say it TO somebody (a praise, an insult, a yielding), or say it
// ABOUT somebody (the regard TELL, which the room overhears). Plus the ask that
// makes standing diegetic rather than a hidden meter: "who is the leader?".
//
// What this file is FOR, beyond the acts: the four rulesets. `baseWord` falls
// back to the raw English head and fails SILENTLY, so a regard line with no
// lexeme would look perfect in English and put an English word on a Hebrew
// board. Every sentiment is rendered in every shipped ruleset here and checked
// against its own word — that is the gate.
//
// Pure (no DB, no LLM) — belongs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  chooseSpeakerAct,
  intentToAct,
  speakInConversation,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import {
  createConversation,
  joinConversation,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import { perceiveFact, type RegardSentiment } from "@shared/world-engine/interaction/behavior/facts.js";
import { makeRelation, DEFAULT_RELATION, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import { NEUTRAL_PERSONALITY, personalityFromPreset } from "@shared/world-engine/interaction/behavior/personality.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { en, he, es, pt } from "@shared/world-engine/interaction/lang/index.js";
import { translateWith, type GlyphLanguage } from "@shared/world-engine/interaction/lang/core.js";

const NAMES = new Map<string, "m" | "f">([
  ["pip", "m"],
  ["mara", "f"],
  ["orrin", "m"],
]);

/** Three named bodies and nothing else — the regard channel needs no items. */
function room() {
  return createCreatureWorld([{ id: "me" }, { id: "pip" }, { id: "mara" }, { id: "orrin" }], []);
}

const opts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => w.items[id]?.kind ?? id,
  symbolOfCreature: (cid) => cid,
  creatureOf: (sym) => (["pip", "mara", "orrin", "me"].includes(sym) ? sym : undefined),
});

function circle(ids: readonly string[]): ConversationState {
  const c = createConversation("convo", 0);
  for (const id of ids) joinConversation(c, id, 0, "c");
  return c;
}

const constRng = (v: number) => () => v;

// ---------------------------------------------------------------------------
// PARSE — a sentence to an act
// ---------------------------------------------------------------------------

describe("the three words parse to the acts §4b names", () => {
  const w = room();
  const o = opts(w);
  const say = (s: string, to?: string): DialogueAct | null =>
    intentToAct(parseSentence(s), w, { speakerId: "me", ...(to ? { addresseeId: to } : {}) }, o);

  it("said TO somebody, an evaluation is an ACT — praise / insult / yield", () => {
    expect(say("you + nice", "pip")?.kind).toBe("praise");
    expect(say("you + mean", "pip")?.kind).toBe("insult");
    // "You are the leader" is the player HANDING OVER the right to direct them
    // (§5: there is no `yield` word, and this is the sentence that means it).
    expect(say("you + leader", "pip")?.kind).toBe("yield");
  });

  it("a BARE evaluation means the person being spoken to — one glyph is a sentence", () => {
    expect(say("nice", "pip")?.kind).toBe("praise");
    expect(say("mean", "pip")?.kind).toBe("insult");
    // …and aimed at nobody it is not a quieter act, it is no act.
    expect(say("nice")?.kind).toBe("dont-understand");
  });

  it("said ABOUT a third party, it is the regard TELL", () => {
    expect(say("mara + nice", "pip")).toMatchObject({
      kind: "tell-fact",
      fact: { kind: "regard", observer: "me", subject: "mara", sentiment: "like" },
    });
    expect(say("mara + mean", "pip")).toMatchObject({
      fact: { kind: "regard", subject: "mara", sentiment: "dislike" },
    });
    expect(say("mara + leader", "pip")).toMatchObject({
      fact: { kind: "regard", subject: "mara", sentiment: "respect" },
    });
  });

  it("🚨 nobody appoints THEMSELVES — a self-regard is not an act", () => {
    // Self-authorship is not a compliance bypass (the round's law), and the
    // regard channel is by construction what OTHERS hold about you.
    expect(say("i_me + leader", "pip")?.kind).toBe("dont-understand");
    expect(say("i_me + nice", "pip")?.kind).toBe("dont-understand");
  });

  it("'who + leader' is the REGARD query, not a condition search (§4c)", () => {
    expect(say("who + leader", "pip")).toMatchObject({
      kind: "ask-fact",
      query: { kind: "regard", sentiment: "respect" },
    });
    expect(say("who + nice", "pip")).toMatchObject({ query: { kind: "regard", sentiment: "like" } });
    // The shipped condition search is untouched for every other word.
    expect(say("who + hungry", "pip")).toMatchObject({
      query: { kind: "conditionSearch", condition: "hungry" },
    });
  });

  it("a NEGATED evaluation still SPEAKS as the corrective — the `.not` is not eaten", () => {
    // A TRAIT's negation is the shipped corrective: the regard frame has no
    // slot for it and must not claim it, because rendering "mara + nice.not"
    // as "Mara is nice" would say the opposite of the sentence.
    expect(translateWith(en, "mara + nice.not", { names: NAMES })).toBe("Mara isn't nice.");
    expect(translateWith(es, "mara + nice.not", { names: NAMES })).toBe("Mara no es amable.");
  });

  // ⚖️ A2 — THE RESIDUAL THIS FILE USED TO PIN IS FIXED (semantic-engine-round
  // §A2). The parser DISCARDED a `.not` on an attribute (`attrs.push(tok.head)`
  // dropped `tok.mods`) and computed `negated` from verb tokens alone, so no
  // verbless frame could ever be negative: "mara + hungry.not" parsed as a
  // confession of hunger and "mara + nice.not" ASSERTED that she is nice. The
  // two expectations that pinned that behaviour are inverted below on purpose —
  // this is the day somebody chose, and the rule is that a negated attribute
  // NEVER asserts the positive.
  it("A2 — a negated attribute never asserts the positive", () => {
    // A negated CONDITION is the shipped decline (the invitation-decline shape).
    expect(say("mara + hungry.not", "pip")).toMatchObject({ kind: "refuse" });
    expect(say("i_me + hungry.not", "pip")).toMatchObject({ kind: "refuse" });
    // `nice` and `mean` are the two poles of ONE axis, so denying one asserts
    // the other — a child with only the `nice` button can still say it.
    expect(say("mara + nice.not", "pip")).toMatchObject({ fact: { kind: "regard", sentiment: "dislike" } });
    expect(say("mara + mean.not", "pip")).toMatchObject({ fact: { kind: "regard", sentiment: "like" } });
    // To the FACE, the same flip: "you're not nice" is an insult, not a praise.
    expect(say("you + nice.not", "pip")?.kind).toBe("insult");
    expect(say("you + mean.not", "pip")?.kind).toBe("praise");
    // 🚨 A ROLE DENIED APPOINTS NOBODY. No regard fact, and above all no
    // `yield`: "you are not the leader" must never hand over the authority its
    // positive twin hands over. It is still a well-formed sentence, so it is
    // acknowledged (`tell`) and never gets the don't-understand floor.
    expect(say("you + leader", "pip")?.kind).toBe("yield");
    expect(say("you + leader.not", "pip")?.kind).toBe("tell");
    expect(say("mara + leader.not", "pip")?.kind).toBe("tell");
    // The ASK flips too — "who isn't nice?" is the dislike query.
    expect(say("who + nice.not", "pip")).toMatchObject({
      kind: "ask-fact",
      query: { kind: "regard", sentiment: "dislike" },
    });
    expect(say("who + mean.not", "pip")).toMatchObject({ query: { kind: "regard", sentiment: "like" } });
    // …and a query the fact store cannot express is refused honestly rather
    // than answered with its opposite ("who is NOT hungry" is not a search).
    expect(say("who + hungry.not", "pip")?.kind).toBe("dont-understand");
    // Every POSITIVE twin is untouched.
    expect(say("mara + hungry", "pip")).toMatchObject({ fact: { kind: "condition", condition: "hungry" } });
    expect(say("mara + nice", "pip")).toMatchObject({ fact: { kind: "regard", sentiment: "like" } });
    expect(say("who + nice", "pip")).toMatchObject({ query: { kind: "regard", sentiment: "like" } });
    expect(say("who + hungry", "pip")).toMatchObject({ query: { kind: "conditionSearch", condition: "hungry" } });
  });

  // 🚨 `leader` is a NOUN in the POS table, so the corrective frame (which wants
  // an ADJECTIVE) could never claim "mara + leader.not" — it fell all the way to
  // the telegraphic GLOSS in every ruleset: "mara not leader" · "mara לא מנהיג" ·
  // "mara no líder" · "mara não líder". No copula, no article, no agreement, and
  // the NAME left raw. The role predicate's own frame now carries the negation.
  it("A2 — a ROLE denied renders as a proper sentence in all four rulesets", () => {
    expect(translateWith(en, "mara + leader.not", { names: NAMES })).toBe("Mara is not the leader.");
    expect(translateWith(he, "mara + leader.not", { names: NAMES })).toBe("Mara היא לא המנהיגה.");
    expect(translateWith(es, "mara + leader.not", { names: NAMES })).toBe("Mara no es la líder.");
    expect(translateWith(pt, "mara + leader.not", { names: NAMES })).toBe("Mara não é a líder.");
    // The pronoun subject takes no copula pronoun in Hebrew.
    expect(translateWith(en, "you + leader.not", { names: NAMES })).toBe("You are not the leader.");
    expect(translateWith(he, "you + leader.not", { names: NAMES })).toBe("אתה לא המנהיג.");
    expect(translateWith(es, "you + leader.not", { names: NAMES })).toBe("No eres el líder.");
    expect(translateWith(pt, "you + leader.not", { names: NAMES })).toBe("Você não é o líder.");
    // The POSITIVE twins are byte-identical to what they always were.
    expect(translateWith(en, "mara + leader", { names: NAMES })).toBe("Mara is the leader.");
    expect(translateWith(he, "mara + leader", { names: NAMES })).toBe("Mara היא המנהיגה.");
    expect(translateWith(es, "mara + leader", { names: NAMES })).toBe("Mara es la líder.");
    expect(translateWith(pt, "mara + leader", { names: NAMES })).toBe("Mara é a líder.");
    // No raw English HEAD survives into Hebrew (`baseWord` fails silently).
    // The NAME itself stays Latin — the ruleset transliterates nothing, which
    // is the shipped behaviour every other Hebrew pin in this file assumes.
    for (const g of ["mara + leader.not", "you + leader.not"]) {
      expect(/[a-z]{3}/.test(translateWith(he, g, { names: NAMES }).replace(/Mara/g, ""))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RENDER — every sentiment, every shipped ruleset
// ---------------------------------------------------------------------------

describe("the regard line speaks in all four rulesets", () => {
  const w = room();
  const o = opts(w);

  /** What an ANSWERER says when it holds this belief — the real path: a held
   *  fact, asked about, phrased by `factLine`. */
  function heard(sentiment: RegardSentiment): string {
    const world = room();
    perceiveFact(world, "pip", { kind: "regard", observer: "orrin", subject: "mara", sentiment });
    const ask = intentToAct(
      parseSentence(sentiment === "respect" ? "who + leader" : sentiment === "like" ? "who + nice" : "who + mean"),
      world,
      { speakerId: "me", addresseeId: "pip" },
      o,
    )!;
    return selectAct(world, "pip", "me", ask, "c", opts(world)).responseGlyph!;
  }

  it("like / dislike / respect are said ABOUT THE SUBJECT; fear names BOTH parties", () => {
    expect(heard("like")).toBe("mara + nice");
    expect(heard("dislike")).toBe("mara + mean");
    expect(heard("respect")).toBe("mara + leader");
    // A fear is a confession — the observer IS the news, so it stays in.
    const world = room();
    perceiveFact(world, "pip", { kind: "regard", observer: "orrin", subject: "mara", sentiment: "fear" });
    const line = selectAct(
      world,
      "pip",
      "me",
      { kind: "ask-fact", query: { kind: "regard", sentiment: "fear" }, glyph: "" },
      "c",
      opts(world),
    ).responseGlyph;
    expect(line).toBe("orrin + scared + mara");
  });

  // ONE ROW PER SENTIMENT × RULESET. The expectation is the ruleset's OWN word
  // and the absence of the English head — which is exactly the failure mode
  // (`baseWord` hands back the head and nothing complains).
  const rows: Array<[GlyphLanguage, string, string, string, string]> = [
    // lang, like-word, dislike-word, respect-word, fear-word
    [en, "nice", "mean", "leader", "scared"],
    [he, "נחמדה", "מרושעת", "מנהיגה", "מפחד"],
    [es, "amable", "antipática", "líder", "asustado"],
    [pt, "gentil", "antipática", "líder", "assustado"],
  ];

  for (const [lang, like, dislike, respect, fear] of rows) {
    it(`${lang.id}: every sentiment gets a real word, and no English head leaks`, () => {
      const speak = (g: string) => translateWith(lang, g, { names: NAMES, speaker: "m", addressee: "f" });
      const lines = {
        like: speak("mara + nice"),
        dislike: speak("mara + mean"),
        respect: speak("mara + leader"),
        fear: speak("orrin + scared + mara"),
      };
      expect(lines.like).toContain(like);
      expect(lines.dislike).toContain(dislike);
      expect(lines.respect).toContain(respect);
      expect(lines.fear).toContain(fear);
      if (lang.id !== "en") {
        // 🚨 THE SILENT FAILURE. A missing lexeme renders the raw head, which is
        // an English word — the whole reason this suite exists.
        for (const text of Object.values(lines)) {
          expect(text).not.toMatch(/\b(nice|mean|leader|scared)\b/);
        }
      }
    });
  }

  it("the rendered line is a legal BOARD line — it parses back to the same act", () => {
    // The NPC's bubble shows glyphs, so what `factLine` builds has to be a
    // sentence a child could have pressed.
    expect(intentToAct(parseSentence("mara + leader"), w, { speakerId: "me", addresseeId: "pip" }, o)).toMatchObject({
      kind: "tell-fact",
      fact: { kind: "regard", subject: "mara", sentiment: "respect" },
    });
  });
});

// ---------------------------------------------------------------------------
// THE ASK — answered from the book, then from hearsay
// ---------------------------------------------------------------------------

describe("'who is the leader?' (§4c — standing is ASKABLE)", () => {
  const ask = (w: ReturnType<typeof createCreatureWorld>, o: ProjectionOpts) =>
    intentToAct(parseSentence("who + leader"), w, { speakerId: "me", addresseeId: "pip" }, o)!;

  function withBook(book: Record<string, Relation>): ProjectionOpts {
    return { ...opts(room()), relationOf: (a, b) => book[`${a}>${b}`] ?? DEFAULT_RELATION };
  }

  it("a body answers about the person it actually respects, from the BOOK", () => {
    const w = room();
    const o = { ...withBook({ "pip>mara": makeRelation({ authority: 0.6 }) }), symbolOf: (id: string) => id };
    const res = selectAct(w, "pip", "me", ask(w, o), "c", o, { convo: circle(["me", "pip", "mara"]) });
    expect(res.responseGlyph).toBe("mara + leader");
    // …and the answer TEACHES, exactly as every other fact answer does.
    expect(w.creatures.me!.facts?.["regard:pip:mara"]).toMatchObject({ sentiment: "respect" });
  });

  it("respecting nobody present, it falls back to what it was TOLD", () => {
    const w = room();
    perceiveFact(w, "pip", { kind: "regard", observer: "orrin", subject: "mara", sentiment: "respect" });
    const o = withBook({});
    const res = selectAct(w, "pip", "me", ask(w, o), "c", o, { convo: circle(["me", "pip", "mara"]) });
    expect(res.responseGlyph).toBe("mara + leader");
  });

  it("knowing nothing, it says so — never a fabricated chief", () => {
    const w = room();
    const o = withBook({});
    const res = selectAct(w, "pip", "me", ask(w, o), "c", o, { convo: circle(["me", "pip", "mara"]) });
    expect(res.responseGlyph).toContain("think.not");
  });
});

// ---------------------------------------------------------------------------
// THE TELL — overhearing, and what an NPC will volunteer
// ---------------------------------------------------------------------------

describe("a regard told in a circle reaches the third member", () => {
  it("overhear fans a regard out — it is an ordinary tell-fact", () => {
    const w = room();
    const c = circle(["me", "pip", "mara"]);
    const o = opts(w);
    const act = intentToAct(parseSentence("orrin + mean"), w, { speakerId: "me", addresseeId: "pip" }, o)!;
    speakInConversation(w, c, "me", act, "pip", o, { tick: 0, rng: constRng(0) });
    // The addressee learned it inside `selectAct`; the BYSTANDER learned it
    // through the fan-out, which is the whole point of a circle.
    expect(w.creatures.pip!.facts?.["regard:me:orrin"]).toMatchObject({ sentiment: "dislike" });
    expect(w.creatures.mara!.facts?.["regard:me:orrin"]).toMatchObject({ sentiment: "dislike" });
  });
});

describe("an NPC offers a regard tell when it HOLDS one about somebody else", () => {
  const speakerOpts = (w: ReturnType<typeof createCreatureWorld>): ProjectionOpts => opts(w);
  const mood = { personality: NEUTRAL_PERSONALITY, rng: constRng(0.5) };

  /** The acts `chooseSpeakerAct` would weigh, in order — the roulette's vector
   *  is a function of exactly this list. */
  function boardOf(w: ReturnType<typeof createCreatureWorld>, c: ConversationState): string[] {
    return projectDialogue(w, "pip", "me", "c", speakerOpts(w), { convo: c }).acts.map(
      (a) => `${a.kind}:${a.fact?.kind === "regard" ? a.fact.subject : ""}`,
    );
  }

  it("🚨 holding none, the candidate list is UNCHANGED — the bench promise", () => {
    const w = room();
    const c = circle(["me", "pip", "mara"]);
    const before = boardOf(w, c);
    expect(before.some((k) => k.startsWith("tell-fact"))).toBe(false);
  });

  it("holding one about a third party present, the tell is offered", () => {
    const w = room();
    const c = circle(["me", "pip", "mara"]);
    perceiveFact(w, "me", { kind: "regard", observer: "me", subject: "mara", sentiment: "like" });
    expect(boardOf(w, c)).toContain("tell-fact:mara");
    const picked = chooseSpeakerAct(w, "me", "pip", "c", speakerOpts(w), mood, { convo: c });
    expect(picked).toBeTruthy();
  });

  it("a regard about the person being TALKED TO is never a tell — that is an insult", () => {
    const w = room();
    const c = circle(["me", "pip", "mara"]);
    perceiveFact(w, "me", { kind: "regard", observer: "me", subject: "pip", sentiment: "dislike" });
    expect(boardOf(w, c).some((k) => k.startsWith("tell-fact"))).toBe(false);
  });

  // ⚖️ W2-4 (2026-09-08) — PIN MOVED, WITH ITS REASON. This used to assert the
  // opposite ("gossip needs the circle"): the subject had to be a third party
  // STANDING IN THE CIRCLE. That guard was a bench-preserving choice, not a law,
  // and it was backwards — the natural regard tell is about the person who is
  // NOT in earshot, and every dollhouse circle is a DYAD, so the presence test
  // rejected every gossip in the game whatever anybody believed. The four
  // remaining guards (holds it · not about either party · has a name · not
  // already known) are the whole rule now.
  it("a regard about somebody ABSENT IS offered — gossip is about people who are not there", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    perceiveFact(w, "me", { kind: "regard", observer: "me", subject: "orrin", sentiment: "like" });
    expect(boardOf(w, c)).toContain("tell-fact:orrin");
    // …and it is sayable: a DYAD is where almost all of these actually get said.
    const picked = chooseSpeakerAct(w, "me", "pip", "c", speakerOpts(w), mood, { convo: c });
    expect(picked).toBeTruthy();
  });

  it("old news is not a turn — a fact the addressee already holds is dropped", () => {
    const w = room();
    const c = circle(["me", "pip", "mara"]);
    perceiveFact(w, "me", { kind: "regard", observer: "me", subject: "mara", sentiment: "like" });
    perceiveFact(w, "pip", { kind: "regard", observer: "me", subject: "mara", sentiment: "like" });
    expect(boardOf(w, c).some((k) => k.startsWith("tell-fact"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE PLAYER-SIDE YIELD — an agreement that reverses a refusal
// ---------------------------------------------------------------------------

describe("refuse → agree is tagged `yielded` (§5 — the yield has no word)", () => {
  function setUp() {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "bear" }],
      [{ id: "cookie1", ownerId: "me", kind: "cookie" }],
    );
    return { w, c: circle(["me", "bear"]), o: opts(w) };
  }
  const request: DialogueAct = { kind: "request", itemId: "cookie1", glyph: "give + cookie" };
  const refuse: DialogueAct = { kind: "refuse", glyph: "no" };
  const agree: DialogueAct = { kind: "agree", glyph: "yes" };

  it("the second answer, after a refusal to the same asker, is a climb-down", () => {
    const { w, c, o } = setUp();
    speakInConversation(w, c, "bear", request, "me", o, { tick: 0, rng: constRng(0) });
    speakInConversation(w, c, "me", refuse, "bear", o, { tick: 1, rng: constRng(0) });
    const turn = speakInConversation(w, c, "me", agree, "bear", o, { tick: 2, rng: constRng(0) });
    expect(turn.utterance.act.yielded).toBe(true);
  });

  it("a plain 'yes' is not a surrender", () => {
    const { w, c, o } = setUp();
    speakInConversation(w, c, "bear", request, "me", o, { tick: 0, rng: constRng(0) });
    const turn = speakInConversation(w, c, "me", agree, "bear", o, { tick: 1, rng: constRng(0) });
    expect(turn.utterance.act.yielded).toBeUndefined();
  });

  it("a refusal that came BEFORE the ask is about something else", () => {
    const { w, c, o } = setUp();
    speakInConversation(w, c, "me", refuse, "bear", o, { tick: 0, rng: constRng(0) });
    speakInConversation(w, c, "bear", request, "me", o, { tick: 1, rng: constRng(0) });
    const turn = speakInConversation(w, c, "me", agree, "bear", o, { tick: 2, rng: constRng(0) });
    expect(turn.utterance.act.yielded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⚖️ W2-4 — A YIELD SAYS "YOU LEADER"
//
// The yield rung of `willingnessToGive` is the ONE give that costs the giver
// standing publicly, and it used to sound EXACTLY like handing over a spare
// ("yes"): the climb-down was in the events and nowhere in the room. The words
// are the child's own yield sentence spoken back — one sentence for both
// directions of the move, and no new word.
// ---------------------------------------------------------------------------

describe("a yielded request is SAID, not just booked (W2-4)", () => {
  // A FRESH WORLD PER ASK, and that is not fussiness: the request EXECUTES (the
  // cookie changes hands), so a second ask against the same world is a different
  // question — the owner no longer has one to give.
  function ask(rel: Relation, preset: "companion", level: "a" | "c" = "c") {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "bear" }],
      [{ id: "cookie1", ownerId: "bear", kind: "cookie" }],
    );
    const acts: { kind: string }[] = [];
    const o: ProjectionOpts = {
      symbolOf: (id) => w.items[id]?.kind ?? id,
      symbolOfCreature: (cid) => cid,
      relationOf: () => rel,
      personalityOf: () => personalityFromPreset(preset),
      onSocialAct: (a) => acts.push(a),
    };
    const req: DialogueAct = { kind: "request", itemId: "cookie1", glyph: "give + cookie" };
    return {
      glyph: selectAct(w, "bear", "me", req, level, o).responseGlyph,
      kinds: acts.map((x) => x.kind),
    };
  }

  it("giving way to somebody with standing says 'you + leader' — level-aware", () => {
    // Authority 0.9 at an unassertive body clears `yieldGate`; the whole ladder
    // above it (bound / own need / generosity / surplus) had already refused,
    // which is what makes this a yield rather than a gift.
    const out = ask(makeRelation({ authority: 0.9 }), "companion");
    expect(out.glyph).toBe("you + leader");
    // the one-symbol rung says the word alone
    expect(ask(makeRelation({ authority: 0.9 }), "companion", "a").glyph).toBe("leader");
    expect(out.kinds).toEqual(["yield", "request-granted"]); // the book move is unchanged
  });

  it("a GIFT is still a plain 'yes' — the two gives must not sound alike", () => {
    const out = ask(makeRelation({ affinity: 0.95 }), "companion");
    expect(out.glyph).toBe("yes");
    expect(out.kinds).toEqual(["request-granted"]); // no yield: nobody gave way
  });

  it("the yield SENTENCE is the same one a child presses", () => {
    // Symmetry, checked rather than assumed: "you + leader" from the player maps
    // to the `yield` act, so the creature's answer is a line the child could
    // have composed — the ONE-VOCABULARY law, in both directions.
    const w = room();
    const spoken = intentToAct(parseSentence("you + leader"), w, { speakerId: "me", addresseeId: "pip" }, opts(w));
    expect(spoken?.kind).toBe("yield");
    expect(spoken?.glyph).toBe("you + leader");
  });
});

// ---------------------------------------------------------------------------
// THE ANSWER SIDE — an NPC replies to all three, but initiates none
// ---------------------------------------------------------------------------

describe("praise / insult / yield are answered; only PRAISE is also initiated", () => {
  const w = room();
  const o = opts(w);
  const reply = (act: DialogueAct) => selectAct(w, "pip", "me", act, "c", o).responseGlyph;

  it("each act gets an honest answer, never silence", () => {
    expect(reply({ kind: "praise", glyph: "you + nice" })).toBe("thank_you");
    expect(reply({ kind: "insult", glyph: "you + mean" })).toContain("sad");
    expect(reply({ kind: "yield", glyph: "you + leader" })).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// ⚖️ W2-2 / W2-3 — WHAT AN NPC SAYS OUT OF ITS OWN BOOK
//
// The fact store is what a creature was TOLD; its own attitude lives in the
// host's directed relation book, which reaches the pure layer only as
// `SpeakerMood.relationTo` and only on an NPC's turn. These pins are the whole
// asymmetry: a speaker with a book has things to say, the PLAYER's board is
// untouched, and a speaker without one behaves exactly as it did before.
// ---------------------------------------------------------------------------

describe("the speaker's OWN BOOK is a source of things to say (W2-2/W2-3)", () => {
  const mood = (relationTo?: (id: string) => Relation) => ({
    personality: NEUTRAL_PERSONALITY,
    rng: constRng(0.5),
    ...(relationTo ? { relationTo } : {}),
  });
  /** Every act `chooseSpeakerAct` would weigh, over the whole roulette. */
  function candidates(
    w: ReturnType<typeof createCreatureWorld>,
    c: ConversationState,
    speaker: string,
    listener: string,
    relationTo?: (id: string) => Relation,
  ): string[] {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const a = chooseSpeakerAct(w, speaker, listener, "c", opts(w), {
        ...mood(relationTo),
        rng: () => i / 200,
      }, { convo: c });
      if (a) seen.add(`${a.kind}:${a.glyph}`);
    }
    return [...seen].sort();
  }
  const likes = (who: string) => (id: string) =>
    id === who ? makeRelation({ affinity: 0.8 }) : DEFAULT_RELATION;

  it("🚨 NO BOOK, NO CHANGE — a speaker with no `relationTo` says what it always said", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    // The bench promise, restated for the own-book half: every existing caller
    // (and every test that passes only `relation`) keeps its candidate list —
    // and therefore its weight vector and its roulette outcome — byte for byte.
    expect(candidates(w, c, "me", "pip")).toEqual(["bye:goodbye", "how-are-you:you + ok#question"]);
  });

  it("PRAISE to a liked addressee — the child's own 'you + nice', spoken back", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    expect(candidates(w, c, "me", "pip", likes("pip"))).toContain("praise:you + nice");
    // …and the answer is the one the tell convention already reserves.
    expect(selectAct(w, "pip", "me", { kind: "praise", glyph: "you + nice" }, "c", opts(w)).responseGlyph)
      .toBe("thank_you");
  });

  it("🚨 INSULT is never offered — kid-safety, not an engineering gap", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    const dislikes = (id: string) => (id === "pip" ? makeRelation({ affinity: -0.9 }) : DEFAULT_RELATION);
    const list = candidates(w, c, "me", "pip", dislikes);
    expect(list.some((k) => k.startsWith("insult"))).toBe(false);
    // …nor a YIELD (authority arriving from nowhere): a creature yields only
    // where a yield is EARNED, on the willingness ladder.
    expect(list.some((k) => k.startsWith("yield"))).toBe(false);
  });

  it("GOSSIP about an ABSENT third party — the tell nobody could reach before", () => {
    const w = room();
    const c = circle(["me", "pip"]); // orrin and mara are NOT here
    const list = candidates(w, c, "me", "pip", likes("orrin"));
    expect(list).toContain("tell-fact:orrin + nice");
  });

  it("the four guards hold: not the listener, not myself, not old news, not nameless", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    // …about the LISTENER — that is a praise, and it is offered AS one.
    const toFace = candidates(w, c, "me", "pip", likes("pip"));
    expect(toFace).toContain("praise:you + nice");
    expect(toFace.some((k) => k.startsWith("tell-fact"))).toBe(false);
    // …about MYSELF — the self-appointment §2e forbids.
    expect(candidates(w, c, "me", "pip", likes("me")).some((k) => k.startsWith("tell-fact"))).toBe(false);
    // …OLD NEWS: the addressee already holds this speaker's belief about orrin.
    const known = room();
    perceiveFact(known, "pip", { kind: "regard", observer: "me", subject: "orrin", sentiment: "like" });
    expect(
      candidates(known, circle(["me", "pip"]), "me", "pip", likes("orrin")).some((k) =>
        k.startsWith("tell-fact"),
      ),
    ).toBe(false);
    // …and a subject with NO NAME in this speaker's mouth ("there + nice" is not
    // a sentence in any ruleset).
    const nameless = createCreatureWorld([{ id: "me" }, { id: "pip" }, { id: "orrin" }], []);
    const noNames: ProjectionOpts = { symbolOf: (id) => id }; // no symbolOfCreature
    const anon = chooseSpeakerAct(nameless, "me", "pip", "c", noNames, mood(likes("orrin")), {
      convo: circle(["me", "pip"]),
    });
    expect(anon?.kind).not.toBe("tell-fact");
  });

  it("🚨 ONE SENTENCE, ONE BUTTON — an own-book tell never doubles a held one", () => {
    // `regardLine` drops the OBSERVER, so "what I think of orrin" and "what mara
    // told me she thinks of orrin" are the SAME line. Two facts, one sentence:
    // the wheel must carry it once, or it gets double the weight it earned.
    const w = room();
    const c = circle(["me", "pip"]);
    perceiveFact(w, "me", { kind: "regard", observer: "mara", subject: "orrin", sentiment: "like" });
    const list = candidates(w, c, "me", "pip", likes("orrin"));
    expect(list.filter((k) => k === "tell-fact:orrin + nice")).toHaveLength(1);
  });

  it("the strongest THREE only — a well-connected speaker cannot flood its own wheel", () => {
    const many = createCreatureWorld(
      [{ id: "me" }, { id: "pip" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      [],
    );
    const o: ProjectionOpts = { symbolOf: (id) => id, symbolOfCreature: (cid) => cid };
    const strength: Record<string, number> = { a: 0.4, b: 0.9, c: 0.5, d: 0.7, e: 0.35 };
    const rel = (id: string) => makeRelation({ affinity: strength[id] ?? 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const act = chooseSpeakerAct(many, "me", "pip", "c", o, { ...mood(rel), rng: () => i / 200 }, {
        convo: circle(["me", "pip"]),
      });
      if (act?.kind === "tell-fact") seen.add(act.glyph);
    }
    // Sorted by the axis `regardSentimentOf` actually read, ties by id.
    expect([...seen].sort()).toEqual(["b + nice", "c + nice", "d + nice"]);
  });

  it("nothing is WRITTEN by offering — the store moves only when the tell is SPOKEN", () => {
    const w = room();
    const c = circle(["me", "pip"]);
    candidates(w, c, "me", "pip", likes("orrin"));
    expect(w.creatures.me!.facts?.["regard:me:orrin"]).toBeUndefined();
    expect(w.creatures.pip!.facts?.["regard:me:orrin"]).toBeUndefined();
    // Spoken, it travels the one knowledge channel it always did.
    const act = chooseSpeakerAct(w, "me", "pip", "c", opts(w), mood(likes("orrin")), { convo: c })!;
    const tell = act.kind === "tell-fact" ? act : { kind: "tell-fact" as const, fact: { kind: "regard" as const, observer: "me", subject: "orrin", sentiment: "like" as RegardSentiment }, glyph: "orrin + nice" };
    speakInConversation(w, c, "me", tell, "pip", opts(w), { tick: 0, rng: constRng(0) });
    expect(w.creatures.pip!.facts?.["regard:me:orrin"]).toMatchObject({ sentiment: "like" });
  });
});
