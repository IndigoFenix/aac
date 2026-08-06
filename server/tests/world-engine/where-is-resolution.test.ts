// ⚖️ LAW ③ — THE ANSWER IS THE RESOLUTION
// (planning-docs/games/world-engine/household-economy-and-where-is.md §2/§5).
//
// *"A creature asked 'where is {type}?' answers with the source ITS OWN acquire
// resolution would pick, run as a READ-ONLY probe — never from a parallel copy
// of the world."*
//
// This file pins the PURE half of that: the dialogue layer's side of the
// contract, with `resolveSourceFor` stubbed to each of the four answers the
// hook can give. The HOST half — that the probe is really the body's own need
// row, and that asking moves nothing — is pinned in `where-is-probe.test.ts`
// against a live dollhouse.
//
// The reported bug this exists against (2026-08-06): a household of four walked
// past a stocked refrigerator to the market, and biscuit's "Where is the food?"
// was reproducibly never answered — because container stock is a glyph→count
// map that reaches NO creature-world item and NO `provides` fact, so every rung
// of the old chain missed, and the ask itself carried only the asker's row
// marker (`good:food`) with no sort on it.
//
// Pure logic — no DB / GL / LLM.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld, seeItem } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  projectDialogue,
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
  type SourceAnswer,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { intentToAct } from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { ARBITRATION, defaultRelevance } from "@shared/world-engine/interaction/dialogue/respond.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

/** The household: two members, and NOTHING edible anywhere in the creature
 *  world — which is the dollhouse's real shape. The food is in the fridge, and
 *  a fridge is a glyph→count map the creature layer cannot see. */
function household() {
  return createCreatureWorld([{ id: "mara" }, { id: "biscuit" }], []);
}

const baseOpts = (): ProjectionOpts => ({ symbolOf: (id) => id });

/** Projection opts whose law-③ hook always answers `answer`. */
function withHook(answer: SourceAnswer | undefined): ProjectionOpts {
  return { ...baseOpts(), resolveSourceFor: () => answer };
}

/** The ambient ask exactly as an NPC projects it: the asker's ROW MARKER as the
 *  itemId (no world item ever carries that id) plus the sort it names. */
const foodAsk = (over: Partial<DialogueAct> = {}): DialogueAct => ({
  kind: "where-is",
  itemId: "good:food",
  target: { category: "food" },
  glyph: "place#question + food",
  ...over,
});

describe("where-is → the responder's OWN acquire resolution (law ③)", () => {
  it("a stocked fridge is NAMED — the verbless locative, container in the place slot", () => {
    const world = household();
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      foodAsk(),
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    // `{item} + in + {place}` — the construction-speech law's locative, and the
    // container word (not the object id: `furn_9_chest_food` IS a refrigerator).
    expect(res.responseGlyph).toBe("food + in + refrigerator");
    expect(res.askedDirections).toBeUndefined();
  });

  it("level a answers with the CONTAINER alone (the one-symbol reader's answer)", () => {
    const world = household();
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      foodAsk(),
      "a",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    expect(res.responseGlyph).toBe("refrigerator");
  });

  it("an EMPTY fridge with a stocked market answers with DIRECTIONS, not a shrug", () => {
    const world = household();
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      foodAsk(),
      "c",
      withHook({ kind: "place", subjectId: "buy:good:food" }),
    );
    // The place answer rides the EXISTING directions channel unchanged — the
    // host measures the town and speaks the prose.
    expect(res.askedDirections).toBe("buy:good:food");
    expect(res.responseGlyph).toBeUndefined();
  });

  it("no row and no told fact → the honest DON'T-KNOW (never silence)", () => {
    const world = household();
    const res = selectAct(world, "mara", "biscuit", foodAsk(), "c", withHook(undefined));
    expect(res.askedDirections).toBeUndefined();
    expect(res.responseGlyph).toBe("i_me + think.not");
  });

  it("a row that resolves to NOTHING says there is none — a different fact from not knowing", () => {
    const world = household();
    const res = selectAct(world, "mara", "biscuit", foodAsk(), "c", withHook({ kind: "none" }));
    expect(res.responseGlyph).toBe("i_me + have.not + food");
  });

  it("a TOLD provides fact still answers when the responder has no row of its own", () => {
    const world = household();
    seeItem(world, "mara", "provides:food", { kind: "provided", place: "buy:good:food" });
    const res = selectAct(world, "mara", "biscuit", foodAsk(), "c", withHook(undefined));
    expect(res.askedDirections).toBe("buy:good:food");
  });

  it("the OWN resolution OUTRANKS the told fact — the fridge beats the market it was told about", () => {
    const world = household();
    seeItem(world, "mara", "provides:food", { kind: "provided", place: "buy:good:food" });
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      foodAsk(),
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    expect(res.responseGlyph).toBe("food + in + refrigerator");
  });

  // §1 defect ③, the regression this whole pass is named for: the ask carried
  // `itemId: "good:food"` — an id NO world item holds — and a truthy itemId
  // skipped the type chain outright, so every housemate who was not itself
  // hungry answered "I don't know".
  it("a ROW MARKER itemId never shortcuts the type chain", () => {
    const world = household();
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      foodAsk(),
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    expect(res.responseGlyph).toBe("food + in + refrigerator");
  });

  // …while a REAL instance still wins the chain: sightings are first-hand.
  it("a KNOWN INSTANCE still answers ahead of the probe", () => {
    const world = createCreatureWorld(
      [{ id: "mara" }, { id: "biscuit" }],
      [{ id: "apple1", ownerId: "biscuit", kind: "apple", category: "food" }],
    );
    seeItem(world, "mara", "apple1", { kind: "held", by: "biscuit" });
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      { kind: "where-is", target: { category: "food" }, glyph: "place#question + food" },
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    // "you have it" — the holder clue, not the pantry.
    expect(res.responseGlyph).toContain("have");
  });
});

// ⚠️ THE ASK THAT ACTUALLY FIRES IN PLAY. An ambient "Where is the food?" is
// usually a `directions-pick` off the town's own place facts, NOT the needs-
// projected `where-is` act — same words, same glyph (`whereIs()` builds both).
// A `buy:good:<key>` subject is a sort question wearing a place's clothes, so
// law ③ reaches it; every other subject is a place and keeps pointing.
describe("a directions PICK about a good is a sort question too", () => {
  const world = household();
  const pick = (subjectId: string): DialogueAct => ({
    kind: "directions-pick",
    subjectId,
    glyph: "place#question + food",
  });

  it("a stocked fridge diverts the pick to the locative", () => {
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      pick("buy:good:food"),
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    expect(res.responseGlyph).toBe("food + in + refrigerator");
    expect(res.askedDirections).toBeUndefined();
  });

  it("a PLACE answer changes nothing — the directions reply is byte-identical", () => {
    for (const hook of [
      undefined,
      { kind: "place", subjectId: "buy:good:food" } as const,
      { kind: "none" } as const,
    ]) {
      const res = selectAct(world, "mara", "biscuit", pick("buy:good:food"), "c", withHook(hook));
      expect(res.askedDirections).toBe("buy:good:food");
      expect(res.responseGlyph).toBeUndefined();
    }
  });

  it("a subject that names a PLACE keeps pointing, whatever the rows say", () => {
    const res = selectAct(
      world,
      "mara",
      "biscuit",
      pick("home:wanter_1"),
      "c",
      withHook({ kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }),
    );
    expect(res.askedDirections).toBe("home:wanter_1");
  });
});

describe("the ask ACT carries the sort it is about", () => {
  it("a resource-type want projects a where-is with `target`", () => {
    const world = createCreatureWorld(
      [
        { id: "biscuit", needs: [{ itemId: "good:food", value: 2, target: { category: "food" } }] },
        { id: "mara" },
      ],
      [],
    );
    const proj = projectDialogue(world, "biscuit", "mara", "c", baseOpts());
    const ask = proj.acts.find((a) => a.kind === "where-is");
    expect(ask).toBeDefined();
    // WITHOUT this the responder gets only `good:food` — an id its own world
    // does not hold — and can never resolve the question as a SORT question.
    expect(ask?.target).toEqual({ category: "food" });
    expect(ask?.itemId).toBe("good:food");
  });
});

describe("typeTarget — the LISTENER'S OWN ROWS count as recognizing a word", () => {
  const world = household();
  // The PARSER's question word is `where` (the board's `place#question` glyph is
  // its rendered form) — §5.3's own example sentence.
  const frame = () => parseSentence("where + food");

  // §8 D1 — WITHOUT the hook the word is still THE SORT THE ASK IS ABOUT. No
  // world item carries the category and nobody has been told a provides fact, so
  // this layer can see nothing at all — and the last resort is to take the
  // spoken noun at its word rather than emit an act the evaluator can only shrug
  // at. (Before D1 this returned `target: undefined`, which is how "where is the
  // ball" became "I don't understand".)
  it("without the hook, the spoken noun is still carried as the sort", () => {
    const act = intentToAct(frame(), world, { speakerId: "biscuit", addresseeId: "mara" }, baseOpts());
    expect(act).toMatchObject({ kind: "where-is", target: { kind: "food" } });
  });

  it("with the hook, the word IS a sort — because the person asked can place it", () => {
    // KIND FIRST, then category (§8 D1): a host answers `{kind:"food"}` with
    // nothing — food is nobody's kind — and the category reading is what its
    // hunger row serves. The stub here answers exactly as the real host does.
    const act = intentToAct(frame(), world, { speakerId: "biscuit", addresseeId: "mara" }, {
      ...baseOpts(),
      resolveSourceFor: (_cid, target) =>
        target.category === "food"
          ? { kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }
          : undefined,
    });
    expect(act).toMatchObject({ kind: "where-is", target: { category: "food" } });
  });

  it("a KIND the listener can place is the MORE SPECIFIC reading, and wins", () => {
    // "where is the apple": the responder's hunger row matches a kind against
    // its item spec the way every stack is matched, so the kind reading resolves
    // — and it must be the one that rides the act, or the answer would be about
    // food in general.
    const act = intentToAct(parseSentence("where + apple"), world, { speakerId: "biscuit", addresseeId: "mara" }, {
      ...baseOpts(),
      resolveSourceFor: (_cid, target) =>
        target.kind === "apple"
          ? { kind: "container", objId: "furn_9_chest_food", glyph: "refrigerator" }
          : undefined,
    });
    expect(act).toMatchObject({ kind: "where-is", target: { kind: "apple" } });
  });

  it("the probe is asked about the LISTENER, never the speaker", () => {
    const asked: string[] = [];
    const opts: ProjectionOpts = {
      ...baseOpts(),
      resolveSourceFor: (cid) => {
        asked.push(cid);
        return { kind: "none" };
      },
    };
    intentToAct(frame(), world, { speakerId: "biscuit", addresseeId: "mara" }, opts);
    expect(asked).toContain("mara");
    expect(asked).not.toContain("biscuit");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 FIX D — "WHERE" LOCATES ANYTHING WITH A LOCATION
// ═══════════════════════════════════════════════════════════════════════════

describe("D1 — a well-formed 'where + noun' ALWAYS becomes an ask", () => {
  const world = household();
  const p = { speakerId: "biscuit", addresseeId: "mara" };

  // The reported symptom: "where is the ball" / "where is the apple" answered
  // "I don't understand", or produced an act with NEITHER an id nor a target —
  // which the evaluator can only shrug at, and whose worse shapes fell out of
  // the conversation entirely (the host toast).
  it.each(["ball", "apple", "refrigerator", "mara"])(
    "where + %s parses to an act that names its sort",
    (noun) => {
      const act = intentToAct(parseSentence(`where + ${noun}`), world, p, baseOpts());
      expect(act).not.toBeNull();
      expect(act!.kind).not.toBe("dont-understand");
      // Never an act with neither id nor target — the shape D1 exists to kill.
      expect(act!.itemId ?? act!.target ?? act!.query).toBeDefined();
    },
  );

  it("a NAMED creature stays a presence question, not an item hunt", () => {
    const act = intentToAct(parseSentence("where + mara"), world, p, {
      ...baseOpts(),
      creatureOf: (sym) => (sym === "mara" ? "mara" : undefined),
    });
    expect(act).toMatchObject({ kind: "ask-fact", query: { kind: "presence", creature: "mara" } });
  });

  it("a BARE 'where' with nothing named is still honestly not understood", () => {
    const act = intentToAct(parseSentence("where"), world, p, baseOpts());
    expect(act?.kind).toBe("dont-understand");
  });
});

describe("D3 — the HOLDER answer: somebody has it", () => {
  const world = household();
  const ballAsk = (): DialogueAct => ({
    kind: "where-is",
    target: { kind: "ball" },
    glyph: "place#question + ball",
  });

  it("a housemate holding it is NAMED ('biscuit + have + ball')", () => {
    const res = selectAct(world, "mara", "player", ballAsk(), "c", {
      ...withHook({ kind: "holder", cid: "biscuit" }),
      symbolOfCreature: (cid) => cid,
    });
    expect(res.responseGlyph).toBe("biscuit + have + ball");
    expect(res.askedDirections).toBeUndefined();
  });

  it("its OWN hand answers in the first person ('i_me + have + ball')", () => {
    const res = selectAct(world, "mara", "player", ballAsk(), "c", {
      ...withHook({ kind: "holder", cid: "mara" }),
      symbolOfCreature: (cid) => cid,
    });
    expect(res.responseGlyph).toBe("i_me + have + ball");
  });

  it("a place answer still points, and an absent one still says don't-know", () => {
    expect(
      selectAct(world, "mara", "player", ballAsk(), "c", withHook({ kind: "place", subjectId: "at:small_7" }))
        .askedDirections,
    ).toBe("at:small_7");
    expect(selectAct(world, "mara", "player", ballAsk(), "c", withHook(undefined)).responseGlyph).toBe(
      "i_me + think.not",
    );
  });
});

describe("D2 — a CREATURE's whereabouts: sight before the told fact", () => {
  const world = household();
  const ask = (): DialogueAct => ({
    kind: "ask-fact",
    query: { kind: "presence", creature: "mara" },
    glyph: "place#question + mara",
  });

  it("a housemate who can SEE her answers the room she is standing in", () => {
    // The observer reaches the world layer, which is what lets sight overrule
    // the duty roster: the hook is asked WHO is answering, and only the body
    // that can see her gets the room.
    const asked: (string | undefined)[] = [];
    const res = selectAct(world, "biscuit", "player", ask(), "c", {
      ...baseOpts(),
      symbolOfCreature: (cid) => cid,
      presenceOf: (cid, observer) => {
        asked.push(observer);
        return cid === "mara" && observer === "biscuit" ? "kitchen" : undefined;
      },
    });
    expect(asked).toEqual(["biscuit"]);
    expect(res.responseGlyph).toBe("mara + in + kitchen");
  });

  it("out of view, with nothing told, it is the honest don't-know", () => {
    const res = selectAct(world, "biscuit", "player", ask(), "c", {
      ...baseOpts(),
      symbolOfCreature: (cid) => cid,
      presenceOf: () => undefined,
    });
    expect(res.responseGlyph).toBe("i_me + think.not");
  });
});

describe("arbitration — a member the probe answers for CAN answer", () => {
  const world = household();
  const act = foodAsk();

  it("without the hook the sort question lands on the floor rung", () => {
    expect(defaultRelevance(world, "mara", act, {})).toBe(ARBITRATION.relevanceFloor);
  });

  it("a container/place answer lifts the member to the ANSWERABLE rung", () => {
    const rel = defaultRelevance(world, "mara", act, {
      answersSource: () => true,
    });
    expect(rel).toBe(ARBITRATION.relevanceAnswerable);
  });

  it("a member whose row resolves to nothing is NOT promoted (it has no answer)", () => {
    const rel = defaultRelevance(world, "mara", act, {
      answersSource: () => false,
    });
    expect(rel).toBe(ARBITRATION.relevanceFloor);
  });
});
