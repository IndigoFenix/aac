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
import { buildSkeleton, limbTip } from "@shared/world-engine/creatures/skeleton";
import {
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
function stepAnim(dt: number): void {
  if (!animator) return;
  animator.setSpeed(animMisc.speed);
  animator.pattern = gaitParams.pattern;
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
function rebuildGeometry(): ReturnType<typeof buildSkeleton> {
  disposeBuilt();
  disposeLodPreview();
  // Show the soil plane when a root vegetable is present (its body grows
  // down through it). The plant nub grounds at y≈0, so the soil sits there.
  soilPlane.visible = blueprint.growths.some((gr) => gr.type === "root");
  if (lodPreview !== "off") {
    // Static-kind preview: what a scattered instance of this blueprint
    // would render as at mid range (LOD1) or far range (impostor).
    const skel = buildSkeleton(blueprint);
    const lods = buildPlantLods(blueprint);
    lodDisposers.push(() => lods.dispose());
    if (lodPreview === "stick") {
      const fig = creatureSticks(skel, blueprint);
      const geom = buildStickGeometry(fig);
      const mat = stickMaterial(); // unlit tier — `celShading` has no effect here
      const mesh = new THREE.Mesh(geom, mat);
      lodDisposers.push(() => geom.dispose(), () => mat.dispose());
      lodObject = mesh;
      statsEl.textContent =
        `stick · ${fig.segments.length} capsules · ${geom.getAttribute("position").count} verts · ` +
        `${geom.getIndex()!.count / 3} tris (LOD1: ${lods.lod1.vertices} verts)`;
    } else if (lodPreview === "impostor") {
      const imp = bakePlantImpostor(renderer, lods, blueprint);
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
    ? buildSkeleton(blueprint, animFrame?.gait, animFrame?.pose)
    : buildSkeleton(blueprint, walking ? gaitParams : undefined, mouthMisc.gape > 0 ? { gape: mouthMisc.gape } : undefined);
  built = buildCreatureMesh(skel, blueprint, { bareSkull, toon: celShading, debugTags: true });
  (built.mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
  if (colorBySection) applySectionColors();
  else sectionLegendEl.style.display = "none";
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

function sliderSection(
  title: string,
  obj: Record<string, number>,
  ranges: Record<string, FieldRange>,
  open = false,
): void {
  const s = section(title, open);
  for (const [key, range] of Object.entries(ranges)) {
    slider(s, key, obj, key, range);
  }
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

  sliderSection("spine", blueprint.spine as unknown as Record<string, number>, SPINE_RANGES, true);

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
    pick.addEventListener("click", () => {
      if (!animator) return;
      objectPos.y = objectMisc.size / 2;
      animator.pickUp({ x: objectPos.x, y: objectPos.y, z: objectPos.z }, objectMisc.size);
    });
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
  anim(opts: { speed?: number; size?: number; action?: "pickUp" | "putDown"; runS?: number; resume?: boolean }): string {
    if (!animOn) {
      savedAnimPosture.bodyPitch = blueprint.posture.bodyPitch;
      savedAnimPosture.bodyHeight = blueprint.posture.bodyHeight;
      animOn = true;
      startAnimator();
    }
    animPaused = !opts.resume;
    if (opts.speed !== undefined) animMisc.speed = opts.speed;
    if (opts.size !== undefined) {
      objectMisc.size = opts.size;
      objectPos.y = opts.size / 2;
      ensureObject();
    }
    if (opts.action === "pickUp") {
      animator!.pickUp({ x: objectPos.x, y: objectPos.y, z: objectPos.z }, objectMisc.size);
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
