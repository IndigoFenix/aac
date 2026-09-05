// server/tests/world-engine/builder-attribute-verb-chips.test.ts
//
// THE TWO BIG LEXICAL TABS' SUB-CHIPS — Descriptions (`attribute`) and Actions
// (`verb`), the way People got contacts · people · animals (user, 2026-09-04).
//
// THE GAP THIS CLOSES. A lexical tab lists its WHOLE category, and these two are
// thirty-eight and sixty-five words. On a board that withholds words behind
// More, a category nobody can slice is a category most of whose words the child
// never reaches — the same failure the WHO tab had before its chips, one tab
// over. The five remaining lexical tabs each fit one page and stay flat.
//
// ⚖️ THE PARTITION IS THE POINT. Every LEXICON key of either category lands in
// EXACTLY ONE chip, asserted both ways below, so a verb added to the parser
// tomorrow cannot quietly reach no chip: it stays parseable, it stays on "All",
// and it silently leaves the only surface a child can find it on. That is why
// the membership lives in ONE exported table (`LEXICAL_TAB_CHIPS`) with the chip
// ROW derived from it, rather than in an order list plus a membership list.
//
// ⚠️ COLOURS ARE WORDS, NOT RAIL ENTRIES. The eleven `color_*` keys became
// LEXICON attributes so the [colors] chip can list them, and they are
// deliberately kept OFF the item modifier rail: the rail is capped at eight, and
// eleven colours would be the whole of it. `AXIS_WORDS.color` exists and
// `AXES_FOR_KIND`/`AXES_FOR_PROPERTY` never name it — pinned here, because that
// omission looks like an oversight to anyone who does not know why.

import { describe, it, expect } from "@jest/globals";
import {
  builderSurfaceFor,
  lexicalTabChipIds,
  LEXICAL_TAB_CHIPS,
} from "@shared/world-engine/interaction/intent/builder-surface";
import { LEXICON } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  AXES_FOR_KIND,
  AXES_FOR_PROPERTY,
  AXIS_WORDS,
  OBJECT_PROPERTIES,
} from "@shared/world-engine/object-properties.js";
import { en, he, es, pt } from "@shared/world-engine/interaction/lang/index.js";
import { baseWord } from "@shared/world-engine/interaction/lang/core.js";

const ids = (groups: Array<{ id: string }> | undefined) => (groups ?? []).map((g) => g.id);
const keys = (buttons: Array<{ key: string }>) => buttons.map((b) => b.key);

/** Every LEXICON key of one lexical category, in the table's own order — which
 *  is exactly what the tab's "All" listing is. */
const categoryKeys = (cat: string) => Object.keys(LEXICON).filter((k) => LEXICON[k]!.cat === cat);

const LANGS = [en, he, es, pt] as const;

describe("the chip row each tab advertises", () => {
  it("Descriptions offers colors · feelings · size · condition", () => {
    expect(ids(builderSurfaceFor("", { category: "attribute" }).groups)).toEqual([
      "colors", "feelings", "size", "condition",
    ]);
  });

  it("Actions offers go · hands · make · together · body · want", () => {
    expect(ids(builderSurfaceFor("", { category: "verb" }).groups)).toEqual([
      "go", "hands", "make", "together", "body", "want",
    ]);
  });

  it("derives the row from the one membership table (never a second list)", () => {
    expect(lexicalTabChipIds("attribute")).toEqual(["colors", "feelings", "size", "condition"]);
    expect(lexicalTabChipIds("verb")).toEqual(["go", "hands", "make", "together", "body", "want"]);
    expect(lexicalTabChipIds("quantity")).toEqual([]);
  });

  it("still offers the whole row while one chip is open", () => {
    // A child who opened [colors] has to reach [feelings] without going back out
    // through the tab.
    expect(ids(builderSurfaceFor("", { category: "attribute", group: "colors" }).groups)).toEqual([
      "colors", "feelings", "size", "condition",
    ]);
    expect(ids(builderSurfaceFor("", { category: "verb", group: "body" }).groups)).toHaveLength(6);
  });

  it("wears up to three of its own members as the chip's face", () => {
    const byId = new Map((builderSurfaceFor("", { category: "verb" }).groups ?? []).map((g) => [g.id, g]));
    expect(byId.get("go")!.glyphs).toEqual(["go", "come", "stop"]);
    expect(byId.get("go")!.glyph).toBe("go");
    const attrs = new Map((builderSurfaceFor("", { category: "attribute" }).groups ?? []).map((g) => [g.id, g]));
    expect(attrs.get("colors")!.glyphs).toEqual(["color_red", "color_orange", "color_yellow"]);
    // [size] has exactly two members — the face is two, never padded.
    expect(attrs.get("size")!.glyphs).toEqual(["big", "small"]);
  });
});

describe("what 'All' and each chip open", () => {
  it("'All' stays the tab's WHOLE lexical category — a chip is a filter", () => {
    expect(keys(builderSurfaceFor("", { category: "attribute" }).buttons)).toEqual(categoryKeys("attribute"));
    expect(keys(builderSurfaceFor("", { category: "verb" }).buttons)).toEqual(categoryKeys("verb"));
  });

  it("each chip opens exactly its members, in the authored order", () => {
    for (const [id, def] of Object.entries(LEXICAL_TAB_CHIPS)) {
      const s = builderSurfaceFor("", { category: def.tab, group: id });
      expect({ id, keys: keys(s.buttons) }).toEqual({ id, keys: [...def.keys] });
    }
  });

  it("[colors] is the registry's eleven, in palette order", () => {
    expect(keys(builderSurfaceFor("", { category: "attribute", group: "colors" }).buttons)).toEqual([
      "color_red", "color_orange", "color_yellow", "color_green", "color_blue",
      "color_purple", "color_pink", "color_brown", "color_black", "color_white", "color_gray",
    ]);
  });

  it("[feelings] carries the mood AND bodily words a child answers 'how are you' with", () => {
    const k = keys(builderSurfaceFor("", { category: "attribute", group: "feelings" }).buttons);
    for (const w of ["happy", "sad", "hungry", "tired", "angry", "scared", "hurt", "proud", "calm"]) {
      expect({ w, on: k.includes(w) }).toEqual({ w, on: true });
    }
  });

  it("falls back to the full listing on a foreign or stale chip id", () => {
    // "food" is a THINGS-tab cluster; "colors" belongs to the other lexical tab.
    // Neither may empty the board (the [contacts] exception is the person tab's
    // alone — every chip here has fixed membership and can never arrive empty).
    for (const grp of ["food", "gone", "colors"]) {
      expect(keys(builderSurfaceFor("", { category: "verb", group: grp }).buttons)).toEqual(categoryKeys("verb"));
    }
    for (const grp of ["food", "gone", "hands"]) {
      expect(keys(builderSurfaceFor("", { category: "attribute", group: grp }).buttons)).toEqual(
        categoryKeys("attribute"),
      );
    }
  });
});

describe("the partition — every word on exactly one chip", () => {
  for (const cat of ["attribute", "verb"] as const) {
    it(`${cat}: the chips together ARE the category, with no word twice`, () => {
      const members = lexicalTabChipIds(cat).flatMap((id) => [...LEXICAL_TAB_CHIPS[id]!.keys]);
      // No duplicates ACROSS chips (a word on two chips is two buttons meaning
      // one thing — and the child cannot tell which chip they last found it on).
      expect(members.length).toBe(new Set(members).size);
      // Exactly the category: nothing unlisted (the failure this pins), and
      // nothing listed that the parser does not actually have.
      expect([...members].sort()).toEqual([...categoryKeys(cat)].sort());
    });
  }

  it("every chip clears the SpeakMenu's ≥2 rule", () => {
    // A chip that opens one word is a wasted press. Reported as a map so a
    // failure names the thin chip rather than stopping at the first.
    const sizes = Object.fromEntries(
      Object.entries(LEXICAL_TAB_CHIPS).filter(([, d]) => d.keys.length < 2).map(([id, d]) => [id, d.keys.length]),
    );
    expect(sizes).toEqual({});
  });
});

describe("colours are words, NOT modifier-rail entries", () => {
  it("no colour reaches the item modifier rail", () => {
    for (const glyph of ["apple", "shirt", "ball", "i_me", "home"]) {
      const mods = builderSurfaceFor(glyph).modifiers ?? [];
      expect({ glyph, colors: mods.filter((m) => m.key.startsWith("color_")) }).toEqual({ glyph, colors: [] });
    }
  });

  it("the `color` axis is bound to no kind and no property — deliberately", () => {
    expect(AXIS_WORDS.color).toHaveLength(11);
    for (const kind of Object.keys(AXES_FOR_KIND) as (keyof typeof AXES_FOR_KIND)[]) {
      expect({ kind, has: AXES_FOR_KIND[kind].includes("color") }).toEqual({ kind, has: false });
    }
    for (const p of OBJECT_PROPERTIES) {
      expect({ p, has: AXES_FOR_PROPERTY[p].includes("color") }).toEqual({ p, has: false });
    }
  });

  it("a colour FACET still parses exactly as it did (`shirt.color_red`)", () => {
    // The whole risk of making colours lexicon words: a modifier is read off the
    // token's `.mods`, never through the lexicon, so the recolour path must be
    // untouched. `shirt` stays the head and the colour stays its modifier.
    const s = builderSurfaceFor("shirt.color_red");
    expect(s.modifiers?.some((m) => m.key === "color_red")).toBeFalsy();
    expect(LEXICON.color_red).toEqual({ cat: "attribute" });
  });
});

describe("every new word is sayable in every SHIPPED ruleset", () => {
  it("`color_gray` and the seven feelings render as themselves, never the English head", () => {
    // `baseWord` falls back to the raw head (with the `color_` prefix stripped),
    // and a head IS an English word — so this fails SILENTLY in exactly the three
    // rulesets a reviewer reading English cannot see. Pinned per locale.
    const words = (locale: (typeof LANGS)[number], head: string) => baseWord(locale, head);
    expect(words(en, "color_gray")).toBe("gray");
    expect(words(he, "color_gray")).toBe("אפור");
    expect(words(es, "color_gray")).toBe("gris");
    expect(words(pt, "color_gray")).toBe("cinza");

    for (const head of ["angry", "scared", "excited", "hurt", "surprised", "proud", "calm"]) {
      for (const lang of [he, es, pt]) {
        // A lexeme exists AND it is not the English word wearing a disguise.
        expect({ head, lang: lang.id, has: !!lang.lexicon[head] }).toEqual({ head, lang: lang.id, has: true });
        expect({ head, lang: lang.id, w: baseWord(lang, head) }).not.toEqual({
          head, lang: lang.id, w: baseWord(en, head),
        });
      }
    }
  });

  it("labels the Descriptions chips as NOUNS in all four", () => {
    const labels = (locale: string) =>
      new Map((builderSurfaceFor("", { category: "attribute", locale }).groups ?? []).map((g) => [g.id, g.label]));
    expect(labels("en")).toEqual(
      new Map([["colors", "colors"], ["feelings", "feelings"], ["size", "size"], ["condition", "condition"]]),
    );
    expect(labels("he")).toEqual(
      new Map([["colors", "צבעים"], ["feelings", "רגשות"], ["size", "גודל"], ["condition", "מצב"]]),
    );
    expect(labels("es")).toEqual(
      new Map([["colors", "colores"], ["feelings", "sentimientos"], ["size", "tamaño"], ["condition", "estado"]]),
    );
    expect(labels("pt")).toEqual(
      new Map([["colors", "cores"], ["feelings", "sentimentos"], ["size", "tamanho"], ["condition", "estado"]]),
    );
  });

  it("labels the Action chips in all four — a VERB-headed chip wears the INFINITIVE", () => {
    // ⚠️ `w` is the 1st-person singular in the romance rulesets and the present
    // participle in Hebrew, so the three verb-headed chips used to name their
    // categories "voy · hago · quiero" — *I go, I make, I want*. The citation
    // form is what a category name wants (`INFINITIVE_LABEL_CHIPS`). English is
    // unaffected: its infinitive IS its base form.
    const labels = (locale: string) =>
      new Map((builderSurfaceFor("", { category: "verb", locale }).groups ?? []).map((g) => [g.id, g.label]));
    expect(labels("en")).toEqual(
      new Map([["go", "go"], ["hands", "hands"], ["make", "make"], ["together", "together"], ["body", "body"], ["want", "want"]]),
    );
    expect(labels("he")).toEqual(
      new Map([["go", "ללכת"], ["hands", "ידיים"], ["make", "להכין"], ["together", "ביחד"], ["body", "גוף"], ["want", "לרצות"]]),
    );
    expect(labels("es")).toEqual(
      new Map([["go", "ir"], ["hands", "manos"], ["make", "hacer"], ["together", "juntos"], ["body", "cuerpo"], ["want", "querer"]]),
    );
    expect(labels("pt")).toEqual(
      new Map([["go", "ir"], ["hands", "mãos"], ["make", "fazer"], ["together", "juntos"], ["body", "corpo"], ["want", "querer"]]),
    );
  });

  it("ALL THREE verb-headed chips carry a real infinitive in he/es/pt", () => {
    // The positive form of the rule: not one of these three may fall back to
    // `w`, because `w` is the 1sg ("quiero") or the participle ("רוצה") and a
    // category named that way tells the child the wrong thing. Asserted against
    // the LEXEME as well as the rendered chip, so a lexeme that quietly lost its
    // `inf` fails here rather than silently reverting the label.
    //
    // `want` gained its `inf` on 2026-09-04 (he לרצות, es/pt querer) — the one
    // re-baselined entry in the pre-move snapshot, documented in law 1's comment
    // over in lexicon-spec-words.test.ts. `go` and `make` had theirs all along.
    const chipLabel = (locale: string, id: string) =>
      builderSurfaceFor("", { category: "verb", locale }).groups!.find((g) => g.id === id)!.label;
    for (const lang of [he, es, pt]) {
      for (const head of ["go", "make", "want"]) {
        const inf = lang.lexicon[head]?.inf;
        expect({ lang: lang.id, head, hasInf: !!inf }).toEqual({ lang: lang.id, head, hasInf: true });
        expect({ lang: lang.id, head, label: chipLabel(lang.id, head) }).toEqual({
          lang: lang.id, head, label: inf,
        });
        // …and it is genuinely a DIFFERENT form from the base word, or the chip
        // is still wearing the conjugation under another name.
        expect({ lang: lang.id, head, same: inf === lang.lexicon[head]!.w }).toEqual({
          lang: lang.id, head, same: false,
        });
      }
    }
  });

  it("`colors` is NOT the head `color` — that one is the VERB", () => {
    // The `plants`/`plant` trap, one chip row over: labelling a category of
    // adjectives with the recolour verb would put "I am colouring" on it in
    // three of the four rulesets.
    for (const lang of LANGS) {
      expect({ id: lang.id, same: baseWord(lang, "colors") === baseWord(lang, "color") }).toEqual({
        id: lang.id,
        same: false,
      });
    }
  });
});
