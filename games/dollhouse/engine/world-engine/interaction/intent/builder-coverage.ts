// shared/world-engine/interaction/intent/builder-coverage.ts
//
// WHICH WORDS THE SENTENCE BUILDER CAN PUT IN FRONT OF A CHILD, and whether
// each shipped ruleset can actually say them.
//
// THE GAP THIS EXISTS FOR. The builder draws from two stores, and only one was
// ever checked:
//   1. `shared/glyph-registry.ts` → `client-aac/src/i18n/*.ts`, covered by
//      `validate-glyphs`. A miss there renders the raw `aac.glyph.*` key —
//      loud, obvious, caught.
//   2. the engine's own grammar layer (`interaction/lang/*.ts`), covered by
//      nothing. Its lookup fails SILENTLY: `baseWord()` returns the raw head
//      when a word has no lexeme, and a head is an English word, so English
//      looks perfect while Hebrew, Spanish and Portuguese quietly put an
//      English word on the board. `validate-i18n` (locale files against each
//      other) and `scan:i18n` (files against `t()` call sites) both miss it —
//      there is no `t()` call and no locale file in the path at all.
//
// The failure has been found and patched by hand at least three times (the
// furniture kinds, the construction trade, the posture pair — each of their
// comments says so). This module is the systematic version: derive the set,
// check it, fail the build.
//
// Consumers: `scripts/validate-builder-lexicon.ts` (the report) and
// `server/tests/world-engine/builder-lexicon.test.ts` (the merge gate). Both
// read THIS, so the reachable set is defined once.

import type { GlyphLanguage } from "../lang/core.js";
import { LEXICON } from "./parse-intent.js";
import { BUILDER_CATEGORIES, GROUP_LABEL_HEAD, defaultBuilderNouns } from "./builder-surface.js";
import { AXIS_WORDS, OBJECT_PROPERTIES } from "../../object-properties.js";
import { headOf } from "../../variations.js";

/**
 * Every head the builder can surface, mapped to the surfaces that show it.
 *
 * The four surfaces mirror `builderSurfaceFor` exactly:
 *   - `tab:<cat>`      a lexical-category tab lists its WHOLE category
 *                      (`LEX_KEYS.filter(cat === tab)`), so every LEXICON key
 *                      under a builder category is one press away.
 *   - `things:*`       `defaultBuilderNouns()` — the curated out-of-game
 *                      objects plus every room/building the programs declare.
 *                      In-game nouns are host-pushed and carry their own
 *                      spec-side words (pinned by the spec-words oracle), so
 *                      they are not re-derived here.
 *   - `modifier:<axis>` the descriptor rail, `AXIS_WORDS`, via `baseWord`.
 *   - `group-chip:*`   a cluster chip wears `baseWord(GROUP_LABEL_HEAD[id] ?? id)`,
 *                      and the property clusters ARE their own ids. Every chip
 *                      id the builder can render — the noun clusters, the WHO
 *                      tab's three, and the Descriptions/Actions slices of
 *                      `LEXICAL_TAB_CHIPS` — is listed in that table for this
 *                      reason: an id left out of it is a chip whose label
 *                      nothing checks, and an unchecked label renders as the
 *                      raw English id on a Hebrew board.
 *
 * A composed symbol (`room(bed)`) is spoken by its HEAD — that is what a
 * lexicon has to carry — so heads are what this returns.
 */
export function builderReachableHeads(): Map<string, Set<string>> {
  const reachable = new Map<string, Set<string>>();
  const reach = (head: string, surface: string) => {
    if (!head) return;
    const s = reachable.get(head) ?? new Set<string>();
    s.add(surface);
    reachable.set(head, s);
  };

  const tabCategories = new Set(BUILDER_CATEGORIES.filter((c) => c !== "things"));
  for (const [key, lex] of Object.entries(LEXICON)) {
    const cat = (lex as { cat: string }).cat;
    if (tabCategories.has(cat)) reach(key, `tab:${cat}`);
  }

  for (const n of defaultBuilderNouns()) {
    reach(headOf(n.symbol), n.kind === "place" ? "things:place" : "things:item");
  }

  for (const [axis, words] of Object.entries(AXIS_WORDS)) {
    for (const w of words) reach(w, `modifier:${axis}`);
  }

  for (const p of OBJECT_PROPERTIES) reach(p, "group-chip:property");
  for (const head of Object.values(GROUP_LABEL_HEAD)) reach(head, "group-chip:kind");

  return reachable;
}

export type CoverageRule = "missing-en" | "missing-locale" | "empty-value" | "same-as-english";

export interface CoverageFinding {
  severity: "error" | "warn";
  rule: CoverageRule;
  head: string;
  lang: string;
  /** The builder surfaces that can show this word, comma-joined and sorted. */
  surface: string;
  detail: string;
}

export interface CoverageOpts {
  /** Ruleset ids written in a script other than Latin — a value byte-identical
   *  to English there is an untranslated signal, not a coincidence. */
  nonLatin?: ReadonlySet<string>;
  /** Extend the byte-identical check to the LATIN rulesets, where a shared
   *  spelling is often a real cognate rather than an oversight. */
  sameAsEnglishEverywhere?: boolean;
  /** `<lang>:<head>` pairs whose value is SUPPOSED to read as English. */
  allowedSameAsEnglish?: ReadonlySet<string>;
}

/** What `baseWord` would fall back to for a head with no lexeme — i.e. exactly
 *  what the child sees today when the lookup misses. */
export const rawHeadFallback = (head: string): string =>
  head.replace(/^color_/, "").replace(/_/g, " ");

/**
 * Check every reachable head against every shipped ruleset.
 *
 * `langs[0]` is the SOURCE ruleset (English): the raw-head fallback happens to
 * be correct there — a head IS an English word — so an English gap is cosmetic
 * while the same gap elsewhere puts an English word on a child's board. The
 * other rulesets are therefore still checked when English is missing; skipping
 * them (the first cut of this did) hides exactly the words this exists to find.
 *
 * THE LEXICON IS READ ASSEMBLED, never as the authored literal: the live table
 * is `CENTRAL ⊕ specWords(locale)`, so a word carried by a station / program /
 * species / pool row counts as covered. Grepping a lang file — which is what a
 * human does — reports false gaps for precisely the words the spec side owns.
 */
export function lexiconCoverageFindings(
  langs: readonly GlyphLanguage[],
  opts: CoverageOpts = {},
): CoverageFinding[] {
  const nonLatin = opts.nonLatin ?? new Set(["he"]);
  const allowed = opts.allowedSameAsEnglish ?? new Set<string>();
  const source = langs[0];
  if (!source) return [];
  const others = langs.slice(1);

  const reachable = builderReachableHeads();
  const findings: CoverageFinding[] = [];

  for (const head of [...reachable.keys()].sort()) {
    const surface = [...reachable.get(head)!].sort().join(", ");
    const srcLex = source.lexicon[head];

    if (!srcLex) {
      findings.push({
        severity: "error",
        rule: "missing-en",
        head,
        lang: source.id,
        surface,
        detail: "no lexeme — `baseWord` falls back to the raw head",
      });
    } else if (!srcLex.w?.trim()) {
      findings.push({ severity: "error", rule: "empty-value", head, lang: source.id, surface, detail: "blank `w`" });
    }

    const srcWord = srcLex?.w?.trim() || rawHeadFallback(head);

    for (const lang of others) {
      const lex = lang.lexicon[head];
      if (!lex) {
        findings.push({
          severity: "error",
          rule: "missing-locale",
          head,
          lang: lang.id,
          surface,
          detail: `renders the English "${srcWord}"`,
        });
        continue;
      }
      if (!lex.w?.trim()) {
        findings.push({ severity: "error", rule: "empty-value", head, lang: lang.id, surface, detail: "blank `w`" });
        continue;
      }
      const checkSame = nonLatin.has(lang.id) || !!opts.sameAsEnglishEverywhere;
      if (checkSame && lex.w === srcWord && !allowed.has(`${lang.id}:${head}`)) {
        findings.push({
          severity: "warn",
          rule: "same-as-english",
          head,
          lang: lang.id,
          surface,
          detail: `byte-identical to English ("${srcWord}")`,
        });
      }
    }
  }

  return findings;
}
