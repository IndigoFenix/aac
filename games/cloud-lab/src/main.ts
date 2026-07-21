/**
 * Cloud Lab — a test bench for developing CLOUDS against the SHARED world-engine.
 *
 * It renders the same planet + sky the game does: a real body from the home Sol
 * (shared/space celestial-body → shared/planet quadtree terrain + atmosphere)
 * under the shared sky (space-sky.ts: camera-dome sky, starfield, body halos)
 * through the same HDR bloom pipeline as the world-lab flight. An orbit camera
 * frames the chosen world; a `cloudGroup` parented to it is the SEAM where the
 * (not-yet-ported) cloud system will attach.
 *
 * Clouds themselves are intentionally NOT implemented yet — this is the bench we
 * build them on next. `window.__cloudLab` exposes the scene/world/planet/camera.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { DEFAULT_GALAXY_PARAMS } from "@shared/world-engine/space/galaxy";
import { createWorld } from "@shared/world-engine/space/world";
import { createSpaceSky } from "@shared/world-engine/space/space-sky";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { deriveCloudField } from "@shared/world-engine/space/cloud-field";
import { createCloudSystem, computeCloudPixelsPerUnit, type CloudSystem } from "@shared/world-engine/space/cloud-system";

const viewEl = document.getElementById("view") as HTMLDivElement;
const controlsEl = document.getElementById("controls") as HTMLDivElement;
const statsEl = document.getElementById("stats") as HTMLDivElement;

const seed = (Number(new URLSearchParams(location.search).get("seed")) || 1337) >>> 0;

// ── Renderer + HDR bloom (identical to the world-lab flight look) ─────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.7; // must match space-sky's ACES_EXPOSURE
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1e13);

const hdrTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.6, 2.2);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ── The world: the real home Sol; the sky reads its bodies + star ─────────────
const world = createWorld(seed, DEFAULT_GALAXY_PARAMS, 24);
scene.add(world.sceneGroup);
const starBody = world.bodies.find((b) => b.type === "star") ?? null;
const sky = createSpaceSky(scene, world.universe);

// ── Clouds (shared cloud-system, derived from the body's atmosphere) ──────────
let cloudSystem: CloudSystem | null = null;
let cloudNote = "none";
/** Simple deterministic per-body seed for the cloud field. */
const bodySeed = (id: string): number => {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
};
function disposeClouds(): void {
  if (!cloudSystem) return;
  cloudSystem.group.parent?.remove(cloudSystem.group);
  cloudSystem.dispose();
  cloudSystem = null;
}
function buildClouds(b: CelestialBody): void {
  disposeClouds();
  const f = b.resolvedPhysics?.features;
  if (!f) { cloudNote = "no physics"; return; }
  const field = deriveCloudField({
    atmosphere: f.atmosphere,
    planetRadiusM: b.radius,
    bandCount: f.atmosphericBandCount,
    bandingIntensity: f.atmosphericBanding,
    rotationPeriodHours: f.rotation.periodHours,
    seed: bodySeed(b.id),
  });
  if (field.layers.length === 0) {
    cloudNote = `none (${f.atmosphere.cloudType}, cover ${f.atmosphere.cloudCoverage.toFixed(2)})`;
    return;
  }
  cloudSystem = createCloudSystem({ field, timeSeconds: performance.now() * 0.001 });
  b.group.add(cloudSystem.group);
  cloudNote = `${f.atmosphere.cloudType} · ${field.layers.length} layer(s) · cover ${f.atmosphere.cloudCoverage.toFixed(2)}`;
}

// ── Orbit camera around the framed body (kept at the scene origin) ────────────
let body: CelestialBody = world.homePlanet ?? world.bodies.find((b) => b.type === "rocky")!;
const orbit = { yaw: 0.7, pitch: 0.22, dist: 1.8, tYaw: 0.7, tPitch: 0.22, tDist: 1.8 };
const _camLocal = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

/** Frame a body: floating-origin rebase so it sits at the scene origin (Float32
 *  precision for its metre-scale terrain), materialise it, rebuild its clouds. */
function frameBody(b: CelestialBody): void {
  body = b;
  const rec = b.worldPosition.clone();
  world.checkActiveSystem(rec); // rebases every body so `b` → ~origin
  b.materialize?.();
  buildClouds(b);
  orbit.tDist = orbit.dist = 1.8;
}
frameBody(body);

// ── Pointer orbit + wheel zoom ────────────────────────────────────────────────
let dragging = false, lastX = 0, lastY = 0;
viewEl.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  orbit.tYaw -= (e.clientX - lastX) * 0.006;
  orbit.tPitch = Math.max(-1.45, Math.min(1.45, orbit.tPitch + (e.clientY - lastY) * 0.006));
  lastX = e.clientX; lastY = e.clientY;
});
viewEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  orbit.tDist = Math.max(1.04, Math.min(30, orbit.tDist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

// ── Panel: pick which world to view (clouds behave differently per world) ─────
const bodySelect = document.createElement("select");
for (const b of world.bodies) {
  if (b.type === "star") continue;
  const o = document.createElement("option");
  o.value = b.id;
  o.textContent = `${b.id} · ${b.type}${b.hasOcean ? " · ocean" : ""}`;
  bodySelect.appendChild(o);
}
bodySelect.value = body.id;
bodySelect.addEventListener("change", () => {
  const b = world.bodies.find((x) => x.id === bodySelect.value);
  if (b) frameBody(b);
});
const row = document.createElement("div");
row.className = "row";
const lbl = document.createElement("label"); lbl.textContent = "body";
row.append(lbl, bodySelect);
controlsEl.appendChild(row);

// ── Resize + loop ─────────────────────────────────────────────────────────────
function resize(): void {
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  orbit.yaw += (orbit.tYaw - orbit.yaw) * 0.12;
  orbit.pitch += (orbit.tPitch - orbit.pitch) * 0.12;
  orbit.dist += (orbit.tDist - orbit.dist) * 0.12;

  const R = body.radius;
  const c = body.worldPosition;
  const d = orbit.dist * R;
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    c.x + d * cp * Math.cos(orbit.yaw),
    c.y + d * Math.sin(orbit.pitch),
    c.z + d * cp * Math.sin(orbit.yaw),
  );
  camera.lookAt(c);

  const h = viewEl.clientHeight || 1;
  const fovRad = (camera.fov * Math.PI) / 180;
  world.updateHalos(camera.position, h, fovRad); // materialise + terrain LOD
  const altitude = camera.position.distanceTo(c) - R;
  sky.update({
    bodies: world.bodies,
    star: starBody,
    dominant: body,
    altitude,
    cameraPos: camera.position,
    screenHeightPx: h,
    fovRad,
    sceneAnchorGalactic: world.sceneAnchorGalactic,
    dt: 1 / 60,
  });

  // Drive the clouds: camera pos/forward in the body's local frame, projection,
  // sun, then the per-frame bake + sprite/shell walk.
  if (cloudSystem) {
    scene.updateMatrixWorld();
    _camLocal.copy(camera.position).sub(c).applyQuaternion(body.inverseOrientation);
    _camFwd.copy(c).sub(camera.position).normalize().applyQuaternion(body.inverseOrientation);
    cloudSystem.setRuntimeOpts({
      // Lab wants the weather map to bake FAST so clouds show immediately (the
      // game amortises this at 0.5 ms/frame); rebuild the sprite set every frame.
      opacity: 1, spriteOversize: 1, minDensity: 0.04, windMult: 1,
      detailMult: 1, vigorMult: 1, bakeBudgetMs: 20, updateInterval: 1,
    });
    cloudSystem.setProjection(computeCloudPixelsPerUnit(camera, h), h);
    cloudSystem.setSunWorldPos(starBody ? starBody.worldPosition : null);
    cloudSystem.update(_camLocal, performance.now() * 0.001, _camFwd);
  }

  composer.render();

  const altKm = altitude / 1000;
  statsEl.textContent =
    `${body.id} · ${body.type}\n` +
    `radius ${(R / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km\n` +
    `altitude ${altKm.toLocaleString(undefined, { maximumFractionDigits: 0 })} km · ${orbit.dist.toFixed(2)}×R\n` +
    `clouds: ${cloudNote}`;
});

(window as unknown as Record<string, unknown>).__cloudLab = {
  scene, world, camera, sky,
  get body() { return body; },
  get cloudSystem() { return cloudSystem; },
};
