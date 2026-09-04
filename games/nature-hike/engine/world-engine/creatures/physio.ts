// Creature physiology — the STRESS LEDGER: what a body weighs, what each leg
// can hold, and what each leg is actually being asked to hold.
//
// PURE MATH. No three.js, no skeleton import (the bone shape is taken
// structurally, so there is no cycle) — node-testable, server-importable,
// like balance.ts / gait.ts.
//
// WHY THIS EXISTS. Posture in skeleton.ts is a COMMAND that flows downward:
// the body picks a height and a pitch, each leg tries to reach the ground,
// and a leg that cannot reach silently drops out of support at zero cost.
// Two shipped bugs are the same missing concept:
//   • the handstand — a pitched trunk lifts the hind hips out of leg reach,
//     the hind legs fold in mid-air, and the body "stands on its front legs";
//   • the cute floats — a girth-doubled belly becomes the body's floor and
//     legs that cannot reach dangle.
// Neither is visible to the engine because nothing measures LOAD. This module
// is that measurement: forces the ground must supply, strength each leg has,
// and the ratio between them. It only REPORTS — phase 1 changes no pose.
//
// UNITS. Everything geometric is in absolute meters. Mass is a VOLUME PROXY
// (density 1): a bone's mass is the volume of its truncated cone with the
// π dropped, so a "kilogram" here is π⁻¹ m³ of creature. Every other quantity
// is derived from it, so the proxy cancels wherever a ratio is taken — which
// is what a stress is. Because lengths are absolute, square-cube scaling
// falls out with no special code: mass ∝ L³, leg strength ∝ L², so stress ∝ L.
//
// Coordinates match the rest of the creature stack: +Y up, +Z forward,
// ground at y = 0; the support plane is (x, z).

/** Environment the body is standing in. `gravity` is a RELATIVE multiplier
 *  (1 = Earth) — it scales every force and therefore every stress, and
 *  nothing else. It must never move a bone. */
export interface EnvPhysics {
  gravity: number;
}

export const EARTH: EnvPhysics = { gravity: 1 };

/** A point on the ground plane. A creature-space Vec3 satisfies this. */
export interface GroundPt {
  x: number;
  z: number;
}

/** A 3D point. A creature-space Vec3 satisfies this. */
export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** The minimal shape of a bone this module needs — a truncated cone with a
 *  radius at each end. `CreatureBone` satisfies it structurally, which is why
 *  physio.ts never imports skeleton.ts. */
export interface MassBone {
  head: Pt3;
  tail: Pt3;
  radiusHead: number;
  radiusTail: number;
}

export interface MassProperties {
  /** Volume proxy Σ (r₀² + r₀r₁ + r₁²)/3 · len — the truncated-cone volume
   *  with π dropped. Density 1, so this is also the mass. */
  mass: number;
  /** Full 3D center of mass. Zero vector when the mass is zero. */
  com: Pt3;
}

// ── Real units ───────────────────────────────────────────────────────────
// 🚨 THE PROXY IS π-DROPPED CUBIC METRES, AND THAT IS THE ONLY THING BETWEEN
// THIS MODULE AND SI. A bone's proxy mass is its truncated-cone volume with
// the π left out (`boneMass`), so:
//
//     real volume (m³) = π · proxy
//     real mass   (kg) = π · proxy · ρ,     ρ in kg/m³
//
// with ρ = 1000 (water ≈ vertebrate soft tissue) as the reference. Everything
// below is stated in real units first and converted once, so a constant can be
// checked against an anatomy table without anyone having to think in proxies.

/** Density of vertebrate soft tissue, kg/m³ — water, near enough. `density`
 *  arguments in this module are RELATIVE to this. */
export const TISSUE_DENSITY_KG_M3 = 1000;

/** Standard gravity, m/s². The ledger's `gravity` is a multiple of this. */
export const G_EARTH = 9.81;

/** 🚨 ONE PROXY FORCE UNIT, IN NEWTONS = π · ρ · g ≈ 30 819 N. Every force in
 *  this module is (proxy mass × relative gravity); multiply by this to get
 *  newtons. Kept as a named constant because it is the hinge of the whole
 *  calibration below — a stress is a ratio, so it cancels out of every number
 *  the ledger reports, and appears only where a real-world quantity enters. */
export const PROXY_FORCE_N = Math.PI * TISSUE_DENSITY_KG_M3 * G_EARTH;

/** Real mass in kilograms of a proxy mass. `density` is relative to tissue
 *  (1 = flesh and water).
 *
 *  ⚖️ DENSITY IS A MASS-ONLY DIAL. It scales what a body weighs, where its CoM
 *  sits and where it lands on the Campione line — and NOTHING about what a leg
 *  can carry. That is not an omission: a pneumatised skeleton (sauropod ≈ 0.8,
 *  theropod ≈ 0.85, a modern bird 0.6–0.75) needs less leg because it weighs
 *  less, and that already falls out of the weight. Giving density a second
 *  effect on strength would count the same air twice. */
export function massKg(proxyMass: number, density = 1): number {
  return Math.PI * proxyMass * TISSUE_DENSITY_KG_M3 * density;
}

/** Inverse of `massKg` — the proxy mass of a real body. */
export function proxyMassOf(kg: number, density = 1): number {
  const d = Math.max(1e-6, density);
  return kg / (Math.PI * TISSUE_DENSITY_KG_M3 * d);
}

/** A proxy force (proxy mass × relative gravity) in newtons. */
export function forceNewtons(proxyForce: number): number {
  return proxyForce * PROXY_FORCE_N;
}

// ── The Campione & Evans line ────────────────────────────────────────────
// Campione & Evans (2012), 200 mammals + 47 non-avian reptiles from skeletons
// with known live weights:
//
//     log₁₀(mass in grams) = 2.749 · log₁₀(C) − 1.104
//
// where C is the SUMMED minimum shaft circumference of humerus + femur, in mm.
// R² = 0.988, mean prediction error ≈ 25%. Inverted, C ∝ M^0.364 — thicknesses
// are allometric while lengths stay isometric, which is the one empirical law
// this whole module is anchored to. It is the reference a body is measured
// AGAINST, never a law imposed on one: nothing here forces a limb onto the
// line, it only reports how far off it is.

export const CAMPIONE_SLOPE = 2.749;
export const CAMPIONE_INTERCEPT = -1.104;

/** Summed humerus+femur minimum shaft circumference (mm) a quadruped of this
 *  mass sits at on the line. */
export function campioneCircumferenceMm(kg: number): number {
  if (!(kg > 0)) return 0;
  return 10 ** ((Math.log10(kg * 1000) - CAMPIONE_INTERCEPT) / CAMPIONE_SLOPE);
}

/** The line read forward: what a quadruped with this summed circumference
 *  weighs, in kg. */
export function campioneMassKg(circumferenceMm: number): number {
  if (!(circumferenceMm > 0)) return 0;
  return 10 ** (CAMPIONE_SLOPE * Math.log10(circumferenceMm) + CAMPIONE_INTERCEPT) / 1000;
}

/** Radius (m) of ONE proximal limb bone on the line — half the summed
 *  circumference, over 2π. */
export function campioneBoneRadiusM(kg: number): number {
  return campioneCircumferenceMm(kg) / 2 / (2 * Math.PI) / 1000;
}

/** Radius (m) of the whole FLESH CAPSULE a line-conforming limb would have —
 *  the bone radius times the body's own bone fraction (`K_BONE` for a mammal,
 *  `K_BONE_EXO` for an arthropod). This is the number a creature's
 *  `radiusFrac × maxTorsoRadius` should be compared with.
 *
 *  ⚠️ The LINE ITSELF is a vertebrate regression and is not re-fitted for an
 *  exoskeleton: what changes is only how much capsule a line-thick load-bearing
 *  core needs around it. An arthropod's capsule is therefore ~4.7× thinner than
 *  a mammal's at the same mass, which is what a real insect leg looks like. */
export function campioneLimbRadiusM(kg: number, k = K_BONE): number {
  return Math.max(1e-6, k) * campioneBoneRadiusM(kg);
}

// ── Constants ────────────────────────────────────────────────────────────
// 🚨 DERIVED, NOT TUNED. Every number below traces to the Campione line, to a
// stated anatomical measurement, or to one design choice named out loud. None
// of them was chosen to make a body in the registry look good — the registry
// is what gets MEASURED by them.

/** 🚨 FLESH-CAPSULE RADIUS ÷ LOAD-BEARING BONE RADIUS.
 *
 *  A creature limb here is one capsule; a real limb is a thin bone inside a
 *  lot of muscle, and only the bone carries the column. The ratio comes from
 *  the notes' own sanity row, the human:
 *
 *    • femur minimum shaft circumference ≈ 85 mm → bone radius 13.5 mm
 *      (the line PREDICTS 146 mm summed against a measured ~147 — the two
 *      agree, so either may be used);
 *    • mid-thigh ≈ 150–180 mm ACROSS → flesh radius 75–90 mm, mid 82.5 mm.
 *
 *  82.5 / 13.5 = 6.1. Cross-checked on the labrador row, which was not used to
 *  fit it: the line puts a 30 kg dog's femur at 17.1 mm diameter (a real
 *  labrador femur shaft is ~17 mm) and 6.1× that is a 104 mm thigh, which is a
 *  labrador's thigh.
 *
 *  ⚠️ IT IS A MAMMAL NUMBER. An arthropod carries its skeleton on the OUTSIDE
 *  and nearly the whole capsule is structural (k ≈ 1–1.5), so this constant
 *  understates an insect limb's load-bearing area by ~k² ≈ 37×. Under the
 *  single global k every arthropod in the registry therefore reads far over
 *  capacity at ANY scale. `SkeletonPlan` below is the per-body seam that fixes
 *  it; this stays the DEFAULT, so nothing that does not opt out moves. */
export const K_BONE = 6.1;

/** 🚨 THE ARTHROPOD'S BONE FRACTION — an EXOSKELETON.
 *
 *  A locust femur is a cuticle tube of outer radius ~1.0 mm and wall ~0.1 mm;
 *  the flesh (muscle, haemolymph) is INSIDE it, not around it. So the capsule
 *  the builder draws IS very nearly the load-bearing structure, and the
 *  capsule-radius ÷ structural-radius ratio is not 6.1 but ~1.0–1.5. 1.3 is the
 *  middle: it leaves a little unsclerotised membrane at the joints, which every
 *  arthropod has.
 *
 *  It enters as k² in crushing and k⁴ in buckling, so against the mammalian
 *  6.1 an exoskeleton is (6.1/1.3)² ≈ 22× more load-bearing area and
 *  (6.1/1.3)⁴ ≈ 484× stiffer against buckling at the same drawn thickness.
 *  That is the whole of the 7 cm mantis miss — nothing else about an insect
 *  had to be special-cased.
 *
 *  ⚠️ MATERIAL IS NOT RE-DERIVED, GEOMETRY IS. Sclerotised cuticle runs
 *  E ≈ 10–20 GPa against bone's 17 and yields near 80–100 MPa against bone's
 *  ~200 — the same order, and well inside this module's honesty, while k is a
 *  factor of 4.7 in a term that is squared and to the fourth. So the seam moves
 *  k and leaves BONE_MODULUS_PA and what σ = 1 MEANS alone. */
export const K_BONE_EXO = 1.3;

/** Where a body keeps its skeleton. The one anatomical switch on a blueprint's
 *  spine, and the only thing that changes what a drawn limb is made OF. */
export type SkeletonPlan = "endo" | "exo";

/** Bone fraction k for a body plan. Default (and anything unrecognised) is the
 *  mammalian one — a body must opt OUT of vertebrate anatomy deliberately. */
export function boneFraction(plan?: SkeletonPlan): number {
  return plan === "exo" ? K_BONE_EXO : K_BONE;
}

/** 🚨 THE ONE DESIGN CHOICE. Biewener measured peak in-vivo bone stress to be
 *  size-independent at a safety factor of 2–4; 2.75 is the middle of that
 *  band. It fixes what σ = 1 MEANS: a real, line-conforming quadruped standing
 *  still reads σ = 1/2.75 ≈ 0.36, so "1.0" is the load at which a body has
 *  spent the margin a real animal keeps. */
export const SAFETY_FACTOR = 2.75;

/** Reference posture multiplier (see `emaMultiplier`). The animals the
 *  Campione line was measured on stand on BENT limbs, so the calibration point
 *  has to include a posture — a columnar-limb anchor would put every real
 *  animal over capacity the moment its own posture was measured. 2.0 is
 *  1 + 1/EMA at Biewener's EMA ≈ 0.5–0.8 for upright quadrupeds, and it is
 *  what `emaMultiplier` reads on real-proportioned upright quadrupeds
 *  (measured: dog 1.8–2.1, horse 2.2–2.5, cat 2.3–2.4, elephant 1.7–1.9). */
export const EMA_REF = 2;

/** Mass of the animal the constant is anchored on, kg, and its leg count.
 *  The labrador row: a quadruped (the line's own domain — Campione et al.
 *  2014 needed a separate factor for bipeds), and the geometric middle of the
 *  table's eight orders of magnitude. */
const REF_MASS_KG = 30;
const REF_LEGS = 4;

/** Static bone stress (Pa) of that reference animal standing still: its
 *  weight over four legs, through one line-thick bone each. ≈ 0.32 MPa. */
const REF_BONE_STRESS_PA =
  (REF_MASS_KG * G_EARTH) / REF_LEGS / (Math.PI * campioneBoneRadiusM(REF_MASS_KG) ** 2);

/** Force a leg of 1 m² FLESH cross-section can carry, in proxy-mass × g.
 *
 *  🚨 DERIVATION, END TO END. For a leg of flesh radius r carrying F newtons:
 *
 *      bone stress σ_b = F · k² / (π r²)          (bone area = π(r/k)²)
 *      ledger stress σ = F_proxy · ema / (π r² · MUSCLE_STRENGTH)
 *      F = F_proxy · PROXY_FORCE_N
 *   ⇒  σ = σ_b · ema / (k² · PROXY_FORCE_N · MUSCLE_STRENGTH)
 *
 *  Requiring the reference animal — on the line, at its real scale, in a real
 *  quadruped's posture — to read σ = 1/SAFETY_FACTOR pins the constant:
 *
 *      MUSCLE_STRENGTH = σ_b,ref · EMA_REF · SAFETY_FACTOR / (k² · PROXY_FORCE_N)
 *
 *  ≈ 1.54. (The previous value, 1.4, was fitted to the shipped dog and horse;
 *  landing within 10% of a number derived from an anatomy table is a
 *  coincidence worth naming, and no longer the reason for it.)
 *
 *  What σ = 1 IS, in real units: `boneStressPa(1)` ≈ 1.77 MPa of static
 *  compressive stress in the load-bearing bone. That is ~1% of cortical bone's
 *  ~200 MPa failure strength, and deliberately so — this is a CONFORMANCE
 *  threshold, not a fracture threshold. The gap is the dynamic factor: peak
 *  locomotor bone stress is 40–80 MPa, tens of times the standing value, and
 *  Biewener's 2–4 safety factor lives up there. A body over σ = 1 is not
 *  predicted to snap while standing; it is a body no real animal is shaped
 *  like, and it will snap the moment it moves. */
export const MUSCLE_STRENGTH =
  (REF_BONE_STRESS_PA * EMA_REF * SAFETY_FACTOR) / (K_BONE ** 2 * PROXY_FORCE_N);

/** The ledger's σ read back as real bone stress, Pa. The inverse of the
 *  derivation above, and the only honest way to check a σ against an
 *  engineering table. */
export function boneStressPa(sigma: number): number {
  return sigma * K_BONE ** 2 * PROXY_FORCE_N * MUSCLE_STRENGTH;
}

/** Bending counterpart of MUSCLE_STRENGTH: the moment a cantilever of 1 m
 *  radius can carry, in proxy-mass × g × m. A neck/tail is loaded in BENDING,
 *  not compression, so its capacity scales with r³ (section modulus), not r².
 *  Calibrated on the same two bodies' necks: dog 0.43, horse 0.36, cow 0.49,
 *  human 0.02 (an upright biped carries its head over its shoulders).
 *
 *  🚨 STILL FITTED, AND IT IS NOW THE ODD ONE OUT. Bending through the same
 *  bone core would give σ_b = 4M·k³/(π r³) against the same capacity stress,
 *  i.e. BEND_STRENGTH = π · MUSCLE_STRENGTH / (4 · K_BONE) ≈ 0.20 — fifteen
 *  times stricter than the 3 shipped here. Some of that gap is real (a neck is
 *  a chain of short vertebrae slung in muscle and nuchal ligament, not one
 *  cantilever of bone) and some of it is the old fit. It is deliberately NOT
 *  moved in this round: the crushing constant is what the round re-derived,
 *  and dropping the bending capacity 15× would re-decide every carry refusal
 *  in `canBear` at the same time. Consequence to keep in mind while reading a
 *  table: leg σ is now anchored to anatomy, neck σ is not, and the two are not
 *  yet on the same scale. */
export const BEND_STRENGTH = 3;

/** Membrane discount — a webbed limb (a wing, a fin) is mostly skin and
 *  carries proportionally less. Matches the legacy capacity term's shape in
 *  skeleton.ts so the two agree about what a wing is worth. */
const MEMBRANE_DISCOUNT = 0.7;

// ── Mass properties ──────────────────────────────────────────────────────

/** Volume proxy of one bone: a truncated cone, π dropped, density 1. */
export function boneMass(b: MassBone): number {
  const dx = b.tail.x - b.head.x;
  const dy = b.tail.y - b.head.y;
  const dz = b.tail.z - b.head.z;
  const len = Math.hypot(dx, dy, dz);
  const r0 = b.radiusHead;
  const r1 = b.radiusTail;
  return ((r0 * r0 + r0 * r1 + r1 * r1) / 3) * len;
}

/** Centroid of one bone along its own axis, at the truncated cone's exact
 *  center of volume — a tapered bone (a tail, a limb) carries its mass toward
 *  the thick end, and a whole-body CoM built from midpoints would drift. */
function boneCentroid(b: MassBone, out: Pt3): Pt3 {
  const r0 = b.radiusHead;
  const r1 = b.radiusTail;
  const denom = r0 * r0 + r0 * r1 + r1 * r1;
  const t = denom > 1e-18 ? (r0 * r0 + 2 * r0 * r1 + 3 * r1 * r1) / (4 * denom) : 0.5;
  out.x = b.head.x + (b.tail.x - b.head.x) * t;
  out.y = b.head.y + (b.tail.y - b.head.y) * t;
  out.z = b.head.z + (b.tail.z - b.head.z) * t;
  return out;
}

/** Mass + full 3D CoM over ANY set of bones.
 *
 *  🚨 This counts EVERY bone it is handed — head, neck and limbs included.
 *  The legacy `bodyMass` in skeleton.ts sums torso + tail only, which is why
 *  a long-necked or heavy-limbed body reads far too light there. Callers pick
 *  the subset (whole body, neck + head, one chain); this function never
 *  filters. */
export function massProperties(bones: Iterable<MassBone>, density = 1): MassProperties {
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const c: Pt3 = { x: 0, y: 0, z: 0 };
  for (const b of bones) {
    const m = boneMass(b);
    if (m <= 0) continue;
    boneCentroid(b, c);
    mass += m;
    cx += m * c.x;
    cy += m * c.y;
    cz += m * c.z;
  }
  if (mass <= 1e-12) return { mass: 0, com: { x: 0, y: 0, z: 0 } };
  // 🚨 DENSITY SCALES THE MASS AND LEAVES THE CoM ALONE — it is uniform over
  // the body, so it divides straight back out of the centroid. A pneumatised
  // body is lighter in exactly the place a solid one was heavy. Default 1
  // multiplies by one, so every existing caller is bit-identical.
  const com = { x: cx / mass, y: cy / mass, z: cz / mass };
  return { mass: density === 1 ? mass : mass * Math.max(0, density), com };
}

/** Mass + CoM of a set of bones in REAL units — kilograms and metres. The
 *  same walk as `massProperties`, converted once at the door, for a readout or
 *  a Campione-line comparison that has no business thinking in proxies. */
export function massPropertiesKg(bones: Iterable<MassBone>, density = 1): MassProperties {
  const p = massProperties(bones, density);
  return { mass: massKg(p.mass), com: p.com };
}

// ── Strength ─────────────────────────────────────────────────────────────

/** What a contact patch of a given AREA can carry: area × muscle constant.
 *  The one bearing law in this module — `legStrength` is this applied to a
 *  leg's circular cross-section, and the belly patch (phase 4) is this
 *  applied to the trunk's ground footprint. Keeping them one function is
 *  what makes a belly and a foot comparable at all: both are areas pressed
 *  against the same ground, and the ledger can only split load between them
 *  if it measures them the same way. */
export function contactStrength(areaM2: number, k = K_BONE): number {
  return Math.max(0, areaM2) * muscleStrengthFor(k);
}

/** 🚨 THE SEAM, CRUSHING SIDE. What σ = 1 MEANS is a fixed bone stress
 *  (`boneStressPa(1)` ≈ 1.77 MPa); what changes with the body plan is how much
 *  of the drawn capsule is carrying it. Substituting k for K_BONE in the same
 *  derivation gives MUSCLE_STRENGTH ∝ 1/k², i.e.
 *
 *      muscleStrengthFor(k) = MUSCLE_STRENGTH · (K_BONE/k)²
 *
 *  which is an identity at k = K_BONE — every mammal reads exactly what it read
 *  before the seam existed. */
export function muscleStrengthFor(k: number): number {
  const kk = Math.max(1e-6, k);
  return MUSCLE_STRENGTH * (K_BONE / kk) ** 2;
}

/** The buckling counterpart. Euler carries k⁴ (second moment of area goes as
 *  r⁴, and the structural radius is r/k), so the same substitution gives
 *  BUCKLE_STRENGTH · (K_BONE/k)⁴ — 484× for an exoskeleton, which is why a real
 *  insect can stand on legs a mammal's law calls hair-thin. */
export function buckleStrengthFor(k: number): number {
  const kk = Math.max(1e-6, k);
  return BUCKLE_STRENGTH * (K_BONE / kk) ** 4;
}

/** What one leg can carry: cross-sectional area × muscle constant, discounted
 *  for membrane (a wing is skin, not a pillar). ABSOLUTE — a leg of radius r
 *  is exactly as strong on a mouse as on an elephant, which is the whole
 *  point: it is the body above it that grew. */
export function legStrength(radiusM: number, membrane = 0, k = K_BONE): number {
  const r = Math.max(0, radiusM);
  const web = Math.max(0, Math.min(1, membrane));
  return contactStrength(Math.PI * r * r, k) * (1 - MEMBRANE_DISCOUNT * web);
}

// ── EMA — what POSTURE costs ─────────────────────────────────────────────
// 🚨 THE HALF OF THE LAW THAT THICKNESS CANNOT DO. Bone circumference on the
// Campione line goes as M^0.364, so cross-section goes as M^0.728 and stress
// still climbs as M^0.272: thickness alone does not close. Biewener's answer is
// posture — small animals run crouched, big ones run upright, and limb
// effective mechanical advantage rises with size (they fit ≈ W^0.25, which
// closes 0.272 − 0.25 ≈ 0.02).
//
// We do not need their regression. They had to infer posture from body mass;
// we have the built limb, so we can measure the moment arms directly. EMA is
// r/R — the muscle's moment arm about a joint over the ground-reaction force's
// moment arm about the same joint — and the load the BONE carries is the
// ground force plus the muscle force that balances it:
//
//     F_bone ≈ F_ground · (1 + R/r) = F_ground · (1 + 1/EMA)
//
// so `emaMultiplier` returns that (1 + R/r). A columnar limb — foot straight
// under the hip, knee straight — has R → 0 and reads 1: the bone is a pillar
// and carries nothing but the weight. Every degree of crouch or sprawl moves
// the ground force's line of action away from a joint and multiplies what the
// muscles, and therefore the bone, must carry.

/** 🚨 MUSCLE MOMENT ARM ÷ LIMB FLESH RADIUS. An extensor tendon wraps its
 *  joint at a fraction of the limb's own thickness: a human patellar tendon
 *  moment arm is ~45 mm inside a thigh of ~82 mm radius (0.55), a dog's is
 *  ~15 mm inside a ~40 mm one (0.38). 0.45 is the middle. It is the one
 *  anatomical number in the EMA path, and it is what makes a THIN limb doubly
 *  expensive — small cross-section AND short lever — which is exactly why a
 *  spindly leg is worse than its area alone says. */
export const MUSCLE_MOMENT_FRAC = 0.45;

/** The built geometry one standing leg's EMA is read from. All distances in
 *  metres, all moment arms HORIZONTAL — the ground reaction is vertical, so
 *  its moment arm about a joint is the horizontal offset from that joint to
 *  the contact point. */
export interface EmaGeometry {
  /** Horizontal distance from the KNEE to the ground contact. Grows with
   *  every degree the knee is folded. */
  kneeArm: number;
  /** The limb's flesh radius at the knee. */
  limbRadius: number;
  /** Horizontal distance from the HIP to the ground contact — the SPRAWL: a
   *  crocodile plants its feet far outside its hips, a horse plants them
   *  underneath. */
  hipArm: number;
  /** ⚖️ THE HIP'S MUSCLES DO NOT WORK ACROSS THE LIMB, THEY WORK ACROSS THE
   *  TRUNK. Hip abductors and extensors span the pelvis, so their moment arm
   *  scales with the BODY's radius, not the leg's — using the leg's radius
   *  here would charge a sprawler for a lever it does not have and made the
   *  metre-long arthropods read ten times worse than the (already impossible)
   *  truth. Pass the trunk's max radius. */
  hipSpan: number;
}

/** Effective-load multiplier for one standing leg: 1 + R/r at whichever joint
 *  is worst off. Never below 1 (a limb always carries at least the weight),
 *  and finite for a zero-radius limb (which reads enormous, correctly).
 *
 *  Both joints are computed and the larger binds. On every body shipped today
 *  that is the KNEE — the hip's lever is the whole trunk radius, which is hard
 *  to lose — but a straight-legged extreme sprawler is a real body plan and
 *  the hip term is what would catch it. */
export function emaMultiplier(g: EmaGeometry): number {
  return emaDetail(g).mult;
}

/** The same measurement with its WORKING SHOWN — which joint bound, and what
 *  each cost. `emaMultiplier` is this function's `mult`.
 *
 *  🚨 THE ACTIONABLE HALF OF A RE-PROPORTIONING. Thickness and mass are both
 *  read straight off a table, but posture is not: a body reading σ high at
 *  line-perfect limbs is being charged for a CROUCH, and there is no way to fix
 *  that without knowing whether the cost is at the knee (fold the joint
 *  straighter, shorten the foot, drop `stance`) or at the hip (pull the feet in
 *  under the body — `restLevation`, `legBalance`, the sprawl). The two want
 *  opposite edits, so a single number cannot be acted on. */
export interface EmaDetail {
  /** 1 + max(knee, hip) — the load multiplier. */
  mult: number;
  /** R/r at the knee: ground-contact offset ÷ 0.45 × the LIMB's radius. */
  knee: number;
  /** R/r at the hip: ground-contact offset ÷ 0.45 × the TRUNK's radius. */
  hip: number;
  /** Which one set `mult`. Ties go to the knee (the usual binder). */
  joint: "knee" | "hip";
}

export function emaDetail(g: EmaGeometry): EmaDetail {
  const knee = jointDisadvantage(g.kneeArm, MUSCLE_MOMENT_FRAC * g.limbRadius);
  const hip = jointDisadvantage(g.hipArm, MUSCLE_MOMENT_FRAC * g.hipSpan);
  return { mult: 1 + Math.max(knee, hip), knee, hip, joint: hip > knee ? "hip" : "knee" };
}

/** R/r at one joint, with the degenerate cases pinned rather than left to
 *  produce Infinity or NaN downstream. */
function jointDisadvantage(arm: number, muscleArm: number): number {
  const R = Math.abs(arm);
  if (!(R > 0)) return 0;
  if (!(muscleArm > 1e-9)) return EMA_MAX; // no lever at all
  return Math.min(EMA_MAX, R / muscleArm);
}

/** Ceiling on the disadvantage term. Nothing physical picks it: it exists so a
 *  degenerate limb (radius 0) produces a huge FINITE number that sorts, prints
 *  and compares like every other, instead of an Infinity that poisons a mean.
 *  A leg anywhere near it is already unbuildable by many orders. */
const EMA_MAX = 1e4;

// ── Euler buckling — the other way a leg fails ───────────────────────────
// 🚨 CRUSHING IS NOT THE ONLY FAILURE, AND FOR A SLENDER LIMB IT IS NOT THE
// FIRST. A column fails by buckling at π²EI/(KL)², which for a circular
// section (I = πr⁴/4) goes as r⁴/L² — a completely different exponent from
// crushing's r². Compute both, take the minimum, and spindly giants reject
// themselves without anyone writing a rule against them.

/** Young's modulus of cortical bone, Pa. The textbook value; the load-bearing
 *  core is bone, so the flesh around it is dilution (see K_BONE), not
 *  stiffness. */
export const BONE_MODULUS_PA = 17e9;

/** Euler effective-length factor. A leg is held at the hip and planted at the
 *  foot with both ends free to rotate — the pinned-pinned case, K = 1. */
export const EULER_K = 1;

/** Buckling capacity of a limb of 1 m radius and 1 m length, in proxy force.
 *
 *  DERIVATION: P_cr = π²·E·I/(K·L)² with I = π(r/k)⁴/4, so
 *
 *      P_cr = π³ · E · r⁴ / (4 · k⁴ · K² · L²)   newtons
 *
 *  divided once by PROXY_FORCE_N to land in the ledger's units. Nothing is
 *  fitted — E, k and K are each named above.
 *
 *  CHECK AGAINST THE NOTES. Greenhill's self-buckling height for the same
 *  column is L_cr = (7.8373·EI/(ρAg))^⅓, which for this composite comes out at
 *  8.5·D^(2/3) metres (solid bone would be 95·D^(2/3); the ratio is exactly
 *  k^(4/3) = 11.2, the flesh dilution). The EXPONENT — the notes' "safe length
 *  ∝ diameter^(2/3)" — falls out of Euler by construction rather than being
 *  matched to it, which is the strongest form the check can take. */
export const BUCKLE_STRENGTH =
  (Math.PI ** 3 * BONE_MODULUS_PA) / (4 * K_BONE ** 4 * EULER_K ** 2 * PROXY_FORCE_N);

/** What a limb of radius r and length L can carry before it buckles, in the
 *  same units as `legStrength`. */
export function buckleCapacity(
  radiusM: number, lengthM: number, membrane = 0, k = K_BONE,
): number {
  const r = Math.max(0, radiusM);
  const L = Math.max(1e-6, lengthM);
  const web = Math.max(0, Math.min(1, membrane));
  return (buckleStrengthFor(k) * r ** 4) / (L * L) * (1 - MEMBRANE_DISCOUNT * web);
}

/** Which failure mode binds, and at what capacity. */
export interface LegCapacity {
  /** min(crush, buckle) — what the ledger divides a force by. */
  strength: number;
  crush: number;
  buckle: number;
  bind: "crush" | "buckle";
}

/** 🚨 THE LEG'S REAL CAPACITY: the lesser of crushing and buckling.
 *
 *  The crossover is at r/L ≈ 0.040 — below that a limb buckles before it
 *  crushes. That lands next to (and independently of) the pose layer's own
 *  `isLeggy` cutoff of 0.03, which asks a different question and is untouched:
 *  `isLeggy` decides whether a limb may bear weight AT ALL, this decides how
 *  much a bearing limb can take.
 *
 *  `lengthM` omitted (or non-positive) = crushing only, which is what a caller
 *  with no built geometry — a capacity estimate before a pose exists — can
 *  honestly ask for.
 *
 *  `k` is the body's bone fraction (`boneFraction(spine.skeleton)`). It moves
 *  the crossover as well as the capacities: buckling binds below r/L ≈ 0.040
 *  for a mammal but only below ≈ 0.0086 for an exoskeleton, because a tube
 *  carrying its own outside is the stiff way to build a thin leg.
 *
 *  ⚠️ `bendCapacity` (necks, tails, carried loads) is deliberately NOT on this
 *  seam. It hangs off BEND_STRENGTH, which is still the old FIT rather than an
 *  anatomical derivation, so threading k through it would propagate a number
 *  that is not yet on the anatomical scale. Nothing with an exoskeleton in the
 *  registry carries anything on a neck. */
export function legCapacity(
  radiusM: number, lengthM = 0, membrane = 0, k = K_BONE,
): LegCapacity {
  const crush = legStrength(radiusM, membrane, k);
  if (!(lengthM > 0)) return { strength: crush, crush, buckle: Infinity, bind: "crush" };
  const buckle = buckleCapacity(radiusM, lengthM, membrane, k);
  return buckle < crush
    ? { strength: buckle, crush, buckle, bind: "buckle" }
    : { strength: crush, crush, buckle, bind: "crush" };
}

/** How close a load is to capacity. 1.0 = at capacity; > 1 = overloaded.
 *  A zero-strength part under any load is fully overloaded, not NaN. */
export function stress(force: number, strength: number): number {
  if (strength > 1e-12) return force / strength;
  return force > 1e-12 ? Infinity : 0;
}

/** What a cantilever of radius r can hold, as a MOMENT (force × meters):
 *  BEND_STRENGTH × r³. Split out of `cantileverStress` because a carried load
 *  and the part's own weight are two moments about ONE root and have to be
 *  summed before they are divided by anything — a stress is a ratio, and
 *  ratios do not add. */
export function bendCapacity(radiusM: number): number {
  const r = Math.max(0, radiusM);
  return BEND_STRENGTH * r * r * r;
}

/** Bending stress on a cantilever (a neck holding a head out front, a tail
 *  held off the ground): moment `load × lever` against a section modulus
 *  ∝ r³. Same 1.0 = at capacity convention. */
export function cantileverStress(load: number, lever: number, radiusM: number): number {
  return stress(Math.abs(load * lever), bendCapacity(radiusM));
}

// ── Carried loads ────────────────────────────────────────────────────────
// 🚨 A CARRIED LOAD IS NOT A CONTACT. It is extra WEIGHT hanging at a point on
// the body: it adds to the total the ground must hold, it drags the CoM toward
// itself, and it bends whatever part it hangs from. An object RESTING on the
// ground is simply not a load — it becomes one at the lift and stops being one
// at the release. (Handing a held object to `solveFootForces` as one more
// contact would say the creature is standing on the thing it is carrying.)

/** A mass riding on the body at a creature-local point (post-lift frame — the
 *  same space `PoseOverrides.limbTargets` and `snoutTarget` live in, which is
 *  where a host already knows the object's position).
 *
 *  UNITS: `mass` is the SAME volume proxy as body mass — π-dropped volume ×
 *  density, density 1 = body tissue (see the units note at the top). Use
 *  `objectMassFromSize` unless you know better; every ratio the ledger reports
 *  is a stress, so the proxy cancels and only the RATIO of load to body
 *  matters. */
export interface CarriedLoad {
  mass: number;
  at: Pt3;
}

/** Density of a picked-up object RELATIVE TO BODY TISSUE (water ≈ 1). The
 *  default says "as dense as the animal carrying it", which is the honest
 *  no-information answer; a wooden crate is ~0.5, a stuffed toy ~0.1, a rock
 *  ~2.6. A caller that knows the object passes its own mass instead. */
export const OBJECT_DENSITY = 1;

/** Proxy mass of an object `sizeM` across, in the body's own mass units.
 *
 *  The volume taken is a SPHERE of that diameter — πs³/6 — because `sizeM` is
 *  an overall size, not a box edge, and because the π then drops out against
 *  the body's π-dropped bone volumes exactly. So: s³/6 × density, and nothing
 *  is tuned. A 20 cm object on the shipped dog is ~0.5% of its body mass; a
 *  50 cm one is ~7.5%. */
export function objectMassFromSize(sizeM: number, density = OBJECT_DENSITY): number {
  const s = Math.max(0, sizeM);
  return ((s * s * s) / 6) * Math.max(0, density);
}

/** Σ of the load masses (non-positive entries ignored). */
export function loadMassTotal(loads: readonly CarriedLoad[] | undefined): number {
  let total = 0;
  if (!loads) return 0;
  for (const l of loads) if (l.mass > 0 && Number.isFinite(l.mass)) total += l.mass;
  return total;
}

/** The CoM of the SUPPORTED SYSTEM — body plus everything it carries. The
 *  mass-weighted combination, and the point the force solve must balance
 *  under: a mouth-held object pulls it forward, the front feet take more, and
 *  nothing else in the solver has to know loads exist.
 *
 *  Returns the body's own CoM unchanged when nothing is carried. */
export function combinedCoM(
  bodyMass: number, bodyCom: Pt3, loads: readonly CarriedLoad[] | undefined,
): MassProperties {
  const carried = loadMassTotal(loads);
  if (!(carried > 0)) return { mass: bodyMass, com: bodyCom };
  let mass = Math.max(0, bodyMass);
  let cx = mass * bodyCom.x;
  let cy = mass * bodyCom.y;
  let cz = mass * bodyCom.z;
  for (const l of loads!) {
    if (!(l.mass > 0) || !Number.isFinite(l.mass)) continue;
    mass += l.mass;
    cx += l.mass * l.at.x;
    cy += l.mass * l.at.y;
    cz += l.mass * l.at.z;
  }
  if (!(mass > 1e-18)) return { mass: 0, com: { x: 0, y: 0, z: 0 } };
  return { mass, com: { x: cx / mass, y: cy / mass, z: cz / mass } };
}

// ── Refusal ──────────────────────────────────────────────────────────────

/** 🚨 THE REFUSAL THRESHOLD — and it is not a new number: 1.0 is this
 *  module's own "at capacity" convention, the same 1.0 the stress ramp turns
 *  red at. A body may not START carrying something that would put any part of
 *  it past capacity.
 *
 *  ⚖️ NO EXEMPTION FOR AN ALREADY-OVERLOADED BODY. The shipped cow reads a
 *  mean leg stress of 3.8 standing empty (and the sheep 5.3) — a body-plan
 *  fact: they ship legs with ~1/13 the cross-section of the dog's under most
 *  of the mass. Under this gate they refuse EVERY load, including a
 *  weightless one, and that is the deliberate choice: the alternative —
 *  measuring a load against a body the ledger already calls overloaded — is a
 *  silent exemption that would make the gate mean nothing for exactly the
 *  bodies it should be loudest about. The fix for a cow that should be able
 *  to carry a bucket lives in the cow's radiusFrac or in MUSCLE_STRENGTH, not
 *  here. `BearVerdict` reports which side bound, so a caller that wants a
 *  different policy has the numbers to write it. */
export const MAX_BEARABLE_STRESS = 1;

export interface BearRequest {
  /** (body + everything already carried + the new load) × gravity. */
  totalWeight: number;
  /** Strengths of the legs actually holding the body up. Empty or omitted =
   *  the legs are not what is carrying the body (a belly rest, a swimmer), so
   *  the stance side does not bind. */
  stanceStrengths?: readonly number[];
  /** The one part that would carry the NEW load, alone: the neck for a mouth
   *  carry, the arm for a hand carry. `load` is that part's share of the load
   *  as a FORCE (mass × gravity), `lever` the horizontal distance from the
   *  part's root to where the load rides, `radius` the root's radius.
   *
   *  `baseMoment` is what that part is ALREADY holding out on that lever
   *  (force × meters — for a neck, the head). Include it and the gate agrees
   *  with the ledger the load is about to land in: a permitted load can never
   *  make `chainStress.neck` read over capacity, because the gate weighed the
   *  same moment sum the ledger will. Omit it and the gate asks the narrower
   *  question "is the LOAD alone too much for this part", which is all a
   *  caller with no ledger can ask. */
  carrier?: { load: number; lever: number; radius: number; baseMoment?: number };
  /** Override the threshold (default MAX_BEARABLE_STRESS). */
  limit?: number;
}

export interface BearVerdict {
  ok: boolean;
  /** Mean leg stress the total weight implies over the stance. */
  stance: number;
  /** Bending stress on the carrying part alone. */
  carrier: number;
  limit: number;
  /** Which side said no (or "none" when the answer is yes). */
  bind: "stance" | "carrier" | "none";
}

/**
 * Can this body take that load? Two questions, and the binding one wins:
 *   • the STANCE — total weight against the legs holding the body up, the
 *     same mean-leg-stress measure `chainStress.spine` reports;
 *   • the CARRIER — the neck or the limb that would hold the thing, on its
 *     own, in bending, through `cantileverStress`. This is why holding a
 *     weight at arm's length is the hard part and not the standing.
 * Coarse by construction: it asks whether the body could hold the load at
 * all, not whether the exact pose it will end up in is sound — the ledger on
 * the built skeleton answers that, honestly, every frame after the lift.
 */
export function canBear(req: BearRequest): BearVerdict {
  const limit = req.limit ?? MAX_BEARABLE_STRESS;
  let stanceStress = 0;
  const legs = req.stanceStrengths;
  if (legs && legs.length > 0) {
    let total = 0;
    for (const s of legs) total += Math.max(0, s);
    stanceStress = stress(Math.max(0, req.totalWeight), total);
  }
  const c = req.carrier;
  const carrierStress = c
    ? stress(Math.abs(c.load * c.lever) + Math.abs(c.baseMoment ?? 0), bendCapacity(c.radius))
    : 0;
  const bind = stanceStress > limit && stanceStress >= carrierStress ? "stance"
    : carrierStress > limit ? "carrier"
    : "none";
  return { ok: bind === "none", stance: stanceStress, carrier: carrierStress, limit, bind };
}

// ── Foot forces ──────────────────────────────────────────────────────────

export interface FootForceInput {
  /** Ground contact points of the legs actually bearing weight.
   *
   *  ⚖️ NOT NECESSARILY FEET. Phase 4 hands this the BELLY patch's centroid
   *  as one more contact when the trunk is on the ground, which is the whole
   *  reason `stiffness` exists: a belly and a hoof are both areas pressed
   *  against the same plane, and the only thing that separates them is how
   *  much load each can take. */
  feet: readonly GroundPt[];
  /** Center of mass to balance under — the POST-shift CoM: the body has
   *  already leaned, the feet have not moved. */
  com: GroundPt;
  /** Total downward load to distribute (mass × gravity). */
  weight: number;
  /** 🚨 LOAD-SHARING CAPACITY per contact, index-aligned with `feet`.
   *  OPTIONAL, and omitting it is the phases 1–3 behaviour EXACTLY (every
   *  contact equal), which is why no shipped body's forces move.
   *
   *  This is the tie-break, not the balance: the moment term still comes
   *  first and is still minimised to the last bit. Among the force sets that
   *  TIE on moment — the usual case for 3+ contacts, and the only case a
   *  belly is ever in — the solver picks the one that shares load in
   *  proportion to these numbers instead of the one that shares it evenly.
   *
   *  Hand it `strength` (what each contact can carry) and the model reads:
   *  every contact works equally hard. That is the classic rigid-body-on-
   *  elastic-supports answer AND the physically honest one for a lying
   *  animal — a belly with 100× a hoof's footprint takes ~100× the load, so
   *  the legs go nearly slack and nothing is overloaded. Anything ≤ 0 is
   *  treated as "carries nothing" (it still gets a force of 0, never NaN).
   *  Ignored when its length does not match `feet`. */
  stiffness?: readonly number[];
}

export interface FootForces {
  /** Downward force per foot, index-aligned with the input. All ≥ 0 and
   *  summing to `weight` (exactly — the sum is a hard constraint; the moment
   *  balance is only satisfied when it CAN be). */
  forces: number[];
  /** Where the ground's push actually acts, Σf·p / Σf. Null when nothing is
   *  bearing (no feet, or no weight). */
  centerOfPressure: GroundPt | null;
  /** 🚨 THE TIPPING MEASURE — distance in METERS from the CoM to the center
   *  of pressure. 0 while the CoM sits over the feet. When the CoM is outside
   *  the support polygon no non-negative force distribution can zero the
   *  moment: the far feet go to 0, the CoP pins to the polygon's edge, and
   *  this is how far past it the weight hangs. That is precisely the
   *  handstand — a pitched trunk whose hind legs have dropped out of support
   *  leaves the CoM behind the front feet, and this number says by how much. */
  tipping: number;
  /** Unit direction the body topples (CoP → CoM). Zero vector when balanced. */
  tipDir: GroundPt;
}

const ZERO_DIR: GroundPt = { x: 0, z: 0 };

/**
 * Distribute a body's weight over its planted feet.
 *
 * The problem is a tiny QP: find f ≥ 0 with Σfᵢ = weight (the ground MUST
 * hold the body up) minimising the horizontal moment about the CoM,
 * Σfᵢ(pᵢ − com), and — among the many force sets that tie on moment, which is
 * the usual case for 3+ feet — the most EVEN one. (Under Σfᵢ = weight,
 * minimising ‖f‖² is exactly minimising the distance to an even share, so one
 * objective covers both.)
 *
 *   minimise  ½ fᵀ(MᵀM + εI) f      M = the 2×n lever-arm matrix
 *   subject to 1ᵀf = weight, f ≥ 0
 *
 * ε is a tiny relative regulariser: it is what picks the even solution out of
 * a moment-tied family, and it cancels entirely when every lever is zero.
 * Solved by active set — free everything, drop whatever goes negative, re-add
 * anything whose multiplier says it wants to push again. n ≤ ~8 feet, a
 * handful of Cholesky solves, no allocation per iteration beyond the working
 * arrays, and fully deterministic (ties break to the lowest index).
 *
 * ⚖️ WITH `stiffness`, the regulariser becomes εD⁻¹ (D = the normalised
 * capacities) and the objective is Σfᵢ²/wᵢ instead of Σfᵢ². Same solve, same
 * active set, same moment priority — only the tie-break changes, from "the
 * most even" to "in proportion to capacity". With every lever zero it gives
 * fᵢ = weight·wᵢ/Σw exactly, which is the belly split. The weights are
 * normalised to mean 1 so ε keeps the magnitude it was calibrated at, and
 * the whole path is skipped when `stiffness` is absent so the phase-3
 * numbers survive bit for bit.
 *
 * Degenerates all fall out of the same path: one foot takes everything;
 * collinear feet balance along their line and tip across it; no feet returns
 * no forces at all — the belly is bearing the body, not the legs.
 */
export function solveFootForces(input: FootForceInput): FootForces {
  const { feet, com, weight } = input;
  const n = feet.length;
  if (n === 0) {
    // Nothing is standing: the belly (or the water, or the ground under the
    // trunk) bears everything. There is no support polygon to tip out of.
    return { forces: [], centerOfPressure: null, tipping: 0, tipDir: ZERO_DIR };
  }
  const forces = new Array<number>(n).fill(0);
  if (!(weight > 0)) {
    return { forces, centerOfPressure: null, tipping: 0, tipDir: ZERO_DIR };
  }

  // Lever arms about the CoM.
  const lx = new Array<number>(n);
  const lz = new Array<number>(n);
  let lever2 = 0;
  for (let i = 0; i < n; i++) {
    lx[i] = feet[i].x - com.x;
    lz[i] = feet[i].z - com.z;
    lever2 += lx[i] * lx[i] + lz[i] * lz[i];
  }

  // Capacity weights, normalised to mean 1 (so ε keeps its calibrated size).
  // `null` = the unweighted path, which must stay bit-identical to phase 3.
  const w = normaliseStiffness(input.stiffness, n);

  // H = MᵀM + εD⁻¹ (n×n, symmetric positive definite). D = diag(w), so the
  // unweighted case is literally εI and takes the same branch it always did.
  const eps = 1e-6 * (lever2 / n) + 1e-12;
  const H = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = lx[i] * lx[j] + lz[i] * lz[j] + (i === j ? (w ? eps / w[i] : eps) : 0);
      H[i * n + j] = v;
      H[j * n + i] = v;
    }
  }
  /** Capacity-proportional share of `weight` — the fallback the degenerate
   *  paths below use in place of an even split. Identical to `weight / k`
   *  over the same index set when unweighted. */
  const share = (idx: readonly number[]): number[] => {
    if (!w) return idx.map(() => weight / idx.length);
    let tot = 0;
    for (const i of idx) tot += w[i];
    if (!(tot > 1e-18)) return idx.map(() => weight / idx.length);
    return idx.map((i) => (weight * w[i]) / tot);
  };
  const allIdx: number[] = [];
  for (let i = 0; i < n; i++) allIdx.push(i);

  const free = new Array<boolean>(n).fill(true);
  const TOL = 1e-12 * weight + 1e-15;
  const maxIter = 4 * n + 8;
  for (let iter = 0; iter < maxIter; iter++) {
    // Equality-constrained optimum over the free set: with f = -λ H⁻¹1, the
    // constraint 1ᵀf = weight fixes λ, so f = (H⁻¹1) · weight / Σ(H⁻¹1).
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (free[i]) idx.push(i);
    if (idx.length === 0) {
      // Everything was driven to zero (only possible under round-off) —
      // fall back to a capacity share rather than dropping the body.
      const f = share(allIdx);
      for (let i = 0; i < n; i++) forces[i] = f[i];
      break;
    }
    const sol = solveSymmetric(H, n, idx);
    let sum = 0;
    for (let k = 0; k < idx.length; k++) sum += sol[k];
    for (let i = 0; i < n; i++) forces[i] = 0;
    if (!(sum > 1e-18) || !Number.isFinite(sum)) {
      const f = share(idx);
      for (let k = 0; k < idx.length; k++) forces[idx[k]] = f[k];
      break;
    }
    const gain = weight / sum;
    for (let k = 0; k < idx.length; k++) forces[idx[k]] = sol[k] * gain;

    // A foot cannot PULL. Drop the most negative one and re-solve.
    let worst = -1;
    let worstV = -TOL;
    for (const i of idx) {
      if (forces[i] < worstV) { worstV = forces[i]; worst = i; }
    }
    if (worst >= 0) { free[worst] = false; continue; }

    // Optimality for the feet held at zero: μᵢ = (Hf)ᵢ + λ, λ = −weight/Σ.
    // μᵢ < 0 means letting that foot push would reduce the moment — free it.
    const lambda = -gain;
    let best = -1;
    let bestMu = -TOL;
    for (let i = 0; i < n; i++) {
      if (free[i]) continue;
      let hf = 0;
      for (let j = 0; j < n; j++) hf += H[i * n + j] * forces[j];
      const mu = hf + lambda;
      if (mu < bestMu) { bestMu = mu; best = i; }
    }
    if (best < 0) break;
    free[best] = true;
  }

  // Clamp round-off and renormalise so Σf = weight EXACTLY.
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!(forces[i] > 0)) forces[i] = 0;
    total += forces[i];
  }
  if (total > 1e-18) {
    const k = weight / total;
    for (let i = 0; i < n; i++) forces[i] *= k;
  } else {
    const f = share(allIdx);
    for (let i = 0; i < n; i++) forces[i] = f[i];
  }

  let px = 0;
  let pz = 0;
  for (let i = 0; i < n; i++) {
    px += forces[i] * feet[i].x;
    pz += forces[i] * feet[i].z;
  }
  px /= weight;
  pz /= weight;
  const dx = com.x - px;
  const dz = com.z - pz;
  const tipping = Math.hypot(dx, dz);
  return {
    forces,
    centerOfPressure: { x: px, z: pz },
    tipping,
    tipDir: tipping > 1e-9 ? { x: dx / tipping, z: dz / tipping } : ZERO_DIR,
  };
}

/** Capacity weights normalised so the SMALLEST real one is 1, or `null` for
 *  the unweighted path.
 *
 *  🚨 WHY THE MINIMUM AND NOT THE MEAN. The regulariser enters as ε/wᵢ, so
 *  every weight below the normalisation point AMPLIFIES it — and ε is a
 *  deliberate lie, the tiny perturbation that picks one answer out of a
 *  moment-tied family. Normalised to the mean, a contact 100× weaker than
 *  average got 100ε on its diagonal, which is no longer negligible: it bent
 *  the balance itself and a body over its own feet reported real tipping.
 *  Normalised to the minimum every wᵢ ≥ 1, so ε/wᵢ ≤ ε and the perturbation
 *  is bounded by exactly what the unweighted solver already accepted. The
 *  RATIOS are untouched, so the tie-break lands in the same place.
 *
 *  Returns null — the phase-3 path, bit for bit — whenever the caller gave no
 *  weights, gave the wrong number of them, or gave a set with no capacity in
 *  it at all. A single non-positive entry is NOT a reason to throw the whole
 *  set away: it is a contact that carries nothing, and a large 1/w on the H
 *  diagonal says exactly that (its force is driven toward 0, never to NaN). */
function normaliseStiffness(
  stiffness: readonly number[] | undefined, n: number,
): Float64Array | null {
  if (!stiffness || stiffness.length !== n || n === 0) return null;
  let minPos = Infinity;
  for (let i = 0; i < n; i++) {
    const v = stiffness[i];
    if (Number.isFinite(v) && v > 0) minPos = Math.min(minPos, v);
  }
  if (!Number.isFinite(minPos)) return null; // nothing can carry anything
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = stiffness[i];
    // 1e-6 rather than 0: a capacity-less contact must be pushed hard toward
    // zero force without making H singular.
    w[i] = Number.isFinite(v) && v > 0 ? v / minPos : 1e-6;
  }
  return w;
}

/** Solve H[idx,idx] · s = 1 by Cholesky. H is SPD by construction (MᵀM + εI);
 *  a non-positive pivot can only come from catastrophic round-off, and is
 *  reported as an all-zero solution so the caller falls back to an even
 *  share. Allocates two small arrays per call; k ≤ n ≤ ~8. */
function solveSymmetric(H: Float64Array, n: number, idx: readonly number[]): Float64Array {
  const k = idx.length;
  const Lm = new Float64Array(k * k);
  const s = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = H[idx[i] * n + idx[j]];
      for (let p = 0; p < j; p++) sum -= Lm[i * k + p] * Lm[j * k + p];
      if (i === j) {
        if (!(sum > 0)) return s; // all zeros → caller uses the even split
        Lm[i * k + i] = Math.sqrt(sum);
      } else {
        Lm[i * k + j] = sum / Lm[j * k + j];
      }
    }
  }
  // Forward then back substitution against the all-ones right-hand side.
  for (let i = 0; i < k; i++) {
    let sum = 1;
    for (let p = 0; p < i; p++) sum -= Lm[i * k + p] * s[p];
    s[i] = sum / Lm[i * k + i];
  }
  for (let i = k - 1; i >= 0; i--) {
    let sum = s[i];
    for (let p = i + 1; p < k; p++) sum -= Lm[p * k + i] * s[p];
    s[i] = sum / Lm[i * k + i];
  }
  return s;
}
