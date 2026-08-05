/**
 * CONVERSATION IN MOTION ⑫⑤ — AMBIGUITY AS THE OUTCOME.
 *
 * ⑫③ made `memberAddressee` nullable, which is what finally lets a line be said
 * to NOBODY inside a circle. That created a real hole and left it open: a board
 * press in a roster of three with no channel spent went to the floor, and when
 * arbitration declined it, the faced creature just… didn't answer. A "…" over
 * its head, and no way for the child to tell "it heard me and had no answer"
 * from "whom did you mean?" — two entirely different things wearing one face.
 *
 * ⑤ closes it. The rule is one predicate over three facts (roster size, is there
 * an addressee, what KIND of act), and it lives in the module that already owns
 * "an absent addressee is the floor":
 *
 *   • `ADDRESSEE_REQUIRED_ACTS` — the acts that need a named person TO EXECUTE.
 *     Something has to move between two specific pairs of hands (`request`,
 *     `offer`, `trade`, `trade-pick`) or a specific body has to be committed
 *     (`invite`).
 *   • In a 3+ roster with no addressee, those come back `underSpecified`:
 *     RECORDED, then nothing. No arbitration, no reply, and — the bar §5 sets —
 *     NOT ONE `rng()` DRAW, so every seeded suite downstream stays in step.
 *   • The QUESTION FAMILY is deliberately out. "Does anyone know where the ball
 *     is?" is a fine thing to say to a room, and `defaultRelevance` already
 *     answers it with the voice that actually knows.
 *   • `how-are-you` is deliberately out too: anyone can say how they are.
 *
 * The host half is a MIRROR test — `quest-host.ts` cannot be value-imported here
 * (its import chain reaches JSX, which this jest project does not compile), so
 * the arm is pinned by re-stating the host's OWN expression, labelled with the
 * function it copies. Same discipline as `conversation-addressee.test.ts`.
 *
 * DB-free / GL-free — runs in `npm run test:engine`.
 */
import { describe, it, expect } from "@jest/globals";
import { mulberry32, hashSeed } from "@shared/prng.js";
import {
  ADDRESSEE_REQUIRED_ACTS,
  FLOOR_SAFE_ACTS,
  speakInConversation,
  type ConvoDeps,
  type SpokenTurn,
} from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import {
  createConversation,
  joinConversation,
  memberOf,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import type {
  DialogueAct,
  ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import type { SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import { WHO_DO_YOU_MEAN } from "@shared/world-engine/interaction/dialogue/host-lines.js";
import {
  createCreatureWorld,
  seeItem,
  type CreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { NEUTRAL_PERSONALITY } from "@shared/world-engine/interaction/behavior/personality.js";
import { LOCAL_PLAYER_CID, isPlayerCid } from "@shared/world-engine/interaction/quest/player-identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANN = LOCAL_PLAYER_CID; // the child at the board
const BEAR = "bear";
const FOX = "fox";

/** The FIRST slot of any wheel — with live candidates, "somebody answers". */
const FIRST = () => 0;

const opts = (world: CreatureWorld): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

const deps = (over: Partial<ConvoDeps> = {}): ConvoDeps => ({
  tick: 10,
  rng: FIRST,
  personalityOf: () => NEUTRAL_PERSONALITY,
  ...over,
});

/** A stream that COUNTS. The ⑤ claim is not "the draw doesn't matter" — it is
 *  that the draw never happens, because one stolen draw shifts every later turn
 *  in a seeded transcript. */
function countingRng(): { rng: () => number; draws: () => number } {
  let n = 0;
  return {
    rng: () => {
      n++;
      return 0;
    },
    draws: () => n,
  };
}

function convoOf(members: [string, SyntaxLevel][]): ConversationState {
  const c = createConversation("convo", 0);
  for (const [id, level] of members) joinConversation(c, id, 0, level);
  return c;
}

/** ANN + BEAR + FOX, with the cookie in Bear's hands and everyone knowing it.
 *  THE shape ⑫ is about: three people, so "whom do you mean" is a question that
 *  can be asked. */
function circle(): { w: CreatureWorld; c: ConversationState } {
  const w = createCreatureWorld(
    [{ id: ANN }, { id: BEAR }, { id: FOX }],
    [{ id: "cookie1", ownerId: BEAR, kind: "cookie" }],
  );
  for (const id of [ANN, FOX]) seeItem(w, id, "cookie1", { kind: "held", by: BEAR });
  return {
    w,
    c: convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]),
  };
}

/** ANN + BEAR alone — law ④'s shape, where nothing is ambiguous. */
function dyad(): { w: CreatureWorld; c: ConversationState } {
  const w = createCreatureWorld([{ id: ANN }, { id: BEAR }], [{ id: "cookie1", ownerId: BEAR, kind: "cookie" }]);
  seeItem(w, ANN, "cookie1", { kind: "held", by: BEAR });
  return {
    w,
    c: convoOf([
      [ANN, "c"],
      [BEAR, "c"],
    ]),
  };
}

const REQUEST: DialogueAct = { kind: "request", itemId: "cookie1", glyph: "i_me + want + cookie" };
const OFFER: DialogueAct = { kind: "offer", itemId: "cookie1", glyph: "i_me + give + cookie" };
const INVITE: DialogueAct = { kind: "invite", verb: "eat", glyph: "eat + with + i_me" };
const TRADE: DialogueAct = { kind: "trade", itemId: "cookie1", glyph: "cookie + for + apple" };
const TRADE_PICK: DialogueAct = { kind: "trade-pick", itemId: "cookie1", glyph: "cookie + for + apple" };
const WHERE_IS: DialogueAct = { kind: "where-is", itemId: "cookie1", glyph: "where + cookie" };
const HOW_ARE_YOU: DialogueAct = { kind: "how-are-you", glyph: "hi" };

// ---------------------------------------------------------------------------
// 1. THE SET ITSELF
// ---------------------------------------------------------------------------

describe("ADDRESSEE_REQUIRED_ACTS — the acts that need a named person to EXECUTE", () => {
  it("is exactly the five hand-to-hand / body-committing acts", () => {
    // Pinned as a whole, not member by member, because the VALUE of this set is
    // how tight it is. Widening it is a product decision (more sentences come
    // back unanswered-with-a-question), and it should read as one here.
    expect([...ADDRESSEE_REQUIRED_ACTS].sort()).toEqual(
      ["invite", "offer", "request", "trade", "trade-pick"].sort(),
    );
  });

  it("🚨 DISJOINT FROM `FLOOR_SAFE_ACTS` — nothing is both", () => {
    // An act cannot be "fine to say to nobody" AND "impossible to execute
    // without somebody". If this ever fails, one of the two lists has drifted
    // and a line is about to be both answered and questioned.
    const both = [...ADDRESSEE_REQUIRED_ACTS].filter((k) => FLOOR_SAFE_ACTS.has(k));
    expect(both).toEqual([]);
  });

  it("the QUESTION FAMILY is out, on purpose — a room answers a question well", () => {
    for (const kind of ["where-is", "ask-fact", "ask-directions", "what-doing", "where-going"] as const) {
      expect(ADDRESSEE_REQUIRED_ACTS.has(kind)).toBe(false);
    }
  });

  it("`how-are-you` is out — anyone can say how they are", () => {
    // It NAMES the second person (so it is not floor-safe either, and an NPC's
    // remark to the room gets re-aimed by `chooseSpeakerMove`), but executing it
    // needs nobody in particular. The two tests are different questions, which
    // is why the two sets are disjoint without being complements.
    expect(ADDRESSEE_REQUIRED_ACTS.has("how-are-you")).toBe(false);
    expect(FLOOR_SAFE_ACTS.has("how-are-you")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. THE RULE — a floor request in a circle
// ---------------------------------------------------------------------------

describe("⑫⑤ a floor REQUEST in a room of three — recorded, unanswered, questioned", () => {
  it("comes back `underSpecified`, with no response and no silent reactions", () => {
    const { w, c } = circle();
    const turn = speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps());
    expect(turn.underSpecified).toBe(true);
    expect(turn.response).toBeUndefined();
    // NOT a silence: nobody declined to answer, because nobody was ever asked.
    // The host renders those two differently — a "…" thought vs a spoken
    // question — and conflating them is the bug ⑤ exists to remove.
    expect(turn.silent).toEqual([]);
  });

  it("★ IT WAS STILL SAID — the utterance is on the record, clocks and all", () => {
    const { w, c } = circle();
    const turn = speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps({ tick: 41 }));
    expect(turn.utterance).toMatchObject({ seq: 0, tick: 41, speakerId: ANN, act: REQUEST });
    expect(turn.utterance.addresseeIds).toBeUndefined(); // …to the floor
    expect(c.history).toHaveLength(1);
    expect(c.nextSeq).toBe(1);
    // The conversation's idle clock moved, because somebody spoke. A turn that
    // "didn't happen" would let a circle time out under a child who is talking.
    expect(c.lastActivityTick).toBe(41);
    expect(memberOf(c, ANN)?.lastSpokeTick).toBe(41);
  });

  it("🚨 NOT ONE rng() DRAW — the byte-identity bar (§5)", () => {
    // ONE seeded stream per turn, keyed on the seq. A single stolen draw here
    // would shift every subsequent turn of every seeded transcript, which is why
    // the return happens BEFORE the arbitration rather than after it.
    for (const act of [REQUEST, OFFER, INVITE, TRADE, TRADE_PICK]) {
      const { w, c } = circle();
      const counter = countingRng();
      const turn = speakInConversation(w, c, ANN, act, undefined, opts(w), deps({ rng: counter.rng }));
      expect(turn.underSpecified).toBe(true);
      expect(counter.draws()).toBe(0);
    }
  });

  it("…and a floor line that IS answered does draw — the counter is measuring something", () => {
    const { w, c } = circle();
    const counter = countingRng();
    speakInConversation(w, c, ANN, WHERE_IS, undefined, opts(w), deps({ rng: counter.rng }));
    expect(counter.draws()).toBeGreaterThan(0);
  });

  it("every member of the set behaves the same way", () => {
    for (const act of [REQUEST, OFFER, INVITE, TRADE, TRADE_PICK]) {
      const { w, c } = circle();
      const turn = speakInConversation(w, c, ANN, act, undefined, opts(w), deps());
      expect([act.kind, turn.underSpecified]).toEqual([act.kind, true]);
      expect(turn.response).toBeUndefined();
    }
  });

  it("an NPC speaker gets the same verdict — the rule is about the ROSTER, not the mouth", () => {
    const { w, c } = circle();
    const turn = speakInConversation(w, c, BEAR, OFFER, undefined, opts(w), deps());
    expect(turn.underSpecified).toBe(true);
    expect(turn.response).toBeUndefined();
  });

  it("a FOURTH person changes nothing — three is already a room", () => {
    const w = createCreatureWorld([{ id: ANN }, { id: BEAR }, { id: FOX }, { id: "cat" }], []);
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
      ["cat", "c"],
    ]);
    expect(speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps()).underSpecified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. THE THREE THINGS THAT MUST STILL WORK
// ---------------------------------------------------------------------------

describe("law ④ — a conversation of two needs no addressing at all", () => {
  it("★ THE SAME REQUEST IN A DYAD ANSWERS NORMALLY ★", () => {
    // There is one other person; every channel would be answering a question
    // nobody can ask. Every rule in this chapter is a rule about the THIRD
    // person, and this is where that is enforced.
    const { w, c } = dyad();
    const turn = speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(turn.response?.responderId).toBe(BEAR);
    expect(turn.response?.result.responseGlyph).toBeTruthy();
  });

  it("…and so does every other addressee-required act", () => {
    for (const act of [OFFER, INVITE, TRADE, TRADE_PICK]) {
      const { w, c } = dyad();
      const turn = speakInConversation(w, c, ANN, act, undefined, opts(w), deps());
      expect([act.kind, turn.underSpecified]).toEqual([act.kind, undefined]);
    }
  });

  it("a roster that SHRINKS to two answers again, mid-conversation", () => {
    const { w, c } = circle();
    expect(speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps()).underSpecified).toBe(true);
    c.members = c.members.filter((m) => m.id !== FOX);
    const turn = speakInConversation(w, c, ANN, REQUEST, undefined, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(turn.response?.responderId).toBe(BEAR);
  });
});

describe("the carve-outs — the lines a room is GOOD at", () => {
  it("★ a floor WHERE-IS still arbitrates and still answers ★", () => {
    // "Does anyone know where the ball is?" — `defaultRelevance` weights the
    // member who actually knows, which is exactly what a floor question is for.
    const { w, c } = circle();
    const turn = speakInConversation(w, c, ANN, WHERE_IS, undefined, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(turn.response?.responderId).toBeDefined();
    expect(turn.response?.result.responseGlyph).toBeTruthy();
  });

  it("…and the ROOM favours the member who KNOWS, over many seeded draws", () => {
    // The reason the question family is exempt, stated as a frequency rather
    // than as an opinion: Bear holds the cookie (relevance 1.0), Fox has never
    // seen it (the floor, 0.1), and `defaultRelevance` is what makes the right
    // voice answer without anybody having to be addressed.
    const rng = mulberry32(hashSeed("ambiguity", "where"));
    const tally: Record<string, number> = { [BEAR]: 0, [FOX]: 0, "": 0 };
    for (let i = 0; i < 400; i++) {
      const w = createCreatureWorld(
        [{ id: ANN }, { id: BEAR }, { id: FOX }],
        [{ id: "cookie1", ownerId: BEAR, kind: "cookie" }],
      );
      const c = convoOf([
        [ANN, "c"],
        [BEAR, "c"],
        [FOX, "c"],
      ]);
      const turn = speakInConversation(w, c, ANN, WHERE_IS, undefined, opts(w), deps({ rng }));
      tally[turn.response?.responderId ?? ""]!++;
    }
    expect(tally[BEAR]!).toBeGreaterThan(tally[FOX]!);
    // …and a floor question DOES sometimes land on nobody, which is the texture
    // the chapter says is already tuned (§4 ⑤): the ambiguity was reachable for
    // questions all along.
    expect(tally[""]!).toBeGreaterThan(0);
  });

  it("★ a floor HOW-ARE-YOU still answers — the carve-out's pin ★", () => {
    // `conversation-turns.test.ts` leans on this everywhere: anyone can say how
    // they are, so a floor greeting is answered by whoever feels like it.
    const { w, c } = circle();
    const turn = speakInConversation(w, c, ANN, HOW_ARE_YOU, undefined, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(turn.response?.result.responseGlyph).toBeTruthy();
  });

  it("★ an ADDRESSED request answers normally, in any size of room ★", () => {
    // The whole feature is about the ABSENCE of an addressee. Spend any channel
    // — a look, a name, a dyad — and nothing here applies.
    const { w, c } = circle();
    const turn = speakInConversation(w, c, ANN, REQUEST, BEAR, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(turn.response?.responderId).toBe(BEAR);
    expect(turn.utterance.addresseeIds).toEqual([BEAR]);
  });

  it("a `tell` to the floor still teaches the room — statements were never the problem", () => {
    const w = createCreatureWorld(
      [{ id: ANN }, { id: BEAR }, { id: FOX }],
      [{ id: "cookie1", ownerId: "cat", kind: "cookie" }],
    );
    seeItem(w, BEAR, "cookie1", { kind: "held", by: "cat" });
    const c = convoOf([
      [ANN, "c"],
      [BEAR, "c"],
      [FOX, "c"],
    ]);
    const tell: DialogueAct = { kind: "tell", itemId: "cookie1", glyph: "cookie" };
    const turn = speakInConversation(w, c, BEAR, tell, undefined, opts(w), deps());
    expect(turn.underSpecified).toBeUndefined();
    expect(w.creatures[FOX]!.knowledge.cookie1).toEqual({ kind: "held", by: "cat" });
  });
});

// ---------------------------------------------------------------------------
// 4. THE HOST — what the child actually hears (mirror)
// ---------------------------------------------------------------------------

/** MIRROR of `HostConversation` — the board's aim (`faced`) is NOT the
 *  sentence's addressee (⑫③). */
interface HostConversation {
  id: string;
  nodeId: string;
  convo: ConversationState;
  group?: object;
  faced?: Map<string, string>;
}

/**
 * The two arms of `runCreatureAct` that ⑤ is about, and nothing else: the
 * `confused` arm (which DROPS the speaker's rung) and the new `underSpecified`
 * arm (which must not, and which speaks instead).
 */
class HostMirror {
  /** MIRROR of `sayNpcLine` — the SPEECH chokepoint: voiced, and mirrored to
   *  every peer as an avatar `say`. */
  readonly said: { cid: string; glyph: string }[] = [];
  /** MIRROR of `showNpcThought` — the "…" bubble. DELIBERATELY not speech. */
  readonly thoughts: string[] = [];
  /** MIRROR of `presentCreatureTurn(line, present, memberCid)`. */
  readonly presented: { line?: string; speak: boolean; memberCid: string }[] = [];

  /** MIRROR of `facedBy(c, memberCid)` — always answers somebody. */
  facedBy(c: HostConversation, memberCid: string): string {
    const faced = c.faced?.get(memberCid);
    if (faced && memberOf(c.convo, faced)) return faced;
    if (!c.group) return c.nodeId;
    return c.convo.members.find((m) => !isPlayerCid(m.id))?.id ?? c.nodeId;
  }

  /** MIRROR of `levelOf(c, memberCid)` — this member's own rung. */
  levelOf(c: HostConversation, memberCid: string): SyntaxLevel {
    return memberOf(c.convo, memberCid)?.level ?? "b";
  }

  /** MIRROR of `runCreatureAct(act, speakerCid, addresseeOverride)`, reduced to
   *  the arms ⑤ touches. Returns the turn for the assertions. */
  runCreatureAct(
    w: CreatureWorld,
    c: HostConversation,
    speakerCid: string,
    act: DialogueAct,
    addresseeId?: string,
    over: Partial<ConvoDeps> = {},
  ): SpokenTurn | null {
    const nodeId = addresseeId ?? this.facedBy(c, speakerCid);
    if (act.kind === "confused") {
      // The rung drop, verbatim: "I don't understand" demotes the ONE member
      // who said it.
      const me = memberOf(c.convo, speakerCid);
      if (me) me.level = me.level === "c" ? "b" : "a";
      this.presented.push({ speak: true, memberCid: speakerCid });
      return null;
    }
    const spoken = speakInConversation(w, c.convo, speakerCid, act, addresseeId, opts(w), deps(over));
    // ★ ⑫⑤ — the arm under test.
    if (spoken.underSpecified) {
      this.said.push({ cid: nodeId, glyph: WHO_DO_YOU_MEAN[this.levelOf(c, nodeId)] });
      this.presented.push({ speak: false, memberCid: speakerCid });
      return spoken;
    }
    if (!spoken.response) {
      for (const r of spoken.silent) this.thoughts.push(r.id);
      this.presented.push({ speak: false, memberCid: speakerCid });
      return spoken;
    }
    this.presented.push({
      ...(spoken.response.result.responseGlyph ? { line: spoken.response.result.responseGlyph } : {}),
      speak: true,
      memberCid: speakerCid,
    });
    return spoken;
  }
}

/** The circle as the HOST holds it: a group record, the child's board aimed at
 *  Bear, Fox standing there too. */
function hostCircle(): { h: HostMirror; w: CreatureWorld; g: HostConversation } {
  const { w, c } = circle();
  return {
    h: new HostMirror(),
    w,
    g: { id: "circle_1", nodeId: BEAR, convo: c, group: {}, faced: new Map([[ANN, BEAR]]) },
  };
}

describe("⑫⑤ the host — the world narrows, it never rejects", () => {
  it("★ THE CREATURE ASKS BACK — the shipped not-understood line, out loud ★", () => {
    const { h, w, g } = hostCircle();
    h.runCreatureAct(w, g, ANN, REQUEST);
    // `i_me + understand.not`, the same answer three other missing-target cases
    // already give, and already localized in en/es/he/pt.
    expect(h.said).toEqual([{ cid: BEAR, glyph: WHO_DO_YOU_MEAN.c }]);
    expect(h.said[0]!.glyph).toContain("understand.not");
  });

  it("…spoken over `facedBy` — what the board is aimed at, since nobody was named", () => {
    const { h, w, g } = hostCircle();
    g.faced!.set(ANN, FOX); // the child re-aims the board at Fox
    h.runCreatureAct(w, g, ANN, REQUEST);
    expect(h.said).toEqual([{ cid: FOX, glyph: WHO_DO_YOU_MEAN.c }]);
  });

  it("…and at THAT creature's own rung, not the game's default", () => {
    const { h, w, g } = hostCircle();
    memberOf(g.convo, BEAR)!.level = "a";
    h.runCreatureAct(w, g, ANN, REQUEST);
    expect(h.said).toEqual([{ cid: BEAR, glyph: WHO_DO_YOU_MEAN.a }]);
  });

  it("★ 🚨 NOT THE `confused` ACT — no rung drop for a good sentence ★", () => {
    // Being ambiguous about whom you meant is not a comprehension failure on
    // the child's part: they said a perfectly good sentence into a room with
    // three people in it. `confused`'s arm would demote them for it.
    const { h, w, g } = hostCircle();
    const before = g.convo.members.map((m) => [m.id, m.level]);
    h.runCreatureAct(w, g, ANN, REQUEST);
    expect(g.convo.members.map((m) => [m.id, m.level])).toEqual(before);
    expect(memberOf(g.convo, ANN)!.level).toBe("c");

    // …and this is what the `confused` arm does, for contrast: it demotes the
    // speaker and says nothing at all.
    const confused = new HostMirror();
    confused.runCreatureAct(w, g, ANN, { kind: "confused", glyph: "confused" });
    expect(memberOf(g.convo, ANN)!.level).toBe("b");
    expect(confused.said).toEqual([]);
  });

  it("★ THE BOARD COMES BACK, silently — the answer is one press away ★", () => {
    // The question above IS this turn's spoken line, so the re-present must not
    // speak over it. ⑫⑥ adds the addressee's NAME to that board; until then the
    // two ways out are re-aiming the board and the dwell `address` cell (⑫④).
    const { h, w, g } = hostCircle();
    h.runCreatureAct(w, g, ANN, REQUEST);
    expect(h.presented).toEqual([{ speak: false, memberCid: ANN }]);
  });

  it("★ NOT the '…' silent thought — that was the bug ★", () => {
    // Before ⑤ this landed as a thought over whoever came closest to answering,
    // which reads as "it heard me and had no answer" — a different and wrong
    // thing to tell a child who simply hasn't named anybody yet.
    const { h, w, g } = hostCircle();
    h.runCreatureAct(w, g, ANN, REQUEST);
    expect(h.thoughts).toEqual([]);
  });

  it("a genuine SILENCE still shows the thought and says nothing — the two stay distinct", () => {
    // Same room, an answerable act, and a wheel landing on nobody: the old
    // rendering, untouched. ⑤ narrowed what reaches it; it did not replace it.
    const { h, w, g } = hostCircle();
    h.runCreatureAct(w, g, ANN, HOW_ARE_YOU, undefined, { rng: () => 1 - 1e-9 });
    expect(h.said).toEqual([]);
    expect(h.thoughts.length).toBeGreaterThan(0);
  });

  it("a DYAD never reaches the arm — ⑦ byte-identical", () => {
    const { w, c } = dyad();
    const h = new HostMirror();
    const d: HostConversation = { id: BEAR, nodeId: BEAR, convo: c };
    const turn = h.runCreatureAct(w, d, ANN, REQUEST);
    expect(turn?.underSpecified).toBeUndefined();
    expect(turn?.response?.responderId).toBe(BEAR);
    expect(h.said).toEqual([]); // no question back…
    expect(h.presented[0]?.speak).toBe(true); // …the creature's own answer IS the line
  });

  it("an ADDRESSED request in the circle answers instead of asking back", () => {
    const { h, w, g } = hostCircle();
    const turn = h.runCreatureAct(w, g, ANN, REQUEST, BEAR);
    expect(turn?.response?.responderId).toBe(BEAR);
    expect(h.said).toEqual([]);
    expect(h.presented[0]?.speak).toBe(true);
  });
});
