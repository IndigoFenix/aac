/**
 * board-keys.ts
 *
 * The AI addresses pre-built boards by KEY, not by id — a uuid is unusable in a
 * prompt and would bloat every turn. Keys must therefore be readable, unique,
 * and stable for the life of a session (the Coordinator caches the loaded key).
 *
 * Form:
 *   student-scoped board  →  `slug(name)`                    e.g. `morning_routine`
 *   package board         →  `slug(package).slug(board)`     e.g. `kindergarten_core.snack`
 *
 * `slug()` never emits a `.`, so the dot is unambiguously the qualifier
 * separator. Collisions get a `_2`, `_3`, … suffix in stable input order.
 *
 * A key is built from the board's OWN name in the author's own script, so a
 * Hebrew board keys as `תירס_חם` — not transliterated. The key's whole job is
 * to be the handle the model reaches for after reading the name beside it, and
 * the model reads the name in that script already. Callers must therefore pass
 * a DETERMINISTICALLY ORDERED list (see `boardRepository`), or the collision
 * suffixes churn between session loads and strand the loaded board.
 *
 * Resolution accepts EITHER form: a bare board slug resolves when exactly one
 * board has it. When several do, the caller gets the qualified alternatives back
 * as validator feedback rather than a dead end.
 *
 * See planning-docs/aac-packages-plan.md §4.
 */

/** Cap on a single slug segment. Long enough to stay readable, short enough to keep prompts lean. */
const MAX_SEGMENT = 40;

/** Truncate by CODE POINT, so a cap never splits a surrogate pair and leaves a
 *  lone half in a key. */
function capCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}

export interface BoardKeyInput {
  id: string;
  name: string;
  /** Present for package boards; absent for the student's own boards. */
  packageName?: string | null;
}

export interface ResolvedBoardKey {
  id: string;
  key: string;
}

export type BoardKeyResolution =
  | { kind: "found"; id: string; key: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "missing" };

/**
 * Lowercase, non-alphanumerics → `_`, collapsed and trimmed, length-capped.
 *
 * Deliberately strips `.` along with everything else, so a package or board
 * named "Mr. Fox" cannot forge a qualifier separator.
 *
 * "Alphanumeric" is UNICODE letters and digits, not `[a-z0-9]`. An ASCII-only
 * class silently erased every non-Latin name: on a Hebrew deployment EVERY
 * board slugged to `""`, so `buildBoardKeys` handed out `board`, `board_2`,
 * `board_3` … and the AI could not name the board a child had just asked for
 * out loud (prod, 2026-08-31: "תירס חם" was listed as `package.board_3`).
 * `\p{L}\p{N}` keeps Hebrew, Arabic, Cyrillic and CJK names addressable in the
 * one script the model and the author actually share — the board's own.
 *
 * Combining marks are DROPPED rather than turned into separators (NFD first,
 * so precomposed forms decompose): Hebrew niqqud would otherwise explode one
 * word into `ת_י_ר_ס`, and Latin accents would truncate "Café" to "caf".
 * Dropping them also makes a niqqud-ed name and its plain spelling resolve to
 * the same key, which matters because Hebrew children's books — the boards
 * this feature exists for — are routinely titled מנוקד.
 *
 * The kana voicing marks are the exception: dakuten/handakuten CHANGE the
 * letter (ボ→ホ) rather than decorating it, so stripping them would key a
 * Japanese board to a misspelling of its own name. They survive and NFC puts
 * them back.
 *
 * IDEMPOTENT — `slug(slug(x)) === slug(x)`. `resolveBoardKey` re-slugs whatever
 * the model sends, which is normally a key this function already produced, so
 * a second pass must be a no-op or every key would fail to resolve.
 */
export function slug(input: string): string {
  const s = (input ?? "")
    .normalize("NFD")
    // U+3099 / U+309A = combining dakuten / handakuten. Written as escapes:
    // they are invisible combining characters in source.
    .replace(/\p{M}+/gu, (marks) => marks.replace(/[^\u3099\u309A]/g, ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return capCodePoints(s, MAX_SEGMENT).replace(/_$/, "").normalize("NFC");
}

/**
 * Build the id → key map for one session's boards.
 *
 * Input order decides collision suffixes, so callers must pass a stable order
 * (the repository sorts by package then name) or keys will churn between
 * session loads and strand a loaded board.
 */
export function buildBoardKeys(
  entries: readonly BoardKeyInput[],
  /**
   * Keys that must not be handed out — in practice the virtual home board's
   * `home`. Without this a student board actually named "Home" would take the
   * key and shadow the real home board.
   */
  reserved: readonly string[] = [],
): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>(reserved);

  for (const entry of entries) {
    const board = slug(entry.name) || "board";
    const base = entry.packageName ? `${slug(entry.packageName) || "package"}.${board}` : board;

    let key = base;
    let n = 2;
    while (taken.has(key)) key = `${base}_${n++}`;

    taken.add(key);
    keys.set(entry.id, key);
  }

  return keys;
}

/**
 * Resolve what the model asked for against the built keys.
 *
 * Tries the exact key first, then the bare board segment. A bare segment that
 * matches several boards returns every qualified alternative so the caller can
 * ask the model to disambiguate.
 */
export function resolveBoardKey(
  input: string,
  keys: ReadonlyMap<string, string>,
): BoardKeyResolution {
  const wanted = slugPath(input);
  if (!wanted) return { kind: "missing" };

  for (const [id, key] of keys) {
    if (key === wanted) return { kind: "found", id, key };
  }

  // Bare board slug — match on the segment after the dot.
  if (!wanted.includes(".")) {
    const matches: ResolvedBoardKey[] = [];
    for (const [id, key] of keys) {
      const tail = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
      if (tail === wanted) matches.push({ id, key });
    }
    if (matches.length === 1) return { kind: "found", ...matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((m) => m.key) };
  }

  return { kind: "missing" };
}

/**
 * Normalize model input to key form. Slugs each dot-separated segment, so
 * "Kindergarten Core.Snack" and "kindergarten_core.snack" both resolve.
 */
function slugPath(input: string): string {
  return (input ?? "")
    .trim()
    .split(".")
    .map((part) => slug(part))
    .filter(Boolean)
    .join(".");
}
