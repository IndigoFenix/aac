// THE SENTENCE BUILDER'S WORDS MUST BE SAYABLE IN EVERY SHIPPED LANGUAGE.
//
// The builder draws from two stores. The glyph registry → client i18n half is
// gated by `glyph-registry.test.ts`, and a miss there renders a raw
// `aac.glyph.*` key — obvious the moment anyone looks. The ENGINE half (the
// `interaction/lang` rulesets) had no gate at all, and it fails SILENTLY:
// `baseWord()` returns the raw head when a word has no lexeme, and a head is an
// English word, so English looked perfect while Hebrew, Spanish and Portuguese
// put English words on a child's board.
//
// That had already been found and hand-patched at least three times (the
// furniture kinds, the construction trade, the posture pair — read their
// comments in the lang files). A word is added to the parser far more often
// than anyone remembers to add four lexemes, so the rule is pinned here rather
// than trusted to memory.
//
// The reachable set and the checks come from `builder-coverage.ts`, shared with
// `scripts/validate-builder-lexicon.ts` — the report and the gate can never
// disagree about what "reachable" means.

import { describe, it, expect } from "@jest/globals";
import { en, he, es, pt } from "@shared/world-engine/interaction/lang/index.js";
import {
  builderReachableHeads,
  lexiconCoverageFindings,
  rawHeadFallback,
} from "@shared/world-engine/interaction/intent/builder-coverage.js";
import { glyphLabel } from "@shared/world-engine/interaction/lang/index.js";

/** English FIRST — the source ruleset the others are compared against. */
const LANGS = [en, he, es, pt] as const;

describe("builder lexicon coverage", () => {
  it("every reachable head has a lexeme in every shipped ruleset", () => {
    const errors = lexiconCoverageFindings(LANGS).filter((f) => f.severity === "error");
    // Reported as `<lang>:<head>` strings so a failure names the missing words
    // outright instead of printing a diff of two large objects.
    expect(errors.map((f) => `${f.lang}:${f.head} (${f.surface})`).sort()).toEqual([]);
  });

  it("no Hebrew value is byte-identical to its English source", () => {
    // Hebrew is written in another script, so an identical string is an
    // untranslated leftover rather than a coincidence. es/pt are exempt: they
    // share real cognates with English ("material", "no").
    const same = lexiconCoverageFindings(LANGS).filter((f) => f.rule === "same-as-english");
    expect(same.map((f) => `${f.lang}:${f.head}`).sort()).toEqual([]);
  });

  it("the reachable set covers all four builder surfaces", () => {
    // A guard on the DERIVATION, not the translations: if a refactor made
    // `builderReachableHeads` silently return less, the coverage test above
    // would pass while checking nothing. Every surface must contribute.
    const surfaces = new Set<string>();
    for (const s of builderReachableHeads().values()) {
      for (const one of s) surfaces.add(one.split(":")[0]!);
    }
    expect([...surfaces].sort()).toEqual(["group-chip", "modifier", "tab", "things"]);
    expect(builderReachableHeads().size).toBeGreaterThan(150);
  });

  it("a covered head no longer renders as its English key", () => {
    // The end-to-end reading of the bug: these four are the words the report
    // that started this named, and each one used to come back as the English
    // head in every ruleset.
    for (const head of ["bad", "if", "what", "where"]) {
      for (const lang of [he, es, pt]) {
        const label = glyphLabel(head, lang.id);
        expect({ head, lang: lang.id, label }).not.toEqual({
          head,
          lang: lang.id,
          label: rawHeadFallback(head),
        });
      }
    }
  });

  it("`good` and `bad` are both sayable — a pair is covered or it is not", () => {
    // The asymmetry that made the bug visible to a human: `good` shipped with
    // lexemes and `bad` never did, so a Hebrew board offered טוב beside "bad".
    for (const lang of LANGS) {
      expect({ id: lang.id, good: !!lang.lexicon.good, bad: !!lang.lexicon.bad }).toEqual({
        id: lang.id,
        good: true,
        bad: true,
      });
    }
  });
});
