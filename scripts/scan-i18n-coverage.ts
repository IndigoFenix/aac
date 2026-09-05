/**
 * i18n Coverage Scanner
 *
 * Complements scripts/validate-i18n.ts. That script checks the translation
 * files against *each other* (same keys, same lines). This one checks the
 * translation files against the *code* — the two ways untranslated text
 * reaches the UI:
 *
 *   1. A `t()` / `ts()` call whose key isn't in en.ts. Both LanguageContexts
 *      fall back to returning the key itself, so the user sees
 *      "aacSettings.budgetWindowDay" rendered as literal text.
 *   2. A user-visible string that was never wrapped in `t()` at all — JSX
 *      text, a `placeholder=` / `title=` / `aria-label=` attribute, a toast
 *      title, an alert().
 *
 *   3. Text localized by hand with a `language === 'he' ? … : …` ternary. Two
 *      locales get real copy; the other nine silently fall through to English.
 *
 * Plus three smaller cross-checks:
 *   4. Server `"error:CODE"` responses with no matching `errors.CODE` in the
 *      client bundle (the client maps them via t(`errors.${code}`)).
 *   5. `t('x') || 'Fallback'` — dead code. `t()` returns the key when the key
 *      is missing, which is truthy, so the fallback never renders and the
 *      missing key is silently shown to the user instead.
 *   6. Non-English values byte-identical to English in a non-Latin-script
 *      locale (he/ar/ru/zh/yue/ko) — copied but never translated.
 *
 * Parsing is done with the TypeScript compiler API, not regex, so JSX text
 * nodes and attribute values are identified structurally.
 *
 * Usage:
 *   npm run scan:i18n              # all checks, exits 1 on any error
 *   npm run scan:i18n:keys         # just the two hard-error checks — good for CI
 *   npm run scan:i18n:report       # everything + planning-docs/i18n-coverage-report.md
 *   npx tsx scripts/scan-i18n-coverage.ts --bundle=client-aac --only=literals
 *
 * Checks (--only / --skip take these names):
 *   keys       t()/ts() key missing from en.ts                        [error]
 *   literals   JSX text / attributes / toasts never wrapped in t()    [warn]
 *   inline     files hand-rolling localization with a locale ternary  [warn]
 *   fallbacks  unreachable `t(...) || 'literal'`                      [warn]
 *   errors     server error:CODE with no client errors.CODE           [error]
 *   locales    locale value byte-identical to English                 [warn]
 *   unused     en.ts key nothing references (opt-in via --unused)     [info]
 *
 * Flags:
 *   --only=<a,b>       Run only these checks
 *   --skip=<a,b>       Skip these checks
 *   --bundle=<name>    Restrict to one bundle (client, client-aac, popusim, shared)
 *   --unused           Enable the unused-key check
 *   --include-debug    Also scan Debug and Sandbox files for hardcoded copy
 *   --same-as-english  Include Latin-script locales in the untranslated-value check
 *   --report           Write planning-docs/i18n-coverage-report.md
 *   --out=<path>       Write the markdown report to a specific path
 *   --json=<path>      Write raw findings as JSON
 *   --max=<n>          Max findings printed per check in the console (default 40)
 *   --no-fail          Always exit 0
 *
 * Adding a new surface: append to BUNDLES below. A bundle with i18nDir=null has
 * no locale files of its own; give it `keyDirs` when its t() calls resolve
 * against somebody else's bundle(s), or leave both unset for a literals-only scan.
 *
 * Suppressing a false positive:
 *   Add `i18n-ignore` in a comment on the offending line or the line above it,
 *   or `i18n-ignore-file` anywhere in the first 10 lines of the file.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { fileURLToPath, pathToFileURL } from "url";

const __filename_ = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename_), "..");

// ============================================================================
// CONFIG
// ============================================================================

interface BundleConfig {
  /** Display name, also the --bundle= filter value */
  name: string;
  /** Directory holding en.ts + the locale siblings. null = no bundle of its own. */
  i18nDir: string | null;
  /**
   * Additional i18n dirs whose en.ts must ALSO contain every key these roots
   * use. For code hosted by more than one client: a key present in only one
   * host's en.ts renders as the raw key string in the other.
   */
  keyDirs?: string[];
  /** Source roots whose t() keys resolve against this bundle */
  roots: string[];
  /** Identifiers treated as translation lookups in these roots */
  translateFns: string[];
}

/** One en.ts a bundle's t() keys are resolved against. */
interface KeySource {
  /** Path shown in the finding, e.g. "client-aac/src/i18n/en.ts" */
  label: string;
  keys: FlatBundle;
}

const BUNDLES: BundleConfig[] = [
  {
    name: "client",
    i18nDir: "client/src/i18n",
    roots: ["client/src"],
    // ts() is the student/child/patient-swapping wrapper over t()
    translateFns: ["t", "ts"],
  },
  {
    name: "client-aac",
    i18nDir: "client-aac/src/i18n",
    roots: ["client-aac/src"],
    translateFns: ["t", "ts"],
  },
  {
    name: "popusim",
    i18nDir: "games/popusim/src/ui/app/i18n",
    roots: ["games/popusim/src/ui"],
    translateFns: ["t"],
  },
  {
    name: "shared",
    // Rendered inside BOTH clients and has no locale files of its own — the
    // host passes t() in. So every key used here must exist in both hosts'
    // en.ts (the sentence-builder chrome's `construction.*` labels are the
    // reason this stopped being a literals-only scan).
    i18nDir: null,
    keyDirs: ["client/src/i18n", "client-aac/src/i18n"],
    roots: ["client-shared/src"],
    translateFns: ["t"],
  },
];

/** Where the client reads `error:CODE` responses back as `errors.CODE` */
const ERROR_CODE_BUNDLE = "client";
const ERROR_CODE_SOURCE_ROOTS = ["server"];

/** Directory names skipped everywhere */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "coverage",
  "__tests__", "__mocks__", "tests", "test",
  // dev-only surfaces — English-only by design
  "debug",
]);

/** File suffixes/patterns skipped everywhere */
const SKIP_FILE = /\.(test|spec|d)\.tsx?$|\.bak$|\.stories\.tsx?$/;

/**
 * Debug/dev-only surfaces. CLAUDE.md exempts debug features from translation,
 * so their hardcoded strings aren't findings. Pass --include-debug to scan them.
 */
const DEBUG_FILE = /(^|[\/])[A-Za-z]*[Dd]ebug[A-Za-z]*\.tsx?$|[Ss]andbox\.tsx?$|paddle-test\.tsx?$/;

/** Locales whose script differs from English — an identical value means untranslated */
const NON_LATIN_LOCALES = new Set(["he", "ar", "ru", "zh", "yue", "ko"]);

/** JSX elements whose text content is never user-facing copy */
const NON_TEXT_TAGS = new Set([
  "code", "pre", "script", "style", "svg", "path", "g", "defs", "circle",
  "rect", "line", "polygon", "polyline", "ellipse", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "filter",
]);

/** Attributes whose string value is rendered to the user */
const TEXT_ATTRS = new Set([
  "placeholder", "title", "alt", "label", "description", "tooltip",
  "heading", "subtitle", "caption", "hint", "helperText", "emptyText",
  "emptyMessage", "loadingText", "errorMessage", "confirmText", "cancelText",
  "submitText", "buttonText", "actionLabel", "summary",
  "aria-label", "aria-description", "aria-placeholder", "aria-roledescription",
  "aria-valuetext",
]);

/** Calls whose object argument carries user-visible copy */
const TEXT_CALLS = new Set([
  "toast", "showToast", "notify", "confirm", "alert", "prompt",
  "setErrorMessage", "setStatusMessage",
]);

/** Object properties inside those calls that are user-visible copy */
const TEXT_PROPS = new Set(["title", "description", "message", "text", "label", "body"]);

/**
 * Identifiers that hold a locale code. `language === 'he' ? '...' : '...'`
 * localizes two languages and leaves the other nine on the English branch.
 */
const LOCALE_VARS = /^(language|lang|locale|currentLanguage|languageCode|uiLanguage)$/;

/** Short tokens that are units/symbols rather than copy */
const UNIT_TOKENS = new Set([
  "ms", "px", "em", "rem", "s", "m", "h", "d", "kg", "cm", "mm", "km",
  "kb", "mb", "gb", "tb", "hz", "fps", "x", "vs", "id", "url", "api",
  "csv", "pdf", "png", "jpg", "svg", "json", "http", "https", "www",
]);

/**
 * Brand names, device models and acronyms legitimately stay identical across
 * locales ("YouTube", "Tobii Eye Tracker"). Rather than enumerate them, the
 * locale check only fires on values that read as *prose* — English function
 * words, or a sentence's worth of them. A proper noun has neither.
 */
const ENGLISH_FUNCTION_WORDS =
  /\b(the|a|an|and|or|but|to|of|in|on|at|for|with|from|by|is|are|was|were|be|been|will|would|can|could|should|must|has|have|had|do|does|did|not|no|yes|this|that|these|those|your|you|their|there|it|its|if|when|while|after|before|than|then|too|only|all|any|each|more|most|please|try|again|here|now|new|about|into|over|out|up|down|per|via)\b/i;

// ============================================================================
// FINDINGS
// ============================================================================

type Check = "keys" | "literals" | "inline" | "fallbacks" | "errors" | "locales" | "unused";
type Severity = "error" | "warn" | "info";

interface Finding {
  check: Check;
  code: string;
  severity: Severity;
  bundle: string;
  file: string;
  line: number;
  message: string;
  snippet?: string;
}

const findings: Finding[] = [];
function report(f: Finding) {
  findings.push(f);
}

// ============================================================================
// ARGS
// ============================================================================

const ARGV = process.argv.slice(2);
function flag(name: string): boolean {
  return ARGV.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const ALL_CHECKS: Check[] = ["keys", "literals", "inline", "fallbacks", "errors", "locales", "unused"];
const onlyList = opt("only")?.split(",").map((s) => s.trim()).filter(Boolean) as Check[] | undefined;
const skipList = opt("skip")?.split(",").map((s) => s.trim()).filter(Boolean) as Check[] | undefined;
const bundleFilter = opt("bundle");
const maxPerCheck = Number(opt("max") ?? 40);

function enabled(check: Check): boolean {
  // `unused` is opt-in — it's advisory, not a defect
  if (check === "unused" && !flag("unused") && !onlyList?.includes("unused")) return false;
  if (onlyList && !onlyList.includes(check)) return false;
  if (skipList && skipList.includes(check)) return false;
  return true;
}

// ============================================================================
// TRANSLATION BUNDLE LOADING
// ============================================================================

type FlatBundle = Map<string, string>;

function flatten(obj: unknown, prefix = "", out: FlatBundle = new Map()): FlatBundle {
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(full, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, full, out);
  }
  return out;
}

/** Import a locale .ts file and flatten its exported object to dotted paths. */
async function loadLocale(dir: string, file: string): Promise<FlatBundle | null> {
  const filePath = path.join(ROOT, dir, file);
  try {
    const url = pathToFileURL(filePath).href + `?t=${Date.now()}`;
    const mod = await import(url);
    const exportName = file.replace(/\.ts$/, "");
    const obj = (mod as Record<string, unknown>)[exportName] ?? mod.default;
    if (!obj || typeof obj !== "object") return null;
    return flatten(obj);
  } catch (err) {
    console.error(`  ! Could not load ${dir}/${file}: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

/**
 * Map each dotted key to its 1-based line in a locale file. Leaf names repeat
 * across sections (a dozen `title:` entries), so a text search finds the wrong
 * one — track the section stack instead, the way validate-i18n.ts does.
 */
function keyLineMap(dir: string, file: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = fs.readFileSync(path.join(ROOT, dir, file), "utf-8").split("\n");
  const stack: string[] = [];
  let insideExport = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!insideExport) {
      if (/^export\s+const\s+\w+/.test(trimmed)) insideExport = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

    const sectionOpen = trimmed.match(/^["']?(\w+)["']?\s*:\s*\{/);
    if (sectionOpen) {
      stack.push(sectionOpen[1]);
      continue;
    }
    if (trimmed === "}" || trimmed === "},") {
      stack.pop();
      continue;
    }
    const keyValue = trimmed.match(/^["']?(\w+)["']?\s*:/);
    if (keyValue) out.set([...stack, keyValue[1]].join("."), i + 1);
  }
  return out;
}

function localeFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".bak"))
    .sort();
}

// ============================================================================
// SOURCE WALKING
// ============================================================================

function collectSources(root: string, excludeDirs: string[] = []): string[] {
  const abs = path.join(ROOT, root);
  if (!fs.existsSync(abs)) return [];
  const excluded = excludeDirs.map((d) => path.join(ROOT, d));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (excluded.some((e) => p === e || p.startsWith(e + path.sep))) continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(abs);
  return out;
}

function rel(p: string): string {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** Strip parens / `as any` / `!` so we can see the real argument node. */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    (ts.isSatisfiesExpression?.(n) ?? false)
  ) {
    n = (n as ts.ParenthesizedExpression).expression;
  }
  return n;
}

// ============================================================================
// SUPPRESSION
// ============================================================================

interface FileCtx {
  file: string;
  lines: string[];
  fileSuppressed: boolean;
  sf: ts.SourceFile;
}

function makeCtx(filePath: string, text: string): FileCtx {
  const lines = text.split("\n");
  return {
    file: rel(filePath),
    lines,
    fileSuppressed: lines.slice(0, 10).some((l) => l.includes("i18n-ignore-file")),
    sf: parse(filePath, text),
  };
}

/** 1-based line number */
function lineOf(ctx: FileCtx, pos: number): number {
  return ctx.sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function suppressed(ctx: FileCtx, line: number): boolean {
  if (ctx.fileSuppressed) return true;
  const here = ctx.lines[line - 1] ?? "";
  if (here.includes("i18n-ignore")) return true;
  // The line above counts only when it is comment-*only* (`//`, `/* … */`,
  // `{/* … */}`). A trailing comment on the previous line must not bleed down
  // onto this one.
  const above = (ctx.lines[line - 2] ?? "").trim();
  return /^(\/\/|\/\*|\{\/\*|\*)/.test(above) && above.includes("i18n-ignore");
}

function snippetOf(ctx: FileCtx, line: number): string {
  return (ctx.lines[line - 1] ?? "").trim().slice(0, 160);
}

// ============================================================================
// CHECK 1 + 5: t() KEY RESOLUTION
// ============================================================================

interface KeyRef {
  kind: "static" | "dynamic";
  key: string;      // static key, or the template with ${…} placeholders
  pattern?: RegExp; // for dynamic keys
  line: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn a template literal into a regex that any concrete key must match. */
function templateToPattern(node: ts.TemplateExpression): { display: string; pattern: RegExp } {
  let src = escapeRe(node.head.text);
  let display = node.head.text;
  for (const span of node.templateSpans) {
    // A substituted segment is at least one char and rarely spans a dot level,
    // but allow dots so nested lookups still match.
    src += "[^`]+?";
    display += "${…}" + span.literal.text;
    src += escapeRe(span.literal.text);
  }
  return { display, pattern: new RegExp(`^${src}$`) };
}

/** Collect every key a translate-call argument could resolve to. */
function keyRefsFrom(arg: ts.Node, line: number): KeyRef[] {
  const node = unwrap(arg);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ kind: "static", key: node.text, line }];
  }
  if (ts.isTemplateExpression(node)) {
    const { display, pattern } = templateToPattern(node);
    return [{ kind: "dynamic", key: display, pattern, line }];
  }
  if (ts.isConditionalExpression(node)) {
    return [...keyRefsFrom(node.whenTrue, line), ...keyRefsFrom(node.whenFalse, line)];
  }
  // `cond && 'a.b'`, `x || 'a.b'` — either side may be the key
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...keyRefsFrom(node.left, line), ...keyRefsFrom(node.right, line)];
    }
  }
  return []; // a variable — unresolvable statically
}

function isTranslateCall(node: ts.CallExpression, fns: string[]): boolean {
  const callee = node.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) name = callee.text;
  else if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
  if (!name || !fns.includes(name)) return false;
  if (node.arguments.length === 0) return false;
  // Guard against `t(someTimer)` style false hits — require a string-ish arg
  const first = unwrap(node.arguments[0]);
  return (
    ts.isStringLiteral(first) ||
    ts.isTemplateExpression(first) ||
    ts.isNoSubstitutionTemplateLiteral(first) ||
    ts.isConditionalExpression(first) ||
    ts.isBinaryExpression(first)
  );
}

// ============================================================================
// CHECK 2: HARDCODED USER-VISIBLE TEXT
// ============================================================================

function hasLetters(s: string): boolean {
  return /[A-Za-zÀ-ɏ]/.test(s);
}

/** Does this string read like UI copy rather than an identifier/token/value? */
function looksLikeCopy(s: string, opts: { strict: boolean }): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (!hasLetters(t)) return false;                       // "—", ":", "42", emoji
  if (/^https?:\/\//i.test(t)) return false;              // URL
  if (/^[\w.-]+@[\w.-]+$/.test(t)) return false;          // email
  if (/^\/[\w\-/.:]*$/.test(t)) return false;             // route or path
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;          // hex colour
  if (/^data:|^blob:/i.test(t)) return false;             // data URI
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(t)) return false;    // mime type
  if (/^\w+\([^)]*\)$/.test(t)) return false;             // css fn: translateX(0)
  if (/^(?:[\d.]+(?:px|rem|em|vh|vw|%|s|ms|fr)\s*)+$/i.test(t)) return false; // css lengths
  if (/^\{+.*\}+$/.test(t)) return false;                 // pure interpolation leftovers
  if (UNIT_TOKENS.has(t.toLowerCase())) return false;
  if (/^\p{Lu}{2,6}(_\p{Lu}{2,}){0,4}$/u.test(t)) return false; // SCREAMING_CASE enum
  if (strictIdentifier(t) && opts.strict) return false;
  return true;
}

/** camelCase / kebab-case / dotted identifiers — enum values, not copy */
function strictIdentifier(t: string): boolean {
  if (/\s/.test(t)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return true;                 // camelCase / single lower word
  if (/^[a-z0-9]+([._-][a-z0-9]+)+$/i.test(t)) return true;       // kebab / snake / dotted
  return false;
}

// ---------------------------------------------------------------------------
// Hand-rolled locale branching
// ---------------------------------------------------------------------------

/** `language === 'he'` — returns the locale code, or undefined. */
function localeComparison(node: ts.Node, locales: Set<string>): string | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  const op = node.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    op !== ts.SyntaxKind.EqualsEqualsToken &&
    op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return undefined;
  }
  const sides = [unwrap(node.left), unwrap(node.right)];
  const isVar = sides.some(
    (s) =>
      (ts.isIdentifier(s) && LOCALE_VARS.test(s.text)) ||
      (ts.isPropertyAccessExpression(s) && LOCALE_VARS.test(s.name.text))
  );
  if (!isVar) return undefined;
  const lit = sides.find((s) => ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s));
  const code = lit ? (lit as ts.StringLiteral).text : undefined;
  return code && locales.has(code) ? code : undefined;
}

/** Locale codes compared anywhere inside a subtree. */
function localeCodesIn(node: ts.Node, locales: Set<string>, out = new Set<string>()): Set<string> {
  const code = localeComparison(node, locales);
  if (code) out.add(code);
  ts.forEachChild(node, (c) => localeCodesIn(c, locales, out));
  return out;
}

/**
 * `const he = language === 'he'` — a boolean standing in for a locale test.
 * Name → the codes it compares against.
 */
function collectLocaleBools(sf: ts.SourceFile, locales: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const codes = localeCodesIn(node.initializer, locales);
      if (codes.size > 0) out.set(node.name.text, codes);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Does this ternary branch produce text the user reads? */
function branchCarriesCopy(node: ts.Node): boolean {
  const n = unwrap(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    // strict: excludes 'rtl' / 'ltr' / 'text-right' — styling, not copy
    return looksLikeCopy((n as ts.StringLiteral).text, { strict: true });
  }
  if (ts.isTemplateExpression(n)) {
    return [n.head, ...n.templateSpans.map((s) => s.literal)].some((p) =>
      looksLikeCopy(p.text, { strict: true })
    );
  }
  if (ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isJsxSelfClosingElement(n)) {
    let found = false;
    const walk = (c: ts.Node): void => {
      if (found) return;
      if (ts.isJsxText(c) && looksLikeCopy(c.text.trim(), { strict: false })) found = true;
      else ts.forEachChild(c, walk);
    };
    walk(n);
    return found;
  }
  return false;
}

function enclosingTagName(node: ts.Node): string | undefined {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isJsxElement(p)) {
      const tag = p.openingElement.tagName;
      return ts.isIdentifier(tag) ? tag.text : tag.getText(p.getSourceFile());
    }
    p = p.parent;
  }
  return undefined;
}

// ============================================================================
// SCANNERS
// ============================================================================

interface ScanResult {
  staticKeys: Set<string>;
  dynamicPatterns: RegExp[];
}

function scanBundleSources(
  bundle: BundleConfig,
  files: string[],
  keySources: KeySource[],
  allLocales: string[]
): ScanResult {
  const staticKeys = new Set<string>();
  const dynamicPatterns: RegExp[] = [];
  const doKeys = enabled("keys") && keySources.length > 0;
  /** Which en.ts files (of the ones this bundle answers to) lack this key. */
  const missingFrom = (key: string): string[] =>
    keySources.filter((s) => !s.keys.has(key)).map((s) => s.label);
  const doLiterals = enabled("literals");
  const doFallbacks = enabled("fallbacks");
  const doInline = enabled("inline") && allLocales.length > 1;
  const localeSet = new Set(allLocales);
  const includeDebug = flag("include-debug");

  for (const filePath of files) {
    // Debug surfaces are exempt from translation (CLAUDE.md), but their t()
    // keys still have to resolve — so only the copy checks are skipped.
    const isDebugFile = !includeDebug && DEBUG_FILE.test(rel(filePath));

    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const ctx = makeCtx(filePath, text);

    // Per-file tally of inline `language === 'xx'` branching
    const inlineLocales = new Set<string>();
    let inlineSites = 0;
    let inlineFirstLine = 0;

    // Booleans standing in for a locale test: `const he = language === 'he'`
    const localeBools =
      doInline && !isDebugFile ? collectLocaleBools(ctx.sf, localeSet) : new Map<string, Set<string>>();

    const visit = (node: ts.Node): void => {
      // ---- hand-rolled locale branching ----
      // Only counts when a branch actually selects *copy*. `isRTL ? 'rtl' : 'ltr'`
      // and `he ? 'text-right' : 'text-left'` are direction/styling, not translation.
      if (doInline && !isDebugFile && ts.isConditionalExpression(node)) {
        const codes = localeCodesIn(node.condition, localeSet);
        const walkCond = (c: ts.Node): void => {
          if (ts.isIdentifier(c) && localeBools.has(c.text)) {
            for (const code of localeBools.get(c.text)!) codes.add(code);
          }
          ts.forEachChild(c, walkCond);
        };
        walkCond(node.condition);

        if (codes.size > 0 && (branchCarriesCopy(node.whenTrue) || branchCarriesCopy(node.whenFalse))) {
          const line = lineOf(ctx, node.getStart(ctx.sf));
          if (!suppressed(ctx, line)) {
            for (const code of codes) inlineLocales.add(code);
            inlineSites++;
            if (!inlineFirstLine) inlineFirstLine = line;
          }
        }
      }

      // ---- translate-call key resolution ----
      if (ts.isCallExpression(node) && isTranslateCall(node, bundle.translateFns)) {
        const line = lineOf(ctx, node.getStart(ctx.sf));
        for (const ref of keyRefsFrom(node.arguments[0], line)) {
          if (ref.kind === "static") {
            staticKeys.add(ref.key);
            if (doKeys && !suppressed(ctx, line)) {
              const missing = missingFrom(ref.key);
              if (missing.length > 0) {
                report({
                  check: "keys",
                  code: "missing-key",
                  severity: "error",
                  bundle: bundle.name,
                  file: ctx.file,
                  line,
                  message:
                    `t("${ref.key}") — key not in ${missing.join(" + ")}; ` +
                    `the raw key string renders to the user`,
                  snippet: snippetOf(ctx, line),
                });
              }
            }
          } else {
            dynamicPatterns.push(ref.pattern!);
            if (doKeys && !suppressed(ctx, line)) {
              const unmatched = keySources
                .filter((s) => ![...s.keys.keys()].some((k) => ref.pattern!.test(k)))
                .map((s) => s.label);
              if (unmatched.length > 0) {
                report({
                  check: "keys",
                  code: "dynamic-key-no-match",
                  severity: "error",
                  bundle: bundle.name,
                  file: ctx.file,
                  line,
                  message: `t(\`${ref.key}\`) — no key in ${unmatched.join(" + ")} can match this template`,
                  snippet: snippetOf(ctx, line),
                });
              }
            }
          }
        }
      }

      // ---- dead `t(...) || 'Fallback'` ----
      if (
        doFallbacks &&
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        const left = unwrap(node.left);
        const right = unwrap(node.right);
        const leftIsT = ts.isCallExpression(left) && isTranslateCall(left, bundle.translateFns);
        const rightIsLiteral =
          ts.isStringLiteral(right) || ts.isNoSubstitutionTemplateLiteral(right);
        if (leftIsT && rightIsLiteral && hasLetters((right as ts.StringLiteral).text)) {
          const line = lineOf(ctx, node.getStart(ctx.sf));
          if (!suppressed(ctx, line)) {
            report({
              check: "fallbacks",
              code: "dead-fallback",
              severity: "warn",
              bundle: bundle.name,
              file: ctx.file,
              line,
              message:
                `Fallback "${(right as ts.StringLiteral).text}" is unreachable — ` +
                `t() returns the key itself when a key is missing, which is truthy`,
              snippet: snippetOf(ctx, line),
            });
          }
        }
      }

      // ---- hardcoded JSX text ----
      if (doLiterals && !isDebugFile && ts.isJsxText(node)) {
        const raw = node.text;
        const trimmed = raw.trim();
        if (trimmed && looksLikeCopy(trimmed, { strict: false })) {
          const tag = enclosingTagName(node);
          if (!tag || !NON_TEXT_TAGS.has(tag)) {
            const offset = raw.search(/\S/);
            const line = lineOf(ctx, node.pos + (offset > 0 ? offset : 0));
            if (!suppressed(ctx, line)) {
              report({
                check: "literals",
                code: "jsx-text",
                severity: "warn",
                bundle: bundle.name,
                file: ctx.file,
                line,
                message: `Hardcoded JSX text: "${trimmed.replace(/\s+/g, " ").slice(0, 80)}"`,
                snippet: snippetOf(ctx, line),
              });
            }
          }
        }
      }

      // ---- hardcoded user-visible attribute ----
      if (doLiterals && !isDebugFile && ts.isJsxAttribute(node) && node.initializer) {
        const attrName = ts.isIdentifier(node.name)
          ? node.name.text
          : node.name.getText(ctx.sf);
        if (TEXT_ATTRS.has(attrName)) {
          let lit: ts.Node | undefined;
          if (ts.isStringLiteral(node.initializer)) lit = node.initializer;
          else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
            const inner = unwrap(node.initializer.expression);
            if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) lit = inner;
          }
          if (lit) {
            const value = (lit as ts.StringLiteral).text;
            if (looksLikeCopy(value, { strict: true })) {
              const line = lineOf(ctx, node.getStart(ctx.sf));
              if (!suppressed(ctx, line)) {
                report({
                  check: "literals",
                  code: "jsx-attribute",
                  severity: "warn",
                  bundle: bundle.name,
                  file: ctx.file,
                  line,
                  message: `Hardcoded ${attrName}="${value.slice(0, 80)}"`,
                  snippet: snippetOf(ctx, line),
                });
              }
            }
          }
        }
      }

      // ---- hardcoded toast / alert copy ----
      if (doLiterals && !isDebugFile && ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        if (name && TEXT_CALLS.has(name)) {
          for (const arg of node.arguments) {
            const a = unwrap(arg);
            // alert("Saved")
            if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
              maybeReportCopy(ctx, bundle, a, `${name}()`, (a as ts.StringLiteral).text);
            }
            // toast({ title: "Saved", description: "..." })
            if (ts.isObjectLiteralExpression(a)) {
              for (const prop of a.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                const key = ts.isIdentifier(prop.name)
                  ? prop.name.text
                  : ts.isStringLiteral(prop.name)
                    ? prop.name.text
                    : undefined;
                if (!key || !TEXT_PROPS.has(key)) continue;
                const v = unwrap(prop.initializer);
                if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
                  maybeReportCopy(ctx, bundle, v, `${name}({ ${key} })`, (v as ts.StringLiteral).text);
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(ctx.sf);

    if (inlineSites > 0) {
      const covered = [...inlineLocales].sort();
      const uncovered = allLocales.filter((l) => l !== "en" && !inlineLocales.has(l));
      report({
        check: "inline",
        code: "inline-locale-branch",
        severity: "warn",
        bundle: bundle.name,
        file: ctx.file,
        line: inlineFirstLine,
        message:
          `Localized inline with ${inlineSites} \`${covered.join("/")}\` comparison(s) instead of t(). ` +
          `${uncovered.length} locale(s) fall through to the other branch: ${uncovered.join(", ")}`,
      });
    }
  }

  return { staticKeys, dynamicPatterns };
}

function maybeReportCopy(
  ctx: FileCtx,
  bundle: BundleConfig,
  node: ts.Node,
  where: string,
  value: string
): void {
  if (!looksLikeCopy(value, { strict: true })) return;
  const line = lineOf(ctx, node.getStart(ctx.sf));
  if (suppressed(ctx, line)) return;
  report({
    check: "literals",
    code: "call-copy",
    severity: "warn",
    bundle: bundle.name,
    file: ctx.file,
    line,
    message: `Hardcoded copy in ${where}: "${value.slice(0, 80)}"`,
    snippet: snippetOf(ctx, line),
  });
}

// ============================================================================
// CHECK 3: SERVER error:CODE ↔ client errors.CODE
// ============================================================================

function scanServerErrorCodes(enKeys: FlatBundle): void {
  const seen = new Map<string, { file: string; line: number }>();
  for (const root of ERROR_CODE_SOURCE_ROOTS) {
    for (const filePath of collectSources(root)) {
      const text = fs.readFileSync(filePath, "utf-8");
      if (!text.includes("error:")) continue;
      const ctx = makeCtx(filePath, text);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const m = /^error:([A-Za-z0-9_]+)$/.exec(node.text);
          if (m && !seen.has(m[1])) {
            seen.set(m[1], { file: ctx.file, line: lineOf(ctx, node.getStart(ctx.sf)) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ctx.sf);
    }
  }

  for (const [code, loc] of [...seen].sort()) {
    if (!enKeys.has(`errors.${code}`)) {
      report({
        check: "errors",
        code: "missing-error-key",
        severity: "error",
        bundle: ERROR_CODE_BUNDLE,
        file: loc.file,
        line: loc.line,
        message: `Server returns "error:${code}" but client en.ts has no errors.${code} — the user sees the raw code`,
      });
    }
  }
}

// ============================================================================
// CHECK 4: LOCALE VALUES IDENTICAL TO ENGLISH
// ============================================================================

async function scanLocaleValues(bundle: BundleConfig, enKeys: FlatBundle): Promise<void> {
  const dir = bundle.i18nDir!;
  const includeLatin = flag("same-as-english");
  for (const file of localeFiles(dir)) {
    const locale = file.replace(/\.ts$/, "");
    if (locale === "en") continue;
    if (!includeLatin && !NON_LATIN_LOCALES.has(locale)) continue;
    const flat = await loadLocale(dir, file);
    if (!flat) continue;

    // Line lookup so findings point at the offending line, not just the key
    const lineFor = keyLineMap(dir, file);

    let count = 0;
    for (const [key, value] of flat) {
      const enValue = enKeys.get(key);
      if (enValue === undefined || enValue !== value) continue;
      const v = value.trim();
      if (v.length < 3) continue;
      if (!hasLetters(v)) continue;
      // ICU/placeholder-only strings ("{n}", "{{STUDENT}}") aren't translatable
      if (/^[{}\s\w,#|]*$/.test(v) && /^\{/.test(v)) continue;
      // Only flag prose. A brand or device name ("YouTube", "Tobii Eye Tracker")
      // is supposed to survive translation unchanged; a sentence is not.
      const isProse =
        ENGLISH_FUNCTION_WORDS.test(v) ||
        /[.!?…]$/.test(v) ||
        v.split(/\s+/).length >= 5;
      if (!isProse) continue;

      count++;
      report({
        check: "locales",
        code: "untranslated-value",
        severity: "warn",
        bundle: bundle.name,
        file: `${dir}/${file}`,
        line: lineFor.get(key) ?? 0,
        message: `${locale}: "${key}" is byte-identical to English — "${v.slice(0, 70)}"`,
      });
    }
    if (count > 0) {
      console.log(`    ${locale}: ${count} value(s) identical to English`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const bundles = BUNDLES.filter((b) => !bundleFilter || b.name === bundleFilter);
  if (bundles.length === 0) {
    console.error(`No bundle named "${bundleFilter}". Known: ${BUNDLES.map((b) => b.name).join(", ")}`);
    process.exit(2);
  }

  console.log("i18n coverage scan");
  console.log(`  checks: ${ALL_CHECKS.filter(enabled).join(", ") || "(none)"}`);

  let clientEnKeys: FlatBundle | null = null;

  for (const bundle of bundles) {
    console.log(`\n=== ${bundle.name} ===`);

    let enKeys: FlatBundle | null = null;
    const keySources: KeySource[] = [];
    // The bundle's own en.ts, plus any host bundle it borrows t() from.
    for (const dir of [...(bundle.i18nDir ? [bundle.i18nDir] : []), ...(bundle.keyDirs ?? [])]) {
      const keys = await loadLocale(dir, "en.ts");
      if (!keys) {
        console.log(`  ! ${dir}/en.ts failed to load — its keys are not checked`);
        continue;
      }
      console.log(`  ${dir}/en.ts: ${keys.size} keys`);
      keySources.push({ label: `${dir}/en.ts`, keys });
      if (dir === bundle.i18nDir) {
        enKeys = keys;
        if (bundle.name === ERROR_CODE_BUNDLE) clientEnKeys = keys;
      }
    }
    if (keySources.length === 0) console.log(`  (no keys to resolve against — literal scan only)`);

    const excludes = bundle.i18nDir ? [bundle.i18nDir] : [];
    const files = bundle.roots.flatMap((r) => collectSources(r, excludes));
    console.log(`  sources: ${files.length} files`);

    const locales = bundle.i18nDir
      ? localeFiles(bundle.i18nDir).map((f) => f.replace(/\.ts$/, ""))
      : [];
    const { staticKeys, dynamicPatterns } = scanBundleSources(bundle, files, keySources, locales);

    if (enKeys && enabled("unused")) {
      const unused: string[] = [];
      for (const key of enKeys.keys()) {
        if (staticKeys.has(key)) continue;
        if (dynamicPatterns.some((p) => p.test(key))) continue;
        unused.push(key);
      }
      for (const key of unused) {
        report({
          check: "unused",
          code: "unused-key",
          severity: "info",
          bundle: bundle.name,
          file: `${bundle.i18nDir}/en.ts`,
          line: 0,
          message: `"${key}" is not referenced by any t() call in ${bundle.roots.join(", ")}`,
        });
      }
      console.log(`  unused keys: ${unused.length}`);
    }

    if (enKeys && enabled("locales")) {
      await scanLocaleValues(bundle, enKeys);
    }
  }

  if (enabled("errors")) {
    console.log(`\n=== server error codes ===`);
    if (!clientEnKeys) {
      const cfg = BUNDLES.find((b) => b.name === ERROR_CODE_BUNDLE)!;
      clientEnKeys = await loadLocale(cfg.i18nDir!, "en.ts");
    }
    if (clientEnKeys) scanServerErrorCodes(clientEnKeys);
    else console.log("  ! client en.ts unavailable — skipped");
  }

  printSummary();
  writeOutputs();

  const errors = findings.filter((f) => f.severity === "error").length;
  if (errors > 0 && !flag("no-fail")) process.exit(1);
}

// ============================================================================
// OUTPUT
// ============================================================================

const CHECK_TITLES: Record<Check, string> = {
  keys: "Translation keys referenced by code but missing from en.ts",
  literals: "User-visible text never passed through t()",
  inline: "Files that hand-roll localization with a locale ternary",
  fallbacks: "Unreachable `t(...) || 'literal'` fallbacks",
  errors: "Server error codes with no client translation",
  locales: "Locale values identical to English (probably untranslated)",
  unused: "Keys in en.ts that nothing references",
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** Findings for one check, errors first, then by file/line. */
function groupFor(check: Check): Finding[] {
  return findings
    .filter((f) => f.check === check)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
}

function printSummary(): void {
  console.log(`\n${"=".repeat(72)}`);

  for (const check of ALL_CHECKS) {
    const group = groupFor(check);
    if (group.length === 0) continue;
    console.log(`\n## ${CHECK_TITLES[check]} (${group.length})`);
    const shown = group.slice(0, maxPerCheck);
    for (const f of shown) {
      const sev = f.severity === "error" ? "ERROR" : f.severity === "warn" ? "WARN " : "INFO ";
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  ${sev} ${loc}`);
      console.log(`        ${f.message}`);
    }
    if (group.length > shown.length) {
      console.log(`  … ${group.length - shown.length} more (raise --max, or use --report for the full list)`);
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Total: ${errors} errors, ${warns} warnings, ${infos} info`);
  if (errors === 0 && warns === 0) console.log("No untranslated text found.");
}

function writeOutputs(): void {
  const jsonPath = opt("json");
  if (jsonPath) {
    const abs = path.resolve(ROOT, jsonPath);
    fs.writeFileSync(abs, JSON.stringify(findings, null, 2), "utf-8");
    console.log(`\nJSON written to ${rel(abs)}`);
  }

  const outPath = opt("out") ?? (flag("report") ? "planning-docs/i18n-coverage-report.md" : undefined);
  if (!outPath) return;
  const abs = path.resolve(ROOT, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const md: string[] = [];
  md.push("# i18n Coverage Report");
  md.push("");
  md.push("Generated by `scripts/scan-i18n-coverage.ts`. Regenerate with `npm run scan:i18n -- --report`.");
  md.push("");
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  md.push(`**${errors} errors, ${warns} warnings.**`);
  md.push("");
  md.push("Suppress a false positive with an `i18n-ignore` comment on the line (or the line above),");
  md.push("or `i18n-ignore-file` in the first 10 lines of the file.");
  md.push("");

  for (const check of ALL_CHECKS) {
    const group = groupFor(check);
    if (group.length === 0) continue;
    md.push(`## ${CHECK_TITLES[check]}`);
    md.push("");
    md.push(`${group.length} finding(s).`);
    md.push("");
    const byFile = new Map<string, Finding[]>();
    for (const f of group) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file)!.push(f);
    }
    for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      md.push(`### \`${file}\` (${list.length})`);
      md.push("");
      md.push("| Line | Severity | Finding |");
      md.push("|---:|---|---|");
      for (const f of list) {
        md.push(`| ${f.line || "—"} | ${f.severity} | ${f.message.replace(/\|/g, "\\|")} |`);
      }
      md.push("");
    }
  }

  fs.writeFileSync(abs, md.join("\n"), "utf-8");
  console.log(`\nReport written to ${rel(abs)}`);
}

main().catch((err) => {
  console.error("Scanner crashed:", err);
  process.exit(2);
});
