// shared/world-engine/kernel/town/skills.ts
//
// ⚖️ SKILLS — THE BODY SLICE (skill-learning-quality.md; skill-learning-round.md).
//
// USER'S ASK, verbatim: *"Create a basic, but easily expandable system for the
// skills that are currently relevant."* — and the owner's spec: *"the more an
// individual performs a task, the better they get at that task, and the lower
// that task costs for them. This would cause roles to emerge naturally."*
//
// THE FOUR THINGS THIS MODULE IS, and nothing else:
//
//  ① THE CATALOGUE — spec-defined rows, include-then-extend (`withSkills`, the
//    `withBehaviors` idiom verbatim: a later key WINS, so a world extends the
//    shipped tree by declaring one row rather than restating seven).
//  ② THE CURVE — the power law of practice, capped at mastery. Pure arithmetic
//    over (practice seconds, the row's real anchor, the world's `learning`
//    dial). No body, no session, no clock.
//  ③ THE FOLD — a sub-skill inherits from its parent at `INHERIT_SHARE`: a
//    carpenter's hour is half an hour of general refining, and a refiner is
//    half as good at carpentry as at refining. ONE walk up `parent`.
//  ④ THE RECORD's two seats — `practiceSkill` (the ONE writer) and
//    `skillMultiplier` (the ONE reader), typed STRUCTURALLY over the session's
//    three fields so quest-host, construction-director and contribute.ts can
//    all reach them without a value import of the host (the `body-needs.ts`
//    pure-half idiom, applied to a store that lives on the session).
//
// 🚨 THE RAW FACT IS PRACTICE SECONDS. A level is DERIVED, never stored — which
// is what lets the later halves (knowledge level, teaching, observing, books,
// the regional fold, quality of output) attach to `BodySkillRow` as new fields
// with NO schema change and no migration. Nothing here is serialised.
//
// ⚖️ TWO CLOCKS (user law, 2026-09-08). Practice rides the METABOLIC clock: a
// labour second is a practice second. NOTHING here multiplies by `dayLengthS`.
// The ONE compression is `WorldScale.learning`, which divides a row's REAL
// `masteryHours` exactly as `construction` divides `REAL_HOUSE_BUILD_DAYS` —
// "every compression variable is a multiplier over a real anchor" (scale.ts).
//
// 🚨 THE BASELINE CONSTANTS ARE THE NOVICE. `CHOP_DWELL_S`, `BUILD_WORK_DWELL_S`,
// `SHOP_SEC` and `laborRatePerS` are what an UNPRACTISED body does, so day one
// of every world is byte-identical to the pre-skill tree by construction. Skill
// only ever shortens what comes AFTER practice.

import type { WorldScale } from "../../scale.js";
import { stackHead } from "./goods-kinds.js";
import { naturalSources } from "../../products.js";
import { freightOf, VALUE_TIER } from "../../freight.js";
import { validateFields, specFail, type GroupSpec } from "../spec-schema.js";
import type { ContributeLink } from "./pull-labor.js";

// ═══ ① THE CATALOGUE ══════════════════════════════════════════════════════

/** One row of the skill tree. */
export interface SkillDef {
  /** Stable id — the key a practice row and a `skillFor` answer both name. */
  key: string;
  /** The skill this one is a sub-skill OF (§③). Absent = a root. */
  parent?: string;
  /**
   * THE REAL ANCHOR: hours of practice to mastery, "roughly normal, adjust
   * later" (the compression law's own instruction). Divided by the world's
   * `learning` dial to get mastery in SIM seconds — never multiplied by a day
   * length, never quoted per game-day.
   */
  masteryHours: number;
  /** Speed at mastery over a novice. Novice = 1×; 2 = twice as fast. */
  gain: number;
}

/**
 * THE SEVEN ROWS OF THE BODY SLICE — "the skills that are currently relevant",
 * which is exactly what the pull decider prices and what the forage walker does
 * (fell, haul, build, refine, forage) plus the ONE material sub-skill.
 *
 * Adding `masonry`, `smithing`, `mining`, `teaching`… later is ONE ROW EACH.
 *
 * 🚨 `labour` IS NEVER KEYED DIRECTLY (`skillFor` never answers it): it is the
 * root every leaf credits at `INHERIT_SHARE`, so a lifetime of building makes a
 * body a slightly better feller than a child who has never worked. Its
 * `masteryHours` is therefore NOT irrelevant — the fold walks up to it — and it
 * is anchored deliberately long (1000 h ≈ a working apprenticeship at general
 * labour) so the cross-skill bleed stays a whisper beside real practice.
 */
export const DEFAULT_SKILLS: readonly SkillDef[] = [
  { key: "labour", masteryHours: 1000, gain: 2 },
  { key: "felling", parent: "labour", masteryHours: 300, gain: 2 },
  { key: "hauling", parent: "labour", masteryHours: 100, gain: 2 },
  { key: "building", parent: "labour", masteryHours: 600, gain: 2 },
  { key: "refining", parent: "labour", masteryHours: 600, gain: 2 },
  // ⚖️ THE ONE MATERIAL SUB-SKILL of this slice: milling wood is refining, and
  // a refiner is half as good at it as at refining in general (§③).
  { key: "carpentry", parent: "refining", masteryHours: 800, gain: 2 },
  // ⚖️ FORAGING HANGS OFF `labour`, NOT off felling (round lead's reading of the
  // brief's tier list, which names a parent only for carpentry): a body that
  // spends its days picking berries must not come out a half-trained feller —
  // that would blur the very division of labour this slice exists to show.
  { key: "foraging", parent: "labour", masteryHours: 200, gain: 2 },
];

/** The resolved tree: the rows in declaration order plus a key lookup. */
export interface SkillCatalogue {
  readonly rows: readonly SkillDef[];
  get(key: string): SkillDef | undefined;
}

function buildCatalogue(rows: readonly SkillDef[]): SkillCatalogue {
  const by = new Map<string, SkillDef>();
  for (const r of rows) by.set(r.key, r);
  // NO CYCLES — validated at catalogue build, once, rather than guarded at
  // every walk (the walks still carry a depth guard as a belt, but a world that
  // declares `a›b›a` is told so at load).
  for (const r of rows) {
    const seen = new Set<string>([r.key]);
    let p = r.parent;
    while (p) {
      if (seen.has(p)) throw new Error(`skills: cycle through "${r.key}" → "${p}"`);
      seen.add(p);
      const def = by.get(p);
      if (!def) throw new Error(`skills: "${r.key}" names unknown parent "${p}"`);
      p = def.parent;
    }
  }
  const ordered = [...by.values()];
  return { rows: ordered, get: (k) => by.get(k) };
}

/**
 * INCLUDE-THEN-EXTEND (`withBehaviors` / `species.ts`): the shipped rows, with
 * `extra` merged over them by key. A later key WINS — re-declaring `felling`
 * replaces it; declaring `masonry` appends it.
 */
export function withSkills(...extra: readonly SkillDef[]): SkillCatalogue {
  return buildCatalogue([...DEFAULT_SKILLS, ...extra]);
}

/** The shipped tree, resolved once. Every world starts here. */
export const DEFAULT_SKILL_CATALOGUE: SkillCatalogue = buildCatalogue(DEFAULT_SKILLS);

// ═══ ② THE CURVE ══════════════════════════════════════════════════════════

/**
 * THE POWER LAW OF PRACTICE. Below 1 ⇒ fast early gains and a long slow tail:
 * the first tenth of the way to mastery already buys 40 % of the benefit, and
 * the last tenth almost nothing. That shape is what makes a role EMERGE — a
 * body that has felled thirty trees is visibly better at it than one that has
 * felled none, without anybody being a master.
 */
export const LEARNING_CURVE_EXPONENT = 0.4;

/** What a rung of the tree passes to the rung above it, in both directions:
 *  practice credited UP (§④) and competence inherited DOWN (§③). */
export const INHERIT_SHARE = 0.5;

/** The world's practice acceleration, defensively read (a synthetic session in
 *  a test may carry a partial scale). */
const learningOf = (scale: Pick<WorldScale, "learning"> | undefined): number => {
  const l = scale?.learning;
  return typeof l === "number" && l > 0 ? l : 1;
};

/** SIM seconds of practice to mastery — the row's REAL anchor ÷ the dial. */
export function masteryS(def: SkillDef, scale: Pick<WorldScale, "learning"> | undefined): number {
  return (Math.max(0, def.masteryHours) * 3600) / learningOf(scale);
}

/** 0 (novice) … 1 (mastered). Capped: practice past mastery buys nothing. */
export function skillLevel(practiceS: number, mastery: number): number {
  if (!(mastery > 0)) return 0;
  const frac = Math.min(1, Math.max(0, practiceS) / mastery);
  return Math.pow(frac, LEARNING_CURVE_EXPONENT);
}

/** Level → the speed multiplier over a novice. Novice 1×, mastery `gain`×. */
export function multiplierOf(level: number, gain: number): number {
  return 1 + (Math.max(1, gain) - 1) * Math.min(1, Math.max(0, level));
}

// ═══ THE ACTION → SKILL MAP ═══════════════════════════════════════════════

/** Heads that ARE wood — the raw and everything wood refines INTO, read off the
 *  products catalogue rather than typed out (the goods layer already classes
 *  it; a new tree species with a wood row joins by existing). Memoised on the
 *  registry's own length, which is what `registerNaturalSource` moves. */
let woodCache: { n: number; set: ReadonlySet<string> } | null = null;
export function woodHeads(): ReadonlySet<string> {
  const srcs = naturalSources();
  if (woodCache && woodCache.n === srcs.length) return woodCache.set;
  const set = new Set<string>();
  for (const s of srcs) {
    for (const p of s.products) {
      if (p.use !== "building") continue;
      if (stackHead(p.glyph) !== "wood") continue;
      set.add(stackHead(p.glyph));
      if (p.refinesTo) set.add(stackHead(p.refinesTo.into));
    }
  }
  woodCache = { n: srcs.length, set };
  return set;
}

/** Is this stack head wood, or something wood is milled into? */
export const isWoodHead = (head: string | undefined): boolean =>
  head !== undefined && woodHeads().has(stackHead(head));

/** The heads the products catalogue MAKES directly (a take mints them) and the
 *  ones they REFINE INTO, by use — read off the registry, memoised on its
 *  length like `woodHeads`. */
let productCache: {
  n: number;
  raw: ReadonlyMap<string, "food" | "drink" | "building" | "raw">;
  refined: ReadonlySet<string>;
} | null = null;
function productHeads(): NonNullable<typeof productCache> {
  const srcs = naturalSources();
  if (productCache && productCache.n === srcs.length) return productCache;
  const raw = new Map<string, "food" | "drink" | "building" | "raw">();
  const refined = new Set<string>();
  for (const s of srcs) {
    for (const p of s.products) {
      raw.set(stackHead(p.glyph), p.use);
      if (p.refinesTo) refined.add(stackHead(p.refinesTo.into));
    }
  }
  productCache = { n: srcs.length, raw, refined };
  return productCache;
}

/**
 * WHICH SKILL MAKES A TRADED GOOD — the regional slice's catalogue function
 * (skill-prior.ts reads a region's competence at it), the `skillFor` idiom
 * one rung out: the answer is derived from the products catalogue and the
 * good's own freight row, never from a name list.
 *
 *   wood, and what wood mills into   → felling (raw) / carpentry (refined)
 *   a natural food or drink           → foraging (the food-making row today)
 *   a refined-tier good (cloth …)     → refining
 *   raw bulk that is not wood (stone) → mining — when the catalogue has it
 *
 * `null` = no skill this world's catalogue names makes it (a staple-tier
 * durable nobody declared, wool, a row a world removed), and every reader
 * treats that as competence 1. A missing catalogue row is the same answer, so
 * declaring `mining` is one line and no code.
 */
export function skillOfGood(good: string, catalogue: SkillCatalogue = DEFAULT_SKILL_CATALOGUE): string | null {
  const head = stackHead(good);
  const has = (k: string): string | null => (catalogue.get(k) ? k : null);
  const products = productHeads();
  if (isWoodHead(head)) return has(products.raw.has(head) ? "felling" : "carpentry");
  const use = products.raw.get(head);
  if (use === "food" || use === "drink") return has("foraging");
  const f = freightOf(head);
  if (f.transit === "selfConsuming") return has("foraging");
  if (f.valueDensity >= VALUE_TIER.refined || products.refined.has(head)) return has("refining");
  if (f.valueDensity < VALUE_TIER.staple) return has("mining");
  return null;
}

/**
 * WHICH SKILL AN ACTION PRACTISES — a CATALOGUE FUNCTION, never a switch
 * scattered through the host. `forage` is the need walker's own path (it is not
 * a `ContributeLink`); everything else is one of the four spoken links.
 */
export function skillFor(link: ContributeLink | "forage", head?: string): string {
  switch (link) {
    case "fell":
      return "felling";
    case "haul":
      return "hauling";
    case "build":
      return "building";
    case "forage":
      return "foraging";
    case "refine":
      return isWoodHead(head) ? "carpentry" : "refining";
  }
}

// ═══ ④ THE RECORD — one writer, one reader ════════════════════════════════

/**
 * A body's practice in ONE skill. An OBJECT rather than a bare number so the
 * later halves (`knowledgeS` for teaching/books, a quality accumulator) add a
 * FIELD instead of a migration. Session-lived; never serialised — the fold into
 * a regional distribution is the REGIONAL slice's job.
 */
export interface BodySkillRow {
  /** Sim seconds of this skill actually performed (plus the inherited share of
   *  every sub-skill practised beneath it). */
  practiceS: number;
}

/**
 * The three session fields this module reads, structurally — so the kernel
 * never value-imports the host and the host never re-implements the curve.
 * Every field is optional-tolerant: a synthetic fixture that carries none reads
 * as a world of novices, which is the pre-skill behaviour verbatim.
 */
export interface SkillState {
  bodySkills?: Map<string, Map<string, BodySkillRow>>;
  skills?: SkillCatalogue;
  scale?: Pick<WorldScale, "learning">;
}

const catalogueOf = (s: SkillState): SkillCatalogue => s.skills ?? DEFAULT_SKILL_CATALOGUE;

/** Belt to the catalogue's braces: a hand-built catalogue can only be 16 deep. */
const MAX_RUNG = 16;

/**
 * THE ONE WRITER. Credits `seconds` of practice to `key` and to every ancestor
 * at `INHERIT_SHARE` per rung — a carpenter's hour is half an hour of general
 * refining and a quarter of an hour of general labour.
 *
 * 🚨 `seconds` is what the body SPENT, always. Never a nominal dwell it did not
 * pay, never a value: the two clocks meet here and only a real second counts.
 */
export function practiceSkill(s: SkillState, cid: string, key: string, seconds: number): void {
  if (!s.bodySkills || !cid || !(seconds > 0)) return;
  const cat = catalogueOf(s);
  if (!cat.get(key)) return; // a world that removed the row does not accrue it
  let rows = s.bodySkills.get(cid);
  if (!rows) {
    rows = new Map<string, BodySkillRow>();
    s.bodySkills.set(cid, rows);
  }
  let k: string | undefined = key;
  let share = 1;
  for (let rung = 0; k && rung < MAX_RUNG; rung++) {
    const row = rows.get(k);
    if (row) row.practiceS += seconds * share;
    else rows.set(k, { practiceS: seconds * share });
    k = cat.get(k)?.parent;
    share *= INHERIT_SHARE;
  }
}

/**
 * EFFECTIVE LEVEL of `key` for a body: `max(level(own row), INHERIT_SHARE ×
 * effectiveLevel(parent))`, one walk up `parent`. Pure over the body's OWN
 * rows — the iteration order of `bodySkills` can never order a decision.
 */
export function skillEffectiveLevel(s: SkillState, cid: string, key: string): number {
  const cat = catalogueOf(s);
  const rows = s.bodySkills?.get(cid);
  let best = 0;
  let k: string | undefined = key;
  let share = 1;
  for (let rung = 0; k && rung < MAX_RUNG; rung++) {
    const def = cat.get(k);
    if (!def) break;
    const lvl = share * skillLevel(rows?.get(k)?.practiceS ?? 0, masteryS(def, s.scale));
    if (lvl > best) best = lvl;
    k = def.parent;
    share *= INHERIT_SHARE;
  }
  return best;
}

/**
 * THE ONE READER — ≥ 1 always. A body with no practice reads exactly 1, which
 * is why every baseline dwell and rate below is untouched on day one.
 */
export function skillMultiplier(s: SkillState, cid: string, key: string): number {
  if (!s.bodySkills || s.bodySkills.size === 0) return 1; // the novice world, fast
  const def = catalogueOf(s).get(key);
  if (!def) return 1;
  return multiplierOf(skillEffectiveLevel(s, cid, key), def.gain);
}

// ═══ THE SPEC SIDE — a `skills` block in the manifest ═════════════════════

/** The authored form (snake_case, like the rest of the `game` envelope):
 *  `{ "<key>": { "parent"?, "mastery_hours"?, "gain"? } }`. */
export type SkillsSpec = Record<string, { parent?: string; mastery_hours?: number; gain?: number }>;

const SKILL_ROW: GroupSpec = {
  objectMessage: "expected an object (the skill row)",
  fields: [
    { key: "parent", kind: "string", label: "Parent skill" },
    { key: "mastery_hours", kind: "number", min: 0.01, max: 1_000_000, label: "Hours of practice to mastery" },
    { key: "gain", kind: "number", min: 1, max: 100, label: "Speed at mastery over a novice" },
  ],
};

/** Structural gate for `game.skills` — path-exact refusals, never skips. */
export function parseSkillsSpec(raw: unknown, path: string): SkillsSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    specFail(path, "expected an object (skill key → row)");
  }
  const out: SkillsSpec = {};
  for (const [key, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.length) specFail(path, "a skill key may not be empty");
    out[key] = validateFields(row, SKILL_ROW, `${path}.${key}`) as SkillsSpec[string];
  }
  return out;
}

/**
 * A document's `skills` block → the world's catalogue. Absent ⇒ the shipped
 * tree verbatim. A row that names only what it changes INHERITS the rest from
 * the shipped row of the same key (the include-then-extend law read at field
 * grain, so `{"felling": {"mastery_hours": 50}}` is a legal one-liner).
 */
export function resolveSkillCatalogue(spec?: SkillsSpec | null): SkillCatalogue {
  if (!spec || !Object.keys(spec).length) return DEFAULT_SKILL_CATALOGUE;
  const extra: SkillDef[] = [];
  for (const [key, row] of Object.entries(spec)) {
    const base = DEFAULT_SKILL_CATALOGUE.get(key);
    const parent = row.parent ?? base?.parent;
    extra.push({
      key,
      ...(parent !== undefined ? { parent } : {}),
      masteryHours: row.mastery_hours ?? base?.masteryHours ?? 100,
      gain: row.gain ?? base?.gain ?? 2,
    });
  }
  return withSkills(...extra);
}
