// Fruit PREFERENCES in the pure dialogue layer: likes seed as KIND words
// ("apple"), preferredOf picks the liked glyph (the host's take-choice), a
// category want VOICES the liked kind ("i_me want apple", not "… food"), WHY
// answers through the likes Clause, and kind-targeted requests/where-is resolve
// exactly like categories. Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureWorld,
  giveItem,
  learnProvides,
  preferredOf,
  seeItem,
  setLikes,
  valueTo,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  likedKindFor,
  projectDialogue,
  selectAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { intentToAct } from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

const opts = (world: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

// A resident with a generic FOOD want who LIKES apples; fruit kinds live in the world.
const fruitWorld = () =>
  createCreatureWorld(
    [
      { id: "res", likes: ["apple"], needs: [{ itemId: "apple1", value: 3, target: { category: "food" } }] },
      { id: "me" },
    ],
    [
      { id: "apple1", kind: "apple", category: "food" },
      // Loose (NOT the player's): a carried match would flip the line to give-ask.
      { id: "banana1", kind: "banana", category: "food" },
    ],
  );

describe("preferredOf — the host's take-choice among available glyphs", () => {
  it("returns the first LIKED glyph, in likes order (preference wins over availability order)", () => {
    expect(preferredOf(["banana", "apple"], ["apple", "banana"])).toBe("banana");
  });

  it("HEAD-matches composed glyphs — 'apple.big' answers an 'apple' like", () => {
    expect(preferredOf(["apple"], ["grape", "apple.big"])).toBe("apple.big");
  });

  it("undefined when nothing on offer is liked (or there are no likes)", () => {
    expect(preferredOf(["apple"], ["sock", "ball"])).toBeUndefined();
    expect(preferredOf([], ["apple"])).toBeUndefined();
  });
});

describe("kind likes — setLikes seeds them; a liked KIND values every instance", () => {
  it("valueTo gives baseline for a liked kind's instances, 0 for the rest", () => {
    const w = createCreatureWorld(
      [{ id: "res" }],
      [
        { id: "apple1", kind: "apple", category: "food" },
        { id: "sock1", kind: "sock" },
      ],
    );
    setLikes(w, "res", ["apple"]);
    expect(valueTo(w.creatures.res!, w.items.apple1!)).toBe(1);
    expect(valueTo(w.creatures.res!, w.items.sock1!)).toBe(0);
  });

  it("a liked-kind gift is ACCEPTED with baseline debt (like an instance like)", () => {
    const w = createCreatureWorld(
      [{ id: "res", likes: ["apple"] }, { id: "me" }],
      [{ id: "apple1", ownerId: "me", kind: "apple", category: "food" }],
    );
    const res = giveItem(w, "me", "res", "apple1");
    expect(res.accepted).toBe(true);
    expect(w.creatures.res!.debts.me).toBe(1);
  });
});

describe("a food want VOICES the liked kind (voice + choice, never a filter)", () => {
  it("the want line speaks 'apple', not 'food'", () => {
    const w = fruitWorld();
    const { lineGlyph } = projectDialogue(w, "res", "me", "b", opts(w));
    expect(lineGlyph).toBe("want + apple");
  });

  it("the where-is / can't buttons name the voiced kind too", () => {
    const w = fruitWorld();
    const { acts } = projectDialogue(w, "res", "me", "b", opts(w));
    expect(acts.find((a) => a.kind === "where-is")?.glyph).toContain("apple");
    expect(acts.find((a) => a.kind === "cant")?.glyph).toContain("apple");
  });

  it("matching is UNTOUCHED — any food (a banana) still satisfies the need", () => {
    const w = fruitWorld();
    const res = giveItem(w, "me", "res", "banana1");
    expect(res.accepted).toBe(true);
    expect(w.creatures.res!.needs[0]!.fulfilled).toBe(true);
  });

  it("a like of the WRONG category never renames the want", () => {
    const w = createCreatureWorld(
      [
        { id: "res", likes: ["sock"], needs: [{ itemId: "apple1", value: 3, target: { category: "food" } }] },
        { id: "me" },
      ],
      [
        { id: "apple1", kind: "apple", category: "food" },
        { id: "sock1", kind: "sock", category: "clothes" },
      ],
    );
    expect(projectDialogue(w, "res", "me", "b", opts(w)).lineGlyph).toBe("want + food");
  });

  it("likedKindFor stays out of a want that already NAMES a kind", () => {
    const w = fruitWorld();
    expect(likedKindFor(w, ["apple"], { kind: "banana", category: "food" })).toBeUndefined();
    expect(likedKindFor(w, ["apple"], { category: "food" })).toBe("apple");
  });
});

describe("WHY answers from the preference (the likes Clause)", () => {
  it("the why button shows for a like-voiced want (no authored fact needed)", () => {
    const w = fruitWorld();
    const why = projectDialogue(w, "res", "me", "b", opts(w)).acts.find((a) => a.kind === "why");
    expect(why).toBeDefined();
    expect(why?.glyph).toContain("apple");
  });

  it("asking why answers 'I want apple because I like apple'", () => {
    const w = fruitWorld();
    const res = selectAct(w, "res", "me", { kind: "why", glyph: "" }, "c", opts(w));
    expect(res.responseGlyph).toBe("i_me + want + apple + because + i_me + like + apple");
  });

  it("an AUTHORED likes fact keeps its own path (same clause machinery)", () => {
    const w = createCreatureWorld(
      [
        {
          id: "res",
          needs: [
            {
              itemId: "apple1",
              value: 3,
              target: { category: "food" },
              causalFact: { connective: "because", cause: { kind: "likes", creature: "res", facet: "apple" } },
            },
          ],
        },
        { id: "me" },
      ],
      [{ id: "apple1", kind: "apple", category: "food" }],
    );
    expect(projectDialogue(w, "res", "me", "b", opts(w)).acts.some((a) => a.kind === "why")).toBe(true);
    const res = selectAct(w, "res", "me", { kind: "why", glyph: "" }, "c", opts(w));
    expect(res.responseGlyph).toContain("because + i_me + like + apple");
  });

  it("a creatureState cause still SUPPRESSES the why button, like or no like", () => {
    const w = createCreatureWorld(
      [
        {
          id: "res",
          likes: ["apple"],
          needs: [
            {
              itemId: "apple1",
              value: 3,
              target: { category: "food" },
              causalFact: { connective: "because", cause: { kind: "creatureState", creature: "res", state: "hungry" } },
            },
          ],
        },
        { id: "me" },
      ],
      [{ id: "apple1", kind: "apple", category: "food" }],
    );
    expect(projectDialogue(w, "res", "me", "b", opts(w)).acts.some((a) => a.kind === "why")).toBe(false);
  });
});

describe("requests/where-is for a specific KIND (the §2b machinery, kind-flavored)", () => {
  it("'i_me want apple' maps to a KIND request when the listener holds none", () => {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "owner" }],
      [{ id: "apple1", ownerId: "fox", kind: "apple", category: "food" }],
    );
    const act = intentToAct(parseSentence("i_me + want + apple"), w, "me", "owner", opts(w))!;
    expect(act.kind).toBe("request");
    expect(act.itemId).toBeUndefined();
    expect(act.target).toEqual({ kind: "apple" });
  });

  it("the kind resolves against the owner's OWN holdings — a spare apple is granted", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [
        { id: "apple1", ownerId: "owner", kind: "apple", category: "food" },
        { id: "apple2", ownerId: "owner", kind: "apple", category: "food" },
      ],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", target: { kind: "apple" }, glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toBe("yes");
    expect(w.items.apple1!.pendingTransferTo).toBe("me");
  });

  it("owner has NONE but knows an apple provider → redirect to the stall", () => {
    const w = createCreatureWorld([{ id: "owner" }, { id: "me" }], []);
    learnProvides(w, "owner", "apple", "buy:good:apple");
    const res = selectAct(w, "owner", "me", { kind: "request", target: { kind: "apple" }, glyph: "" }, "b", opts(w));
    expect(res.askedDirections).toBe("buy:good:apple");
  });

  it("owner has NONE and knows no provider → the honest have-not, naming the kind", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [{ id: "apple1", kind: "apple", category: "food" }], // loose — just makes 'apple' a sort
    );
    const res = selectAct(w, "owner", "me", { kind: "request", target: { kind: "apple" }, glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toContain("have.not");
    expect(res.responseGlyph).toContain("apple");
  });

  it("where-is by KIND: a known matching instance answers with its location clue", () => {
    const w = createCreatureWorld(
      [{ id: "bear" }, { id: "me" }],
      [{ id: "apple1", ownerId: "fox", kind: "apple", category: "food" }],
    );
    seeItem(w, "bear", "apple1", { kind: "held", by: "fox" });
    const res = selectAct(w, "bear", "me", { kind: "where-is", target: { kind: "apple" }, glyph: "" }, "c", opts(w));
    expect(res.responseGlyph).toContain("have");
    expect(res.responseGlyph).toContain("apple");
  });

  it("where-is by KIND: no instance but a provider fact → directions; neither → don't-know", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    expect(
      selectAct(w, "bear", "me", { kind: "where-is", target: { kind: "apple" }, glyph: "" }, "b", opts(w)).responseGlyph,
    ).toContain("think.not");
    learnProvides(w, "bear", "apple", "buy:good:apple");
    expect(
      selectAct(w, "bear", "me", { kind: "where-is", target: { kind: "apple" }, glyph: "" }, "b", opts(w)).askedDirections,
    ).toBe("buy:good:apple");
  });
});
