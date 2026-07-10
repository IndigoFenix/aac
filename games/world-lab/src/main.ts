/**
 * World Lab — the game-maker's test bench (/games/world-lab/).
 *
 * Pick a test game from the dropdown → its aivota-world document loads
 * into the WORLD FILE pane → the lab boots whatever the file says. Edit
 * the JSON and hit "Load world file" to reboot — the path-exact refusals
 * from the manifest kernel and the scope builders land in the status bar.
 *
 * Every scope on the ladder is wired: GALAXY (the density field + the
 * focusable star neighbourhood), SOLAR_SYSTEM (stellar-physics orrery),
 * PLANET (sphere tectonics → quadtree LOD), REGION (flat tectonics →
 * heightfield), TOWN (TownWorld → the canvas town view in 3D). A resolved
 * `initial_focus` flies the camera and enables DESCENT — star → system →
 * planet → founding site → settlement, one document, one button per rung,
 * and "⬆ Back up" climbs out again. `avatar: true` stands a figure in the
 * focused area (WASD/arrows walk it at town scale).
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { avatarKind, loadWorldManifest, type GameSettings, type LoadedWorld } from "@shared/engine/manifest";
import { ECONOMY_MODULE } from "@shared/engine/modules/economy/index";
import { buildPlanetWorld, resolvePlanetFocus } from "@shared/planet/planet-game";
import { createPlanetObject, type PlanetObject } from "@shared/planet/three";
import { buildRegionWorld } from "@shared/engine/civ/region-game";
import { resolveSiteFocus, type SiteFocus } from "@shared/engine/cells/site-focus";
import type { CellGrid } from "@shared/engine/cells/index";
import type { TownPlan } from "@shared/engine/town/plan";
import {
  buildGalaxyWorld, resolveGalaxyFocus, buildSolarWorld, resolveSolarFocus,
} from "@shared/space/space-game";
import {
  createBakedCreature, createDynamicCreature, getSpeciesAssets,
  type CreatureModel, type DynamicCreatureModel,
} from "@shared/world-engine/creatures/creature-model";
import { createTownView, type TownView } from "./town-view";
import { createRegionView, type RegionView } from "./region-view";
import { createGalaxyView, type GalaxyView } from "./galaxy-view";
import { createSolarView, type SolarView } from "./solar-view";
import { createSpaceFlight, type SpaceFlight } from "./space-fly";
import { createSpaceHud, type SpaceHud } from "./space-hud";
import { bootLivingTown, bootStructure, type QuestBoot } from "./quest-boot";
import { canDescend, descendToSite, solarGameFromStar, planetGameFromPlanet } from "./descend";
import { TEST_WORLDS, DEFAULT_WORLD_ID } from "./worlds";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const select = $<HTMLSelectElement>("world-select");
const reloadBtn = $<HTMLButtonElement>("reload");
const descendBtn = $<HTMLButtonElement>("descend");
const ascendBtn = $<HTMLButtonElement>("ascend");
const statusEl = $<HTMLSpanElement>("status");
const fileEl = $<HTMLTextAreaElement>("world-file");
const viewEl = $<HTMLDivElement>("view");

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
  statusEl.title = text;
};
const paint = (): Promise<void> => new Promise(r => setTimeout(r, 30));

// ── Scene ──────────────────────────────────────────────────────────────────
// logarithmicDepthBuffer keeps depth precise across the huge near→far range
// real-scale space flight needs (0.5 m terrain ↔ 1e12 m planets) without z-fighting.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 60000);
// Fixed lab lights for the ground scopes (planet/town/region). In space flight
// the star's own light + the sky's ambient take over, so these are hidden.
const labAmbient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(labAmbient);
const labSun = new THREE.DirectionalLight(0xfff4e0, 2.0);
labSun.position.set(1, 0.7, 0.6);
scene.add(labSun);

// HDR bloom pipeline — used ONLY in space flight, where the sun/stars/halos are
// HDR additive pinpricks that only read as GLOWING through UnrealBloomPass. The
// target is HalfFloat so values above 1.0 survive to cross the bloom threshold.
// threshold 2.2 (seagull's 1.5 blooms sunlit terrain into a washed-out haze
// here): only the HDR sun disc (colour ×4) + stars cross it, not lit ground.
const BLOOM = { strength: 0.9, radius: 0.6, threshold: 2.2, exposure: 0.7 };
const hdrTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Toggle the space look: ACES tone mapping + bloom + star-only lighting.
function setSpaceMode(on: boolean): void {
  renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = on ? BLOOM.exposure : 1;
  labAmbient.visible = !on;
  labSun.visible = !on;
}

const resize = (): void => {
  const w = viewEl.clientWidth;
  const h = viewEl.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
};
window.addEventListener("resize", resize);

// ── Orbit camera (drag to turn, wheel to approach; boot may FLY it) ────────
const view = {
  yaw: 0.6, pitch: 0.35, dist: 3,
  targetYaw: 0.6, targetPitch: 0.35, targetDist: 3,
  center: new THREE.Vector3(),
  targetCenter: new THREE.Vector3(),
  radius: 2000, // scene scale: dist is in multiples of this
  minDist: 1.15, maxDist: 8, minPitch: -1.45,
};
const flyTo = (yaw: number, pitch: number, dist: number, center?: THREE.Vector3): void => {
  view.targetYaw = yaw;
  view.targetPitch = Math.max(view.minPitch, Math.min(1.45, pitch));
  view.targetDist = Math.max(view.minDist, Math.min(view.maxDist, dist));
  if (center) view.targetCenter.copy(center);
};
const applyCamera = (): void => {
  view.yaw += (view.targetYaw - view.yaw) * 0.06;
  view.pitch += (view.targetPitch - view.pitch) * 0.06;
  view.dist += (view.targetDist - view.dist) * 0.06;
  view.center.lerp(view.targetCenter, 0.08);
  const r = view.dist * view.radius;
  const cp = Math.cos(view.pitch);
  camera.position.set(
    view.center.x + r * cp * Math.cos(view.yaw),
    view.center.y + r * Math.sin(view.pitch),
    view.center.z + r * cp * Math.sin(view.yaw),
  );
  camera.lookAt(view.center);
};
let dragging = false;
let lastX = 0;
let lastY = 0;
// SPACESHIP flight input: the live pointer (for nose steering) + an accumulated
// wheel delta (the exponential speed knob), consumed once per frame.
let flight: SpaceFlight | null = null;
let spaceHud: SpaceHud | null = null;
const flightPointer = { x: 0, y: 0, inside: false };
let flightWheel = 0;
viewEl.addEventListener("pointerdown", e => {
  // Orbit-drag belongs to the 3D CANVAS only — never to UI mounted over it. A
  // playing quest renders its stage + response BOARD inside viewEl (the board is
  // a different part of the screen, not the canvas); capturing the pointer for a
  // press on a board button would steal its click — the pointerup lands on the
  // captured viewEl, so the button's native `click` never fires (it only
  // animates on pointerdown). Start a drag ONLY when the press lands on the
  // canvas itself.
  if (e.target !== renderer.domElement) return;
  if (flight) return; // flight steers by pointer POSITION, no drag
  dragging = true; lastX = e.clientX; lastY = e.clientY; viewEl.setPointerCapture(e.pointerId);
});
viewEl.addEventListener("pointerup", () => { dragging = false; });
viewEl.addEventListener("pointermove", e => {
  const r = viewEl.getBoundingClientRect();
  flightPointer.x = e.clientX - r.left;
  flightPointer.y = e.clientY - r.top;
  flightPointer.inside = true;
  if (flight || !dragging) return;
  view.yaw += (e.clientX - lastX) * 0.005;
  view.pitch = Math.max(view.minPitch, Math.min(1.45, view.pitch + (e.clientY - lastY) * 0.005));
  view.targetYaw = view.yaw;
  view.targetPitch = view.pitch;
  lastX = e.clientX;
  lastY = e.clientY;
});
viewEl.addEventListener("pointerleave", () => { flightPointer.inside = false; });
viewEl.addEventListener("wheel", e => {
  e.preventDefault();
  if (flight) {
    // Notches (± = faster/slower). The flight model applies the exponent.
    flightWheel += -e.deltaY / 100;
    return;
  }
  view.dist = Math.max(view.minDist, Math.min(view.maxDist, view.dist * Math.exp(e.deltaY * 0.001)));
  view.targetDist = view.dist;
}, { passive: false });

const setSceneScale = (radius: number, minDist: number, maxDist: number, minPitch: number): void => {
  view.radius = radius;
  view.minDist = minDist;
  view.maxDist = maxDist;
  view.minPitch = minPitch;
  view.dist = Math.max(minDist, Math.min(maxDist, view.dist));
  view.targetDist = view.dist;
  view.center.set(0, 0, 0);
  view.targetCenter.set(0, 0, 0);
  camera.near = Math.max(0.01, (radius * minDist) / 500);
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
};

// ── Walk controls (town scale) ─────────────────────────────────────────────
const keys = new Set<string>();
window.addEventListener("keydown", e => {
  if (e.target === fileEl) return; // typing in the world file isn't walking
  keys.add(e.key.toLowerCase());
});
window.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
let walker: THREE.Group | null = null;
// The town walker/residents are creature-builder bodies now: the walker is a
// DYNAMIC human (rebuilt every frame for real gait); residents are cheap
// PRELOADED (baked-clip) humans sharing one bake. `people` is disposed via each
// model's own dispose() — NOT the generic extras-traversal (which would free the
// SHARED baked geometry/material out from under the asset cache).
let walkerModel: DynamicCreatureModel | null = null;
let walkerSpeed01 = 0;
const people = new THREE.Group();
scene.add(people);
const peopleModels: CreatureModel[] = [];

const stepWalker = (dt: number): void => {
  if (!walker) return;
  let fwd = 0;
  let side = 0;
  if (keys.has("w") || keys.has("arrowup")) fwd += 1;
  if (keys.has("s") || keys.has("arrowdown")) fwd -= 1;
  if (keys.has("a") || keys.has("arrowleft")) side -= 1;
  if (keys.has("d") || keys.has("arrowright")) side += 1;
  if (!fwd && !side) { walkerSpeed01 = 0; return; }
  const fx = -Math.cos(view.yaw);
  const fz = -Math.sin(view.yaw);
  const speed = 6; // m/s — a brisk walk
  walker.position.x += (fx * fwd - fz * side) * speed * dt;
  walker.position.z += (fz * fwd + fx * side) * speed * dt;
  // Face the direction of travel: the creature body faces +Z, so yaw = atan2(dx, dz).
  const mx = fx * fwd - fz * side;
  const mz = fz * fwd + fx * side;
  walker.rotation.y = Math.atan2(mx, mz);
  walkerSpeed01 = 0.6; // a walk on the 0..1 gait dial
  view.targetCenter.set(walker.position.x, walker.position.y + 2, walker.position.z);
};

// ── World lifecycle ────────────────────────────────────────────────────────
let planet: PlanetObject | null = null;
let town: TownView | null = null;
let region: RegionView | null = null;
let galaxy: GalaxyView | null = null;
let solar: SolarView | null = null;
// A STRUCTURE game (the quest village) replaces the lab's scene entirely —
// the world engine's host owns its own canvas and loop while it's up.
let quest: QuestBoot | null = null;
const extras = new THREE.Group(); // avatar, focus beacon
scene.add(extras);
let baseStatus = "—";

// The LADDER: the document that booted the session, the current level's
// re-boot closure, the action one rung down, and the stack back up.
let rootLoaded: LoadedWorld | null = null;
let rootGrid: CellGrid | null = null;
let rootFocus: SiteFocus | null = null;
let currentReboot: () => void = () => {};
let descendAction: { label: string; run: () => void } | null = null;
const ladder: Array<() => void> = [];
// Whether a descended map scope should stand a WALKER avatar at the focus.
// (The spaceship avatar is a space-scope flight mode, dispatched separately.)
const avatarFlag = (): boolean => avatarKind(rootLoaded?.game ?? null) === "walker";

const syncButtons = (): void => {
  descendBtn.hidden = !descendAction;
  if (descendAction) descendBtn.textContent = descendAction.label;
  ascendBtn.hidden = ladder.length === 0;
};

function clearWorld(): void {
  setSpaceMode(false); // ground scopes: no bloom/tone-mapping, lab lights on
  if (quest) { quest.dispose(); quest = null; renderer.domElement.style.display = ""; }
  if (planet) { scene.remove(planet.group); planet.dispose(); planet = null; }
  if (town) { scene.remove(town.group); town.dispose(); town = null; }
  if (region) { scene.remove(region.group); region.dispose(); region = null; }
  if (galaxy) { scene.remove(galaxy.group); galaxy.dispose(); galaxy = null; }
  if (solar) { scene.remove(solar.group); solar.dispose(); solar = null; }
  if (flight) { scene.remove(flight.group); flight.dispose(); flight = null; delete (window as unknown as Record<string, unknown>).__flightLab; }
  if (spaceHud) { spaceHud.dispose(); spaceHud = null; }
  walker = null;
  walkerModel = null;
  walkerSpeed01 = 0;
  // Dispose creature people via their own dispose() — baked residents leave the
  // SHARED cached geometry/material untouched (reused next town); the dynamic
  // walker frees its per-frame mesh.
  for (const m of peopleModels) m.dispose();
  peopleModels.length = 0;
  people.clear();
  rootGrid = null;
  rootFocus = null;
  for (const child of [...extras.children]) {
    extras.remove(child);
    child.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => x.dispose());
    });
  }
}

/** A simple standing figure, `h` units tall, feet at the group origin. */
function makeAvatar(h: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.16, h * 0.2, h * 0.68, 12),
    new THREE.MeshStandardMaterial({ color: 0xe8a33d, roughness: 0.7 }),
  );
  body.position.y = h * 0.34;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(h * 0.16, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf2d3a0, roughness: 0.7 }),
  );
  head.position.y = h * 0.84;
  g.add(body, head);
  return g;
}

/** Stand a scattering of PRELOADED (baked-clip) human residents at their house
 *  doors, facing the street. They share one bake + one material, so a whole town
 *  of them costs a single geometry set. Capped so the lab stays snappy. */
function populateTownPeople(plan: TownPlan, species: string): void {
  // Warm the shared bake once (idle + walk) before spawning residents.
  getSpeciesAssets(species);
  const MAX_RESIDENTS = 30;
  const houses = plan.houses;
  if (houses.length === 0) return;
  const stride = Math.max(1, Math.floor(houses.length / MAX_RESIDENTS));
  for (let i = 0; i < houses.length && peopleModels.length < MAX_RESIDENTS; i += stride) {
    const h = houses[i];
    // Door-edge midpoint + outward normal (plan space; +y plan → +z world).
    let px = h.dx + h.w / 2;
    let py = h.dy + h.h / 2;
    let ox = 0;
    let oy = 0;
    switch (h.door) {
      case "north": py = h.dy; oy = -1; break;
      case "south": py = h.dy + h.h; oy = 1; break;
      case "east": px = h.dx + h.w; ox = 1; break;
      case "west": px = h.dx; ox = -1; break;
    }
    const standOut = 1.0;
    const model = createBakedCreature(species, { heightM: 1.7 });
    model.object.position.set(px + ox * standOut, 0, py + oy * standOut);
    // Creature faces +Z; turn it to look out along the door normal.
    model.update(0, { yaw: Math.atan2(ox, oy) });
    people.add(model.object);
    peopleModels.push(model);
  }
}

function makeBeacon(size: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.ConeGeometry(size * 0.28, size, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5b5b, emissive: 0x611414, roughness: 0.5 }),
  );
}

// ── Scope boots ────────────────────────────────────────────────────────────

function bootTownPlay(loaded: LoadedWorld): void {
  clearWorld();
  // The quest host renders itself — park the lab's canvas while it plays.
  renderer.domElement.style.display = "none";
  quest = bootLivingTown(viewEl, loaded, t => { baseStatus = t; setStatus(t); });
  descendAction = null;
  currentReboot = () => bootTownPlay(loaded);
}

// The STRUCTURE scope: a freestanding creature-quest puzzle played through the
// quest host. With avatar "spirit" it's the stationary, formless puzzle mode.
function bootStructureScope(loaded: LoadedWorld): void {
  clearWorld();
  renderer.domElement.style.display = "none";
  quest = bootStructure(viewEl, loaded, t => { baseStatus = t; setStatus(t); });
  descendAction = null;
  currentReboot = () => bootStructureScope(loaded);
}

function bootGalaxy(loaded: LoadedWorld): void {
  const t0 = performance.now();
  const built = buildGalaxyWorld(loaded.game!);
  const focus = resolveGalaxyFocus(built, loaded.game!.initialFocus);
  clearWorld();
  scene.background = new THREE.Color(0x02030a);

  galaxy = createGalaxyView(built);
  scene.add(galaxy.group);
  setSceneScale(galaxy.radius, 0.004, 3, -1.45);

  let focusNote = "";
  if (focus) {
    const [x, y, z] = galaxy.starPos(focus.star);
    const beacon = makeBeacon(55);
    beacon.position.set(x, y + 45, z);
    beacon.rotation.x = Math.PI;
    extras.add(beacon);
    // The galaxy is a MAP: stay overhead where the arms read; the beacon
    // marks home, and the descent button is the way in.
    flyTo(view.yaw, 1.15, 1.5);
    focusNote = ` · focused ${focus.rank === 0 ? "home star" : `star:${focus.rank}`} (${focus.star.massInit.toFixed(2)} M☉, age ${focus.star.age.toFixed(1)} Gyr)`;
  } else {
    flyTo(view.yaw, 0.9, 1.6);
  }

  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `galaxy seed ${built.spec.seed} · radius ${Math.round(built.params.radius).toLocaleString()} ly · ` +
    `${built.params.arms} arms · ${built.stars.length} neighbourhood stars · ${ms}ms${focusNote}`;
  setStatus(baseStatus);

  descendAction = focus
    ? { label: "→ Enter the system", run: () => bootSolar(solarGameFromStar(focus.star, avatarFlag())) }
    : null;
  currentReboot = () => bootGalaxy(loaded);
}

/** SPACESHIP flight through the system — the seagull physics, driven by the
 *  chase camera + pointer steering + the wheel speed knob; planets bake their
 *  geology and reveal cities by apparent pixel size (space-fly.ts). */
function bootSolarFlight(game: GameSettings): void {
  const t0 = performance.now();
  clearWorld();
  setSpaceMode(true); // HDR bloom + ACES tone mapping + star-only lighting
  // The streaming galaxy world generates from the document's `world.seed`
  // (1337 → the pinned home Sol); the player spawns in the home system and can
  // fly star to star. The space sky owns scene.background/fog now.
  const w = game.world as { seed?: number };
  const galaxySeed = (w.seed ?? 1337) >>> 0;
  flight = createSpaceFlight(scene, galaxySeed);
  spaceHud = createSpaceHud(viewEl);
  scene.add(flight.group);
  (window as unknown as Record<string, unknown>).__flightLab = flight; // test bench
  descendAction = null;
  const ms = Math.round(performance.now() - t0);
  baseStatus = `real-scale interstellar flight · seed ${galaxySeed} · steer with the mouse, wheel = speed · ${ms}ms`;
  setStatus(baseStatus);
  currentReboot = () => bootSolarFlight(game);
}

function bootSolar(game: GameSettings): void {
  const t0 = performance.now();
  const built = buildSolarWorld(game);
  const focus = resolveSolarFocus(built, game.initialFocus);
  clearWorld();
  scene.background = new THREE.Color(0x05070f);

  solar = createSolarView(built);
  scene.add(solar.group);
  setSceneScale(solar.radius, 0.12, 3, -1.4);

  let focusNote = "";
  if (focus) {
    const [x, y, z] = solar.planetPos(focus.planet.index);
    const beacon = makeBeacon(3);
    beacon.position.set(x, y + 4, z);
    beacon.rotation.x = Math.PI;
    extras.add(beacon);
    flyTo(view.yaw, 0.4, 0.3, new THREE.Vector3(x, y, z));
    focusNote = ` · focused planet:${focus.planet.index} (${focus.planet.kind}, ${focus.planet.orbitAU.toFixed(2)} AU, ${Math.round(focus.planet.teqK)} K)`;
  } else {
    flyTo(view.yaw, 0.7, 1.4);
  }

  const star = built.system.star;
  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `${star.state.phase} star · ${star.massInit.toFixed(2)} M☉ · ${Math.round(star.state.teff)} K · ` +
    `L ${star.state.luminosity.toPrecision(2)} · ${built.system.planets.length} planets · ${ms}ms${focusNote}`;
  setStatus(baseStatus);

  descendAction = focus && focus.planet.kind !== "gas"
    ? { label: "→ Approach the planet", run: () => bootPlanetGame(planetGameFromPlanet(focus.planet, avatarFlag())) }
    : null;
  if (focus && focus.planet.kind === "gas") {
    baseStatus += " · gas giant — no surface to approach";
    setStatus(baseStatus);
  }
  currentReboot = () => bootSolar(game);
}

function bootPlanetGame(game: GameSettings): void {
  const t0 = performance.now();
  const built = buildPlanetWorld(game);
  const focus = resolvePlanetFocus(built, game.initialFocus);
  clearWorld();
  scene.background = new THREE.Color(0x05070f);
  rootGrid = built.grid;
  // Default settlement anchor when the document names no focus: the most
  // FERTILE crowd — a founder picks farmland; a granary-less mining camp
  // honestly starves (we watched it happen).
  let fallback: SiteFocus | null = null;
  if (built.sites.length) {
    let best = 0;
    let bestFert = -1;
    built.sites.slice(0, 10).forEach((s, i) => {
      let fert = 0;
      built.grid.topo.disk(s.cell, 3, c => { fert += built.grid.fields.fertility[c]; });
      if (fert > bestFert) { bestFert = fert; best = i; }
    });
    fallback = { cell: built.sites[best].cell, site: built.sites[best] };
  }
  rootFocus = focus ?? fallback;

  const radius = built.spec.radius;
  setSceneScale(radius, 1.15, 8, -1.45);
  planet = createPlanetObject(built.surface, {
    resolution: Math.max(33, 2 * built.spec.topology.faceN + 1),
    maxDepth: 10,
    ocean: {},
  });
  scene.add(planet.group);

  let focusNote = "";
  const anchor = focus ?? (game.avatar ? rootFocus : null);
  if (anchor) {
    const dir = built.topo.pos3!(anchor.cell);
    const h = built.surface.heightAt(dir);
    const surfaceR = radius + Math.max(0, h);
    if (game.avatar) {
      const avatar = makeAvatar(radius * 0.012);
      avatar.position.set(dir[0] * surfaceR, dir[1] * surfaceR, dir[2] * surfaceR);
      avatar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir));
      extras.add(avatar);
    } else {
      const beacon = makeBeacon(radius * 0.03);
      const pinR = surfaceR + radius * 0.02;
      beacon.position.set(dir[0] * pinR, dir[1] * pinR, dir[2] * pinR);
      beacon.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(...dir));
      extras.add(beacon);
    }
    flyTo(Math.atan2(dir[2], dir[0]), Math.asin(dir[1]), game.avatar ? 1.5 : 1.8);
    focusNote = focus ? ` · focused site:${built.sites.indexOf(focus.site)} (density ${Math.round(focus.site.density)})` : "";
  }

  const n = built.topo.n;
  let land = 0;
  for (let c = 0; c < n; c++) if (built.grid.fields.height[c] >= 3) land++;
  const ms = Math.round(performance.now() - t0);
  const avatarNote = game.avatar && anchor ? " · avatar standing at the focus" : "";
  baseStatus =
    `${built.spec.topology.faceN}²×6 = ${n} cells · ${built.geology.world.events.length} tectonic events · ` +
    `${Math.round((100 * land) / n)}% land · ${built.sites.length} founding sites · ${ms}ms${focusNote}${avatarNote}`;
  setStatus(baseStatus);

  descendAction = rootFocus && rootLoaded && canDescend(rootLoaded)
    ? { label: "⬇ Found the settlement", run: doDescendTown }
    : null;
  currentReboot = () => bootPlanetGame(game);
}

function bootRegion(loaded: LoadedWorld): void {
  const t0 = performance.now();
  const built = buildRegionWorld(loaded.game!);
  const focus = resolveSiteFocus(built.grid, built.sites, loaded.game!.initialFocus);
  clearWorld();
  scene.background = new THREE.Color(0x0a1220);
  rootGrid = built.grid;
  rootFocus = focus;

  region = createRegionView(built.grid);
  scene.add(region.group);
  setSceneScale(region.radius, 0.3, 4, 0.1);

  let focusNote = "";
  const anchor = focus ?? (loaded.game!.avatar && built.sites.length
    ? { cell: built.sites[0].cell, site: built.sites[0] }
    : null);
  if (anchor) {
    const [x, y, z] = region.cellPos(anchor.cell);
    if (loaded.game!.avatar) {
      const avatar = makeAvatar(2.2); // map scale: symbolic — descend to walk
      avatar.position.set(x, y, z);
      extras.add(avatar);
    } else {
      const beacon = makeBeacon(3);
      beacon.position.set(x, y + 3, z);
      beacon.rotation.x = Math.PI;
      extras.add(beacon);
    }
    flyTo(view.yaw, 0.75, 0.7, new THREE.Vector3(x, y, z));
    focusNote = focus ? ` · focused site:${built.sites.indexOf(focus.site)} (density ${Math.round(focus.site.density)})` : "";
  } else {
    flyTo(view.yaw, 1.1, 1.6);
  }

  const n = built.grid.topo.n;
  let land = 0;
  for (let c = 0; c < n; c++) if (built.grid.fields.height[c] >= 3) land++;
  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `${built.spec.size.cols}×${built.spec.size.rows} = ${n} tiles · ${built.geology.world.events.length} tectonic events · ` +
    `${Math.round((100 * land) / n)}% land · ${built.sites.length} founding sites · ${ms}ms${focusNote}`;
  setStatus(baseStatus);

  descendAction = focus && canDescend(loaded)
    ? { label: "⬇ Found the settlement", run: doDescendTown }
    : null;
  currentReboot = () => bootRegion(loaded);
}

/** Stand the town view up (the town scope AND the bottom of the descent). */
function showTown(plan: TownPlan, statusText: string, withAvatar: boolean, species = "human_cute"): void {
  clearWorld();
  scene.background = new THREE.Color(0x9dbfd8);
  town = createTownView(plan);
  scene.add(town.group);
  setSceneScale(Math.max(120, town.radius * 1.4), 0.25, 6, 0.08);
  populateTownPeople(plan, species);
  if (withAvatar) {
    // The player is a full-fidelity creature (the builder's dynamic path).
    walkerModel = createDynamicCreature(species, { heightM: 1.7 });
    walkerModel.object.position.set(plan.streets.plazaR * 0.5, 0, 0);
    people.add(walkerModel.object);
    peopleModels.push(walkerModel);
    walker = walkerModel.object as THREE.Group;
    flyTo(0.9, 0.35, 0.45);
  } else {
    flyTo(0.9, 0.8, 1.6);
  }
  baseStatus = statusText + (withAvatar ? " · avatar walks (WASD/arrows)" : "");
  setStatus(baseStatus);
  descendAction = null;
}

// NOTE: the town SCOPE always boots the living town (bootTownPlay). The static
// TownView (showTown) survives only as the DESCENT landing view for now
// (doDescendTown) — descent-into-a-living-town is the documented follow-up
// (docs/TOWN_AND_NPCS.md, step 5).

function doDescendTown(): void {
  if (!rootLoaded || !rootGrid || !rootFocus) return;
  const grid = rootGrid;
  const focus = rootFocus;
  const t0 = performance.now();
  const d = descendToSite(rootLoaded, grid, focus.site);
  const ms = Math.round(performance.now() - t0);
  showTown(
    d.plan,
    `${d.key} · founded from the map (charter: farm ${Math.round(d.charter.farmland)} / ore ${Math.round(d.charter.ore_access)}) · ` +
    `day ${d.town.day} · pop ${Math.round(d.town.scalar("population"))} · ${d.plan.houses.length} houses · ${ms}ms`,
    avatarFlag(),
    rootLoaded.game?.avatarSpecies ?? "human_cute",
  );
  currentReboot = doDescendTown;
}

// ── Ladder controls ────────────────────────────────────────────────────────
async function descend(): Promise<void> {
  if (!descendAction) return;
  const from = currentReboot;
  const action = descendAction;
  setStatus("descending…");
  await paint();
  try {
    action.run();
    ladder.push(from);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  syncButtons();
}

async function ascend(): Promise<void> {
  const up = ladder.pop();
  if (!up) return;
  setStatus("climbing…");
  await paint();
  try {
    up();
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  syncButtons();
}

// ── Boot dispatch ──────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  setStatus("building world…");
  await paint();

  let raw: unknown;
  try {
    raw = JSON.parse(fileEl.value);
  } catch (e) {
    setStatus(`world file is not valid JSON: ${(e as Error).message}`, true);
    return;
  }

  try {
    const loaded = loadWorldManifest(raw, [ECONOMY_MODULE]);
    if (!loaded.game) {
      setStatus("document has no `game` settings — nothing to run", true);
      return;
    }
    rootLoaded = loaded;
    ladder.length = 0;
    descendAction = null;
    switch (loaded.game.scope) {
      case "galaxy": bootGalaxy(loaded); break;
      case "solar_system": {
        // The DEFAULT solar_system game is the ported real-Sol flight (the
        // seagull physics at real scale — `world.seed` picks the system, 1337 =
        // home Sol). A document opts into the compact ORRERY (browse the system
        // from outside, then descend into a planet) by pinning a `star` spec or
        // a planet `initial_focus`; the `walker` avatar likewise uses the map.
        const w = (loaded.game.world ?? {}) as { star?: unknown };
        const wantsOrrery =
          avatarKind(loaded.game) !== "spaceship" &&
          (w.star != null || typeof loaded.game.initialFocus === "string");
        if (wantsOrrery) bootSolar(loaded.game);
        else bootSolarFlight(loaded.game);
        break;
      }
      case "planet": bootPlanetGame(loaded.game); break;
      case "region": bootRegion(loaded); break;
      // A town is ALWAYS living: the playable, walkable town (residents +
      // dwell-to-talk + optional quests), run through the quest host. There is
      // no separate static "town kind" — see docs/TOWN_AND_NPCS.md.
      case "structure":
        bootStructureScope(loaded);
        break;
      case "town":
        bootTownPlay(loaded);
        break;
      default:
        setStatus(`scope "${loaded.game.scope}" is not wired in the lab yet`, true);
    }
    syncButtons();
  } catch (e) {
    setStatus((e as Error).message, true);
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────
for (const w of TEST_WORLDS) {
  const opt = document.createElement("option");
  opt.value = w.id;
  opt.textContent = w.name;
  select.appendChild(opt);
}
select.value = DEFAULT_WORLD_ID;

const loadSelected = (): void => {
  const w = TEST_WORLDS.find(t => t.id === select.value) ?? TEST_WORLDS[0];
  fileEl.value = JSON.stringify(w.doc, null, 2);
  void boot();
};
select.addEventListener("change", loadSelected);
reloadBtn.addEventListener("click", () => void boot());
descendBtn.addEventListener("click", () => void descend());
ascendBtn.addEventListener("click", () => void ascend());

resize();
loadSelected();

let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (quest) return; // the quest host runs its own loop on its own canvas
  if (flight) {
    // Pointer POSITION steers the nose (offset from view centre, [-1,1] with a
    // small dead zone); the accumulated wheel is the speed knob.
    const w = viewEl.clientWidth || 1;
    const h = viewEl.clientHeight || 1;
    let aimX: number | null = null;
    let aimY: number | null = null;
    if (flightPointer.inside) {
      const nx = (flightPointer.x / w) * 2 - 1;
      const ny = -((flightPointer.y / h) * 2 - 1);
      const dead = 0.12;
      aimX = Math.abs(nx) < dead ? 0 : Math.sign(nx) * (Math.abs(nx) - dead) / (1 - dead);
      aimY = Math.abs(ny) < dead ? 0 : Math.sign(ny) * (Math.abs(ny) - dead) / (1 - dead);
    }
    const wheel = flightWheel;
    flightWheel = 0;
    const fovRad = (camera.fov * Math.PI) / 180;
    // The ported chase rig drives the camera (position/up/lookAt) inside update;
    // we set near/far for the frame's depth range.
    const f = flight.update(camera, aimX, aimY, wheel, dt, h, fovRad);
    camera.near = f.near;
    camera.far = f.far;
    camera.updateProjectionMatrix();
    if (!statusEl.classList.contains("error")) setStatus(f.status);
    if (spaceHud) {
      const st = flight.player.state;
      const locked = st.lockedBodyId ? flight.world.bodies.find(b => b.id === st.lockedBodyId) ?? null : null;
      spaceHud.update({
        body: locked, lockProgress: st.lockProgress, camera, playerPos: st.position,
        canvasW: viewEl.clientWidth || 1, canvasH: h, dt,
      });
    }
    composer.render(); // HDR bloom pipeline (sun/stars/halos glow)
    return;
  }
  stepWalker(dt);
  // Animate the dynamic human (its legs stride with walkerSpeed01). stepWalker
  // owns its position + facing, so we don't pass yaw here.
  walkerModel?.update(dt, { speed01: walkerSpeed01 });
  applyCamera();
  if (planet) {
    planet.update(camera.position);
    if (!statusEl.classList.contains("error")) {
      setStatus(`${baseStatus} · ${planet.lod.chunkCount()} chunks`);
    }
  }
  renderer.render(scene, camera);
});
