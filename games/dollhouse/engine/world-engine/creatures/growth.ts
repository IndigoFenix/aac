// Growths — the branching + spiral grammar shared by PLANTS and DERMAL
// GROWTHS (horns, antlers, spikes). One continuous parametric system:
// a tree is a growth planted on a near-invisible body nub, a ram horn is
// a curled unbranched growth on a head, an antler is a branched one.
//
// PURE MATH. No three.js, no DOM, no imports from the render layers —
// node-testable and server-importable (the description→blueprint AI pipeline
// emits GrowthBlueprint as part of a Blueprint). blueprint.ts delegates the
// `growths` array's clamp/validate here; skeleton.ts calls
// generateGrowth() and welds the result to a bone as rigid geometry.
//
// Design rules (see instructions/creatures.md):
// - Continuous fields, no symbolic L-system, no per-level arrays: one
//   geometric ratio per property covers the visual range.
// - Deterministic: every random-looking choice is a pure hash of
//   (blueprint.seed, the node's path in the tree) — NEVER a sequential RNG
//   stream — so the structure is independent of traversal order and of
//   the segment budget.
// - Budget-ordered (the LOD trick): segments are emitted coarse-to-fine
//   through a priority queue (level asc, radius desc, path asc), so
//   generateGrowth(g, N).segments is a STRUCTURAL PREFIX of
//   generateGrowth(g, M > N).segments. LOD tiers of one kind are
//   literally truncations of each other.

import type { FieldRange, RangesOf } from "./blueprint";

// ── Vec3 (local minimal copy — growth.ts stays a leaf module) ────────────

export interface GVec3 {
  x: number;
  y: number;
  z: number;
}

const v3 = (x: number, y: number, z: number): GVec3 => ({ x, y, z });
const add = (a: GVec3, b: GVec3): GVec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a: GVec3, s: number): GVec3 => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: GVec3, b: GVec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: GVec3): number => Math.hypot(a.x, a.y, a.z);
const normalize = (a: GVec3): GVec3 => {
  const l = length(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};
const cross = (a: GVec3, b: GVec3): GVec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const lerpV = (a: GVec3, b: GVec3, t: number): GVec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Rodrigues rotation of `v` around unit `axis` by `angle`. */
function rotate(v: GVec3, axis: GVec3, angle: number): GVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(axis, v);
  const cr = cross(axis, v);
  return v3(
    v.x * c + cr.x * s + axis.x * d * (1 - c),
    v.y * c + cr.y * s + axis.y * d * (1 - c),
    v.z * c + cr.z * s + axis.z * d * (1 - c),
  );
}

/** Component of `v` perpendicular to unit `dir`, normalized; `fallback`
 *  when degenerate. */
function perpTo(v: GVec3, dir: GVec3, fallback: GVec3): GVec3 {
  const p = add(v, scale(dir, -dot(dir, v)));
  return length(p) < 1e-6 ? fallback : normalize(p);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const GDOWN: GVec3 = { x: 0, y: -1, z: 0 };
/** Rotate `dir` toward straight-down by `frac` of the angle between them
 *  (0 = unchanged, 1 = straight down). Robust when `dir` is vertical —
 *  a plain vector lerp cancels to zero at the halfway point. */
function towardDown(dir: GVec3, frac: number): GVec3 {
  const nd = normalize(dir);
  const d = Math.max(-1, Math.min(1, dot(nd, GDOWN)));
  const ang = Math.acos(d) * Math.min(1, Math.max(0, frac));
  if (ang < 1e-6) return nd;
  let axis = cross(nd, GDOWN);
  axis = length(axis) < 1e-6 ? v3(1, 0, 0) : normalize(axis); // (anti)parallel → spin about X
  return normalize(rotate(nd, axis, ang));
}

// ── Blueprint types ─────────────────────────────────────────────────────────

/** Where a growth roots on the creature. Plants use "body" on the nub. */
export type GrowthAttach = "head" | "body";
/** How a growth's copies are arranged (same idea as limbs/chains). */
export type GrowthPlacement = "bilateral" | "radial";
/** Where fruits sit: scattered along terminal branches, or one at each
 *  terminal tip (a mushroom cap is a terminal oblate fruit). */
export type FruitPlacement = "along" | "terminal";

/** What a growth fundamentally IS — the botanical fate of its primary
 *  axis. All three share the same field templates (stem/branching/foliage/
 *  fruit); the type only sets orientation + determinacy.
 *  - shoot: an indeterminate upward axis that branches and bears foliage /
 *    fruit (trees, shrubs, horns — the default, everything before this).
 *  - fruit: the growth IS one determinate fruit body on a short pedicel —
 *    a market item, a gourd, a flower or fruit sitting on the ground.
 *    Branching is skipped.
 *  - root: like fruit but the storage body grows DOWN (a root vegetable),
 *    with the leafy crown at the top (ground level). */
export type GrowthType = "shoot" | "fruit" | "root";

/** The stem — the level-0 axis every branch level derives from. */
export interface GrowthStemBlueprint {
  /** Stem length / torso length. Growths scale WITH the creature (horns);
   *  plants standardize a small body nub, so tall trees need large
   *  fractions — hence the wide range. */
  lengthFrac: number;
  /** Base radius / OWN length. 0.02 = tree trunk, 0.12 = stout mushroom
   *  stem, 0.08 = horn base. */
  girth: number;
  /** Lofted segments along the level-0 stem (deeper levels shrink from
   *  this). More = smoother curls. */
  segments: number;
  /** Tip radius / base radius of each branch. */
  taper: number;
  /** Tilt away from the attach normal, radians: positive toward local
   *  forward, negative rearward (a ram horn starts back-swept). Mirrored
   *  for the L copy of a bilateral pair. */
  lean: number;
  /** Direction jitter per segment, 0 = straight, 1 = gnarled. */
  waviness: number;
  /** Cross-section: 0 = round loft .. 1 = flat blade. Above ~0.7 the
   *  mesh emits a two-sided ribbon (grass blades) instead of a tube. */
  flatten: number;
  /** Ribs on the cross-section (cactus). 0 = smooth round ring. */
  lobes: number;
  /** TOTAL in-plane curvature over the stem length, radians (signed).
   *  ~12 = two full coils (ram horn). Applied as constant curvature per
   *  meter to every branch, so the whole growth shares one material
   *  habit. */
  curl: number;
  /** TOTAL torsion over the stem length, radians (signed). curl alone =
   *  planar coil (ram); curl+twist = helix (kudu); both ~0 = straight
   *  (cow). Mirrored (chirality flips) for the L copy. */
  twist: number;
  /** -1 = every branch curves toward the ground (weeping willow),
   *  0 = none, +1 = curves toward the sky (poplar). Rest-pose space —
   *  baked; a welded horn keeps its curve when the head moves. */
  gravitropism: number;
  /** 0 = green/fleshy (base color) .. 1 = wood/keratin (accent color).
   *  Same blend the beak uses. */
  hardness: number;
  /** Radius multiplier at the very base, easing out over the bottom
   *  ~12% of the stem — root buttress / horn boss. 1 = none. */
  rootFlare: number;
}

/** The branching rules — identical at every level, scaled by the ratios. */
export interface GrowthBranchingBlueprint {
  /** Recursion depth beyond the stem. 0 = unbranched (grass blade, cow
   *  horn, mushroom stem). */
  levels: number;
  /** Where along a parent branching begins, 0 = at the base (bush) ..
   *  near 1 = only at the top (palm, umbrella tree). */
  branchStart: number;
  /** Branch NODES along each parent (whorls of children sprout at each
   *  node). */
  nodes: number;
  /** Children per node, fanned evenly around the parent. */
  whorl: number;
  /** Azimuth rotation between successive nodes, radians. Golden angle
   *  (~2.4) = natural spiral phyllotaxis; small values stack branches
   *  in a plane (antlers). */
  phyllotaxis: number;
  /** Child tilt away from the parent axis, radians. */
  branchAngle: number;
  /** Child length / parent length. */
  lengthRatio: number;
  /** Child base radius / parent radius at the node. */
  radiusRatio: number;
  /** 0 = perfectly regular .. 1 = strongly randomized angles/lengths
   *  (deterministic per seed). */
  jitter: number;
}

/** Leaves — cards scattered along TERMINAL-level branches. */
export interface GrowthFoliageBlueprint {
  /** Expected leaves per terminal segment. 0 = bare (horns). */
  leafDensity: number;
  /** Leaf length / local segment length. */
  leafSizeFrac: number;
  /** Leaf width / leaf length. 0.05 = needle, 1 = round. */
  leafAspect: number;
  /** -1 = leaves point down .. +1 = up. */
  leafDroop: number;
  /** Leaf color, "#rrggbb". */
  leafColor: string;
}

/** Flowers — petal-card clusters at terminal branch tips. */
export interface GrowthFlowerBlueprint {
  /** Chance each terminal tip bears a flower, 0..1. */
  flowerDensity: number;
  /** Petals per flower. */
  petalCount: number;
  /** Petal length / local segment length. */
  flowerSizeFrac: number;
  /** Petal color, "#rrggbb". */
  flowerColor: string;
}

/** A FRUIT BODY — a short determinate axis with a real shape. The same
 *  primitive is a berry, a banana, a pear, a pumpkin, a mushroom cap, or
 *  (pointing down) a carrot. Standalone-usable: buildFruitMesh renders one
 *  as a market item. Density/placement live on the growth. */
export interface GrowthFruitBlueprint {
  /** Equatorial (widest) DIAMETER in meters — ABSOLUTE, not relative to
   *  the twig it hangs on, so a big fruit on a stub stem (ground pumpkin)
   *  works and market items carry a real size. Cherry ~0.02, apple ~0.08,
   *  pumpkin ~0.3; length = sizeM × aspect. */
  sizeM: number;
  /** Long-axis : equatorial ratio. 0.35 = oblate disc (mushroom cap),
   *  1 = sphere (apple), 5 = long (banana, cucumber, cattail). */
  aspect: number;
  /** Station of maximum girth along the body, 0 (stem/base end) .. 1 (far
   *  tip). 0.5 = symmetric (apple), high = top-heavy (fig), low = onion. */
  bulge: number;
  /** Taper at the STEM/base end, 0 = full width .. 1 = pinched to a neck
   *  (pear, gourd, bottle, calabash). */
  neck: number;
  /** Taper at the FAR tip, 0 = round .. 1 = drawn to a point (strawberry,
   *  lemon, teardrop, carrot). */
  tipTaper: number;
  /** Bend of the body's long axis, signed radians over its length — a
   *  banana / chili / cashew curve. Uses the same transported-frame
   *  integration as a stem's curl. */
  curvature: number;
  /** Cross-section ribs (pumpkin, bell pepper, star fruit). 0 = round. */
  lobes: number;
  /** Stalk length / fruit diameter. 0 = sessile, sitting ON the tip and
   *  aligned with the branch (mushroom cap); > 0 = dangles below on a
   *  stalk (apple). Doubles as the hang-vs-align dial. */
  stemFrac: number;
  /** Leaves at the FAR tip (pineapple crown, the leafy top of a root
   *  vegetable when it points down). Leaf-colored (foliage.leafColor). */
  crownLeaves: number;
  /** Crown/calyx leaf length / fruit length. */
  crownSize: number;
  /** Leaves at the STEM/base end (strawberry calyx, tomato hull). */
  calyxLeaves: number;
  /** Fruit color, "#rrggbb". */
  color: string;
}

export interface GrowthBlueprint {
  /** The botanical fate of the primary axis (shoot | fruit | root). Shared
   *  templates; sets orientation + determinacy. Default "shoot". */
  type: GrowthType;
  // ── Attachment (same connective idea as limbs/chains) ─────────────────
  attach: GrowthAttach;
  /** Station along the trunk if attach = "body" (0 front .. 1 rear). */
  station: number;
  /** Position around the cross-section: 0 = ventral midline, 0.5 =
   *  lateral, 1 = dorsal midline (matches limb attachHeight). For a
   *  head attach: 0 = under the chin .. 1 = the crown. */
  phi: number;
  /** bilateral = mirrored L/R pairs (count 1 + phi 1 = a single dorsal
   *  midline growth); radial = count spokes around the axis. */
  placement: GrowthPlacement;
  /** Copies (pairs or radial spokes). */
  count: number;
  /** Splay of the copies away from the surface normal, radians. */
  spread: number;
  /** Deterministic variation seed — same blueprint + seed = same growth,
   *  bit for bit. */
  seed: number;
  stem: GrowthStemBlueprint;
  branching: GrowthBranchingBlueprint;
  foliage: GrowthFoliageBlueprint;
  flowers: GrowthFlowerBlueprint;
  fruit: GrowthFruitBlueprint;
  /** Expected fruits per terminal segment ("along") or chance per
   *  terminal tip ("terminal"). */
  fruitDensity: number;
  fruitPlacement: FruitPlacement;
}

// ── Caps + enums ─────────────────────────────────────────────────────────

/** Growth entries one blueprint can carry. */
export const MAX_GROWTHS = 4;
/** TOTAL lofted segments shared by ALL of a blueprint's growths (enforced by
 *  generateGrowth budgets, NOT by clamp — clamp stays per-field). This is
 *  also the LOD0 budget of a plant kind. */
export const MAX_GROWTH_SEGMENTS = 240;
/** Leaf/petal cards one growth may emit (each is 2 double-faced tris). */
export const MAX_GROWTH_LEAVES = 320;
export const MAX_GROWTH_FRUITS = 48;

export const GROWTH_TYPES: readonly GrowthType[] = ["shoot", "fruit", "root"];
export const GROWTH_ATTACH: readonly GrowthAttach[] = ["head", "body"];
export const GROWTH_PLACEMENTS: readonly GrowthPlacement[] = ["bilateral", "radial"];
export const FRUIT_PLACEMENTS: readonly FruitPlacement[] = ["along", "terminal"];
/** Rings lofted along a fruit body (mesh smoothness of a berry/banana). */
export const FRUIT_BODY_RINGS = 7;

// ── Ranges (single source of truth: clamp, validate, lab sliders) ───────

export const GROWTH_RANGES: RangesOf<GrowthBlueprint> = {
  station: { min: 0, max: 1 },
  phi: { min: 0, max: 1 },
  count: { min: 1, max: 6, int: true },
  spread: { min: 0, max: 1.4 },
  seed: { min: 0, max: 2147483647, int: true, step: 1 },
  fruitDensity: { min: 0, max: 2 },
};

export const GROWTH_STEM_RANGES: RangesOf<GrowthStemBlueprint> = {
  lengthFrac: { min: 0.05, max: 150, step: 0.05 },
  girth: { min: 0.005, max: 0.2 },
  segments: { min: 2, max: 12, int: true },
  taper: { min: 0.02, max: 1 },
  lean: { min: -1.4, max: 1.4 },
  waviness: { min: 0, max: 1 },
  flatten: { min: 0, max: 1 },
  lobes: { min: 0, max: 12, int: true },
  curl: { min: -14, max: 14, step: 0.1 },
  twist: { min: -14, max: 14, step: 0.1 },
  gravitropism: { min: -1, max: 1 },
  hardness: { min: 0, max: 1 },
  rootFlare: { min: 1, max: 3 },
};

export const GROWTH_BRANCHING_RANGES: RangesOf<GrowthBranchingBlueprint> = {
  levels: { min: 0, max: 4, int: true },
  branchStart: { min: 0, max: 0.95 },
  nodes: { min: 1, max: 6, int: true },
  whorl: { min: 1, max: 5, int: true },
  phyllotaxis: { min: 0, max: 3.2 },
  branchAngle: { min: 0.1, max: 1.5 },
  lengthRatio: { min: 0.2, max: 0.95 },
  radiusRatio: { min: 0.2, max: 0.9 },
  jitter: { min: 0, max: 1 },
};

export const GROWTH_FOLIAGE_RANGES: RangesOf<GrowthFoliageBlueprint> = {
  leafDensity: { min: 0, max: 4 },
  leafSizeFrac: { min: 0.1, max: 2 },
  leafAspect: { min: 0.05, max: 1 },
  leafDroop: { min: -1, max: 1 },
};

export const GROWTH_FLOWER_RANGES: RangesOf<GrowthFlowerBlueprint> = {
  flowerDensity: { min: 0, max: 1 },
  petalCount: { min: 3, max: 12, int: true },
  flowerSizeFrac: { min: 0.1, max: 2 },
};

export const GROWTH_FRUIT_RANGES: RangesOf<GrowthFruitBlueprint> = {
  sizeM: { min: 0.005, max: 0.6, step: 0.005 },
  aspect: { min: 0.25, max: 6 },
  bulge: { min: 0.15, max: 0.85 },
  neck: { min: 0, max: 0.9 },
  tipTaper: { min: 0, max: 1 },
  curvature: { min: -2, max: 2, step: 0.02 },
  lobes: { min: 0, max: 12, int: true },
  stemFrac: { min: 0, max: 2 },
  crownLeaves: { min: 0, max: 16, int: true },
  crownSize: { min: 0.1, max: 2 },
  calyxLeaves: { min: 0, max: 10, int: true },
};

// ── Default ──────────────────────────────────────────────────────────────
// A modest leafy shrub-branch: exercises branching + foliage so the lab
// section shows something alive the moment a growth is added.

export function defaultGrowth(): GrowthBlueprint {
  return {
    type: "shoot",
    attach: "body",
    station: 0.5,
    phi: 1,
    placement: "bilateral",
    count: 1,
    spread: 0.3,
    seed: 1,
    stem: {
      lengthFrac: 0.6,
      girth: 0.04,
      segments: 5,
      taper: 0.35,
      lean: 0.25,
      waviness: 0.25,
      flatten: 0,
      lobes: 0,
      curl: 0.4,
      twist: 0,
      gravitropism: 0.3,
      hardness: 0.8,
      rootFlare: 1.15,
    },
    branching: {
      levels: 2,
      branchStart: 0.35,
      nodes: 3,
      whorl: 2,
      phyllotaxis: 2.4,
      branchAngle: 0.7,
      lengthRatio: 0.55,
      radiusRatio: 0.55,
      jitter: 0.35,
    },
    foliage: {
      leafDensity: 1.5,
      leafSizeFrac: 0.5,
      leafAspect: 0.45,
      leafDroop: 0.2,
      leafColor: "#4a7a3a",
    },
    flowers: { flowerDensity: 0, petalCount: 5, flowerSizeFrac: 0.4, flowerColor: "#e8d26a" },
    fruit: {
      sizeM: 0.04, aspect: 1, bulge: 0.5, neck: 0, tipTaper: 0, curvature: 0,
      lobes: 0, stemFrac: 0.5, crownLeaves: 0, crownSize: 0.5, calyxLeaves: 0, color: "#b5402f",
    },
    fruitDensity: 0,
    fruitPlacement: "terminal",
  };
}

// ── Clamp / validate helpers (local copies — leaf module, no runtime
// import from blueprint.ts, which imports us) ───────────────────────────────

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampSection<T extends object>(
  input: unknown,
  ranges: Record<string, FieldRange>,
  defaults: T,
): T {
  const src = isRecord(input) ? input : {};
  const defs = defaults as unknown as Record<string, number>;
  const out = { ...defs };
  for (const [key, range] of Object.entries(ranges)) {
    const raw = src[key];
    let v = typeof raw === "number" && Number.isFinite(raw) ? raw : defs[key];
    v = Math.min(range.max, Math.max(range.min, v));
    if (range.int) v = Math.round(v);
    out[key] = v;
  }
  return out as unknown as T;
}

function clampColor(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX_COLOR.test(v) ? v.toLowerCase() : fallback;
}

function checkNumbers(
  obj: Record<string, unknown>,
  ranges: Record<string, FieldRange>,
  path: string,
  errors: string[],
): void {
  for (const [key, range] of Object.entries(ranges)) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${path}.${key}: expected a finite number, got ${JSON.stringify(v)}`);
      continue;
    }
    if (v < range.min || v > range.max) {
      errors.push(`${path}.${key}: ${v} outside [${range.min}, ${range.max}]`);
    }
    if (range.int && !Number.isInteger(v)) {
      errors.push(`${path}.${key}: ${v} must be an integer`);
    }
  }
}

/** Coerce ANY value into a valid GrowthBlueprint (the growths-array analog of
 *  clampBlueprint's per-section behavior). clampGrowth(clampGrowth(x)) ===
 *  clampGrowth(x). */
export function clampGrowth(value: unknown): GrowthBlueprint {
  const d = defaultGrowth();
  const g = isRecord(value) ? value : {};
  const top = clampSection(g, GROWTH_RANGES as unknown as Record<string, FieldRange>, {
    station: d.station,
    phi: d.phi,
    count: d.count,
    spread: d.spread,
    seed: d.seed,
    fruitDensity: d.fruitDensity,
  });
  const foliageIn = isRecord(g.foliage) ? g.foliage : {};
  const flowersIn = isRecord(g.flowers) ? g.flowers : {};
  const fruitIn = isRecord(g.fruit) ? g.fruit : {};
  return {
    ...top,
    type: GROWTH_TYPES.includes(g.type as GrowthType) ? (g.type as GrowthType) : d.type,
    attach: GROWTH_ATTACH.includes(g.attach as GrowthAttach) ? (g.attach as GrowthAttach) : d.attach,
    placement: GROWTH_PLACEMENTS.includes(g.placement as GrowthPlacement)
      ? (g.placement as GrowthPlacement)
      : d.placement,
    fruitPlacement: FRUIT_PLACEMENTS.includes(g.fruitPlacement as FruitPlacement)
      ? (g.fruitPlacement as FruitPlacement)
      : d.fruitPlacement,
    stem: clampSection(g.stem, GROWTH_STEM_RANGES as unknown as Record<string, FieldRange>, d.stem),
    branching: clampSection(
      g.branching,
      GROWTH_BRANCHING_RANGES as unknown as Record<string, FieldRange>,
      d.branching,
    ),
    foliage: {
      ...clampSection(g.foliage, GROWTH_FOLIAGE_RANGES as unknown as Record<string, FieldRange>, d.foliage),
      leafColor: clampColor(foliageIn.leafColor, d.foliage.leafColor),
    },
    flowers: {
      ...clampSection(g.flowers, GROWTH_FLOWER_RANGES as unknown as Record<string, FieldRange>, d.flowers),
      flowerColor: clampColor(flowersIn.flowerColor, d.flowers.flowerColor),
    },
    fruit: {
      ...clampSection(g.fruit, GROWTH_FRUIT_RANGES as unknown as Record<string, FieldRange>, d.fruit),
      color: clampColor(fruitIn.color, d.fruit.color),
    },
  };
}

/** Structural validation errors for one growths[] entry (appended to the
 *  blueprint's error list by validateBlueprint). Empty = valid. */
export function growthValidationErrors(value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${path}: not an object`];
  if (!GROWTH_TYPES.includes(value.type as GrowthType)) {
    errors.push(`${path}.type: expected one of ${GROWTH_TYPES.join("/")}, got ${JSON.stringify(value.type)}`);
  }
  if (!GROWTH_ATTACH.includes(value.attach as GrowthAttach)) {
    errors.push(`${path}.attach: expected one of ${GROWTH_ATTACH.join("/")}, got ${JSON.stringify(value.attach)}`);
  }
  if (!GROWTH_PLACEMENTS.includes(value.placement as GrowthPlacement)) {
    errors.push(`${path}.placement: expected one of ${GROWTH_PLACEMENTS.join("/")}, got ${JSON.stringify(value.placement)}`);
  }
  if (!FRUIT_PLACEMENTS.includes(value.fruitPlacement as FruitPlacement)) {
    errors.push(`${path}.fruitPlacement: expected one of ${FRUIT_PLACEMENTS.join("/")}, got ${JSON.stringify(value.fruitPlacement)}`);
  }
  checkNumbers(value, GROWTH_RANGES as unknown as Record<string, FieldRange>, path, errors);
  const sections: Array<[string, Record<string, FieldRange>]> = [
    ["stem", GROWTH_STEM_RANGES as unknown as Record<string, FieldRange>],
    ["branching", GROWTH_BRANCHING_RANGES as unknown as Record<string, FieldRange>],
    ["foliage", GROWTH_FOLIAGE_RANGES as unknown as Record<string, FieldRange>],
    ["flowers", GROWTH_FLOWER_RANGES as unknown as Record<string, FieldRange>],
    ["fruit", GROWTH_FRUIT_RANGES as unknown as Record<string, FieldRange>],
  ];
  for (const [name, ranges] of sections) {
    const section = value[name];
    if (!isRecord(section)) {
      errors.push(`${path}.${name}: missing or not an object`);
      continue;
    }
    checkNumbers(section, ranges, `${path}.${name}`, errors);
  }
  const colorFields: Array<[string, string]> = [
    ["foliage", "leafColor"],
    ["flowers", "flowerColor"],
    ["fruit", "color"],
  ];
  for (const [section, key] of colorFields) {
    const sec = value[section];
    if (!isRecord(sec)) continue;
    const v = sec[key];
    if (typeof v !== "string" || !HEX_COLOR.test(v)) {
      errors.push(`${path}.${section}.${key}: expected "#rrggbb", got ${JSON.stringify(v)}`);
    }
  }
  return errors;
}

// ── AGE — plants grow like plants ────────────────────────────────────────
//
// ⚖️ GROWTH IS AN AGE FUNCTION ON THE BLUEPRINT, NEVER A UNIFORM SCALE OF
// THE ADULT MESH (user 2026-09-06, verbatim: *"ideally they should grow in
// the manner of real plants - starting as a shoot and then branching out"*
// — and *"just scaling them would be the simple approach"* is the thing
// that ruling rejects). `stem.lengthFrac` ALONE would be exactly that
// scale: `curvature = curl/stemLen`, `radius0 = girth*stemLen` and every
// tropism is an angle, so halving `lengthFrac` reproduces the same tree at
// half size. Age therefore moves the STRUCTURE too — how many branch
// levels exist, where on the parent they start, how leafy they are, how
// stout the trunk is relative to its own height.
//
// 🎁 WHY PRUNING LEVELS IS A PRUNE AND NOT A RE-ROLL. Every stochastic
// choice in this module hashes on (seed, NODE PATH) — never a sequential
// stream — and a child's path is `${parent.path}.${j*whorl+k}`, which
// mentions `levels` nowhere. Lower `branching.levels` and the branches that
// remain are bit-for-bit the SAME branches the adult grows: a sapling is
// the oak's own first branches, not a different small tree. Foliage follows
// for free — `leafLevel = levels===0 ? 0 : max(1, levels-1)` (emitBranch),
// so a 0-level shoot wears its leaves on its stem, a 1-level young tree on
// its only branches, and a 3-level adult in its crown.
//
// 🚨 `age === 1` (and anything ≥ 1, and NaN) RETURNS `g` ITSELF — the same
// object reference, not a lerp that lands on 1. A mature plant is therefore
// byte-identical to every plant drawn before ageing existed, which is the
// only reason this can land without moving a single existing pin.
//
// THE AGE IS THE SIM'S, NOT THE RENDER'S: `growthAgeOf(species, sizeClass)`
// (products.ts) is the one owner of "how old is this tree"; this function
// only draws what it is told (the LOD-per-camera law — a sim entity must
// never depend on the viewer). The `yieldMul` ladder is NOT this curve.

/** Stem length at age 0, as a fraction of the adult's — a SHOOT (the oak's
 *  23.8 m body ⇒ 0.27 m), never a vanished plant. */
export const AGE_SHOOT_HEIGHT = 0.015;
/** Height ∝ age^p. Calibrated on the oak's own 40-year ladder — three
 *  classes ⇒ ages 0 / 0.5 / 1 (`growthAgeOf`, products.ts) ⇒ 1.5 % / 36 % /
 *  100 % of the adult's stem, which builds as bodies 0.27 m / 8.6 m /
 *  23.8 m tall: the three rungs the sim can actually stand read apart at a
 *  glance — shoot / young tree / adult. A REAL tree's height curve
 *  decelerates (p < 1), which would put `young` at ~15 m and make two of
 *  the three rungs the same picture; the deceleration is expressed here by
 *  the BRANCH LEVELS saturating at age 0.75 instead — a nearly-mature tree
 *  has its final crown structure and is still putting on height. */
export const AGE_HEIGHT_POWER = 1.5;
/** Leaves per segment at age 0, as a fraction of the adult's. A seedling is
 *  sparse — but a BARE shoot reads as a STICK, which is the whole failure
 *  this round exists to avoid, so it never reaches zero: an oak shoot keeps
 *  ~6 leaves on its 6 segments, which is what an oak seedling is. */
export const AGE_LEAF_DENSITY_AT_0 = 0.35;
/** 🚨 LEAF SIZE GOES THE OTHER WAY, AND MEASUREMENT IS WHY. `leafSizeFrac`
 *  is leaf length / SEGMENT length — a RATIO, exactly like `girth`, so
 *  leaving it alone already shrinks a seedling's leaves 60× with its
 *  segments. Scaling the ratio DOWN as well (the obvious reading of "a
 *  shoot has small leaves") measured as a bare vertical stick: crown width
 *  / height 0.18 at age 0, leaf area 0.07 × H². A real seedling's leaves
 *  are nearly full size on a tiny stem — proportionally HUGE — so the ratio
 *  rises as the plant gets younger and the shoot reads as a sprout. The
 *  absolute leaves still shrink with the plant; only the proportion moves.
 *  The lift falls off as (1−age)², so it is spent almost entirely on the
 *  leafless-looking end and a half-grown tree wears the adult's own
 *  foliage proportions (measured in the lab: at age 1.9 flat, a young
 *  oak's leaf cards were twice as coarse relative to it as the adult's). */
export const AGE_LEAF_SIZE_AT_0 = 1.9;
/** How far a shoot's first branches move toward the tip: age 0 sits this
 *  fraction of the way from the adult's `branchStart` to the 0.95 ceiling
 *  (a shoot branches LATE — its crown is a tuft at the growing tip, which
 *  is also what separates a young tree from a bush at a glance). Never
 *  below the adult's own value, never above the range's ceiling. */
export const AGE_BRANCH_START_LIFT = 0.7;
/** Age at which a plant begins to flower/fruit, ramping to full by 1. A
 *  sapling bearing apples is the same lie as a 24 m seedling; the sim
 *  already agrees (a class-0 oak's `yieldMul` is 0). */
export const AGE_REPRODUCTIVE_START = 0.6;

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);

/** Stem length at `age` as a fraction of the adult's. Monotone, 0 ⇒
 *  AGE_SHOOT_HEIGHT, 1 ⇒ 1. Also the driver for girth and root flare, so
 *  the whole habit answers to ONE curve. */
export function growthHeightFactor(age: number): number {
  const a = clamp01(age);
  return AGE_SHOOT_HEIGHT + (1 - AGE_SHOOT_HEIGHT) * Math.pow(a, AGE_HEIGHT_POWER);
}

/** Branch levels REACHED at `age` out of an adult's `levels`. Level k
 *  unlocks at age k/(levels+1) — the last rung lands with life to spare so
 *  a nearly-mature tree is already full-crowned and `age = 1` is a step
 *  onto nothing. For an oak (levels 3) that is 0 / .25 / .5 / .75, which is
 *  the oak's own class ladder: sapling ⇒ a 0-level shoot, young ⇒ 1 level,
 *  mature ⇒ all 3. An unbranched blueprint (grass blade, cow horn) has no
 *  ladder to climb and stays at 0. */
export function growthLevelsAt(levels: number, age: number): number {
  const L = Math.max(0, Math.round(levels));
  if (L <= 0) return 0;
  return Math.min(L, Math.floor(clamp01(age) * (L + 1)));
}

/**
 * The blueprint this growth was at `age` ∈ [0, 1] — 0 a shoot, 1 the
 * authored adult. PURE and deterministic: no RNG, no time, no world; the
 * same (g, age) always yields the same numbers, and the SEED is untouched,
 * so every branch keeps its identity as the plant grows into it.
 *
 * The allometry, all of it derived from `growthHeightFactor` so nothing can
 * drift out of step:
 *  - `branching.levels` — steps (see growthLevelsAt). The structural knob.
 *  - `stem.lengthFrac` — × the height factor.
 *  - `stem.girth` — × √(height factor). Girth is a RATIO (radius / own
 *    length), so leaving it alone is ISOMETRIC growth and a sapling comes
 *    out as stout as an oak. Elastic similarity (McMahon) has diameter ∝
 *    height^1.5, i.e. the ratio ∝ √height — a young tree is SLENDER, and
 *    grows stout as it ages.
 *  - `stem.rootFlare` — the buttress is a consequence of size; a seedling
 *    has none (1 = no flare).
 *  - `stem.hardness` — 0 is green/fleshy, 1 is wood. A shoot is green and
 *    lignifies with age; this is what stops a young tree reading as a bare
 *    brown stick.
 *  - `branching.branchStart` — high (near the tip) when young, falling to
 *    the authored value.
 *  - `foliage.leafDensity` — fewer leaves young (never none).
 *  - `foliage.leafSizeFrac` — a RATIO to the segment, so it RISES as the
 *    plant gets younger; the leaves still shrink with the plant, but a
 *    seedling's are proportionally large, which is what stops a shoot
 *    measuring as a bare stick (crown width / height 0.37 instead of 0.18).
 *  - `flowers.flowerDensity` / `fruitDensity` — nothing until maturity.
 * Everything else — segments, taper, curl/twist (TOTALS over the stem, so
 * the habit is preserved at every size), lean, waviness, nodes, whorl,
 * phyllotaxis, ratios, jitter, colors, the fruit BODY — is age-invariant by
 * construction. A `fruit`/`root` growth (the growth IS one determinate
 * body) only ages its pedicel: fruit size is phenology, not age.
 *
 * The result is clamped into GROWTH_*_RANGES with the same `clampSection`
 * the authored path uses, so an aged blueprint is a legal blueprint and
 * `growthValidationErrors` on it is empty.
 */
export function ageGrowth(g: GrowthBlueprint, age: number): GrowthBlueprint {
  // ≥ 1 (and NaN, and +∞) ⇒ THE ADULT ITSELF. Same reference, no copy.
  if (!(age < 1)) return g;
  const a = clamp01(age);
  const h = growthHeightFactor(a);
  const bs = g.branching.branchStart;
  const repro = clamp01((a - AGE_REPRODUCTIVE_START) / (1 - AGE_REPRODUCTIVE_START));
  const stem = clampSection(
    {
      ...g.stem,
      lengthFrac: g.stem.lengthFrac * h,
      girth: g.stem.girth * Math.sqrt(h),
      rootFlare: 1 + (g.stem.rootFlare - 1) * h,
      hardness: g.stem.hardness * Math.sqrt(a),
    },
    GROWTH_STEM_RANGES as unknown as Record<string, FieldRange>,
    g.stem,
  );
  const branching = clampSection(
    {
      ...g.branching,
      levels: growthLevelsAt(g.branching.levels, a),
      branchStart: bs + (0.95 - bs) * AGE_BRANCH_START_LIFT * (1 - a),
    },
    GROWTH_BRANCHING_RANGES as unknown as Record<string, FieldRange>,
    g.branching,
  );
  const foliage = clampSection(
    {
      ...g.foliage,
      leafDensity: g.foliage.leafDensity * (AGE_LEAF_DENSITY_AT_0 + (1 - AGE_LEAF_DENSITY_AT_0) * a),
      leafSizeFrac: g.foliage.leafSizeFrac * (1 + (AGE_LEAF_SIZE_AT_0 - 1) * (1 - a) * (1 - a)),
    },
    GROWTH_FOLIAGE_RANGES as unknown as Record<string, FieldRange>,
    g.foliage,
  );
  const flowers = clampSection(
    { ...g.flowers, flowerDensity: g.flowers.flowerDensity * repro },
    GROWTH_FLOWER_RANGES as unknown as Record<string, FieldRange>,
    g.flowers,
  );
  return {
    ...g,
    fruitDensity: Math.max(0, g.fruitDensity * repro),
    stem,
    branching,
    foliage: { ...foliage, leafColor: g.foliage.leafColor },
    flowers: { ...flowers, flowerColor: g.flowers.flowerColor },
  };
}

/** `ageGrowth` over every growth a blueprint-shaped object carries — the
 *  call the render seams make (`{ ...bp, growths: … }`). Structurally typed
 *  so growth.ts stays a leaf module; returns `bp` ITSELF at age ≥ 1, so an
 *  adult body is not even a fresh object. */
export function ageGrowths<T extends { growths: GrowthBlueprint[] }>(bp: T, age: number): T {
  if (!(age < 1)) return bp;
  return { ...bp, growths: bp.growths.map((g) => ageGrowth(g, age)) };
}

/** The floor `blueprint.ts`'s `SPINE_RANGES.torsoLengthM.min` puts under a
 *  torso, repeated here because growth.ts is a LEAF (blueprint.ts imports
 *  THIS module, so the range table cannot be imported back). The two are
 *  pinned equal by `plant-growth-stage.test.ts`; the compensation below
 *  measures the shrink it ACTUALLY achieved, so a clamped torso still
 *  yields the exact stem length rather than a silently taller plant. */
export const AGE_TORSO_MIN_M = 0.01;

/**
 * ⚖️ THE PLANT BODY at `age` — `ageGrowths` plus the NUB.
 *
 * `plantBlueprint` stands every plant on a "near-invisible" 0.1 m torso nub
 * and makes the stem a RATIO of it (`stemLen = stem.lengthFrac × torsoLengthM`,
 * skeleton.ts). `ageGrowths` alone therefore shrinks the STEM and leaves the
 * nub at its adult 0.1 m — which on a 0.36 m oak shoot is a brown spindle
 * taking up a third of the plant (PART 1's defect 2, seen in the lab).
 *
 * The fix is not a second height owner: it MOVES the one height factor
 * (`growthHeightFactor`) off the ratio and onto the thing the ratio
 * multiplies. The torso shrinks by `h`; each stem's `lengthFrac` is divided
 * by the shrink that was actually achieved (the torso floor above can bite on
 * a very young plant), so `lengthFrac × torsoLengthM` — and therefore every
 * absolute length, radius, curl and leaf in the generated structure — is
 * IDENTICAL to what `ageGrowths` alone produces. Only the nub moves.
 *
 * `age ≥ 1` ⇒ `bp` ITSELF, exactly like `ageGrowths`: the adult body is not
 * even a fresh object, so a mature bake is byte-identical to one built before
 * ageing existed. Structurally typed, so growth.ts stays a leaf.
 */
export function agePlantBody<T extends {
  growths: GrowthBlueprint[];
  spine: { torsoLengthM: number };
}>(bp: T, age: number): T {
  if (!(age < 1)) return bp;
  const torso = bp.spine.torsoLengthM;
  const shrunk = Math.max(AGE_TORSO_MIN_M, torso * growthHeightFactor(age));
  // What the torso ACTUALLY lost (1 when there is nothing to divide by).
  const back = torso > 0 && shrunk > 0 ? torso / shrunk : 1;
  const lr = GROWTH_STEM_RANGES.lengthFrac;
  const aged = ageGrowths(bp, age);
  return {
    ...aged,
    spine: { ...bp.spine, torsoLengthM: shrunk },
    growths: aged.growths.map((g) => ({
      ...g,
      stem: {
        ...g.stem,
        lengthFrac: Math.min(lr.max, Math.max(lr.min, g.stem.lengthFrac * back)),
      },
    })),
  };
}

// ── Deterministic per-node hash RNG ──────────────────────────────────────
// Every stochastic choice is hash(seed, nodePath, channel) — a pure
// function of the node's position in the tree (the scatter.ts hashCell
// pattern). Structure is therefore identical at every budget and for
// every traversal order; no sequential stream to desynchronize.

function hashU32(seed: number, path: string, channel: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < path.length; i++) {
    h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ channel, 0x01000193) >>> 0;
  // final avalanche (fmix32)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash → [0, 1). */
const h01 = (seed: number, path: string, channel: number): number =>
  hashU32(seed, path, channel) / 4294967296;

/** Hash → [-1, 1). */
const h11 = (seed: number, path: string, channel: number): number =>
  h01(seed, path, channel) * 2 - 1;

// ── Structure output ─────────────────────────────────────────────────────
// Growth-local frame: origin at the attach point, +Y along the attach
// (outward surface) normal, +Z the local "forward" that `lean` tilts
// toward. The caller (skeleton pass 7.7) rotates/mirrors instances into
// creature space; bilateral L copies mirror across X, which also flips
// the twist chirality — exactly what paired horns need.

export interface GrowthSegment {
  a: GVec3;
  b: GVec3;
  radiusA: number;
  radiusB: number;
  /** Branch recursion level, 0 = stem. */
  level: number;
  /** Index (into segments) of the segment this one continues or sprouts
   *  from; -1 for the stem base. Lets the mesh sink child root rings into
   *  the parent, and LOD cluster branches. */
  parent: number;
  /** 0 round loft .. 1 flat blade (≥ ~0.7 renders as a ribbon). */
  flatten: number;
  /** Cross-section ribs (cactus); 0 = round. */
  lobes: number;
}

export interface GrowthLeaf {
  /** Card base (where it meets the branch). */
  pos: GVec3;
  /** Unit direction along the blade/petal. */
  dir: GVec3;
  /** Unit facing normal of the card. */
  normal: GVec3;
  lengthM: number;
  widthM: number;
  kind: "leaf" | "petal";
}

/** A fruit body as a short PROFILED AXIS — a list of rings (base → tip)
 *  along a possibly-curved centerline, rendered by the same lofter as a
 *  stem. Crown/calyx leaves are emitted separately into `leaves`. */
export interface GrowthFruitInstance {
  /** Rings base (stem end) → tip along the body's centerline. */
  rings: Array<{ center: GVec3; radius: number }>;
  /** Unit long-axis direction (base → tip) for cap placement / framing. */
  axis: GVec3;
  /** Cross-section ribs (pumpkin); 0 = round. */
  lobes: number;
}

export interface GrowthStructure {
  segments: GrowthSegment[];
  leaves: GrowthLeaf[];
  fruits: GrowthFruitInstance[];
  /** Level-0 stem length, meters (reference for consumers). */
  lengthM: number;
}

// ── Generator ────────────────────────────────────────────────────────────

/** One branch awaiting expansion. Created deterministically from its
 *  parent's geometry; whether it EMITS depends only on the budget. */
interface PendingBranch {
  path: string;
  level: number;
  base: GVec3;
  dir: GVec3;
  /** Frame normal ⊥ dir — the direction curl bends toward; twist rotates
   *  it around dir (transported frame: this is what makes helixes). */
  normal: GVec3;
  lengthM: number;
  radius0: number;
  segCount: number;
  /** Index of the parent segment at the sprout point (-1 for the stem). */
  parentSeg: number;
}

/** Priority: coarse-to-fine — level asc, thickest first, path tiebreak.
 *  Total order (path is unique), so emission order is deterministic. */
function branchBefore(a: PendingBranch, b: PendingBranch): boolean {
  if (a.level !== b.level) return a.level < b.level;
  if (a.radius0 !== b.radius0) return a.radius0 > b.radius0;
  return a.path < b.path;
}

/**
 * Generate one growth's structure in its local frame.
 *
 * @param g          a CLAMPED GrowthBlueprint
 * @param torsoLengthM the owning creature's torso length (stem.lengthFrac
 *                   reference); plants standardize a ~0.25 m nub
 * @param budget     max segments to emit. THE PREFIX GUARANTEE:
 *                   generateGrowth(g, T, n).segments equals the first n of
 *                   generateGrowth(g, T, m).segments for any m ≥ n.
 *                   Leaves/fruits ride their segment and are prefix-stable
 *                   per emitted segment, but coarse LODs should replace
 *                   them wholesale (canopy blobs) rather than rely on that.
 */
export function generateGrowth(
  g: GrowthBlueprint,
  torsoLengthM: number,
  budget: number = MAX_GROWTH_SEGMENTS,
): GrowthStructure {
  const stemLen = g.stem.lengthFrac * torsoLengthM;
  const segments: GrowthSegment[] = [];
  const leaves: GrowthLeaf[] = [];
  const fruits: GrowthFruitInstance[] = [];
  const out: GrowthStructure = { segments, leaves, fruits, lengthM: stemLen };
  if (budget <= 0 || stemLen <= 0) return out;

  // Fruit / root types: the growth IS one determinate fruit body. A short
  // pedicel stem lifts it off the surface (fruit) or is skipped (root grows
  // straight down into the ground). Branching and along/terminal fruit
  // placement don't apply — there is exactly one body.
  if (g.type === "fruit" || g.type === "root") {
    buildSample(g, stemLen, out, g.seed >>> 0);
    return out;
  }

  // Constant material curvature/torsion (rad per meter) shared by every
  // branch — blueprint totals are expressed over the stem length.
  const curvature = g.stem.curl / stemLen;
  const torsion = g.stem.twist / stemLen;
  const seed = g.seed >>> 0;

  // Root branch: +Y tilted toward +Z by lean.
  const leanDir = normalize(v3(0, Math.cos(g.stem.lean), Math.sin(g.stem.lean)));
  const rootNormal = perpTo(v3(0, 0, 1), leanDir, v3(1, 0, 0));
  const queue: PendingBranch[] = [
    {
      path: "r",
      level: 0,
      base: v3(0, 0, 0),
      dir: leanDir,
      normal: rootNormal,
      lengthM: stemLen,
      radius0: g.stem.girth * stemLen,
      segCount: g.stem.segments,
      parentSeg: -1,
    },
  ];

  let remaining = Math.min(budget, MAX_GROWTH_SEGMENTS);

  while (queue.length > 0 && remaining > 0) {
    // Extract the highest-priority branch (queue stays small — pops are
    // budget-capped — so a linear scan is simpler than a heap and keeps
    // the order trivially deterministic).
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (branchBefore(queue[i], queue[best])) best = i;
    }
    const br = queue.splice(best, 1)[0];

    const emitted = emitBranch(g, br, remaining, seed, curvature, torsion, out);
    remaining -= emitted.count;

    // Children are DERIVED regardless of the budget (their geometry is a
    // pure function of the blueprint), but only enqueued off segments that
    // actually emitted — which can only differ from the full tree once
    // the budget is already exhausted, so the emission stream stays a
    // budget-independent prefix.
    if (br.level < g.branching.levels) {
      for (const child of deriveChildren(g, br, emitted, seed)) queue.push(child);
    }
  }
  return out;
}

/** Per-branch emission result (geometry the children sprout from). */
interface EmittedBranch {
  /** Segments actually emitted. */
  count: number;
  /** Index of the first emitted segment in structure.segments. */
  firstSeg: number;
  /** Per-emitted-segment frames (a, dir, normal at the segment START,
   *  plus radius at both ends) — children and foliage read these. */
  frames: Array<{ p: GVec3; dir: GVec3; normal: GVec3; rA: number; rB: number }>;
  /** Whether the branch tip was reached (terminal features live there). */
  complete: boolean;
  tip: GVec3;
  tipDir: GVec3;
}

function emitBranch(
  g: GrowthBlueprint,
  br: PendingBranch,
  budget: number,
  seed: number,
  curvature: number,
  torsion: number,
  out: GrowthStructure,
): EmittedBranch {
  const segLen = br.lengthM / br.segCount;
  const terminal = br.level >= g.branching.levels;
  // Leaves clothe the OUTER TWO levels (full density on terminal, half on
  // the one below): deep trees rarely fit their whole terminal level in
  // the segment budget, and a canopy must not depend on that (the rule is
  // blueprint-static, so the budget-prefix property survives).
  const leafLevel = g.branching.levels === 0 ? 0 : Math.max(1, g.branching.levels - 1);
  const leafy = br.level >= leafLevel;
  const leafScale = terminal ? 1 : 0.5;
  const emitCount = Math.min(br.segCount, budget);
  const res: EmittedBranch = {
    count: emitCount,
    firstSeg: out.segments.length,
    frames: [],
    complete: emitCount === br.segCount,
    tip: br.base,
    tipDir: br.dir,
  };

  let p = br.base;
  let dir = br.dir;
  let normal = br.normal;
  let prevIdx = br.parentSeg;
  const gravityTarget = v3(0, g.stem.gravitropism >= 0 ? 1 : -1, 0);
  // Total tropism authority over one branch, radians.
  const tropism = Math.abs(g.stem.gravitropism) * 1.5;

  for (let i = 0; i < emitCount; i++) {
    const t0 = i / br.segCount;
    const t1 = (i + 1) / br.segCount;

    // Transported frame: curvature bends dir toward `normal` (rotation
    // around the binormal), torsion rolls `normal` around dir. Constant
    // curvature+torsion integrates to a helix — the horn spiral.
    const binormal = normalize(cross(dir, normal));
    const bend = curvature * segLen;
    if (bend !== 0) {
      dir = rotate(dir, binormal, bend);
      normal = rotate(normal, binormal, bend);
    }
    if (torsion !== 0) normal = rotate(normal, dir, torsion * segLen);

    // Gravitropism: ease dir toward straight up/down, capped per segment.
    if (tropism > 0) {
      const axis = cross(dir, gravityTarget);
      const axisLen = length(axis);
      if (axisLen > 1e-6) {
        const angleTo = Math.asin(Math.min(1, axisLen));
        const step = Math.min(angleTo, tropism / br.segCount);
        dir = rotate(dir, scale(axis, 1 / axisLen), step);
        normal = perpTo(normal, dir, binormal);
      }
    }

    // Waviness: deterministic per-segment wobble.
    if (g.stem.waviness > 0) {
      const az = h01(seed, br.path, i * 4 + 1) * Math.PI * 2;
      const amp = g.stem.waviness * 0.35 * h01(seed, br.path, i * 4 + 2);
      const wobbleAxis = normalize(
        add(scale(normal, Math.cos(az)), scale(normalize(cross(dir, normal)), Math.sin(az))),
      );
      dir = rotate(dir, wobbleAxis, amp);
      normal = perpTo(normal, dir, wobbleAxis);
    }

    const rA = branchRadius(g, br, t0);
    const rB = branchRadius(g, br, t1);
    const b = add(p, scale(dir, segLen));
    const idx = out.segments.length;
    out.segments.push({
      a: p,
      b,
      radiusA: rA,
      radiusB: rB,
      level: br.level,
      parent: prevIdx,
      flatten: g.stem.flatten,
      lobes: br.level === 0 ? g.stem.lobes : 0,
    });
    res.frames.push({ p, dir, normal, rA, rB });

    // Foliage + along-fruits ride their segment (emitted with it, so the
    // caps and the budget truncate them consistently).
    if (leafy) emitLeaves(g, br, i, p, dir, normal, segLen, leafScale, seed, out);
    if (terminal && g.fruitPlacement === "along" && g.fruitDensity > 0) {
      emitFruit(g, br, `${br.path}f${i}`, lerpV(p, b, h01(seed, br.path, i * 4 + 3)), dir, seed, out);
    }

    prevIdx = idx;
    p = b;
  }

  res.tip = p;
  res.tipDir = dir;

  // Terminal-tip features only exist when the tip itself was emitted.
  if (terminal && res.complete) {
    if (g.flowers.flowerDensity > 0 && h01(seed, br.path, 90) < g.flowers.flowerDensity) {
      emitFlower(g, br, p, dir, normal, segLen, seed, out);
    }
    if (g.fruitPlacement === "terminal" && g.fruitDensity > 0 && h01(seed, br.path, 91) < Math.min(1, g.fruitDensity)) {
      emitFruit(g, br, `${br.path}ft`, p, dir, seed, out);
    }
  }
  return res;
}

/** Radius along a branch: base→tip taper, plus the root flare on the
 *  bottom of the level-0 stem. */
function branchRadius(g: GrowthBlueprint, br: PendingBranch, t: number): number {
  let r = br.radius0 * lerp(1, g.stem.taper, t);
  if (br.level === 0 && g.stem.rootFlare > 1) {
    const f = Math.max(0, 1 - t / 0.12);
    r *= 1 + (g.stem.rootFlare - 1) * f * f;
  }
  return r;
}

/** Derive the child branches sprouting from an emitted branch. Geometry is
 *  a pure function of (blueprint, parent path) — budget only decides whether
 *  a sprout point's segment was emitted at all. */
function deriveChildren(
  g: GrowthBlueprint,
  br: PendingBranch,
  emitted: EmittedBranch,
  seed: number,
): PendingBranch[] {
  const children: PendingBranch[] = [];
  const b = g.branching;
  const segLen = br.lengthM / br.segCount;
  const span = 0.95 - b.branchStart;
  for (let j = 0; j < b.nodes; j++) {
    // Node position along the parent (jittered, deterministic).
    const tj =
      b.branchStart +
      span * ((j + 0.5) / b.nodes + h11(seed, br.path, 200 + j) * (b.jitter * 0.3 / b.nodes));
    const t = Math.min(0.95, Math.max(b.branchStart, tj));
    const segIdx = Math.min(br.segCount - 1, Math.floor(t * br.segCount));
    if (segIdx >= emitted.frames.length) continue; // beyond the emitted prefix (budget already 0)
    const fr = emitted.frames[segIdx];
    const along = t * br.segCount - segIdx;
    const base = add(fr.p, scale(fr.dir, along * segLen));
    const parentR = lerp(fr.rA, fr.rB, along);

    for (let k = 0; k < b.whorl; k++) {
      const path = `${br.path}.${j * b.whorl + k}`;
      const az =
        j * b.phyllotaxis +
        (k * Math.PI * 2) / b.whorl +
        h11(seed, path, 1) * b.jitter * 0.9;
      const binormal = normalize(cross(fr.dir, fr.normal));
      const radial = normalize(add(scale(fr.normal, Math.cos(az)), scale(binormal, Math.sin(az))));
      const angle = b.branchAngle * (1 + h11(seed, path, 2) * b.jitter * 0.4);
      const childDir = normalize(
        add(scale(fr.dir, Math.cos(angle)), scale(radial, Math.sin(angle))),
      );
      // Mild built-in crown taper: branches near the parent tip run shorter.
      const lengthM =
        br.lengthM *
        b.lengthRatio *
        (1 - 0.25 * t) *
        (1 + h11(seed, path, 3) * b.jitter * 0.35);
      const radius0 = Math.min(parentR, parentR * b.radiusRatio * (1 + h11(seed, path, 4) * b.jitter * 0.25));
      if (lengthM < 1e-4 || radius0 < 2.5e-4) continue; // too small to ever matter
      children.push({
        path,
        level: br.level + 1,
        base,
        dir: childDir,
        normal: perpTo(fr.dir, childDir, radial),
        lengthM,
        radius0,
        segCount: Math.max(2, Math.round(br.segCount * b.lengthRatio)),
        parentSeg: emitted.firstSeg + segIdx,
      });
    }
  }
  return children;
}

function emitLeaves(
  g: GrowthBlueprint,
  br: PendingBranch,
  segIdx: number,
  p: GVec3,
  dir: GVec3,
  normal: GVec3,
  segLen: number,
  densityScale: number,
  seed: number,
  out: GrowthStructure,
): void {
  const f = g.foliage;
  const density = f.leafDensity * densityScale;
  if (density <= 0) return;
  const whole = Math.floor(density);
  const extra = h01(seed, br.path, segIdx * 8 + 100) < density - whole ? 1 : 0;
  const n = whole + extra;
  const binormal = normalize(cross(dir, normal));
  for (let i = 0; i < n && out.leaves.length < MAX_GROWTH_LEAVES; i++) {
    const ch = segIdx * 8 + 110 + i;
    const along = h01(seed, br.path, ch) * segLen;
    const az = h01(seed, br.path, ch + 1) * Math.PI * 2;
    const radial = normalize(add(scale(normal, Math.cos(az)), scale(binormal, Math.sin(az))));
    // Blade points outward, pitched up/down by droop.
    let leafDir = normalize(add(radial, scale(dir, 0.35)));
    const droopAxis = normalize(cross(leafDir, v3(0, 1, 0)));
    if (length(cross(leafDir, v3(0, 1, 0))) > 1e-6) {
      leafDir = rotate(leafDir, droopAxis, -f.leafDroop * 1.1);
    }
    const lengthM = f.leafSizeFrac * segLen;
    out.leaves.push({
      pos: add(p, scale(dir, along)),
      dir: leafDir,
      normal: perpTo(radial, leafDir, normal),
      lengthM,
      widthM: lengthM * f.leafAspect,
      kind: "leaf",
    });
  }
}

function emitFlower(
  g: GrowthBlueprint,
  br: PendingBranch,
  tip: GVec3,
  tipDir: GVec3,
  normal: GVec3,
  segLen: number,
  seed: number,
  out: GrowthStructure,
): void {
  const fl = g.flowers;
  const petalLen = fl.flowerSizeFrac * segLen;
  const binormal = normalize(cross(tipDir, normal));
  for (let k = 0; k < fl.petalCount && out.leaves.length < MAX_GROWTH_LEAVES; k++) {
    const az = (k * Math.PI * 2) / fl.petalCount + h01(seed, br.path, 300) * 0.5;
    const radial = normalize(add(scale(normal, Math.cos(az)), scale(binormal, Math.sin(az))));
    // Petals fan out from the tip, tilted ~65° off the branch axis.
    const dir = normalize(add(scale(tipDir, Math.cos(1.15)), scale(radial, Math.sin(1.15))));
    out.leaves.push({
      pos: tip,
      dir,
      normal: perpTo(tipDir, dir, radial),
      lengthM: petalLen,
      widthM: petalLen * 0.6,
      kind: "petal",
    });
  }
}

// ── Fruit bodies (shared profiled-axis primitive) ───────────────────────
// A fruit body is a short determinate axis: rings of a profiled radius
// swept along a (possibly curved) centerline, exactly like a stem run.
// The SAME primitive is a berry, banana, pear, pumpkin, mushroom cap, or
// (pointing down) a carrot — the shape lives entirely in the profile +
// curvature + lobes, so one renderer covers the whole market catalogue.

/** Radius multiplier along a fruit body, base (t=0, stem end) → tip
 *  (t=1): 1 at the `bulge` station, easing to `baseW` (= 1-neck) at the
 *  base and `tipW` (= 1-tipTaper) at the tip via smoothstep. */
function axisProfileR(t: number, bulge: number, baseW: number, tipW: number): number {
  const smooth = (u: number): number => {
    const c = Math.min(1, Math.max(0, u));
    return c * c * (3 - 2 * c);
  };
  if (t <= bulge) {
    const u = bulge > 1e-4 ? t / bulge : 1;
    return baseW + (1 - baseW) * smooth(u);
  }
  const u = bulge < 1 - 1e-4 ? (t - bulge) / (1 - bulge) : 1;
  return 1 + (tipW - 1) * smooth(u);
}

/** Build one fruit body's rings + crown/calyx leaves into `out`. The body
 *  starts at `attach`, runs along `dir0`, and bends by the fruit's
 *  `curvature` (transported frame, like a stem). Returns nothing — pushes
 *  a GrowthFruitInstance and any crown/calyx leaves. `sizeM` is the
 *  absolute equatorial DIAMETER; length = sizeM × aspect. */
function buildFruitBody(
  fr: GrowthFruitBlueprint,
  attach: GVec3,
  dir0: GVec3,
  out: GrowthStructure,
): GrowthFruitInstance | null {
  if (out.fruits.length >= MAX_GROWTH_FRUITS) return null;
  const equR = fr.sizeM * 0.5;
  const fullLen = fr.sizeM * fr.aspect;
  if (equR <= 0 || fullLen <= 0) return null;
  const baseW = 1 - fr.neck;
  const tipW = 1 - fr.tipTaper;
  const rings: Array<{ center: GVec3; radius: number }> = [];
  const n = FRUIT_BODY_RINGS;
  // The mesh closes each pole with a SHALLOW dome (not a full hemisphere),
  // so the body spans most of the length and `aspect` reads roughly as
  // length : width — a squat pumpkin stays squat.
  const segLen = fullLen / (n - 1);
  const curvePer = fr.curvature / (n - 1);

  let dir = normalize(dir0);
  let normal = perpTo(v3(0, 0, 1), dir, v3(1, 0, 0));
  let p = attach;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    rings.push({ center: p, radius: Math.max(1e-4, equR * axisProfileR(t, fr.bulge, baseW, tipW)) });
    if (i < n - 1) {
      const binormal = normalize(cross(dir, normal));
      if (curvePer !== 0) {
        dir = rotate(dir, binormal, curvePer);
        normal = perpTo(normal, dir, binormal);
      }
      p = add(p, scale(dir, segLen));
    }
  }
  const axis = normalize(add(scale(dir0, 0.0001), v3(
    rings[n - 1].center.x - rings[0].center.x,
    rings[n - 1].center.y - rings[0].center.y,
    rings[n - 1].center.z - rings[0].center.z,
  )));
  const inst: GrowthFruitInstance = { rings, axis, lobes: Math.round(fr.lobes) };
  out.fruits.push(inst);

  // Crown = leaves fanned from the TIP pole (pineapple, carrot top when
  // the body points down). Calyx = leaves at the BASE/stem pole
  // (strawberry hull, tomato). Both reuse the leaf-card primitive and are
  // tinted foliage.leafColor by the mesh (a leaf is a leaf).
  emitPoleLeaves(fr.crownLeaves, rings[n - 1].center, dir, rings[n - 1].radius, fr, out);
  emitPoleLeaves(fr.calyxLeaves, rings[0].center, scale(normalize(dir0), -1), rings[0].radius, fr, out);
  return inst;
}

/** Fan `count` leaf cards out of a fruit pole along `outDir`. */
function emitPoleLeaves(
  count: number,
  center: GVec3,
  outDir: GVec3,
  poleR: number,
  fr: GrowthFruitBlueprint,
  out: GrowthStructure,
): void {
  const n = Math.round(count);
  if (n <= 0) return;
  const bodyLen = fr.sizeM * fr.aspect;
  const leafLen = fr.crownSize * bodyLen;
  if (leafLen <= 0) return;
  const dir = normalize(outDir);
  const side = perpTo(v3(1, 0, 0), dir, v3(0, 0, 1));
  const binormal = normalize(cross(dir, side));
  for (let k = 0; k < n && out.leaves.length < MAX_GROWTH_LEAVES; k++) {
    const az = (k * Math.PI * 2) / n;
    const radial = normalize(add(scale(side, Math.cos(az)), scale(binormal, Math.sin(az))));
    // Crown leaves stand up and out ~35° off the pole axis (a rosette).
    const leafDir = normalize(add(scale(dir, Math.cos(0.6)), scale(radial, Math.sin(0.6))));
    out.leaves.push({
      pos: add(center, scale(radial, poleR * 0.5)),
      dir: leafDir,
      normal: perpTo(radial, leafDir, dir),
      lengthM: leafLen,
      widthM: leafLen * 0.28,
      kind: "leaf",
    });
  }
}

/** A `fruit`/`root` growth: one determinate fruit body. `fruit` lifts off
 *  the surface on a short pedicel and points up (hanging by stemFrac);
 *  `root` grows straight down into the ground with its leafy crown up. */
function buildSample(g: GrowthBlueprint, stemLen: number, out: GrowthStructure, seed: number): void {
  const fr = g.fruit;
  const bodyLen = fr.sizeM * fr.aspect;
  if (g.type === "root") {
    // Storage organ hangs DOWN from the attach point; the calyx leaves
    // (leafy top) sit at the base pole, at ground level, pointing up.
    buildFruitBody(fr, v3(0, 0, 0), v3(0, -1, 0), out);
    // A leafy top: if the author didn't set calyx leaves, sprout a few
    // from the foliage density so a bare root still reads as a vegetable.
    if (fr.calyxLeaves === 0 && g.foliage.leafDensity > 0) {
      emitPoleLeaves(Math.round(2 + g.foliage.leafDensity), v3(0, 0, 0), v3(0, 1, 0), fr.sizeM * 0.5, fr, out);
    }
    return;
  }
  // fruit: a short pedicel stem lifts the body; the body then hangs or
  // stands per stemFrac (0 sessile/up, 1 dangling down).
  const pedicelLen = Math.min(stemLen, bodyLen * 0.6);
  const up = v3(0, 1, 0);
  if (pedicelLen > 1e-4) {
    const rBase = Math.max(1e-4, g.stem.girth * Math.max(stemLen, bodyLen));
    out.segments.push({
      a: v3(0, 0, 0), b: scale(up, pedicelLen),
      radiusA: rBase, radiusB: rBase * 0.8,
      level: 0, parent: -1, flatten: 0, lobes: 0,
    });
  }
  const bodyDir = towardDown(up, fr.stemFrac);
  buildFruitBody(fr, scale(up, pedicelLen), bodyDir, out);
  void seed;
}

/** Standalone fruit body (market item): one fruit built at the origin,
 *  base pole down, growing up +Y. Used by mesh.buildFruitMesh. */
export function standaloneFruitStructure(fr: GrowthFruitBlueprint): GrowthStructure {
  const out: GrowthStructure = { segments: [], leaves: [], fruits: [], lengthM: fr.sizeM * fr.aspect };
  buildFruitBody(fr, v3(0, 0, 0), v3(0, 1, 0), out);
  return out;
}

function emitFruit(
  g: GrowthBlueprint,
  br: PendingBranch,
  path: string,
  attach: GVec3,
  branchDir: GVec3,
  seed: number,
  out: GrowthStructure,
): void {
  if (out.fruits.length >= MAX_GROWTH_FRUITS) return;
  if (g.fruitPlacement === "along") {
    // Density is EXPECTED fruits per segment; roll per call.
    if (h01(seed, path, 1) >= Math.min(1, g.fruitDensity)) return;
  }
  const fr = g.fruit;
  const bodyLen = fr.sizeM * fr.aspect;
  if (bodyLen <= 0) return;
  // stemFrac doubles as the hang dial: 0 = sessile, aligned with the
  // branch (mushroom cap); > 0 = droops toward the ground (apple).
  const dir = towardDown(branchDir, fr.stemFrac);
  const drop = fr.stemFrac * fr.sizeM;
  buildFruitBody(fr, add(attach, scale(dir, drop)), dir, out);
}
