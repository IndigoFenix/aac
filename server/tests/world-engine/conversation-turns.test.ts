// ONE UTTERANCE INTO A CONVERSATION — the §4.7 façade (`speakInConversation`)
// and the speaker-side move that feeds it (`chooseSpeakerMove`).
// planning-docs/games/world-engine/multi-entity-conversations.md §3c, §4.7.
//
// respond.ts already has its own suite (conversation-arbitration.test.ts) for
// the urge math and the wheel. This file pins the things only the FAÇADE can be
// wrong about: what gets recorded, who is even eligible, whose rung the reply is
// phrased at, who overhears what, and that a silence comes back visible.
//
// Every draw here is either a constant (`() => 0` takes the first slot,
// `() => 1 - ε` takes the last, which is always SILENCE) or a seeded
// `mulberry32` stream — never `Math.random`. Frequencies below are therefore
// facts about the code, not samples.
//
// ⑫⑤ NOTE — half the cases below say `hi` (a `how-are-you`) TO THE FLOOR in a
// roster of three or more, and every one of them still gets an answer. That is
// not luck: `how-are-you` is deliberately OUTSIDE `ADDRESSEE_REQUIRED_ACTS`
// (anyone can say how they are), so ⑫⑤'s `underSpecified` never fires here.
// Nothing in this file hand-builds a floor-addressed request/offer/trade/invite
// in a 3+ roster — those are the acts that now come back unanswered-with-a-
// question, and they are pinned in `conversation-ambiguity.test.ts`.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { mulberry32, hashSeed } from "@shared/prng.js";
import {
  chooseSpeakerMove,
  speakInConversation,
  type ConvoDeps,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import {
  createConversation,
  joinConversation,
  memberOf,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import type { DialogueAct, ProjectionOpts } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  createCreatureWorld,
  seeItem,
  type CreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { knowsFact, perceiveFact } from "@shared/world-engine/interaction/behavior/facts.js";
import { NEUTRAL_PERSONALITY } from "@shared/world-engine/interaction/behavior/personality.js";
import { makeRelation } from "@shared/world-engine/interaction/behavior/relations.js";
import { LOCAL_PLAYER_CID, playerCidOf } from "@shared/world-engine/interaction/quest/player-identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANN = LOCAL_PLAYER_CID; // the local device's author
const BEN = playerCidOf("person-ben", "person-ann"); // a second player, remote
const BEAR = "bear";
const FOX = "fox";

/** The FIRST slot of any wheel — with one candidate that is always "you answer". */
const FIRST = () => 0;
/** The LAST slot, which the roulette always makes SILENCE. */
const LAST = () => 1 - 1e-9;
/** With two equal-urge candidates: the second one. (Silence is a rounding error
 *  beside two live urges, so the midpoint lands inside the second slot.) */
const SECOND = () => 0.5;

const opts = (world: CreatureWorld): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

const deps = (over: Partial<ConvoDeps> = {}): ConvoDeps => ({
  tick: 10,
  rng: FIRST,
  personalityOf: () => NEUTRAL_PERSONALITY,
  ...over,
});

/** A conversation with a roster, in one call. `[id, level]` pairs; everyone
 *  joins on tick 0, so the roster order is the `id` tiebreak. */
function convoOf(members: [string, "a" | "b" | "c"][]): ConversationState {
  const c = createConversation("convo", 0);
  for (const [id, level] of members) joinConversation(c, id, 0, level);
  return c;
}

const hi: DialogueAct = { kind: "how-are-you", glyph: "hi" };

// ---------------------------------------------------------------------------
// 1. IT WAS SAID — the record
// ---------------------------------------------------------------------------

describe("recordUtterance through the façade — the conversation finally has a history", () => {
  const world = () => createCreatureWorld([{ id: ANN }, { id: BEAR }], []);

  it("the utterance is recorded with an assigned seq, and the reply takes the next one", () => {
    const w = world();
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const turn = speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps());

    expect(turn.utterance).toMatchObject({ seq: 0, tick: 10, speakerId: ANN, addresseeIds: [BEAR] });
    expect(turn.response?.responderId).toBe(BEAR);
    // THE REPLY-RECORDING DECISION: a `tell` carrying ONLY the glyph — the one
    // kind whose stock meaning is "a bare disclosure, still a turn". No itemId,
    // no fact, no query, so nothing downstream can read it as a claim.
    expect(turn.response?.utterance).toMatchObject({
      seq: 1,
      speakerId: BEAR,
      addresseeIds: [ANN],
      act: { kind: "tell", glyph: turn.response!.result.responseGlyph },
    });
    expect(turn.response!.utterance!.act).not.toHaveProperty("itemId");
    expect(c.history.map((u) => u.seq)).toEqual([0, 1]);
    expect(c.nextSeq).toBe(2);
  });

  it("the seq keeps advancing across turns — which is what the seeded stream keys on", () => {
    const w = world();
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps());
    const second = speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps({ tick: 12 }));
    expect(second.utterance.seq).toBe(2);
    expect(c.nextSeq).toBe(4);
  });

  it("an ADDRESSEE-LESS line is recorded as spoken to the floor", () => {
    const w = world();
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const turn = speakInConversation(w, c, ANN, hi, undefined, opts(w), deps());
    expect(turn.utterance.addresseeIds).toBeUndefined();
  });

  it("the idle clock moves because somebody SPOKE — no host bump left to forget", () => {
    const w = world();
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    expect(c.lastActivityTick).toBe(0);
    speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps({ tick: 41 }));
    expect(c.lastActivityTick).toBe(41);
    // …and the responder is on the clock too, which is what makes it yield next
    // turn (the courtesy term — the reason a conversation circulates).
    expect(memberOf(c, BEAR)?.lastSpokeTick).toBe(41);
    expect(memberOf(c, BEAR)?.lastAddressedTick).toBe(41);
  });

  it("a reply with NO glyph is not recorded — a navigation press said nothing", () => {
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    // `ask-fact` with no query is the pure layer's "nothing to answer": events
    // only, no spoken line.
    const mute: DialogueAct = { kind: "ask-fact", glyph: "?" };
    const turn = speakInConversation(w, c, ANN, mute, BEAR, opts(w), deps());
    expect(turn.response?.responderId).toBe(BEAR);
    expect(turn.response?.result.responseGlyph).toBeUndefined();
    expect(turn.response?.utterance).toBeUndefined();
    expect(c.history).toHaveLength(1); // the question only
    // …and the responder was NOT charged a courtesy penalty for words it never said.
    expect(memberOf(c, BEAR)?.lastSpokeTick).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. WHO COULD ANSWER
// ---------------------------------------------------------------------------

describe("candidates — the speaker and the players are never arbitrated into replying", () => {
  it("a PLAYER in the room is never the responder, however the wheel lands", () => {
    // Ben is standing right there and is the only other author present. He is a
    // member in every other sense — he can be addressed, he overhears — but the
    // engine never puts words in his mouth: he answers by pressing his board.
    for (const rng of [FIRST, SECOND, LAST, mulberry32(hashSeed("convo", "players"))]) {
      const w = createCreatureWorld([{ id: ANN }, { id: BEN }, { id: BEAR }], []);
      const c = convoOf([
        [ANN, "c"],
        [BEN, "c"],
        [BEAR, "c"],
      ]);
      for (let i = 0; i < 40; i++) {
        const turn = speakInConversation(w, c, ANN, hi, undefined, opts(w), deps({ rng }));
        expect(turn.response?.responderId ?? BEAR).toBe(BEAR);
        expect(turn.silent.map((s) => s.id)).not.toContain(BEN);
      }
    }
  });

  it("a creature never answers ITSELF — and with no candidates there is no silence either", () => {
    // Bear talks to Ann. Ann is an author (not arbitrated) and Bear is the
    // speaker, so the candidate set is empty: nobody spoke, and nobody was
    // visibly silent, because a silence needs somebody to be silent.
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const turn = speakInConversation(w, c, BEAR, hi, ANN, opts(w), deps({ rng: FIRST }));
    expect(turn.response).toBeUndefined();
    expect(turn.silent).toEqual([]);
    expect(c.history).toHaveLength(1); // it was still SAID
  });
});

// ---------------------------------------------------------------------------
// 3. THE RESPONDER PHRASES AT ITS OWN RUNG
// ---------------------------------------------------------------------------

describe("each speaks at their level — a reply is the RESPONDER's sentence", () => {
  /** Bear (full sentences) and Fox (one word) in one room, both wanting a thing
   *  so `how-are-you` makes them say so. Spoken to the FLOOR, so their urges are
   *  identical and the draw alone picks between them. */
  const room = () => ({
    w: createCreatureWorld(
      [
        { id: ANN },
        { id: BEAR, needs: [{ itemId: "cookie1", value: 3 }] },
        { id: FOX, needs: [{ itemId: "cookie1", value: 3 }] },
      ],
      [{ id: "cookie1", ownerId: ANN, kind: "cookie" }],
    ),
    c: convoOf([
      [ANN, "c"],
      [BEAR, "c"], // roster order is the id tiebreak: bear, fox, player
      [FOX, "a"],
    ]),
  });

  it("the SAME question answered by two members comes back in two phrasings", () => {
    const a = room();
    const first = speakInConversation(a.w, a.c, ANN, hi, undefined, opts(a.w), deps({ rng: FIRST }));
    const b = room();
    const second = speakInConversation(b.w, b.c, ANN, hi, undefined, opts(b.w), deps({ rng: SECOND }));

    expect(first.response?.responderId).toBe(BEAR);
    expect(second.response?.responderId).toBe(FOX);

    const bearLine = first.response!.result.responseGlyph!;
    const foxLine = second.response!.result.responseGlyph!;
    // Bear is on rung "c" and Fox on rung "a" — the same want, two sentences.
    expect(bearLine.split(" + ").length).toBeGreaterThan(1);
    expect(foxLine.split(" + ")).toHaveLength(1);
    expect(bearLine).not.toBe(foxLine);
  });

  it("the rung comes off the ROSTER, not off the asker", () => {
    // Ann is on "c". If the reply were phrased at the asker's rung, Fox would
    // answer in full sentences — the exact demotion/overshoot per-member levels
    // exist to prevent (conversation.ts law 2).
    const b = room();
    expect(memberOf(b.c, ANN)?.level).toBe("c");
    const turn = speakInConversation(b.w, b.c, ANN, hi, undefined, opts(b.w), deps({ rng: SECOND }));
    expect(turn.response!.result.responseGlyph!.split(" + ")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. OVERHEARING — the multi-party payoff
// ---------------------------------------------------------------------------

describe("overhearing — spoken aloud in a circle is heard by the circle", () => {
  /** Bear knows where the cookie is; nobody else does. */
  const gossip = () => {
    const w = createCreatureWorld(
      [{ id: ANN }, { id: BEN }, { id: BEAR }, { id: FOX }],
      [{ id: "cookie1", ownerId: "cat", kind: "cookie" }],
    );
    seeItem(w, BEAR, "cookie1", { kind: "held", by: "cat" });
    const c = convoOf([
      [ANN, "c"],
      [BEN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    return { w, c };
  };
  const tellCookie: DialogueAct = { kind: "tell", itemId: "cookie1", glyph: "cookie" };

  it("a tell to THE FLOOR teaches every member — players included", () => {
    const { w, c } = gossip();
    for (const id of [ANN, BEN, FOX]) expect(w.creatures[id]!.knowledge.cookie1).toBeUndefined();

    speakInConversation(w, c, BEAR, tellCookie, undefined, opts(w), deps());

    // A child standing in the circle heard where the ball is; their board should
    // be able to say so next turn.
    for (const id of [ANN, BEN, FOX]) {
      expect(w.creatures[id]!.knowledge.cookie1).toEqual({ kind: "held", by: "cat" });
    }
  });

  it("a DIRECTLY ADDRESSED tell still teaches the bystanders", () => {
    const { w, c } = gossip();
    speakInConversation(w, c, BEAR, tellCookie, ANN, opts(w), deps());
    expect(w.creatures[ANN]!.knowledge.cookie1).toBeDefined(); // the addressee
    expect(w.creatures[BEN]!.knowledge.cookie1).toBeDefined(); // …and the room
    expect(w.creatures[FOX]!.knowledge.cookie1).toBeDefined();
  });

  it("a member's FRESHER belief is never clobbered by the teller's stale one", () => {
    const { w, c } = gossip();
    seeItem(w, FOX, "cookie1", { kind: "held", by: FOX }); // fox is holding it
    speakInConversation(w, c, BEAR, tellCookie, ANN, opts(w), deps());
    expect(w.creatures[FOX]!.knowledge.cookie1).toEqual({ kind: "held", by: FOX });
  });

  it("a tell-fact spreads through the same channel a sighting writes", () => {
    const w = createCreatureWorld([{ id: ANN }, { id: BEN }, { id: BEAR }, { id: FOX }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    const act: DialogueAct = {
      kind: "tell-fact",
      fact: { kind: "presence", creature: "mara", place: "kitchen" },
      glyph: "mara + in + kitchen",
    };
    speakInConversation(w, c, BEAR, act, ANN, opts(w), deps());
    for (const id of [ANN, BEN, FOX]) {
      expect(knowsFact(w, id, { kind: "presence", creature: "mara" })).toMatchObject({ place: "kitchen" });
    }
  });

  it("a claim ABOUT a listener is never absorbed by that listener", () => {
    // Told "Fox is hungry", Fox does not learn it — it is a claim to confirm or
    // correct, the same law selectAct's tell-fact arm applies to the addressee.
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }, { id: FOX }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    const act: DialogueAct = {
      kind: "tell-fact",
      fact: { kind: "condition", creature: FOX, condition: "hungry" },
      glyph: "fox + hungry",
    };
    speakInConversation(w, c, BEAR, act, ANN, opts(w), deps());
    expect(w.creatures[ANN]!.facts?.[`cond:${FOX}`]).toMatchObject({ condition: "hungry" });
    expect(w.creatures[FOX]!.facts?.[`cond:${FOX}`]).toBeUndefined();
  });

  // ─── 🚨 DOCUMENTED GAP ─────────────────────────────────────────────────────
  it("KNOWN GAP: an ANSWER still reaches only the asker", () => {
    // The knowledge spread on the `ask-fact` / `where-is` arms lives INSIDE
    // `selectAct`, aimed at the positional asker. So Bear answering Ann teaches
    // Ann and nobody else — even with Ben standing right there hearing it.
    //
    // This test exists to FAIL the day that changes, so the change is a choice.
    // Closing it means lifting the spread out of those arms (or returning the
    // answering fact on `ActResult`) — creature-dialogue.ts, which §4.7 does
    // not own. See `overhear`'s docblock.
    const w = createCreatureWorld([{ id: ANN }, { id: BEN }, { id: BEAR }], []);
    perceiveFact(w, BEAR, { kind: "condition", creature: "mara", condition: "hungry" });
    const c = convoOf([
      [ANN, "c"],
      [BEN, "c"],
      [BEAR, "c"],
    ]);
    const ask: DialogueAct = {
      kind: "ask-fact",
      query: { kind: "condition", creature: "mara" },
      glyph: "how + mara",
    };
    const turn = speakInConversation(w, c, ANN, ask, BEAR, opts(w), deps());
    expect(turn.response?.responderId).toBe(BEAR);

    expect(knowsFact(w, ANN, { kind: "condition", creature: "mara" })).toMatchObject({ condition: "hungry" });
    expect(knowsFact(w, BEN, { kind: "condition", creature: "mara" })).toBeNull(); // 🚨 the gap
  });
});

// ---------------------------------------------------------------------------
// 5. SILENCE IS VISIBLE
// ---------------------------------------------------------------------------

describe("a full silence always comes back with something to render", () => {
  it("nobody answers ⇒ no response, and a non-empty reaction set", () => {
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const turn = speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps({ rng: LAST }));
    expect(turn.response).toBeUndefined();
    expect(turn.silent).toEqual([{ id: BEAR, kind: "glance" }]);
    // The turn still HAPPENED — the board has something to re-present.
    expect(c.history).toHaveLength(1);
    expect(c.lastActivityTick).toBe(10);
  });

  it("a HOSTILE addressee turns away rather than glancing up", () => {
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const turn = speakInConversation(
      w,
      c,
      ANN,
      hi,
      BEAR,
      opts(w),
      deps({ rng: LAST, relationOf: () => makeRelation({ affinity: -0.8 }) }),
    );
    expect(turn.silent).toEqual([{ id: BEAR, kind: "turn-away" }]);
  });

  it("with ONE creature and the addressee boost, silence is rare — the intended texture", () => {
    // ~1%: the cause-and-effect guarantee in one number (ARBITRATION
    // silenceAddressed). Pinned so a retune of the dials is visible here.
    const rng = mulberry32(hashSeed("convo", "texture"));
    let quiet = 0;
    const draws = 400;
    for (let i = 0; i < draws; i++) {
      const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], []);
      const c = convoOf([
        [ANN, "c"],
        [BEAR, "c"],
      ]);
      if (!speakInConversation(w, c, ANN, hi, BEAR, opts(w), deps({ rng })).response) quiet++;
    }
    expect(quiet).toBeGreaterThan(0); // …but it DOES happen, and visibly
    expect(quiet / draws).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 6. DETERMINISM
// ---------------------------------------------------------------------------

describe("determinism — the same seeded stream replays the same turn", () => {
  const run = () => {
    const w = createCreatureWorld(
      [
        { id: ANN },
        { id: BEAR, needs: [{ itemId: "cookie1", value: 3 }] },
        { id: FOX, needs: [{ itemId: "cookie1", value: 2 }] },
      ],
      [{ id: "cookie1", ownerId: ANN, kind: "cookie" }],
    );
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "b"],
    ]);
    const rng = mulberry32(hashSeed(7, "convo", "convo", 0));
    const turns = [];
    for (let i = 0; i < 6; i++) {
      turns.push(speakInConversation(w, c, ANN, hi, undefined, opts(w), deps({ tick: 10 + i, rng })));
    }
    return { turns, history: c.history.map((u) => [u.seq, u.speakerId, u.act.glyph]) };
  };

  it("two runs of the same seed produce identical turns AND an identical transcript", () => {
    expect(run()).toEqual(run());
  });

  it("a different seed genuinely diverges (the stream is doing work)", () => {
    const pick = (seed: string) => {
      const rng = mulberry32(hashSeed("convo", seed));
      const w = createCreatureWorld([{ id: ANN }, { id: BEAR }, { id: FOX }], []);
      const c = convoOf([
        [ANN, "c"],
        [BEAR, "c"],
        [FOX, "c"],
      ]);
      return Array.from({ length: 12 }, (_, i) =>
        speakInConversation(w, c, ANN, hi, undefined, opts(w), deps({ tick: 10 + i, rng })).response
          ?.responderId ?? "",
      ).join(",");
    };
    expect(pick("alpha")).not.toBe(pick("omega"));
  });
});

// ---------------------------------------------------------------------------
// 7. chooseSpeakerMove — WHOM first
// ---------------------------------------------------------------------------

describe("chooseSpeakerMove — an NPC picks the person before the words", () => {
  const three = () => {
    const w = createCreatureWorld([{ id: BEAR }, { id: FOX }, { id: ANN }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    return { w, c };
  };

  /** Tally the addressee over `n` seeded draws ("" = addressed to the room). */
  const tally = (
    c: ConversationState,
    w: CreatureWorld,
    seed: string,
    n = 600,
    relationTo?: (id: string) => ReturnType<typeof makeRelation>,
  ): Record<string, number> => {
    const rng = mulberry32(hashSeed("move", seed));
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const move = chooseSpeakerMove(w, c, BEAR, opts(w), {
        personality: NEUTRAL_PERSONALITY,
        rng,
        ...(relationTo ? { relationTo } : {}),
      });
      const key = move?.addresseeId ?? "";
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  it("it produces a real move — an act aimed at somebody in the room", () => {
    const { w, c } = three();
    const move = chooseSpeakerMove(w, c, BEAR, opts(w), { personality: NEUTRAL_PERSONALITY, rng: FIRST });
    expect(move).not.toBeNull();
    expect([ANN, FOX, undefined]).toContain(move!.addresseeId);
    expect(typeof move!.act.glyph).toBe("string");
  });

  it("a speaker ALONE in a conversation has nobody to address", () => {
    const w = createCreatureWorld([{ id: BEAR }], []);
    const c = convoOf([[BEAR, "c"]]);
    expect(chooseSpeakerMove(w, c, BEAR, opts(w), { personality: NEUTRAL_PERSONALITY, rng: FIRST })).toBeNull();
  });

  it("THE LAST SPEAKER is preferred — a conversation is mostly a chain of replies", () => {
    const { w, c } = three();
    const flat = tally(c, w, "flat");
    // Fox speaks; now Bear's move is much more likely to be aimed back at Fox.
    speakInConversation(w, c, FOX, hi, undefined, opts(w), deps({ rng: LAST }));
    const after = tally(c, w, "flat");

    expect(flat[FOX]!).toBeGreaterThan(0);
    expect(flat[ANN]!).toBeGreaterThan(0);
    expect(after[FOX]!).toBeGreaterThan(flat[FOX]!);
    expect(after[FOX]!).toBeGreaterThan(after[ANN]!);
  });

  it("AFFINITY shifts it — a creature talks to whoever it likes", () => {
    const { w, c } = three();
    const even = tally(c, w, "aff");
    const fond = tally(c, w, "aff", 600, (id) => makeRelation({ affinity: id === ANN ? 1 : -1 }));
    expect(fond[ANN]!).toBeGreaterThan(even[ANN]!);
    expect(fond[ANN]!).toBeGreaterThan(fond[FOX]!);
  });

  it("ADDRESSING THE ROOM only exists in a room — never in a dyad", () => {
    const { w, c } = three();
    expect(tally(c, w, "room")[""]).toBeGreaterThan(0);

    const w2 = createCreatureWorld([{ id: BEAR }, { id: ANN }], []);
    const c2 = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]);
    const dyad = tally(c2, w2, "dyad");
    expect(dyad[""]).toBeUndefined(); // the only other person present IS the room
    expect(dyad[ANN]).toBe(600);
  });

  it("an act that NAMES a person is aimed at them, whatever the roulette intended", () => {
    // The room slot can win the draw and still come back addressed: "give me
    // your cookie" was aimed at a cookie-holder all along, and recording it as
    // floor-addressed would hand it to the wrong person at arbitration.
    const w = createCreatureWorld(
      [{ id: BEAR, needs: [{ itemId: "cookie1", value: 5 }] }, { id: FOX }, { id: ANN }],
      [{ id: "cookie1", ownerId: FOX, kind: "cookie" }],
    );
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    const rng = mulberry32(hashSeed("move", "named"));
    for (let i = 0; i < 200; i++) {
      const move = chooseSpeakerMove(w, c, BEAR, opts(w), { personality: NEUTRAL_PERSONALITY, rng })!;
      if (move.addresseeId === undefined) {
        // Only the addressee-free kinds ever come back unaddressed.
        expect(["tell", "tell-fact", "where-is", "ask-fact", "ask-directions", "directions-pick", "bye"]).toContain(
          move.act.kind,
        );
      }
    }
  });

  it("seeded-reproducible — the same stream gives the same move, every time", () => {
    const once = () => {
      const { w, c } = three();
      const rng = mulberry32(hashSeed("move", "repro"));
      return Array.from({ length: 20 }, () =>
        chooseSpeakerMove(w, c, BEAR, opts(w), { personality: NEUTRAL_PERSONALITY, rng }),
      );
    };
    expect(once()).toEqual(once());
  });
});
