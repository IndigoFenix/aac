/**
 * i18n Key Inserter
 *
 * Adds a batch of new keys to EVERY locale file of a bundle at the same
 * structural position, so the "identical keys on identical lines" invariant
 * that validate-i18n enforces survives the insert.
 *
 * Doing this by hand across 11 files is how line drift gets introduced; doing
 * it with 11 parallel agents is worse. So: one deterministic pass here, then
 * translators only ever *replace a value in place* and never insert a line.
 *
 * Non-English files are seeded with the English text and a trailing
 * `// TODO-i18n` marker on the same line, which is how the translate step
 * finds what still needs doing. Replacing the value and dropping the marker
 * keeps the line count identical.
 *
 * Input JSON:
 *   {
 *     "bundle": "client-aac",
 *     "keys": [ { "key": "login.signIn", "en": "Sign In" }, ... ]
 *   }
 *
 * A key may also carry `"after": "<siblingLeaf>"` to land directly below that
 * sibling instead of at the end of its section — for blocks that mirror a data
 * source and read badly out of order.
 *
 * Usage:
 *   npx tsx scripts/i18n-insert-keys.ts <input.json> [--dry]
 *
 * Existing keys are skipped. Parent sections are created when missing.
 * Run `npm run validate-i18n` afterwards — it is the acceptance test.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUNDLE_DIRS: Record<string, string> = {
  client: "client/src/i18n",
  "client-aac": "client-aac/src/i18n",
  popusim: "games/popusim/src/ui/app/i18n",
};

const TODO = "// TODO-i18n";

/**
 * `en` is required. Any other locale code present (he, es, ar, …) is used as
 * that locale's value verbatim and is NOT marked for translation — for text
 * that already exists in more than one language, e.g. pages that were
 * hand-localized with a `language === 'he' ? … : …` ternary.
 */
interface KeySpec {
  key: string;
  en: string;
  /**
   * Optional sibling leaf key to insert directly after, inside the same parent
   * section. Sections that mirror a data source — `aac.glyph.*` follows
   * `shared/glyph-registry.ts` — stay readable only if a late addition lands
   * beside its neighbours instead of at the bottom. Omitted, or naming a
   * sibling that isn't there, appends to the end of the section as usual.
   *
   * Not a locale code: it's filtered out of the per-locale value lookup below.
   */
  after?: string;
  [locale: string]: string | undefined;
}

/** Spec fields that are not locale codes. */
const RESERVED_FIELDS = new Set(["key", "en", "after"]);

// ---------------------------------------------------------------------------
// Structure walking
// ---------------------------------------------------------------------------

interface Section {
  /** line index (0-based) of the `name: {` line */
  open: number;
  /** line index of the matching `}` / `},` line */
  close: number;
  /** indent of the members inside this section */
  indent: string;
}

/**
 * Locate a section by dotted path. Returns null if any level is missing.
 * Brace matching is done by scanning, not by counting `{` characters, so a
 * brace inside a string value can't throw off the depth.
 */
function findSection(lines: string[], pathParts: string[]): Section | null {
  let searchStart = 0;
  let searchEnd = lines.length - 1;
  let result: Section | null = null;

  for (const part of pathParts) {
    let open = -1;
    let depth = 0;
    for (let i = searchStart; i <= searchEnd; i++) {
      const trimmed = lines[i].trim();
      if (depth === 0) {
        const m = trimmed.match(/^["']?([\w$]+)["']?\s*:\s*\{/);
        if (m && m[1] === part) { open = i; depth = 1; continue; }
      } else {
        if (/^["']?[\w$]+["']?\s*:\s*\{$/.test(trimmed) || trimmed.endsWith("{")) depth++;
        else if (trimmed === "}" || trimmed === "},") {
          depth--;
          if (depth === 0) {
            const indent = (lines[open].match(/^(\s*)/)?.[1] ?? "") + "  ";
            result = { open, close: i, indent };
            searchStart = open + 1;
            searchEnd = i - 1;
            break;
          }
        }
      }
    }
    if (!result || result.open !== open) return null;
  }
  return result;
}

/** Every dotted key path in the file, mapped to its 1-based line. */
function keyLines(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const stack: string[] = [];
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!inside) { if (/^export\s+const\s+\w+/.test(t)) inside = true; continue; }
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    const open = t.match(/^["']?([\w$]+)["']?\s*:\s*\{/);
    if (open) { stack.push(open[1]); continue; }
    if (t === "}" || t === "},") { stack.pop(); continue; }
    const kv = t.match(/^["']?([\w$]+)["']?\s*:/);
    if (kv) out.set([...stack, kv[1]].join("."), i + 1);
  }
  return out;
}

/** All dotted key paths already present in the file. */
function existingKeys(lines: string[]): Set<string> {
  return new Set(keyLines(lines).keys());
}

/** Line index of the final `};` that closes the exported object. */
function rootClose(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "};") return i;
  }
  throw new Error("could not find the closing `};` of the exported object");
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

/**
 * A leaf that is not a bare JS identifier must be quoted, or the emitted file
 * does not parse — `security-incidents: "..."` is a syntax error, not a key.
 * Section names created by insertKey go through the same check.
 */
function propName(leaf: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(leaf) ? leaf : JSON.stringify(leaf);
}

function valueLine(indent: string, leaf: string, value: string, markTodo: boolean): string {
  // JSON.stringify gives a correctly escaped double-quoted JS string literal
  return `${indent}${propName(leaf)}: ${JSON.stringify(value)},${markTodo ? " " + TODO : ""}`;
}

/**
 * Line index just past a section's direct child `after`, or the section's
 * close when there's no such child. Only direct children count — a nested
 * section's member with the same name must not capture the anchor — so the
 * scan tracks brace depth and matches at depth 0.
 */
function insertionPoint(lines: string[], section: Section, after?: string): number {
  if (!after) return section.close;
  let depth = 0;
  for (let i = section.open + 1; i < section.close; i++) {
    const t = lines[i].trim();
    if (t === "}" || t === "},") { depth--; continue; }
    if (t.endsWith("{")) { depth++; continue; }
    if (depth !== 0) continue;
    const kv = t.match(/^["']?([\w$]+)["']?\s*:/);
    if (kv && kv[1] === after) return i + 1;
  }
  return section.close;
}

/**
 * Insert one key, creating any missing parent sections. Mutates `lines`.
 * The algorithm is deterministic given identical input structure, which is
 * what keeps all 11 files on the same line numbers.
 */
function insertKey(lines: string[], key: string, value: string, markTodo: boolean, after?: string): void {
  const parts = key.split(".");
  const leaf = parts.pop()!;

  if (parts.length === 0) {
    const at = rootClose(lines);
    lines.splice(at, 0, valueLine("  ", leaf, value, markTodo));
    return;
  }

  // Walk down, creating sections that don't exist yet
  for (let depth = 1; depth <= parts.length; depth++) {
    const sub = parts.slice(0, depth);
    if (findSection(lines, sub)) continue;
    const parent = depth === 1 ? null : findSection(lines, parts.slice(0, depth - 1));
    const at = parent ? parent.close : rootClose(lines);
    const indent = parent ? parent.indent : "  ";
    lines.splice(at, 0, `${indent}${propName(sub[depth - 1])}: {`, `${indent}},`);
  }

  const section = findSection(lines, parts);
  if (!section) throw new Error(`failed to create section for ${key}`);
  lines.splice(insertionPoint(lines, section, after), 0, valueLine(section.indent, leaf, value, markTodo));
}

/**
 * Reorder specs so an `after` anchor that is itself being inserted in this
 * batch is written first. Chains resolve transitively; a cycle (a after b,
 * b after a) is left in its input order rather than hanging.
 */
function orderByAnchor(specs: Array<[string, KeySpec]>): Array<[string, KeySpec]> {
  const parentOf = (key: string) => key.slice(0, key.lastIndexOf("."));
  const leafOf = (key: string) => key.slice(key.lastIndexOf(".") + 1);
  // Anchors are sibling leaf names, so index by "<parent>.<leaf>" — the key itself.
  const byFullKey = new Map(specs.map((s) => [s[0], s]));

  const out: Array<[string, KeySpec]> = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (entry: [string, KeySpec]) => {
    const [key, spec] = entry;
    if (state.get(key)) return; // done, or a cycle we're already inside
    state.set(key, "visiting");
    if (spec.after) {
      const anchor = byFullKey.get(`${parentOf(key)}.${spec.after}`);
      if (anchor && leafOf(anchor[0]) !== leafOf(key)) visit(anchor);
    }
    state.set(key, "done");
    out.push(entry);
  };
  for (const entry of specs) visit(entry);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const inputPath = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!inputPath) {
    console.error("usage: npx tsx scripts/i18n-insert-keys.ts <input.json> [--dry]");
    process.exit(2);
  }

  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf-8")) as {
    bundle: string;
    keys: KeySpec[];
  };
  const dir = BUNDLE_DIRS[input.bundle];
  if (!dir) {
    console.error(`unknown bundle "${input.bundle}". known: ${Object.keys(BUNDLE_DIRS).join(", ")}`);
    process.exit(2);
  }

  // Dedupe by key; first spec wins, English conflicts are reported
  const byKey = new Map<string, KeySpec>();
  for (const k of input.keys) {
    const prev = byKey.get(k.key);
    if (prev && prev.en !== k.en) {
      console.warn(`  ! conflicting English for "${k.key}":`);
      console.warn(`      keeping: ${JSON.stringify(prev.en)}`);
      console.warn(`      dropped: ${JSON.stringify(k.en)}`);
      continue;
    }
    if (!prev) byKey.set(k.key, k);
  }
  // Sort so sibling keys land together and the order is reproducible, then
  // pull any spec anchored to another spec in the same batch after its anchor —
  // otherwise the anchor isn't in the file yet and the insert falls back to
  // end-of-section, silently losing the requested placement.
  const specs = orderByAnchor([...byKey].sort((a, b) => a[0].localeCompare(b[0])));

  const preTranslated = new Set<string>();
  for (const [, spec] of specs) {
    for (const code of Object.keys(spec)) {
      if (!RESERVED_FIELDS.has(code)) preTranslated.add(code);
    }
  }
  if (preTranslated.size > 0) {
    console.log(`  pre-translated locales supplied: ${[...preTranslated].sort().join(", ")}`);
  }

  const files = fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".bak"))
    .sort();

  console.log(`bundle ${input.bundle} — ${files.length} locale files, ${specs.length} unique keys`);

  // Build every file in memory first, so a parity failure aborts before any write
  const built = new Map<string, string[]>();
  let addedTotal = 0;

  for (const file of files) {
    const full = path.join(ROOT, dir, file);
    const lines = fs.readFileSync(full, "utf-8").split("\n");
    const present = existingKeys(lines);
    const locale = file.replace(/\.ts$/, "");
    const isEn = locale === "en";

    let added = 0;
    let known = 0;
    for (const [key, spec] of specs) {
      if (present.has(key)) continue;
      // A supplied translation for this locale goes in as-is; anything else
      // is seeded with English and flagged for a translator.
      const supplied = isEn ? undefined : spec[locale];
      if (supplied !== undefined) known++;
      insertKey(lines, key, supplied ?? spec.en, !isEn && supplied === undefined, spec.after);
      added++;
    }

    built.set(file, lines);
    if (isEn) addedTotal = added;
    const suffix = known > 0 ? `  (${known} pre-translated, ${added - known} to do)` : "";
    console.log(`  ${file.padEnd(8)} +${String(added).padStart(3)} keys  (${lines.length} lines)${suffix}`);
  }

  // The invariant that matters is per-key line parity, not total file length —
  // en.ts carries two extra trailing lines (`export type Translations = …`)
  // outside the object, which is legitimate.
  const refMap = keyLines(built.get("en.ts")!);
  const problems: string[] = [];
  for (const file of files) {
    if (file === "en.ts") continue;
    const map = keyLines(built.get(file)!);
    for (const [key, line] of refMap) {
      const other = map.get(key);
      if (other === undefined) problems.push(`${file}: missing "${key}"`);
      else if (other !== line) problems.push(`${file}: "${key}" on line ${other}, en.ts has ${line}`);
      if (problems.length > 10) break;
    }
    for (const key of map.keys()) {
      if (!refMap.has(key)) problems.push(`${file}: extra key "${key}" not in en.ts`);
      if (problems.length > 10) break;
    }
  }
  if (problems.length > 0) {
    console.error(`\n! key/line parity broken — NOTHING was written:`);
    for (const p of problems.slice(0, 10)) console.error(`    ${p}`);
    process.exit(1);
  }

  if (!dry) {
    for (const [file, lines] of built) {
      fs.writeFileSync(path.join(ROOT, dir, file), lines.join("\n"), "utf-8");
    }
  }

  console.log(`\n${dry ? "[dry run] " : ""}${addedTotal} key(s) added to each of ${files.length} files.`);
  if (!dry) {
    console.log(`Non-English values are seeded with English and marked ${TODO}.`);
    console.log(`Next: translate those values in place, then run \`npm run validate-i18n\`.`);
  }
}

main();
