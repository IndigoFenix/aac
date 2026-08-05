// WHO ANSWERS — the fuzzy response arbitration (respond.ts). Pure: an urge per
// member, one seeded roulette against SILENCE, and a visible reaction from
// everyone who didn't get the floor. No world for the arbitration half, a tiny
// hand-built one for the relevance ladder. See
// planning-docs/games/world-engine/multi-entity-conversations.md §3c.

import { describe, it, expect } from "@jest/globals";
import { mulberry32, hashSeed } from "@shared/prng.js";
import {
  ARBITRATION,
  arbitrateResponse,
  defaultRelevance,
  responseUrge,
  type ResponseCandidate,
  type UrgeInput,
} from "@shared/world-engine/interaction/dialogue/respond.js";
import {
  DEFAULT_ENGAGEMENT,
  type ConvoMember,
  type Utterance,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import type { DialogueAct } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import {
  createCreatureWorld,
  learnProvides,
  seeItem,
  type CreatureId,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { perceiveFact } from "@shared/world-engine/interaction/behavior/facts.js";
import { NEUTRAL_PERSONALITY, makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION, makeRelation } from "@shared/world-engine/interaction/behavior/relations.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const member = (over: Partial<ConvoMember> = {}): ConvoMember => ({
  id: "ben",
  joinedTick: 0,
  level: "c",
  engagement: DEFAULT_ENGAGEMENT,
  ...over,
});

const act = (over: Partial<DialogueAct> = {}): DialogueAct => ({ kind: "how-are-you", glyph: "hi", ...over });

const said = (over: Partial<Utterance> = {}): Utterance => ({
  seq: 0,
  tick: 10,
  speakerId: "ann",
  act: act(),
  ...over,
});

/** A neutral member of a neutral conversation, hearing a neutral remark. All the
 *  urge tests move exactly one dial off this point. */
const urge = (over: Partial<UrgeInput> = {}): number =>
  responseUrge({
    member: member(),
    utterance: said(),
    tick: 10,
    personality: NEUTRAL_PERSONALITY,
    relation: DEFAULT_RELATION,
    relevance: 0.5,
    ...over,
  });

/** `attend` at every neutral dial: 0.45·0.5 + 0.35·0.5 + 0.2·1. Pinned here so a
 *  change to the willingness gate shows up as ONE failing expectation and not as
 *  a dozen mysterious ones. */
const NEUTRAL_ATTEND = 0.6;

/** Run the wheel `n` times off ONE seeded stream and tally who got the floor
 *  ("" = silence). Seeded, so these frequencies are facts about the code, not
 *  samples that might come out differently tomorrow. */
function tally(
  candidates: ReadonlyArray<ResponseCandidate>,
  opts: { addressedIds?: readonly CreatureId[]; seed: string; draws?: number },
): Record<string, number> {
  const rng = mulberry32(hashSeed("convo", opts.seed));
  const counts: Record<string, number> = {};
  const draws = opts.draws ?? 500;
  for (let i = 0; i < draws; i++) {
    const { responderId } = arbitrateResponse(candidates, { addressedIds: opts.addressedIds, rng });
    const key = responderId ?? "";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// responseUrge — the four factors
// ---------------------------------------------------------------------------

describe("responseUrge — addressed ≫ floor ≫ aimed at someone else", () => {
  it("scores the three modes at 1.0 / 0.35 / 0.15 of the same base", () => {
    const direct = urge({ utterance: said({ addresseeIds: ["ben"] }) });
    const floor = urge({ utterance: said() });
    const other = urge({ utterance: said({ addresseeIds: ["cal"] }) });

    const base = NEUTRAL_ATTEND * 0.75; // content at relevance 0.5, courtesy 1
    expect(direct).toBeCloseTo(ARBITRATION.addressedDirect * base, 10);
    expect(floor).toBeCloseTo(ARBITRATION.addressedFloor * base, 10);
    expect(other).toBeCloseTo(ARBITRATION.addressedOther * base, 10);
    expect(direct).toBeGreaterThan(floor);
    expect(floor).toBeGreaterThan(other);
  });

  // recordUtterance normalizes an empty addressee list away; the urge has to
  // read it the same way or a caller that builds one either way gets two
  // different conversations.
  it("an EMPTY addressee list is the floor, exactly like an absent one", () => {
    expect(urge({ utterance: said({ addresseeIds: [] }) })).toBeCloseTo(urge({ utterance: said() }), 10);
  });

  it("being one of SEVERAL addressees is still being addressed", () => {
    expect(urge({ utterance: said({ addresseeIds: ["cal", "ben"] }) })).toBeCloseTo(
      urge({ utterance: said({ addresseeIds: ["ben"] }) }),
      10,
    );
  });

  // Nobody answers themselves. Courtesy alone would only dampen the speaker
  // (it just spoke), and "dampened" is not the law.
  it("a member has NO urge to answer its own utterance", () => {
    expect(urge({ utterance: said({ speakerId: "ben", addresseeIds: ["ben"] }) })).toBe(0);
  });
});

describe("responseUrge — content is monotone and floored at half", () => {
  it("rises with relevance, from half the gate to all of it", () => {
    const direct = { utterance: said({ addresseeIds: ["ben"] }) };
    const none = urge({ ...direct, relevance: 0 });
    const some = urge({ ...direct, relevance: 0.5 });
    const all = urge({ ...direct, relevance: 1 });

    expect(none).toBeCloseTo(NEUTRAL_ATTEND * ARBITRATION.contentBase, 10);
    expect(all).toBeCloseTo(NEUTRAL_ATTEND, 10);
    expect(none).toBeLessThan(some);
    expect(some).toBeLessThan(all);
  });

  // "I have nothing to add" is a reason to be quieter, never a reason to be mute.
  it("zero relevance never zeroes the urge", () => {
    expect(urge({ relevance: 0 })).toBeGreaterThan(0);
  });
});

describe("responseUrge — the attend gate carries all three of its dials", () => {
  const direct = { utterance: said({ addresseeIds: ["ben"] }) };

  it("rises with EXPRESSIVENESS (a quiet creature stays quiet)", () => {
    const quiet = urge({ ...direct, personality: makePersonality({ expressiveness: 0 }) });
    const loud = urge({ ...direct, personality: makePersonality({ expressiveness: 1 }) });
    expect(quiet).toBeLessThan(urge(direct));
    expect(urge(direct)).toBeLessThan(loud);
  });

  it("rises with AFFINITY toward the speaker", () => {
    const cold = urge({ ...direct, relation: makeRelation({ affinity: -1 }) });
    const fond = urge({ ...direct, relation: makeRelation({ affinity: 1 }) });
    expect(cold).toBeLessThan(urge(direct));
    expect(urge(direct)).toBeLessThan(fond);
  });

  it("rises with ENGAGEMENT — the one LIVE term in the family", () => {
    const absent = urge({ ...direct, member: member({ engagement: 0 }) });
    const here = urge({ ...direct, member: member({ engagement: 1 }) });
    expect(absent).toBeLessThan(here);
  });
});

describe("responseUrge — courtesy: I just spoke, so I yield", () => {
  const direct = { utterance: said({ addresseeIds: ["ben"] }), tick: 10 };

  it("a member who NEVER spoke carries no penalty", () => {
    expect(member().lastSpokeTick).toBeUndefined();
    expect(urge(direct)).toBeCloseTo(NEUTRAL_ATTEND * 0.75, 10);
  });

  it("suppresses the member who JUST spoke", () => {
    const justSpoke = urge({ ...direct, member: member({ lastSpokeTick: 10 }) });
    expect(justSpoke).toBeLessThan(urge(direct));
    // depth = 0.3 + 0.5·patience(0.5) = 0.55 ⇒ courtesy 0.45
    expect(justSpoke).toBeCloseTo(NEUTRAL_ATTEND * 0.75 * 0.45, 10);
  });

  it("decays back toward no penalty as ticks pass", () => {
    const at = (spokeAgo: number) => urge({ ...direct, member: member({ lastSpokeTick: 10 - spokeAgo }) });
    const ladder = [0, 1, 2, 4, 8, 16, 40].map(at);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
    expect(ladder.at(-1)!).toBeCloseTo(urge(direct), 4); // effectively recovered
  });

  // A peer's utterance can be delivered late, making a member's last word look
  // like it happened in the future. Clamping to "just spoke" is the conservative
  // direction: at worst a creature is briefly too polite.
  it("a negative gap reads as JUST SPOKE, never as a bonus", () => {
    expect(urge({ ...direct, member: member({ lastSpokeTick: 40 }) })).toBeCloseTo(
      urge({ ...direct, member: member({ lastSpokeTick: 10 }) }),
      10,
    );
  });

  it("PATIENCE deepens the yield and holds it longer", () => {
    const at = (patience: number, spokeAgo: number) =>
      urge({
        ...direct,
        personality: makePersonality({ patience }),
        member: member({ lastSpokeTick: 10 - spokeAgo }),
      });

    // Deeper, at every distance from the last word.
    for (const ago of [0, 2, 4, 8]) expect(at(1, ago)).toBeLessThan(at(0, ago));

    // And LONGER: the tick at which the yield has all but worn off (urge back
    // within 10% of unpenalized) arrives later for the patient creature.
    const full = urge(direct);
    const recoversAt = (patience: number) => {
      for (let ago = 0; ago <= 60; ago++) if (at(patience, ago) > full * 0.9) return ago;
      return Infinity;
    };
    expect(recoversAt(1)).toBeGreaterThan(recoversAt(0));
  });
});

describe("responseUrge — total and clamped", () => {
  it("clamps to 1 however far out of range the inputs are", () => {
    const u = responseUrge({
      member: member({ engagement: 99 }),
      utterance: said({ addresseeIds: ["ben"] }),
      tick: 10,
      personality: { ...NEUTRAL_PERSONALITY, expressiveness: 9 },
      relation: { affinity: 9, trust: 9, authority: 9 },
      relevance: 9,
    });
    expect(u).toBe(1);
  });

  it("clamps to 0 from below, and never returns a NaN", () => {
    const u = responseUrge({
      member: member({ engagement: -5 }),
      utterance: said({ addresseeIds: ["cal"] }),
      tick: 10,
      personality: { ...NEUTRAL_PERSONALITY, expressiveness: -5 },
      relation: { affinity: -5, trust: -5, authority: -5 },
      relevance: -5,
    });
    expect(u).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(u)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// arbitrateResponse — the wheel
// ---------------------------------------------------------------------------

describe("arbitrateResponse — nobody present", () => {
  it("zero candidates is neither a responder nor a silence", () => {
    const out = arbitrateResponse([], { rng: () => 0.5 });
    expect(out).toEqual({ silent: [] });
    expect(out.responderId).toBeUndefined();
  });

  it("does not consume a draw when there is nobody to ask", () => {
    let draws = 0;
    arbitrateResponse([], {
      rng: () => {
        draws++;
        return 0.5;
      },
    });
    expect(draws).toBe(0);
  });
});

describe("arbitrateResponse — the addressee answers (cause and effect stays learnable)", () => {
  // THE law. Ann asks Ben something, at every dial neutral: urge 0.45 against a
  // silence weight of 0.08 × 0.05 = 0.004, so Ben answers ~99% of the time.
  it("answers ≥ 90% of 500 seeded draws when asked directly", () => {
    const ben = urge({ utterance: said({ addresseeIds: ["ben"] }) });
    expect(ben).toBeCloseTo(0.45, 10);

    const counts = tally([{ id: "ben", urge: ben }], { addressedIds: ["ben"], seed: "addressee-dyad" });
    expect((counts.ben ?? 0) / 500).toBeGreaterThanOrEqual(0.9);
  });

  // And with a bystander in the room. Ben is asked something he can answer
  // (relevance 0.8 ⇒ urge 0.54); Cal is uninvolved (aimed-at-other × floor
  // relevance ⇒ 0.0495). Analytically P(Ben) = 0.910, P(Cal) = 0.083.
  it("still answers ≥ 88% with a neutral bystander who could barge in", () => {
    const ben = urge({ utterance: said({ addresseeIds: ["ben"] }), relevance: 0.8 });
    const cal = urge({
      member: member({ id: "cal" }),
      utterance: said({ addresseeIds: ["ben"] }),
      relevance: ARBITRATION.relevanceFloor,
    });
    expect(ben).toBeCloseTo(0.54, 10);
    expect(cal).toBeCloseTo(0.0495, 10);

    const counts = tally(
      [
        { id: "ben", urge: ben },
        { id: "cal", urge: cal },
      ],
      { addressedIds: ["ben"], seed: "addressee-trio" },
    );
    expect((counts.ben ?? 0) / 500).toBeGreaterThanOrEqual(0.88);
    expect((counts[""] ?? 0) / 500).toBeLessThan(0.03); // silence has all but left the wheel
  });
});

describe("arbitrateResponse — barge-in is possible but rare", () => {
  // Ann asks Ben for the cookie — but CAL is the one holding it (relevance 1.0),
  // so Cal has a real claim on the floor despite not being addressed.
  it("a high-urge non-addressee sometimes takes the floor, and usually doesn't", () => {
    const asked = said({ addresseeIds: ["ben"], act: act({ kind: "request", itemId: "cookie1" }) });
    const ben = urge({ utterance: asked, relevance: 0.8 });
    const cal = urge({ member: member({ id: "cal" }), utterance: asked, relevance: 1 });
    expect(cal).toBeLessThan(ben);

    const counts = tally(
      [
        { id: "ben", urge: ben },
        { id: "cal", urge: cal },
      ],
      { addressedIds: ["ben"], seed: "barge-in" },
    );
    expect(counts.cal ?? 0).toBeGreaterThan(0); // it CAN happen
    expect((counts.cal ?? 0) / 500).toBeLessThan(0.25); // and it stays the exception
    expect((counts.ben ?? 0) / 500).toBeGreaterThan(0.7);
  });
});

describe("arbitrateResponse — the silence weight", () => {
  // A remark to the room that interests nobody: every urge under 0.25 triples
  // the empty chair, so the room can visibly fail to pick it up.
  it("triples silence for a floor remark NOBODY cares about", () => {
    const bored = [
      { id: "ben", urge: 0.1 },
      { id: "cal", urge: 0.1 },
    ];
    const ignored = tally(bored, { seed: "ignored" });
    const asked = tally(bored, { addressedIds: ["ben"], seed: "ignored" });

    // weights [0.1, 0.1, 0.24] ⇒ P(silence) 0.545 · [0.1, 0.1, 0.004] ⇒ 0.0196
    expect((ignored[""] ?? 0) / 500).toBeGreaterThan(0.45);
    expect((asked[""] ?? 0) / 500).toBeLessThan(0.06);
  });

  // The boundary itself: at exactly `nobodyCares` somebody DOES care, so the
  // empty chair stays at its base weight. One roll straddles the two.
  it("one member at the nobodyCares bar keeps silence at base weight", () => {
    const rng = () => 0.75;
    const cares = arbitrateResponse(
      [
        { id: "ben", urge: ARBITRATION.nobodyCares },
        { id: "cal", urge: 0.1 },
      ],
      { rng },
    );
    const bored = arbitrateResponse(
      [
        { id: "ben", urge: ARBITRATION.nobodyCares - 0.01 },
        { id: "cal", urge: 0.1 },
      ],
      { rng },
    );
    expect(cares.responderId).toBe("cal"); // base silence 0.08 — somebody speaks
    expect(bored.responderId).toBeUndefined(); // tripled to 0.24 — the room lets it go
  });

  it("a floor remark somebody DOES care about is not treated as ignored", () => {
    const counts = tally([{ id: "ben", urge: 0.6 }], { seed: "floor-interest" });
    // weights [0.6, 0.08] ⇒ P(silence) 0.118
    expect((counts[""] ?? 0) / 500).toBeLessThan(0.2);
    expect((counts.ben ?? 0) / 500).toBeGreaterThan(0.8);
  });
});

describe("arbitrateResponse — silence is VISIBLE (the non-negotiable law)", () => {
  it("a full silence ALWAYS emits at least one reaction", () => {
    // Two barely-interested members, floor-addressed ⇒ silence outweighs both.
    const out = arbitrateResponse(
      [
        { id: "ben", urge: 0.05 },
        { id: "cal", urge: 0.02 },
      ],
      { rng: () => 0.99 },
    );
    expect(out.responderId).toBeUndefined();
    expect(out.silent.length).toBeGreaterThanOrEqual(1);
    // Nobody cleared GLANCE_MIN, so the reaction is the forced one: the member
    // who came closest to answering.
    expect(out.silent).toEqual([{ id: "ben", kind: "glance" }]);
  });

  it("hangs the forced reaction on the ADDRESSEE, not the keenest member", () => {
    const out = arbitrateResponse(
      [
        { id: "ben", urge: 0.05 },
        { id: "cal", urge: 0.02 },
      ],
      { addressedIds: ["cal"], rng: () => 0.999 },
    );
    expect(out.responderId).toBeUndefined();
    expect(out.silent).toEqual([{ id: "cal", kind: "glance" }]);
  });

  it("a HOSTILE silent addressee TURNS AWAY — the refusal reads as a refusal", () => {
    const out = arbitrateResponse(
      [
        { id: "ben", urge: 0.9 },
        { id: "cal", urge: 0.8, hostile: true },
      ],
      { addressedIds: ["cal"], rng: () => 0.999 },
    );
    expect(out.responderId).toBeUndefined();
    // Cal earned a glance on urge alone; being the hostile addressee upgrades it.
    expect(out.silent).toEqual([
      { id: "ben", kind: "glance" },
      { id: "cal", kind: "turn-away" },
    ]);
  });

  it("falls back to the keenest member when the addressee has left the roster", () => {
    const out = arbitrateResponse(
      [
        { id: "ben", urge: 0.02 },
        { id: "cal", urge: 0.05, hostile: true },
      ],
      { addressedIds: ["zed"], rng: () => 0.999 },
    );
    expect(out.responderId).toBeUndefined();
    expect(out.silent).toEqual([{ id: "cal", kind: "turn-away" }]);
  });
});

describe("arbitrateResponse — glances, and who is excluded from them", () => {
  const keen: ResponseCandidate[] = [
    { id: "ann", urge: 0.9 },
    { id: "ben", urge: 0.8 },
    { id: "cal", urge: 0.7 },
  ];

  it("everyone above GLANCE_MIN who did not get the floor glances", () => {
    const out = arbitrateResponse(keen, { rng: () => 0 });
    expect(out.responderId).toBe("ann");
    expect(out.silent).toEqual([
      { id: "ben", kind: "glance" },
      { id: "cal", kind: "glance" },
    ]);
  });

  it("the chosen responder NEVER appears in silent, wherever it sits in the roster", () => {
    const out = arbitrateResponse(keen, { rng: () => 0.5 }); // picks the middle one
    expect(out.responderId).toBe("ben");
    expect(out.silent.map((s) => s.id)).toEqual(["ann", "cal"]);
    expect(out.silent.some((s) => s.id === out.responderId)).toBe(false);
  });

  it("stays quiet about members below GLANCE_MIN", () => {
    const out = arbitrateResponse(
      [
        { id: "ann", urge: 0.9 },
        { id: "ben", urge: ARBITRATION.glanceMin },
        { id: "cal", urge: 0.01 },
      ],
      { rng: () => 0 },
    );
    expect(out.responderId).toBe("ann");
    expect(out.silent).toEqual([]); // 0.2 is not ABOVE 0.2
  });

  it("reports reactions in candidate order (the roster's deterministic order)", () => {
    const out = arbitrateResponse(keen, { rng: () => 0.99 });
    expect(out.responderId).toBeUndefined();
    expect(out.silent.map((s) => s.id)).toEqual(["ann", "ben", "cal"]);
  });
});

describe("arbitrateResponse — determinism", () => {
  const roster: ResponseCandidate[] = [
    { id: "ann", urge: 0.45 },
    { id: "ben", urge: 0.3 },
    { id: "cal", urge: 0.12 },
  ];

  it("the same rng sequence gives the same choices, draw for draw", () => {
    const run = () => {
      const rng = mulberry32(hashSeed("convo", "determinism"));
      return Array.from({ length: 200 }, () => arbitrateResponse(roster, { rng }));
    };
    expect(JSON.stringify(run())).toEqual(JSON.stringify(run()));
  });

  // Exactly one draw per call, whatever the roster size: a caller stepping a
  // shared stream stays in step with every device replaying it.
  it("consumes exactly ONE draw per call, whatever the roster size", () => {
    let draws = 0;
    const rng = () => {
      draws++;
      return 0.5;
    };
    arbitrateResponse(roster, { rng });
    expect(draws).toBe(1);
    arbitrateResponse([{ id: "ann", urge: 0.4 }], { rng });
    expect(draws).toBe(2);
  });

  it("a zero-weight member can never win, even on a roll of 0", () => {
    const out = arbitrateResponse(
      [
        { id: "ann", urge: 0 },
        { id: "ben", urge: 0.5 },
      ],
      { rng: () => 0 },
    );
    expect(out.responderId).toBe("ben");
  });

  it("all-zero urges fall to a visible silence rather than an unearned answer", () => {
    const out = arbitrateResponse(
      [
        { id: "ann", urge: 0 },
        { id: "ben", urge: 0 },
      ],
      { addressedIds: ["ben"], rng: () => 0.5 },
    );
    expect(out.responderId).toBeUndefined();
    expect(out.silent).toEqual([{ id: "ben", kind: "glance" }]);
  });
});

// ---------------------------------------------------------------------------
// defaultRelevance — the four rungs
// ---------------------------------------------------------------------------

/** Ben holds the cookie; Cal wants it; Dot is uninvolved. */
function relevanceWorld() {
  return createCreatureWorld(
    [{ id: "ann" }, { id: "ben" }, { id: "cal", needs: [{ itemId: "cookie1", value: 3 }] }, { id: "dot" }],
    [{ id: "cookie1", ownerId: "ben", kind: "cookie", category: "food" }],
  );
}

describe("defaultRelevance — rung 1: it is about something of MINE", () => {
  it("scores 1.0 for the member who HOLDS the requested item", () => {
    const w = relevanceWorld();
    expect(defaultRelevance(w, "ben", act({ kind: "request", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceMine,
    );
  });

  it("scores 1.0 for the member whose OPEN NEED the offered item answers", () => {
    const w = relevanceWorld();
    expect(defaultRelevance(w, "cal", act({ kind: "offer", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceMine,
    );
  });

  it("scores 1.0 on a SORT reference too ('give me food')", () => {
    const w = relevanceWorld();
    const ask = act({ kind: "request", target: { category: "food" } });
    expect(defaultRelevance(w, "ben", ask)).toBe(ARBITRATION.relevanceMine); // holds one
    expect(defaultRelevance(w, "cal", ask)).toBe(ARBITRATION.relevanceMine); // wants one
    expect(defaultRelevance(w, "dot", ask)).toBe(ARBITRATION.relevanceFloor); // neither
  });

  it("outranks the question rung — the thing in my hand beats knowing about it", () => {
    const w = relevanceWorld();
    seeItem(w, "dot", "cookie1", { kind: "held", by: "ben" });
    expect(defaultRelevance(w, "ben", act({ kind: "where-is", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceMine,
    );
    expect(defaultRelevance(w, "dot", act({ kind: "where-is", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceAnswerable,
    );
  });

  it("a need naming an item the world no longer has is still about me", () => {
    const w = relevanceWorld();
    delete w.items.cookie1;
    expect(defaultRelevance(w, "cal", act({ kind: "request", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceMine,
    );
    expect(defaultRelevance(w, "dot", act({ kind: "request", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceFloor,
    );
  });
});

describe("defaultRelevance — rung 2: a question I can answer", () => {
  it("scores 0.8 for a where-is whose answer I KNOW, and the floor when I don't", () => {
    const w = relevanceWorld();
    seeItem(w, "dot", "cookie1", { kind: "held", by: "ben" });
    expect(defaultRelevance(w, "dot", act({ kind: "where-is", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceAnswerable,
    );
    expect(defaultRelevance(w, "ann", act({ kind: "where-is", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceFloor,
    );
  });

  it("scores 0.8 for a SORT where-is I know a PROVIDER for", () => {
    const w = relevanceWorld();
    learnProvides(w, "dot", "food", "buy:good:food");
    expect(defaultRelevance(w, "dot", act({ kind: "where-is", target: { category: "food" } }))).toBe(
      ARBITRATION.relevanceAnswerable,
    );
    expect(defaultRelevance(w, "ann", act({ kind: "where-is", target: { category: "food" } }))).toBe(
      ARBITRATION.relevanceFloor,
    );
  });

  it("scores 0.8 for an ask-fact I hold the belief for", () => {
    const w = relevanceWorld();
    perceiveFact(w, "dot", { kind: "condition", creature: "ann", condition: "cold" });
    const ask = act({ kind: "ask-fact", query: { kind: "condition", creature: "ann" } });
    expect(defaultRelevance(w, "dot", ask)).toBe(ARBITRATION.relevanceAnswerable);
    expect(defaultRelevance(w, "ben", ask)).toBe(ARBITRATION.relevanceFloor);
  });

  it("scores 0.8 for a what-doing asked about ME, and the floor about somebody else", () => {
    const w = relevanceWorld();
    const aboutBen = act({ kind: "what-doing", about: { symbol: "ben", id: "ben" } });
    expect(defaultRelevance(w, "ben", aboutBen)).toBe(ARBITRATION.relevanceAnswerable);
    expect(defaultRelevance(w, "dot", aboutBen)).toBe(ARBITRATION.relevanceFloor);
  });

  // Place-facts belong to the host; without the hook this layer must not invent
  // an answer it cannot back up.
  it("defers directions to the knowsPlace hook, and floors the question without one", () => {
    const w = relevanceWorld();
    const ask = act({ kind: "ask-directions", subjectId: "home.color_blue" });
    expect(defaultRelevance(w, "dot", ask)).toBe(ARBITRATION.relevanceFloor);
    expect(
      defaultRelevance(w, "dot", ask, { knowsPlace: (id, who) => id === "home.color_blue" && who === "dot" }),
    ).toBe(ARBITRATION.relevanceAnswerable);
    expect(defaultRelevance(w, "ben", ask, { knowsPlace: (_id, who) => who === "dot" })).toBe(
      ARBITRATION.relevanceFloor,
    );
  });
});

describe("defaultRelevance — rung 3: small talk, rung 4: the floor", () => {
  it("scores 0.5 for small talk, for anyone present", () => {
    const w = relevanceWorld();
    for (const kind of ["how-are-you", "tell", "tell-fact", "invite", "bye"] as const) {
      expect(defaultRelevance(w, "dot", act({ kind }))).toBe(ARBITRATION.relevanceSmallTalk);
    }
  });

  it("floors board machinery and acts aimed at nobody in particular", () => {
    const w = relevanceWorld();
    for (const kind of ["trade-menu", "back", "more", "confused", "dont-understand"] as const) {
      expect(defaultRelevance(w, "dot", act({ kind }))).toBe(ARBITRATION.relevanceFloor);
    }
  });

  it("never rates anything below the floor", () => {
    const w = relevanceWorld();
    expect(ARBITRATION.relevanceFloor).toBeGreaterThan(0);
    expect(defaultRelevance(w, "dot", act({ kind: "back" }))).toBeGreaterThan(0);
  });
});

describe("defaultRelevance — best-effort and TOTAL", () => {
  it("floors an unknown member instead of throwing", () => {
    const w = relevanceWorld();
    expect(defaultRelevance(w, "ghost", act({ kind: "request", itemId: "cookie1" }))).toBe(
      ARBITRATION.relevanceFloor,
    );
  });

  it("floors an act naming an item nobody has ever heard of", () => {
    const w = relevanceWorld();
    expect(defaultRelevance(w, "ben", act({ kind: "request", itemId: "nope1" }))).toBe(
      ARBITRATION.relevanceFloor,
    );
  });

  it("survives a malformed act, a missing query and a missing world", () => {
    const w = relevanceWorld();
    expect(defaultRelevance(w, "ben", act({ kind: "ask-fact" }))).toBe(ARBITRATION.relevanceFloor);
    expect(defaultRelevance(w, "ben", { kind: "not-a-kind", glyph: "?" } as unknown as DialogueAct)).toBe(
      ARBITRATION.relevanceFloor,
    );
    expect(defaultRelevance(w, "ben", undefined as unknown as DialogueAct)).toBe(
      ARBITRATION.relevanceFloor,
    );
    expect(
      defaultRelevance(undefined as unknown as ReturnType<typeof relevanceWorld>, "ben", act()),
    ).toBe(ARBITRATION.relevanceFloor);
  });
});

// ---------------------------------------------------------------------------
// The two halves together
// ---------------------------------------------------------------------------

describe("urge + arbitration end to end", () => {
  // Ann asks the room for a cookie. Ben has one. Cal wants one. Dot is neither.
  // Nobody was addressed, so the floor weight applies to all three — and the
  // ladder is what separates them.
  it("a floor request lands on whoever it actually concerns", () => {
    const w = relevanceWorld();
    const utterance = said({ act: act({ kind: "request", target: { category: "food" } }) });
    const candidates = ["ben", "cal", "dot"].map((id) => ({
      id,
      urge: responseUrge({
        member: member({ id }),
        utterance,
        tick: 10,
        personality: NEUTRAL_PERSONALITY,
        relation: DEFAULT_RELATION,
        relevance: defaultRelevance(w, id, utterance.act),
      }),
    }));

    const byId = Object.fromEntries(candidates.map((c) => [c.id, c.urge]));
    expect(byId.ben).toBeCloseTo(byId.cal!, 10); // both concerned, equally
    expect(byId.dot!).toBeLessThan(byId.ben!);

    const counts = tally(candidates, { seed: "floor-request" });
    expect((counts.dot ?? 0) / 500).toBeLessThan(Math.min(counts.ben ?? 0, counts.cal ?? 0) / 500);
    // Somebody usually picks it up — but not nearly as reliably as when asked.
    // A floor remark caps every urge at 0.35·attend, which at neutral dials is
    // 0.21, i.e. UNDER `nobodyCares`: the room reads as uninterested and the
    // empty chair triples to 0.24. P(silence) = 0.31 analytically. That is the
    // designed shape, and the reason addressing somebody matters so much.
    expect((counts[""] ?? 0) / 500).toBeLessThan(0.4);
    expect((counts[""] ?? 0) / 500).toBeGreaterThan(0.2);
  });

  // The same remark in a room that is actually paying attention: one expressive,
  // fond, engaged member clears `nobodyCares` on its own, so the tripled silence
  // never applies and the request gets answered.
  it("a keen room picks a floor remark up instead of letting it drop", () => {
    const w = relevanceWorld();
    const utterance = said({ act: act({ kind: "request", target: { category: "food" } }) });
    const keen = responseUrge({
      member: member({ id: "ben" }),
      utterance,
      tick: 10,
      personality: makePersonality({ expressiveness: 1 }),
      relation: makeRelation({ affinity: 1 }),
      relevance: defaultRelevance(w, "ben", utterance.act),
    });
    expect(keen).toBeGreaterThan(ARBITRATION.nobodyCares);

    const counts = tally([{ id: "ben", urge: keen }], { seed: "keen-room" });
    expect((counts[""] ?? 0) / 500).toBeLessThan(0.2);
  });
});
