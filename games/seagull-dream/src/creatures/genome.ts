// Creature genome — the stable interchange format of the creature system.
//
// PURE MATH. No three.js, no DOM — node-testable, and importable by the
// server later (the description→genome AI pipeline emits this shape).
//
// Design rules (see instructions/creatures.md):
// - Plain JSON-serializable object. Field names are human-meaningful and
//   "describable" so an LLM prompt maps naturally onto them.
// - Phase transitions, not parts: everything grows from a metameric
//   spine; a wing IS a leg with high `membrane`; a fin is a wing used in
//   water. No field ever selects a discrete body-part model.
// - Producers (seeded phylogeny, AI description, lab sliders) all emit
//   this type; everything downstream (skeleton → mesh → animation) may
//   assume a genome that passed `validateGenome` after `clampGenome`.
//
// Conventions: lengths in meters or as fractions of a named reference,
// angles in radians, colors as "#rrggbb". `*Frac` fields are fractions
// of the reference named in their comment.

// ── Types ────────────────────────────────────────────────────────────────

/** The trunk — the metameric chain everything else grows from. */
export interface SpineGenome {
  /** Lofted segments along the torso. More = smoother bending (later,
   *  animation) at slightly more verts/bones. */
  torsoSegments: number;
  /** Trunk length, chest to hip, in meters. The main size knob — most
   *  other lengths are fractions of this. */
  torsoLengthM: number;
  /** Max torso radius as a fraction of torso length. 0.08 = slender
   *  (snake/heron), 0.3 = plump (seal/grub). */
  girth: number;
  /** Station (0 front .. 1 rear) of maximum girth. Front-heavy chest
   *  vs rear-heavy grazer. */
  girthPeak: number;
  /** How sharply the radius shrinks toward the chest end (0 blunt,
   *  1 needle). */
  frontTaper: number;
  /** Same toward the hip end. */
  rearTaper: number;
  /** Cross-section width:height ratio of the body. 1 = round, > 1 =
   *  wide & flat / dorsoventrally compressed (ray, flatworm, crab,
   *  trilobite, dimetrodon), < 1 = tall & narrow / laterally compressed
   *  (fish). Applied to the torso and tail, eased back to round across
   *  the neck so the head stays a bulb. */
  crossSection: number;
  /** Radius control points along the trunk, multiplying the smooth
   *  taper to carve distinct body sections (tagmata): a wasp/ant waist,
   *  a spider abdomen, an insect thorax, a lobster cephalothorax. Empty
   *  = a single smooth body. Order doesn't matter (sorted on clamp). */
  profile: ProfilePoint[];
}

/** One radius control point along the trunk (see SpineGenome.profile). */
export interface ProfilePoint {
  /** Station along the trunk, 0 (chest/front) .. 1 (hip/rear). */
  at: number;
  /** Radius multiplier at this station (1 = unchanged by the profile). */
  scale: number;
}

/** Neck = thin spine extension toward the head. 0 segments = head sits
 *  directly on the torso. */
export interface NeckGenome {
  segments: number;
  /** Neck length / torso length. */
  lengthFrac: number;
  /** Neck radius / max torso radius. */
  radiusFrac: number;
  /** Total upward arc of the rest pose, radians. Negative = hanging. */
  lift: number;
}

/** Tail = spine extension past the hip. 0 segments = none. */
export interface TailGenome {
  segments: number;
  /** Tail length / torso length. */
  lengthFrac: number;
  /** Tail base radius / max torso radius (tip always tapers to ~0). */
  radiusFrac: number;
  /** Total downward arc of the rest pose, radians. Negative = raised. */
  droop: number;
}

/** The sensory cluster at the spine's front end. */
export interface HeadGenome {
  /** Head radius / max torso radius. */
  sizeFrac: number;
  /** 0 = fleshy muzzle blended into the skin, 1 = hard rigid beak. */
  beak: number;
  /** Beak/muzzle length / head radius. */
  snoutLengthFrac: number;
  /** Eye PAIRS (0..3). Eyes are rigid details on the head. */
  eyePairs: number;
  /** Eye radius / head radius. */
  eyeSizeFrac: number;
  /** Placement angle around the head from straight-forward, radians.
   *  Small = predator front-facing, large = prey side-facing. */
  eyeAngle: number;
}

// Limb model — see instructions/creatures.md. ONE kind of limb: a leg.
// There is NO function/end-effector enum. A limb's role emerges from its
// shape, position, and the current posture:
//   - a WING / FLIPPER is a leg with high `membrane`;
//   - an ARM is a leg too short to reach the ground at the current
//     `bodyHeight`, so it lifts off and hangs;
//   - a HOOF / HAND / CLAW is digit variation (count + differentiation +
//     opposition + curl), the same way leg rows vary.
// Leg LENGTH is fixed; it constrains the achievable body postures rather
// than being stretched to fit (see PostureGenome.bodyHeight).

/** How a limb type's copies are arranged around the body. */
export type LimbPlacement =
  | "bilateral" // mirrored L/R; each `count` is one pair (the default)
  | "radial"; // `count` spokes evenly around the vertical axis (radial body)

export interface LimbGroupGenome {
  placement: LimbPlacement;
  /** Copies of this type: bilateral → rows (each an L/R pair); radial →
   *  spokes around the body. */
  count: number;
  /** Station of the first copy, 0 (chest) .. 1 (hip). For radial, all
   *  copies sit at this station. */
  stationStart: number;
  /** Station of the last copy (bilateral, count > 1); copies spread
   *  evenly across [start, end]. */
  stationEnd: number;
  /** Copy fraction (0 first .. 1 last) where limbs are LARGEST — lets a
   *  row gravitate big-at-front / middle / back. */
  sizePeak: number;
  /** Size gravitation: 0 = all copies equal, 1 = the farthest from the
   *  peak shrinks to nearly nothing. */
  sizeContrast: number;
  /** Length / torso length. FIXED — does not stretch to the ground. The
   *  limb is always a 3-section chain (femur / tibia / foot); the math
   *  models 3 degrees of freedom, not a variable joint count (extra
   *  arthropod joints are a rendering detail, not more DOF). */
  lengthFrac: number;
  /** Base radius / max torso radius. */
  radiusFrac: number;
  /** Tip radius / base radius. */
  taper: number;
  /** 0 = round limb .. 1 = flattened, widened web (wing / flipper). */
  membrane: number;
  /** MOUNT POSITION around the body cross-section: 0 = ventral midline
   *  (under the belly), 0.5 = lateral (the side), 1 = dorsal midline (the
   *  back). This is only WHERE the limb roots — its hip point, and whether
   *  it can plausibly reach the ground at all (a dorsally-mounted limb is a
   *  wing, not a leg). Where the limb AIMS when relaxed is separate (the
   *  three rest DOF below), so a mantis can mount low — and so reach the
   *  ground — yet hold its forearms raised. */
  attachHeight: number;
  // ── Rest pose — the three limb degrees of freedom ────────────────────
  // A limb is a 3-section chain (femur / tibia / foot) posed like a real
  // one by three rotations. These are the NEUTRAL (relaxed, unloaded)
  // values: the gait modulates protraction on top, and a weight-bearing
  // limb depresses + extends away from neutral until its foot finds the
  // ground. An un-recruited limb simply holds these three angles.
  /** Protraction / retraction — fore/aft swing: -1 = swept fully rearward,
   *  +1 = forward, 0 = straight out. (The gait's stride rides on top.) */
  restProtraction: number;
  /** Levation / depression — how high the limb is carried: -1 = depressed
   *  (hangs straight down, the mammal tuck), 0 = out to the side (reptile
   *  sprawl), +1 = levated (raised up — a wing, a mantis forearm). Also
   *  sets how wide the foot plants and how high the knee arches. */
  restLevation: number;
  /** Knee REST flexion — how folded the knee sits when relaxed, signed so
   *  the fold direction is explicit: 0 = extended (straight); + folds one
   *  way (forward / elbow), - the other (rearward / knee). A weight-bearing
   *  knee deviates from this toward the range limit to reach the ground, but
   *  keeps this sign for which way it bows. */
  restFlexion: number;
  /** Knee RANGE — how far the knee can travel from rest before the joint
   *  locks (the anatomical limit), as a fraction of the full fold. 1 = free,
   *  0 = rigid at its rest angle. Separate from rest: a knee can rest
   *  extended yet still flex deeply under load. */
  flexRange: number;
  /** Long-axis TWIST of the limb (pronation), radians of rotation applied
   *  progressively to each joint's bend plane down the chain. 0 = all three
   *  sections fold in one plane; non-zero spirals them (a crab claw whose
   *  femur swings out, tibia forward, foot in). */
  legTwist: number;
  /** Femur ↔ tibia length split: 0 = even (the two upper sections equal),
   *  -1 = long femur / short shank, +1 = short femur / long shank. Moves
   *  where the knee/elbow sits along the limb (a long shank reads as a
   *  cursorial leaper; the foot, the 3rd section, is sized separately by
   *  footLengthFrac). Doesn't change reach — the foot lands the same. */
  legBalance: number;
  // ── Ankle (3rd joint) + foot (3rd section); digits ride on it ────────
  /** Foot (3rd section) length / leg length. 0 = the limb tip is the foot. */
  footLengthFrac: number;
  /** Ankle REST pitch — where the foot joint sits when relaxed: 0 =
   *  plantigrade (sole flat), 0.5 = digitigrade (up on the ball), 1 =
   *  unguligrade (on the tip / hoof). This is the joint's NEUTRAL; a planted
   *  foot deviates from it toward the range limit as posture demands — a
   *  body held high rides up onto the tip, a low one settles flat — so the
   *  actual stance emerges rather than being dialled in. (Named `stance`
   *  still; it is now the ankle rest, not the outcome.) */
  stance: number;
  /** Ankle RANGE — how far the foot joint can pitch from its rest before it
   *  locks, as a fraction. 1 = free to rise onto the tip under load, 0 =
   *  rigid at its rest pitch. */
  ankleRange: number;
  /** Digits on the foot. 1 = a single peg/hoof. */
  toeCount: number;
  /** Digit length / foot length. */
  toeLengthFrac: number;
  /** Total fan angle across the digits, radians. */
  toeSpread: number;
  /** Digit size gravitation: 0 = all equal, 1 = outer digits shrink to
   *  nothing (the same mechanism as leg-row `sizeContrast`). */
  toeContrast: number;
  /** Opposition: 0 = all digits parallel (paw), 1 = the end digit fully
   *  opposes the rest (thumb / pincer). */
  opposition: number;
  /** Digit curl: 0 = flat on the ground, 1 = curled under (claw / grip). */
  toeCurl: number;
}

// Flexible chains — see instructions/creatures.md. ONE primitive for
// every thin, tapering, jointless, wave-animated appendage: antennae,
// tentacles, trunk, proboscis, tongue, eyestalks, an anglerfish lure, a
// scorpion-like stinger arm. They attach to the head or the body, place
// bilaterally or as a radial crown, and curl at rest; the gait layer
// (phase 2) animates them with traveling waves. Unlike legs they are
// never ground-solved and never lift the body.

/** Where a flexible chain roots. */
export type ChainAttach = "head" | "body";
/** Terminal feature at a chain's tip. */
export type ChainTip = "none" | "club" | "eye" | "stinger";

export interface FlexChainGenome {
  /** Root: the head bulb, or the trunk at `station`. */
  attach: ChainAttach;
  /** Station along the trunk if attach = "body" (0 front .. 1 rear). */
  station: number;
  /** How many chains this entry spawns. */
  count: number;
  /** true = spaced evenly around 360° (tentacle crown / anemone);
   *  false = bilateral (mirrored L/R pairs; count 1 = a single midline
   *  chain like a trunk or tongue). */
  radial: boolean;
  /** Chain segments — many = smooth curl/wave. */
  segments: number;
  /** Length / torso length. */
  lengthFrac: number;
  /** Base radius / max torso radius (the tip tapers from here). */
  radiusFrac: number;
  /** Tip radius / base radius. */
  taper: number;
  /** Rest aim, vertical: -1 hangs straight down, 0 straight out,
   *  +1 points up. */
  aim: number;
  /** Lateral spread from forward/centerline (bilateral) or outward
   *  splay from the body axis (radial), radians. */
  spread: number;
  /** Rest curl: total bend along the chain, radians (droops/sweeps the
   *  chain in its vertical plane). */
  curl: number;
  /** Terminal feature: none, a swollen club, an eye (eyestalk), or a
   *  hard stinger cone. */
  tip: ChainTip;
}

// Midline membranes — see instructions/creatures.md. A web of skin
// running along the body's dorsal or ventral midline, rising to a height
// profile. ONE primitive for the dorsal fin, anal fin, dimetrodon sail,
// and (a dorsal + a ventral panel over the tail) a caudal fin. The OTHER
// membrane topology — spanning a limb — already lives on a limb's
// `membrane` field; this is the midline one.

/** Which midline a membrane runs along. */
export type MembraneEdge = "dorsal" | "ventral";

export interface MembraneGenome {
  edge: MembraneEdge;
  /** Body-arc span the web covers: 0 = tail tip .. 1 = chest (front of
   *  the torso). `start` < `end`. */
  start: number;
  end: number;
  /** Peak height out from the body surface / torso length. */
  height: number;
  /** Where along [start, end] the height peaks (0 = start .. 1 = end). */
  heightPeak: number;
  /** Stiffening rays (0 = smooth sheet; > 0 scallops the outer edge like
   *  a finrayed fish fin / dimetrodon sail). */
  rays: number;
}

export interface SkinGenome {
  /** Main body color, "#rrggbb". */
  baseColor: string;
  /** Underside color (blended below the spine midline). */
  bellyColor: string;
  /** Beak / claws / horn color. */
  accentColor: string;
}

export interface PostureGenome {
  /** Rest pitch of the torso axis, radians. 0 = horizontal,
   *  positive = chest raised (penguin-ward). */
  bodyPitch: number;
  /** How high the body rides, 0 = slung low (legs folded/sprawled) ..
   *  1 = raised high (legs straight). The TALLEST leg sets the ceiling;
   *  legs too short to reach the ground at this height lift off and hang
   *  (becoming arms). Leg length is fixed, so this is what makes a body
   *  bipedal, sprawled, or upright. */
  bodyHeight: number;
}

export interface Genome {
  /** Format version — bump on breaking shape changes. */
  version: 1;
  /** Optional display name (species name, or the description's noun). */
  name?: string;
  spine: SpineGenome;
  neck: NeckGenome;
  tail: TailGenome;
  head: HeadGenome;
  /** 0..MAX_LIMB_GROUPS limb TYPES. Every limb is a leg; role emerges
   *  from shape/position/posture (a wing is a membranous leg, an arm is a
   *  leg that can't reach the ground at the current bodyHeight). */
  limbGroups: LimbGroupGenome[];
  /** 0..MAX_CHAINS flexible chains (antennae, tentacles, trunk, …). */
  chains: FlexChainGenome[];
  /** 0..MAX_MEMBRANES midline webs (dorsal/anal/caudal fin, sail). */
  membranes: MembraneGenome[];
  skin: SkinGenome;
  posture: PostureGenome;
}

/** Total limb TYPES one creature can carry. Few, by design — real
 *  animals reuse one leg structure with variation, not many distinct
 *  types (a wing is just a membranous leg). */
export const MAX_LIMB_GROUPS = 5;
/** Copies (rows or radial spokes) one limb type can be duplicated into. */
export const MAX_LIMB_COUNT = 8;
export const LIMB_PLACEMENTS: readonly LimbPlacement[] = ["bilateral", "radial"];
/** Distinct flexible-chain entries one creature can carry (each may
 *  spawn several chains via `count`). */
export const MAX_CHAINS = 4;
/** Chains a single entry can spawn (a full tentacle crown). */
export const MAX_CHAIN_COUNT = 12;
export const CHAIN_ATTACH: readonly ChainAttach[] = ["head", "body"];
export const CHAIN_TIPS: readonly ChainTip[] = ["none", "club", "eye", "stinger"];
export const MAX_MEMBRANES = 4;
export const MEMBRANE_EDGES: readonly MembraneEdge[] = ["dorsal", "ventral"];
/** Trunk profile control points one body can carve. */
export const MAX_PROFILE_POINTS = 8;
export const PROFILE_POINT_RANGES: RangesOf<ProfilePoint> = {
  at: { min: 0, max: 1 },
  scale: { min: 0.15, max: 3 },
};

// ── Ranges ───────────────────────────────────────────────────────────────
// Single source of truth for every numeric field: clampGenome enforces
// them, validateGenome checks them, and the lab generates its sliders
// from them. `int` fields are rounded by clamp.

export interface FieldRange {
  min: number;
  max: number;
  /** Round to integer on clamp. */
  int?: boolean;
  /** Suggested UI step (lab sliders); defaults to (max-min)/100 or 1. */
  step?: number;
}

// Only the numeric fields of T get a range (non-number fields — arrays,
// strings — are dropped via key remapping, not set to `never`).
type RangesOf<T> = {
  [K in keyof T as T[K] extends number ? K : never]-?: FieldRange;
};

export const SPINE_RANGES: RangesOf<SpineGenome> = {
  torsoSegments: { min: 3, max: 12, int: true },
  torsoLengthM: { min: 0.05, max: 30, step: 0.05 },
  girth: { min: 0.05, max: 0.45 },
  girthPeak: { min: 0, max: 1 },
  frontTaper: { min: 0, max: 1 },
  rearTaper: { min: 0, max: 1 },
  crossSection: { min: 0.3, max: 3, step: 0.02 },
};

export const NECK_RANGES: RangesOf<NeckGenome> = {
  segments: { min: 0, max: 8, int: true },
  lengthFrac: { min: 0, max: 2.5 },
  radiusFrac: { min: 0.1, max: 0.9 },
  lift: { min: -0.8, max: 2.2 },
};

export const TAIL_RANGES: RangesOf<TailGenome> = {
  segments: { min: 0, max: 10, int: true },
  lengthFrac: { min: 0, max: 3 },
  radiusFrac: { min: 0.05, max: 1 },
  droop: { min: -1.2, max: 1.2 },
};

export const HEAD_RANGES: RangesOf<HeadGenome> = {
  sizeFrac: { min: 0.2, max: 1.6 },
  beak: { min: 0, max: 1 },
  snoutLengthFrac: { min: 0, max: 2.5 },
  eyePairs: { min: 0, max: 3, int: true },
  eyeSizeFrac: { min: 0.05, max: 0.45 },
  eyeAngle: { min: 0.15, max: 1.5 },
};

// Only the numeric limb fields get ranges; `placement` is an enum handled
// separately in clamp/validate.
export const LIMB_GROUP_RANGES: RangesOf<LimbGroupGenome> = {
  count: { min: 1, max: MAX_LIMB_COUNT, int: true },
  stationStart: { min: 0, max: 1 },
  stationEnd: { min: 0, max: 1 },
  sizePeak: { min: 0, max: 1 },
  sizeContrast: { min: 0, max: 1 },
  lengthFrac: { min: 0.1, max: 2.5 },
  radiusFrac: { min: 0.03, max: 0.6 },
  taper: { min: 0.1, max: 1 },
  membrane: { min: 0, max: 1 },
  attachHeight: { min: 0, max: 1 },
  restProtraction: { min: -1, max: 1 },
  restLevation: { min: -1, max: 1 },
  restFlexion: { min: -1, max: 1 },
  flexRange: { min: 0, max: 1 },
  legTwist: { min: -1.5, max: 1.5, step: 0.02 },
  legBalance: { min: -1, max: 1 },
  footLengthFrac: { min: 0, max: 0.6 },
  stance: { min: 0, max: 1 },
  ankleRange: { min: 0, max: 1 },
  toeCount: { min: 1, max: 5, int: true },
  toeLengthFrac: { min: 0.2, max: 1 },
  toeSpread: { min: 0, max: 1.4 },
  toeContrast: { min: 0, max: 1 },
  opposition: { min: 0, max: 1 },
  toeCurl: { min: 0, max: 1 },
};

// Only the numeric chain fields get ranges; attach/radial/tip are
// enums/bools handled separately in clamp/validate.
export const CHAIN_RANGES: RangesOf<FlexChainGenome> = {
  station: { min: 0, max: 1 },
  count: { min: 1, max: MAX_CHAIN_COUNT, int: true },
  segments: { min: 2, max: 10, int: true },
  lengthFrac: { min: 0.05, max: 3 },
  radiusFrac: { min: 0.02, max: 0.3 },
  taper: { min: 0.05, max: 1 },
  aim: { min: -1, max: 1 },
  spread: { min: 0, max: 1.6 },
  curl: { min: -2.5, max: 2.5 },
};

// Only the numeric membrane fields get ranges; `edge` is an enum handled
// separately in clamp/validate.
export const MEMBRANE_RANGES: RangesOf<MembraneGenome> = {
  start: { min: 0, max: 1 },
  end: { min: 0, max: 1 },
  height: { min: 0, max: 1.2 },
  heightPeak: { min: 0, max: 1 },
  rays: { min: 0, max: 24, int: true },
};

export const POSTURE_RANGES: RangesOf<PostureGenome> = {
  bodyPitch: { min: -0.4, max: 1.2 },
  bodyHeight: { min: 0, max: 1 },
};

// ── Default ──────────────────────────────────────────────────────────────
// A plausible mid-size quadruped — neutral starting point for lab sliders.

export function defaultGenome(): Genome {
  return {
    version: 1,
    name: "default quadruped",
    spine: {
      torsoSegments: 6,
      torsoLengthM: 1.2,
      girth: 0.18,
      girthPeak: 0.45,
      frontTaper: 0.45,
      rearTaper: 0.55,
      crossSection: 1,
      profile: [],
    },
    neck: { segments: 3, lengthFrac: 0.45, radiusFrac: 0.5, lift: 0.9 },
    tail: { segments: 5, lengthFrac: 0.8, radiusFrac: 0.5, droop: 0.5 },
    head: {
      sizeFrac: 0.6,
      beak: 0.25,
      snoutLengthFrac: 0.8,
      eyePairs: 1,
      eyeSizeFrac: 0.22,
      eyeAngle: 0.7,
    },
    // One leg type, duplicated into a fore + hind pair — the generic
    // quadruped. Distinct fore/hind bend would be two groups.
    limbGroups: [
      {
        placement: "bilateral",
        count: 2, stationStart: 0.18, stationEnd: 0.85, sizePeak: 1, sizeContrast: 0.12,
        lengthFrac: 0.58, radiusFrac: 0.18, taper: 0.55,
        membrane: 0, attachHeight: 0.38, restProtraction: 0, restLevation: -0.45, restFlexion: -0.3,
        flexRange: 1, legTwist: 0, legBalance: 0,
        footLengthFrac: 0.22, stance: 0.4, ankleRange: 1, toeCount: 3, toeLengthFrac: 0.5, toeSpread: 0.5,
        toeContrast: 0.2, opposition: 0, toeCurl: 0.1,
      },
    ],
    chains: [],
    membranes: [],
    skin: { baseColor: "#8a7456", bellyColor: "#cdbfa3", accentColor: "#3d3528" },
    posture: { bodyPitch: 0, bodyHeight: 0.6 },
  };
}

// ── Validate ─────────────────────────────────────────────────────────────
// Structural validation: is this object SHAPED like a genome, with every
// numeric field finite and in range, colors parseable, limb count legal?
// Producers that may emit garbage (an LLM, the lab JSON box) should run
// clampGenome first; validateGenome(clampGenome(x)) only fails when x is
// structurally impossible (missing sections, wrong types), never on
// out-of-range numbers.

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateGenome(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["genome: expected an object"] };
  }
  const g = value as Record<string, unknown>;
  if (g.version !== 1) errors.push(`version: expected 1, got ${JSON.stringify(g.version)}`);
  if (g.name !== undefined && typeof g.name !== "string") {
    errors.push("name: expected a string when present");
  }

  const sections: Array<[string, Record<string, FieldRange>]> = [
    ["spine", SPINE_RANGES],
    ["neck", NECK_RANGES],
    ["tail", TAIL_RANGES],
    ["head", HEAD_RANGES],
    ["posture", POSTURE_RANGES],
  ];
  for (const [name, ranges] of sections) {
    const section = g[name];
    if (!isRecord(section)) {
      errors.push(`${name}: missing or not an object`);
      continue;
    }
    checkNumbers(section, ranges, name, errors);
  }

  // Trunk profile: optional array; each point's at/scale in range.
  if (isRecord(g.spine) && g.spine.profile !== undefined) {
    const prof = g.spine.profile;
    if (!Array.isArray(prof)) {
      errors.push("spine.profile: expected an array when present");
    } else {
      if (prof.length > MAX_PROFILE_POINTS) {
        errors.push(`spine.profile: ${prof.length} points exceeds max ${MAX_PROFILE_POINTS}`);
      }
      prof.forEach((p, i) => {
        if (!isRecord(p)) {
          errors.push(`spine.profile[${i}]: not an object`);
          return;
        }
        checkNumbers(p, PROFILE_POINT_RANGES as unknown as Record<string, FieldRange>, `spine.profile[${i}]`, errors);
      });
    }
  }

  if (!Array.isArray(g.limbGroups)) {
    errors.push("limbGroups: missing or not an array");
  } else {
    if (g.limbGroups.length > MAX_LIMB_GROUPS) {
      errors.push(`limbGroups: ${g.limbGroups.length} types exceeds max ${MAX_LIMB_GROUPS}`);
    }
    g.limbGroups.forEach((grp, i) => {
      if (!isRecord(grp)) {
        errors.push(`limbGroups[${i}]: not an object`);
        return;
      }
      if (!LIMB_PLACEMENTS.includes(grp.placement as LimbPlacement)) {
        errors.push(`limbGroups[${i}].placement: expected one of ${LIMB_PLACEMENTS.join("/")}, got ${JSON.stringify(grp.placement)}`);
      }
      checkNumbers(grp, LIMB_GROUP_RANGES as unknown as Record<string, FieldRange>, `limbGroups[${i}]`, errors);
    });
  }

  if (!Array.isArray(g.chains)) {
    errors.push("chains: missing or not an array");
  } else {
    if (g.chains.length > MAX_CHAINS) {
      errors.push(`chains: ${g.chains.length} exceeds max ${MAX_CHAINS}`);
    }
    g.chains.forEach((ch, i) => {
      if (!isRecord(ch)) {
        errors.push(`chains[${i}]: not an object`);
        return;
      }
      if (!CHAIN_ATTACH.includes(ch.attach as ChainAttach)) {
        errors.push(`chains[${i}].attach: expected one of ${CHAIN_ATTACH.join("/")}, got ${JSON.stringify(ch.attach)}`);
      }
      if (!CHAIN_TIPS.includes(ch.tip as ChainTip)) {
        errors.push(`chains[${i}].tip: expected one of ${CHAIN_TIPS.join("/")}, got ${JSON.stringify(ch.tip)}`);
      }
      if (typeof ch.radial !== "boolean") {
        errors.push(`chains[${i}].radial: expected a boolean, got ${JSON.stringify(ch.radial)}`);
      }
      checkNumbers(ch, CHAIN_RANGES as unknown as Record<string, FieldRange>, `chains[${i}]`, errors);
    });
  }

  if (!Array.isArray(g.membranes)) {
    errors.push("membranes: missing or not an array");
  } else {
    if (g.membranes.length > MAX_MEMBRANES) {
      errors.push(`membranes: ${g.membranes.length} exceeds max ${MAX_MEMBRANES}`);
    }
    g.membranes.forEach((m, i) => {
      if (!isRecord(m)) {
        errors.push(`membranes[${i}]: not an object`);
        return;
      }
      if (!MEMBRANE_EDGES.includes(m.edge as MembraneEdge)) {
        errors.push(`membranes[${i}].edge: expected one of ${MEMBRANE_EDGES.join("/")}, got ${JSON.stringify(m.edge)}`);
      }
      checkNumbers(m, MEMBRANE_RANGES as unknown as Record<string, FieldRange>, `membranes[${i}]`, errors);
    });
  }

  if (!isRecord(g.skin)) {
    errors.push("skin: missing or not an object");
  } else {
    for (const key of ["baseColor", "bellyColor", "accentColor"] as const) {
      const v = (g.skin as Record<string, unknown>)[key];
      if (typeof v !== "string" || !HEX_COLOR.test(v)) {
        errors.push(`skin.${key}: expected "#rrggbb", got ${JSON.stringify(v)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Clamp ────────────────────────────────────────────────────────────────
// Coerce ANY structurally-genome-shaped object into valid ranges: numbers
// clamped (NaN/non-number → section default), ints rounded, colors
// defaulted when unparseable, limbs truncated. Returns a NEW object; the
// input is not modified. clamp(clamp(x)) === clamp(x).

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

/** Coerce any input into a sorted, in-range, capped profile point list. */
function clampProfile(input: unknown): ProfilePoint[] {
  if (!Array.isArray(input)) return [];
  const num = (v: unknown, def: number, lo: number, hi: number): number => {
    const x = typeof v === "number" && Number.isFinite(v) ? v : def;
    return Math.min(hi, Math.max(lo, x));
  };
  const pts = input.slice(0, MAX_PROFILE_POINTS).map((p): ProfilePoint => {
    const r = isRecord(p) ? p : {};
    return {
      at: num(r.at, 0.5, PROFILE_POINT_RANGES.at.min, PROFILE_POINT_RANGES.at.max),
      scale: num(r.scale, 1, PROFILE_POINT_RANGES.scale.min, PROFILE_POINT_RANGES.scale.max),
    };
  });
  pts.sort((a, b) => a.at - b.at);
  return pts;
}

/** Default limb group used when clamp meets a non-object / empty slot. */
const LIMB_GROUP_DEFAULT: LimbGroupGenome = defaultGenome().limbGroups[0];
const CHAIN_DEFAULT: FlexChainGenome = {
  attach: "head",
  station: 0.5,
  count: 2,
  radial: false,
  segments: 6,
  lengthFrac: 0.8,
  radiusFrac: 0.05,
  taper: 0.15,
  aim: 0.4,
  spread: 0.5,
  curl: 0.6,
  tip: "none",
};
const MEMBRANE_DEFAULT: MembraneGenome = {
  edge: "dorsal",
  start: 0.35,
  end: 0.75,
  height: 0.25,
  heightPeak: 0.5,
  rays: 0,
};

export function clampGenome(value: unknown): Genome {
  const d = defaultGenome();
  const g = isRecord(value) ? value : {};

  const groupsIn = Array.isArray(g.limbGroups) ? g.limbGroups.slice(0, MAX_LIMB_GROUPS) : d.limbGroups;
  const limbGroups = groupsIn.map((grp): LimbGroupGenome => {
    const numeric = clampSection(grp, LIMB_GROUP_RANGES as unknown as Record<string, FieldRange>, LIMB_GROUP_DEFAULT);
    const rec = isRecord(grp) ? grp : {};
    const placement = LIMB_PLACEMENTS.includes(rec.placement as LimbPlacement)
      ? (rec.placement as LimbPlacement) : "bilateral";
    return { ...numeric, placement };
  });

  const chainsIn = Array.isArray(g.chains) ? g.chains.slice(0, MAX_CHAINS) : [];
  const chains = chainsIn.map((ch): FlexChainGenome => {
    const numeric = clampSection(ch, CHAIN_RANGES as unknown as Record<string, FieldRange>, CHAIN_DEFAULT);
    const rec = isRecord(ch) ? ch : {};
    return {
      ...numeric,
      attach: CHAIN_ATTACH.includes(rec.attach as ChainAttach) ? (rec.attach as ChainAttach) : "head",
      tip: CHAIN_TIPS.includes(rec.tip as ChainTip) ? (rec.tip as ChainTip) : "none",
      radial: rec.radial === true,
    };
  });

  const membranesIn = Array.isArray(g.membranes) ? g.membranes.slice(0, MAX_MEMBRANES) : [];
  const membranes = membranesIn.map((m): MembraneGenome => {
    const numeric = clampSection(m, MEMBRANE_RANGES as unknown as Record<string, FieldRange>, MEMBRANE_DEFAULT);
    const rec = isRecord(m) ? m : {};
    return {
      ...numeric,
      edge: MEMBRANE_EDGES.includes(rec.edge as MembraneEdge) ? (rec.edge as MembraneEdge) : "dorsal",
    };
  });

  const skinIn = isRecord(g.skin) ? g.skin : {};
  const spine = clampSection(g.spine, SPINE_RANGES as unknown as Record<string, FieldRange>, d.spine);
  spine.profile = clampProfile(isRecord(g.spine) ? g.spine.profile : undefined);
  return {
    version: 1,
    ...(typeof g.name === "string" ? { name: g.name } : {}),
    spine,
    neck: clampSection(g.neck, NECK_RANGES as unknown as Record<string, FieldRange>, d.neck),
    tail: clampSection(g.tail, TAIL_RANGES as unknown as Record<string, FieldRange>, d.tail),
    head: clampSection(g.head, HEAD_RANGES as unknown as Record<string, FieldRange>, d.head),
    limbGroups,
    chains,
    membranes,
    skin: {
      baseColor: clampColor(skinIn.baseColor, d.skin.baseColor),
      bellyColor: clampColor(skinIn.bellyColor, d.skin.bellyColor),
      accentColor: clampColor(skinIn.accentColor, d.skin.accentColor),
    },
    posture: clampSection(g.posture, POSTURE_RANGES as unknown as Record<string, FieldRange>, d.posture),
  };
}

// ── Random genome (seeded) ───────────────────────────────────────────────
// Deterministic producer for the lab's re-roll. Biased toward plausible
// animals rather than uniform over the full ranges — the phylogeny layer
// (phase 3) will replace this as the in-game producer.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [min, max). */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function randHexColor(rng: () => number, lightness: [number, number]): string {
  // HSL-ish: pick hue/sat/light then convert, keeps colors organic.
  const h = rng();
  const s = lerp(0.15, 0.6, rng());
  const l = lerp(lightness[0], lightness[1], rng());
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function randomGenome(seed: number): Genome {
  const rng = mulberry32(seed);

  // Size: log-uniform 0.15m .. 8m so small creatures aren't drowned out.
  const torsoLengthM = Math.exp(lerp(Math.log(0.15), Math.log(8), rng()));

  // Body archetype dials, all continuous.
  const slender = rng(); // 0 plump .. 1 snake-like
  const girth = lerp(0.32, 0.07, slender);
  // Cross-section: usually round; sometimes laterally compressed (fish)
  // or dorsoventrally flattened (ray/flatworm). Continuous either way.
  const csRoll = rng();
  const crossSection =
    csRoll < 0.65 ? 1 : csRoll < 0.83 ? lerp(0.4, 0.8, rng()) : lerp(1.4, 2.6, rng());
  // Tagmata: usually a single smooth body; sometimes a pinched waist
  // (wasp/ant) or a swollen rear (spider/abdomen).
  const profRoll = rng();
  const profile: ProfilePoint[] =
    profRoll < 0.8
      ? []
      : profRoll < 0.9
        ? [
            { at: 0.34, scale: 1 },
            { at: 0.5, scale: lerp(0.22, 0.45, rng()) },
            { at: 0.64, scale: lerp(1, 1.25, rng()) },
          ]
        : [
            { at: 0.5, scale: 1 },
            { at: 0.85, scale: lerp(1.35, 1.95, rng()) },
          ];

  // Limb plan: weighted toward a 1–2 type leg layout; sometimes wings;
  // rarely limbless (slither/swim plans).
  const planRoll = rng();
  const limbGroups: LimbGroupGenome[] = [];

  // Articulation style is shared across a creature's legs (one animal,
  // one way of standing): 0..~0.45 erect mammal, mid = reptile sprawl,
  // high = arthropod arch. Continuous — intermediates exist.
  const limbStyle = rng();
  // Legs MOUNT low-lateral regardless of style (so they can reach the
  // ground); style instead sets how the limb is CARRIED: a mammal depresses
  // its legs straight down (low levation), an arthropod levates them out
  // into a sprawl (high levation).
  const attachHeight = lerp(0.3, 0.48, limbStyle);
  const restLevation = lerp(-0.55, 0.3, limbStyle);
  // Foot stance is its own axis (bears vs dogs vs horses share erect
  // legs). Hoofward stances get fewer, tighter toes and a hoof effector.
  const stance = rng();
  const hoofward = stance > 0.75;
  const toeCount = hoofward ? 1 + Math.round(rng()) : 2 + Math.round(rng() * 2);
  const toeSpread = hoofward ? lerp(0, 0.25, rng()) : lerp(0.3, 0.9, rng());
  const manyLegged = limbStyle > 0.55 && rng() < 0.5; // arthropod-ish rows

  const legGroup = (
    count: number,
    stationStart: number,
    stationEnd: number,
    over: Partial<LimbGroupGenome> = {},
  ): LimbGroupGenome => ({
    placement: "bilateral",
    count,
    stationStart,
    stationEnd,
    sizePeak: rng() < 0.5 ? 1 : rng(), // often biggest at the rear
    sizeContrast: lerp(0, 0.4, rng()),
    lengthFrac: lerp(0.25, 0.85, rng()),
    radiusFrac: lerp(0.08, 0.28, rng()) * lerp(1, 0.5, limbStyle),
    taper: lerp(0.35, 0.75, rng()),
    membrane: rng() < 0.15 ? lerp(0.2, 0.45, rng()) : lerp(0, 0.1, rng()),
    attachHeight,
    restProtraction: lerp(-0.15, 0.15, rng()),
    restLevation,
    restFlexion: lerp(-0.6, 0.6, rng()),
    flexRange: 1,
    legTwist: rng() < 0.25 ? lerp(-0.6, 0.6, rng()) : 0,
    legBalance: lerp(-0.3, 0.5, rng()),
    footLengthFrac: lerp(0.12, 0.35, rng()),
    stance,
    ankleRange: 1,
    toeCount,
    toeLengthFrac: lerp(0.35, 0.7, rng()),
    toeSpread,
    toeContrast: lerp(0, 0.4, rng()),
    opposition: 0,
    toeCurl: lerp(0, 0.4, rng()),
    ...over,
  });
  // A wing/flipper is just a membranous forelimb (an emergent role, not a
  // type): dorsally mounted, carried up and rearward, folded — so it can't
  // bear weight and rests up and back along the body.
  const wingLimb = (station: number): LimbGroupGenome =>
    legGroup(1, station, station, {
      membrane: lerp(0.8, 1, rng()),
      lengthFrac: lerp(1.0, 1.7, rng()),
      radiusFrac: lerp(0.05, 0.09, rng()),
      taper: lerp(0.2, 0.4, rng()),
      attachHeight: lerp(0.8, 0.95, rng()),
      restProtraction: lerp(-0.7, -0.3, rng()),
      restLevation: lerp(0.6, 0.9, rng()),
      restFlexion: 0.6,
      footLengthFrac: 0,
      toeCount: 1,
    });

  let biped = false;
  if (planRoll < 0.12) {
    // limbless — slither/swim
  } else if (planRoll < 0.35) {
    // biped: one rear leg type, short or absent forelimbs (the forelimbs
    // lift off at the high body posture and read as arms/wings).
    biped = true;
    limbGroups.push(legGroup(1, lerp(0.72, 0.88, rng()), 0.86));
    if (rng() < 0.6) limbGroups.push(wingLimb(lerp(0.12, 0.25, rng())));
  } else if (planRoll < 0.85) {
    if (manyLegged) {
      // one leg type duplicated into a row of pairs (centipede-ish)
      limbGroups.push(legGroup(3 + Math.round(rng() * 3), lerp(0.1, 0.2, rng()), lerp(0.8, 0.95, rng())));
    } else if (rng() < 0.4) {
      // distinct fore + hind knee fold (two groups, opposite restFlexion)
      limbGroups.push(legGroup(1, lerp(0.1, 0.22, rng()), 0.2, { restFlexion: lerp(0.2, 0.7, rng()) }));
      limbGroups.push(legGroup(1, lerp(0.78, 0.92, rng()), 0.9, { restFlexion: lerp(-0.7, -0.2, rng()) }));
    } else {
      // one type, fore+hind rows (generic quadruped)
      limbGroups.push(legGroup(2, lerp(0.1, 0.22, rng()), lerp(0.8, 0.92, rng())));
    }
    if (rng() < 0.15) limbGroups.push(wingLimb(lerp(0.3, 0.45, rng())));
  } else {
    // hexapod: one type, three rows
    limbGroups.push(legGroup(3, lerp(0.08, 0.18, rng()), lerp(0.82, 0.95, rng())));
  }

  // Flexible chains: a pair of head antennae/feelers on some creatures
  // (more likely on arthropod-styled ones).
  const chains: FlexChainGenome[] = [];
  if (rng() < (limbStyle > 0.5 ? 0.5 : 0.18)) {
    chains.push({
      attach: "head",
      station: 0.5,
      count: 2,
      radial: false,
      segments: 5 + Math.round(rng() * 3),
      lengthFrac: lerp(0.3, 1.1, rng()),
      radiusFrac: lerp(0.02, 0.05, rng()),
      taper: lerp(0, 0.2, rng()),
      aim: lerp(0.1, 0.8, rng()),
      spread: lerp(0.2, 0.7, rng()),
      curl: lerp(-0.3, 1.2, rng()),
      tip: rng() < 0.25 ? "club" : "none",
    });
  }

  // Midline membranes: an occasional dorsal fin / ridge / sail.
  const membranes: MembraneGenome[] = [];
  if (rng() < 0.2) {
    const sail = rng() < 0.3;
    membranes.push({
      edge: "dorsal",
      start: lerp(0.3, 0.45, rng()),
      end: lerp(0.6, 0.85, rng()),
      height: sail ? lerp(0.4, 0.9, rng()) : lerp(0.1, 0.3, rng()),
      heightPeak: lerp(0.35, 0.65, rng()),
      rays: rng() < 0.5 ? Math.round(lerp(4, 14, rng())) : 0,
    });
  }

  const raw: Genome = {
    version: 1,
    spine: {
      torsoSegments: Math.round(lerp(4, 9, rng())),
      torsoLengthM,
      girth,
      girthPeak: lerp(0.25, 0.7, rng()),
      frontTaper: lerp(0.2, 0.8, rng()),
      rearTaper: lerp(0.2, 0.8, rng()),
      crossSection,
      profile,
    },
    neck: {
      segments: Math.round(lerp(0, 6, rng() * rng())),
      lengthFrac: lerp(0.15, 1.4, rng() * rng()),
      radiusFrac: lerp(0.3, 0.7, rng()),
      lift: lerp(0.2, 1.6, rng()),
    },
    tail: {
      segments: Math.round(lerp(0, 8, rng())),
      lengthFrac: lerp(0.2, 1.8, rng() * rng()),
      radiusFrac: lerp(0.2, 0.8, rng()),
      droop: lerp(-0.4, 0.9, rng()),
    },
    head: {
      sizeFrac: lerp(0.35, 0.9, rng()),
      beak: rng() < 0.4 ? lerp(0.5, 1, rng()) : lerp(0, 0.35, rng()),
      snoutLengthFrac: lerp(0.3, 1.6, rng()),
      eyePairs: 1 + (rng() < 0.12 ? 1 : 0),
      eyeSizeFrac: lerp(0.12, 0.32, rng()),
      eyeAngle: lerp(0.3, 1.2, rng()),
    },
    limbGroups,
    chains,
    membranes,
    skin: {
      baseColor: randHexColor(rng, [0.3, 0.6]),
      bellyColor: randHexColor(rng, [0.6, 0.85]),
      accentColor: randHexColor(rng, [0.1, 0.35]),
    },
    // Bipeds stand upright and ride high (so the forelimbs lift off);
    // everyone else stays nearer horizontal. Arthropod-styled bodies sit
    // lower/sprawled; mammal-styled ride higher.
    posture: {
      bodyPitch: biped ? lerp(0.6, 1.1, rng()) : lerp(-0.05, 0.2, rng()),
      bodyHeight: biped ? lerp(0.8, 1.0, rng()) : lerp(0.35, 0.8, 1 - limbStyle * 0.6),
    },
  };
  return clampGenome(raw);
}
