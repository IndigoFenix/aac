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
 * Resolution accepts EITHER form: a bare board slug resolves when exactly one
 * board has it. When several do, the caller gets the qualified alternatives back
 * as validator feedback rather than a dead end.
 *
 * See planning-docs/aac-packages-plan.md §4.
 */

/** Cap on a single slug segment. Long enough to stay readable, short enough to keep prompts lean. */
const MAX_SEGMENT = 40;

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
 */
export function slug(input: string): string {
  const s = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return s.slice(0, MAX_SEGMENT).replace(/_$/, "");
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
