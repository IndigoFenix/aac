// Creature Lab — standalone dev page (lab.html) for the creature
// generator. Phase-1 scope: view a blueprint's rest pose, tweak every field
// with sliders generated from the blueprint RANGES tables, re-roll seeded
// random blueprints, and round-trip blueprints through the JSON box (the same
// path an AI-emitted description→blueprint will use later).
//
// This page is a dev tool: mouse-driven (OrbitControls), not eyegaze.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  clampBlueprint,
  defaultBlueprint,
  randomBlueprint,
  validateBlueprint,
  HEAD_RANGES,
  LIMB_GROUP_RANGES,
  LIMB_PLACEMENTS,
  CHAIN_RANGES,
  CHAIN_ATTACH,
  CHAIN_TIPS,
  MEMBRANE_RANGES,
  MEMBRANE_EDGES,
  PROFILE_POINT_RANGES,
  MAX_LIMB_GROUPS,
  MAX_CHAINS,
  MAX_MEMBRANES,
  MAX_PROFILE_POINTS,
  NECK_RANGES,
  POSTURE_RANGES,
  SPINE_RANGES,
  TAIL_RANGES,
  type ChainAttach,
  type ChainTip,
  type FieldRange,
  type Blueprint,
  type LimbPlacement,
  type MembraneEdge,
} from "@shared/world-engine/creatures/blueprint";
import {
  buildSkeleton,
  limbTip,
  type CreatureSkeleton,
  type LegSupport,
  type SkeletonPhysics,
  type SupportDiagnostics,
} from "@shared/world-engine/creatures/skeleton";
import {
  SAFETY_FACTOR,
  boneStressPa,
  massKg,
  objectMassFromSize,
  type BearVerdict,
} from "@shared/world-engine/creatures/physio";
import { convexHull2D } from "@shared/world-engine/creatures/balance";
import {
  ageGrowth,
  ageGrowths,
  agePlantBody,
  growthHeightFactor,
  growthLevelsAt,
  FRUIT_PLACEMENTS,
  GROWTH_ATTACH,
  GROWTH_BRANCHING_RANGES,
  GROWTH_FLOWER_RANGES,
  GROWTH_FOLIAGE_RANGES,
  GROWTH_FRUIT_RANGES,
  GROWTH_PLACEMENTS,
  GROWTH_RANGES,
  GROWTH_STEM_RANGES,
  GROWTH_TYPES,
  MAX_GROWTHS,
  type FruitPlacement,
  type GrowthAttach,
  type GrowthPlacement,
  type GrowthType,
} from "@shared/world-engine/creatures/growth";
import {
  GARMENT_KINDS,
  GARMENT_RANGES,
  MAX_GARMENTS,
  defaultGarment,
  type GarmentBlueprint,
  type GarmentKind,
} from "@shared/world-engine/creatures/clothing";
import { buildCreatureMesh, LOFT, type BuiltCreature } from "@shared/world-engine/creatures/mesh";
import { bakePlantImpostor, buildPlantLods, makeImpostorMesh, plantMaterial } from "@shared/world-engine/creatures/plant-lod";
import { buildStickGeometry, creatureSticks, stickMaterial } from "@shared/world-engine/creatures/stick-lod";
import { propMaterial, terrainMaterial } from "@shared/world-engine/materials";
import { CREATURE_EXAMPLES } from "@shared/world-engine/creatures/examples";
import { getSpecies, listSpecies, requireSpecies, speciesBlueprint, type Species } from "@shared/world-engine/creatures/species";
import { activeCreatureMods, applyAppearanceMods } from "@shared/world-engine/creatures/mods";
import { listCreatureMods } from "@shared/world-engine/creatures/mod-library";
import { applyWorldCreatureMods } from "@shared/world-engine/creatures/world-mods";
import { DEFAULT_GAIT, GAIT_PATTERNS, type GaitParams, type GaitPattern } from "@shared/world-engine/creatures/gait";
import { CreatureAnimator, type AnimFrame } from "@shared/world-engine/creatures/animation";

// ── Scene ────────────────────────────────────────────────────────────────

const canvas = document.getElementById("lab-scene") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#1a2027");
scene.fog = new THREE.Fog("#1a2027", 30, 120);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(2.5, 1.6, 3.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.6, 0);

scene.add(new THREE.HemisphereLight("#cfe5ff", "#3a3328", 0.9));
const sun = new THREE.DirectionalLight("#fff3dd", 1.6);
sun.position.set(4, 8, 3);
scene.add(sun);

// Ground: soft disc + grid, creature stands at the origin.
{
  const disc = new THREE.Mesh(new THREE.CircleGeometry(40, 48), terrainMaterial({ color: "#222a33" }));
  disc.rotation.x = -Math.PI / 2;
  scene.add(disc);
  const grid = new THREE.GridHelper(80, 80, 0x33404e, 0x273039);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.4;
  grid.position.y = 0.001;
  scene.add(grid);
}

// Soil plane — a translucent brown sheet at y=0 shown only when a growth
// is a root vegetable, so the downward storage organ reads as underground
// (the plant's leafy top pokes above it). Toggled from rebuildGeometry.
const soilPlane = new THREE.Mesh(
  new THREE.CircleGeometry(0.5, 40),
  terrainMaterial({
    color: "#5a4326", transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
  }),
);
soilPlane.rotation.x = -Math.PI / 2;
soilPlane.position.y = 0.002;
soilPlane.visible = false;
soilPlane.renderOrder = 2; // drawn after the plant so it reads as a translucent overlay
scene.add(soilPlane);

// ── State ────────────────────────────────────────────────────────────────

let blueprint: Blueprint = defaultBlueprint();
/** The creature mods switched on in the lab, in declaration order. Held here
 *  (not read back off the engine) because it is the panel's own state: the
 *  engine only ever sees the result of `applyWorldCreatureMods`. */
let modIds: string[] = [];

/** Load a species the way THE GAME would see it under the active mods: a
 *  derived species is already a registry row (the derivation baked its
 *  transform in), and an appearance mod is applied on top at build time — so
 *  the lab has to apply it here too, or the lab shows a body the world does
 *  not. */
function loadSpeciesBlueprint(id: string): Blueprint {
  return applyAppearanceMods(requireSpecies(id), speciesBlueprint(id), activeCreatureMods());
}

/** The species id a save targets — set by loading one, editable in the panel
 *  so a variant can be saved under a new id instead of over the original. */
let speciesId = "";
let statusEl: HTMLElement | null = null;
let statusText = "";
let statusIsError = false;
let built: BuiltCreature | null = null;
let skeletonHelper: THREE.SkeletonHelper | null = null;
let seed = 1;
// 🌱 PLANT AGE — 0 a shoot .. 1 the authored adult (growth.ts `ageGrowth`).
// A VIEW, never an edit: the sliders and the JSON box keep writing/showing
// the ADULT blueprint, and the scrub only changes the body drawn from it,
// exactly as the world will (the sim's size class decides the age, the
// render reads it). 1 is identity, so a fresh lab session is byte-identical
// to the lab before this existed.
let plantAge = 1;
let autoFrame = true;
let wireframe = false;
let showSkeleton = false;
// Posture animation: when on, the torso target (bodyHeight + a gentle pitch
// rear-up) is driven by a clock and the skeleton re-solves every frame, so
// you watch legs plant/lift and knees fold as the body rises and lowers.
let animatePosture = false;
const savedPosture = { bodyPitch: 0, bodyHeight: 0 };
// LOD preview: swap the live skinned creature for the static tier a DISTANT
// instance would use. `lod1` / `impostor` are the plant ladder (plant-lod.ts);
// `stick` is the tier both ladders share (stick-lod.ts) and is the one to
// check on a CREATURE too — it is what a resident 45-110 m away is drawn as.
let lodPreview: "off" | "stick" | "lod1" | "impostor" = "off";
let lodObject: THREE.Object3D | null = null;
let lodDisposers: Array<() => void> = [];
// Walk gait: when on, the animation loop advances the gait phase from a
// clock and the skeleton is re-solved each frame with gait-driven foot
// targets (stance/swing) + body bob.
let walking = false;
// Mouth testing: a static gape plus an open/close cycle that re-solves the
// skeleton each frame (the gape is baked into the loft, like posture).
const mouthMisc = { gape: 0 };
let mouthCycle = false;
let bareSkull = false; // suppress the soft-tissue layer (work on the bone)
let celShading = false; // toon-ramp material (candidate game default look)
// Color-by-section (debug): repaint each construction section a distinct
// hue so a gap reads as a seam between two NAMED regions. A legend maps
// color → section name.
let colorBySection = false;
const sectionLegendEl = document.createElement("div");
sectionLegendEl.style.cssText =
  "position:fixed;right:10px;top:10px;z-index:20;font:11px monospace;" +
  "color:#fff;background:#000b;padding:6px 8px;border-radius:4px;display:none;line-height:1.5";
document.body.appendChild(sectionLegendEl);

/** Stable hash of a section name → a distinct, readable color. */
function sectionColor(name: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = new THREE.Color();
  c.setHSL((h % 360) / 360, 0.5 + ((h >> 9) % 35) / 100, 0.55);
  return c;
}

/** Repaint the built mesh's color attribute by construction section and
 *  fill the legend. Called from rebuildGeometry when the toggle is on. */
function applySectionColors(): void {
  if (!built || built.sections.length === 0) return;
  const attr = built.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  const present = new Set<string>();
  for (let i = 0; i < built.sections.length; i++) {
    const name = built.sections[i] || "(none)";
    present.add(name);
    const c = sectionColor(name);
    attr.setXYZ(i, c.r, c.g, c.b);
  }
  attr.needsUpdate = true;
  sectionLegendEl.innerHTML = "";
  for (const name of [...present].sort()) {
    const c = sectionColor(name);
    const row = document.createElement("div");
    row.innerHTML =
      `<span style="display:inline-block;width:10px;height:10px;margin-right:6px;` +
      `background:${c.getStyle()};border:1px solid #fff6"></span>${name}`;
    sectionLegendEl.appendChild(row);
  }
  sectionLegendEl.style.display = "block";
}

// ── Stress physics (phase 2) ─────────────────────────────────────────────
// `buildSkeleton` attaches a SUPPORT LEDGER to every skeleton it builds
// (`skel.support`, a SupportDiagnostics computed by physio.ts): what the body
// weighs, where that weight lands, which legs are actually bearing it and how
// hard each one works. Phase 1 only computed it. This section makes it
// VISIBLE — a per-bone stress tint on the skin, a ground overlay (support
// polygon / CoM / foot forces / tipping lever) and a numeric readout — and
// owns the gravity dial that every buildSkeleton call on this page reads.
//
// Gravity feeds back into NOTHING: it scales forces and stresses and nothing
// else, so turning that dial must never move a bone.
//
// ⚖️ THE LOAD DIALS ARE THE EXCEPTION, and they are supposed to be. A body
// carrying something really does stand lower (skeleton.ts section 6 derives
// the sag from the same strengths this readout prints), so the crate in the
// jaws and the pack on the back both move the pose — through `phys.loads`,
// which `physEnv` merges from the animator's frame.
let stressView = false;
/** Sub-toggle: the ground overlay is the loudest part of the stress view, so
 *  it can be dropped while keeping the skin tint. Only ever drawn when
 *  `stressView` is on. */
let groundOverlay = true;
// gravity — a pure diagnostic multiplier (never moves a bone);
// objectMass — the crate's mass as a MULTIPLE of `objectMassFromSize` (1 =
//   auto: as dense as the creature carrying it), so the dial stays readable
//   without the reader having to think in π-dropped volume proxies;
// backLoad  — a persistent pack as a fraction of the creature's OWN body mass
//   (0.5 = a dog carrying half a dog), which is the only scale on which "is
//   that a lot?" has an answer.
const physMisc = { gravity: 1, objectMass: 1, backLoad: 0 };
/** The last refused pick-up (physio.canBear's verdict), so the panel can SAY
 *  the body said no instead of the button silently doing nothing. */
let lastRefusal: BearVerdict | null = null;
/** The ledger from the MOST RECENT build. Written by rebuildGeometry, so the
 *  animator tick refreshes it for free; read by the readout, the overlay and
 *  the `stressReport()` hook. */
let lastSupport: SupportDiagnostics | null = null;
/** The readout <pre>. Rebuilt with the panel (buildPanel wipes it), so it is
 *  held like `statusEl` — nullable, re-attached each buildPanel. */
let stressReadoutEl: HTMLElement | null = null;

/** THE physics source of truth. Every `buildSkeleton` call in this file
 *  passes it, so one dial moves the static build, the gait build and the
 *  animator tick together.
 *
 *  🚨 THE ANIMATOR'S LOADS RIDE ALONG. `AnimFrame.loads` is what the creature
 *  is holding this frame (the crate in its jaws, the pack on its back), and
 *  the CALLER is the one that has to merge it into `phys` — this is that
 *  merge, in one place, so the static build, the frozen-gait build and the
 *  live tick can never disagree about what the body is carrying. With the
 *  animator off (or empty-handed) it is undefined and the build is the
 *  byte-identical unloaded one. Gravity multiplies loads for free: it is
 *  applied to the total weight, and a load is part of the total. */
const physEnv = (): SkeletonPhysics => ({
  gravity: physMisc.gravity,
  loads: animOn ? animFrame?.loads : undefined,
});

// Stress ramp: green (0) → yellow (0.7) → red (1) → near-black violet (>= 3).
// The tail past 1 is what separates "borderline red" (a horse at 1.06, an
// evolutionary edge case) from "over the border red" (a sauropod at 2.3 under
// a mammal bone fraction) at a glance. Grey is deliberately OFF the ramp — an
// unloaded manipulator is not "healthy support", it is not supporting
// anything, and green would read as the former.
const STRESS_UNLOADED = new THREE.Color("#7c848d");
const RAMP_LO = new THREE.Color("#2fbf4f");
const RAMP_MID = new THREE.Color("#e8d13a");
const RAMP_HI = new THREE.Color("#e03c28");
const RAMP_OVER = new THREE.Color("#3a0a2e");

function stressRamp(s: number): THREE.Color {
  const raw = Number.isFinite(s) ? Math.max(0, s) : 0;
  const c = new THREE.Color();
  if (raw >= 1) return c.copy(RAMP_HI).lerp(RAMP_OVER, Math.min(1, (raw - 1) / 2));
  if (raw <= 0.7) c.copy(RAMP_LO).lerp(RAMP_MID, raw / 0.7);
  else c.copy(RAMP_MID).lerp(RAMP_HI, (raw - 0.7) / 0.3);
  return c;
}

/** Which ledger row a bone chain belongs to. Digit bones are named
 *  `${legChain}d${k}` (skeleton.ts addDigits), so a leg owns its toes. */
function legForChain(sup: SupportDiagnostics, chain: string): LegSupport | undefined {
  return sup.legs.find((l) => chain === l.chain || chain.startsWith(`${l.chain}d`));
}

/** Stress colour for one bone chain. */
function chainStressColor(sup: SupportDiagnostics, chain: string): THREE.Color {
  const leg = legForChain(sup, chain);
  // An ungrounded limb carries nothing — grey, not green (see above). The
  // ledger cannot tell a relaxed ARM from a hind leg that just lost the
  // ground (both are `grounded:false, force:0`); the overlay's shrunken
  // support polygon and tipping arrow are what distinguish them.
  if (leg) return leg.grounded ? stressRamp(leg.stress) : STRESS_UNLOADED.clone();
  if (chain === "spine") return stressRamp(sup.chainStress.spine ?? 0);
  if (chain === "tail") return stressRamp(sup.chainStress.tail ?? 0);
  // The head IS the load the neck cantilever number measures, so the whole
  // head group wears it.
  if (chain === "neck" || chain === "head" || chain === "snout" || chain === "jaw" || chain === "nose") {
    return stressRamp(sup.chainStress.neck ?? 0);
  }
  return STRESS_UNLOADED.clone(); // tentacle chains / growths: no ledger row
}

/** Repaint the built mesh's colour attribute by per-bone stress.
 *
 *  The mesh is a SkinnedMesh and mesh.ts binds every vertex to one or two
 *  skeleton bones (`skinIndex` / `skinWeight`, bone index == `skel.bones`
 *  index, 1:1). So the vertex→bone→chain mapping is already in the geometry
 *  and the REAL SKIN gets tinted — no capsule overlay needed. */
function applyStressColors(skel: CreatureSkeleton): void {
  if (!built) return;
  const geo = built.mesh.geometry;
  const attr = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  const skin = geo.getAttribute("skinIndex") as THREE.BufferAttribute | undefined;
  const wts = geo.getAttribute("skinWeight") as THREE.BufferAttribute | undefined;
  if (!attr || !skin || !wts) return;
  const byBone = skel.bones.map((b) => chainStressColor(skel.support, b.chain));
  for (let i = 0; i < attr.count; i++) {
    // Dominant bind — a 50/50 seam vertex takes boneA, which keeps the seam
    // on the chain boundary instead of dithering it.
    const bi = wts.getX(i) >= 0.5 ? skin.getX(i) : skin.getY(i);
    const c = byBone[bi] ?? STRESS_UNLOADED;
    attr.setXYZ(i, c.r, c.g, c.b);
  }
  attr.needsUpdate = true;
}

// ── Ground overlay ───────────────────────────────────────────────────────
// One group holding the support polygon, the CoM marker + drop line, an
// upward force arrow per grounded foot, and (when the body is tipping) the
// horizontal lever from the CoM's ground point to the centre of pressure.
const stressOverlay = new THREE.Group();
stressOverlay.visible = false;
scene.add(stressOverlay);
const overlayDisposers: Array<() => void> = [];

function clearStressOverlay(): void {
  for (const d of overlayDisposers) d();
  overlayDisposers.length = 0;
  stressOverlay.clear();
}

/** ArrowHelper's line/cone geometries are MODULE-SHARED in three — disposing
 *  them would yank the buffers out from under every later arrow. Only the
 *  per-instance materials are ours to free. */
function addArrow(dir: THREE.Vector3, origin: THREE.Vector3, len: number, color: string): void {
  const head = Math.min(len * 0.3, len);
  const arrow = new THREE.ArrowHelper(dir.clone().normalize(), origin, Math.max(len, 1e-4), color, head, head * 0.5);
  // A diagnostic overlay must read THROUGH the body it diagnoses — a force
  // arrow hidden behind a thigh is the one you needed to see.
  for (const part of [arrow.line, arrow.cone]) {
    const m = part.material as THREE.Material;
    m.depthTest = false;
    part.renderOrder = 6;
  }
  overlayDisposers.push(() => {
    (arrow.line.material as THREE.Material).dispose();
    (arrow.cone.material as THREE.Material).dispose();
  });
  stressOverlay.add(arrow);
}

function addLine(pts: THREE.Vector3[], color: string, loop: boolean): void {
  if (pts.length < 2) return;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const obj = loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
  obj.renderOrder = 5;
  overlayDisposers.push(() => { geo.dispose(); mat.dispose(); });
  stressOverlay.add(obj);
}

/** Centre of pressure, Σ(force·foot)/Σforce over the grounded feet. The
 *  ledger does not expose it (physio.solveFootForces computes it internally
 *  and SupportDiagnostics drops it — see the phase-3 wishlist), so the lab
 *  re-derives it from the per-leg forces it does get. */
function centerOfPressure(sup: SupportDiagnostics): { x: number; z: number } | null {
  let fx = 0, fz = 0, sum = 0;
  for (const leg of sup.legs) {
    if (!leg.grounded || !leg.foot || !(leg.force > 0)) continue;
    fx += leg.force * leg.foot.x;
    fz += leg.force * leg.foot.z;
    sum += leg.force;
  }
  return sum > 1e-9 ? { x: fx / sum, z: fz / sum } : null;
}

function rebuildStressOverlay(skel: CreatureSkeleton): void {
  clearStressOverlay();
  stressOverlay.visible = stressView && groundOverlay;
  if (!stressOverlay.visible) return;
  const sup = skel.support;
  // Scale everything to the body so the overlay reads on a mouse and on a cow.
  const span = Math.max(
    skel.bounds.max.y - skel.bounds.min.y,
    skel.bounds.max.z - skel.bounds.min.z,
    0.05,
  );
  const Y = span * 0.004; // lift off the ground plane so it does not z-fight

  // 1) Support polygon over the grounded feet.
  const feet = sup.legs
    .filter((l) => l.grounded && l.foot)
    .map((l) => ({ x: l.foot!.x, z: l.foot!.z }));
  const hull = convexHull2D(feet);
  if (hull.length >= 2) {
    addLine(hull.map((p) => new THREE.Vector3(p.x, Y, p.z)), "#5fd0ff", hull.length >= 3);
  } else if (hull.length === 1) {
    // A single foot is a POINT of support — draw a tick so "one contact" is
    // visibly different from "no polygon drawn".
    const r = span * 0.02;
    addLine([new THREE.Vector3(hull[0].x - r, Y, hull[0].z), new THREE.Vector3(hull[0].x + r, Y, hull[0].z)], "#5fd0ff", false);
    addLine([new THREE.Vector3(hull[0].x, Y, hull[0].z - r), new THREE.Vector3(hull[0].x, Y, hull[0].z + r)], "#5fd0ff", false);
  }

  // 2) CoM marker + drop line. Red once the CoM is outside its support.
  const comColor = sup.body.supportMargin < 0 ? "#ff4433" : "#ffffff";
  const com = new THREE.Vector3(sup.body.com.x, sup.body.com.y, sup.body.com.z);
  const ball = new THREE.SphereGeometry(span * 0.022, 12, 8);
  const ballMat = new THREE.MeshBasicMaterial({ color: comColor, depthTest: false });
  const ballMesh = new THREE.Mesh(ball, ballMat);
  ballMesh.position.copy(com);
  ballMesh.renderOrder = 6;
  overlayDisposers.push(() => { ball.dispose(); ballMat.dispose(); });
  stressOverlay.add(ballMesh);
  addLine([com, new THREE.Vector3(com.x, Y, com.z)], comColor, false);

  // 3) One upward force arrow per grounded foot, length ∝ force / weight
  //    (so the arrows sum to a body-height's worth of arrow), tinted by the
  //    leg's own stress.
  const w = sup.body.weight > 0 ? sup.body.weight : 1;
  for (const leg of sup.legs) {
    if (!leg.grounded || !leg.foot || !(leg.force > 0)) continue;
    const len = (leg.force / w) * span * 0.9;
    addArrow(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(leg.foot.x, Y, leg.foot.z),
      len,
      `#${stressRamp(leg.stress).getHexString()}`,
    );
  }

  // 4) The tipping lever: CoM ground point → centre of pressure. Non-zero
  //    only when no non-negative foot force can balance the body (the
  //    handstand signature) — its length IS `body.tipping`.
  if (sup.body.tipping > 1e-6) {
    const cop = centerOfPressure(sup);
    if (cop) {
      const from = new THREE.Vector3(sup.body.com.x, Y, sup.body.com.z);
      const to = new THREE.Vector3(cop.x, Y, cop.z);
      const d = to.clone().sub(from);
      if (d.lengthSq() > 1e-12) addArrow(d, from, d.length(), "#ff7a18");
    }
  }
}

/** Upper edge of the VIABLE band — see the verdict note below. Deliberately
 *  above 1/SAFETY_FACTOR (≈0.36), the value a real line-conforming animal
 *  reads, so that such a body lands comfortably inside the band instead of on
 *  its boundary. */
const VIABLE_SIGMA = 0.5;

/** The numeric readout — body row, chain row, one row per limb. */
function updateStressReadout(sup: SupportDiagnostics | null): void {
  if (!stressReadoutEl) return;
  if (!sup) { stressReadoutEl.textContent = "(no build yet)"; return; }
  const n = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  /** Real mass, in whichever unit a person can picture it in. The proxy is
   *  π-dropped m³ and spans mouse-to-whale, so a fixed unit is unreadable at
   *  one end or the other. */
  const kg = (v: number): string =>
    !Number.isFinite(v) ? String(v)
      : v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} g`
      : v < 10 ? `${v.toFixed(2)} kg`
      : v < 1000 ? `${v.toFixed(1)} kg`
      : `${(v / 1000).toFixed(2)} t`;
  const lines: string[] = [];
  // 🚨 `sup.body.mass` IS ALREADY DENSITY-WEIGHTED — the ledger folds
  // `spine.density` into every bone's proxy mass — so `massKg` is called at
  // density 1 here. Multiplying by the dial again would double-count it.
  lines.push(
    `mass ${n(sup.body.mass, 3)} (${kg(massKg(sup.body.mass))})` +
    `   weight ${n(sup.body.weight, 3)}   g ${n(sup.body.gravity)}`,
  );
  lines.push(`density ${n(blueprint.spine.density)}× tissue`);
  // What it is CARRYING, kept on its own line and only when there is
  // something: body vs load is the whole question a load dial raises.
  if (sup.body.loadMass > 0) {
    const share = sup.body.mass > 0 ? (100 * sup.body.loadMass) / sup.body.mass : 0;
    lines.push(
      `load ${n(sup.body.loadMass, 3)} (${kg(massKg(sup.body.loadMass))}, ` +
      `${share.toFixed(0)}% of body)` +
      `   total ${kg(massKg(sup.body.mass + sup.body.loadMass))}`,
    );
  }
  // A REFUSED PICK-UP MUST SAY SO. The button used to no-op silently, which
  // reads as a bug; now the body's own reason is on the panel.
  if (lastRefusal) {
    lines.push(
      `REFUSED: ${lastRefusal.bind} σ ` +
      `${n(lastRefusal.bind === "stance" ? lastRefusal.stance : lastRefusal.carrier)}` +
      ` > ${n(lastRefusal.limit)}`,
    );
  }
  lines.push(`com  ${n(sup.body.com.x, 3)} ${n(sup.body.com.y, 3)} ${n(sup.body.com.z, 3)}`);
  lines.push(
    `tipping ${n(sup.body.tipping, 3)}   margin ${n(sup.body.supportMargin, 3)}`,
  );
  lines.push(
    `belly ${sup.body.bellyRest ? `REST (${n(sup.body.bellyShare)})` : "no"}` +
    `   standing ${sup.legs.filter((l) => l.grounded).length}/${sup.legs.length}`,
  );
  lines.push("");
  for (const [k, v] of Object.entries(sup.chainStress)) lines.push(`${k.padEnd(9)} σ ${n(v)}`);
  lines.push("");
  for (const leg of sup.legs) {
    const mark = leg.grounded ? "●" : leg.foot ? "○" : "×"; // × = cannot reach the ground
    // `ema` is the posture tax (1 = columnar pillar, >1 = muscles fighting a
    // moment through the same bone); `bind` is which failure mode set
    // `strength`, abbreviated so the row stays one screen wide —
    // C = crushing, B = Euler buckling (the slender-column mode).
    lines.push(
      `${leg.chain.padEnd(9)}${mark} F ${n(leg.force, 3).padStart(7)}` +
      // ⚖️ ema saturates at physio's EMA_MAX (1e4) on a limb with no lever at
      // all; printed in full it would blow the column apart, so cap the label.
      `  ema ${(leg.ema >= 100 ? "99+" : n(leg.ema)).padStart(5)}` +
      `  ${leg.bind === "buckle" ? "B" : "C"}` +
      `  σ ${n(leg.stress).padStart(5)}`,
    );
  }

  // ── VERDICT ────────────────────────────────────────────────────────────
  // 🚨 THE LOUDEST LINE, AND THE ONLY ONE THAT ANSWERS THE QUESTION SOMEONE
  // OPENED THIS PANEL WITH: could this body stand up in the real world?
  // Read off the WORST GROUNDED SUPPORT leg — a manipulator is allowed to be
  // off the ground and an ungrounded support leg carries no force, so neither
  // says anything about what the body is standing on.
  //
  // The bands are anchored on physio's own two fixed points, not on taste:
  //   • σ ≤ 0.5 — VIABLE. A real, Campione-line-conforming quadruped standing
  //     still reads 1/SAFETY_FACTOR ≈ 0.36, so the band has to CONTAIN that
  //     number with room on both sides — putting the cut exactly AT 0.36 made
  //     the shipped cat (0.364, i.e. a textbook-correct body) print "marginal"
  //     on a rounding error, which is worse than useless. 0.5 still leaves a
  //     2× margin, so nothing called viable here is anywhere near its limit.
  //   • σ ≤ 1 — MARGINAL. Standing is fine, but the body has eaten into the
  //     margin a real animal keeps for running, landing and stumbling.
  //   • σ ≤ SAFETY_FACTOR (2.75) — OVER CAPACITY. Past the conformance
  //     threshold: no animal is shaped like this, and it fails the moment it
  //     moves. (Still standing, though — σ = 1 is not a fracture threshold;
  //     `boneStressPa(1)` ≈ 1.8 MPa against cortical bone's ~200 MPa.)
  //   • above that — NOT VIABLE. Beyond even the whole dynamic margin; the
  //     legs are decorative.
  const worst = sup.legs
    .filter((l) => l.role === "support" && l.grounded)
    .reduce<LegSupport | null>((a, l) => (a && a.stress >= l.stress ? a : l), null);
  lines.push("");
  if (!worst) {
    lines.push(
      sup.body.bellyRest
        ? "VERDICT: on its belly — no grounded support leg to judge"
        : "VERDICT: no grounded support leg",
    );
  } else {
    const s = worst.stress;
    const verdict =
      s <= VIABLE_SIGMA ? "viable"
        : s <= 1 ? "marginal — standing on its safety margin"
        : s <= SAFETY_FACTOR ? "over capacity"
        : "NOT viable";
    lines.push(
      `VERDICT: σ ${n(s)} — ${verdict}` +
      `   (${worst.chain}, ${(boneStressPa(s) / 1e6).toFixed(2)} MPa bone)`,
    );
  }

  stressReadoutEl.textContent = lines.join("\n");
}

/** Record one build's ledger and refresh everything that shows it. Called
 *  from rebuildGeometry, so the static build, the gait build and the
 *  animator tick all keep the readout, overlay and `stressReport()` current. */
function publishSupport(skel: CreatureSkeleton): void {
  lastSupport = skel.support;
  updateStressReadout(lastSupport);
  rebuildStressOverlay(skel);
}

// Polygon picker (debug): click a triangle → highlight it, show + copy its
// face/vertex indices, so a specific polygon can be named exactly. The
// three vertices are labeled with their indices ON the model (projected
// each frame so they track the camera).
let pickerOn = false;
let pickHighlight: THREE.Object3D | null = null;
let pickedVerts: { idx: number; pos: THREE.Vector3 }[] | null = null;
const pickInfoEl = document.createElement("div");
pickInfoEl.style.cssText =
  "position:fixed;left:10px;bottom:10px;z-index:20;font:12px monospace;" +
  "color:#ffd0ff;background:#000a;padding:4px 8px;border-radius:4px;display:none;white-space:pre";
document.body.appendChild(pickInfoEl);
// A 2D overlay over the WebGL canvas for the vertex-index labels.
const labelCanvas = document.createElement("canvas");
labelCanvas.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;z-index:19;";
document.body.appendChild(labelCanvas);
const labelCtx = labelCanvas.getContext("2d")!;

function drawPickLabels(): void {
  const w = window.innerWidth, h = window.innerHeight;
  if (labelCanvas.width !== w) labelCanvas.width = w;
  if (labelCanvas.height !== h) labelCanvas.height = h;
  labelCtx.clearRect(0, 0, w, h);
  if (!pickedVerts) return;
  labelCtx.font = "bold 13px monospace";
  labelCtx.textAlign = "center";
  labelCtx.textBaseline = "middle";
  const _p = new THREE.Vector3();
  for (const { idx, pos } of pickedVerts) {
    _p.copy(pos).project(camera);
    if (_p.z > 1) continue; // behind the camera
    const sx = (_p.x * 0.5 + 0.5) * w;
    const sy = (-_p.y * 0.5 + 0.5) * h;
    // Vertex dot.
    labelCtx.fillStyle = "#ff00ff";
    labelCtx.beginPath();
    labelCtx.arc(sx, sy, 3, 0, Math.PI * 2);
    labelCtx.fill();
    // Index label, offset up-right, with a dark halo for legibility.
    const tx = sx + 12, ty = sy - 10;
    labelCtx.lineWidth = 3;
    labelCtx.strokeStyle = "#000";
    labelCtx.strokeText(String(idx), tx, ty);
    labelCtx.fillStyle = "#ffe0ff";
    labelCtx.fillText(String(idx), tx, ty);
  }
}

interface PickResult {
  tri: number;
  verts: [number, number, number];
  positions: [number, number, number][];
  point: [number, number, number];
  /** Construction sections of the three vertices (provenance). */
  sections: [string, string, string];
}

function clearPickHighlight(): void {
  if (pickHighlight) {
    scene.remove(pickHighlight);
    pickHighlight.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    pickHighlight = null;
  }
  pickedVerts = null;
  if (labelCanvas.width) labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
}

function pickAtNdc(nx: number, ny: number): PickResult | null {
  if (!built) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const hit = ray.intersectObject(built.mesh, false)[0];
  if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
  const g = built.mesh.geometry;
  const idx = g.getIndex()!;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const verts: [number, number, number] = [
    idx.getX(hit.faceIndex * 3), idx.getX(hit.faceIndex * 3 + 1), idx.getX(hit.faceIndex * 3 + 2),
  ];
  const positions = verts.map((v) => [
    +pos.getX(v).toFixed(4), +pos.getY(v).toFixed(4), +pos.getZ(v).toFixed(4),
  ]) as [number, number, number][];
  // Highlight: the picked triangle, drawn on top of everything.
  clearPickHighlight();
  const hg = new THREE.BufferGeometry();
  hg.setAttribute("position", new THREE.Float32BufferAttribute(positions.flat(), 3));
  hg.setIndex([0, 1, 2]);
  const fill = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({
    color: "#ff00ff", transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide,
  }));
  fill.renderOrder = 999;
  const edge = new THREE.LineLoop(hg.clone(), new THREE.LineBasicMaterial({
    color: "#ff00ff", depthTest: false,
  }));
  edge.renderOrder = 1000;
  const group = new THREE.Group();
  group.add(fill, edge);
  scene.add(group);
  pickHighlight = group;
  // Remember the three verts (world space — the mesh sits at the origin, so
  // geometry-local positions are world positions) for the on-model labels.
  pickedVerts = verts.map((v, i) => ({ idx: v, pos: new THREE.Vector3(...positions[i]) }));
  const sec = (v: number): string => built!.sections[v] || "(none)";
  return {
    tri: hit.faceIndex, verts, positions,
    point: [+hit.point.x.toFixed(4), +hit.point.y.toFixed(4), +hit.point.z.toFixed(4)],
    sections: [sec(verts[0]), sec(verts[1]), sec(verts[2])],
  };
}

function handlePick(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const r = pickAtNdc(nx, ny);
  if (!r) {
    pickInfoEl.textContent = "picker: no polygon hit";
    pickInfoEl.style.display = "block";
    return;
  }
  const uniqueSecs = [...new Set(r.sections)].join(", ");
  const text = `tri ${r.tri} · ${uniqueSecs}\n` +
    r.positions.map((p, i) => `v${r.verts[i]} [${r.sections[i]}] (${p.join(", ")})`).join("\n");
  pickInfoEl.textContent = text + "\n(copied)";
  pickInfoEl.style.display = "block";
  console.log("[picker]", JSON.stringify(r));
  try { void navigator.clipboard.writeText(JSON.stringify(r)); } catch { /* headless */ }
}

{
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!pickerOn || !down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    if (dx * dx + dy * dy > 25) return; // that was an orbit drag, not a click
    handlePick(e);
  });
}
const gaitMisc = { cadence: 1.1 }; // gait cycles per second
const gaitParams: GaitParams = { ...DEFAULT_GAIT };
// Animator: the full controller (stand/walk/run + pick up / put down).
// When on, it owns gait + posture + pose each frame; the manual walk-gait
// section above is ignored.
let animOn = false;
let animator: CreatureAnimator | null = null;
let animFrame: AnimFrame | null = null;
const animMisc = { speed: 0 };
const savedAnimPosture = { bodyPitch: 0, bodyHeight: 0 };
// The prop the creature picks up: a crate on the pad. Size is adjustable —
// past about a palm-width the animator switches to a two-handed lift.
let objectMesh: THREE.Mesh | null = null;
let objectMeshSize = 0;
const objectMisc = { size: 0.1 };
let objectPos = new THREE.Vector3(0.25, objectMisc.size / 2, 0.35);

function ensureObject(): THREE.Mesh {
  if (objectMesh && objectMeshSize !== objectMisc.size) {
    objectMesh.geometry.dispose();
    objectMesh.geometry = new THREE.BoxGeometry(objectMisc.size, objectMisc.size, objectMisc.size);
    objectMeshSize = objectMisc.size;
    objectPos.y = objectMisc.size / 2; // keep the crate resting on the pad
  }
  if (!objectMesh) {
    objectMesh = new THREE.Mesh(
      new THREE.BoxGeometry(objectMisc.size, objectMisc.size, objectMisc.size),
      propMaterial("#a2703f", { roughness: 0.8 }),
    );
    objectMeshSize = objectMisc.size;
    scene.add(objectMesh);
  }
  objectMesh.position.copy(objectPos);
  return objectMesh;
}

// One animator tick: it owns gait + posture + hand targets; we build the
// skeleton from its frame, then feed the result back (observe) so the
// reach can keep crouching until the hand actually arrives. Shared by the
// live loop and the deterministic screenshot hook.
let animPaused = false;
/** The crate's proxy mass: auto from its size, times the panel's multiplier. */
function objectMass(): number {
  return objectMassFromSize(objectMisc.size) * physMisc.objectMass;
}

/** Fire a pick-up and REMEMBER A REFUSAL (the readout shows it). */
function tryPickUp(): void {
  if (!animator) return;
  objectPos.y = objectMisc.size / 2;
  const ok = animator.pickUp(
    { x: objectPos.x, y: objectPos.y, z: objectPos.z }, objectMisc.size, objectMass());
  lastRefusal = ok ? null : animator.lastRefusal();
  updateStressReadout(lastSupport);
}

function stepAnim(dt: number): void {
  if (!animator) return;
  animator.setSpeed(animMisc.speed);
  animator.pattern = gaitParams.pattern;
  // The pack dial is a fraction of the creature's OWN mass, so it needs the
  // ledger — before the first build there is nothing to take a fraction of.
  animator.setBackLoad(physMisc.backLoad > 0 ? physMisc.backLoad * (lastSupport?.body.mass ?? 0) : 0);
  animFrame = animator.update(dt);
  blueprint.posture.bodyPitch = animFrame.posture.bodyPitch;
  blueprint.posture.bodyHeight = animFrame.posture.bodyHeight;
  const skel = rebuildGeometry();
  animator.observe(skel);
  const obj = ensureObject();
  const chains = animFrame.handChains ?? [];
  if (animFrame.holding && chains.length > 0) {
    // One hand: the object rides the hand tip. Two hands: it hangs between
    // the bracketing palms.
    const tips = chains.map((c) => limbTip(skel, c)).filter((t): t is NonNullable<typeof t> => !!t);
    if (tips.length > 0) {
      obj.position.set(
        tips.reduce((s, t) => s + t.x, 0) / tips.length,
        tips.reduce((s, t) => s + t.y, 0) / tips.length,
        tips.reduce((s, t) => s + t.z, 0) / tips.length,
      );
    }
  } else {
    obj.position.copy(objectPos);
  }
}

function startAnimator(): void {
  animator = new CreatureAnimator(blueprint);
  animator.setSpeed(animMisc.speed);
  animator.pattern = gaitParams.pattern;
  // Rest the object a bit ahead of the creature, scaled to its size. A
  // hand reach comes in from the side; a MOUTH (beak) reach dives on the
  // midline, a little further out — the lab stands in for the host that
  // would normally walk the creature up to the object.
  const L = blueprint.spine.torsoLengthM;
  if (animator.hasHands()) {
    objectPos = new THREE.Vector3(0.3 * L, objectMisc.size / 2, 0.45 * L);
  } else {
    objectPos = new THREE.Vector3(0, objectMisc.size / 2, 0.7 * L);
  }
  ensureObject();
}

const statsEl = document.getElementById("lab-stats")!;

function disposeBuilt(): void {
  if (built) {
    scene.remove(built.mesh);
    built.mesh.geometry.dispose();
    (built.mesh.material as THREE.Material).dispose();
    built = null;
  }
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.dispose();
    skeletonHelper = null;
  }
  // A rebuild renumbers vertices; a stale pick would label the wrong spot.
  clearPickHighlight();
}

function disposeLodPreview(): void {
  if (lodObject) {
    scene.remove(lodObject);
    lodObject = null;
  }
  for (const d of lodDisposers) d();
  lodDisposers = [];
}

// Rebuild ONLY the geometry from the current blueprint — cheap enough to run
// every frame, which is how the posture animation re-solves the strain pose
// (legs plant/lift, knees fold/straighten) as the torso target moves.
function rebuildGeometry(): CreatureSkeleton {
  disposeBuilt();
  disposeLodPreview();
  // The BODY the age scrub asks for. `agePlantBody` returns the authored
  // object itself at age 1, so every path below is untouched at rest.
  // 🌱 It is the WORLD's ager too (creature-model.ts `dressedBlueprint`), so
  // the lab and the live twin draw the same plant at the same age — including
  // the nub: it shrinks the 0.1 m torso with the plant and compensates the
  // stem ratio, so the stem length is exactly `ageGrowths`' own.
  const bp = agePlantBody(blueprint, plantAge);
  // Show the soil plane when a root vegetable is present (its body grows
  // down through it). The plant nub grounds at y≈0, so the soil sits there.
  soilPlane.visible = blueprint.growths.some((gr) => gr.type === "root");
  if (lodPreview !== "off") {
    // Static-kind preview: what a scattered instance of this blueprint
    // would render as at mid range (LOD1) or far range (impostor).
    const skel = buildSkeleton(bp, undefined, undefined, undefined, physEnv());
    publishSupport(skel);
    const lods = buildPlantLods(bp);
    lodDisposers.push(() => lods.dispose());
    if (lodPreview === "stick") {
      const fig = creatureSticks(skel, bp);
      const geom = buildStickGeometry(fig);
      const mat = stickMaterial(); // unlit tier — `celShading` has no effect here
      const mesh = new THREE.Mesh(geom, mat);
      lodDisposers.push(() => geom.dispose(), () => mat.dispose());
      lodObject = mesh;
      statsEl.textContent =
        `stick · ${fig.segments.length} capsules · ${geom.getAttribute("position").count} verts · ` +
        `${geom.getIndex()!.count / 3} tris (LOD1: ${lods.lod1.vertices} verts)`;
    } else if (lodPreview === "impostor") {
      const imp = bakePlantImpostor(renderer, lods, bp);
      const mesh = makeImpostorMesh(imp);
      lodDisposers.push(() => imp.dispose(), () => mesh.geometry.dispose(), () => (mesh.material as THREE.Material).dispose());
      lodObject = mesh;
      statsEl.textContent = `impostor · ${mesh.geometry.getAttribute("position").count} verts · baked 256²`;
    } else {
      const mat = plantMaterial();
      const mesh = new THREE.Mesh(lods.lod1.geometry, mat);
      lodDisposers.push(() => mat.dispose());
      lodObject = mesh;
      statsEl.textContent = `LOD1 · ${lods.lod1.vertices} verts · ${Math.round(lods.lod1.triangles)} tris (LOD0: ${lods.lod0.vertices})`;
    }
    scene.add(lodObject);
    return skel;
  }
  const skel = animOn
    ? buildSkeleton(bp, animFrame?.gait, animFrame?.pose, undefined, physEnv())
    : buildSkeleton(
        bp,
        walking ? gaitParams : undefined,
        mouthMisc.gape > 0 ? { gape: mouthMisc.gape } : undefined,
        undefined,
        physEnv(),
      );
  publishSupport(skel);
  built = buildCreatureMesh(skel, bp, { bareSkull, toon: celShading, debugTags: true });
  (built.mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
  if (colorBySection) applySectionColors();
  else sectionLegendEl.style.display = "none";
  // Stress wins over color-by-section when both are on — they share the one
  // vertex-colour attribute and the stress view is the more specific ask.
  if (stressView) applyStressColors(skel);
  scene.add(built.mesh);
  if (showSkeleton) {
    skeletonHelper = new THREE.SkeletonHelper(built.mesh);
    scene.add(skeletonHelper);
  }
  const s = built.stats;
  statsEl.textContent =
    `${s.vertices} verts · ${s.triangles} tris · ${s.bones} bones · ${s.buildMs.toFixed(1)} ms`;
  return skel;
}

function rebuild(): void {
  const skel = rebuildGeometry();
  if (autoFrame) {
    const size = Math.max(
      skel.bounds.max.x - skel.bounds.min.x,
      skel.bounds.max.y - skel.bounds.min.y,
      skel.bounds.max.z - skel.bounds.min.z,
    ) + skel.maxTorsoRadius * 2;
    const midY = (skel.bounds.max.y + skel.bounds.min.y) / 2;
    controls.target.set(0, midY, 0);
    const dist = Math.max(size * 1.6, 0.5);
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.5, 1);
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist);
  }
  syncJson();
}

// ── Control panel ────────────────────────────────────────────────────────
// Sliders are generated from the RANGES tables — the single source of
// truth shared with clampBlueprint/validateBlueprint — so new blueprint fields
// appear here automatically.

const controlsRoot = document.getElementById("lab-controls")!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function section(title: string, open = false): HTMLElement {
  const details = el("details", undefined, controlsRoot);
  if (open) details.open = true;
  el("summary", undefined, details).textContent = title;
  return details;
}

const fmt = (v: number, r: FieldRange): string =>
  r.int ? v.toFixed(0) : Math.abs(r.max - r.min) > 5 ? v.toFixed(1) : v.toFixed(2);

/** Slider bound to obj[key], rebuilds on input. */
function slider(
  parent: HTMLElement,
  label: string,
  obj: Record<string, number>,
  key: string,
  range: FieldRange,
): void {
  const row = el("div", "lab-row", parent);
  el("label", undefined, row).textContent = label;
  const input = el("input", undefined, row);
  input.type = "range";
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step ?? (range.int ? 1 : (range.max - range.min) / 200));
  input.value = String(obj[key]);
  const val = el("span", "val", row);
  val.textContent = fmt(obj[key], range);
  input.addEventListener("input", () => {
    let v = Number(input.value);
    if (range.int) v = Math.round(v);
    obj[key] = v;
    val.textContent = fmt(v, range);
    rebuild();
  });
}

/** @param custom keys the caller ships a DEDICATED widget for (see the
 *  torso-length vernier below). The auto-pass emits the custom row IN PLACE of
 *  the generated one, at the field's own position — it must never emit both,
 *  or two widgets write the same field and neither shows the other's value. */
function sliderSection(
  title: string,
  obj: Record<string, number>,
  ranges: Record<string, FieldRange>,
  open = false,
  custom: Record<string, (parent: HTMLElement) => void> = {},
): void {
  const s = section(title, open);
  for (const [key, range] of Object.entries(ranges)) {
    const own = custom[key];
    if (own) own(s);
    else slider(s, key, obj, key, range);
  }
}

// ── Torso length: coarse + fine vernier ──────────────────────────────────
// 🚨 WHY THIS FIELD GETS ITS OWN ROW AND NOTHING ELSE DOES. `torsoLengthM`
// spans 0.05 m (a mouse) to 30 m (a whale) — near three orders of magnitude —
// and the auto-generated slider is LINEAR over that range with step 0.05. Two
// things break at once:
//   • every small creature lives in the first 0.5% of the track, so a mouse, a
//     cat and a dog are all within four pixels of each other; and
//   • the shared `fmt()` prints ONE decimal whenever max-min > 5, so 0.05,
//     0.07 and 0.12 all read "0.1" and the slider looks stuck at its floor.
//     (It never was: the value moved, only the label lied.)
//
// The scheme: a LOG-SCALED coarse slider picks the ballpark in equal
// multiplicative steps, and a LINEAR fine slider trims within ±one coarse step
// of the coarse anchor. Log coarse because "next size up" is a RATIO, not a
// number of metres — one notch is +11% whether you are at 0.05 m or at 20 m;
// linear fine because once the ballpark is chosen you are thinking in metres
// again. `blueprint.spine.torsoLengthM` stays the single source of truth: the
// coarse thumb marks the anchor it last set, the fine thumb marks the trim,
// and BOTH rows print the one true value.
//
// 🚨 THE 0.05 m FLOOR IS `clampBlueprint`'s, NOT OURS. Every window either
// slider offers is clamped into [min, max] before it reaches the field, so the
// fine slider can never write a value the clamp would silently pull back —
// which would desync the thumb from the model on the very next rebuild.
const TORSO_COARSE_NOTCHES = 64;

/** Metres, printed with enough decimals to tell 0.05 from 0.07 from 0.12 —
 *  the shared `fmt()` cannot, and is not ours to change (it is right for the
 *  other ~80 dials). Trailing zeros trimmed so "30" stays "30". */
function fmtLenM(v: number): string {
  const d = v < 0.5 ? 4 : v < 5 ? 3 : 2;
  return `${v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "")} m`;
}

function torsoLengthRow(parent: HTMLElement): void {
  const range = SPINE_RANGES.torsoLengthM;
  const lnMin = Math.log(range.min);
  const lnMax = Math.log(range.max);
  const clampLen = (v: number): number => Math.min(range.max, Math.max(range.min, v));
  const notchToM = (t: number): number => clampLen(Math.exp(lnMin + ((lnMax - lnMin) * t) / TORSO_COARSE_NOTCHES));
  const mToNotch = (v: number): number =>
    Math.round((TORSO_COARSE_NOTCHES * (Math.log(clampLen(v)) - lnMin)) / (lnMax - lnMin));
  /** One coarse notch as a ratio (≈1.105) — the half-width of the fine window
   *  on each side, so the fine slider can always reach the neighbouring
   *  anchors and no value is unreachable between two notches. */
  const notchRatio = Math.exp((lnMax - lnMin) / TORSO_COARSE_NOTCHES);

  const coarseRow = el("div", "lab-row", parent);
  el("label", undefined, coarseRow).textContent = "torsoLengthM";
  const coarse = el("input", undefined, coarseRow);
  coarse.type = "range";
  coarse.min = "0";
  coarse.max = String(TORSO_COARSE_NOTCHES);
  coarse.step = "1";
  const coarseVal = el("span", "val", coarseRow);

  const fineRow = el("div", "lab-row", parent);
  el("label", undefined, fineRow).textContent = "  ⤷ fine";
  const fine = el("input", undefined, fineRow);
  fine.type = "range";
  const fineVal = el("span", "val", fineRow);

  /** Re-window the fine slider around `anchor` and put both thumbs and both
   *  labels where the model actually is. Called on every write from either
   *  slider, so moving one always updates the other's readout. */
  const sync = (anchor: number): void => {
    const v = blueprint.spine.torsoLengthM;
    const lo = clampLen(anchor / notchRatio);
    const hi = clampLen(anchor * notchRatio);
    fine.min = String(lo);
    fine.max = String(hi);
    fine.step = String(Math.max(1e-5, (hi - lo) / 200));
    fine.value = String(Math.min(hi, Math.max(lo, v)));
    coarse.value = String(mToNotch(anchor));
    coarseVal.textContent = fmtLenM(v);
    fineVal.textContent = fmtLenM(v);
  };

  coarse.addEventListener("input", () => {
    const v = notchToM(Number(coarse.value));
    blueprint.spine.torsoLengthM = v;
    sync(v);
    rebuild();
  });
  fine.addEventListener("input", () => {
    blueprint.spine.torsoLengthM = clampLen(Number(fine.value));
    // Keep the fine WINDOW anchored where the coarse thumb is: a trim must not
    // drag its own window along under the cursor.
    sync(notchToM(Number(coarse.value)));
    rebuild();
  });

  sync(notchToM(mToNotch(blueprint.spine.torsoLengthM)));
}

function colorRow(parent: HTMLElement, label: string, key: keyof Blueprint["skin"]): void {
  const row = el("div", "lab-row", parent);
  el("label", undefined, row).textContent = label;
  const input = el("input", undefined, row);
  input.type = "color";
  input.value = blueprint.skin[key];
  input.addEventListener("input", () => {
    blueprint.skin[key] = input.value;
    rebuild();
  });
}

/** A labelled <select> over a string union — used by the growths grammar rows
 *  and by the view section's LOD preview. Rebuilds on change like every other
 *  control here, so a caller never has to. */
function enumSel<T extends string>(
  parent: HTMLElement, options: readonly T[], value: T, set: (v: T) => void,
): void {
  const sel = el("select", undefined, parent) as HTMLSelectElement;
  for (const o of options) {
    const opt = el("option", undefined, sel) as HTMLOptionElement;
    opt.value = o;
    opt.textContent = o;
    if (o === value) opt.selected = true;
  }
  sel.addEventListener("change", () => { set(sel.value as T); rebuild(); });
}

// ── Species save / load ──────────────────────────────────────────────────
// The store lives in the DEV SERVER (games/creature-lab/lab-store.ts), which
// rewrites shared/world-engine/creatures/lab-blueprints.ts. The built page has
// no server behind it, so every call here reports the failure plainly and
// leaves export/import as the way out — it never pretends a save landed.

function setStatus(text: string, isError = false): void {
  statusText = text;
  statusIsError = isError;
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? "" : "#9fd6a0";
}

const STORE_ROUTE = "/api/lab-blueprints";

async function saveSpecies(id: string, bp: Blueprint): Promise<void> {
  setStatus(`saving "${id}"…`);
  try {
    const res = await fetch(STORE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: id, blueprint: bp }),
    });
    const data = (await res.json()) as { error?: string; count?: number };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`saved "${id}" → lab-blueprints.ts (${data.count} overrides)`);
  } catch (err) {
    setStatus(
      `save failed (dev server only): ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

/** Drop a species' lab override, so the registry falls back to its authored
 *  body again. The panel then reloads whatever the registry now says. */
async function revertSpecies(id: string): Promise<void> {
  try {
    const res = await fetch(STORE_ROUTE, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: id }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`reverted "${id}" — reload to see the authored body`);
  } catch (err) {
    setStatus(
      `revert failed (dev server only): ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

function buildPanel(): void {
  controlsRoot.innerHTML = "";
  statusEl = null;

  // Creature mods — the optional world modifiers (creatures/mod-library.ts) a
  // world template declares in `game.mods`. Switching one on here does EXACTLY
  // what a world declaring it does (`applyWorldCreatureMods`): derived species
  // join the registry below, and appearance mods reshape every body that is
  // built from here on. That is the point of putting them in the lab — the
  // thing being checked is the thing that ships.
  {
    const s = section("mods", true);
    for (const mod of listCreatureMods()) {
      const row = el("div", "lab-row", s);
      const lbl = el("label", undefined, row);
      lbl.textContent = mod.id;
      lbl.title = mod.description;
      const input = el("input", undefined, row);
      input.type = "checkbox";
      input.checked = modIds.includes(mod.id);
      input.addEventListener("change", () => {
        // Declaration ORDER is semantic (mods compose left to right), so the
        // set is rebuilt in library order rather than push/splice order.
        modIds = listCreatureMods()
          .map((m) => m.id)
          .filter((id) => (id === mod.id ? input.checked : modIds.includes(id)));
        const { derived } = applyWorldCreatureMods(modIds);
        // Re-read the loaded body under the new mod set. Guarded because
        // `speciesId` is also the editable SAVE TARGET, so it may be a name
        // the registry never had — or a derived row that just went away with
        // its mod. Either way, keep what is on screen rather than throwing.
        if (speciesId && getSpecies(speciesId)) blueprint = loadSpeciesBlueprint(speciesId);
        buildPanel();
        rebuild();
        setStatus(
          modIds.length
            ? `mods: ${modIds.join(", ")} — ${derived.length} derived species`
            : "mods: none (the authored registry)",
        );
      });
    }
    // The lab EDITS what it shows, and an appearance mod is a transform over
    // the authored body — so a save while one is on would write the modded
    // body back over the authored row. Say so where the button is.
    if (activeCreatureMods().some((m) => m.appearance)) {
      const warn = el("div", "lab-row", s);
      warn.textContent = "⚠ appearance mods reshape the loaded body — \"save to species\" would store the MODDED one";
      warn.style.color = "#d8b45a";
    }
  }

  // Species — the REGISTRY the game itself builds from (species.ts), so what
  // is tuned here is what a town spawns, not a look-alike. Bodiless and stub
  // species are listed but disabled: they have no blueprint on purpose, and
  // clamping their empty record would invent a default body for them.
  //
  // "save to species" writes the current blueprint to lab-blueprints.ts via
  // the dev server, which the registry applies LAST — so a save takes effect
  // on the next reload with no copy-paste. Export/import cover the built page,
  // where there is no dev server behind the fetch.
  {
    const s = section("species", true);
    const row = el("div", "lab-row", s);
    el("label", undefined, row).textContent = "load";
    const sel = el("select", undefined, row) as HTMLSelectElement;
    const ph = el("option", undefined, sel) as HTMLOptionElement;
    ph.value = "";
    ph.textContent = "— pick a species —";
    const byKind = new Map<string, Species[]>();
    for (const sp of listSpecies()) {
      const list = byKind.get(sp.kind) ?? [];
      list.push(sp);
      byKind.set(sp.kind, list);
    }
    for (const [kind, list] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
      const grp = el("optgroup", undefined, sel) as HTMLOptGroupElement;
      grp.label = kind;
      for (const sp of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
        const opt = el("option", undefined, grp) as HTMLOptionElement;
        const drawable = !sp.stub && !sp.bodiless;
        opt.value = sp.id;
        // A mod-derived row is marked, so a body that only exists because a
        // mod is on can never be mistaken for an authored species.
        const from = (sp as { fromMod?: string }).fromMod;
        const tag = from ? ` [${from}]` : "";
        opt.textContent = drawable ? `${sp.id}${tag}` : `${sp.id}${tag} (no body)`;
        opt.disabled = !drawable;
        if (sp.id === speciesId) opt.selected = true;
      }
    }
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      blueprint = loadSpeciesBlueprint(sel.value);
      speciesId = sel.value;
      buildPanel();
      rebuild();
      setStatus(`loaded species "${speciesId}"`);
    });

    // Curated showcase blueprints (creatures/examples.ts) — worked examples
    // that back the registry entries, browsable on their own.
    const exRow = el("div", "lab-row", s);
    el("label", undefined, exRow).textContent = "example";
    const exSel = el("select", undefined, exRow) as HTMLSelectElement;
    const exPh = el("option", undefined, exSel) as HTMLOptionElement;
    exPh.value = "";
    exPh.textContent = "— pick an example —";
    for (const ex of CREATURE_EXAMPLES) {
      const opt = el("option", undefined, exSel) as HTMLOptionElement;
      // The option's VALUE is the species id (the join key); its label is the
      // worked example's title.
      opt.value = ex.id;
      opt.textContent = ex.title;
    }
    exSel.addEventListener("change", () => {
      const ex = CREATURE_EXAMPLES.find((e) => e.id === exSel.value);
      if (!ex) return;
      blueprint = clampBlueprint(ex.blueprint);
      buildPanel();
      rebuild();
      setStatus(`loaded example "${ex.title}"`);
    });

    // Save target — defaults to whatever was loaded, editable so a tweak can
    // be saved under a NEW species id without clobbering the original.
    const nameRow = el("div", "lab-row", s);
    el("label", undefined, nameRow).textContent = "save as";
    const nameInput = el("input", undefined, nameRow) as HTMLInputElement;
    nameInput.type = "text";
    nameInput.placeholder = "species id";
    nameInput.value = speciesId;
    nameInput.addEventListener("change", () => { speciesId = nameInput.value.trim(); });

    const btnRow = el("div", "lab-row", s);
    const save = el("button", undefined, btnRow);
    save.textContent = "save to species";
    save.addEventListener("click", () => {
      const id = nameInput.value.trim();
      if (!id) { setStatus("save needs a species id", true); return; }
      speciesId = id;
      void saveSpecies(id, blueprint);
    });
    const revert = el("button", undefined, btnRow);
    revert.textContent = "revert";
    revert.addEventListener("click", () => {
      const id = nameInput.value.trim();
      if (!id) return;
      void revertSpecies(id);
    });

    const fileRow = el("div", "lab-row", s);
    const dl = el("button", undefined, fileRow);
    dl.textContent = "export .json";
    dl.addEventListener("click", () => {
      const id = nameInput.value.trim() || "creature";
      const blob = new Blob([JSON.stringify({ ...blueprint, name: id }, null, 2)],
        { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${id}.blueprint.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(`exported ${a.download}`);
    });
    const up = el("button", undefined, fileRow);
    up.textContent = "import .json";
    up.addEventListener("click", () => {
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "application/json,.json";
      picker.addEventListener("change", () => {
        const f = picker.files?.[0];
        if (!f) return;
        void f.text().then((text) => {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            blueprint = clampBlueprint(parsed);
            if (typeof parsed.name === "string") speciesId = parsed.name;
            buildPanel();
            rebuild();
            setStatus(`imported ${f.name}`);
          } catch (err) {
            setStatus(`import failed: ${err instanceof Error ? err.message : String(err)}`, true);
          }
        });
      });
      picker.click();
    });

    statusEl = el("div", "lab-errors", s);
    statusEl.textContent = statusText;
    statusEl.style.color = statusIsError ? "" : "#9fd6a0";
  }

  // Seed / re-roll.
  {
    const s = section("seed", true);
    const row = el("div", "lab-row", s);
    el("label", undefined, row).textContent = "seed";
    const input = el("input", undefined, row);
    input.type = "number";
    input.value = String(seed);
    input.addEventListener("change", () => {
      seed = Math.floor(Number(input.value)) || 0;
    });
    const row2 = el("div", "lab-row", s);
    const roll = el("button", undefined, row2);
    roll.textContent = "generate from seed";
    roll.addEventListener("click", () => {
      blueprint = randomBlueprint(seed);
      buildPanel();
      rebuild();
    });
    const next = el("button", undefined, row2);
    next.textContent = "next seed";
    next.addEventListener("click", () => {
      seed += 1;
      input.value = String(seed);
      blueprint = randomBlueprint(seed);
      buildPanel();
      rebuild();
    });
    const reset = el("button", undefined, row2);
    reset.textContent = "default";
    reset.addEventListener("click", () => {
      blueprint = defaultBlueprint();
      buildPanel();
      rebuild();
    });
  }

  // `torsoLengthM` swaps its generated slider for the coarse+fine vernier, in
  // place (see `torsoLengthRow`). `density` is NOT special-cased: it is in
  // SPINE_RANGES, so the auto-pass already dials it.
  sliderSection(
    "spine",
    blueprint.spine as unknown as Record<string, number>,
    SPINE_RANGES,
    true,
    { torsoLengthM: torsoLengthRow },
  );

  // Body profile (tagmata) — pinch/bulge control points along the trunk.
  // An array, so it isn't auto-slidered; it gets a dedicated editor.
  {
    const s = section("body profile (tagmata)");
    blueprint.spine.profile.forEach((pt, i) => {
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = `point ${i}`;
      const remove = el("button", "danger", row);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { blueprint.spine.profile.splice(i, 1); buildPanel(); rebuild(); });
      slider(s, "  at", pt as unknown as Record<string, number>, "at", PROFILE_POINT_RANGES.at);
      slider(s, "  scale", pt as unknown as Record<string, number>, "scale", PROFILE_POINT_RANGES.scale);
    });
    if (blueprint.spine.profile.length < MAX_PROFILE_POINTS) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add point";
      add.addEventListener("click", () => {
        blueprint.spine.profile.push({ at: 0.5, scale: 0.6 });
        buildPanel();
        rebuild();
      });
    }
  }

  sliderSection("neck", blueprint.neck as unknown as Record<string, number>, NECK_RANGES);
  sliderSection("tail", blueprint.tail as unknown as Record<string, number>, TAIL_RANGES);
  sliderSection("head", blueprint.head as unknown as Record<string, number>, HEAD_RANGES);
  sliderSection("posture", blueprint.posture as unknown as Record<string, number>, POSTURE_RANGES);

  // Animator — the full controller (animation.ts): one speed dial from
  // standing (idle sway) through walking to running, plus pick-up /
  // put-down of the crate. Owns gait + posture + pose while enabled.
  {
    const s = section("animator", true);
    const row0 = el("div", "lab-row", s);
    el("label", undefined, row0).textContent = "enable";
    const cb = el("input", undefined, row0);
    cb.type = "checkbox";
    cb.checked = animOn;
    cb.addEventListener("change", () => {
      animOn = cb.checked;
      if (animOn) {
        savedAnimPosture.bodyPitch = blueprint.posture.bodyPitch;
        savedAnimPosture.bodyHeight = blueprint.posture.bodyHeight;
        startAnimator();
      } else {
        blueprint.posture.bodyPitch = savedAnimPosture.bodyPitch;
        blueprint.posture.bodyHeight = savedAnimPosture.bodyHeight;
        animator = null;
        animFrame = null;
        rebuild();
      }
    });
    slider(s, "speed (0 stand · 1 run)", animMisc, "speed", { min: 0, max: 1 });
    // Object size: past ~1.5 palm-widths the pick-up goes two-handed (and
    // any size does, for a kind without opposable digits).
    slider(s, "object size (m)", objectMisc, "size", { min: 0.05, max: 0.5, step: 0.01 });
    const row1 = el("div", "lab-row", s);
    const pick = el("button", undefined, row1);
    pick.textContent = "pick up";
    pick.addEventListener("click", () => { tryPickUp(); });
    const put = el("button", undefined, row1);
    put.textContent = "put down";
    put.addEventListener("click", () => {
      if (!animator) return;
      const L = blueprint.spine.torsoLengthM;
      // Hands set the crate down on the other side; a mouth can only
      // lower it back onto the midline where the beak dives.
      const spot = animator.hasHands()
        ? { x: -objectPos.x, y: objectMisc.size / 2, z: 0.55 * L }
        : { x: 0, y: objectMisc.size / 2, z: 0.7 * L };
      if (animator.putDown(spot)) objectPos.set(spot.x, spot.y, spot.z);
    });
    // Point at the crate — the creature raises the anatomically-chosen limb
    // (arm / foreleg / …, whichever extends furthest without losing balance)
    // toward it, holds, then drops. Nothing to point with → the button no-ops.
    const point = el("button", undefined, row1);
    point.textContent = "point";
    point.addEventListener("click", () => {
      if (!animator) return;
      animator.point({ x: objectPos.x, y: 0, z: objectPos.z }, 2.0);
    });
  }

  // Mouth — test mouth movements: a static gape slider plus an open/close
  // cycle. Exercises the commissure/cheek layer (the visible mouth should
  // stay smaller than the mandible's full gape on horses/humans).
  {
    const s = section("mouth", true);
    slider(s, "gape (0 closed · 1 open)", mouthMisc, "gape", { min: 0, max: 1 });
    const row = el("div", "lab-row", s);
    el("label", undefined, row).textContent = "cycle open/close";
    const cb = el("input", undefined, row);
    cb.type = "checkbox";
    cb.checked = mouthCycle;
    cb.addEventListener("change", () => {
      mouthCycle = cb.checked;
      if (!mouthCycle) { mouthMisc.gape = 0; rebuild(); }
    });
  }

  // Walk gait — phase-offset stepping (gait.ts). Toggle "walk" to animate
  // it; the skeleton re-solves each frame with gait-driven foot targets.
  // (Manual/low-level; the animator section above supersedes it when on.)
  {
    const s = section("walk gait");
    const row0 = el("div", "lab-row", s);
    el("label", undefined, row0).textContent = "walk";
    const cb = el("input", undefined, row0);
    cb.type = "checkbox";
    cb.checked = walking;
    cb.addEventListener("change", () => {
      walking = cb.checked;
      if (!walking) { gaitParams.phase = 0; rebuild(); }
    });
    const row1 = el("div", "lab-row", s);
    el("label", undefined, row1).textContent = "pattern";
    const sel = el("select", undefined, row1) as HTMLSelectElement;
    for (const p of GAIT_PATTERNS) {
      const opt = el("option", undefined, sel) as HTMLOptionElement;
      opt.value = p;
      opt.textContent = p;
      if (p === gaitParams.pattern) opt.selected = true;
    }
    sel.addEventListener("change", () => { gaitParams.pattern = sel.value as GaitPattern; });
    slider(s, "cadence", gaitMisc, "cadence", { min: 0.2, max: 3, step: 0.05 });
    slider(s, "stride", gaitParams as unknown as Record<string, number>, "strideFrac", { min: 0.1, max: 1 });
    slider(s, "step height", gaitParams as unknown as Record<string, number>, "stepHeight", { min: 0, max: 0.5 });
    slider(s, "duty factor", gaitParams as unknown as Record<string, number>, "dutyFactor", { min: 0.3, max: 0.95 });
  }

  // Limb groups — unified legs / arms / wings / fins. Each is a TYPE,
  // duplicated by `count`, placed bilaterally or radially, with an
  // end-effector. ≤3 of them may be function "leg".
  {
    const s = section("limb groups", true);
    blueprint.limbGroups.forEach((grp, i) => {
      const head = el("div", "lab-row", s);
      el("label", undefined, head).textContent = `limb ${i}`;
      const placeSel = el("select", undefined, head) as HTMLSelectElement;
      for (const pl of LIMB_PLACEMENTS) {
        const opt = el("option", undefined, placeSel) as HTMLOptionElement;
        opt.value = pl;
        opt.textContent = pl;
        if (pl === grp.placement) opt.selected = true;
      }
      placeSel.addEventListener("change", () => { grp.placement = placeSel.value as LimbPlacement; rebuild(); });
      const remove = el("button", "danger", head);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { blueprint.limbGroups.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(LIMB_GROUP_RANGES)) {
        slider(s, `  ${key}`, grp as unknown as Record<string, number>, key, range);
      }
    });
    if (blueprint.limbGroups.length < MAX_LIMB_GROUPS) {
      const row = el("div", "lab-row", s);
      const addLeg = el("button", undefined, row);
      addLeg.textContent = "add leg";
      addLeg.addEventListener("click", () => {
        blueprint.limbGroups.push({ ...defaultBlueprint().limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5 });
        buildPanel();
        rebuild();
      });
      const addWing = el("button", undefined, row);
      addWing.textContent = "add wing/arm";
      addWing.addEventListener("click", () => {
        blueprint.limbGroups.push(clampBlueprint({ limbGroups: [{ membrane: 0.9, stationStart: 0.2, stationEnd: 0.2, lengthFrac: 1.3, attachHeight: 0.85, restProtraction: -0.4, restLevation: 0.7, restFlexion: 0.6, footLengthFrac: 0, toeCount: 1 }] }).limbGroups[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // Flexible chains — antennae, tentacles, trunk, eyestalks, lures.
  {
    const s = section("flexible chains");
    blueprint.chains.forEach((ch, i) => {
      const head = el("div", "lab-row", s);
      el("label", undefined, head).textContent = `chain ${i}`;
      const attachSel = el("select", undefined, head) as HTMLSelectElement;
      for (const a of CHAIN_ATTACH) {
        const opt = el("option", undefined, attachSel) as HTMLOptionElement;
        opt.value = a;
        opt.textContent = a;
        if (a === ch.attach) opt.selected = true;
      }
      attachSel.addEventListener("change", () => { ch.attach = attachSel.value as ChainAttach; rebuild(); });
      const tipSel = el("select", undefined, head) as HTMLSelectElement;
      for (const t of CHAIN_TIPS) {
        const opt = el("option", undefined, tipSel) as HTMLOptionElement;
        opt.value = t;
        opt.textContent = t;
        if (t === ch.tip) opt.selected = true;
      }
      tipSel.addEventListener("change", () => { ch.tip = tipSel.value as ChainTip; rebuild(); });
      const radWrap = el("label", undefined, head);
      radWrap.textContent = "radial";
      const rad = el("input", undefined, radWrap) as HTMLInputElement;
      rad.type = "checkbox";
      rad.checked = ch.radial;
      rad.addEventListener("change", () => { ch.radial = rad.checked; rebuild(); });
      const remove = el("button", "danger", head);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { blueprint.chains.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(CHAIN_RANGES)) {
        slider(s, `  ${key}`, ch as unknown as Record<string, number>, key, range);
      }
    });
    if (blueprint.chains.length < MAX_CHAINS) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add chain";
      add.addEventListener("click", () => {
        blueprint.chains.push(clampBlueprint({ chains: [{}] }).chains[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // Midline membranes — dorsal/ventral fins, sails, crests.
  {
    const s = section("membranes");
    blueprint.membranes.forEach((m, i) => {
      const head = el("div", "lab-row", s);
      el("label", undefined, head).textContent = `membrane ${i}`;
      const edgeSel = el("select", undefined, head) as HTMLSelectElement;
      for (const e of MEMBRANE_EDGES) {
        const opt = el("option", undefined, edgeSel) as HTMLOptionElement;
        opt.value = e;
        opt.textContent = e;
        if (e === m.edge) opt.selected = true;
      }
      edgeSel.addEventListener("change", () => { m.edge = edgeSel.value as MembraneEdge; rebuild(); });
      const remove = el("button", "danger", head);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { blueprint.membranes.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(MEMBRANE_RANGES)) {
        slider(s, `  ${key}`, m as unknown as Record<string, number>, key, range);
      }
    });
    if (blueprint.membranes.length < MAX_MEMBRANES) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add membrane";
      add.addEventListener("click", () => {
        blueprint.membranes.push(clampBlueprint({ membranes: [{}] }).membranes[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // 🌱 Plant age — the growth scrub (growth.ts `ageGrowth`). Above the
  // growths section because it READS every field below it: a shoot is the
  // same blueprint with fewer branch levels, a slenderer stem and sparser
  // leaves, never a scaled-down copy of the adult. The readout names the
  // stage the scrub derives, so what you see can be checked against the
  // numbers without opening the JSON box.
  if (blueprint.growths.length > 0) {
    const s = section("plant age (view only)", true);
    const row = el("div", "lab-row", s);
    el("label", undefined, row).textContent = "age";
    const input = el("input", undefined, row);
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = String(plantAge);
    const val = el("span", "val", row);
    const stage = el("div", "lab-age", s);
    const readout = (): void => {
      val.textContent = plantAge.toFixed(2);
      const g0 = blueprint.growths[0];
      const aged = ageGrowth(g0, plantAge);
      const h = plantAge >= 1 ? 1 : growthHeightFactor(plantAge);
      const heightM = aged.stem.lengthFrac * blueprint.spine.torsoLengthM;
      stage.textContent =
        `levels ${growthLevelsAt(g0.branching.levels, plantAge)}/${g0.branching.levels}` +
        ` · leaves ${aged.foliage.leafDensity.toFixed(2)}/${g0.foliage.leafDensity}` +
        ` · stem ×${h.toFixed(3)} (${fmtLenM(heightM)})` +
        ` · girth ${aged.stem.girth.toFixed(4)} · start ${aged.branching.branchStart.toFixed(2)}`;
    };
    readout();
    input.addEventListener("input", () => {
      plantAge = Number(input.value);
      readout();
      rebuild();
    });
  }

  // Growths — the branching/spiral grammar (growth.ts): horns, antlers,
  // and whole plants (a plant is a body nub carrying one of these).
  {
    const s = section("growths");
    const anyColor = (parent: HTMLElement, label: string, obj: Record<string, string>, key: string): void => {
      const row = el("div", "lab-row", parent);
      el("label", undefined, row).textContent = label;
      const input = el("input", undefined, row);
      input.type = "color";
      input.value = obj[key];
      input.addEventListener("input", () => { obj[key] = input.value; rebuild(); });
    };
    blueprint.growths.forEach((gr, i) => {
      const head = el("div", "lab-row", s);
      el("label", undefined, head).textContent = `growth ${i}`;
      enumSel(head, GROWTH_TYPES, gr.type, (v: GrowthType) => { gr.type = v; buildPanel(); });
      enumSel(head, GROWTH_ATTACH, gr.attach, (v: GrowthAttach) => { gr.attach = v; });
      enumSel(head, GROWTH_PLACEMENTS, gr.placement, (v: GrowthPlacement) => { gr.placement = v; });
      const remove = el("button", "danger", head);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { blueprint.growths.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(GROWTH_RANGES)) {
        slider(s, `  ${key}`, gr as unknown as Record<string, number>, key, range);
      }
      const fruitRow = el("div", "lab-row", s);
      el("label", undefined, fruitRow).textContent = "  fruit placement";
      enumSel(fruitRow, FRUIT_PLACEMENTS, gr.fruitPlacement, (v: FruitPlacement) => { gr.fruitPlacement = v; });
      const subs: Array<[string, Record<string, number>, Record<string, FieldRange>]> = [
        ["stem", gr.stem as unknown as Record<string, number>, GROWTH_STEM_RANGES as unknown as Record<string, FieldRange>],
        ["branching", gr.branching as unknown as Record<string, number>, GROWTH_BRANCHING_RANGES as unknown as Record<string, FieldRange>],
        ["foliage", gr.foliage as unknown as Record<string, number>, GROWTH_FOLIAGE_RANGES as unknown as Record<string, FieldRange>],
        ["flowers", gr.flowers as unknown as Record<string, number>, GROWTH_FLOWER_RANGES as unknown as Record<string, FieldRange>],
        ["fruit", gr.fruit as unknown as Record<string, number>, GROWTH_FRUIT_RANGES as unknown as Record<string, FieldRange>],
      ];
      for (const [name, obj, ranges] of subs) {
        const sub = el("details", undefined, s);
        el("summary", undefined, sub).textContent = `growth ${i} · ${name}`;
        for (const [key, range] of Object.entries(ranges)) {
          slider(sub, `  ${key}`, obj, key, range);
        }
        if (name === "foliage") anyColor(sub, "  leaf color", gr.foliage as unknown as Record<string, string>, "leafColor");
        if (name === "flowers") anyColor(sub, "  flower color", gr.flowers as unknown as Record<string, string>, "flowerColor");
        if (name === "fruit") anyColor(sub, "  fruit color", gr.fruit as unknown as Record<string, string>, "color");
      }
    });
    if (blueprint.growths.length < MAX_GROWTHS) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add growth";
      add.addEventListener("click", () => {
        blueprint.growths.push(clampBlueprint({ growths: [{}] }).growths[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // Skin colors.
  {
    const s = section("skin");
    colorRow(s, "base", "baseColor");
    colorRow(s, "belly", "bellyColor");
    colorRow(s, "accent", "accentColor");
  }

  // Outfit — the clothing designer (clothing.ts): garments as data over body
  // REGIONS (spine spans + limbs rooted in them + skull landmarks), so the
  // same rows dress any species. An array section, like the trunk profile.
  {
    const s = section("outfit (clothing)");
    const outfit = (blueprint.outfit ??= { garments: [] });
    const gColor = (parent: HTMLElement, label: string, g: GarmentBlueprint, key: "color" | "accentColor"): void => {
      const row = el("div", "lab-row", parent);
      el("label", undefined, row).textContent = label;
      const input = el("input", undefined, row);
      input.type = "color";
      input.value = g[key];
      input.addEventListener("input", () => { g[key] = input.value; rebuild(); });
    };
    outfit.garments.forEach((g, i) => {
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = `garment ${i}`;
      const sel = el("select", undefined, row) as HTMLSelectElement;
      for (const k of GARMENT_KINDS) {
        const opt = el("option", undefined, sel) as HTMLOptionElement;
        opt.value = k;
        opt.textContent = k;
        if (k === g.kind) opt.selected = true;
      }
      sel.addEventListener("change", () => {
        // Swapping kind re-seats that kind's dial defaults (each kind reads
        // them differently); the designer's colors carry over.
        const fresh = defaultGarment(sel.value as GarmentKind);
        outfit.garments[i] = { ...fresh, color: g.color, accentColor: g.accentColor };
        buildPanel();
        rebuild();
      });
      const remove = el("button", "danger", row);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { outfit.garments.splice(i, 1); buildPanel(); rebuild(); });
      gColor(s, "  fabric", g, "color");
      gColor(s, "  trim", g, "accentColor");
      slider(s, "  coverage", g as unknown as Record<string, number>, "coverage", GARMENT_RANGES.coverage);
      if (g.kind !== "hat") {
        slider(s, "  limb coverage", g as unknown as Record<string, number>, "limbCoverage", GARMENT_RANGES.limbCoverage);
      }
      slider(s, "  flare", g as unknown as Record<string, number>, "flare", GARMENT_RANGES.flare);
      if (g.kind === "dress") {
        slider(s, "  skirt length", g as unknown as Record<string, number>, "skirtLength", GARMENT_RANGES.skirtLength);
      }
    });
    if (outfit.garments.length < MAX_GARMENTS) {
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = "add";
      for (const k of GARMENT_KINDS) {
        const add = el("button", undefined, row);
        add.textContent = k;
        add.addEventListener("click", () => {
          outfit.garments.push(defaultGarment(k));
          buildPanel();
          rebuild();
        });
      }
    }
  }

  // Physics / stress — the support ledger (`skel.support`) made visible.
  // The gravity dial here is the ONE source of truth every buildSkeleton
  // call on this page reads, so it drives the static build, the gait build
  // and the animator tick alike.
  {
    // Open whenever the stress view is on: the readout IS the stress view's
    // other half (and the only place a refusal is spoken), so turning the
    // tint on and leaving its numbers folded away is a small lie.
    const s = section("physics / stress", true); // always open — the debug view users come here for
    {
      const row = el("div", "lab-row", s);
      const lbl = el("label", undefined, row);
      lbl.textContent = "stress view";
      lbl.title = "tint the skin per bone by stress + draw the ground overlay";
      const input = el("input", undefined, row);
      input.type = "checkbox";
      input.checked = stressView;
      input.addEventListener("change", () => { stressView = input.checked; rebuild(); });
    }
    {
      const row = el("div", "lab-row", s);
      const lbl = el("label", undefined, row);
      lbl.textContent = "ground overlay";
      lbl.title = "support polygon / CoM / foot forces / tipping lever (needs stress view)";
      const input = el("input", undefined, row);
      input.type = "checkbox";
      input.checked = groundOverlay;
      input.addEventListener("change", () => { groundOverlay = input.checked; rebuild(); });
    }
    slider(s, "gravity (×g)", physMisc, "gravity", { min: 0, max: 3, step: 0.05 });
    // ── Carried mass ───────────────────────────────────────────────────
    // Two dials, because a body carries things two ways: in its hands/mouth
    // (an ACTION, so it goes through pickUp and can be refused) and on its
    // back (a state someone else put it in, never refused — the ledger just
    // reports what it costs).
    slider(s, "object mass (×auto)", physMisc, "objectMass", { min: 0, max: 8, step: 0.1 });
    slider(s, "back load (×body mass)", physMisc, "backLoad", { min: 0, max: 2, step: 0.05 });
    {
      const note = el("div", "lab-row", s);
      note.style.color = "#8b99a8";
      note.innerHTML =
        `<span style="flex:1">object mass feeds “pick up” (×1 = as dense as the ` +
        `creature); back load rides the girth peak while the animator runs</span>`;
    }
    {
      // Ramp legend — grey is off the ramp on purpose (unloaded ≠ healthy).
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = "σ ramp";
      const bar = el("div", undefined, row);
      bar.style.cssText =
        `flex:1;height:10px;border-radius:2px;background:linear-gradient(90deg,` +
        `${RAMP_LO.getStyle()} 0%,${RAMP_MID.getStyle()} 23%,${RAMP_HI.getStyle()} 33%,` +
        `${RAMP_OVER.getStyle()} 100%)`;
      const key = el("span", "val", row);
      key.textContent = "0→1→3+";
      const note = el("div", "lab-row", s);
      note.style.color = "#8b99a8";
      note.innerHTML =
        `<span style="display:inline-block;width:10px;height:10px;flex:0 0 10px;` +
        `background:${STRESS_UNLOADED.getStyle()};border:1px solid #fff4"></span>` +
        `<span style="flex:1">unloaded limb — σ 1.0 = at capacity</span>`;
    }
    stressReadoutEl = el("pre", undefined, s);
    // Named so a headless capture can scroll to THIS block (the panel has
    // several <pre>s, and the JSON export box is the last one).
    stressReadoutEl.id = "lab-stress-readout";
    stressReadoutEl.style.cssText =
      "margin:6px 0 2px;padding:5px 6px;background:#0d1116;border:1px solid #2a323c;" +
      "border-radius:3px;color:#cdd6e0;font:11px/1.45 inherit;white-space:pre;overflow-x:auto";
    updateStressReadout(lastSupport);
  }

  // Loft quality + view toggles.
  {
    const s = section("loft / view");
    // LOD PREVIEW — swap the live body for the static tier a DISTANT instance
    // is drawn as. `stick` works on ANY blueprint (it is the creature far tier
    // too, 45-110 m); `lod1` / `impostor` are the plant-only rungs below it.
    // Lives here rather than under `growths` because it is a VIEW choice and
    // the creature tier has nothing to do with plants.
    {
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = "LOD preview";
      enumSel(row, ["off", "stick", "lod1", "impostor"] as const, lodPreview, (v) => { lodPreview = v; });
    }
    slider(s, "sides", LOFT as unknown as Record<string, number>, "sides", { min: 5, max: 14, int: true });
    slider(s, "headRings", LOFT as unknown as Record<string, number>, "headRings", { min: 3, max: 8, int: true });
    const toggles: Array<[string, () => boolean, (v: boolean) => void]> = [
      ["wireframe", () => wireframe, (v) => { wireframe = v; }],
      ["cel shading (toon ramp)", () => celShading, (v) => { celShading = v; }],
      ["polygon picker (click = copy index)", () => pickerOn, (v) => {
        pickerOn = v;
        if (!v) { clearPickHighlight(); pickInfoEl.style.display = "none"; }
      }],
      ["color by construction section", () => colorBySection, (v) => { colorBySection = v; }],
      ["skeleton", () => showSkeleton, (v) => { showSkeleton = v; }],
      ["auto-frame camera", () => autoFrame, (v) => { autoFrame = v; }],
      ["animate posture (torso target)", () => animatePosture, (v) => {
        animatePosture = v;
        if (v) {
          savedPosture.bodyPitch = blueprint.posture.bodyPitch;
          savedPosture.bodyHeight = blueprint.posture.bodyHeight;
        } else {
          blueprint.posture.bodyPitch = savedPosture.bodyPitch;
          blueprint.posture.bodyHeight = savedPosture.bodyHeight;
        }
      }],
    ];
    for (const [label, get, set] of toggles) {
      const row = el("div", "lab-row", s);
      const lbl = el("label", undefined, row);
      lbl.textContent = label;
      const input = el("input", undefined, row);
      input.type = "checkbox";
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        rebuild();
      });
    }
  }

  // Blueprint JSON — the interchange-format round-trip. Apply runs
  // clamp→validate exactly like a server-side description→blueprint
  // pipeline will, and surfaces validation errors.
  {
    const s = section("blueprint JSON", true);
    const ta = el("textarea", undefined, s);
    ta.id = "lab-json";
    ta.spellcheck = false;
    const errors = el("div", "lab-errors", s);
    errors.id = "lab-json-errors";
    const row = el("div", "lab-row", s);
    const apply = el("button", undefined, row);
    apply.textContent = "apply JSON";
    apply.addEventListener("click", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        errors.textContent = `JSON parse error: ${(e as Error).message}`;
        return;
      }
      const structural = validateBlueprint(parsed);
      const clamped = clampBlueprint(parsed);
      const after = validateBlueprint(clamped);
      if (!after.ok) {
        errors.textContent = `unrecoverable:\n${after.errors.join("\n")}`;
        return;
      }
      blueprint = clamped;
      errors.textContent = structural.ok
        ? ""
        : `applied with clamps:\n${structural.errors.join("\n")}`;
      buildPanel();
      rebuild();
    });
    const copy = el("button", undefined, row);
    copy.textContent = "copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(ta.value);
    });
  }
}

function syncJson(): void {
  const ta = document.getElementById("lab-json") as HTMLTextAreaElement | null;
  if (ta && document.activeElement !== ta) {
    ta.value = JSON.stringify(blueprint, null, 2);
  }
}

// ── Boot + loop ──────────────────────────────────────────────────────────

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

buildPanel();
rebuild();

// ── Screenshot / automation hooks (shot-creature.cjs) ───────────────────
// Dev-only: lets a puppeteer script load an example, pose the camera, and
// freeze the gait at a chosen phase for deterministic captures.
const labApi = {
  skeleton(): ReturnType<typeof buildSkeleton> { return rebuildGeometry(); },
  loadExample(name: string): boolean {
    const ex = CREATURE_EXAMPLES.find(
      (e) => e.id === name || e.title === name || e.title.startsWith(name),
    );
    if (!ex) return false;
    blueprint = clampBlueprint(ex.blueprint);
    buildPanel();
    rebuild();
    return true;
  },
  applyBlueprint(json: string): void {
    blueprint = clampBlueprint(JSON.parse(json));
    buildPanel();
    rebuild();
  },
  /** Orbit the camera: azimuth degrees (0 = looking at the creature's right
   *  flank, 90 = head-on), elevation degrees, distance multiplier. */
  orbit(azimuthDeg: number, elevationDeg: number, distMult = 1): void {
    autoFrame = false;
    const dist = camera.position.distanceTo(controls.target) * distMult;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    camera.position.set(
      controls.target.x + dist * Math.cos(el) * Math.cos(az),
      controls.target.y + dist * Math.sin(el),
      controls.target.z + dist * Math.cos(el) * Math.sin(az),
    );
    camera.lookAt(controls.target);
  },
  /** Aim the camera at the HEAD (for face iteration): target = head-bone
   *  midpoint, distance scaled to the skull. Follow with orbit() calls —
   *  they keep this target. */
  frameHead(distMult = 1): void {
    autoFrame = false;
    const skel = rebuildGeometry();
    const h = skel.bones.find((b) => b.chain === "head");
    if (!h) return;
    const cx = (h.head.x + h.tail.x) / 2;
    const cy = (h.head.y + h.tail.y) / 2;
    const cz = (h.head.z + h.tail.z) / 2;
    controls.target.set(cx, cy, cz);
    const dist = Math.max(h.radiusHead * 6, 0.3) * distMult;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.3, 1);
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist);
    camera.lookAt(controls.target);
  },
  /** Aim the camera at ANY bone chain — `frameHead` for the rest of the body.
   *  Added for the digit-crossing pass: judging whether a row of toes leaves
   *  its foot cleanly needs the toes filling the frame, and every other framing
   *  affordance here is whole-body or skull. Pass a chain name as the skeleton
   *  reports it (`limb0L`, `limb1R`, `limb0Ld2`, …); follow with orbit(). */
  frameChain(chain: string, distMult = 1): boolean {
    autoFrame = false;
    const skel = rebuildGeometry();
    const bs = skel.bones.filter((b) => b.chain === chain);
    if (bs.length === 0) return false;
    let cx = 0, cy = 0, cz = 0, r = 0;
    for (const b of bs) {
      cx += (b.head.x + b.tail.x) / 2 / bs.length;
      cy += (b.head.y + b.tail.y) / 2 / bs.length;
      cz += (b.head.z + b.tail.z) / 2 / bs.length;
      r = Math.max(r, b.radiusHead, b.radiusTail);
    }
    controls.target.set(cx, cy, cz);
    let extent = r;
    for (const b of bs) {
      extent = Math.max(extent,
        Math.hypot(b.tail.x - cx, b.tail.y - cy, b.tail.z - cz),
        Math.hypot(b.head.x - cx, b.head.y - cy, b.head.z - cz));
    }
    const dist = Math.max(extent * 3.2, 1e-3) * distMult;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.3, 1);
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist);
    camera.lookAt(controls.target);
    return true;
  },
  /** Force a static mouth gape (0..1) for head iteration. */
  setGape(v: number): void {
    mouthMisc.gape = Math.max(0, Math.min(1, v));
    rebuildGeometry();
  },
  /** Toggle wireframe (head-geometry debugging). */
  setWireframe(on: boolean): void {
    wireframe = on;
    rebuildGeometry();
  },
  /** Suppress the soft-tissue layer to work on the bare skull underneath. */
  setTissue(on: boolean): void {
    bareSkull = !on;
    rebuildGeometry();
  },
  /** Toggle the cel/toon-ramp material (candidate game default look). */
  setCel(on: boolean): void {
    celShading = on;
    rebuildGeometry();
  },
  /** Toggle color-by-construction-section (debug provenance view). */
  setColorSection(on: boolean): void {
    colorBySection = on;
    rebuildGeometry();
  },
  /** Toggle the stress view: per-bone stress tint on the skin + the ground
   *  overlay (support polygon, CoM, foot forces, tipping lever). */
  setStressView(on: boolean, overlay = true): void {
    stressView = on;
    groundOverlay = overlay;
    buildPanel();
    rebuildGeometry();
  },
  /** Set the gravity the STRESS LEDGER is computed under (0..3 × Earth).
   *  Forces and stresses scale; the pose does not move. */
  setGravity(g: number): void {
    physMisc.gravity = Math.max(0, Math.min(3, g));
    buildPanel();
    rebuildGeometry();
  },
  /** The most recent build's SupportDiagnostics, JSON-safe. Works in static
   *  and animator modes alike — every build publishes its ledger, so in
   *  animator mode this is the ledger of the tick that just ran. */
  stressReport(): SupportDiagnostics | null {
    if (!lastSupport) rebuildGeometry();
    return lastSupport ? (JSON.parse(JSON.stringify(lastSupport)) as SupportDiagnostics) : null;
  },
  /** What the body is carrying and whether it last said NO — the load half of
   *  `stressReport`, in the panel's own units. */
  loadReport(): {
    objectMassMul: number; backLoadFrac: number; objectMass: number;
    loadMass: number; weight: number; refusal: BearVerdict | null;
  } {
    return {
      objectMassMul: physMisc.objectMass,
      backLoadFrac: physMisc.backLoad,
      objectMass: objectMass(),
      loadMass: lastSupport?.body.loadMass ?? 0,
      weight: lastSupport?.body.weight ?? 0,
      refusal: lastRefusal,
    };
  },
  /** Put a pack on the animal (fraction of its own body mass) — the dial, for
   *  headless captures. Takes effect on the next animator tick. */
  setBackLoad(fracOfBody: number): void {
    physMisc.backLoad = Math.max(0, fracOfBody);
    buildPanel();
  },
  /** Pick the polygon under normalized device coords (-1..1) — the same
   *  info the click-picker copies. For headless debugging. */
  pickAt(nx: number, ny: number): PickResult | null {
    return pickAtNdc(nx, ny);
  },
  /** Read positions of specific vertex indices + every triangle that uses
   *  any of them, to identify what a vertex IS in the construction. */
  dumpVerts(indices: number[]): {
    positions: Record<number, [number, number, number]>;
    tris: { tri: number; verts: [number, number, number] }[];
    vertexCount: number;
  } | { error: string } {
    if (!built) return { error: "not built" };
    const g = built.mesh.geometry;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const idx = g.getIndex()!;
    const want = new Set(indices);
    const positions: Record<number, [number, number, number]> = {};
    for (const i of indices) {
      positions[i] = [+pos.getX(i).toFixed(4), +pos.getY(i).toFixed(4), +pos.getZ(i).toFixed(4)];
    }
    const tris: { tri: number; verts: [number, number, number] }[] = [];
    for (let t = 0; t < idx.count / 3; t++) {
      const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
      if (want.has(a) || want.has(b) || want.has(c)) tris.push({ tri: t, verts: [a, b, c] });
    }
    return { positions, tris, vertexCount: pos.count };
  },
  /** Freeze the walk gait at a fixed phase (deterministic captures). */
  setGait(on: boolean, params?: Partial<GaitParams>): void {
    walking = on;
    if (params) Object.assign(gaitParams, params);
    frozenPhase = on && params?.phase !== undefined ? params.phase : null;
    rebuildGeometry();
  },
  /** Drive the animator deterministically: enable it (paused), optionally
   *  set speed / fire an action, then advance `runS` seconds in fixed
   *  1/60 steps and freeze — the frame on screen is reproducible. */
  anim(opts: {
    speed?: number; size?: number; action?: "pickUp" | "putDown"; runS?: number; resume?: boolean;
    /** Crate mass as a multiple of `objectMassFromSize` (the panel's dial). */
    mass?: number;
    /** Pack on the back, as a fraction of the creature's own body mass. */
    backLoad?: number;
  }): string {
    if (!animOn) {
      savedAnimPosture.bodyPitch = blueprint.posture.bodyPitch;
      savedAnimPosture.bodyHeight = blueprint.posture.bodyHeight;
      animOn = true;
      startAnimator();
    }
    animPaused = !opts.resume;
    if (opts.speed !== undefined) animMisc.speed = opts.speed;
    if (opts.mass !== undefined) physMisc.objectMass = Math.max(0, opts.mass);
    if (opts.backLoad !== undefined) physMisc.backLoad = Math.max(0, opts.backLoad);
    if (opts.size !== undefined) {
      objectMisc.size = opts.size;
      objectPos.y = opts.size / 2;
      ensureObject();
    }
    // A dial set from here must show on the panel — a screenshot of a lab
    // whose sliders disagree with what it is simulating is worse than no
    // screenshot. (Only when one actually moved: `anim({runS})` is called in
    // a loop to advance time.)
    if (opts.speed !== undefined || opts.mass !== undefined ||
      opts.backLoad !== undefined || opts.size !== undefined) buildPanel();
    // A refusal is measured against the LAST OBSERVED ledger, so a hook that
    // enables the animator and picks up in the same call has to let one frame
    // run first — otherwise the gate has nothing to measure and fails open.
    if (opts.action) stepAnim(1 / 60);
    if (opts.action === "pickUp") {
      tryPickUp();
    } else if (opts.action === "putDown") {
      const L = blueprint.spine.torsoLengthM;
      const spot = animator!.hasHands()
        ? { x: -objectPos.x, y: objectMisc.size / 2, z: 0.55 * L }
        : { x: 0, y: objectMisc.size / 2, z: 0.7 * L };
      if (animator!.putDown(spot)) objectPos.set(spot.x, spot.y, spot.z);
    }
    const runS = opts.runS ?? 0;
    for (let s = 0; s < runS; s += 1 / 60) stepAnim(1 / 60);
    return animator!.currentAction;
  },
  ready: (): boolean => built !== null,
};
let frozenPhase: number | null = null;
(window as unknown as { __creatureLab: typeof labApi }).__creatureLab = labApi;

let lastLoopT: number | null = null;
renderer.setAnimationLoop(() => {
  const t = performance.now() / 1000;
  const dt = lastLoopT === null ? 1 / 60 : t - lastLoopT;
  lastLoopT = t;
  if (animOn && animator && !animPaused) {
    stepAnim(dt);
  } else if (!animOn) {
    if (animatePosture) {
      // Drive the torso target from a clock; the strain solver re-poses the
      // limbs each frame — legs straighten then fold, short forelimbs lift
      // off as the body rises, the tail drags as it sinks.
      blueprint.posture.bodyHeight = 0.5 - 0.5 * Math.cos(t * 1.1); // 0 → 1 → 0
      blueprint.posture.bodyPitch = savedPosture.bodyPitch + 0.25 * Math.sin(t * 0.55);
    }
    if (walking) {
      // Advance the gait cycle; the legs step (stance/swing) and the body
      // bobs as the skeleton re-solves with gait-driven foot targets.
      gaitParams.phase = frozenPhase ?? (t * gaitMisc.cadence) % 1;
    }
    // Mouth cycle: chew open/closed so the commissure, cheeks and jaw can
    // be judged in motion.
    if (mouthCycle) mouthMisc.gape = 0.5 - 0.5 * Math.cos(t * 2.6);
    if (animatePosture || mouthCycle || (walking && frozenPhase === null)) rebuildGeometry();
  }
  controls.update();
  renderer.render(scene, camera);
  drawPickLabels();
});
