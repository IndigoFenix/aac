/**
 * Sentence-builder ↔ world-engine LEXICON coverage report.
 *
 * The sentence builder draws its words from TWO stores, and only one of them
 * was ever checked:
 *
 *   1. `shared/glyph-registry.ts` → `client-aac/src/i18n/*.ts`, the static
 *      per-item vocabulary. `validate-glyphs` covers this, and a missing
 *      translation there renders the raw `aac.glyph.*` key — loud and obvious.
 *   2. `shared/world-engine/interaction/lang/*.ts`, the ENGINE's own grammar
 *      layer. Nothing covered this — and its lookup fails SILENTLY:
 *      `baseWord()` returns the raw English head when a word has no lexeme, so
 *      an untranslated word renders as a plausible English button on a Hebrew
 *      board rather than as an obvious key. `validate-i18n` (locale files vs
 *      each other) and `scan:i18n` (files vs `t()` call sites) both miss it:
 *      there is no `t()` call and no locale file anywhere in that path.
 *
 * The reachable set and the checks live in
 * `shared/world-engine/interaction/intent/builder-coverage.ts`, shared with the
 * jest gate (`server/tests/world-engine/builder-lexicon.test.ts`) so the two can
 * never disagree about what "reachable" means. This file is the REPORT.
 *
 * Only the SHIPPED rulesets are checked (en · he · es · pt). The other app
 * locales (fr, de, ru, ko, zh, yue, ar) have no ruleset by design — they fall
 * back to English wholesale (lang/index.ts) — so reporting them would be seven
 * columns of noise about a decision already made.
 *
 * Usage:
 *   npm run validate-builder-lexicon                  # errors + warnings
 *   npm run validate-builder-lexicon:report           # everything, never fails
 *   npx tsx scripts/validate-builder-lexicon.ts --verbose
 *   npx tsx scripts/validate-builder-lexicon.ts --quiet     # errors only
 *   npx tsx scripts/validate-builder-lexicon.ts --strict    # warnings fail too
 *   npx tsx scripts/validate-builder-lexicon.ts --same-as-english
 *   npx tsx scripts/validate-builder-lexicon.ts --no-fail
 *
 * Exits 1 when any error-severity finding is present.
 */

import { en } from "../shared/world-engine/interaction/lang/en.js";
import { he } from "../shared/world-engine/interaction/lang/he.js";
import { es } from "../shared/world-engine/interaction/lang/es.js";
import { pt } from "../shared/world-engine/interaction/lang/pt.js";
import {
  builderReachableHeads,
  lexiconCoverageFindings,
  type CoverageFinding,
  type CoverageRule,
} from "../shared/world-engine/interaction/intent/builder-coverage.js";
import { MODE_CHIPS } from "../shared/glyph-registry.js";
import { BUILDER_CATEGORIES } from "../shared/world-engine/interaction/intent/builder-surface.js";
import { TYPE_CHIPS } from "../shared/world-engine/interaction/intent/surface-next.js";
import { en as clientEn } from "../client-aac/src/i18n/en.js";

const argv = process.argv.slice(2);
const flags = {
  verbose: argv.includes("--verbose"),
  quiet: argv.includes("--quiet"),
  strict: argv.includes("--strict"),
  noFail: argv.includes("--no-fail"),
  sameAsEnglish: argv.includes("--same-as-english"),
};

/** English FIRST — it is the source ruleset the others are compared against. */
const LANGS = [en, he, es, pt] as const;

/**
 * `<lang>:<head>` pairs whose value is SUPPOSED to read as English — a real
 * translation that happens to be spelled the same. Listing them is what keeps
 * `--same-as-english` a SIGNAL: four permanently-warning lines are four lines
 * a reader learns to skip, and the fifth (a genuine oversight) skips with them.
 */
const ALLOWED_SAME_AS_ENGLISH = new Set<string>([
  "es:material", // "material" is the Spanish word too
  "pt:material", // …and the Portuguese one
  "pt:banana", // the fruit keeps its name
  "es:no", // Spanish "no" is Spanish, not an untranslated English "no"
]);

const reachable = builderReachableHeads();
const findings = lexiconCoverageFindings(LANGS, {
  sameAsEnglishEverywhere: flags.sameAsEnglish,
  allowedSameAsEnglish: ALLOWED_SAME_AS_ENGLISH,
});

const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");

if (!flags.quiet) {
  console.log("=== Sentence-builder lexicon coverage ===");
  console.log(`Reachable heads: ${reachable.size} · shipped rulesets: ${LANGS.map((l) => l.id).join(", ")}`);
  for (const lang of LANGS) {
    const missing = findings.filter(
      (f) => f.lang === lang.id && (f.rule === "missing-locale" || f.rule === "missing-en"),
    ).length;
    const covered = reachable.size - missing;
    const pct = ((covered / reachable.size) * 100).toFixed(1);
    console.log(
      `  ${lang.id.padEnd(4)} ${String(covered).padStart(4)}/${reachable.size}  ${pct.padStart(5)}%  ${missing === 0 ? "ok" : `${missing} missing`}`,
    );
  }
  console.log();
}

const byRule = new Map<CoverageRule, CoverageFinding[]>();
for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);

if (findings.length) console.log("=== Findings ===\n");
const RULE_ORDER: CoverageRule[] = ["missing-en", "empty-value", "missing-locale", "same-as-english"];
for (const rule of RULE_ORDER) {
  const list = byRule.get(rule);
  if (!list?.length) continue;
  console.log(`${list[0]!.severity === "error" ? "ERROR" : "WARN "} ${rule} (${list.length})`);

  // `missing-locale` is the biggest bucket by far, so it groups by HEAD: one
  // untranslated word is one line naming its locales, not three separate lines.
  if (rule === "missing-locale") {
    const byHead = new Map<string, { langs: string[]; surface: string; en: string }>();
    for (const f of list) {
      const cur = byHead.get(f.head) ?? {
        langs: [],
        surface: f.surface,
        en: en.lexicon[f.head]?.w ?? `${f.head} (no en lexeme)`,
      };
      cur.langs.push(f.lang);
      byHead.set(f.head, cur);
    }
    const rows = [...byHead.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const shown = flags.verbose ? rows : rows.slice(0, 40);
    for (const [head, info] of shown) {
      console.log(
        `  ${head.padEnd(18)} ${`[${info.langs.join(" ")}]`.padEnd(12)} ${`"${info.en}"`.padEnd(18)} ${info.surface}`,
      );
    }
    if (rows.length > shown.length) console.log(`  … ${rows.length - shown.length} more (--verbose to list)`);
  } else {
    const shown = flags.verbose ? list : list.slice(0, 40);
    for (const f of shown) console.log(`  ${f.head.padEnd(18)} ${f.lang.padEnd(4)} ${f.detail}  (${f.surface})`);
    if (list.length > shown.length) console.log(`  … ${list.length - shown.length} more (--verbose to list)`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// TWIN BUTTONS — two heads on ONE tab that render the SAME word
// ---------------------------------------------------------------------------
//
// A tab lists its whole lexical category, so two LEXICON keys naming the same
// act become two buttons. When their lexemes agree they are two buttons a child
// cannot tell apart — `hi`/`hello` are both "שלום", `ok`/`okay` are "okay" in
// English as well.
//
// This is NOT a translation gap; it surfaced BECAUSE the gaps were filled (a
// missing lexeme used to disguise the twin as an English word beside a Hebrew
// one). Reported as a warning, never an error: the aliases are legitimate in
// the PARSER — they let it accept whatever word the AI or a user produces — so
// the fix belongs on the surfacing side (a canonical-head filter like the one
// `VERB_FAMILY`/`canonicalVerb` already gives verbs), which is a design call.
//
// `<lang>|<sorted heads>` pairs ACCEPTED as twins: two distinct concepts that
// one language genuinely spells the same. Listing them keeps the check a
// signal — a permanently-warning line is a line readers learn to skip.
const ALLOWED_TWINS = new Set<string>([
  // Spanish uses "hacer" for both, and there is no narrower verb that is right
  // for "hacer un juguete". They stay distinguishable by ART (🙌 vs 🔨), which
  // is what a child selects by. User decision 2026-08-20.
  "es|do+make",
  "pt|do+make", // "fazer" — the same fact one language over
]);

const twins: string[] = [];
{
  const byTabLabel = new Map<string, string[]>();
  for (const [head, surfaces] of reachable) {
    for (const surface of surfaces) {
      if (!surface.startsWith("tab:")) continue;
      for (const lang of LANGS) {
        const w = lang.lexicon[head]?.w;
        if (!w) continue;
        const k = `${surface}|${lang.id}|${w}`;
        byTabLabel.set(k, [...(byTabLabel.get(k) ?? []), head]);
      }
    }
  }
  const seenPair = new Set<string>();
  for (const [k, heads] of byTabLabel) {
    if (heads.length < 2) continue;
    const [surface, langId, w] = k.split("|");
    const sorted = [...heads].sort();
    if (ALLOWED_TWINS.has(`${langId}|${sorted.join("+")}`)) continue;
    const pair = `${surface}|${sorted.join("+")}`;
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    twins.push(`  ${heads.sort().join(" / ").padEnd(30)} both read "${w}" [${langId}]  (${surface})`);
  }
}
if (twins.length && !flags.quiet) {
  console.log(`WARN  twin-button (${twins.length})`);
  console.log("  Two heads on one tab rendering one word — indistinguishable buttons:");
  for (const t of twins) console.log(t);
  console.log();
}

// ---------------------------------------------------------------------------
// THE BUILDER'S CHROME IDS — the other half of "every word the builder shows"
// ---------------------------------------------------------------------------
//
// Tabs and chips are labelled from the CLIENT's i18n, and they miss the same
// way the lexicon does: `SentenceConstructorBoard` does
// `const label = t(key) === key ? chip : t(key)`, so an id with no translation
// key renders as the RAW ID ("body_parts") rather than as a visible failure.
// And these ids are DATA — no `t()` call ever names `construction.chips.animals`
// literally — so `scan:i18n` walks straight past them, exactly as it does past
// the glyph registry.
//
// Only `en.ts` is read: `validate-i18n` already pins all 11 locale files to
// identical keys on identical lines, so a key present in English is present
// everywhere. That check owns locale parity; this one owns "does the key exist
// at all for every id the builder can render".
const chrome = (clientEn as { construction?: Record<string, Record<string, unknown>> }).construction ?? {};
const chromeMissing: string[] = [];
const checkChrome = (block: string, ids: readonly string[]) => {
  const have = chrome[block] ?? {};
  for (const id of ids) if (!(id in have)) chromeMissing.push(`construction.${block}.${id}`);
};

checkChrome("tabs", Object.keys(MODE_CHIPS));
// Every mode chip across every category, deduped.
checkChrome("chips", [...new Set(Object.values(MODE_CHIPS).flatMap((v) => [...v]))]);
// The engine ladder, plus the pinned leading "all" tab the builder adds itself.
checkChrome("engineTabs", ["all", ...BUILDER_CATEGORIES]);
checkChrome("typeChips", TYPE_CHIPS.map((c) => c.kind as string));

if (chromeMissing.length) {
  console.log(`ERROR missing-chrome-key (${chromeMissing.length})`);
  console.log("  Builder tab/chip ids with no client-aac i18n key — these render as the RAW ID:");
  for (const k of chromeMissing) console.log(`  ${k}`);
  console.log();
} else if (!flags.quiet) {
  console.log("=== Builder chrome ids ===");
  console.log("  tabs / chips / engineTabs / typeChips: all ids have a client i18n key\n");
}

console.log("=== Summary ===");
console.log(`${errors.length + chromeMissing.length} error(s), ${warns.length + twins.length} warning(s)`);

// `--strict` fails on the WARNING backlog too — same contract as
// `validate-glyphs --strict`, which fails on its art backlog. The twin-button
// list is a real backlog (it needs a canonical-head filter on the surfacing
// side), so it has to count, or `--strict` would quietly mean "strict about
// some warnings".
const warnCount = warns.length + twins.length;
if (!flags.noFail && (errors.length || chromeMissing.length || (flags.strict && warnCount))) {
  process.exit(1);
}
