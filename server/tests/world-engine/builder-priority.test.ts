// PAGE ONE IS THE BOARD (user complaint, 2026-08-24).
//
// The sentence builder's grid is 9×2 with a More button, so the first
// `BUILDER_ITEMS_WITH_MORE` buttons are the only ones a child sees without
// paging. Every pin in this file therefore asserts on THAT SLICE, not on
// presence anywhere in the 54 ranked words the board asks for — because
// presence-anywhere is exactly what let the shipped board open "I want" on
//
//     apple ball banana bed blocks book bowl box chair cookie dress grape
//     lamp oven puzzle refrigerator go
//
// with every action a page away and the objects in ALPHABETICAL ORDER (the
// frequency prior holds no concrete noun, so every noun tied and the symbol
// sort decided). Three laws now stand against that, and this file is where
// they are held:
//
//   L1  the alphabet never orders anything a child sees — the vocabulary's own
//       order does, derived from the spec (`content/vocab-order.ts`).
//   L2  primitives first, wherever an action list appears.
//   ⑬   a place is not a thing you want: places belong to the `go` board.
//
// planning-docs/sentence-builder-default-vocabulary.md §5–§9.

import { describe, it, expect } from "@jest/globals";
import { BUILDER_ITEMS_WITH_MORE } from "@shared/aac-builder-paging.js";
import {
  builderSurfaceFor,
  defaultBuilderNouns,
} from "@shared/world-engine/interaction/intent/builder-surface.js";
import { isSpecNoun } from "@shared/world-engine/interaction/content/vocab-order.js";
import { emptyRecency, noteUtterance } from "@shared/world-engine/interaction/intent/surface-next.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { headOf } from "@shared/world-engine/variations.js";

/** The AAC's own budget: three grid pages, exactly what the board asks for. */
const CAPACITY = 54;
const NOUNS = defaultBuilderNouns();

/** What the child sees before pressing More. */
const pageOne = (partial: string): string[] =>
  builderSurfaceFor(partial, { nouns: NOUNS, capacity: CAPACITY })
    .buttons.slice(0, BUILDER_ITEMS_WITH_MORE)
    .map((b) => b.key);

const keys = (partial: string): string[] =>
  builderSurfaceFor(partial, { nouns: NOUNS, capacity: CAPACITY }).buttons.map((b) => b.key);

const kindOf = (key: string): string | undefined =>
  NOUNS.find((n) => n.symbol === key)?.kind;

const isSorted = (words: readonly string[]): boolean =>
  words.every((w, i) => i === 0 || words[i - 1]! <= w);

describe("page one of a desire — actions and CATEGORIES, never the pantry", () => {
  it("offers the doings and the kinds of thing, and no specific item", () => {
    const page = pageOne("i_me + want");
    // The doings the complaint named. (`make` is twelfth in the primitive order,
    // so it rides a later page rather than this one — but it IS on the board.)
    for (const v of ["go", "eat", "play", "get"]) expect(page).toContain(v);
    expect(keys("i_me + want")).toContain("make");
    // The KINDS of thing, as words a child can actually say: "I want food" is a
    // complete request, and often the one a child can reach fastest.
    for (const c of ["food", "toy"]) expect(page).toContain(c);
    // NOT the individual foods and toys (user decision 2026-08-24). A page of
    // apple/banana/cookie/grape/ball/blocks/puzzle is a cupboard, not a board:
    // the thing this child wants is no easier to find there than in the kitchen.
    for (const item of ["apple", "banana", "cookie", "grape", "ball", "blocks", "puzzle"]) {
      expect({ item, onBoard: keys("i_me + want").includes(item) }).toEqual({ item, onBoard: false });
    }
  });

  it("…but every one of them is ONE press away, in its own chip", () => {
    const chips = builderSurfaceFor("i_me + want", { nouns: NOUNS, capacity: CAPACITY }).groups ?? [];
    expect(chips.map((g) => g.id)).toEqual(expect.arrayContaining(["food", "toy"]));
    // Pressing a chip echoes its id back as `group`, and THAT is the expansion —
    // the wire shape carries the chip's face, never its members.
    const open = (group: string) =>
      builderSurfaceFor("i_me + want", { nouns: NOUNS, capacity: CAPACITY, group })
        .buttons.map((b) => b.key);
    expect(open("food")).toContain("apple");
    expect(open("toy")).toContain("ball");
    // Ordered by the property vocabulary, not by cluster size and not by the
    // alphabet: food and toys lead the object categories (the people chip rides
    // with them, since five of them are already inline).
    const ids = chips.map((g) => g.id);
    expect(ids.slice(0, 4)).toEqual(expect.arrayContaining(["food", "toy"]));
    expect(ids).toContain("drink");
  });

  it("an item the child has ASKED FOR BEFORE comes back inline", () => {
    // The one exception the user named. The learned layer already records it —
    // this is what it is for.
    const mem = noteUtterance(
      noteUtterance(emptyRecency(), parseSentence("i_me + want + ball")),
      parseSentence("i_me + want + ball"),
    );
    const page = builderSurfaceFor("i_me + want", { nouns: NOUNS, capacity: CAPACITY, recency: mem })
      .buttons.slice(0, BUILDER_ITEMS_WITH_MORE)
      .map((b) => b.key);
    expect(page).toContain("ball");
    // …and the toys nobody asked for stay behind the chip.
    expect(page).not.toContain("blocks");
  });

  it("a bare `want` opens the same board as `i_me + want`", () => {
    expect(pageOne("want")).toEqual(pageOne("i_me + want"));
  });

  it("the inner verb's own board then leads with what that verb wants", () => {
    expect(pageOne("i_me + want + eat").slice(0, 4)).toEqual(["cookie", "apple", "banana", "grape"]);
    expect(pageOne("i_me + want + drink")[0]).toBe("water");
  });
});

describe("page one is never alphabetical (L1)", () => {
  for (const partial of ["i_me + want", "i_me + want + eat", "i_me + go", "you"]) {
    it(`"${partial}" is ranked, not sorted`, () => {
      const page = pageOne(partial);
      expect(page.length).toBeGreaterThan(3);
      expect(isSorted(page)).toBe(false);
    });
  }

  it("every default noun has a place in the vocabulary's order", () => {
    // The order is only a law if it is exhaustive: a head no registry defines
    // falls through to the symbol sort, which is the defect all of this exists
    // to remove. A miss here is a SPEC GAP — add the row, not a list.
    const unranked = NOUNS.map((n) => headOf(n.symbol)).filter((h) => !isSpecNoun(h));
    expect(unranked).toEqual([]);
  });
});

describe("a place is not a thing you want (⑬)", () => {
  it("no place reaches the want board at all", () => {
    const all = builderSurfaceFor("i_me + want", { nouns: NOUNS, capacity: CAPACITY }).buttons;
    expect(all.filter((b) => kindOf(b.key) === "place")).toEqual([]);
  });

  it("the go board is where they live, and home leads it", () => {
    const page = pageOne("i_me + go");
    expect(page[0]).toBe("home");
    expect(page.every((k) => kindOf(k) === "place" || k === "here" || k === "there")).toBe(true);
  });

  it("`see` keeps places — the one verb whose object may be one", () => {
    const all = builderSurfaceFor("you + see", { nouns: NOUNS, capacity: CAPACITY }).buttons;
    expect(all.some((b) => kindOf(b.key) === "place")).toBe(true);
  });
});

describe("what a verb's object may BE (VERB_OBJECT_CLASSES)", () => {
  /** The head of the object band for a partial, at a page's worth. */
  const leads = (partial: string, n = 4): string[] => keys(partial).slice(0, n);

  it("a transfer takes what a hand can HOLD — never the room's furniture", () => {
    // `ownable` is derived, not authored: an item that is neither furniture nor
    // a raised structure. So a bed and a table rank under every apple.
    for (const partial of ["you + get", "you + give", "you + carry"]) {
      const k = keys(partial);
      // A fixture is not even a transfer's CANDIDATE now: an oven is a thing you
      // want and go to, never a thing you hand over, so it carries no `give`.
      for (const fixture of ["bed", "table", "chair", "oven", "refrigerator"]) {
        const at = k.indexOf(fixture);
        expect({ partial, fixture, lead: at >= 0 && at < 8 }).toEqual({ partial, fixture, lead: false });
      }
      expect(leads(partial).every((key) => !["bed", "table", "chair"].includes(key))).toBe(true);
    }
  });

  it("the put family's OBJECT is the thing placed; the container is its destination", () => {
    // "put + ball + in + box", never "put + box". The chip pre-load still opens
    // [container] — that is the DESTINATION's question, and both are true at once.
    const s = builderSurfaceFor("you + put", { nouns: NOUNS, capacity: CAPACITY });
    expect(s.buttons.slice(0, 4).map((b) => b.key)).not.toContain("box");
    // …and once the ball is named, the board asks where it goes: containers and
    // places, with no loose apple anywhere on it.
    const after = keys("you + put + ball");
    expect(after[0]).toBe("box");
    expect(after).not.toContain("apple");
  });

  it("play leads with toys, see offers places, eat falls back to its pre-load property", () => {
    expect(leads("you + play", 3)).toEqual(["ball", "blocks", "puzzle"]);
    // A verb with no row in the class table uses `PROPERTY_FOR_VERB` — one fact,
    // one owner, no duplicated row.
    expect(leads("you + eat", 4)).toEqual(["cookie", "apple", "banana", "grape"]);
    expect(keys("you + see").some((k) => kindOf(k) === "place")).toBe(true);
  });

  it("WHOM you help depends on who you are talking to", () => {
    // The user's flip: an order is about the speaker ("you help ME"), a wish is
    // about the listener ("I want to help YOU").
    expect(keys("you + help")[0]).toBe("i_me");
    expect(keys("i_me + want + help")[0]).toBe("you");
  });
});

describe("ONE vocabulary, in game and out (W3)", () => {
  it("the library is DERIVED — the people a child names are on it", () => {
    // The curated 19-item array is gone; the walk reads the registries. What it
    // changes most is who is on the board: there were NO people at all, so every
    // creature-keyed band was structurally empty out of game.
    const greet = keys("hi");
    expect(greet.slice(0, 3)).toEqual(["mom", "dad", "teacher"]);
    for (const person of ["mom", "dad", "teacher", "friend", "baby"]) {
      expect(NOUNS.some((n) => n.symbol === person && n.kind === "creature")).toBe(true);
    }
    // And the everyday food and drink the stubs added reach the board.
    for (const w of ["milk", "juice", "bread", "cheese", "school", "park"]) {
      expect(NOUNS.some((n) => n.symbol === w)).toBe(true);
    }
  });

  it("a host's scene nouns MERGE with it, and the host's own entry wins", () => {
    const host = [
      { symbol: "mara", kind: "creature" as const, affords: ["talk", "give"] },
      // The same head the defaults carry, with the scene's own affordances.
      { symbol: "apple", kind: "item" as const, affords: ["eat"], properties: ["food"] },
    ];
    const merged = builderSurfaceFor("", { nouns: host, category: "things" }).buttons.map((b) => b.key);
    expect(merged).toContain("mara"); // the scene's person
    expect(merged).toContain("cookie"); // …and the vocabulary a child had before it opened
    expect(merged.filter((k) => k === "apple")).toHaveLength(1); // one entry per head
    expect(merged.indexOf("apple")).toBeLessThan(merged.indexOf("cookie")); // host first
    // `defaults: false` is the opt-out, for a surface that pins an exact board.
    const alone = builderSurfaceFor("", { nouns: host, category: "things", defaults: false })
      .buttons.map((b) => b.key);
    expect(alone).toEqual(["mara", "apple"]);
  });
});

describe("the verb's own priority beats the vocabulary's (CONTEXT_PRIORITY)", () => {
  it("you sit on a chair and sleep in a bed, though both are furniture", () => {
    expect(pageOne("i_me + want + sit")[0]).toBe("chair");
    expect(pageOne("i_me + want + sleep")[0]).toBe("bed");
  });
});
