// FURNITURE NAMING — the `furn.` prefix is STORAGE, never a word.
//
// A stored piece of furniture stacks as `furn.<kind>` (stations.ts
// furnitureGlyph), so its glyph HEAD is a bookkeeping prefix rather than a
// noun. Every layer that reduces a glyph to a word has to see through it, or
// the world starts talking about "the furn": it was heard in a spoken locative
// ("the furn is in the door"), in a refusal ("I don't want the furn"), and read
// off the pocket strip and the container board of a stashed piece.
//
// Two claims are under test, and they are the same claim twice:
//
//   ① THE WORD IS THE PIECE. `spokenWord`/`drawnGlyph` are the fold, and every
//     line-producing path in the engine goes through them — `headOf` stays
//     right for STORAGE and MATCHING (a stack key really is `furn.chair`) and
//     wrong for everything anybody says or reads.
//
//   ② THE WORD IS IN THE PLAYER'S LANGUAGE. Glyph keys are English by accident
//     of authoring, so an English-only path LOOKS correct and ships a Hebrew
//     board with "workbench" on it. Every shipped ruleset must name every
//     craftable piece.
//
// Pure — no DB, no THREE. Safe in test:engine / test:unit.

import { describe, it, expect } from "@jest/globals";
import {
  drawnGlyph,
  makeableGlyph,
  spokenWord,
} from "@shared/world-engine/interaction/content/makeable.js";
import {
  FURNITURE_ITEMS,
  furnitureGlyph,
  furnitureKindOfGlyph,
  type StationKind,
} from "@shared/world-engine/kernel/town/stations.js";
import { stepActivity } from "@shared/world-engine/interaction/dialogue/going.js";
import { goalActivity, goalIntentLine } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { builderSurfaceFor } from "@shared/world-engine/interaction/intent/builder-surface.js";
import { glyphLabel, languageFor, translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { fixtureWord } from "@shared/world-engine/types.js";
import { unitsOf } from "@shared/world-engine/kernel/town/scope.js";
import { stackHead, stackUnits, takeStock } from "@shared/world-engine/kernel/town/transfer.js";

/** Every locale with a shipped glyph ruleset (lang/index LANGUAGES). */
const LOCALES = ["en", "he", "es", "pt"] as const;

/** The line-level assertion: nothing anybody hears may contain the prefix. */
const saysNoFurn = (text: string) => {
  expect(text.length).toBeGreaterThan(0);
  expect(text.toLowerCase()).not.toMatch(/\bfurn\b/);
};

/** The intent-line symbol table, stubbed: every resolver answers with the raw
 *  reference, so a leaked storage head shows up as itself in the output. */
const SYMS = {
  item: (ref: { id: string } | { match: { kind?: string; descriptors?: string[] } }) =>
    "id" in ref ? ref.id : [ref.match.kind ?? "thing", ...(ref.match.descriptors ?? [])].join("."),
  place: () => "home",
  creature: (cid: string) => cid,
};

describe("`furn.` is storage bookkeeping, not a word", () => {
  it("folds the head to the piece — and keeps the facets", () => {
    expect(spokenWord("furn.chair")).toBe("chair");
    expect(drawnGlyph("furn.chair")).toBe("chair");
    // A painted piece is still a chair. The kind is the FIRST modifier; the
    // rest are ordinary facets and ride along, so "the red chair" survives.
    expect(spokenWord("furn.chair.color_red")).toBe("chair");
    expect(drawnGlyph("furn.chair.color_red")).toBe("chair.color_red");
    // Non-furniture stacks are untouched by the fold.
    expect(drawnGlyph("shirt.color_red")).toBe("shirt.color_red");
    expect(spokenWord("apple.hot")).toBe("apple");
  });

  it("reads a facetted piece as furniture at all (the kind is the first mod)", () => {
    expect(furnitureKindOfGlyph("furn.chair")).toBe("chair");
    expect(furnitureKindOfGlyph("furn.chair.color_red")).toBe("chair");
    expect(furnitureKindOfGlyph("chair")).toBeNull();
    expect(furnitureKindOfGlyph("furn.nonsense")).toBeNull();
  });

  it("speaks the VOCABULARY's word where the sim's kind isn't one", () => {
    // The sim tells a goods `chest` from the toy `box` and calls a cabinet a
    // `cupboard`; the board carries neither word (types.ts FIXTURE_WORD).
    expect(spokenWord("furn.chest")).toBe("box");
    expect(spokenWord("furn.cupboard")).toBe("cabinet");
    // …and the fold is round-trippable: the word an order names reaches the
    // recipe that makes it.
    expect(spokenWord(makeableGlyph("cabinet")!)).toBe("cabinet");
  });

  it("never head-matches one piece against another in a stack count", () => {
    // Every furniture glyph shares the head `furn`, so head-matching answers a
    // query for beds with the chairs too. Prefix-exact matching is the rule.
    const stack = { "furn.bed": 1, "furn.chair": 3, "furn.chair.color_red": 2 };
    expect(unitsOf(stack, "furn.bed")).toBe(1);
    expect(unitsOf(stack, "furn.chair")).toBe(5); // the red one IS a chair
    expect(unitsOf(stack, "furn.table")).toBe(0);
  });

  it("takes the piece it asked for — a bill for a bed never eats the chairs", () => {
    // The same collision on the TRANSFER side, where it moves real units: the
    // stack head of a piece is its KIND, so a bed is not payable in chairs.
    expect(stackHead("furn.chair.color_red")).toBe("furn.chair");
    expect(stackHead("wood.wet")).toBe("wood"); // materials are unchanged
    const stack = { "furn.bed": 1, "furn.chair": 2 };
    expect(stackUnits(stack, "furn.bed")).toBe(1);
    expect(takeStock(stack, "furn.bed", 2)).toEqual({ "furn.bed": 1 });
    expect(stack).toEqual({ "furn.chair": 2 }); // the chairs stayed put
  });
});

describe("nothing a creature SAYS about a piece says «furn»", () => {
  it("the errand a body is running (where-are-you-going / what-are-you-doing)", () => {
    expect(stepActivity({ kind: "deposit", tplKey: "tidy", goodKey: "furn.chair" }))
      .toEqual({ verb: "put", object: "chair" });
    expect(stepActivity({ kind: "take", tplKey: "tidy", goodKey: "furn.workbench" }))
      .toEqual({ verb: "get", object: "workbench" });
  });

  it("a haul announcement and the live activity it becomes", () => {
    const goal = { kind: "transfer" as const, goods: { "furn.door": 1 }, to: { kind: "home" as const } };
    const line = goalIntentLine(goal as never, SYMS as never)!;
    expect(line.c).toContain("door");
    saysNoFurn(line.c);
    expect(goalActivity(goal as never, SYMS as never)).toEqual({ verb: "carry", object: "door" });
  });

  it("a craft announcement", () => {
    const line = goalIntentLine(
      { kind: "craft", glyph: "furn.workbench" } as never,
      SYMS as never,
    )!;
    expect(line.c).toContain("workbench");
    saysNoFurn(line.c);
  });

  it("the sentence layer folds a leaked stack glyph anyway (the last defence)", () => {
    // canonicalToken (lang/core) is the backstop: a `furn.` token that reaches
    // the language layer still speaks as its piece.
    expect(translateGlyph("furn.chair + in + home", "en")).toBe("The chair is in the house.");
    saysNoFurn(translateGlyph("i_me + want.not + furn.workbench", "en"));
  });
});

describe("a piece's word is rendered in the player's language", () => {
  it("names every craftable piece in every shipped ruleset", () => {
    const craftable = FURNITURE_ITEMS.filter((f) => f.craft);
    expect(craftable.length).toBeGreaterThan(0);
    for (const f of craftable) {
      const word = fixtureWord(f.kind);
      for (const locale of LOCALES) {
        const lex = languageFor(locale).lexicon[word];
        // A kind with no lexeme falls back to the glyph key — an English word
        // on a board that is not in English (the bug this pins).
        expect(`${locale}:${word}:${lex?.w ?? "MISSING"}`).toBe(`${locale}:${word}:${lex?.w}`);
        expect(lex?.w).toBeTruthy();
      }
    }
  });

  it("labels a stored piece as a localized bare noun phrase — no article, no full stop", () => {
    // What a container board / the pocket strip shows: one glyph in, a button's
    // worth of text out.
    expect(glyphLabel(drawnGlyph("furn.workbench"), "en")).toBe("workbench");
    expect(glyphLabel(drawnGlyph("furn.workbench"), "he")).toBe("שולחן עבודה");
    // The romance rulesets article an utterance ("una caja") — a label is a
    // word, not an utterance.
    expect(glyphLabel(drawnGlyph("furn.chest"), "es")).toBe("caja");
    expect(translateGlyph(drawnGlyph("furn.chest"), "es")).toBe("una caja");
    for (const locale of LOCALES) {
      for (const f of FURNITURE_ITEMS) {
        const label = glyphLabel(drawnGlyph(furnitureGlyph(f.kind as StationKind)), locale);
        saysNoFurn(label);
        expect(label).not.toMatch(/[.!?]$/); // a label is not a sentence
      }
    }
  });

  it("keeps a facet in the label, in the ruleset's own adjective order", () => {
    expect(glyphLabel(drawnGlyph("furn.chair.color_red"), "en")).toBe("red chair");
    expect(glyphLabel(drawnGlyph("furn.chair.color_red"), "es")).toBe("silla roja");
    // A determiner that MEANS something is not an article and stays.
    expect(glyphLabel("chair.my", "es")).toBe("mi silla");
  });

  it("lets the LEXICON outrank the host's English label on builder buttons", () => {
    // The host hands the builder an English label for every noun (the glyph key
    // IS an English word). A word that the ruleset can say must be said in it…
    //
    // 🔁 RE-AIMED 2026-09-01 — the LAW is unchanged, the place it is observable
    // moved. This used to read the DEFAULT board's JSON, which only serialises
    // page-one buttons plus each chip's id and three exemplar KEYS. A desire
    // board withholds objects in favour of chips, so both nouns are chip
    // MEMBERS and neither label is on the wire until the chip is opened. Open
    // it: same claim, asserted where labels are actually emitted.
    const host = {
      locale: "he",
      nouns: [
        { symbol: "chair", label: "chair", kind: "item", affords: ["want", "get", "give"] },
        { symbol: "mara", label: "Mara", kind: "creature", affords: ["talk"] },
      ],
    };
    const labelsIn = (group: string): string[] =>
      (builderSurfaceFor("i_me + want", { ...host, group } as never).buttons as { label?: string }[])
        .map((b) => b.label ?? "");

    // A host noun keeps the library's properties (it declared none), so the
    // chair still clusters as furniture — and the ruleset says it in Hebrew.
    expect(labelsIn("furniture")).toContain("כיסא");
    // …while a NAME has no lexeme and stays itself.
    expect(labelsIn("creatures")).toContain("Mara");
  });
});
