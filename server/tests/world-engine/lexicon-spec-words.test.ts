// THE SPEC-SIDE WORD MOVE (user decision 2026-08-12): a world-spec item's
// translations live ON ITS OWN DEFINITION (`words: ItemWords` — stations /
// programs / species / pool rows, plus content/words.ts ITEM_WORDS for items
// whose defining registry is an array or another workstream's file), joined
// into each ruleset's lexicon by content/words.ts. The central lang files
// keep only what is NOT an item: grammar, verbs, adjectives, function words,
// and the CORE ENGINE CONCEPTS (object-properties.ts CORE_CONCEPTS).
//
// Three laws pinned here:
//   1. THE MOVE IS A MOVE. Every word in the pre-move snapshot
//      (fixtures/lexicon-premove-snapshot.json) is still present, unchanged,
//      in the assembled lexicon of its locale — no word CHANGED or VANISHED.
//      This is the migration's oracle: any slip in any registry shows up here.
//
//      It was once an exact deep-equal, which also forbade words APPEARING.
//      That third clause was dropped deliberately (2026-08-20) when the
//      builder-lexicon coverage round added ~85 central words per ruleset:
//      the migration's real guarantee is that the move moved things rather
//      than rewriting them, and "nothing may ever be added" is a freeze, not
//      an oracle. Growth of the CENTRAL vocabulary stays free; growth of the
//      SPEC-side vocabulary does not — law 3's last case still pins spec-head
//      coverage against this same snapshot exactly, so a spec row still
//      cannot invent a word for a locale that never had one.
//   2. ONE DEFINITION PER HEAD. No head is defined by two spec sources, and
//      no spec head remains in a central lexicon — precedence exists to be
//      deterministic, never to hide a duplicate.
//   3. THE CHAIN IS LIVE. A spec row's lexeme is what the ruleset actually
//      renders, agreement and all.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { en, he, es, pt, translateGlyph, glyphLabel } from "@shared/world-engine/interaction/lang/index.js";
import { CENTRAL_WORDS as EN_CENTRAL } from "@shared/world-engine/interaction/lang/en.js";
import { CENTRAL_WORDS as HE_CENTRAL } from "@shared/world-engine/interaction/lang/he.js";
import { CENTRAL_WORDS as ES_CENTRAL } from "@shared/world-engine/interaction/lang/es.js";
import { CENTRAL_WORDS as PT_CENTRAL } from "@shared/world-engine/interaction/lang/pt.js";
import {
  duplicateSpecWordHeads,
  specWordHeads,
  specWords,
} from "@shared/world-engine/interaction/content/words.js";
import { CORE_CONCEPTS } from "@shared/world-engine/object-properties.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(
  readFileSync(path.join(here, "fixtures", "lexicon-premove-snapshot.json"), "utf8"),
) as Record<"en" | "he" | "es" | "pt", Record<string, unknown>>;

const LANGS = { en, he, es, pt } as const;
const CENTRALS = { en: EN_CENTRAL, he: HE_CENTRAL, es: ES_CENTRAL, pt: PT_CENTRAL } as const;
const LOCALES = ["en", "he", "es", "pt"] as const;

describe("law 1 — the move is a move (no word changed or vanished)", () => {
  for (const loc of LOCALES) {
    it(`${loc}: every pre-move word survives the move unchanged`, () => {
      const live = LANGS[loc].lexicon;
      // Compared as one object rather than in a loop so a failure names EVERY
      // drifted word at once instead of stopping at the first.
      const before = Object.keys(SNAPSHOT[loc]).sort();
      const after = Object.fromEntries(before.map((k) => [k, live[k]]));
      expect(after).toEqual(SNAPSHOT[loc]);
    });
  }
});

describe("law 2 — one definition per head", () => {
  it("no head is defined by two spec word sources", () => {
    expect(duplicateSpecWordHeads()).toEqual([]);
  });

  it("no spec head remains in a central lexicon", () => {
    const heads = specWordHeads();
    for (const loc of LOCALES) {
      const stale = [...heads].filter((h) => h in CENTRALS[loc]).sort();
      expect({ loc, stale }).toEqual({ loc, stale: [] });
    }
  });

  it("core engine concepts stay central — a spec row may not claim one", () => {
    const claimed = [...specWordHeads()].filter((h) => CORE_CONCEPTS.has(h)).sort();
    expect(claimed).toEqual([]);
  });
});

describe("law 3 — the chain is live end to end", () => {
  it("a spec item's word renders with full agreement in every ruleset", () => {
    // wood rides the ITEM_WORDS catalog; the Hebrew request needs its gender.
    expect(translateGlyph("i_me + want + wood", "he")).toBe("אני רוצה עץ.");
    expect(glyphLabel("wood", "es")).toBe("madera");
    expect(glyphLabel("wood", "en")).toBe("wood");
  });

  it("a spec item's lexeme object IS the assembled entry (no copy drift)", () => {
    for (const loc of LOCALES) {
      const overlay = specWords(loc);
      for (const [head, lex] of Object.entries(overlay)) {
        expect(LANGS[loc].lexicon[head]).toBe(lex);
      }
    }
  });

  it("a locale an item never authored keeps the raw-head fallback", () => {
    // No spec source may invent a word the old lexicons lacked: for every
    // spec head, locale coverage must match the snapshot exactly.
    for (const loc of LOCALES) {
      for (const head of specWordHeads()) {
        const had = head in SNAPSHOT[loc];
        const has = head in LANGS[loc].lexicon;
        expect({ loc, head, has }).toEqual({ loc, head, has: had });
      }
    }
  });
});
