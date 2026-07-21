/**
 * culture.ts — the world's CULTURAL LAW declaration (nations arc P2,
 * planning-docs/games/nations-and-empires.md §6).
 *
 * `game.culture` is the world spec's outermost, unrepealable ring:
 * UNIVERSAL ABSOLUTE TABOOS. An absolute law is a law a member of the
 * culture is PHYSICALLY UNABLE to break — the violating candidate never
 * enters any argmax (the cannotLeavePost pattern), and a commanded
 * violation is refused ALOUD with the law named ("we do not fight"),
 * never met with confusion. Parental controls are exactly this ring:
 * declared at world creation, immutable, not player-repealable.
 *
 * Per-culture (repealable, content-tier) laws use the SAME Law rows one
 * layer in (interaction/behavior/laws.ts); this module only declares the
 * universal ring and gates its SHAPE (the kernel gates shape; scope
 * builders own interpretation — the module law).
 */

/** The `game.culture` block as authored (snake_case, kernel-gated). */
export interface WorldCultureSpec {
  /** Verbs no member of any culture on this world can ever perform —
   *  lexicon verb words ("fight"). The universal absolute ring. */
  absolutes?: string[];
}

/** The resolved culture a session runs under. */
export interface WorldCulture {
  /** The universal absolute taboos, as a closed set of forbidden verbs. */
  absolutes: ReadonlySet<string>;
}

/** No declaration = no universal taboos (the realism default — restricted
 *  worlds OPT IN to the ring). */
export const OPEN_CULTURE: WorldCulture = { absolutes: new Set() };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Explicitly annotated so callers narrow past a fail() (never-call
// control-flow analysis needs the variable's own type to say never).
const fail: (path: string, msg: string) => never = (path, msg) => {
  throw new Error(`${path}: ${msg}`);
};

/** Parse + gate the `game.culture` block (the parseWorldScaleSpec
 *  pattern): unknown fields REJECTED, absolutes = ≤16 non-empty strings. */
export function parseWorldCultureSpec(raw: unknown, path: string): WorldCultureSpec {
  if (!isObj(raw)) fail(path, "expected an object (the cultural-law declaration)");
  const allowed = ["absolutes"];
  for (const k of Object.keys(raw as object)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: WorldCultureSpec = {};
  if ("absolutes" in (raw as object)) {
    const a = (raw as Record<string, unknown>).absolutes;
    if (!Array.isArray(a)) fail(`${path}.absolutes`, "expected an array of verb words");
    if (a.length > 16) fail(`${path}.absolutes`, "at most 16 absolute taboos");
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (typeof v !== "string" || !v.trim()) {
        fail(`${path}.absolutes[${i}]`, "expected a non-empty verb word");
      }
    }
    out.absolutes = (a as string[]).map(s => s.trim());
  }
  return out;
}

/** Resolve a (possibly absent) spec to the culture a session runs under. */
export function resolveWorldCulture(spec?: WorldCultureSpec | null): WorldCulture {
  if (!spec?.absolutes?.length) return OPEN_CULTURE;
  return { absolutes: new Set(spec.absolutes) };
}
