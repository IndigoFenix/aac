// Creature Lab — standalone dev page (lab.html) for the creature
// generator. Phase-1 scope: view a genome's rest pose, tweak every field
// with sliders generated from the genome RANGES tables, re-roll seeded
// random genomes, and round-trip genomes through the JSON box (the same
// path an AI-emitted description→genome will use later).
//
// This page is a dev tool: mouse-driven (OrbitControls), not eyegaze.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  clampGenome,
  defaultGenome,
  randomGenome,
  validateGenome,
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
  type Genome,
  type LimbPlacement,
  type MembraneEdge,
} from "./genome";
import { buildSkeleton } from "./skeleton";
import { buildCreatureMesh, LOFT, type BuiltCreature } from "./mesh";
import { CREATURE_EXAMPLES } from "./examples";
import { DEFAULT_GAIT, GAIT_PATTERNS, type GaitParams, type GaitPattern } from "./gait";

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
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: "#222a33", roughness: 1 }),
  );
  disc.rotation.x = -Math.PI / 2;
  scene.add(disc);
  const grid = new THREE.GridHelper(80, 80, 0x33404e, 0x273039);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.4;
  grid.position.y = 0.001;
  scene.add(grid);
}

// ── State ────────────────────────────────────────────────────────────────

let genome: Genome = defaultGenome();
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
// Walk gait: when on, the animation loop advances the gait phase from a
// clock and the skeleton is re-solved each frame with gait-driven foot
// targets (stance/swing) + body bob.
let walking = false;
const gaitMisc = { cadence: 1.1 }; // gait cycles per second
const gaitParams: GaitParams = { ...DEFAULT_GAIT };

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
}

// Rebuild ONLY the geometry from the current genome — cheap enough to run
// every frame, which is how the posture animation re-solves the strain pose
// (legs plant/lift, knees fold/straighten) as the torso target moves.
function rebuildGeometry(): ReturnType<typeof buildSkeleton> {
  disposeBuilt();
  const skel = buildSkeleton(genome, walking ? gaitParams : undefined);
  built = buildCreatureMesh(skel, genome);
  (built.mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
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
// truth shared with clampGenome/validateGenome — so new genome fields
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

function colorRow(parent: HTMLElement, label: string, key: keyof Genome["skin"]): void {
  const row = el("div", "lab-row", parent);
  el("label", undefined, row).textContent = label;
  const input = el("input", undefined, row);
  input.type = "color";
  input.value = genome.skin[key];
  input.addEventListener("input", () => {
    genome.skin[key] = input.value;
    rebuild();
  });
}

function buildPanel(): void {
  controlsRoot.innerHTML = "";

  // Examples — curated showcase genomes (creatures/examples.ts). Loaded
  // through clampGenome, exactly like an AI-emitted description→genome.
  {
    const s = section("examples", true);
    const row = el("div", "lab-row", s);
    el("label", undefined, row).textContent = "load";
    const sel = el("select", undefined, row) as HTMLSelectElement;
    const ph = el("option", undefined, sel) as HTMLOptionElement;
    ph.value = "";
    ph.textContent = "— pick a creature —";
    for (const ex of CREATURE_EXAMPLES) {
      const opt = el("option", undefined, sel) as HTMLOptionElement;
      opt.value = ex.name;
      opt.textContent = ex.name;
    }
    sel.addEventListener("change", () => {
      const ex = CREATURE_EXAMPLES.find((e) => e.name === sel.value);
      if (!ex) return;
      genome = clampGenome(ex.genome);
      buildPanel();
      rebuild();
    });
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
      genome = randomGenome(seed);
      buildPanel();
      rebuild();
    });
    const next = el("button", undefined, row2);
    next.textContent = "next seed";
    next.addEventListener("click", () => {
      seed += 1;
      input.value = String(seed);
      genome = randomGenome(seed);
      buildPanel();
      rebuild();
    });
    const reset = el("button", undefined, row2);
    reset.textContent = "default";
    reset.addEventListener("click", () => {
      genome = defaultGenome();
      buildPanel();
      rebuild();
    });
  }

  sliderSection("spine", genome.spine as unknown as Record<string, number>, SPINE_RANGES, true);

  // Body profile (tagmata) — pinch/bulge control points along the trunk.
  // An array, so it isn't auto-slidered; it gets a dedicated editor.
  {
    const s = section("body profile (tagmata)");
    genome.spine.profile.forEach((pt, i) => {
      const row = el("div", "lab-row", s);
      el("label", undefined, row).textContent = `point ${i}`;
      const remove = el("button", "danger", row);
      remove.textContent = "remove";
      remove.addEventListener("click", () => { genome.spine.profile.splice(i, 1); buildPanel(); rebuild(); });
      slider(s, "  at", pt as unknown as Record<string, number>, "at", PROFILE_POINT_RANGES.at);
      slider(s, "  scale", pt as unknown as Record<string, number>, "scale", PROFILE_POINT_RANGES.scale);
    });
    if (genome.spine.profile.length < MAX_PROFILE_POINTS) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add point";
      add.addEventListener("click", () => {
        genome.spine.profile.push({ at: 0.5, scale: 0.6 });
        buildPanel();
        rebuild();
      });
    }
  }

  sliderSection("neck", genome.neck as unknown as Record<string, number>, NECK_RANGES);
  sliderSection("tail", genome.tail as unknown as Record<string, number>, TAIL_RANGES);
  sliderSection("head", genome.head as unknown as Record<string, number>, HEAD_RANGES);
  sliderSection("posture", genome.posture as unknown as Record<string, number>, POSTURE_RANGES);

  // Walk gait — phase-offset stepping (gait.ts). Toggle "walk" to animate
  // it; the skeleton re-solves each frame with gait-driven foot targets.
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
    genome.limbGroups.forEach((grp, i) => {
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
      remove.addEventListener("click", () => { genome.limbGroups.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(LIMB_GROUP_RANGES)) {
        slider(s, `  ${key}`, grp as unknown as Record<string, number>, key, range);
      }
    });
    if (genome.limbGroups.length < MAX_LIMB_GROUPS) {
      const row = el("div", "lab-row", s);
      const addLeg = el("button", undefined, row);
      addLeg.textContent = "add leg";
      addLeg.addEventListener("click", () => {
        genome.limbGroups.push({ ...defaultGenome().limbGroups[0], count: 1, stationStart: 0.5, stationEnd: 0.5 });
        buildPanel();
        rebuild();
      });
      const addWing = el("button", undefined, row);
      addWing.textContent = "add wing/arm";
      addWing.addEventListener("click", () => {
        genome.limbGroups.push(clampGenome({ limbGroups: [{ membrane: 0.9, stationStart: 0.2, stationEnd: 0.2, lengthFrac: 1.3, attachHeight: 0.85, restProtraction: -0.4, restLevation: 0.7, restFlexion: 0.6, footLengthFrac: 0, toeCount: 1 }] }).limbGroups[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // Flexible chains — antennae, tentacles, trunk, eyestalks, lures.
  {
    const s = section("flexible chains");
    genome.chains.forEach((ch, i) => {
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
      remove.addEventListener("click", () => { genome.chains.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(CHAIN_RANGES)) {
        slider(s, `  ${key}`, ch as unknown as Record<string, number>, key, range);
      }
    });
    if (genome.chains.length < MAX_CHAINS) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add chain";
      add.addEventListener("click", () => {
        genome.chains.push(clampGenome({ chains: [{}] }).chains[0]);
        buildPanel();
        rebuild();
      });
    }
  }

  // Midline membranes — dorsal/ventral fins, sails, crests.
  {
    const s = section("membranes");
    genome.membranes.forEach((m, i) => {
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
      remove.addEventListener("click", () => { genome.membranes.splice(i, 1); buildPanel(); rebuild(); });
      for (const [key, range] of Object.entries(MEMBRANE_RANGES)) {
        slider(s, `  ${key}`, m as unknown as Record<string, number>, key, range);
      }
    });
    if (genome.membranes.length < MAX_MEMBRANES) {
      const row = el("div", "lab-row", s);
      const add = el("button", undefined, row);
      add.textContent = "add membrane";
      add.addEventListener("click", () => {
        genome.membranes.push(clampGenome({ membranes: [{}] }).membranes[0]);
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

  // Loft quality + view toggles.
  {
    const s = section("loft / view");
    slider(s, "sides", LOFT as unknown as Record<string, number>, "sides", { min: 5, max: 14, int: true });
    slider(s, "headRings", LOFT as unknown as Record<string, number>, "headRings", { min: 3, max: 8, int: true });
    const toggles: Array<[string, () => boolean, (v: boolean) => void]> = [
      ["wireframe", () => wireframe, (v) => { wireframe = v; }],
      ["skeleton", () => showSkeleton, (v) => { showSkeleton = v; }],
      ["auto-frame camera", () => autoFrame, (v) => { autoFrame = v; }],
      ["animate posture (torso target)", () => animatePosture, (v) => {
        animatePosture = v;
        if (v) {
          savedPosture.bodyPitch = genome.posture.bodyPitch;
          savedPosture.bodyHeight = genome.posture.bodyHeight;
        } else {
          genome.posture.bodyPitch = savedPosture.bodyPitch;
          genome.posture.bodyHeight = savedPosture.bodyHeight;
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

  // Genome JSON — the interchange-format round-trip. Apply runs
  // clamp→validate exactly like a server-side description→genome
  // pipeline will, and surfaces validation errors.
  {
    const s = section("genome JSON", true);
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
      const structural = validateGenome(parsed);
      const clamped = clampGenome(parsed);
      const after = validateGenome(clamped);
      if (!after.ok) {
        errors.textContent = `unrecoverable:\n${after.errors.join("\n")}`;
        return;
      }
      genome = clamped;
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
    ta.value = JSON.stringify(genome, null, 2);
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

renderer.setAnimationLoop(() => {
  const t = performance.now() / 1000;
  if (animatePosture) {
    // Drive the torso target from a clock; the strain solver re-poses the
    // limbs each frame — legs straighten then fold, short forelimbs lift
    // off as the body rises, the tail drags as it sinks.
    genome.posture.bodyHeight = 0.5 - 0.5 * Math.cos(t * 1.1); // 0 → 1 → 0
    genome.posture.bodyPitch = savedPosture.bodyPitch + 0.25 * Math.sin(t * 0.55);
  }
  if (walking) {
    // Advance the gait cycle; the legs step (stance/swing) and the body
    // bobs as the skeleton re-solves with gait-driven foot targets.
    gaitParams.phase = (t * gaitMisc.cadence) % 1;
  }
  if (animatePosture || walking) rebuildGeometry();
  controls.update();
  renderer.render(scene, camera);
});
