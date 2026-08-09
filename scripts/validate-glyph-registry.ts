/**
 * Glyph-registry ↔ i18n ↔ artwork validator.
 *
 * `validate-i18n.ts` checks the locale files against *each other* (same keys,
 * same order, same lines). `scan-i18n-coverage.ts` checks them against the
 * *code*. Neither one knows about `shared/glyph-registry.ts`, whose vocabulary
 * is data rather than call sites: a `t()` call never mentions `aac.glyph.apple`
 * literally, so a registry item with no translation is invisible to both.
 * This script closes that gap, and audits bundled artwork at the same time
 * (the registry is also the only list of which SYMBOLs still lack an icon).
 *
 * Checks — i18n:
 *   E  tkey-format      tKey doesn't follow `aac.glyph.<key>`
 *   E  missing-en       registry item has no entry in client-aac en.ts
 *   E  missing-locale   entry in en.ts but absent from another locale
 *   E  orphan-key       `aac.glyph.*` entry no registry item claims (dead key)
 *   E  empty-value      translation exists but is blank
 *   W  untranslated     non-Latin locale value byte-identical to English
 *                       (`--same-as-english` extends this to Latin locales,
 *                        where identical words are often legitimate)
 *
 * Checks — artwork:
 *   E  missing-art      imagePath / emptyImagePath / filledImagePath points at
 *                       a file that isn't in attached_assets/aac-icons
 *   E  no-visual        no imagePath, no emoji, no faIcon — renders as nothing
 *   W  gender-variant   `gender_body` host missing its `-male` / `-female` art
 *   W  no-icon          emoji-only item (fine, but it's the "needs art" queue)
 *
 * Deliberately NOT a finding: a `directional: true` item carrying only an emoji.
 * Mirroring is opt-out and applies to emoji as readily as to PNGs (see
 * `shouldMirror` in shared/emoji-registry.ts), so such an item turns around in
 * Hebrew like everything else. It wants art for the usual reason — an emoji is
 * a rough likeness — which the art queue below already says.
 *
 * Errors are things that are *broken now*: a label that renders as a raw key, a
 * dead key, an imagePath resolving to nothing. Warnings are the art backlog —
 * real work, but work that needs generated assets rather than an edit — so a
 * clean tree exits 0 and the script can gate CI the way `validate-i18n` does.
 *
 * Usage:
 *   npx tsx scripts/validate-glyph-registry.ts            # errors + warnings
 *   npx tsx scripts/validate-glyph-registry.ts --icons    # artwork checks only
 *   npx tsx scripts/validate-glyph-registry.ts --i18n     # translation checks only
 *   npx tsx scripts/validate-glyph-registry.ts --quiet    # errors only
 *   npx tsx scripts/validate-glyph-registry.ts --verbose  # list every finding
 *   npx tsx scripts/validate-glyph-registry.ts --strict   # art backlog fails too
 *   npx tsx scripts/validate-glyph-registry.ts --same-as-english
 *   npx tsx scripts/validate-glyph-registry.ts --no-fail  # always exit 0
 *
 * Exits 1 when any error-severity finding is present.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { listAllVocabulary, type VocabularyItem } from "../shared/glyph-registry";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** The sentence builder's labels live in the AAC bundle only. */
const I18N_DIR = path.join(ROOT, "client-aac", "src", "i18n");
const ICON_ROOT = path.join(ROOT, "attached_assets", "aac-icons");

/** Namespace every registry tKey must sit under. */
const GLYPH_NS = "aac.glyph";

/**
 * Locales written in a different script from English. A single English word
 * surviving into one of these is untranslated, full stop — unlike Latin-script
 * locales, where "banana" or "pizza" legitimately stays put.
 */
const NON_LATIN_LOCALES = new Set(["he", "ar", "ru", "zh", "yue", "ko"]);

/**
 * Keys under `aac.glyph.*` that intentionally have no registry item. These are
 * modifier/affordance labels the sentence-builder UI renders directly rather
 * than resolving through a VocabularyItem. Anything not listed here that has no
 * registry item is a dead key.
 */
const NON_REGISTRY_GLYPH_KEYS = new Set<string>([]);

/**
 * `<locale>:<registry key>` pairs whose value is *supposed* to read as English.
 * Cantonese writes "OK" in Latin letters — it's a naturalized loanword, not an
 * untranslated string — and the check can't tell the two apart on its own.
 */
const INTENTIONALLY_ENGLISH = new Set<string>(["yue:ok"]);

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const ONLY_ICONS = flag("icons");
const ONLY_I18N = flag("i18n");
const QUIET = flag("quiet");
const VERBOSE = flag("verbose");
const STRICT = flag("strict");
const SAME_AS_ENGLISH = flag("same-as-english");
const NO_FAIL = flag("no-fail");

/** Findings per code before the listing collapses to a count. */
const LIST_CAP = VERBOSE ? Infinity : 12;

const RUN_I18N = !ONLY_ICONS;
const RUN_ICONS = !ONLY_I18N;

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "error" | "warn";

interface Finding {
  severity: Severity;
  code: string;
  /** Registry key or locale key the finding is about. */
  subject: string;
  file?: string;
  line?: number;
  message: string;
}

const findings: Finding[] = [];
const report = (f: Finding) => findings.push(f);

// ─────────────────────────────────────────────────────────────────────────────
// Locale loading
// ─────────────────────────────────────────────────────────────────────────────

function localeFiles(): string[] {
  return fs
    .readdirSync(I18N_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
}

/** Dynamic-import a locale module and return its exported translation object. */
async function loadLocale(file: string): Promise<Record<string, unknown> | null> {
  const name = file.replace(/\.ts$/, "");
  try {
    const url = pathToFileURL(path.join(I18N_DIR, file)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    const obj = (mod[name] ?? mod.default) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") {
      report({
        severity: "error",
        code: "locale-load",
        subject: name,
        file: `client-aac/src/i18n/${file}`,
        message: `Export '${name}' is missing or not an object`,
      });
      return null;
    }
    return obj;
  } catch (err) {
    report({
      severity: "error",
      code: "locale-load",
      subject: name,
      file: `client-aac/src/i18n/${file}`,
      message: `Failed to import: ${(err as Error).message.split("\n")[0]}`,
    });
    return null;
  }
}

/** Read a dotted path out of a nested translation object. */
function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/**
 * Map `aac.glyph.<key>` → line number, so findings point at the right line.
 * Cheap brace-depth walk of the source rather than a real parse — the locale
 * files are flat literal objects, which is also what `validate-i18n.ts` assumes.
 */
function glyphKeyLines(file: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = fs.readFileSync(path.join(I18N_DIR, file), "utf-8").split("\n");
  const stack: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const open = trimmed.match(/^(\w+)\s*:\s*\{/);
    if (open) {
      stack.push(open[1]);
      continue;
    }
    if (trimmed === "}" || trimmed === "},") {
      stack.pop();
      continue;
    }
    const kv = trimmed.match(/^(\w+)\s*:/);
    if (kv && stack.join(".") === GLYPH_NS) out.set(`${GLYPH_NS}.${kv[1]}`, i + 1);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artwork inventory
// ─────────────────────────────────────────────────────────────────────────────

/** Every bundled icon, keyed by its registry-style relative path (no extension). */
function loadIconIndex(): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(ICON_ROOT)) return out;
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      const m = entry.name.match(/^(.+)\.(png|svg)$/i);
      if (m) out.add(prefix ? `${prefix}/${m[1]}` : m[1]);
    }
  };
  walk(ICON_ROOT, "");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK: translations
// ─────────────────────────────────────────────────────────────────────────────

async function checkTranslations(vocab: readonly VocabularyItem[]): Promise<void> {
  console.log("\n=== Translations (client-aac/src/i18n) ===");

  // tKey convention. A registry item whose tKey drifts off the namespace
  // silently stops resolving — the builder falls back to the raw English key.
  // Pointing at ANOTHER item's key is legitimate and deliberate: the emotion
  // modifiers (`emo_happy`) share the label of the feeling they badge
  // (`happy`), so they read the same word rather than duplicating it.
  const registryKeys = new Set(vocab.map((v) => v.key));
  const aliases: string[] = [];
  for (const item of vocab) {
    if (item.tKey === `${GLYPH_NS}.${item.key}`) continue;
    const suffix = item.tKey.startsWith(`${GLYPH_NS}.`) ? item.tKey.slice(GLYPH_NS.length + 1) : null;
    if (suffix && registryKeys.has(suffix)) {
      aliases.push(`${item.key} → ${suffix}`);
      continue;
    }
    report({
      severity: "error",
      code: "tkey-format",
      subject: item.key,
      file: "shared/glyph-registry.ts",
      message: `tKey "${item.tKey}" is neither "${GLYPH_NS}.${item.key}" nor another registry item's key`,
    });
  }

  const files = localeFiles();
  const enFile = files.find((f) => f === "en.ts");
  if (!enFile) {
    report({ severity: "error", code: "no-reference", subject: "en", message: "No en.ts to use as reference" });
    return;
  }

  const en = await loadLocale(enFile);
  if (!en) return;
  const enLines = glyphKeyLines(enFile);

  console.log(`Registry items: ${vocab.length} · locales: ${files.length}`);

  // Every registry item needs an English label first.
  const missingEn: string[] = [];
  for (const item of vocab) {
    const value = lookup(en, item.tKey);
    if (typeof value !== "string") {
      missingEn.push(item.key);
      report({
        severity: "error",
        code: "missing-en",
        subject: item.key,
        file: "client-aac/src/i18n/en.ts",
        message: `No translation for "${item.tKey}" — the builder renders the raw key "${item.key}"`,
      });
    } else if (value.trim() === "") {
      report({
        severity: "error",
        code: "empty-value",
        subject: item.key,
        file: "client-aac/src/i18n/en.ts",
        line: enLines.get(item.tKey),
        message: `"${item.tKey}" is empty`,
      });
    }
  }

  // Dead keys: a translation nobody looks up. Usually a renamed registry key.
  const enGlyphBlock = lookup(en, GLYPH_NS);
  if (enGlyphBlock && typeof enGlyphBlock === "object") {
    for (const key of Object.keys(enGlyphBlock as Record<string, unknown>)) {
      if (registryKeys.has(key) || NON_REGISTRY_GLYPH_KEYS.has(key)) continue;
      report({
        severity: "error",
        code: "orphan-key",
        subject: key,
        file: "client-aac/src/i18n/en.ts",
        line: enLines.get(`${GLYPH_NS}.${key}`),
        message: `"${GLYPH_NS}.${key}" has no registry item — dead key`,
      });
    }
  }

  // Per-locale: present, non-empty, and actually translated.
  for (const file of files) {
    if (file === enFile) continue;
    const locale = file.replace(/\.ts$/, "");
    const tr = await loadLocale(file);
    if (!tr) continue;
    const lines = glyphKeyLines(file);

    let missing = 0;
    let identical = 0;

    for (const item of vocab) {
      if (typeof lookup(en, item.tKey) !== "string") continue; // already reported as missing-en
      const value = lookup(tr, item.tKey);

      if (typeof value !== "string") {
        missing++;
        report({
          severity: "error",
          code: "missing-locale",
          subject: item.key,
          file: `client-aac/src/i18n/${file}`,
          message: `No translation for "${item.tKey}" (present in en.ts)`,
        });
        continue;
      }
      if (value.trim() === "") {
        report({
          severity: "error",
          code: "empty-value",
          subject: item.key,
          file: `client-aac/src/i18n/${file}`,
          line: lines.get(item.tKey),
          message: `"${item.tKey}" is empty`,
        });
        continue;
      }

      // Untranslated: identical to English. Only meaningful where the script
      // differs — in es/fr/de/pt a matching word is often the correct one.
      if (!SAME_AS_ENGLISH && !NON_LATIN_LOCALES.has(locale)) continue;
      if (INTENTIONALLY_ENGLISH.has(`${locale}:${item.key}`)) continue;
      const enValue = lookup(en, item.tKey) as string;
      if (value !== enValue) continue;
      if (!/[A-Za-z]/.test(value)) continue; // e.g. a shared emoji or numeral label
      identical++;
      report({
        severity: "warn",
        code: "untranslated",
        subject: item.key,
        file: `client-aac/src/i18n/${file}`,
        line: lines.get(item.tKey),
        message: `${locale}: "${item.tKey}" is still English — "${value}"`,
      });
    }

    const parts: string[] = [];
    if (missing) parts.push(`${missing} missing`);
    if (identical) parts.push(`${identical} untranslated`);
    console.log(`  ${locale.padEnd(4)} ${parts.length ? parts.join(", ") : "ok"}`);
  }

  if (aliases.length) {
    console.log(`  ${aliases.length} label alias(es): ${aliases.join(", ")}`);
  }
  if (missingEn.length) {
    console.log(`\n  ${missingEn.length} item(s) missing from en.ts: ${missingEn.join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK: artwork
// ─────────────────────────────────────────────────────────────────────────────

function checkArtwork(vocab: readonly VocabularyItem[]): void {
  console.log("\n=== Artwork (attached_assets/aac-icons) ===");
  const icons = loadIconIndex();
  console.log(`Bundled icons on disk: ${icons.size}`);

  const noIcon: VocabularyItem[] = [];

  for (const item of vocab) {
    // A declared path that resolves to nothing renders as the emoji fallback —
    // silently, so it only ever surfaces as "why is this one an emoji".
    const declared: Array<[string, string]> = [];
    if (item.imagePath) declared.push(["imagePath", item.imagePath]);
    if (item.composable?.emptyImagePath) declared.push(["emptyImagePath", item.composable.emptyImagePath]);
    if (item.composable?.filledImagePath) declared.push(["filledImagePath", item.composable.filledImagePath]);
    for (const [field, p] of declared) {
      if (!icons.has(p)) {
        report({
          severity: "error",
          code: "missing-art",
          subject: item.key,
          file: "shared/glyph-registry.ts",
          message: `${field} "${p}" has no file under attached_assets/aac-icons`,
        });
      }
    }

    // Animated sprites carry their art through the client's sheet map, so an
    // item with one isn't iconless even without an imagePath.
    const hasVisual = !!(item.imagePath || item.emoji || item.faIcon || item.animatedSprite);
    if (!hasVisual) {
      report({
        severity: "error",
        code: "no-visual",
        subject: item.key,
        file: "shared/glyph-registry.ts",
        message: `No imagePath, emoji, faIcon or animatedSprite — the button renders blank`,
      });
      continue;
    }

    if (!item.imagePath && !item.animatedSprite) {
      // An alias (expandsTo) draws the art of the item it expands to, so its
      // own lack of an imagePath is by design.
      if (item.expandsTo) continue;
      noIcon.push(item);
      report({
        severity: STRICT ? "error" : "warn",
        code: "no-icon",
        subject: item.key,
        file: "shared/glyph-registry.ts",
        message: `No bundled artwork — falls back to ${item.emoji ?? item.faIcon}`,
      });
    }
  }

  // gender_body swaps the host art for `<imagePath>-male` / `-female`. Without
  // those files the modifier silently degrades to a gendered emoji.
  const genderHosts = new Set<string>();
  for (const item of vocab) {
    if (item.modifier?.transform !== "gender_body") continue;
    for (const host of vocab) {
      if (!host.imagePath) continue;
      if (!item.modifier.appliesTo.includes(host.pos)) continue;
      genderHosts.add(host.imagePath);
    }
  }
  for (const hostPath of genderHosts) {
    for (const suffix of ["male", "female"]) {
      if (!icons.has(`${hostPath}-${suffix}`)) {
        report({
          severity: "warn",
          code: "gender-variant",
          subject: hostPath,
          file: "attached_assets/aac-icons",
          message: `No "${hostPath}-${suffix}" variant — the gender modifier falls back to an emoji on this host`,
        });
      }
    }
  }

  // `directional` items are reported separately not because they're broken —
  // they mirror fine as emoji — but because a concept whose meaning turns on
  // left/right is where bought-in likeness pays off most, so it's the head of
  // the art queue rather than a defect.
  const directionalNoArt = vocab.filter((v) => v.directional && !v.imagePath && !v.animatedSprite);
  console.log(`  Items with bundled art: ${vocab.filter((v) => v.imagePath).length}/${vocab.length}`);
  console.log(`  Emoji-only (art queue): ${noIcon.length}`);
  console.log(`  Directional: ${vocab.filter((v) => v.directional).length} (${directionalNoArt.length} emoji-only — art queue priority)`);
  if (directionalNoArt.length && !QUIET) {
    console.log(`  Priority: ${directionalNoArt.map((v) => v.key).join(", ")}`);
  }
  if (noIcon.length && !QUIET) {
    console.log(`\n  Art queue: ${noIcon.map((v) => v.key).join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const vocab = listAllVocabulary();

  if (RUN_I18N) await checkTranslations(vocab);
  if (RUN_ICONS) checkArtwork(vocab);

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");

  const shown = QUIET ? errors : findings;
  if (shown.length) {
    console.log("\n=== Findings ===");
    // Group by code so a hundred missing-locale lines read as one block.
    const byCode = new Map<string, Finding[]>();
    for (const f of shown) {
      const list = byCode.get(f.code) ?? [];
      list.push(f);
      byCode.set(f.code, list);
    }
    for (const [code, list] of byCode) {
      console.log(`\n${list[0].severity === "error" ? "ERROR" : "WARN "} ${code} (${list.length})`);
      // `no-icon` is the whole art backlog — already printed as one line above.
      const cap = code === "no-icon" && !VERBOSE ? 0 : LIST_CAP;
      for (const f of list.slice(0, cap)) {
        const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
        console.log(`  ${f.subject.padEnd(16)} ${loc ? loc + " — " : ""}${f.message}`);
      }
      if (list.length > cap) console.log(`  … ${list.length - cap} more (--verbose to list)`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  if (!errors.length && !warnings.length) console.log("Registry, translations and artwork are aligned.");

  if (errors.length && !NO_FAIL) process.exit(1);
}

main().catch((err) => {
  console.error("Validator crashed:", err);
  process.exit(1);
});
