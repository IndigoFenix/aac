// shared/world-engine/creatures/mods.ts
//
// CREATURE MODS — optional, built-in world modifiers that reshape the species
// registry, in the Dwarf-Fortress creature-variation tradition (user,
// 2026-08-29). A world template declares the ones it wants (`game.mods`); a
// world that declares none sees the authored registry exactly as before.
//
// A mod is a JSON DOCUMENT (mod-library.ts ships the built-ins; a future
// content pack can carry its own), and it does at most two things:
//
//   APPEARANCE — a transform applied to EVERY matching species' blueprint at
//                materialisation time. It adds no species and changes no id;
//                it is a RENDERER option, so the same world with the mod off
//                is the same world. `cute` is this: chunkier bodies, bigger
//                heads.
//   DERIVE     — for every species matching a selector, emit a NEW species
//                whose blueprint is the base's, transformed. `animal_people`
//                is this: every non-speaking creature gains a bipedal,
//                handed, SPEAKING counterpart that keeps its animal head.
//
// ── THE GRAVITATION SYSTEM ──────────────────────────────────────────────────
// Both halves share one transform vocabulary, because the whole design question is
// "which traits are overwritten, which are pulled toward a target, and which
// are left alone". A rule per blueprint FIELD PATH answers it:
//
//   (no rule)                  KEEP — the base value survives untouched. This
//                              is the default and it is load-bearing: an
//                              animal person keeps its muzzle, its horns, its
//                              coat colour and its limb thickness because
//                              NOBODY WROTE A RULE for them.
//   { to: X, by: 1 }           OVERWRITE — land exactly on X.
//   { to: X, by: 0.5 }         GRAVITATE — move half way to X. The dial the
//                              design actually wants: "similar to, but not".
//   { to: "template", by: b }  Gravitate toward the TEMPLATE SPECIES' value at
//                              the same path (`derive.template`, e.g. human).
//   { scale: k }               PROPORTIONAL — multiply. Preserves the spread
//                              across species (a cute snake is a chunkier
//                              SNAKE, not a snake-shaped human).
//   { from: "template" }       SECTION COPY — replace a whole section
//                              (`neck`, `posture`, `spine.profile`).
//   min / max                  Clamp the result before the blueprint's own
//                              range clamp — the ceiling that stops a
//                              proportional rule from running away.
//
// Order within one rule: gravitate, then scale, then clamp. Order across
// mods: declaration order, each applied to the previous result.
//
// PURE DATA + math. No three.js, no registry mutation — `deriveModSpecies`
// RETURNS rows, it does not install them. Safe to import anywhere.

import type { Blueprint } from "./blueprint";
import { clampBlueprint } from "./blueprint";
import type { Species, SpeciesKind } from "./species";
import type { ItemWords, Lexeme, WordLocale } from "../interaction/lang/core.js";

// ── The document shape ──────────────────────────────────────────────────────

/** One field's transform. Every part optional; an empty rule is a no-op. */
export interface FieldRule {
  /** Gravitation target: a literal value, or the template species' own value
   *  at this path. Needs `by`. */
  to?: number | "template";
  /** How far toward `to`: 0 = unchanged, 1 = land on it. */
  by?: number;
  /** Multiply (after gravitation). */
  scale?: number;
  /** Clamp the result (before the blueprint's own range clamp). */
  min?: number;
  max?: number;
  /** Replace this whole SECTION with the template's (section paths only —
   *  `neck`, `posture`, `skin`, `spine.profile`). */
  from?: "template";
}

/** Which species a mod's half applies to. Every field is a filter; omitted =
 *  no constraint. */
export interface SpeciesSelector {
  /** Species kinds ("creature", "plant", …). Omitted = every kind. */
  kinds?: SpeciesKind[];
  /** Match only species whose `canSpeak` is this. */
  canSpeak?: boolean;
  /** Match only species that HAVE a body plan (not `stub`/`bodiless`). */
  hasBody?: boolean;
  /** Never touch these ids (the escape hatch for an authored exception). */
  except?: string[];
}

/** The appearance half — a blueprint transform, no new species. */
export interface AppearanceMod {
  applyTo: SpeciesSelector;
  gravitate: Record<string, FieldRule>;
}

/** How a derived body is stood up on two legs and handed. Structural, so the
 *  JSON declares PARAMETERS and the engine owns the surgery — see
 *  `bipedalize`. */
export interface BipedalizeSpec {
  /** Fields the ARMS take from the template's front limb group (the hand:
   *  digits, opposition, reach). */
  armsFrom: string[];
  /** Fields the LEGS take from the template's rear limb group (the upright
   *  stance). */
  legsFrom: string[];
}

/** The derivation half — emit a new species per matching base. */
export interface DeriveMod {
  from: SpeciesSelector;
  /** Id pattern; `{base}` is the base species id. */
  id: string;
  /** Display-name pattern. `{base}` is the base species' ID here too — the
   *  substitution means ONE thing across the document, and a base `name` is a
   *  worked-example title ("Cow (straight horns)"), not a name a derived row
   *  should wear. */
  name: string;
  /** Species id whose blueprint `"template"` rules read from. */
  template: string;
  /** Flat species-row fields the derived row gets outright.
   *
   *  `bodyRadiusM`: a number, `"template"` (the template species' radius), or
   *  `"proportional"` — the template's radius scaled by how much bigger the
   *  DERIVED torso ended up than the template's. Proportional is the honest
   *  one for a family that spans a cat to an elephant: an elephant person is
   *  a person, but it is not a person-sized person, and everything that
   *  reasons about girth (collision, the indoor router, the rooms its own
   *  town builds) reads this one number. */
  grants?: {
    canSpeak?: boolean;
    bodyRadiusM?: number | "template" | "proportional";
  };
  /** Per-locale word patterns; `{base}` is the base species' lexeme for that
   *  locale. A locale the base has no word for derives no word. */
  words?: Partial<Record<WordLocale, Lexeme>>;
  /** Worldgen abundance relative to the base species (1 = as common). Carried
   *  on the derived row for the spawn pass to read; nothing spawns yet. */
  rarity?: number;
  /** Where it lives. `"base"` = the base species' habitat, which is the only
   *  value that means anything today. */
  habitat?: "base";
  bipedalize?: BipedalizeSpec;
  gravitate: Record<string, FieldRule>;
}

export interface CreatureMod {
  id: string;
  name: string;
  description: string;
  appearance?: AppearanceMod;
  derive?: DeriveMod;
}

// ── Parsing (the kernel's refusal law: path-exact, never a silent skip) ─────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function only(raw: Record<string, unknown>, path: string, allowed: string[]): void {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a finite number");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || !v.length) fail(path, "must be a non-empty string");
  return v;
}

function parseFieldRule(raw: unknown, path: string): FieldRule {
  if (!isObj(raw)) fail(path, "expected an object");
  only(raw, path, ["to", "by", "scale", "min", "max", "from"]);
  const rule: FieldRule = {};
  if ("to" in raw) {
    if (raw.to === "template") rule.to = "template";
    else rule.to = num(raw.to, `${path}.to`);
    if (!("by" in raw)) fail(`${path}.by`, "required alongside `to` (0 = unchanged, 1 = land on it)");
    const by = num(raw.by, `${path}.by`);
    if (by < 0 || by > 1) fail(`${path}.by`, "must be between 0 and 1");
    rule.by = by;
  } else if ("by" in raw) {
    fail(`${path}.by`, "means nothing without `to`");
  }
  if ("scale" in raw) rule.scale = num(raw.scale, `${path}.scale`);
  if ("min" in raw) rule.min = num(raw.min, `${path}.min`);
  if ("max" in raw) rule.max = num(raw.max, `${path}.max`);
  if ("from" in raw) {
    if (raw.from !== "template") fail(`${path}.from`, 'the only section source is "template"');
    rule.from = "template";
  }
  return rule;
}

function parseGravitate(raw: unknown, path: string): Record<string, FieldRule> {
  if (!isObj(raw)) fail(path, "expected an object of field-path → rule");
  const out: Record<string, FieldRule> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseFieldRule(v, `${path}.${k}`);
  return out;
}

const KINDS: readonly string[] = ["creature", "plant", "fruit", "spark"];

function parseSelector(raw: unknown, path: string): SpeciesSelector {
  if (!isObj(raw)) fail(path, "expected an object");
  only(raw, path, ["kinds", "canSpeak", "hasBody", "except"]);
  const sel: SpeciesSelector = {};
  if ("kinds" in raw) {
    if (!Array.isArray(raw.kinds)) fail(`${path}.kinds`, "must be an array of species kinds");
    sel.kinds = raw.kinds.map((k, i) => {
      const s = str(k, `${path}.kinds[${i}]`);
      if (!KINDS.includes(s)) fail(`${path}.kinds[${i}]`, `must be one of: ${KINDS.join(", ")}`);
      return s as SpeciesKind;
    });
  }
  if ("canSpeak" in raw) {
    if (typeof raw.canSpeak !== "boolean") fail(`${path}.canSpeak`, "must be true or false");
    sel.canSpeak = raw.canSpeak;
  }
  if ("hasBody" in raw) {
    if (typeof raw.hasBody !== "boolean") fail(`${path}.hasBody`, "must be true or false");
    sel.hasBody = raw.hasBody;
  }
  if ("except" in raw) {
    if (!Array.isArray(raw.except)) fail(`${path}.except`, "must be an array of species ids");
    sel.except = raw.except.map((e, i) => str(e, `${path}.except[${i}]`));
  }
  return sel;
}

function parseLexeme(raw: unknown, path: string): Lexeme {
  if (!isObj(raw)) fail(path, "expected a lexeme object");
  if (typeof raw.w !== "string" || !raw.w.length) fail(`${path}.w`, "must be a non-empty word pattern");
  // Lexeme is an open shape (v2/v3/plw/defw/…); the words here are NOUNS, so
  // only string fields plus the boolean/gender ones can appear. Anything else
  // is a typo, and a typo'd lexeme field fails SILENTLY at render time.
  for (const [k, v] of Object.entries(raw)) {
    if (k === "pl" || k === "mass") {
      if (typeof v !== "boolean") fail(`${path}.${k}`, "must be true or false");
    } else if (typeof v !== "string") {
      fail(`${path}.${k}`, "must be a string");
    }
  }
  return raw as unknown as Lexeme;
}

const LOCALES: readonly string[] = ["en", "he", "es", "pt"];

function parseDerive(raw: unknown, path: string): DeriveMod {
  if (!isObj(raw)) fail(path, "expected an object");
  only(raw, path, ["from", "id", "name", "template", "grants", "words", "rarity", "habitat", "bipedalize", "gravitate"]);
  const id = str(raw.id, `${path}.id`);
  if (!id.includes("{base}")) fail(`${path}.id`, "must contain {base} — a derived id has to be unique per base species");
  const d: DeriveMod = {
    from: parseSelector(raw.from ?? {}, `${path}.from`),
    id,
    name: str(raw.name ?? "{base}", `${path}.name`),
    template: str(raw.template, `${path}.template`),
    gravitate: parseGravitate(raw.gravitate ?? {}, `${path}.gravitate`),
  };
  if ("grants" in raw && raw.grants !== undefined) {
    const g = raw.grants;
    if (!isObj(g)) fail(`${path}.grants`, "expected an object");
    only(g, `${path}.grants`, ["canSpeak", "bodyRadiusM"]);
    d.grants = {};
    if ("canSpeak" in g) {
      if (typeof g.canSpeak !== "boolean") fail(`${path}.grants.canSpeak`, "must be true or false");
      d.grants.canSpeak = g.canSpeak;
    }
    if ("bodyRadiusM" in g) {
      d.grants.bodyRadiusM = (g.bodyRadiusM === "template" || g.bodyRadiusM === "proportional")
        ? g.bodyRadiusM
        : num(g.bodyRadiusM, `${path}.grants.bodyRadiusM`);
    }
  }
  if ("words" in raw && raw.words !== undefined) {
    if (!isObj(raw.words)) fail(`${path}.words`, "expected an object of locale → lexeme pattern");
    const w: Partial<Record<WordLocale, Lexeme>> = {};
    for (const [loc, lex] of Object.entries(raw.words)) {
      if (!LOCALES.includes(loc)) fail(`${path}.words.${loc}`, `unknown locale (allowed: ${LOCALES.join(", ")})`);
      w[loc as WordLocale] = parseLexeme(lex, `${path}.words.${loc}`);
    }
    d.words = w;
  }
  if ("rarity" in raw && raw.rarity !== undefined) {
    const r = num(raw.rarity, `${path}.rarity`);
    if (r <= 0) fail(`${path}.rarity`, "must be greater than 0 (a species nothing ever spawns is not a species)");
    d.rarity = r;
  }
  if ("habitat" in raw && raw.habitat !== undefined) {
    if (raw.habitat !== "base") fail(`${path}.habitat`, 'the only habitat source is "base" (the species it derives from)');
    d.habitat = "base";
  }
  if ("bipedalize" in raw && raw.bipedalize !== undefined) {
    const b = raw.bipedalize;
    if (!isObj(b)) fail(`${path}.bipedalize`, "expected an object");
    only(b, `${path}.bipedalize`, ["armsFrom", "legsFrom"]);
    const list = (v: unknown, p: string): string[] => {
      if (!Array.isArray(v)) fail(p, "must be an array of limb-group field names");
      return v.map((x, i) => str(x, `${p}[${i}]`));
    };
    d.bipedalize = {
      armsFrom: list(b.armsFrom, `${path}.bipedalize.armsFrom`),
      legsFrom: list(b.legsFrom, `${path}.bipedalize.legsFrom`),
    };
  }
  return d;
}

/** Structural gate for one mod document. Unknown fields are path-exact
 *  errors — a mod that silently ignored half its own JSON would look like it
 *  worked and change nothing. */
export function parseCreatureMod(raw: unknown, path = "mod"): CreatureMod {
  if (!isObj(raw)) fail(path, "expected an object");
  only(raw, path, ["id", "name", "description", "appearance", "derive"]);
  const mod: CreatureMod = {
    id: str(raw.id, `${path}.id`),
    name: str(raw.name, `${path}.name`),
    description: str(raw.description, `${path}.description`),
  };
  if ("appearance" in raw && raw.appearance !== undefined) {
    const a = raw.appearance;
    if (!isObj(a)) fail(`${path}.appearance`, "expected an object");
    only(a, `${path}.appearance`, ["applyTo", "gravitate"]);
    mod.appearance = {
      applyTo: parseSelector(a.applyTo ?? {}, `${path}.appearance.applyTo`),
      gravitate: parseGravitate(a.gravitate ?? {}, `${path}.appearance.gravitate`),
    };
  }
  if ("derive" in raw && raw.derive !== undefined) mod.derive = parseDerive(raw.derive, `${path}.derive`);
  if (!mod.appearance && !mod.derive) {
    fail(path, "a mod must declare `appearance`, `derive`, or both — one that does neither is a no-op");
  }
  return mod;
}

// ── Selection ───────────────────────────────────────────────────────────────

/** Does this species match the selector? A species with no body (`stub` /
 *  `bodiless`) is never given a blueprint transform — clamping its empty
 *  blueprint would invent a default body, which is the exact failure
 *  `Species.stub` exists to prevent. */
export function speciesMatches(sp: Species, sel: SpeciesSelector): boolean {
  if (sel.except?.includes(sp.id)) return false;
  if (sel.kinds && !sel.kinds.includes(sp.kind)) return false;
  if (sel.canSpeak !== undefined && (sp.canSpeak ?? false) !== sel.canSpeak) return false;
  if (sel.hasBody !== undefined) {
    const bodied = !sp.stub && !sp.bodiless;
    if (bodied !== sel.hasBody) return false;
  }
  return true;
}

// ── The path engine ─────────────────────────────────────────────────────────
//
// Paths address a CLAMPED blueprint, so every field named here exists. Three
// shapes:
//   "spine.girth"                a numeric leaf
//   "limbGroups.*.radiusFrac"    the same leaf on EVERY limb group
//   "neck" / "spine.profile"     a whole section (`from: "template"` only)

type AnyRec = Record<string, unknown>;

function walk(root: AnyRec, parts: string[]): { parent: AnyRec; leaf: string } | null {
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur)) return null;
    cur = cur[parts[i]!];
  }
  if (!isObj(cur)) return null;
  return { parent: cur, leaf: parts[parts.length - 1]! };
}

/** Every (parent, leaf) a path resolves to — more than one when it wildcards
 *  over limb groups. `template` walks in lockstep so a `"template"` target
 *  reads the corresponding group. */
function resolve(
  bp: AnyRec, tpl: AnyRec | null, path: string,
): Array<{ parent: AnyRec; leaf: string; tplParent: AnyRec | null }> {
  const parts = path.split(".");
  const star = parts.indexOf("*");
  if (star < 0) {
    const hit = walk(bp, parts);
    if (!hit) return [];
    const tplHit = tpl ? walk(tpl, parts) : null;
    return [{ ...hit, tplParent: tplHit?.parent ?? null }];
  }
  // One wildcard, over an array section ("limbGroups.*.radiusFrac").
  const before = parts.slice(0, star);
  const after = parts.slice(star + 1);
  let arr: unknown = bp;
  for (const p of before) arr = isObj(arr) ? arr[p] : undefined;
  let tplArr: unknown = tpl;
  for (const p of before) tplArr = isObj(tplArr) ? tplArr[p] : undefined;
  if (!Array.isArray(arr)) return [];
  const out: Array<{ parent: AnyRec; leaf: string; tplParent: AnyRec | null }> = [];
  arr.forEach((el, i) => {
    if (!isObj(el)) return;
    const hit = walk(el, after);
    if (!hit) return;
    // Template lockstep: element i, else the LAST template element (a
    // 3-group animal reading a 2-group template shouldn't lose its rules).
    let tplEl: unknown;
    if (Array.isArray(tplArr) && tplArr.length) tplEl = tplArr[Math.min(i, tplArr.length - 1)];
    const tplHit = isObj(tplEl) ? walk(tplEl, after) : null;
    out.push({ ...hit, tplParent: tplHit?.parent ?? null });
  });
  return out;
}

/** Deep structural clone of the plain-JSON blueprint shape. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Apply one rule set to a blueprint in place. `tpl` supplies `"template"`
 *  values (null when the mod half has no template — appearance mods). */
function applyRules(bp: AnyRec, tpl: AnyRec | null, rules: Record<string, FieldRule>): void {
  for (const [path, rule] of Object.entries(rules)) {
    // SECTION COPY first — it replaces the subtree, so a leaf rule under the
    // same section would be overwritten if it ran before.
    if (rule.from === "template") {
      if (!tpl) continue;
      const parts = path.split(".");
      const dst = walk(bp, parts);
      const src = walk(tpl, parts);
      if (!dst || !src) continue;
      const v = src.parent[src.leaf];
      if (v === undefined) continue;
      dst.parent[dst.leaf] = clone(v);
      continue;
    }
    for (const { parent, leaf, tplParent } of resolve(bp, tpl, path)) {
      const cur = parent[leaf];
      if (typeof cur !== "number") continue;
      let v = cur;
      if (rule.to !== undefined && rule.by !== undefined) {
        let target: number | undefined;
        if (rule.to === "template") {
          const t = tplParent?.[leaf];
          if (typeof t === "number") target = t;
        } else target = rule.to;
        if (target !== undefined) v = v + (target - v) * rule.by;
      }
      if (rule.scale !== undefined) v *= rule.scale;
      if (rule.min !== undefined) v = Math.max(rule.min, v);
      if (rule.max !== undefined) v = Math.min(rule.max, v);
      parent[leaf] = v;
    }
  }
}

// ── Appearance ──────────────────────────────────────────────────────────────

/**
 * Run the appearance half of each mod over one species' blueprint, in
 * declaration order. Returns a NEW clamped blueprint; the input is untouched.
 * A species the mod's selector rejects comes back unchanged.
 */
export function applyAppearanceMods(sp: Species, bp: Blueprint, mods: readonly CreatureMod[]): Blueprint {
  // A SPECIES WITH NO BODY IS NEVER GIVEN ONE HERE. `bp` for a stub or the
  // spark is `clampBlueprint({})` — a complete DEFAULT quadruped — so running
  // a transform over it would hand back a real body plan for a species that
  // deliberately has none, and the caller would have no way to tell. The
  // build path already refuses these (buildSpeciesAssets throws); this is the
  // same refusal at the transform, so a mod can never be the thing that
  // invents a lion.
  if (sp.stub || sp.bodiless) return bp;
  let out = bp;
  let copied = false;
  for (const mod of mods) {
    const app = mod.appearance;
    if (!app || !speciesMatches(sp, app.applyTo)) continue;
    if (!copied) { out = clone(out); copied = true; }
    applyRules(out as unknown as AnyRec, null, app.gravitate);
  }
  return copied ? clampBlueprint(out) : out;
}

/** A stable tag for the active appearance mods — the asset cache must key on
 *  it, or the first-baked variant is handed to everyone. Empty when no mod
 *  touches appearance. */
export function appearanceModTag(mods: readonly CreatureMod[]): string {
  const ids = mods.filter((m) => m.appearance).map((m) => m.id);
  return ids.length ? `|m:${ids.join(",")}` : "";
}

// ── The session's active mods ───────────────────────────────────────────────
//
// One process runs one world, so the active set is module state — the same
// shape `materials.ts` holds the engine-wide shading mode in, and for the same
// reason: every body-building site would otherwise have to be handed the
// world's mod list, and the one that wasn't would silently bake an unmodded
// body into a modded world.
//
// It lives HERE rather than in creature-model.ts so a pure context (tests,
// the server, headless text mode) can read and set it without pulling in
// three.js.

let ACTIVE: readonly CreatureMod[] = [];

/** Install the world's mods as the active set. Called once at world load
 *  (world-mods.ts); pass `[]` to go back to the authored registry. */
export function setActiveCreatureMods(mods: readonly CreatureMod[]): void {
  ACTIVE = mods;
}

/** The mods this world is running. */
export function activeCreatureMods(): readonly CreatureMod[] {
  return ACTIVE;
}

// ── Derivation ──────────────────────────────────────────────────────────────

interface LimbGroup extends AnyRec {
  stationStart: number;
  stationEnd: number;
  count: number;
}

const isLimb = (v: unknown): v is LimbGroup =>
  isObj(v) && typeof v.stationStart === "number" && typeof v.count === "number";

/**
 * STAND THE BODY UP AND GIVE IT HANDS.
 *
 * Structural, so it is an engine step the JSON parameterises rather than a
 * rule set: which limb group becomes the arms is a fact about the body, not a
 * number to interpolate.
 *
 *   • The REAR-most limb group becomes the LEGS, the FRONT-most the ARMS.
 *   • Each takes its POSTURE fields from the template's corresponding group
 *     (that is the whole of "bipedal" and "handed") and KEEPS everything else
 *     — chiefly `radiusFrac`/`taper`, so limb thickness stays the animal's.
 *   • LIMB COUNT IS CONSERVED. A one-group quadruped (2 pairs) becomes 1 pair
 *     of legs + 1 pair of arms: still four limbs. A one-group hexapod (3
 *     pairs) becomes 2 pairs of legs + 1 pair of arms: still six. Groups
 *     beyond the two used are left exactly as they were.
 */
function bipedalize(bp: AnyRec, tpl: AnyRec, spec: BipedalizeSpec): void {
  const groups = Array.isArray(bp.limbGroups) ? bp.limbGroups : [];
  const tplGroups = Array.isArray(tpl.limbGroups) ? tpl.limbGroups : [];
  const bodied = groups.filter(isLimb);
  const tplBodied = tplGroups.filter(isLimb);
  if (!bodied.length || tplBodied.length < 2) return;

  // Template roles: rear-most = legs, front-most = arms (the human's own
  // split — group 0 sits at station 0.88, group 1 at 0).
  const tplLegs = tplBodied.reduce((a, b) => (b.stationStart > a.stationStart ? b : a));
  const tplArms = tplBodied.reduce((a, b) => (b.stationStart < a.stationStart ? b : a));

  const take = (dst: LimbGroup, src: LimbGroup, fields: string[]): void => {
    for (const f of fields) if (src[f] !== undefined) dst[f] = src[f];
  };

  if (bodied.length === 1) {
    // ONE group doing every job: split it into an arm pair and the rest legs.
    const src = bodied[0]!;
    const legs = clone(src);
    const arms = clone(src);
    legs.count = Math.max(1, Math.round(src.count) - 1);
    arms.count = 1;
    take(legs, tplLegs, spec.legsFrom);
    take(arms, tplArms, spec.armsFrom);
    const idx = groups.indexOf(src);
    groups.splice(idx, 1, legs, arms);
    bp.limbGroups = groups;
    return;
  }
  const legs = bodied.reduce((a, b) => (b.stationStart > a.stationStart ? b : a));
  const arms = bodied.reduce((a, b) => (b.stationStart < a.stationStart ? b : a));
  take(legs, tplLegs, spec.legsFrom);
  take(arms, tplArms, spec.armsFrom);
}

/** Substitute `{base}` in a pattern. */
const fill = (pattern: string, base: string): string => pattern.split("{base}").join(base);

/** Build the derived row's words from the base's, per locale. A locale the
 *  base has no lexeme for derives NOTHING — inventing one would put an
 *  English word on a Hebrew board, which is the exact silent failure
 *  `validate-builder-lexicon` exists to catch. */
function deriveWords(base: ItemWords | undefined, patterns: Partial<Record<WordLocale, Lexeme>>): ItemWords | undefined {
  if (!base) return undefined;
  const out: Record<string, Lexeme> = {};
  for (const [loc, pat] of Object.entries(patterns)) {
    const src = base[loc as WordLocale];
    if (!src?.w) continue;
    const lex: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pat as unknown as Record<string, unknown>)) {
      lex[k] = typeof v === "string" ? fill(v, src.w) : v;
    }
    out[loc] = lex as unknown as Lexeme;
  }
  return Object.keys(out).length ? (out as ItemWords) : undefined;
}

/** The template's body radius, scaled by how much bigger the DERIVED torso is
 *  than the template's. Undefined when either torso is missing (a stub has no
 *  body, so it has no size — its radius stays the engine default until someone
 *  draws it). */
function proportionalRadius(
  template: Species, derivedBp: Record<string, unknown>, stub: boolean,
): number | undefined {
  if (stub || template.bodyRadiusM === undefined) return template.bodyRadiusM;
  const tplTorso = (clampBlueprint(template.blueprint) as unknown as AnyRec).spine as AnyRec | undefined;
  const ownTorso = (derivedBp as AnyRec).spine as AnyRec | undefined;
  const t = typeof tplTorso?.torsoLengthM === "number" ? tplTorso.torsoLengthM : 0;
  const o = typeof ownTorso?.torsoLengthM === "number" ? ownTorso.torsoLengthM : 0;
  if (!t || !o) return template.bodyRadiusM;
  return template.bodyRadiusM * (o / t);
}

/** A derived species row — a `Species` plus the provenance the spawn pass
 *  will read (which mod made it, from what, and how rare it is). */
export interface DerivedSpecies extends Species {
  /** The mod that emitted this row. */
  readonly fromMod: string;
  /** The species it was derived from — ALSO its habitat: it lives where its
   *  base animal lives (`derive.habitat: "base"`). */
  readonly derivedFrom: string;
  /** Worldgen abundance relative to the base species (1 = as common). */
  readonly rarity?: number;
}

/**
 * Every species the given mods derive from the given base registry, in mod
 * order then base-registry order (which is the vocabulary's rank).
 *
 * PURE: it returns rows, it installs nothing. Callers that want them in the
 * registry (a world declaring the mod, the creature lab) register them
 * themselves — and an AUTHORED row of the same id always wins, so the
 * hand-tuned `dog_person`/`bear_person`/`frog_person`/`rabbit_person` bodies
 * keep their authored geometry and only the ones nobody drew are generated.
 */
export function deriveModSpecies(
  mods: readonly CreatureMod[],
  registry: readonly Species[],
): DerivedSpecies[] {
  const byId = new Map(registry.map((s) => [s.id, s] as const));
  const out: DerivedSpecies[] = [];
  const seen = new Set<string>();
  for (const mod of mods) {
    const d = mod.derive;
    if (!d) continue;
    const template = byId.get(d.template);
    if (!template) throw new Error(`creature mod "${mod.id}": unknown template species "${d.template}"`);
    const tplBp = clampBlueprint(template.blueprint) as unknown as AnyRec;
    for (const base of registry) {
      if (!speciesMatches(base, d.from)) continue;
      const id = fill(d.id, base.id);
      if (byId.has(id) || seen.has(id)) continue; // authored (or already derived) wins
      seen.add(id);

      // A STUB base derives a STUB: the word ships ahead of the body here for
      // exactly the reason it does on the base row, and clamping the base's
      // empty blueprint would stand a default quadruped up and call it a lion
      // person.
      const stub = !!base.stub || !!base.bodiless;
      let blueprint: Record<string, unknown> = {};
      if (!stub) {
        const bp = clampBlueprint(base.blueprint) as unknown as AnyRec;
        if (d.bipedalize) bipedalize(bp, tplBp, d.bipedalize);
        applyRules(bp, tplBp, d.gravitate);
        bp.name = id;
        blueprint = clampBlueprint(bp) as unknown as Record<string, unknown>;
      }

      const grant = d.grants?.bodyRadiusM;
      let bodyRadiusM: number | undefined;
      if (grant === "template") bodyRadiusM = template.bodyRadiusM;
      else if (grant === "proportional") bodyRadiusM = proportionalRadius(template, blueprint, stub);
      else bodyRadiusM = grant;

      out.push({
        id,
        name: fill(d.name, base.id),
        kind: base.kind,
        ...(stub ? { stub: true as const } : {}),
        ...(d.grants?.canSpeak !== undefined ? { canSpeak: d.grants.canSpeak } : {}),
        blueprint,
        scale: base.scale,
        ...(bodyRadiusM !== undefined ? { bodyRadiusM } : {}),
        ...(d.words ? { words: deriveWords(base.words, d.words) } : {}),
        fromMod: mod.id,
        derivedFrom: base.id,
        ...(d.rarity !== undefined ? { rarity: d.rarity } : {}),
      });
    }
  }
  return out;
}
