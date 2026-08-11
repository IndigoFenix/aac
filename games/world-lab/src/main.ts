/**
 * World Lab — the game-maker's test bench (/games/world-lab/).
 *
 * Pick a test game from the dropdown → its aivota-world document loads
 * into the WORLD FILE pane → the lab boots whatever the file says. Edit
 * the JSON and hit "Load world file" to reboot — the path-exact refusals
 * from the manifest kernel and the scope builders land in the status bar.
 *
 * Every space-and-planet scope rides the flight STREAMING world now:
 * piloted real-scale flight (`avatar: true` + `can_fly`) or the gaze-driven
 * SPIRIT ladder (shared/world-engine/spirit/ — flight → town orbit → ground
 * glide → structure dollhouse) for everything else; town/structure scopes
 * run the standalone quest host. The old standalone planet LOD map (private
 * orbit camera + WASD walker + manual descend buttons) was deleted when the
 * spirit ladder unified descent.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { avatarKind, loadWorldManifest, type GameSettings, type LoadedWorld , focusLevel } from "@shared/world-engine/kernel/manifest";
import {
  REAL_SCALE, resolveWorldScale, townExtentM,
  type WorldScale, type WorldScaleSpec,
} from "@shared/world-engine/scale";
import { getShadingMode, setShadingMode } from "@shared/world-engine/materials";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy/index";
import { createSpaceFlight, type SpaceFlight, type FlightCity } from "./space-fly";
import { createSpaceHud, type SpaceHud, type HudCity } from "./space-hud";
import { createDroneCamera, type DroneCamera } from "@shared/world-engine/spirit/drone-camera";
import { createSpiritLadder, CITY_FOCUS_ALT, type SpiritLadder } from "@shared/world-engine/spirit/ladder";
import type { SpiritCursorHost, SpiritLevel, SpiritStructureHost } from "@shared/world-engine/spirit/frame-provider";
import { createPlanetSpiritProvider } from "./spirit/planet-provider";
import { GazeSpark } from "@shared/world-engine/render3d";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { createPlanetObject, type PlanetObject } from "@shared/world-engine/planet/three";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { createSurfaceChart, type SurfacePoint } from "@shared/world-engine/space/surface-chart";
import { OWNS_MATERIAL_STATE } from "@shared/world-engine/space/space-sky";
import { bootLivingTown, bootStructure, bootTownEmbedded, bootWildernessQuest, type QuestBoot, type EmbeddedTown, type SharedBoard, type BoardHandlers } from "./quest-boot";
import { bootWilderness, faunaForBiome, wildMixForBiome, WILD_SIDE, type WildernessGround } from "./wilderness-boot";
import { createFloraField, floraTreesNear, FLORA_TREE_SPECIES, type FloraField } from "./flora-field";
import { makeFeature, wildFeatureContainerId } from "@shared/world-engine/interaction/quest/wilderness";
import { createTradeRoads, type TradeRoads, type TownSpliceSpec } from "./trade-roads";
import { createRiverRibbons, type RiverRibbons } from "./river-ribbons";
import {
  approachBearings, arterialTips, townRoadSeeds,
  type ArterialTip, type TownFrame,
} from "@shared/world-engine/kernel/town/approach";
import type { GrowSeed, TownStreets } from "@shared/world-engine/kernel/town/streets";
import type { PlanetRoute } from "@shared/world-engine/planet/routes";
import { regionFrame, type HighwayRefinement } from "@shared/world-engine/planet/refine";
import {
  WORLD_EPOCH_MS, worldGrowthDays, conurbations, conurbationName,
} from "@shared/world-engine/planet/growth";
import type { TownPlay } from "@shared/world-engine/interaction/town/town-play";
import {
  siteTownConfig, clusterSites, clusterRadiusM, mergeSites, CLUSTER_MIN_SITES,
  type FoundedSite,
} from "@shared/world-engine/interaction/town/founding";
import type { PlanetCity } from "@shared/world-engine/planet/cities";
import type { PartnerGeography } from "@shared/world-engine/kernel/town/barter";
import { mountBoardIsland } from "./board-island";
import { createCityTownLoader, type CityTownLoader, type CityTownEntry } from "./city-towns";
import { routeFor } from "./dispatch";
import { buildTownMesh, disposeTownMesh, type TownMeshView } from "./city-visuals";
import { createGeologyBaker, type GeologyBaker } from "./geo-bake";
import { TEST_WORLDS, DEFAULT_WORLD_ID } from "./worlds";
import { mountDebugPanel } from "./debug-panel";
import { mountSpecForm } from "./spec-form";
import { LAB_LOCALES, LOCALE_STORAGE_KEY, applyLabLocale, normalizeLabLocale } from "./lab-locale";
import { createFlashWatch } from "./flash-watch";
import { HdrProbePass } from "./hdr-probe";
import type { CreatureTier, QuestHost3D, QuestSession } from "@shared/world-engine/interaction/quest/quest-host";

// LAG HUNT (perf-probes.ts): the dollhouse still stutters with the attention
// system ruled out — the lab boots with every dormant probe LIVE by default
// ([sim-blocks]/[frame-phase]/[render-blocks]/[trip-emit]/…). Silence them at
// runtime with `globalThis.__perfProbes = false` in the console.
(globalThis as { __perfProbes?: boolean }).__perfProbes = true;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const select = $<HTMLSelectElement>("world-select");
const langSelect = $<HTMLSelectElement>("lang-select");
const reloadBtn = $<HTMLButtonElement>("reload");
const pathsBtn = $<HTMLButtonElement>("paths");
const nationsBtn = $<HTMLButtonElement>("nations");
const statusEl = $<HTMLSpanElement>("status");
const formEl = $<HTMLDivElement>("world-file");
const specForm = mountSpecForm(formEl); // the generated form IS the world document
const viewEl = $<HTMLDivElement>("view");
mountDebugPanel(); // 🐞 / "D" — creature+session readout on the left, pauses the sim

// ── THE BUTTON BOARD — the AAC's own chrome. A TOP-LEVEL sibling of the
// viewscreen (never inside it, never per-mode), mounted ONCE and ALWAYS
// visible whatever the scope/focus/mode: the active world host claims it and
// feeds it content; with no claim it sits blank. Mirrors the real AAC layout
// (game window + the AAC's own board in the sidebar/footer). ────────────────
const boardPanelEl = document.createElement("div");
boardPanelEl.className = "quest-boardpanel";
viewEl.insertAdjacentElement("afterend", boardPanelEl);
let boardHandlers: BoardHandlers | null = null;
const labBoard: SharedBoard = {
  island: mountBoardIsland(
    boardPanelEl,
    (id) => boardHandlers?.select(id),
    (sentence) => boardHandlers?.speak(sentence),
    (entityId) => boardHandlers?.selectPocket(entityId),
    (memberId) => boardHandlers?.selectFamilyMember(memberId),
  ),
  claim(handlers) {
    boardHandlers = handlers;
    return () => {
      if (boardHandlers !== handlers) return; // a newer claim took over
      boardHandlers = null;
      labBoard.island.set(null);
      labBoard.island.setNouns([]);
      labBoard.island.setPocket([]);
      labBoard.island.setFamily([]);
    };
  },
};

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
  statusEl.title = text;
};
const paint = (): Promise<void> => new Promise(r => setTimeout(r, 30));

// ── Loading veil ────────────────────────────────────────────────────────────
// Heavy builds (world boot, geology bakes, the quest host's session start)
// are still synchronous lumps — the veil's CSS spinner runs on the
// COMPOSITOR, so the page visibly stays alive through them instead of
// appearing hung. Show it before the lump, one painted frame guaranteed by
// the caller's `await paint()`.
if (getComputedStyle(viewEl).position === "static") viewEl.style.position = "relative";
const veilEl = document.createElement("div");
veilEl.className = "lab-veil hidden";
const veilSpin = document.createElement("div");
veilSpin.className = "lab-spin";
const veilLabel = document.createElement("div");
veilEl.append(veilSpin, veilLabel);
viewEl.appendChild(veilEl);
const showVeil = (label: string): void => {
  veilLabel.textContent = label;
  veilEl.classList.remove("hidden");
};
const hideVeil = (): void => veilEl.classList.add("hidden");
// The founding badge: a small, non-blocking "this city is building" pill
// shown while an approached town fast-forwards in the background.
const foundingEl = document.createElement("div");
foundingEl.className = "lab-founding hidden";
const foundingSpin = document.createElement("div");
foundingSpin.className = "lab-spin";
const foundingLabel = document.createElement("span");
foundingEl.append(foundingSpin, foundingLabel);
viewEl.appendChild(foundingEl);
const setFoundingBadge = (label: string | null): void => {
  foundingEl.classList.toggle("hidden", label === null);
  if (label !== null) foundingLabel.textContent = label;
};

// ── Shading ────────────────────────────────────────────────────────────────
// `?shading=toon` cel-shades every LIT surface in the engine (creatures, plants,
// terrain, buildings, roads, props); `?shading=standard` (the default) keeps the
// physically-based look. Read BEFORE anything builds — the mode is sampled at
// material construction, so a world already on screen keeps the materials it was
// born with until its next reboot.
const shadingParam = new URLSearchParams(location.search).get("shading");
if (shadingParam === "toon" || shadingParam === "standard") setShadingMode(shadingParam);
const toonShading = getShadingMode() === "toon";

// ── Scene ──────────────────────────────────────────────────────────────────
// logarithmicDepthBuffer keeps depth precise across the huge near→far range
// real-scale space flight needs (0.5 m terrain ↔ 1e12 m planets) without z-fighting.
// `?flashlogdepth=0` drops the logarithmic depth buffer for the star-flash
// A/B. Logdepth writes gl_FragDepth per fragment, which changes how tiny
// primitives rasterize — one of the few stages that sits between "the beacon's
// fragment shader writes 2.6" and "the resolved texture holds 1.6e4".
const flashNoLogDepth = new URLSearchParams(location.search).get("flashlogdepth") === "0";
// REVERSED-Z (`reverseDepthBuffer`), not `logarithmicDepthBuffer`, for the huge
// range. Same precision story, but logdepth writes gl_FragDepth per fragment,
// and BLENDED draws that write gl_FragDepth into the composer's offscreen
// target lose their depth test entirely on ANGLE/D3D11 (measured: the same
// transparent quad depth-tests fine rendered straight to the canvas, and fine
// in the composer without logdepth — the ground cursor was invisible on
// planets for exactly this reason, and the old "sprites don't survive
// logdepth" note was this same driver bug misread). Reversed-Z is pure
// projection + clip-control — no fragment depth writes, early-Z stays on —
// so the broken driver path is never entered. `?depth=log` restores the old
// mode for A/B; `?flashlogdepth=0` still drops both.
const wantLogDepth = new URLSearchParams(location.search).get("depth") === "log";
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  logarithmicDepthBuffer: wantLogDepth && !flashNoLogDepth,
  reversedDepthBuffer: !wantLogDepth && !flashNoLogDepth,
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 60000);
// Fixed lab lights for the ground scopes (planet/town/region). In space flight
// the star's own light + the sky's ambient take over, so these are hidden.
// Ambient is un-banded under toon (only direct light rides the ramp), so the
// cel look wants a dimmer fill and lets labSun carry the shading.
const labAmbient = new THREE.AmbientLight(0xffffff, toonShading ? 0.25 : 0.4);
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
// `?flashmsaa=0` drops MSAA for the star-flash A/B. A sub-pixel primitive that
// covers a fraction of the samples should resolve DIMMER, not brighter — so if
// killing MSAA kills the flash, the multisample resolve is manufacturing the
// value rather than any shader authoring it.
const flashSamples = new URLSearchParams(location.search).get("flashmsaa") === "0" ? 0 : 4;
const hdrTarget = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, samples: flashSamples,
});
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));

// ── NaN/Inf GUARD — MANDATORY IN FRONT OF THE BLOOM PYRAMID ────────────────
// A separable blur is a weighted SUM, so one bad texel poisons everything it
// touches: Inf × 0 = NaN, and the horizontal pass smears that NaN along a
// whole row, the vertical pass down every column, until the mip is 100% NaN
// (measured: `bloom mip0 … NaN 463680` = every texel). The composite then adds
// that to every pixel and the frame goes black — STARS AND ALL — while the
// same scene rendered straight to the canvas looks perfect, because a lone
// blown-out texel is invisible until something spreads it.
//
// Two ways a texel goes bad here: a shader producing NaN (normalize(vec3(0)),
// pow of a negative, 0/0 in the terrain/water shading), and plain HalfFloat
// OVERFLOW — the scene renders untone-mapped into a HalfFloat target, so any
// radiance above 65504 saturates to Inf. Both are cheap to neutralise, and
// clamping before bloom is standard practice in HDR pipelines (the "firefly
// clamp"): NaN → 0, and an outlier texel pulled back down.
//
// ── WHY THE CLAMP IS RELATIVE, NOT ABSOLUTE ────────────────────────────────
// The single-frame star flashes (games/world-lab/DEBUG-STAR-FLASH.md) were
// traced to a texel holding ~1.6e4 in a city beacon's hue. Nothing in the scene
// can author that: a beacon is a MeshBasicMaterial writing its uniform (≤2.6),
// the sun disc is ~4, the brightest starfield point ~8.95, the atmosphere ≤1.
// The value is manufactured by the multisample resolve — `?flashmsaa=0` removes
// it, `fatBeacons(8)` does not — so there is no author to fix, and a firefly
// clamp IS the correct mitigation rather than a patch.
//
// But a FIXED ceiling would also be a permanent ceiling on the whole engine: a
// supernova, a warp flash, anything meant to be genuinely blinding would be
// capped at the same number. So clamp on the RATIO instead, which is what
// actually distinguishes the two cases:
//
//   • A firefly is ONE texel whose neighbours are normal. Measured directly —
//     the captures read ~0.5-1.2 immediately beside a 1.6e4 texel.
//   • A supernova is a coherent bright REGION. Its neighbours are bright too,
//     so it raises its own limit and passes through untouched, at any scale.
//
// A texel is pulled down only if it exceeds BOTH `absFloor` (nothing below the
// bloom threshold can bloom, so leave it alone) AND `relMax` times the
// brightest of its 8 neighbours. Scaling is applied to the whole colour so hue
// is preserved. `clampMax` survives as a last-resort ceiling against Inf.
//
// COROLLARY FOR CONTENT: anything meant to read as bright at a distance must be
// drawn with a FOOTPRINT — a sprite with falloff, as the starfield already does
// — not a lone texel. That is also what a real bright point source looks like
// through any lens, so it is not a concession.
const clampParam = Number(new URLSearchParams(location.search).get("flashclamp"));
const relParam = Number(new URLSearchParams(location.search).get("flashrel"));
const HDR_CLAMP = Number.isFinite(clampParam) && clampParam > 0 ? clampParam : 10_000;
const FIREFLY_REL_MAX = Number.isFinite(relParam) && relParam > 0 ? relParam : 8;
/** Below this nothing can cross the bloom threshold anyway — never touch it. */
const FIREFLY_ABS_FLOOR = 4;
const sanitizePass = new ShaderPass({
  name: "HdrSanitize",
  uniforms: {
    tDiffuse: { value: null },
    clampMax: { value: HDR_CLAMP },
    relMax: { value: FIREFLY_REL_MAX },
    absFloor: { value: FIREFLY_ABS_FLOOR },
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float clampMax;
    uniform float relMax;
    uniform float absFloor;
    uniform vec2 texel;
    varying vec2 vUv;

    // Brightest channel, with NaN/Inf mapped to 0 so a bad NEIGHBOUR cannot
    // raise the limit and license the very outlier we are trying to catch.
    float peak(vec3 c) {
      float m = max(max(c.r, c.g), c.b);
      return (m == m && m < clampMax) ? m : 0.0;
    }

    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      // NaN is the only value that fails self-comparison; Inf passes it and is
      // caught by the clamp below. Negatives would also misbehave in a blur.
      vec3 c = vec3(
        t.r == t.r ? t.r : 0.0,
        t.g == t.g ? t.g : 0.0,
        t.b == t.b ? t.b : 0.0
      );
      c = clamp(c, vec3(0.0), vec3(clampMax));

      // Brightest of the 8 neighbours — the local context this texel is
      // allowed to stand out from.
      float n = 0.0;
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2( 0.0, -1.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  0.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  0.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2( 0.0,  1.0)).rgb));
      n = max(n, peak(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb));

      float m = max(max(c.r, c.g), c.b);
      float limit = max(absFloor, n * relMax);
      // Scale the whole colour, not per channel: per-channel clamping is what
      // turned these flashes arbitrary hues (magenta from R+B pinned and G not).
      if (m > limit) c *= limit / m;

      gl_FragColor = vec4(c, t.a == t.a ? t.a : 1.0);
    }`,
});
// The overflow probe sits between the raw render and the sanitize clamp, so it
// sees what the clamp is about to swallow. Read-only (needsSwap = false) — the
// presented image is identical with it in or out.
const hdrProbe = new URLSearchParams(location.search).has("flashwatch")
  ? new HdrProbePass()
  : null;
if (hdrProbe) composer.addPass(hdrProbe);

composer.addPass(sanitizePass);

const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Toggle the space look: ACES tone mapping + bloom + star-only lighting.
function setSpaceMode(on: boolean): void {
  renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = on ? BLOOM.exposure : 1;
  // Ground scopes render untone-mapped, so nothing ever reaches BLOOM.threshold
  // (2.2) and the pass emits no pixels — but an enabled UnrealBloomPass still
  // runs its whole blur pyramid every frame. Disable it off the space path.
  bloomPass.enabled = on;
  labAmbient.visible = !on;
  labSun.visible = !on;
}

const resize = (): void => {
  const w = viewEl.clientWidth;
  const h = viewEl.clientHeight;
  // Skip a zero-size layout (the flex panel hasn't been measured yet at boot) —
  // sizing the renderer + the bloom composer target to 0 leaves the space path
  // rendering into a 1×1 target (blank / compressed to the corner until a real
  // resize). The ResizeObserver below re-runs this the moment the real size
  // lands, so the first space demo comes up correctly without an inspect-element.
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  // INTEGER DEVICE-PIXEL TARGETS. EffectComposer multiplies whatever size it
  // is given by its own captured pixel ratio, so on a fractionally-scaled
  // display (Windows at 125% ⇒ dpr 1.25) `composer.setSize(cssW, cssH)` built
  // targets of 642.5 × 808.75 — FRACTIONAL. Three creates the multisampled
  // renderbuffer and its resolve texture from those, and a resolve blit
  // between mismatched integer-truncated sizes yields an undefined (black)
  // frame — intermittently, whenever the framebuffers are rebuilt, which is
  // exactly what a layout change at a rung transition triggers. Bloom made it
  // fatal rather than subtle: its mip pyramid spreads one bad resolve over
  // the entire image (disabling bloom hid the blanking, which is how this was
  // caught). So: do the device-pixel scaling HERE, rounded, and hand the
  // composer a ratio of 1.
  const dpr = renderer.getPixelRatio();
  composer.setPixelRatio(1);
  const bufW = Math.round(w * dpr);
  const bufH = Math.round(h * dpr);
  composer.setSize(bufW, bufH);
  // The firefly clamp compares each texel against its 8 NEIGHBOURS, so its taps
  // must be exactly one device pixel apart. A stale texel size would sample
  // fractions of a pixel away and blur the very distinction it depends on.
  (sanitizePass.uniforms.texel.value as THREE.Vector2).set(1 / bufW, 1 / bufH);
  // NO explicit bloomPass.setSize: composer.setSize already sizes every pass
  // (with the same integer device pixels). The old call passed CSS pixels,
  // deriving the whole mip pyramid from a resolution 1.25× off the buffer it
  // samples.
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(viewEl);

// SPACESHIP flight input: the live pointer (for nose steering) + an accumulated
// wheel delta (the exponential speed knob), consumed once per frame.
let flight: SpaceFlight | null = null;
let spaceHud: SpaceHud | null = null;
// x/y are canvas-local (flight steering); clientX/clientY are page coords (the
// embedded town host maps them through the canvas rect for its gaze).
const flightPointer = { x: 0, y: 0, clientX: 0, clientY: 0, inside: false };
let flightWheel = 0;
// The flight rung's reboot + the async-load services: geology bakes in a
// worker (geo-bake.ts), city towns fast-forward on approach (city-towns.ts),
// and each ready city stands VISIBLY on its planet — street plan from afar
// (city-visuals.ts), living residents up close (city-life.ts). Loading only
// pauses the game at a FORCE boundary (the player outran a bake).
let flightReboot: () => void = () => {};
let cityTowns: CityTownLoader | null = null;
let geoBaker: GeologyBaker | null = null;
let spawnFixPending = false;
let forceVeil = false;
// ── SPIRIT MODE — the unified spirit LADDER (shared/world-engine/spirit/):
// FLIGHT (invisible drone) > TOWN (orbit) > GROUND > STRUCTURE (dollhouse),
// driven over this lab's flight streaming world by the PLANET provider
// (./spirit/planet-provider). main.ts owns only the boot, the per-frame
// pointer feed, and the veil/status/HUD around the ladder's step. ─────────────
interface SpiritRun {
  ladder: SpiritLadder;
  drone: DroneCamera;
  spark: GazeSpark;
  focusBody: CelestialBody;
  /** A town-rung initial_focus awaiting the geology bake (the streaming
   *  world's cities exist only after it) — resolved by stepSpirit. */
  pendingFocus: { index: number } | null;
}
let spirit: SpiritRun | null = null;
// A VACUUM PLANET (a `body`/`planet` root, project_scope_object_vacuum_law): the
// planet is built from its OWN doc params (buildPlanetWorld) and rendered ALONE —
// no galaxy, no star (its sun/stars come later). The spirit ladder drives it via
// a minimal `flight` stub; the mesh LODs from the camera each frame.
interface SpiritPlanet {
  group: THREE.Group;
  planetObj: PlanetObject;
  lights: THREE.Object3D[];
}
let spiritPlanet: SpiritPlanet | null = null;
interface CityViz {
  fc: FlightCity;
  /** The city anchor group (positioned/oriented on the planet). */
  mesh: THREE.Group;
  /** The static plan's handle — per-building live handoff (city-visuals). */
  view: TownMeshView;
  /** Terrain height in town-local y at a local (x, z) — buildings and
   *  roads conform to the real ground through this. */
  ground: (x: number, z: number) => number;
  /** The town's CANONICAL surface address (body + local dir + elevation). The
   *  anchor group above is `createSurfaceChart(fc.body, point.localDir,
   *  point.elevation)` byte-for-byte; derive a live chart from it any time. */
  point: SurfacePoint<CelestialBody>;
}

// ── THE LIVE TOWN — a DISTANCE-LOD DETAIL LAYER, exactly like every other
// load in this loop (planets, regions, street plans). Within TOWN_LIVE_IN_M
// the LIVING town (residents, buildings, dialogue) mounts INTO the flight
// scene under its city anchor and starts simulating — WHILE THE PLAYER IS
// STILL FLYING. It unmounts (static plan back) past TOWN_LIVE_OUT_M. Mounting
// never touches the player: landing and take-off below are PHYSICS/CAMERA
// switches ONLY — `grounded` says who owns the avatar+camera (town walker vs
// flight-sim); the town itself lives from mount to unmount regardless.
let embedTown: EmbeddedTown | null = null;
let grounded = false;
/** Which ground layer owns the walker while grounded (town streets or a
 *  wilderness chunk). Ground is ground — same walker, camera, board. */
let groundedIn: "town" | "wild" | null = null;
let liveViz: CityViz | null = null;
// The mounted town's stage ORIGIN in sim coords. It was called the plaza
// while the ring decreed one there; growth-phase-B made the plaza an OUTPUT
// that lands wherever the walks are busiest, so this is now purely the town's
// coordinate FRAME (§0's triage: frames keep an origin, growth inputs die).
const liveCenter = { x: 0, y: 0 };
/** The live town's render anchor: a child of the city group offset by
 *  (-center.x, 0, -center.y), so the town's stage ORIGIN sits exactly on the
 *  city anchor — the same registration the static plan uses. Its LOCAL
 *  coords ARE town-sim coords (walk↔fly mappings go through this, unshifted). */
let liveAnchor: THREE.Group | null = null;
/** Terrain height at town-SIM (x, y) — viz.ground re-centred on the origin. */
let liveGround: ((x: number, y: number) => number) | null = null;

/** The mounted live town's stage — its streamer's `loadedLots()` is THE
 *  single variable driving the static↔live handoff (below). */
let liveStage: TownPlay["stage"] | null = null;

/** Static plan ⇄ live twins, ONE VARIABLE PER BUILDING: a static instance
 *  hides iff the live streamer has that lot materialized (stage.loadedLots),
 *  so exactly one of the two rendering modes shows — never both (z-fighting
 *  walls/doors), never neither (holes). Runs after every host step (the only
 *  time the streamer's set can change) and at mount. */
function syncLiveHandoff(): void {
  liveViz?.view.setLiveLots(liveStage?.loadedLots?.() ?? null);
}

// ── WILDERNESS GROUND (ground is ground) ────────────────────────────────────
// Touching down away from a town mounts a wilderness chunk at the landing
// point through the SAME walker/camera/board machinery a town uses — content
// grown from the landing cell's BIOME (wilderness-boot.ts). Unmounts by
// distance like everything else.
/** ONE handle shape whichever boot mounted the chunk: the legacy sandbox
 *  (bootWilderness) or the unified quest session (bootWildernessQuest) —
 *  every coordinator site drives the WildernessGround surface; the optional
 *  members are the unified path's extras (pocket handoff, board claims). */
type WildHandle = WildernessGround & {
  quest?: QuestHost3D;
  claimBoard?: () => void;
};
let embedWild: WildHandle | null = null;
/** The positioned anchor on the planet (parent) + the sim-frame child. */
let wildRoot: THREE.Group | null = null;
let wildAnchor: THREE.Group | null = null;
// MUTABLE samplers: the wilderness host receives WRAPPERS over these, so a
// floating-origin re-anchor (maybeRebaseWild) swaps the chart under the live
// sim without remounting anything.
let wildGround: ((x: number, y: number) => number) | null = null;
let wildWater: ((x: number, y: number) => boolean) | null = null;
/** The wilderness chunk's canonical surface address (body + local dir + elevation)
 *  — the same SurfacePoint abstraction a town carries. A ground view anywhere is
 *  just a chart at a point + whatever content streams there. */
let wildPoint: SurfacePoint<CelestialBody> | null = null;
/** WORLD-FIXED flora streaming (flora-field.ts): tree positions are a pure
 *  function of (world seed, planet position) — tiles stream by distance from
 *  the ground focus airborne or grounded; impostors resolve near the player.
 *  One field per low body; recreated when the low body changes. */
let flora: FloraField | null = null;
let floraBodyId: string | null = null;
let floraAcc = 0;
const FLORA_ALT_M = 3_000; // stream flora when this low over a baked body
const _wildPos = new THREE.Vector3();
const _floraFocus = new THREE.Vector3();
const _floraPlayer = new THREE.Vector3();

/** The grounded layer's control surface — one shape whichever ground owns the
 *  walker, so take-off/pointer/step code never cares which it is. */
interface GroundCtx {
  host: {
    step(dt: number, now: number): void;
    setPointer(clientX: number, clientY: number): void;
    clearPointer(): void;
    setDriveCamera(on: boolean): void;
    setLocalAvatarHidden(hidden: boolean): void;
  };
  pose(): { x: number; y: number; fx: number; fy: number } | null;
  ground(x: number, y: number): number;
  anchor: THREE.Group;
}
function groundCtx(): GroundCtx | null {
  if (groundedIn === "town" && embedTown && liveAnchor && liveGround) {
    return { host: embedTown.host, pose: () => embedTown!.playerPose(), ground: liveGround, anchor: liveAnchor };
  }
  if (groundedIn === "wild" && embedWild && wildAnchor && wildGround) {
    return { host: embedWild.host, pose: () => embedWild!.playerPose(), ground: wildGround, anchor: wildAnchor };
  }
  return null;
}

// ── PLANET-SCALE FOUNDING (nations P0): a site founded in the walkable
// wilderness becomes a PLANET feature — a beacon in the flight registry and
// a town-loader override, so flying away and returning rebuilds ITS town
// (siteTownConfig: founded buildings, yard stock, standing routes) through
// the same approach ladder every city uses. Session-lived, like every other
// planet mutation today. ─────────────────────────────────────────────────
/** Founded-site cell namespace — disjoint from capitals (< nCells), village
 *  keys (region*16384+child, ≲2.3e8) and border towns (negative). */
const FOUNDED_CELL_BASE = 1_000_000_000;
/** Every site this session has founded on a planet. `dir`/`surfaceR` are its
 *  BODY-LOCAL address — the one frame two sites founded in different
 *  wilderness sessions can be compared in (growth phase C §3.2/§3.3: the
 *  access lane and the homestead cluster both need "how far is that one from
 *  this one" across sessions). `record` is the site itself when we have it,
 *  which is what a cluster merges. */
const foundedPlanetSites = new Map<string, {
  cell: number; bodyId: string;
  dir: [number, number, number]; surfaceR: number;
  record?: FoundedSite;
}>();

/** The wild session's QUEST host, when the unified-ground boot owns the
 *  chunk (the legacy sandbox boot has no session — narrow by its
 *  quest-only member). */
function wildQuestSession(): QuestSession | null {
  return embedWild && "quest" in embedWild && embedWild.quest
    ? embedWild.quest.session
    : null;
}

/** The live wild session's own founded site's cell — its town must NOT
 *  mount as a city town while the wilderness sim still owns the ground. */
function liveFoundedSiteCell(): number | null {
  const key = wildQuestSession()?.foundedSite?.key;
  return key ? foundedPlanetSites.get(key)?.cell ?? null : null;
}

function registerFoundedPlanetSite(site: {
  key: string; seed: number; at: { x: number; y: number }; stock: Record<string, number>;
}): void {
  if (!flight || !wildPoint || !wildAnchor || !cityTowns) return;
  const body = wildPoint.body;
  // Chunk-sim → body-local surface direction (the site's canonical address).
  const gy = wildGround?.(site.at.x, site.at.y) ?? 0;
  const world = wildAnchor.localToWorld(new THREE.Vector3(site.at.x, gy, site.at.y));
  const local = body.group.worldToLocal(world);
  const r = local.length();
  if (r < 1e-6) return;
  const dir: [number, number, number] = [local.x / r, local.y / r, local.z / r];
  const cell = FOUNDED_CELL_BASE + site.seed;
  const pc: PlanetCity = {
    cell,
    name: site.key,
    dir,
    density: 0, // no wild crowd founded this — the player did
    charter: { farmland: 60, ore_access: 0, timberland: 0 },
    startPop: 0, // zero-building growth: settlers raise everything (①b)
  };
  flight.addCities(body.id, [pc]);
  const live = wildQuestSession()?.foundedSite;
  foundedPlanetSites.set(site.key, {
    cell, bodyId: body.id, dir, surfaceR: r,
    ...(live && live.key === site.key ? { record: live } : {}),
  });
  if (live && live.key === site.key) cityTowns.registerFounded(cell, siteTownConfig(live));
  traceWalk(`founded site registered on planet: ${site.key} (cell ${cell})`);
  // THE FOUNDING CADENCE (growth phase C §3.3): a new homestead is the only
  // thing that can complete a cluster, so the check rides the founding.
  maybeFoundTownOverCluster(body.id);
}

/** SESSION COORDS of every OTHER site standing on this body — the standing
 *  circulation a new founding's access lane may reach (growth phase C §3.2,
 *  `QuestHostDeps.siteNetworkAt`). Body-local dir → world → the wilderness
 *  anchor's frame, the exact inverse of the projection above. */
function foundedSiteNetwork(): Array<{ x: number; y: number }> {
  if (!wildPoint || !wildAnchor) return [];
  const bodyId = wildPoint.body.id;
  const liveKey = wildQuestSession()?.foundedSite?.key;
  const out: Array<{ x: number; y: number }> = [];
  for (const [key, rec] of foundedPlanetSites) {
    if (rec.bodyId !== bodyId || key === liveKey) continue;
    const world = wildPoint.body.group.localToWorld(
      new THREE.Vector3(rec.dir[0], rec.dir[1], rec.dir[2]).multiplyScalar(rec.surfaceR),
    );
    const localPt = wildAnchor.worldToLocal(world);
    out.push({ x: localPt.x, y: localPt.z });
  }
  return out;
}

/** Town-local METRES of `dir` about `about` — the tangent chart a cluster is
 *  merged in. Sites founded in different wilderness sessions share no sim
 *  frame; the body does. */
function siteOffsetM(
  about: readonly [number, number, number], dir: readonly [number, number, number], radius: number,
): { x: number; y: number } {
  const a = new THREE.Vector3(about[0], about[1], about[2]);
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]);
  const up = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(up, a).normalize();
  const north = new THREE.Vector3().crossVectors(a, east).normalize();
  // Gnomonic: the chord is metres at the reach a cluster is measured over.
  const w = d.dot(a) || 1e-9;
  return { x: (d.dot(east) / w) * radius, y: (d.dot(north) / w) * radius };
}

/**
 * HOMESTEAD CLUSTERING (growth phase C §3.3): N founded sites standing
 * within one camp's reach of each other stop being farms and become a TOWN,
 * by RE-PARENTING — the eldest's cell keeps the address, the rest unregister
 * into it, and the merged overlay (stock conserved, buildings annexed, lanes
 * turned into spine seeds) is what the approach ladder rebuilds from.
 *
 * The live session's OWN site is left out: the wilderness sim still owns that
 * ground (`liveFoundedSiteCell`), and a town may not mount under the player's
 * feet. It joins on the next founding after this session lets go.
 */
function maybeFoundTownOverCluster(bodyId: string): void {
  if (!cityTowns || !flight) return;
  const liveKey = wildQuestSession()?.foundedSite?.key;
  const here = [...foundedPlanetSites.entries()]
    .filter(([key, r]) => r.bodyId === bodyId && r.record && key !== liveKey);
  if (here.length < CLUSTER_MIN_SITES) return;
  const radius = wildPoint?.body.radius ?? 0;
  if (!(radius > 0)) return;
  // One chart for the whole body's sites, about the first — good enough to
  // measure neighbourhood in; the merge re-charts about the cluster's eldest.
  const about = here[0]![1].dir;
  const flat = here.map(([key, r]) => ({
    key, rec: r,
    site: { ...r.record!, at: siteOffsetM(about, r.dir, radius) } as FoundedSite,
  }));
  const byKey = new Map(flat.map(f => [f.site.key, f]));
  const reach = clusterRadiusM(docSessionScale() ?? REAL_SCALE, radius * 2);
  for (const group of clusterSites(flat.map(f => f.site), reach)) {
    const members = group.map(s => byKey.get(s.key)!).filter(Boolean);
    if (members.length < CLUSTER_MIN_SITES) continue;
    // Re-chart about the ELDEST — the town's frame origin and its address.
    const head = members[0]!;
    const merged = mergeSites(members.map(m => ({
      ...m.rec.record!,
      at: siteOffsetM(head.rec.dir, m.rec.dir, radius),
    } as FoundedSite)));
    cityTowns.registerFounded(head.rec.cell, siteTownConfig(merged));
    // The absorbed sites UNREGISTER into the town (snapshotLive's precedent:
    // a ground-owned thing acquires a new parent identity and its
    // construction record travels — it is already inside `merged`).
    for (const m of members.slice(1)) {
      flight.removeCities([m.rec.cell]);
      cityTowns.dropFounded(m.rec.cell);
      foundedPlanetSites.delete(m.key);
    }
    foundedPlanetSites.set(head.key, { ...head.rec, record: merged });
    traceWalk(
      `homestead cluster founded a town: ${members.map(m => m.key).join(" + ")} → ${head.key} (cell ${head.rec.cell})`,
    );
  }
}

function unregisterFoundedPlanetSite(key: string): void {
  const rec = foundedPlanetSites.get(key);
  if (!rec) return;
  flight?.removeCities([rec.cell]);
  cityTowns?.dropFounded(rec.cell);
  foundedPlanetSites.delete(key);
}

/** Refresh a live site's town config from its CURRENT deltas — called as
 *  the wilderness chunk lets go, so the approach loader rebuilds tomorrow's
 *  town from today's site (buildings, stock, ledger — all serialized). */
function snapshotLiveFoundedSite(): void {
  const live: FoundedSite | null | undefined = wildQuestSession()?.foundedSite;
  if (!live) return;
  const rec = foundedPlanetSites.get(live.key);
  if (!rec) return;
  cityTowns?.registerFounded(rec.cell, siteTownConfig(live));
  // The record travels with the config — the site's own overlay is what a
  // later cluster merges (§3.3), and this is the moment it stops being live.
  foundedPlanetSites.set(live.key, { ...rec, record: live });
  // The chunk is letting go, so this site is no longer under the player's
  // feet: it may join a cluster now (the founding cadence's other moment).
  maybeFoundTownOverCluster(rec.bodyId);
}

function disposeWilderness(): void {
  if (embedWild) traceWalk(`disposeWilderness (groundedIn=${groundedIn})`);
  snapshotLiveFoundedSite();
  clearFloraTwins(); // every twin dies with its session — all scenery again
  embedWild?.dispose();
  embedWild = null;
  if (wildRoot) { wildRoot.parent?.remove(wildRoot); wildRoot = null; }
  wildAnchor = null;
  wildGround = null;
  wildWater = null;
  wildPoint = null;
  if (groundedIn === "wild") {
    grounded = false;
    groundedIn = null;
    flight?.setAvatarVisible(true);
    spaceHud?.setVisible(true);
  }
}

const _UP_Y = new THREE.Vector3(0, 1, 0);
/** Attach a child group to `body.group` at a body-LOCAL surface point, oriented
 *  +Y-out — the ONE way EVERY ground layer (a town, a wilderness chunk, a lone
 *  feature) sits on a body. The group's LOCAL frame IS the SurfaceChart's frame at
 *  that point: its world transform equals `createSurfaceChart(point)` (origin +
 *  quat), so content authored in chart (x = east, z = north) metres lands
 *  correctly wherever it mounts — no per-settlement coordinate root, no temp town. */
function attachSurfaceAnchor(point: SurfacePoint<CelestialBody>): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(point.localDir).multiplyScalar(point.body.radius + point.elevation);
  g.quaternion.setFromUnitVectors(_UP_Y, point.localDir);
  // A ground layer hangs INSIDE the planet's group (its spin carries it), but
  // it runs its own fades — the dollhouse cutaway, see-inside storeys, blended
  // sprites. Claim the subtree so the sky's force-opaque pass prunes it
  // instead of resetting every wall/roof fade to opacity 1 each frame.
  g.userData[OWNS_MATERIAL_STATE] = true;
  point.body.group.add(g);
  return g;
}

/** A failed wild boot must not re-throw every glide frame — back off. */
let wildMountRetryAt = -1;

/** Mount the walkable wilderness CHUNK (anchor + samplers + quest session) at
 *  a WORLD position, WITHOUT granting it the walker — the same proximity-mount
 *  contract a town has (mountLiveTown): the chunk renders and LIVES, camera
 *  and avatar stay with whoever owns them (flight, or the spirit glide, which
 *  parks the hidden gaze avatar through spiritParkWild). A touchdown grants
 *  the walker on top (mountWildernessAt). Returns whether a chunk is live.
 *  Flora is NOT here — it's the world-fixed streaming field; this chunk is
 *  the entity engine: gatherable scatter + fauna + minds. */
function mountWildChunk(pos: THREE.Vector3, fwdWorld?: THREE.Vector3): boolean {
  if (embedWild) return true;
  if (!flight || performance.now() < wildMountRetryAt) return false;
  const nb = flight.world.nearestBodyAltitudeAt(pos);
  const body = nb.body;
  const geo = body?.geography;
  if (!body || !body.walkable || !geo) return false;
  // Body-local landing direction (the anchor's radial).
  const local = body.group.worldToLocal(_wildPos.copy(pos));
  const r = local.length();
  if (r < 1e-3) return false;
  const dir = new THREE.Vector3(local.x / r, local.y / r, local.z / r);
  const dirArr: [number, number, number] = [dir.x, dir.y, dir.z];
  if (geo.surface.heightAt(dirArr) < 0) return false; // water — flight swims / glide holds the ray
  try {
    // Anchor on the surface via the SHARED surface-anchor — the identical frame a
    // town uses (its local frame IS the SurfaceChart at this landing point).
    const h0 = Math.max(0, geo.surface.heightAt(dirArr));
    wildPoint = { body, localDir: dir, elevation: h0 };
    const g = attachSurfaceAnchor(wildPoint);
    const samplers = makeSurfaceSamplers(body, dirArr, g);
    // Sim coords run 0..WILD_SIDE with the anchor at the CENTER (the same
    // child-group registration a town uses).
    wildRoot = g;
    wildAnchor = new THREE.Group();
    wildAnchor.position.set(-WILD_SIDE / 2, 0, -WILD_SIDE / 2);
    g.add(wildAnchor);
    wildAnchor.updateWorldMatrix(true, false);
    wildGround = (x, y) => samplers.ground(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
    wildWater = (x, y) => samplers.water(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
    // The landing cell's biome decides what grazes here (plants are the
    // world-fixed field). Fauna reshuffles per mount — herds move.
    const cell = geo.grid.topo.cellAt ? geo.grid.topo.cellAt(dirArr) : 0;
    const biome = geo.grid.fields.biome ? geo.grid.fields.biome[cell] : 0;
    embedWild = UNIFIED_GROUND
      ? // SLICE 1: open country is a QuestHost3D wilderness session — minded,
        // talkable, possessable creatures on the same host class as the town
        // side of the border (its boot claims the shared board: the walker
        // lands here whenever this mounts).
        bootWildernessQuest(
          viewEl,
          renderer.domElement,
          // castGroundRay: the wild chunk draws no ground of its own — its gaze
          // pick must land on the flight scene's streamed meshes (terrain,
          // roads, trees), not on the analytic sampler they approximate.
          { scene, camera, anchor: wildAnchor, castGroundRay: castDrawnGround },
          t => { baseStatus = t; setStatus(t); },
          labBoard,
          // WRAPPERS, not the closures themselves: a floating-origin re-anchor
          // swaps the chart's samplers in place under the live sim.
          (x, y) => wildGround?.(x, y) ?? 0,
          (x, y) => wildWater?.(x, y) ?? false,
          {
            seed: (cell * 2654435761) >>> 0,
            fauna: faunaForBiome(biome),
            // ONE TREE AUTHORITY: the flora field's streamed trees become
            // this session's interactive features (syncFloraTwins) — the
            // biome mix must not scatter a SECOND, unrelated population of
            // the same species. Everything the field doesn't render (rocks,
            // fruit plants, animals) still comes from the mix.
            wildMix: wildMixForBiome(biome, (cell * 2654435761) >>> 0)
              .filter(m => m.species !== FLORA_TREE_SPECIES),
            spirit: spirit !== null,
            ...(docSessionScale() ? { scale: docSessionScale() } : {}),
            // Nearby planet cities as trade partners for a site FOUNDED out
            // here (P0). Late-bound off the LIVE anchor: a floating-origin
            // re-anchor moves wildPoint/wildRoot and the bearings follow.
            tradePartners: () =>
              wildPoint && wildRoot
                ? nearbyCityPartners(
                    wildPoint.body,
                    _wildPartnerDir.copy(wildPoint.localDir).normalize(),
                    wildRoot.quaternion,
                    { x: WILD_SIDE / 2, y: WILD_SIDE / 2 },
                    null,
                  )
                : [],
            // Planet-scale founding (P0): a spoken "build" out here raises a
            // planet feature — beacon + approach-loader entry — not just a
            // chunk-local crate.
            onSiteFounded: (site) => registerFoundedPlanetSite(site),
            // THE ACCESS LANE's other end (growth phase C §3.2): the standing
            // homesteads this founder can already reach. The session cannot
            // know them — they were founded in other sessions — so the boot
            // answers, and the new site records its lane to the nearest.
            siteNetworkAt: () => foundedSiteNetwork(),
            onSiteAbandoned: (key) => unregisterFoundedPlanetSite(key),
          },
        )
      : bootWilderness(
          renderer.domElement,
          { scene, camera, anchor: wildAnchor, castGroundRay: castDrawnGround },
          (x, y) => wildGround?.(x, y) ?? 0,
          (x, y) => wildWater?.(x, y) ?? false,
          faunaForBiome(biome),
          (cell * 2654435761) >>> 0,
        );
    // The incoming heading carries into the parked body (chunk centre = pos).
    const fwd = fwdWorld
      ? _lp2.copy(fwdWorld).transformDirection(_inv.copy(wildAnchor.matrixWorld).invert())
      : _lp2.set(0, 0, 1);
    embedWild.placePlayer(WILD_SIDE / 2, WILD_SIDE / 2, fwd.x, fwd.z);
    // Mounted WITHOUT the walker: camera + avatar stay with their owner until
    // a touchdown grants them (mountWildernessAt / maybeLand).
    embedWild.host.setDriveCamera(false);
    embedWild.host.setLocalAvatarHidden(true);
    traceWalk(`wilderness chunk mounted (${UNIFIED_GROUND ? "quest" : "plain"})`);
    return true;
  } catch (err) {
    traceWalk(`wilderness mount FAILED: ${(err as Error).message}`);
    disposeWilderness();
    wildMountRetryAt = performance.now() + 5000;
    setStatus((err as Error).message, true);
    return false;
  }
}

/** FLY→LAND at open country: mount the chunk AND grant it the walker. Only
 *  called with no chunk live (an existing one claims via maybeLand's bounds
 *  check / is disposed first), so the fresh chunk centres on the touchdown. */
function mountWildernessAt(pos: THREE.Vector3, fwdWorld: THREE.Vector3): void {
  if (!flight) return;
  if (!mountWildChunk(pos, fwdWorld)) return;
  const ew = embedWild;
  if (!ew) return;
  grounded = true;
  groundedIn = "wild";
  flight.setAvatarVisible(false);
  spaceHud?.setVisible(false);
  ew.host.setDriveCamera(true);
  ew.host.setLocalAvatarHidden(false);
  traceWalk("wilderness walker granted (touchdown)");
  setStatus("wilderness — walk with the mouse · aim at the top of the screen to take off");
}

/** FLOATING-ORIGIN RE-ANCHOR (no invisible walls, no remount): when the walker
 *  strays toward the chunk's edge, MOVE the surface anchor to where they stand
 *  and re-express the live sim in the new chart — same world, same bodies,
 *  same camera; world poses are unchanged by construction. This is the ground
 *  sim's twin of the flight scene's camera rebase: the PLANET is the reference
 *  frame, and the chart is just the 2D engine's local window onto it. Nothing
 *  here knows or cares where any city is. */
const _rbPrev = new THREE.Matrix4();
const _rbDelta = new THREE.Matrix4();
const _rbQ = new THREE.Quaternion();
const _rbV = new THREE.Vector3();
function maybeRebaseWild(): void {
  if (!flight || !embedWild || !wildRoot || !wildAnchor || !wildGround || !wildPoint) return;
  const pose = embedWild.playerPose();
  if (!pose) return;
  const MARGIN = 24;
  if (pose.x > MARGIN && pose.x < WILD_SIDE - MARGIN && pose.y > MARGIN && pose.y < WILD_SIDE - MARGIN) return;
  const body = wildPoint.body;
  const geo = body.geography;
  if (!geo) return;
  // The walker's WORLD position through the CURRENT chart names the new anchor.
  wildAnchor.updateWorldMatrix(true, false);
  const gOld = wildGround;
  const worldPos = wildAnchor.localToWorld(_lp.set(pose.x, gOld(pose.x, pose.y), pose.y));
  const local = body.group.worldToLocal(_rbV.copy(worldPos));
  const r = local.length();
  if (r < 1e-3) return;
  const dir = local.multiplyScalar(1 / r).clone();
  const dirArr: [number, number, number] = [dir.x, dir.y, dir.z];
  if (geo.surface.heightAt(dirArr) < 0) return; // at a shoreline: hold this chart, retry on land
  _rbPrev.copy(wildAnchor.matrixWorld);
  // Move the SAME anchor group (the render scene hangs under it and rides along).
  const h0 = Math.max(0, geo.surface.heightAt(dirArr));
  wildPoint = { body, localDir: dir, elevation: h0 };
  wildRoot.position.copy(dir).multiplyScalar(body.radius + h0);
  wildRoot.quaternion.setFromUnitVectors(_UP_Y, dir);
  wildRoot.updateWorldMatrix(true, true);
  const samplers = makeSurfaceSamplers(body, dirArr, wildRoot);
  wildGround = (x, y) => samplers.ground(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
  wildWater = (x, y) => samplers.water(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
  // delta: new-anchor local ← old-anchor local; sim POINTS lift at the OLD
  // chart's ground height (they sit ON the surface — a y=0 lift would smear
  // them sideways by chart tilt × elevation), VECTORS take the rotation only.
  _rbDelta.copy(wildAnchor.matrixWorld).invert().multiply(_rbPrev);
  _rbQ.setFromRotationMatrix(_rbDelta);
  embedWild.rebase(
    _rbDelta,
    p => {
      _rbV.set(p.x, gOld(p.x, p.y), p.y).applyMatrix4(_rbDelta);
      return { x: _rbV.x, y: _rbV.z };
    },
    v => {
      _rbV.set(v.x, 0, v.y).applyQuaternion(_rbQ);
      return { x: _rbV.x, y: _rbV.z };
    },
  );
  embedWild.refreshFauna();
  traceWalk("wild chart rebased under the walker");
}

// ── DATUM PROBE (press G near a live town) ──────────────────────────────────
// Measures how far the RENDERED terrain mesh sits from the town's height
// datum (liveGround — the same surface.heightAt the buildings conform to) at
// a ring of points around the walker. Positive = the drawn ground is ABOVE
// the datum (town sunk); negative = below (town floats). Numbers go to the
// console and the status line — turning "the town floats" into metres.
const _probeRay = new THREE.Raycaster();
const _probeOrigin = new THREE.Vector3();
const _probeDir = new THREE.Vector3();
const _probeUp = new THREE.Vector3();
const _probeLocal = new THREE.Vector3();

/** Meshes only — raycasting sprites needs Raycaster.camera and the beacon /
 *  bubble sprites crash the sweep (and aren't terrain anyway). */
function probeMeshes(root: THREE.Object3D, exclude?: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse(o => {
    if (!(o as THREE.Mesh).isMesh) return;
    if (exclude) {
      let n: THREE.Object3D | null = o;
      while (n) { if (n === exclude) return; n = n.parent; }
    }
    out.push(o as THREE.Mesh);
  });
  return out;
}

// ── SPARK PROBE: not-drawn vs off-screen ─────────────────────────────────────
// "No spark on screen" has two completely different causes and they are not
// separable by eye. This projects the spark's OWN eased position through the
// live camera and says which one it is:
//   • amp≈0 / core≈0        → never DRAWN (hidden, or mid-dart at zero size)
//   • amp>0 and OFF@…       → drawn, but placed outside the frustum
// The spark's stored position is in its GROUP's frame (the planet's body group
// — it is an object on the planet), so lift it through the group's world matrix
// before projecting, or the answer is nonsense.
const _sparkWorld = new THREE.Vector3();
const _sparkNdc = new THREE.Vector3();
function sparkProbe(s: SpiritRun): string {
  s.spark.debugPose(_sparkWorld);
  s.spark.group.updateWorldMatrix(true, false);
  _sparkWorld.applyMatrix4(s.spark.group.matrixWorld);
  const dist = camera.position.distanceTo(_sparkWorld);
  _sparkNdc.copy(_sparkWorld).project(camera);
  const onScreen =
    Math.abs(_sparkNdc.x) <= 1 && Math.abs(_sparkNdc.y) <= 1 && _sparkNdc.z >= -1 && _sparkNdc.z <= 1;
  const w = viewEl.clientWidth || 1;
  const h = viewEl.clientHeight || 1;
  const px = `${Math.round((_sparkNdc.x * 0.5 + 0.5) * w)},${Math.round((-_sparkNdc.y * 0.5 + 0.5) * h)}`;
  return `${s.spark.debugState()} d${dist.toFixed(1)} ${
    onScreen ? `ON@${px}` : `OFF@${px}z${_sparkNdc.z.toFixed(2)}`
  }`;
}

// ── GROUND CURSOR CAST ───────────────────────────────────────────────────────
// The ground-mode cursor sits where the POINTER RAY meets the DRAWN world —
// the same discipline a live town host's engine cursor uses against its own
// meshes — so the spark can never drift off the pixel the player is gazing
// at, whatever the analytic surface and the LOD mesh disagree about. Targets:
// the streamed terrain chunks plus the trade-road ribbons (the cursor rests
// on a road when it points at one, exactly as the aim probe reports).
const _castRay = new THREE.Raycaster();
let castMeshes: THREE.Mesh[] = [];
let castMeshesAt = -1;

/** Is this object — and every ancestor — actually being DRAWN right now?
 *  THREE'S RAYCASTER DOES NOT SKIP INVISIBLE OBJECTS, and these mesh lists are
 *  cached for ~1s, so a chunk the LOD superseded moments ago is still a
 *  perfectly good ray target while being nowhere on screen. Those superseded
 *  chunks sit metres BELOW the finer skin that replaced them, so a cursor
 *  seated on one is seated underground — visible only when you hide the
 *  terrain. Build-time filtering is not enough; the check has to happen at
 *  CAST time, against this frame's visibility. */
function liveVisible(o: THREE.Object3D): boolean {
  let n: THREE.Object3D | null = o;
  while (n) {
    if (!n.visible) return false;
    n = n.parent;
  }
  return true;
}
/** Is this mesh SOLID on screen, or has it been faded out of the way?
 *  The dollhouse cutaway hides walls two different ways: cut walls go
 *  `visible = false` (caught by liveVisible), but roofs and see-inside walls
 *  merely FADE — still fully raycastable at opacity 0.05. A cursor that stops
 *  on a wall the player cannot see is placed inside a building: it looks
 *  roughly right (it is near the surface it should be on) but real geometry
 *  then occludes it, which is why it only ever appeared with depth OFF.
 *  Treat anything faded as though it were not there. */
const CURSOR_SOLID_OPACITY = 0.5;
function drawnSolid(o: THREE.Object3D): boolean {
  const mats = (o as THREE.Mesh).material;
  for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
    if (m.transparent && m.opacity < CURSOR_SOLID_OPACITY) return false;
  }
  return true;
}
/** The first intersection that is still attached to the scene AND drawn. */
function firstLiveHit(hits: THREE.Intersection[]): THREE.Intersection | null {
  for (const h of hits) {
    if (!h.object.parent) continue;        // detached by streaming since the list was built
    if (!liveVisible(h.object)) continue;  // superseded LOD chunk: in the list, off the screen
    if (!drawnSolid(h.object)) continue;   // cut-away wall / faded roof: not really there
    return h;
  }
  return null;
}
/** DIAGNOSTICS: last `castDrawnGround` verdict — surfaced on the status line. */
let castDbg = "-";
function drawnGroundMeshes(body: CelestialBody): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  // TOWN CONTENT IS PLANET CONTENT. A settlement's buildings, walls and
  // residents are PHYSICAL LOADED OBJECTS ON THE PLANET that merely happen to
  // stand inside a town — only ABSTRACTIONS (the roster, the plan, the
  // economy, the common knowledge) live in a town's own context. So the
  // cursor resolves against them by exactly the rule it uses for terrain:
  // one drawn world, one ray, no town in the loop.
  const townRoots: THREE.Object3D[] = [];
  for (const viz of cityViz.values()) if (viz.fc.body === body) townRoots.push(viz.mesh);
  body.group.traverse(o => {
    if (!(o as THREE.Mesh).isMesh) return;
    // ONLY WHAT IS ACTUALLY DRAWN. Three's raycaster does NOT skip invisible
    // objects, and LOD streaming keeps superseded chunk meshes in the graph —
    // casting one places the cursor under the visible ground (the buried-spark
    // bug: the spark rendered exactly where the cast said, beneath the skin).
    // Re-checked per cast as well, since this list is cached (firstLiveHit).
    let n: THREE.Object3D | null = o;
    let eligible = o.name.startsWith("chunk_");
    while (n && n !== body.group) {
      if (!n.visible) return;
      if (!eligible && (n.name === "trade-roads" || n.name.startsWith("flora:") || townRoots.includes(n))) {
        eligible = true;
      }
      n = n.parent;
    }
    if (eligible) out.push(o as THREE.Mesh);
  });
  return out;
}
function castDrawnGround(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Vector3 | null {
  if (!flight) { castDbg = "noflight"; return null; }
  const body = flight.world.nearestBodyAltitudeAt(origin).body;
  if (!body) { castDbg = "nobody"; return null; }
  // Refresh the mesh list ~1/s (streaming mounts/unmounts chunks and roads).
  const t = performance.now();
  if (t - castMeshesAt > 800) {
    castMeshes = drawnGroundMeshes(body);
    castMeshesAt = t;
  }
  if (!castMeshes.length) { castDbg = "nomesh"; return null; }
  // Picks precede render(): the rebase just moved the world, so the target
  // matrixWorld is a frame stale — refresh before casting (the planet-sweep
  // dart bug otherwise; see the host-pick rule).
  for (const m of castMeshes) m.updateWorldMatrix(true, false);
  _castRay.set(origin, dir);
  _castRay.near = 0;
  _castRay.far = far;
  _castRay.camera = camera;
  const hits = _castRay.intersectObjects(castMeshes, false);
  const hit = firstLiveHit(hits);
  // A hit rejected as stale means the cached list has drifted from what is on
  // screen — rebuild it on the next call rather than waiting out the TTL, so
  // the cursor self-heals within a frame instead of staying underground.
  if (hits.length && !hit) castMeshesAt = -1;
  // PROBE: the wilderness cursor lives or dies here. `n` = meshes cast against,
  // `age` = ms since the list was rebuilt, `stale` = every hit was on a mesh
  // that is detached or no longer drawn (a superseded LOD chunk — seating the
  // cursor there buries it under the visible ground).
  castDbg = `n${castMeshes.length}/age${Math.round(t - castMeshesAt)}/${
    !hits.length ? "miss" : !hit ? `stale${hits.length}` : `hit:${hit.object.name || "?"}`
  }`;
  return hit ? hit.point : null;
}

// TERRAIN-ONLY drawn cast (chunks; no roads, no trees): the camera floor below
// must never hoist the view onto a treetop the rig legitimately slid under.
let terrainCastMeshes: THREE.Mesh[] = [];
let terrainCastMeshesAt = -1;
function castDrawnTerrain(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Vector3 | null {
  if (!flight) return null;
  const body = flight.world.nearestBodyAltitudeAt(origin).body;
  if (!body) return null;
  const t = performance.now();
  if (t - terrainCastMeshesAt > 800) {
    terrainCastMeshes = drawnGroundMeshes(body).filter(m => m.name.startsWith("chunk_"));
    terrainCastMeshesAt = t;
  }
  if (!terrainCastMeshes.length) return null;
  for (const m of terrainCastMeshes) m.updateWorldMatrix(true, false);
  _castRay.set(origin, dir);
  _castRay.near = 0;
  _castRay.far = far;
  _castRay.camera = camera;
  const hits = _castRay.intersectObjects(terrainCastMeshes, false);
  const hit = firstLiveHit(hits);
  if (hits.length && !hit) terrainCastMeshesAt = -1; // stale list — rebuild next call
  return hit ? hit.point : null;
}

// ── CAMERA GROUND FLOOR (planet law: the DRAWN world wins) ──────────────────
// Every rig poses the camera from ANALYTIC heights, but the player sees the
// LOD terrain skin, which sits metres off the analytic surface (worst near a
// town's edge). A rig pose that dips under the drawn skin puts the camera
// INSIDE the planet — the whole screen goes blank; rung-transition sweeps
// flash the same way when the interpolated pose grazes the skin. Render-side
// floor: sample the drawn terrain radially above/below the camera and lift the
// camera to a minimum clearance over the hit. Planet-frame, town-agnostic, and
// a no-op whenever the rig is already above the drawn ground.
const CAM_FLOOR_M = 1.2;
const _cfBody = new THREE.Vector3();
const _cfUp = new THREE.Vector3();
const _cfOrigin = new THREE.Vector3();
const _cfDown = new THREE.Vector3();
let camFloorTraceAt = 0;
function clampCameraAboveDrawnGround(): void {
  if (!flight) return;
  const nb = flight.world.nearestBodyAltitudeAt(camera.position);
  const body = nb.body;
  // Near-surface concern only — high flight never grazes the skin.
  if (!body || !Number.isFinite(nb.altitude) || nb.altitude > 2000) return;
  body.group.getWorldPosition(_cfBody);
  _cfUp.copy(camera.position).sub(_cfBody).normalize();
  _cfOrigin.copy(camera.position).addScaledVector(_cfUp, 200);
  _cfDown.copy(_cfUp).negate();
  const hit = castDrawnTerrain(_cfOrigin, _cfDown, 600);
  if (!hit) return;
  const clearance = _cfOrigin.sub(hit).dot(_cfUp) - 200; // camera height over the drawn skin
  if (clearance >= CAM_FLOOR_M) return;
  camera.position.addScaledVector(_cfUp, CAM_FLOOR_M - clearance);
  if (performance.now() - camFloorTraceAt > 1000) {
    camFloorTraceAt = performance.now();
    traceWalk(`camera lifted ${(CAM_FLOOR_M - clearance).toFixed(1)}m above the drawn terrain (was ${clearance.toFixed(1)}m)`);
  }
}

/** AIM PROBE: cast through the pointer and report what the cursor is on —
 *  each hit's mesh name + ancestry, and for terrain hits the rendered-height
 *  vs surface.heightAt datum error at that exact spot. Point at each side of
 *  a seam and press G twice: the two reports identify the plates. */
function probeAim(): void {
  if (!flight) return;
  const w = viewEl.clientWidth || 1;
  const h = viewEl.clientHeight || 1;
  const ndc = new THREE.Vector2((flightPointer.x / w) * 2 - 1, -((flightPointer.y / h) * 2 - 1));
  _probeRay.setFromCamera(ndc, camera);
  _probeRay.camera = camera;
  _probeRay.far = Infinity;
  const hits = _probeRay.intersectObjects(probeMeshes(scene), false).slice(0, 3);
  if (!hits.length) { console.log("[aim probe] no mesh under cursor"); return; }
  for (const hit of hits) {
    const chain: string[] = [];
    let n: THREE.Object3D | null = hit.object;
    while (n && chain.length < 8) { chain.push(n.name || n.type); n = n.parent; }
    const report: Record<string, unknown> = {
      mesh: chain.join(" ← "),
      dist_m: Math.round(hit.distance),
    };
    // Terrain datum check: hit point → body-local → radius vs heightAt.
    const nb = flight.world.nearestBodyAltitudeAt(hit.point);
    const surf = nb.body?.geography?.surface;
    if (nb.body && surf) {
      const local = nb.body.group.worldToLocal(_probeLocal.copy(hit.point));
      const r = local.length();
      const dir: [number, number, number] = [local.x / r, local.y / r, local.z / r];
      const hDatum = Math.max(0, surf.heightAt(dir)); // sea-clamped like the render
      const hRendered = r - nb.body.radius;
      report.rendered_m = hRendered.toFixed(1);
      report.datum_m = hDatum.toFixed(1);
      report.delta_m = (hRendered - hDatum).toFixed(1);
    }
    console.log("[aim probe]", report);
  }
  setStatus("aim probe → console (point at each side of the seam and press G on both)");
}

/** RING PROBE: rendered terrain vs the town datum at points around the walker
 *  (+ = drawn ground above the datum = town sunk; − = town floats). */
function probeDatum(): void {
  if (!embedTown || !liveViz || !liveAnchor || !liveGround) {
    console.log("[probe] no live town mounted — aim probe only");
    return;
  }
  const pose = embedTown.playerPose();
  if (!pose) return;
  const rows: Array<{ dx: number; dz: number; datum: number; rendered: number; delta: number }> = [];
  // TERRAIN CHUNKS ONLY — the body group also holds cloud puffs, atmosphere
  // shells and static town plans; the first ring-probe run measured a cloud
  // deck (+140…200 m) and called it ground.
  const terrainMeshes = probeMeshes(liveViz.fc.body.group, liveViz.mesh)
    .filter(m => m.name.startsWith("chunk_"));
  liveAnchor.updateWorldMatrix(true, false);
  for (const [dx, dz] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40], [120, 0], [-120, 0], [0, 120], [0, -120]] as const) {
    const sx = pose.x + dx;
    const sz = pose.y + dz;
    const datumY = liveGround(sx, sz);
    _probeUp.set(0, 1, 0).transformDirection(liveAnchor.matrixWorld);
    _probeOrigin.set(sx, datumY + 500, sz);
    liveAnchor.localToWorld(_probeOrigin);
    _probeDir.copy(_probeUp).negate();
    _probeRay.set(_probeOrigin, _probeDir);
    _probeRay.far = 5000;
    const hits = _probeRay.intersectObjects(terrainMeshes, false);
    if (!hits.length) {
      rows.push({ dx, dz, datum: datumY, rendered: NaN, delta: NaN });
      continue;
    }
    const renderedY = datumY + 500 - hits[0]!.distance;
    rows.push({ dx, dz, datum: datumY, rendered: renderedY, delta: renderedY - datumY });
  }
  console.table(rows.map(r => ({
    at: `${r.dx},${r.dz}`,
    datum_m: r.datum.toFixed(2),
    rendered_m: Number.isFinite(r.rendered) ? r.rendered.toFixed(2) : "NO HIT",
    delta_m: Number.isFinite(r.delta) ? r.delta.toFixed(2) : "—",
  })));
  const deltas = rows.map(r => r.delta).filter(Number.isFinite);
  const worst = deltas.length ? deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : NaN;
  setStatus(`datum probe: worst Δ ${Number.isFinite(worst) ? worst.toFixed(2) : "—"} m (+ = town sunk, − = floats) · console has the table`);
}
window.addEventListener("keydown", e => {
  if (e.key !== "g" && e.key !== "G") return;
  if (flightPointer.inside) probeAim();
  probeDatum();
});
const TOWN_LIVE_IN_M = 1_500;  // live town mounts (hysteresis pair with…)
const TOWN_LIVE_OUT_M = 2_600; // …live town unmounts, static plan returns
// VIEW-DISTANCE LOD (view-distance-lod-tiers.md Phase 2): the town's ambient
// street crowd budget ramps with camera→town distance — 0 beyond
// CROWD_ABSTRACT_M (no individual creatures at orbit; you neither see nor should
// HEAR them), climbing to full at/under CROWD_FULL_M. Ramping means the streamer
// embodies the crowd a few bodies per descending frame instead of all at once at
// the mount (the ~12 s freeze). CROWD_MAX mirrors the kernel's STREET_NPCS —
// overshooting is harmless (the stage clamps to its own budget), undershooting
// just shows fewer.
const CROWD_ABSTRACT_M = 1_000;
const CROWD_FULL_M = 140;
const CROWD_MAX = 40;
const CROWD_STEP = 8;    // budget granularity — coarse ⇒ few transitions
const CROWD_HYST_M = 60; // the camera must move THIS far before the budget is
                         // re-evaluated. A jittering distance otherwise re-spawns
                         // the marginal street body every frame (residents.ts:
                         // desired = budget + locked), and each spawn is a ~200ms
                         // creature-mesh build — the district/ground churn.
function crowdBudgetForDist(distM: number): number | null {
  if (distM >= CROWD_ABSTRACT_M) return 0;
  if (distM <= CROWD_FULL_M) return null; // stage default (full crowd)
  const t = (CROWD_ABSTRACT_M - distM) / (CROWD_ABSTRACT_M - CROWD_FULL_M);
  return Math.round((CROWD_MAX * t) / CROWD_STEP) * CROWD_STEP; // quantized
}
// Hysteretic wrapper: hold the applied budget until the camera has moved
// CROWD_HYST_M, so a STABLE view (orbit, district, hovering) never churns bodies.
// Reset on mount (mountLiveTown) so a fresh town re-evaluates immediately.
let appliedCrowd: number | null = 0;
let appliedCrowdAtM = Infinity;
function hystereticCrowdBudget(distM: number): number | null {
  if (Math.abs(distM - appliedCrowdAtM) >= CROWD_HYST_M) {
    appliedCrowdAtM = distM;
    appliedCrowd = crowdBudgetForDist(distM);
  }
  return appliedCrowd;
}
// CREATURE VIEW TIER (view-distance-lod-tiers.md Phase 3): the fidelity town
// bodies render at, by camera→town distance — full skinned bake near the
// ground, the cheap simple loft on approach, the placeholder capsule at far
// district range (beyond CROWD_ABSTRACT_M the budget is 0: no bodies at all).
// PER-CAMERA BY DESIGN: this is render chrome computed from the LOCAL camera —
// in multiplayer every peer picks its own tier over the same replicated
// bodies; it must never feed the sim. Boundary thrash is prevented twice over:
// a tier only flips after the distance crosses its boundary by TIER_HYST_M,
// and a flip rebuilds bodies a few per frame (quest-host's re-tier stream),
// never all at once.
const TIER_SIMPLE_M = 180;  // full ↔ simple boundary
const TIER_CAPSULE_M = 450; // simple ↔ capsule boundary
const TIER_HYST_M = 40;
let appliedTier: CreatureTier = "full";
// DEBOUNCE on the PUSHED values (dollhouse crawl-cycle fix, 2026-07-23): the
// `walking` flag the push derives from composes frame-order-sensitive state
// (`spiritTownDriven` is re-derived each frame and set true inside the
// structure rung's own step), so a transition hiccup can flap it for a frame
// — and a town-tier flap FLOODS a staggered whole-crowd rebuild EACH WAY
// (seconds of 4-rebuilds-a-frame crawl, drain, smooth, repeat). A changed
// tier/budget must HOLD for TIER_DEBOUNCE_MS (`now` is performance.now())
// before it lands; real transitions (descent, focus) hold far longer.
const TIER_DEBOUNCE_MS = 700;
let pushedTier: CreatureTier = "full";
let tierCandidate: CreatureTier = "full";
let tierCandidateAt = 0;
function debouncedTier(t: CreatureTier, now: number): CreatureTier {
  if (t !== tierCandidate) {
    tierCandidate = t;
    tierCandidateAt = now;
  }
  if (t !== pushedTier && now - tierCandidateAt >= TIER_DEBOUNCE_MS) pushedTier = t;
  return pushedTier;
}
let pushedBudget: number | null | undefined; // undefined = never pushed
let budgetCandidate: number | null = null;
let budgetCandidateAt = 0;
function debouncedBudget(b: number | null, now: number): number | null {
  if (b !== budgetCandidate) {
    budgetCandidate = b;
    budgetCandidateAt = now;
  }
  if (pushedBudget === undefined || (b !== pushedBudget && now - budgetCandidateAt >= TIER_DEBOUNCE_MS)) {
    pushedBudget = b;
  }
  return pushedBudget;
}
function hystereticCreatureTier(distM: number): CreatureTier {
  switch (appliedTier) {
    case "full":
      if (distM > TIER_SIMPLE_M + TIER_HYST_M)
        appliedTier = distM > TIER_CAPSULE_M + TIER_HYST_M ? "capsule" : "simple";
      break;
    case "simple":
      if (distM > TIER_CAPSULE_M + TIER_HYST_M) appliedTier = "capsule";
      else if (distM < TIER_SIMPLE_M - TIER_HYST_M) appliedTier = "full";
      break;
    case "capsule":
      if (distM < TIER_CAPSULE_M - TIER_HYST_M)
        appliedTier = distM < TIER_SIMPLE_M - TIER_HYST_M ? "full" : "simple";
      break;
  }
  return appliedTier;
}
// SINGLE GROUND HOST (PLANET_ENTITY_PLAN step 3, slice 1): true boots the
// wilderness side of the ground path as a QuestHost3D wilderness session
// (minded, talkable creatures) — the same host class as the town side; false
// keeps the legacy bare-sandbox boot (delete once the browser loop passes).
const UNIFIED_GROUND = true;
const TAKEOFF_NY = 0.85;      // gaze this far up the screen (0=centre,1=top) lifts off
const TOWN_RECLAIM_R = 900;   // touch down within this of the plaza to walk its town
const _lp = new THREE.Vector3(); // scratch: launch / land point (world)
const _lp2 = new THREE.Vector3(); // scratch: landing heading (local)
const _inv = new THREE.Matrix4(); // scratch: anchor world→local for directions
const _wildPartnerDir = new THREE.Vector3(); // scratch: wild chunk's radial for partner bearings
// AIRBORNE town cadence: from the air the town steps at 20 Hz (= the sim's dt
// clamp, so residents run at full speed) instead of every rAF — the flight and
// the town sharing one thread is the main frame cost. Grounded = every frame.
const AIRBORNE_TOWN_STEP_S = 0.05;
let townStepAcc = 0;
let wildStepAcc = 0;
// Frame-cost probe (ms) — surfaced in the status line + window.__perf.
const perf = { fly: 0, town: 0 };
(window as unknown as Record<string, unknown>).__perf = perf;

/** Mount the living town under its city anchor — called from the flight loop
 *  when the ship crosses TOWN_LIVE_IN_M. The player keeps flying; the town's
 *  own walker stays hidden until a real touchdown claims it. */
function mountLiveTown(viz: CityViz, play: TownPlay, cityName: string): void {
  if (!flight || embedTown) return;
  try {
    liveViz = viz;
    liveCenter.x = play.stage.center.x;
    liveCenter.y = play.stage.center.y;
    // REGISTRATION: town-sim coords put the frame ORIGIN at stage.center,
    // while the city anchor (and the static plan, which subtracts the centre)
    // IS that origin — so the live layer hangs off a child group shifted by
    // minus the centre.
    // Its local frame IS sim coords; viz.ground (anchor-local) shifts to match.
    liveAnchor = new THREE.Group();
    liveAnchor.position.set(-liveCenter.x, 0, -liveCenter.y);
    viz.mesh.add(liveAnchor);
    liveGround = (x, y) => viz.ground(x - liveCenter.x, y - liveCenter.y);
    embedTown = bootTownEmbedded(
      viewEl, renderer.domElement,
      // castGroundRay: ONE cursor rule everywhere on the planet — the town
      // host's gaze pick lands on the DRAWN world (streamed terrain chunks,
      // road ribbons, trees) exactly like the wilderness and the spirit
      // glide, instead of an analytic plane that drifts off the rendered
      // ground away from the town centre.
      { scene, camera, anchor: liveAnchor, castGroundRay: castDrawnGround },
      play,
      t => { baseStatus = t; setStatus(t); },
      labBoard,
      liveGround,
      undefined,
      // A SPIRIT run mounts the town as a spirit session (dwell-at-range
      // talk/containers/carry; stationary formless local avatar the ladder
      // parks) — the same semantics as a standalone spirit world. The
      // walker scope keeps the plain walking session.
      {
        spirit: spirit !== null,
        ...(docSessionScale() ? { scale: docSessionScale() } : {}),
        // The planet's OTHER cities as boot-known trade partners (P0):
        // the trade board offers more than the one bound caravan line.
        tradePartners: () =>
          nearbyCityPartners(
            viz.fc.body,
            new THREE.Vector3(viz.fc.city.dir[0], viz.fc.city.dir[1], viz.fc.city.dir[2]).normalize(),
            viz.mesh.quaternion,
            play.stage.center,
            viz.fc.city.cell,
          ),
      },
    );
    // Mounted DURING FLIGHT: the town renders and LIVES, but flight still owns
    // the avatar and the camera — the town walker hides until touchdown.
    embedTown.host.setDriveCamera(false);
    embedTown.host.setLocalAvatarHidden(true);
    // SEAL INTERIORS AT MOUNT (view-distance-lod-tiers.md, Phase 1). A fresh
    // host's renderer defaults interiorReveal=true, and the mount's first
    // host-steps run inside streamGround BEFORE the ladder's per-frame clamp
    // (setInteriorReveal below) lands. At orbit the frameless spirit reveal
    // opens EVERY accessible room, which runs the resident economy for the
    // whole in-window town and PROMOTES its households to live bodies — ~180
    // skinned meshes + furniture built synchronously, then discarded a few
    // frames later when the clamp re-seals. Start sealed; the per-frame clamp
    // re-opens it at the structure rung / when riding.
    embedTown.host.setInteriorReveal(false);
    appliedCrowdAtM = Infinity; // a fresh town re-evaluates its crowd budget
    appliedTier = "full"; // …and its creature tier (the first push re-tiers)
    pushedTier = "full"; // fresh debounce state — a stale hold must not gate the new town
    tierCandidate = "full";
    pushedBudget = undefined;
    budgetCandidate = null;
    // A proximity mount must not steal the board from the wilderness session
    // the walker is standing in (last-wins claim — hand it straight back).
    if (groundedIn === "wild") embedWild?.claimBoard?.();
    // Static plan → live handoff is BUILDING BY BUILDING, driven by the
    // streamer's own loaded set: only lots with a materialized live twin
    // hide; the rest of the plan keeps standing.
    liveStage = play.stage;
    syncLiveHandoff();
    setStatus(`${cityName} is live — touch down to walk its streets`);
  } catch (err) {
    disposeEmbeddedTown();
    setStatus((err as Error).message, true);
  }
}

function disposeEmbeddedTown(): void {
  // SAFETY NET: the edge handoff (maybeHandoffGround) moves the walker to the
  // planet's ground layer long before the town's unmount radius, so the town
  // should never own the walker here — but if it somehow still does, carry the
  // walker out rather than vaporising it with the town. The city must never be
  // the thing a body's existence hangs on.
  if (embedTown) traceWalk(`disposeEmbeddedTown (groundedIn=${groundedIn})`);
  if (groundedIn === "town") handWalkerToWild();
  liveViz?.view.setLiveLots(null); // full static plan back
  liveStage = null;
  embedTown?.dispose();
  embedTown = null;
  if (liveAnchor) { liveAnchor.parent?.remove(liveAnchor); liveAnchor = null; }
  liveGround = null;
  liveViz = null;
  // Only release the walker if the TOWN owned it (a wilderness walk elsewhere
  // must survive a distant town unmounting by distance).
  if (groundedIn === "town" || groundedIn === null) {
    grounded = false;
    groundedIn = null;
    flight?.setAvatarVisible(true);
    spaceHud?.setVisible(true);
  }
}

/** WALK→FLY: launch flight-sim from the town walker's ground pose. ONLY the
 *  physics/camera owner changes — the town stays mounted and living (it
 *  unmounts by DISTANCE, like everything else). The quest host renders avatars
 *  at RAW town-sim coords in the anchor's local frame, so the sim↔local map is
 *  identity (NOT centred) — the launch point coincides exactly with where the
 *  walker was drawn. */
function maybeTakeoff(): void {
  if (!flight || !grounded) return;
  const ctx = groundCtx();
  if (!ctx) return;
  if (!flightPointer.inside) return;
  const h = viewEl.clientHeight || 1;
  const ny = 1 - (flightPointer.y / h) * 2; // +1 at the very top of the screen
  if (ny < TAKEOFF_NY) return;
  const pose = ctx.pose();
  if (!pose) return;
  const gy = ctx.ground(pose.x, pose.y);
  const pos = ctx.anchor.localToWorld(_lp.set(pose.x, gy, pose.y)).clone();
  const fwd = ctx.anchor
    .localToWorld(new THREE.Vector3(pose.x + pose.fx, gy, pose.y + pose.fy))
    .sub(pos);
  // Guard a degenerate/zero facing (avatar never moved) — fall back to the
  // anchor's local +Z so beginFlight always gets a finite tangent to project.
  if (!Number.isFinite(fwd.x) || fwd.lengthSq() < 1e-8) {
    fwd.set(0, 0, 1).transformDirection(ctx.anchor.matrixWorld);
  }
  fwd.normalize();
  flight.player.beginFlight(pos, fwd, 45);
  grounded = false;
  groundedIn = null;
  flight.setAvatarVisible(true);
  spaceHud?.setVisible(true);
  ctx.host.setDriveCamera(false);
  ctx.host.setLocalAvatarHidden(true);
  ctx.host.clearPointer(); // the walker must not chase the flight mouse
}

/** FLY→LAND: flight-sim touched down (its own tuned landing). A live town
 *  claims the walker when the touchdown is inside it; ANY other dry-land
 *  touchdown mounts a WILDERNESS chunk — ground is ground. Only the
 *  physics/camera owner changes; whatever ground detail exists was already
 *  mounted and visible on the way down. */
function maybeLand(): void {
  if (!flight || grounded) return;
  if (flight.player.state.mode !== "walking") return;
  // 1) The live town's claim (its anchor's local frame IS town-sim coords).
  if (embedTown && liveAnchor) {
    const local = liveAnchor.worldToLocal(_lp.copy(flight.player.state.position));
    if (Math.hypot(local.x - liveCenter.x, local.z - liveCenter.y) <= TOWN_RECLAIM_R) {
      // Face the walker (and the freshly-seeded chase camera) along the
      // landing heading — the view keeps looking the way the flight moved.
      const dir = _lp2.copy(flight.player.state.forward)
        .transformDirection(_inv.copy(liveAnchor.matrixWorld).invert());
      embedTown.placePlayer(local.x, local.z, dir.x, dir.z);
      grounded = true;
      groundedIn = "town";
      flight.setAvatarVisible(false);
      spaceHud?.setVisible(false);
      embedTown.host.setDriveCamera(true);
      embedTown.host.setLocalAvatarHidden(false);
      embedTown.claimBoard(); // the walker's session routes the shared board
      setStatus("walking — aim at the top of the screen to take off");
      return;
    }
  }
  // 2) An existing wilderness chunk claims a touchdown inside its bounds
  //    (took off, circled, came back down); landing elsewhere retires it.
  if (embedWild && wildAnchor) {
    const local = wildAnchor.worldToLocal(_lp.copy(flight.player.state.position));
    if (local.x > 4 && local.x < WILD_SIDE - 4 && local.z > 4 && local.z < WILD_SIDE - 4) {
      const dir = _lp2.copy(flight.player.state.forward)
        .transformDirection(_inv.copy(wildAnchor.matrixWorld).invert());
      embedWild.placePlayer(local.x, local.z, dir.x, dir.z);
      grounded = true;
      groundedIn = "wild";
      flight.setAvatarVisible(false);
      spaceHud?.setVisible(false);
      embedWild.host.setDriveCamera(true);
      embedWild.host.setLocalAvatarHidden(false);
      embedWild.claimBoard?.(); // a town mounted meanwhile may hold the claim
      setStatus("wilderness — walk with the mouse · aim at the top of the screen to take off");
      return;
    }
    disposeWilderness();
  }
  // 3) Open country: mount the wilderness at the touchdown point (declines
  //    over water / unbaked bodies — flight's own swim/walk carries on).
  mountWildernessAt(flight.player.state.position, flight.player.state.forward);
}

// ── TOWN ↔ OPEN-GROUND WALKER HANDOFF (the city is CONTENT, not a frame) ────
// While grounded, ONE ground layer owns the walker at a time, chosen by where
// the walker STANDS: inside a live town's streets the town host owns it (its
// buildings, furniture and residents need the body in the town sim);
// everywhere else the planet's wilderness layer does. Crossing the edge is a
// pose-preserving transfer through WORLD space — never a despawn, never a
// wall — and it is decoupled from when the town itself mounts/unmounts
// (that's a render/sim-LOD choice, keyed on distance like every other load).
const TOWN_WALK_OUT_R = TOWN_RECLAIM_R + 80; // hysteresis pair with TOWN_RECLAIM_R
const _ho1 = new THREE.Vector3();
const _ho2 = new THREE.Vector3();

/** Can a wilderness chunk anchor at this WORLD point? (dry land on a baked,
 *  walkable body — the same tests mountWildernessAt applies.) */
function walkableGroundAt(pos: THREE.Vector3): boolean {
  if (!flight) return false;
  const body = flight.world.nearestBodyAltitudeAt(pos).body;
  const geo = body?.geography;
  if (!body || !body.walkable || !geo) return false;
  const local = body.group.worldToLocal(_ho1.copy(pos));
  const r = local.length();
  if (r < 1e-3) return false;
  return geo.surface.heightAt([local.x / r, local.y / r, local.z / r]) >= 0;
}

/** Carry the town-owned walker onto the planet's ground layer at its exact
 *  world pose (a walk out of town, or a safety before the town unmounts).
 *  True = the wilderness owns the walker now. */
function handWalkerToWild(): boolean {
  if (!embedTown || !liveAnchor || !liveGround) return false;
  const et = embedTown;
  const pose = et.playerPose();
  if (!pose) return false;
  liveAnchor.updateWorldMatrix(true, false);
  // NB: walkableGroundAt scratches _ho1 — keep the handoff pose in _lp/_ho2.
  const pos = _lp.set(pose.x, liveGround(pose.x, pose.y), pose.y);
  liveAnchor.localToWorld(pos);
  const fwd = _ho2.set(pose.fx, 0, pose.fy).transformDirection(liveAnchor.matrixWorld);
  if (!walkableGroundAt(pos)) {
    traceWalk("handoff town→wild REFUSED (unwalkable ground — water/unbaked)");
    return false; // over water — the streets keep the body
  }
  if (embedWild) disposeWilderness(); // a stale chunk left elsewhere; fresh ground mounts HERE
  et.host.setDriveCamera(false);
  et.host.setLocalAvatarHidden(true);
  et.host.clearPointer();
  groundedIn = null;
  mountWildernessAt(pos, fwd);
  if (groundedIn === "wild") {
    // The POCKET travels with the walker (glyph→count stacks are portable —
    // no town-scoped ids). Followers/party stay behind for now:
    // TODO(step4-entity-store): carry companions once entities are planet-owned.
    if (embedWild?.quest) {
      embedWild.quest.restorePocket(et.host.pocketSnapshot());
      et.host.restorePocket({});
    }
    traceWalk("handoff town→wild OK");
    return true;
  }
  // The mount declined after the pre-check (rare) — the town keeps the walker.
  traceWalk("handoff town→wild MOUNT DECLINED — town keeps the walker");
  groundedIn = "town";
  et.host.setDriveCamera(true);
  et.host.setLocalAvatarHidden(false);
  return false;
}

function maybeHandoffGround(): void {
  if (!flight || !grounded) return;
  if (groundedIn === "town" && embedTown && liveGround) {
    const pose = embedTown.playerPose();
    if (!pose) return;
    if (Math.hypot(pose.x - liveCenter.x, pose.y - liveCenter.y) <= TOWN_WALK_OUT_R) return;
    handWalkerToWild();
  } else if (groundedIn === "wild" && embedWild && wildAnchor && wildGround && embedTown && liveAnchor) {
    const pose = embedWild.playerPose();
    if (!pose) return;
    wildAnchor.updateWorldMatrix(true, false);
    const pos = wildAnchor.localToWorld(_ho1.set(pose.x, wildGround(pose.x, pose.y), pose.y));
    liveAnchor.updateWorldMatrix(true, false);
    const local = _ho2.copy(pos).applyMatrix4(_inv.copy(liveAnchor.matrixWorld).invert());
    if (Math.hypot(local.x - liveCenter.x, local.z - liveCenter.y) >= TOWN_RECLAIM_R) return;
    // Walked into the live town: its sim takes the body at the same world pose.
    const dir = _lp2.set(pose.fx, 0, pose.fy)
      .transformDirection(wildAnchor.matrixWorld)
      .transformDirection(_inv); // _inv still holds world → town-local
    embedWild.host.setDriveCamera(false);
    embedWild.host.setLocalAvatarHidden(true);
    embedWild.host.clearPointer();
    embedTown.placePlayer(local.x, local.z, dir.x, dir.z);
    groundedIn = "town";
    embedTown.host.setDriveCamera(true);
    embedTown.host.setLocalAvatarHidden(false);
    // The POCKET travels with the walker; the board follows its session.
    if (embedWild.quest) {
      embedTown.host.restorePocket(embedWild.quest.pocketSnapshot());
      embedWild.quest.restorePocket({});
    }
    embedTown.claimBoard();
    traceWalk("handoff wild→town OK");
    setStatus("walking — aim at the top of the screen to take off");
  }
}

// ── FLORA TWINS (one tree authority) ────────────────────────────────────────
// The streamed flora field DRAWS the planet's trees; the wilderness session
// makes the near ones REAL: every streamed tree within WILD_TWIN_R of the
// player (walker or glide) materializes as an ordinary wilderness feature at
// its exact spot — hover/jump-on/products/felling through the same engine
// code a flat region runs — and its scenery instance hides (setTwinHidden).
// Walk away and an untouched twin releases back to scenery; a part-harvested
// one stays standing (its state must not evaporate); a FELLED one keeps its
// instance hidden for the rest of the mount, so the tree you cut down does
// not respawn behind you as scenery.
const WILD_TWIN_R = 80;
/** instance key (`face:tx:ty:i`) → live feature id. */
const wildTwins = new Map<string, string>();
/** Instances whose feature was consumed (felled) — hidden for the mount. */
const wildTwinFelled = new Set<string>();
function twinRng(instKey: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < instKey.length; i++) {
    h ^= instKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0; // mulberry32 — the scatter convention
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clearFloraTwins(): void {
  if (!wildTwins.size && !wildTwinFelled.size) return;
  wildTwins.clear();
  wildTwinFelled.clear();
  flora?.setTwinHidden(new Set());
}
function syncFloraTwins(playerWorld: THREE.Vector3): void {
  const q = embedWild?.quest;
  if (!q || !wildAnchor || !flora || !wildPoint || floraBodyId !== wildPoint.body.id) {
    clearFloraTwins(); // no session (or another body's field) — all scenery
    return;
  }
  const sess = q.session;
  const w = sess.wilderness;
  if (!w) return;
  const near = floraTreesNear(wildPoint.body, playerWorld, WILD_TWIN_R);
  const nearKeys = new Set(near.map(t => t.key));
  wildAnchor.updateWorldMatrix(true, false);
  // STAND UP trees entering the radius (world → chunk-sim coords; stock
  // rolled off the instance key, so a re-entry re-rolls the same tree).
  for (const t of near) {
    if (wildTwins.has(t.key) || wildTwinFelled.has(t.key)) continue;
    const local = wildAnchor.worldToLocal(t.world);
    const id = `wild:${FLORA_TREE_SPECIES}_${t.key}`;
    const f = makeFeature(id, FLORA_TREE_SPECIES, { x: local.x, y: local.z }, twinRng(t.key));
    if (q.addWildFeature(f)) wildTwins.set(t.key, id);
  }
  // RELEASE / FELL bookkeeping for standing twins.
  for (const [instKey, id] of wildTwins) {
    const f = w.features.find(g => g.id === id);
    if (!f) {
      // Gone from the session = consumed (fellIfConsumed) — scenery stays
      // hidden where the stump would be.
      wildTwins.delete(instKey);
      wildTwinFelled.add(instKey);
      continue;
    }
    if (nearKeys.has(instKey)) continue;
    // Out of range: release back to scenery — unless MUTATED (part-taken
    // stock or an armed regrow clock); that state stays standing.
    const live = sess.containerStock.get(wildFeatureContainerId(f));
    const untouched =
      !f.regrowAt && !!live &&
      Object.keys({ ...live, ...f.stock }).every(k => (live[k] ?? 0) === (f.stock[k] ?? 0));
    if (untouched && q.removeWildFeature(id)) wildTwins.delete(instKey);
  }
  flora.setTwinHidden(new Set([...wildTwins.keys(), ...wildTwinFelled]));
}

/** Drive the world-fixed flora streamer: tiles load around the ground point
 *  under the player whenever we're low over a baked walkable body — airborne
 *  (forests visible on approach) or grounded (impostors resolve near the
 *  walker). ~4 Hz; tile builds are budgeted inside ensure(). */
function driveFlora(dt: number, playerWorld: THREE.Vector3): void {
  if (!flight) return;
  floraAcc += dt;
  if (floraAcc < 0.25) return;
  floraAcc = 0;
  const nb = flight.world.nearestBodyAltitudeAt(playerWorld);
  const body = nb.body;
  if (!body || !body.walkable || !body.geography || nb.altitude > FLORA_ALT_M) return;
  if (floraBodyId !== body.id) {
    flora?.dispose();
    clearFloraTwins(); // twin keys are per-field; a fresh field starts clean
    flora = createFloraField(renderer, body);
    floraBodyId = body.id;
  }
  if (!flora) return;
  const focus = body.surfaceAt ? body.surfaceAt(playerWorld, _floraFocus) : playerWorld;
  flora.ensure(
    focus,
    playerWorld,
    liveViz ? { world: liveViz.mesh.getWorldPosition(_wildPos), r: 600 } : undefined,
  );
  // The near trees BECOME entities (and their scenery hides) — the same
  // ground point drives both, so the swap tracks the player exactly.
  syncFloraTwins(playerWorld);
}

// ── INTERCITY ROADS + CARAVANS (planet/routes.ts + trade-roads.ts) ─────────
// Once a settled body's geology bakes, its capitals join into a deterministic
// road net; the caravans on it are drawn from the WORLD CLOCK (closed form —
// every client sharing seed and clock sees the same cart at the same bend,
// nothing on a wire). One net per body, disposed with the flight world.
const roadNets = new Map<string, TradeRoads | null>();
let roadAcc = 0;

// Rivers, drawn as draped ribbons beside the roads (river-ribbons.ts). One net
// per body, created on the same demand and disposed with the flight world.
const riverNets = new Map<string, RiverRibbons | null>();

// ── CONURBATIONS (planet/growth.ts) ─────────────────────────────────────────
// Settlements age on the world clock; when two grown footprints touch they
// are ONE conurbation — surfaced wherever a city names itself (HUD target
// list, approach lines). Recomputed only when a growth quantum passes or the
// beacon set changes, never per frame.
const conurbationLabels = new Map<number, string>(); // city.cell → shared name
let conurbationStamp = "";
function refreshConurbations(): void {
  if (!flight) return;
  const all = flight.cities();
  const stamp = `${worldGrowthDays(Date.now())}:${all.length}`;
  if (stamp === conurbationStamp) return;
  conurbationStamp = stamp;
  conurbationLabels.clear();
  const byBody = new Map<string, FlightCity[]>();
  for (const fc of all) {
    let list = byBody.get(fc.body.id);
    if (!list) { list = []; byBody.set(fc.body.id, list); }
    list.push(fc);
  }
  const probe: Record<string, string[]> = {};
  for (const [bodyId, list] of byBody) {
    const cities = list.map(fc => fc.city);
    for (const [i, j] of conurbations(cities, list[0]!.body.radius, Date.now())) {
      const name = conurbationName(cities[i]!, cities[j]!);
      conurbationLabels.set(cities[i]!.cell, name);
      conurbationLabels.set(cities[j]!.cell, name);
      (probe[bodyId] ??= []).push(name);
    }
  }
  (window as unknown as Record<string, unknown>).__conurbations = probe;
}
/** The city's display name — its own, or the conurbation it has grown
 *  into, ANNOUNCED UNDER ITS CROWN (nations P5): the allegiance reads
 *  live off the polity ledger, so a scrubbed history renames the whole
 *  map's loyalties and the border town you fly into is introduced as the
 *  empire's. A city-state's own crown adds nothing ("Alster — Alster"). */
const cityLabel = (fc: FlightCity): string => {
  const con = conurbationLabels.get(fc.city.cell);
  const base = con ? `${fc.city.name} (${con})` : fc.city.name;
  if (!nationsOn) return base; // crowns are hidden until the layer is lit
  const crown = roadNets.get(fc.body.id)?.polityAt(fc.city.dir);
  return crown && crown.name !== fc.city.name ? `${base} — ${crown.name}` : base;
};

/** The body's road net, created on first demand (synchronous — the tier-0
 *  Dijkstras are paid once per approached body). Regions and mounted town
 *  splices that arrived before the net sweep in at creation. Null = fewer
 *  than two cities (or a failed build, parked so the loop survives). */
function ensureRoadNet(b: CelestialBody): TradeRoads | null {
  const have = roadNets.get(b.id);
  if (have !== undefined) return have;
  if (!b.walkable || !b.geography) return null;
  try {
    const net = createTradeRoads(b);
    roadNets.set(b.id, net);
    if (net) {
      // A body approached while the layer is lit joins it already showing.
      net.nations(nationsOn);
      // Regions that refined before the net existed sweep their roads
      // in now (refine and net creation race on approach).
      for (const [key, entry] of regions) {
        if (entry.state === "ready" && key.startsWith(`${b.id}:`)
          && (entry.roads.length || entry.highways.length)) {
          net.addRegion(key, { roads: entry.roads, highways: entry.highways });
        }
      }
      // Town street plans mounted before the net existed splice in too.
      for (const viz of cityViz.values()) {
        if (viz.fc.body.id !== b.id) continue;
        const spec = townSpliceSpecOf(viz.fc);
        if (spec) net.setTownSplice(viz.fc.city.cell, spec);
      }
    }
    return net;
  } catch (err) {
    // A broken net must not kill the render loop — park it and say why.
    console.warn(`trade-roads ${b.id} failed:`, err);
    roadNets.set(b.id, null);
    return null;
  }
}

/** The body's river net, created on first demand. Unlike roads it needs no
 *  cities — only settled geography — so a wild ocean world still shows its
 *  rivers. Parked (null) on failure so the loop survives. */
function ensureRiverNet(b: CelestialBody): RiverRibbons | null {
  const have = riverNets.get(b.id);
  if (have !== undefined) return have;
  if (!b.geography) return null;
  try {
    const net = createRiverRibbons(b);
    riverNets.set(b.id, net);
    net?.nations(nationsOn); // born into the current layer state, like roads
    return net;
  } catch (err) {
    console.warn(`rivers ${b.id} failed:`, err);
    riverNets.set(b.id, null);
    return null;
  }
}

function driveRoadNets(dt: number, playerWorld: THREE.Vector3): void {
  if (!flight) return;
  roadAcc += dt;
  if (roadAcc < 0.25) return;
  roadAcc = 0;
  refreshConurbations();
  for (const b of flight.world.bodies) {
    if (b.walkable && b.geography && !roadNets.has(b.id)) ensureRoadNet(b);
    if (b.geography && !riverNets.has(b.id)) ensureRiverNet(b);
  }
  for (const net of riverNets.values()) net?.update(playerWorld);
  const tSec = (Date.now() - WORLD_EPOCH_MS) / 1000;
  for (const net of roadNets.values()) net?.update(tSec, playerWorld);
  retintBeacons();
  updateHistoryScrubber();
  // Console probe: per-body road-net state (null = fewer than two cities).
  (window as unknown as Record<string, unknown>).__roads =
    [...roadNets.entries()].map(([id, net]) => ({ id, ...(net ? net.stats() : { routes: 0 }) }));
}

// ── POLITY FLAGS (nations P1): every settlement beacon wears its crown's
// ink — villages and border towns resolve through the tier-0 cell under
// them (the states.ts law), so a merge retints the loser's WHOLE map,
// border towns included, on the next road sweep. ──────────────────────────
const beaconTintSig = new Map<string, string>();
function retintBeacons(): void {
  if (!flight) return;
  const cs = flight.cities();
  for (const [bodyId, net] of roadNets) {
    if (!net) continue;
    const bodyCities = cs.filter(c => c.body.id === bodyId);
    const sig = `${net.polities.version}:${bodyCities.length}:${nationsOn}`;
    if (beaconTintSig.get(bodyId) === sig) continue;
    beaconTintSig.set(bodyId, sig);
    for (const c of bodyCities) {
      // Layer off = beacons go back to their plain ink (null), so the planet
      // reads as geography until someone asks who holds it.
      flight.setCityColor(c.city.cell, nationsOn ? net.polityAt(c.city.dir)?.color ?? null : null);
    }
  }
}

/** The lab's scripted-relabel surface (P1 gate): `__polities.list()` names
 *  the living crowns per body; `merge(winner, loser)` / `cede(state, to)`
 *  relabel on the FIRST body with a net unless a bodyId narrows it. The
 *  border ink and every beacon repaint on the next sweep — no reboot. */
function mountPolityHook(): void {
  const pick = (bodyId?: string): TradeRoads | null =>
    (bodyId ? roadNets.get(bodyId) : [...roadNets.values()].find(n => n)) ?? null;
  (window as unknown as Record<string, unknown>).__polities = {
    list: (bodyId?: string) => {
      const net = pick(bodyId);
      if (!net) return null;
      return {
        living: net.polities.living().map(r => ({
          id: r.id, name: r.name, color: r.color, states: net.polities.statesOf(r.id),
        })),
        unions: net.polities.unions(),
      };
    },
    merge: (winner: number, loser: number, bodyId?: string) =>
      pick(bodyId)?.polities.merge(winner, loser) ?? false,
    cede: (state: number, to: number, bodyId?: string) =>
      pick(bodyId)?.polities.cede(state, to) ?? false,
  };
}
mountPolityHook();

// ── DEEP HISTORY (nations P5): the planet's political past, scrubbable ──────
// The ledger boots at FOUNDING (year 0 — byte-identical to P1 until the
// first scrub); dragging the slider relabels it to any year of the
// simulated centuries. Cede-only relabels, so the border ink and every
// beacon flag repaint on the next road sweep, and wherever the thumb ends
// IS the planet's present — fly down and the border town you walk into
// wears the crown the scrubber ended on (the P5 gate).
function mountHistoryHook(): void {
  const pick = (bodyId?: string): TradeRoads | null =>
    (bodyId ? roadNets.get(bodyId) : [...roadNets.values()].find(n => n)) ?? null;
  (window as unknown as Record<string, unknown>).__history = {
    span: (bodyId?: string) => pick(bodyId)?.history().years ?? 0,
    events: (bodyId?: string) => pick(bodyId)?.history().events ?? [],
    living: (year: number, bodyId?: string) => {
      const net = pick(bodyId);
      if (!net) return null;
      const owner = net.history().ownerAt(year);
      const held = new Map<number, number>();
      for (const p of owner) held.set(p, (held.get(p) ?? 0) + 1);
      return [...held.entries()].sort((a, b) => a[0] - b[0]).map(([id, states]) => {
        const r = net.polities.get(id);
        return { id, name: r?.name ?? `#${id}`, color: r?.color ?? "#888888", states };
      });
    },
    scrub: (year: number, bodyId?: string) => {
      const net = pick(bodyId);
      return net ? net.history().applyTo(net.polities, year) : 0;
    },
  };
  // The territory wash's taste knobs (nations P6b): `__fill.opacity(0.4)`
  // to strengthen it, `__fill.on()` / `__fill.off()` to pin it regardless
  // of altitude, `__fill.auto()` to hand it back to the altitude gate.
  // NOTE: all of these sit UNDER the 👑 Nations master switch — with the
  // layer dark, `__fill.on()` arms the wash but shows nothing.
  (window as unknown as Record<string, unknown>).__fill = {
    opacity: (v: number, bodyId?: string) => pick(bodyId)?.fill({ opacity: v }),
    on: (bodyId?: string) => pick(bodyId)?.fill({ force: true }),
    off: (bodyId?: string) => pick(bodyId)?.fill({ force: false }),
    auto: (bodyId?: string) => pick(bodyId)?.fill({ force: null }),
  };
}
mountHistoryHook();

// The scrubber overlay — a lab draft (interaction surfaces are drafts; the
// student-facing surface is P6). One range input over the first road net's
// political record; the centuries simulate lazily on the first touch, so a
// player who never scrubs never pays for them.
const historyEl = document.createElement("div");
historyEl.style.cssText =
  "position:absolute;left:50%;bottom:14px;transform:translateX(-50%);" +
  "width:min(440px,70%);padding:6px 12px;border-radius:10px;" +
  "background:rgba(10,14,24,.72);color:#cfd8ea;" +
  "font:12px system-ui,sans-serif;z-index:30;display:none;";
const historyLabel = document.createElement("div");
historyLabel.style.cssText = "text-align:center;margin-bottom:2px;";
const historySlider = document.createElement("input");
historySlider.type = "range";
historySlider.min = "0";
historySlider.value = "0";
historySlider.style.cssText = "width:100%;";
historyEl.append(historyLabel, historySlider);
viewEl.appendChild(historyEl);
let historyNet: TradeRoads | null = null;
function updateHistoryScrubber(): void {
  if (historyNet) return;
  const net = [...roadNets.values()].find(n => n) ?? null;
  if (!net) return;
  historyNet = net;
  historyEl.style.display = nationsOn ? "block" : "none";
  historyLabel.textContent = "political history — drag to run the centuries";
  let armed = false;
  const arm = (): void => {
    if (armed) return;
    armed = true;
    historySlider.max = String(net.history().years);
  };
  historySlider.addEventListener("pointerdown", arm);
  historySlider.addEventListener("input", () => {
    arm();
    const year = parseInt(historySlider.value, 10);
    net.history().applyTo(net.polities, year);
    const crowns = net.history().livingAt(year).length;
    historyLabel.textContent = year === 0
      ? `founding — ${crowns} city-states`
      : `year ${year} — ${crowns} crowns`;
  });
}

// ── 👑 NATIONS — the political layer is OPT-IN. A planet comes up as
//    geography: no border ink, no territory wash, no crown flags on the
//    beacons and no history scrubber. The header button lights all of it at
//    once, so "who holds this" is a question the viewer asks rather than a
//    thing the map asserts. The choice is the LAB's and survives a world
//    reload — every net created afterwards is born in the current state.
let nationsOn = false;
function applyNations(): void {
  nationsBtn.setAttribute("aria-pressed", String(nationsOn));
  for (const net of roadNets.values()) net?.nations(nationsOn);
  for (const net of riverNets.values()) net?.nations(nationsOn); // sky-ribbon river debug overlay
  if (historyNet) historyEl.style.display = nationsOn ? "block" : "none";
  retintBeacons(); // the signature carries nationsOn, so this repaints
}
nationsBtn.addEventListener("click", () => {
  nationsOn = !nationsOn;
  applyNations();
});

/** Anchor-local terrain samplers for any surface point (a city or a
 *  wilderness landing): walks the tangent frame back onto the sphere and
 *  reads the planet surface (curvature-corrected — centimetres over a town,
 *  but free to include). `water` = the RAW surface below the waterline at
 *  the walked direction (ground clamps it to bank level, matching the
 *  sea-clamped render). */
function makeSurfaceSamplers(
  body: FlightCity["body"],
  dir: readonly [number, number, number],
  mesh: THREE.Group,
): { ground: (x: number, z: number) => number; water: (x: number, z: number) => boolean } {
  const surface = body.geography!.surface;
  const R = body.radius;
  const dir0 = new THREE.Vector3(dir[0], dir[1], dir[2]);
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
  const north = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
  const h0 = Math.max(0, surface.heightAt(dir as [number, number, number]));
  const _g = new THREE.Vector3();
  const dirAt = (x: number, z: number): [number, number, number] => {
    _g.copy(dir0).multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, z).normalize();
    return [_g.x, _g.y, _g.z];
  };
  return {
    ground: (x, z) => {
      const h = Math.max(0, surface.heightAt(dirAt(x, z)));
      return (h - h0) - (x * x + z * z) / (2 * R);
    },
    water: (x, z) => surface.heightAt(dirAt(x, z)) < 0,
  };
}

/** The town-local terrain sampler for a city (the anchored samplers above at
 *  the city's own direction). */
function makeTownGround(fc: FlightCity, mesh: THREE.Group): (x: number, z: number) => number {
  return makeSurfaceSamplers(fc.body, fc.city.dir, mesh).ground;
}

/** The K nearest same-body cities as BOOT-SUPPLIED trade partners (nations
 *  P0 — quest-host `deps.tradePartners`): each in the anchored layer's own
 *  sim coordinates via the identical tangent-frame projection the caravan
 *  bind below uses. A town excludes itself by cell; a wilderness chunk
 *  excludes nobody. Stub partners — the host prices them off the
 *  closed-form scarcity proxy until the civ tier makes them real. */
function nearbyCityPartners(
  body: CelestialBody,
  selfDir: THREE.Vector3,
  quat: THREE.Quaternion,
  simCenter: { x: number; y: number },
  excludeCell: number | null,
  maxN = 3,
): Array<{ key: string; at: { x: number; y: number }; geo: PartnerGeography }> {
  if (!flight) return [];
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const north = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const other = new THREE.Vector3();
  const rows: Array<{
    key: string; ang: number; at: { x: number; y: number }; geo: PartnerGeography;
  }> = [];
  for (const c of flight.cities()) {
    if (c.body !== body || c.city.cell === excludeCell) continue;
    other.set(c.city.dir[0], c.city.dir[1], c.city.dir[2]);
    const ang = selfDir.angleTo(other);
    if (ang < 1e-9) continue;
    const toward = other.addScaledVector(selfDir, -other.dot(selfDir));
    if (toward.lengthSq() < 1e-12) continue;
    toward.normalize();
    const distM = ang * body.radius;
    rows.push({
      key: `city:${c.city.cell}`,
      ang,
      at: {
        x: simCenter.x + toward.dot(east) * distM,
        y: simCenter.y + toward.dot(north) * distM,
      },
      geo: cityPartnerGeography(c),
    });
  }
  rows.sort((a, b) => a.ang - b.ang);
  return rows.slice(0, maxN).map(({ key, at, geo }) => ({ key, at, geo }));
}

/** ⚖️ WHAT A DISTANT CITY'S GROUND SAYS IT CAN SELL (R&T ⑤ T5) — the founding
 *  scan's own verdict, forwarded verbatim: the node taxon `classifyNode` read
 *  off its terrain, plus the charter-box sums that verdict was derived from.
 *  Nothing new is computed here; "geography chooses" simply reaches the
 *  scarcity proxy the barter clerk quotes from. */
function cityPartnerGeography(fc: FlightCity): PartnerGeography {
  return {
    node: fc.city.node?.type ?? null,
    farmland: fc.city.charter?.farmland,
    ore: fc.city.charter?.ore_access,
  };
}

/** Aim the town's intercity trade line (kernel/town/trade.ts) at its REAL
 *  nearest neighbor, now that the planet knows its cities: the caravan comes
 *  and goes by the gate that faces the road out (matching the planet-scale
 *  net), and its rare cargo scales with the true distance. Villages already
 *  streamed by the region tier count as partners — a day's-walk hamlet beats
 *  a far capital. Sim coords ride the same east/north tangent frame the
 *  ground samplers walk. */
function bindTradePartner(fc: FlightCity, mesh: THREE.Group, play: TownPlay): void {
  const trade = play.stage.trade;
  if (!trade || !flight) return;
  const self = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]);
  const other = new THREE.Vector3();
  let best: FlightCity | null = null;
  let bestAng = Infinity;
  for (const c of flight.cities()) {
    if (c.body !== fc.body || c.city.cell === fc.city.cell) continue;
    const ang = self.angleTo(other.set(c.city.dir[0], c.city.dir[1], c.city.dir[2]));
    if (ang < bestAng) { bestAng = ang; best = c; }
  }
  if (!best || bestAng < 1e-9) return;
  other.set(best.city.dir[0], best.city.dir[1], best.city.dir[2]);
  // Tangent-plane direction toward the partner, in town-sim coordinates.
  const toward = other.addScaledVector(self, -other.dot(self));
  if (toward.lengthSq() < 1e-12) return;
  toward.normalize();
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
  const north = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
  const distM = bestAng * fc.body.radius;
  const c0 = play.stage.center;
  // TRADE PRICES THE ROAD, NOT THE CHORD: the caravan walks the route, whose
  // port-to-port length runs longer than the line of sight wherever the road
  // went round a mountain. The chord stays the fallback for a partner with
  // no road between — common only where the nearest city is across a border
  // the state-adjacency net never paired.
  const road = cityIncidentRoutes(fc).find(
    ({ route, end }) => (end === "a" ? route.b : route.a) === best!.city.cell,
  );
  trade.bindPartner({
    key: `city:${best.city.cell}`,
    at: { x: c0.x + toward.dot(east) * distM, y: c0.y + toward.dot(north) * distM },
    distanceM: road?.route.lengthM,
    // ⚖️ T5: the neighbour's own terrain reading rides the bind, so the closed-
    // form proxy quotes a river-mouth granary differently from a mining camp.
    geo: cityPartnerGeography(best),
  });
}

/** The city's tangent frame — EXACTLY the surface-anchor convention its
 *  render mounts with (attachSurfaceAnchor: +Y-out quaternion; plan x runs
 *  along local +X, plan y along +Z), so kernel bearings and the splice
 *  land in the same coordinates the town draws in. */
function townFrameOf(fc: FlightCity): TownFrame {
  const d = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_UP_Y, d);
  const e = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return { center: [d.x, d.y, d.z], east: [e.x, e.y, e.z], north: [n.x, n.y, n.z] };
}

/** The town's gates, best first: every port the street tree DECLARED, then
 *  every other gen-0 street end behind them (see townSpliceSpecOf). */
function townGates(net: TownStreets): ArterialTip[] {
  const gates = arterialTips(net.streets, net.ports);
  for (const t of arterialTips(net.streets)) {
    if (!gates.some(g => g.street === t.street && g.end === t.end)) gates.push(t);
  }
  return gates;
}

/** The trade-roads splice spec for a city whose street plan is built —
 *  null until the town is ready (no plan, nothing to join). The extent is
 *  the DERIVED one (scale.ts `townExtentM`), the SAME number planet/routes.ts
 *  ported the routes at and the SAME one the street tree grew to — plan.radius
 *  is the BUILT-UP radius, which shrinks with the town and would no longer
 *  name the port. */
function townSpliceSpecOf(fc: FlightCity): TownSpliceSpec | null {
  const play = cityTowns?.entry(fc.city.cell)?.play;
  if (!play) return null;
  const net = play.plan.streets;
  return {
    frame: townFrameOf(fc),
    radiusM: townExtentM(docSessionScale() ?? REAL_SCALE),
    // THE GATE IS THE PORT (§2.2): the tree DECLARES where its roads leave,
    // and those gates come FIRST — `nearestArterialTip` keeps list order on a
    // tie, so a declared port always beats an ordinary tip at the same
    // bearing. For a span-seeded town the port IS the road's own endpoint and
    // `spliceRouteAtTown` returns null: nothing to bend, no connector.
    // The remaining gen-0 ends stay on the list behind them as the reach for
    // a road the town never knew about — a village lane from a region
    // refined AFTER these streets were laid ports at an extent the tree made
    // no gate for, and a plain ribbon stopping in the fields is worse than a
    // connector to the nearest real street end.
    tips: townGates(net),
    // The building line a connector's PAINT must stop at (the ribbon may
    // still thread the lots to reach its gate). STUB-TOWN PATH ONLY now:
    // a town whose baseline reaches the port grows no connector to paint.
    houses: play.plan.houses.map(h => ({ dx: h.dx, dy: h.dy, w: h.w, h: h.h })),
  };
}

/** The city's incident routes, with which endpoint the city is: the
 *  founding interstates plus the region's own village lanes. Stitch pair
 *  roads are EXCLUDED on purpose — whether the neighbour region is loaded
 *  is session noise, and anything derived here must replay identically
 *  every session. */
function cityIncidentRoutes(fc: FlightCity): Array<{ route: PlanetRoute; end: "a" | "b" }> {
  const incident: Array<{ route: PlanetRoute; end: "a" | "b" }> = [];
  const net = ensureRoadNet(fc.body);
  if (net) incident.push(...net.incidentRoutes(fc.city.cell));
  // A village's roads live in its OWN region's deterministic net (its
  // composite cell key appears nowhere else); ready whenever it exists.
  for (const [key, entry] of regions) {
    if (entry.state !== "ready" || !key.startsWith(`${fc.body.id}:`)) continue;
    for (const r of entry.roads) {
      if (r.a === fc.city.cell) incident.push({ route: r, end: "a" });
      else if (r.b === fc.city.cell) incident.push({ route: r, end: "b" });
    }
  }
  return incident;
}

/** Fix C's data: the city's incident road POLYLINES → the bearing of each
 *  road's PORT (its endpoint, which planet/routes.ts already terminated at
 *  the town's extent), one per road — the gates the street tree grows its
 *  arterials to. Null = no route knowledge at all (townBias falls back). */
function cityRoadBearings(fc: FlightCity): readonly number[] | null {
  const incident = cityIncidentRoutes(fc);
  if (!ensureRoadNet(fc.body) && !incident.length) return null;
  // Inset 0: the endpoint IS the port, so its bearing is the gate bearing.
  return approachBearings(incident, townFrameOf(fc), 0);
}

/** THE SEAM (growth phase B §2.1): the city's incident road POLYLINES → the
 *  growth seeds its street tree forms around — the through road as one span
 *  across the town, a spur per remaining gate, all in town-local metres.
 *
 *  The polylines were ALREADY port-terminated at `townRMax` (planet/routes.ts
 *  — the port law at generation), so the span's ends are literally the points
 *  where the ribbons stop: the baseline runs gate to gate and the road needs
 *  no connector to reach it (§2.2).
 *
 *  Empty where the OVERLAP RULE bites — on a compressed test planet most
 *  neighbours sit closer than their own extents, so their road comes back
 *  unclipped and ports at neither end. That is not a failure: the town falls
 *  back to the bearings and grows a stub baseline, as it did before. */
function cityRoadSeeds(fc: FlightCity): readonly GrowSeed[] | null {
  const incident = cityIncidentRoutes(fc);
  if (!ensureRoadNet(fc.body) && !incident.length) return null;
  return townRoadSeeds(
    incident, townFrameOf(fc), fc.body.radius, townExtentM(docSessionScale() ?? REAL_SCALE),
  );
}
const cityViz = new Map<number, CityViz>();
const TOWN_REVEAL_M = 30_000; // beacon → street-plan handoff distance

// ── TIER-1 REGION STREAMING (hierarchical-cells.md) ────────────────────────
// Below REGION_START_ALT the region under the ship refines in the worker
// (planet/refine.ts): its VILLAGES join the city list at day's-walk spacing
// between the capitals. Regions left behind evict (LRU); the IndexedDB
// cache makes re-entry instant. FORCE: descending under REGION_FORCE_ALT
// into an unrefined region veils until the refine lands.
interface RegionEntry {
  state: "loading" | "ready" | "error";
  cells: number[];
  /** The region's local road net + refined highway spans (kept so a net
   *  created AFTER the refine — late geography, error recovery — can still
   *  sweep them in). */
  roads: PlanetRoute[];
  highways: HighwayRefinement[];
}
const regions = new Map<string, RegionEntry>();
const regionLru: string[] = [];
const REGION_START_ALT = 120_000;
const REGION_FORCE_ALT = 10_000;
const REGION_KEEP = 6;
const _regV = new THREE.Vector3();

// ── CROSS-REGION STITCHING ──────────────────────────────────────────────────
// When BOTH sides of a border are refined, their villages join hands: one
// deterministic road set per unordered region pair (geo-bake.stitch — a pure
// function of the seed, so load order only decides WHEN it appears, never
// WHAT it is). Pair roads ride the trade-roads region API under a pair key
// and leave when EITHER side evicts.
const stitchKicked = new Set<string>();
const regionPairs = new Map<string, string[]>(); // region key → live pair keys
function stitchNeighbours(body: FlightCity["body"], regionCell: number): void {
  const topo = body.geography?.grid.topo;
  if (!topo || !geoBaker) return;
  const nbs: number[] = new Array(topo.maxDegree).fill(0);
  const k = topo.neighbours(regionCell, nbs);
  for (let j = 0; j < k; j++) {
    const nb = nbs[j]!;
    if (regions.get(`${body.id}:${nb}`)?.state !== "ready") continue;
    const lo = Math.min(regionCell, nb);
    const hi = Math.max(regionCell, nb);
    const pairKey = `${body.id}:stitch:${lo}:${hi}`;
    if (stitchKicked.has(pairKey)) continue;
    stitchKicked.add(pairKey);
    geoBaker.stitch(body.id, lo, hi)
      .then(({ routes, streams }) => {
        if (!routes.length && !streams.length) return; // a sea border — deterministically empty
        const aKey = `${body.id}:${lo}`;
        const bKey = `${body.id}:${hi}`;
        if (regions.get(aKey)?.state !== "ready" || regions.get(bKey)?.state !== "ready") {
          stitchKicked.delete(pairKey); // a side evicted mid-flight — re-kick on next meet
          return;
        }
        if (routes.length) roadNets.get(body.id)?.addRegion(pairKey, { roads: routes, highways: [] });
        // Stream JOINS fold into the terrain like the regions' own streams;
        // the pair ROADS painted through addRegion above. Idempotent by pair
        // key, persist after evict; the border band re-samples once so the
        // seam closes on standing chunks.
        const relief = body.geography?.riverRelief;
        if (relief && streams.length) relief.addRivers(pairKey, streams);
        if (body.geography) {
          const pa = body.geography.grid.topo.pos3!(lo);
          const pb = body.geography.grid.topo.pos3!(hi);
          const mid: [number, number, number] = [pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]];
          const m = Math.hypot(mid[0], mid[1], mid[2]) || 1;
          mid[0] /= m; mid[1] /= m; mid[2] /= m;
          body.refreshTerrain?.(mid, regionFrame(body.geography, lo).widthM * 0.7);
        }
        for (const rk of [aKey, bKey]) {
          const list = regionPairs.get(rk) ?? [];
          list.push(pairKey);
          regionPairs.set(rk, list);
        }
      })
      .catch(err => {
        stitchKicked.delete(pairKey);
        console.warn(`stitch ${pairKey} failed:`, err);
      });
  }
}

/** Kick (idempotent) the refine for the region under `pos` on `body`;
 *  returns its entry, or null when the body has no baked geography yet. */
function ensureRegionUnder(body: FlightCity["body"], pos: THREE.Vector3): RegionEntry | null {
  if (!geoBaker || !flight || !body.geography || body.geographyPending) return null;
  _regV.copy(pos).sub(body.worldPosition).applyQuaternion(body.inverseOrientation).normalize();
  const regionCell = body.geography.grid.topo.cellAt!([_regV.x, _regV.y, _regV.z]);
  const key = `${body.id}:${regionCell}`;
  let entry = regions.get(key);
  if (!entry) {
    entry = { state: "loading", cells: [], roads: [], highways: [] };
    regions.set(key, entry);
    const bodyId = body.id;
    geoBaker.refine(bodyId, regionCell)
      .then(({ villages, roads, highways, rivers }) => {
        entry!.state = "ready";
        entry!.cells = villages.map(v => v.cell);
        entry!.roads = roads;
        entry!.highways = highways;
        flight?.addCities(bodyId, villages);
        // The village net + refined interstates join the body's road layers.
        roadNets.get(bodyId)?.addRegion(key, { roads, highways });
        // The region's own STREAMS fold into the terrain itself (river paint
        // + valley notch — rivers.ts addRivers); its LANES painted through
        // trade-roads.addRegion above (route-paint.ts). Then the standing
        // chunks nearby re-sample once so both show up without waiting for
        // LOD churn. Paint persists after the region evicts: it is the
        // world's deterministic truth, not region chrome, and both indexes
        // dedupe by key on re-entry.
        const relief = body.geography?.riverRelief;
        if (relief && rivers.length) relief.addRivers(key, rivers);
        if (body.geography) {
          const frame = regionFrame(body.geography, regionCell);
          body.refreshTerrain?.(frame.dir0, frame.widthM * 0.85);
        }
        // And any already-refined neighbour joins hands across the border.
        stitchNeighbours(body, regionCell);
      })
      .catch(err => {
        entry!.state = "error";
        console.warn(`region refine ${key} failed:`, err);
      });
    // LRU eviction: villages of long-left regions leave the sky.
    regionLru.push(key);
    while (regionLru.length > REGION_KEEP) {
      const old = regionLru.shift()!;
      const gone = regions.get(old);
      regions.delete(old);
      const oldNet = roadNets.get(old.slice(0, old.lastIndexOf(":")));
      oldNet?.removeRegion(old);
      // Pair roads leave with EITHER side.
      for (const pairKey of regionPairs.get(old) ?? []) {
        oldNet?.removeRegion(pairKey);
        stitchKicked.delete(pairKey);
        for (const [rk, list] of regionPairs) {
          if (rk === old) continue;
          const i = list.indexOf(pairKey);
          if (i >= 0) list.splice(i, 1);
        }
      }
      regionPairs.delete(old);
      if (gone?.cells.length) {
        flight?.removeCities(gone.cells);
        for (const cell of gone.cells) {
          const viz = cityViz.get(cell);
          if (viz) {
            disposeTownMesh(viz.mesh);
            cityViz.delete(cell);
            oldNet?.setTownSplice(cell, null); // the plain ribbon returns
          }
        }
      }
    }
  }
  return entry;
}
viewEl.addEventListener("pointermove", e => {
  const r = viewEl.getBoundingClientRect();
  flightPointer.x = e.clientX - r.left;
  flightPointer.y = e.clientY - r.top;
  flightPointer.clientX = e.clientX;
  flightPointer.clientY = e.clientY;
  flightPointer.inside = true;
  pmCount++;
  pmTarget = e.target instanceof Element ? (e.target.tagName + (e.target.className ? "." + String(e.target.className).slice(0, 24) : "")) : "?";
});
viewEl.addEventListener("pointerleave", () => { flightPointer.inside = false; plCount++; });
// PROBE: is the POINTER FEED itself alive? `pm` counts pointermove events that
// reached viewEl, `pl` counts pointerleave (inside → false), `tgt` is the last
// event's target element — if something overlays the canvas and steals the
// feed, tgt names it. Copying the readout necessarily parks the mouse on the
// status bar (inside=false at that instant, an observer effect) — that is why
// pm/pl are CUMULATIVE: travel ~5 s, then copy; a pm delta near 0 for the
// travel window means events never arrived, a large delta with the spark still
// dead means they arrived and died between here and the ladder.
let pmCount = 0;
let plCount = 0;
let pmTarget = "-";
/** Per-frame spirit probe ring — see the `__spirit.trace` doc above. */
const spiritTrace: string[] = [];
viewEl.addEventListener("wheel", e => {
  e.preventDefault();
  if (!flight) return;
  // Notches (± = faster/slower). The flight model applies the exponent.
  // NOT while a town session covers the flight — a parked ship must not
  // bank speed notches while the player shops.
  if (!quest) flightWheel += -e.deltaY / 100;
}, { passive: false });

// ── World lifecycle ────────────────────────────────────────────────────────
// Every space-and-planet scope is the flight streaming world (piloted, or
// under the spirit camera) — the standalone planet LOD map went with the
// lab's private orbit camera and walker.
// A STRUCTURE / TOWN game replaces the lab's scene entirely — the world
// engine's host owns its own canvas and loop while it's up.
let quest: QuestBoot | null = null;
let baseStatus = "—";

// The current document, the level's re-boot closure.
let rootLoaded: LoadedWorld | null = null;

/** The root document's declared space-time compression, resolved — or
 *  undefined when it declares none (the boots then fall back to the lab's
 *  street-clock default; the ENGINE default is realism). */
function docSessionScale(): WorldScale | undefined {
  return rootLoaded?.game?.scale ? resolveWorldScale(rootLoaded.game.scale) : undefined;
}

/**
 * The universe-wide compression dials a space boot forwards (scale.ts): body
 * size, the two distance scales, and the spin/orbit time factors. LAW: these
 * scale EVERY body, not just the home world — relative scales come out
 * unchanged, so compression reads as presentation. Only non-unity dials are
 * emitted, so an undeclared world boots byte-identically at real scale.
 */
function spaceScaleOpts(scaleSpec: WorldScaleSpec | null | undefined): {
  compression?: number; interplanetary?: number; interstellar?: number;
  revolution?: number; rotation?: number;
} {
  if (!scaleSpec) return {};
  const s = resolveWorldScale(scaleSpec);
  return {
    ...(s.planetCompression > 1 ? { compression: s.planetCompression } : {}),
    ...(s.interplanetary > 1 ? { interplanetary: s.interplanetary } : {}),
    ...(s.interstellar > 1 ? { interstellar: s.interstellar } : {}),
    ...(s.revolution !== 1 ? { revolution: s.revolution } : {}),
    ...(s.rotation !== 1 ? { rotation: s.rotation } : {}),
  };
}
let currentReboot: () => void = () => {};

function clearWorld(): void {
  setSpaceMode(false); // ground scopes: no bloom/tone-mapping, lab lights on
  setFoundingBadge(null);
  if (spirit) { spirit.ladder.dispose(); spirit.spark.group.parent?.remove(spirit.spark.group); spirit.spark.dispose(); }
  spirit = null;
  if (spiritPlanet) {
    scene.remove(spiritPlanet.group);
    spiritPlanet.planetObj.dispose();
    for (const l of spiritPlanet.lights) scene.remove(l);
    spiritPlanet = null;
  }
  if (quest) { quest.dispose(); quest = null; renderer.domElement.style.display = ""; }
  if (embedTown) { disposeEmbeddedTown(); }
  if (embedWild) { disposeWilderness(); }
  if (flight) {
    for (const v of cityViz.values()) disposeTownMesh(v.mesh);
    cityViz.clear();
    regions.clear();
    regionLru.length = 0;
    stitchKicked.clear();
    regionPairs.clear();
    conurbationLabels.clear();
    conurbationStamp = "";
    delete (window as unknown as Record<string, unknown>).__conurbations;
    scene.remove(flight.group); flight.dispose(); flight = null; cityTowns = null;
    geoBaker?.dispose(); geoBaker = null;
    flora?.dispose(); flora = null; floraBodyId = null;
    for (const net of roadNets.values()) net?.dispose();
    roadNets.clear();
    for (const net of riverNets.values()) net?.dispose();
    riverNets.clear();
    delete (window as unknown as Record<string, unknown>).__roads;
    spawnFixPending = false;
    forceVeil = false;
    delete (window as unknown as Record<string, unknown>).__flightLab;
    delete (window as unknown as Record<string, unknown>).__cityTowns;
  }
  if (spaceHud) { spaceHud.dispose(); spaceHud = null; }
}

// ── Scope boots ────────────────────────────────────────────────────────────

function bootTownPlay(loaded: LoadedWorld): void {
  clearWorld();
  // The quest host renders itself — park the lab's canvas while it plays.
  renderer.domElement.style.display = "none";
  quest = bootLivingTown(viewEl, loaded, t => { baseStatus = t; setStatus(t); }, labBoard);
  currentReboot = () => bootTownPlay(loaded);
}

// The STRUCTURE scope: a freestanding creature-quest puzzle played through the
// quest host. With avatar "spirit" it's the stationary, formless puzzle mode.
function bootStructureScope(loaded: LoadedWorld): void {
  clearWorld();
  renderer.domElement.style.display = "none";
  quest = bootStructure(viewEl, loaded, t => { baseStatus = t; setStatus(t); }, labBoard);
  currentReboot = () => bootStructureScope(loaded);
}

/** SPACESHIP flight through the system — the seagull physics, driven by the
 *  chase camera + pointer steering + the wheel speed knob. Every settled body
 *  bakes its geology OFF-THREAD (geo-bake.ts) and founds its CITIES; a city
 *  is a beacon from orbit, a street plan on approach, and a LIVING town —
 *  residents walking their errands — when you fly down into it. No mode
 *  switch: the city is already there. */
function bootSolarFlight(game: GameSettings): void {
  const t0 = performance.now();
  clearWorld();
  setSpaceMode(true); // HDR bloom + ACES tone mapping + star-only lighting
  // The streaming galaxy world generates from the document's `world.seed`
  // (1337 → the pinned home Sol); the player spawns in the home system and can
  // fly star to star. The space sky owns scene.background/fog now. faceN 48
  // (finer than the map scope's 24) because cities live per substrate cell —
  // a real-sized settled world founds a city at EVERY site that feeds itself
  // (~dozens), not a token handful.
  const w = game.world as { seed?: number; questCount?: number };
  const galaxySeed = (w.seed ?? 1337) >>> 0;
  // COMPRESSION (game.scale): a declared miniature profile shrinks every
  // materialized system AND its sky — radii, orbits, star separations, spin
  // and orbital periods, relative scales preserved (space-time-compression.md
  // §5 + settlement-emergence.md §4a). Default: real scale.
  geoBaker = createGeologyBaker({ scale: () => rootLoaded?.game?.scale ?? null });
  flight = createSpaceFlight(scene, galaxySeed, 48, geoBaker.bake, {
    canFly: game.canFly,
    species: game.avatarSpecies,
    ...spaceScaleOpts(game.scale),
  });
  // Quest certification rides the geology worker (pure JSON both ways) —
  // the founding pipeline's last main-thread lump goes off-thread.
  const certifyBaker = geoBaker;
  cityTowns = createCityTownLoader({
    certify: game => certifyBaker.certifyTown(game),
    questCount: w.questCount ?? 0,
    roadBearings: cityRoadBearings, // the fallback where no route ports
    roadSeeds: cityRoadSeeds,        // the baseline IS the through road
  });
  spaceHud = createSpaceHud(viewEl);
  scene.add(flight.group);
  (window as unknown as Record<string, unknown>).__flightLab = flight; // test bench
  (window as unknown as Record<string, unknown>).__cityTowns = cityTowns;
  // The home world's geology is still baking in the worker — the loop's
  // force gate holds the veil until it lands, then re-places the spawn on
  // the real terrain.
  spawnFixPending = true;
  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `${compression > 1 ? `miniature (÷${compression})` : "real-scale"} interstellar flight · seed ${galaxySeed} · ` +
    `steer with the mouse, wheel = speed · fly down into a city to visit it · ${ms}ms`;
  setStatus(baseStatus);
  flightReboot = () => bootSolarFlight(game);
  currentReboot = flightReboot;
}

// ── Boot dispatch ──────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  setStatus("building world…");
  showVeil("building world…");
  await paint();

  const raw = specForm.getDocument();
  applyLabLocale(raw, labLocale); // the bar's Language picker wins over the form's Locale field

  try {
    const loaded = loadWorldManifest(raw, [ECONOMY_MODULE]);
    if (!loaded.game) {
      setStatus("document has no `game` settings — nothing to run", true);
      return;
    }
    rootLoaded = loaded;
    // ONE route table (dispatch.ts): scope × avatar-kind → world route.
    // boot() only translates routes to the boots this build has; temporary
    // fallbacks below are marked and die as the spirit ladder lands.
    const route = routeFor(loaded.game.scope, avatarKind(loaded.game));
    switch (route.kind) {
      case "spirit":
        // ONE spirit system: town/structure scopes attach the SAME ladder to
        // their standalone quest-host world (flat provider — quest-boot.ts);
        // every larger scope flies it over the streaming world.
        if (loaded.game.scope === "town") bootTownPlay(loaded);
        else if (loaded.game.scope === "structure") bootStructureScope(loaded);
        else if (loaded.game.scope === "planet") bootPlanetScope(loaded.game);
        else bootSpiritWorld(loaded.game);
        break;
      case "flight":
        bootSolarFlight(loaded.game); // the piloted real-scale flight
        break;
      case "surface-walker":
        // INTERIM: a planet/region walker gets the gaze view until the
        // streamed-ground avatar spawn lands (avatar-everywhere stage).
        bootSpiritWorld(loaded.game);
        break;
      case "town-walker":
        bootTownPlay(loaded);
        break;
      case "structure-walker":
        bootStructureScope(loaded);
        break;
    }
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    hideVeil();
  }
}

// ── 🗣 LANGUAGE — see lab-locale.ts for what the locale actually drives and
//    why switching it rebuilds the world instead of retranslating it. ────────
let labLocale = normalizeLabLocale(localStorage.getItem(LOCALE_STORAGE_KEY));

for (const l of LAB_LOCALES) {
  const opt = document.createElement("option");
  opt.value = l.code;
  opt.textContent = l.label;
  langSelect.appendChild(opt);
}
langSelect.value = labLocale;

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
  specForm.setDocument(w.world);
  void boot().then(applyPaths);
};
select.addEventListener("change", loadSelected);
reloadBtn.addEventListener("click", () => void boot().then(applyPaths));
langSelect.addEventListener("change", () => {
  labLocale = langSelect.value;
  localStorage.setItem(LOCALE_STORAGE_KEY, labLocale);
  void boot().then(applyPaths); // build-time choice — rebuild, don't half-translate
});

// ── 🧭 PATHS — draw what every hosted body is steering at (see
//    shared/world-engine/path-debug-3d.ts for the colour key). The choice is the
//    LAB's and outlives a world reload: each boot builds a fresh QuestHost3D, so
//    re-apply once the new one has published itself on window.__questLab.
let pathsOn = false;
function applyPaths(): void {
  pathsBtn.setAttribute("aria-pressed", String(pathsOn));
  (window as unknown as { __questLab?: QuestHost3D }).__questLab?.setPathDebug(pathsOn);
}
pathsBtn.addEventListener("click", () => {
  pathsOn = !pathsOn;
  applyPaths();
});

// Size the renderer and load the default demo on startup (the ResizeObserver
// above re-runs resize once the flex panel is measured). This call was
// accidentally dropped when the spirit functions were inserted — without it the
// lab comes up with a blank world file / empty view until you pick a demo.
resize();
loadSelected();

// ── The anchor-driven ground streaming (cities LOD ladder + live-town mount +
// flora/roads), SHARED by fly and spirit modes. `anchorPos` is the ship pose in
// fly mode and the orbiting camera pose in spirit mode; everything here is
// keyed on it (great-circle city distance, live-town mount radius, flora/road
// focus). Returns the nearest city bits the caller's status line needs. ──────
function streamGround(
  anchorPos: THREE.Vector3, dt: number, now: number,
): { near: ReturnType<SpaceFlight["nearestCity"]>; townEntry: CityTownEntry | null; inRegion: boolean } {
  if (!flight) return { near: null, townEntry: null, inRegion: false };
  const near = flight.nearestCity(anchorPos);
  const inRegion = near !== null && near.distM < near.regionM;
  // A site the LIVE wilderness session still owns never approach-loads as a
  // city town — one ground, one owner; the loader takes over when the chunk
  // lets go (snapshotLiveFoundedSite refreshes its config on dispose).
  const liveSiteCell = liveFoundedSiteCell();
  const townEntry =
    near && cityTowns && near.distM < near.regionM * 6 && near.entry.city.cell !== liveSiteCell
      ? cityTowns.approach(near.entry)
      : null;
  setFoundingBadge(
    townEntry?.state === "founding" && near
      ? `founding ${cityLabel(near.entry)} — ${townEntry.note}`
      : null,
  );
  if (cityTowns) {
    for (const fc of flight.cities()) {
      if (fc.city.cell === liveSiteCell) continue; // the wild session owns it
      const e = cityTowns.entry(fc.city.cell);
      if (e?.state !== "ready" || !e.play) continue;
      let viz = cityViz.get(fc.city.cell);
      if (!viz) {
        const dir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
        const h0 = Math.max(0, fc.body.geography?.surface.heightAt(fc.city.dir) ?? 0);
        // The town's canonical surface address; its anchor group IS this point's
        // SurfaceChart (attachSurfaceAnchor uses the shared convention).
        const point: SurfacePoint<CelestialBody> = { body: fc.body, localDir: dir, elevation: h0 };
        const g = attachSurfaceAnchor(point);
        const groundAt = makeTownGround(fc, g);
        const view = buildTownMesh(e.play.plan, e.play.stage.roads, e.play.stage.center, groundAt);
        g.add(view.group);
        viz = { fc, mesh: g, view, ground: groundAt, point };
        cityViz.set(fc.city.cell, viz);
        bindTradePartner(fc, g, e.play);
        // The detailed render is up: incident ribbons clip at the town
        // edge and splice onto its arterial tips (render-only).
        const spliceSpec = townSpliceSpecOf(fc);
        if (spliceSpec) roadNets.get(fc.body.id)?.setTownSplice(fc.city.cell, spliceSpec);
      }
      flight.setCityMarkerVisible(
        fc.city.cell,
        anchorPos.distanceTo(fc.worldPos) > TOWN_REVEAL_M,
      );
    }
  }
  const nearDist3 = near ? anchorPos.distanceTo(near.entry.worldPos) : Infinity;
  if (!embedTown && nearDist3 < TOWN_LIVE_IN_M && townEntry?.state === "ready" && townEntry.play) {
    const viz = cityViz.get(near!.entry.city.cell);
    if (viz) mountLiveTown(viz, townEntry.play, cityLabel(near!.entry));
  } else if (embedTown && liveViz && groundedIn !== "town" && !spiritRiding() &&
             anchorPos.distanceTo(liveViz.fc.worldPos) > TOWN_LIVE_OUT_M) {
    // Unmount is a SIM/RENDER-LOD choice and never a physics event: the walker
    // was handed to the planet's ground layer at the town edge long before
    // this radius (groundedIn guard = belt and braces), and a town one of
    // whose bodies the spirit is RIDING stays mounted however far the ride
    // goes — unmounting would destroy the ridden creature. TODO(histfig): the
    // real fix promotes a creature pulled out of its town to a historical
    // figure that outlives the town host (see quest-boot.ts TODO).
    disposeEmbeddedTown();
  }
  // VIEW-DISTANCE LOD (view-distance-lod-tiers.md Phase 2): set the mounted
  // town's ambient crowd budget BEFORE it steps below. WALKING the town (or a
  // structure/ridden focus) is always FULL — distance-to-centre is meaningless
  // on foot, and a stable budget there is what keeps ground play churn-free.
  // Otherwise (flight / orbit / district) ramp by camera→town distance through
  // the HYSTERETIC wrapper: 0 at orbit (no bodies, no voices), and — critically
  // — a value that only changes when the camera really moves, so a hovering
  // orbit or district view never re-spawns the marginal body every frame.
  if (embedTown && liveViz) {
    const walking = groundedIn === "town" || spiritTownDriven;
    const townDistM = anchorPos.distanceTo(liveViz.fc.worldPos);
    // Both pushes are DEBOUNCED (see debouncedTier) — a one-frame `walking`
    // flap must not flood a whole-crowd rebuild or flap the street budget.
    embedTown.host.setCrowdBudget(debouncedBudget(walking ? null : hystereticCrowdBudget(townDistM), now));
    // Phase 3 creature tier rides the same push: full whenever walking (bodies
    // at arm's length), else the hysteretic distance band. Per-CAMERA, render-
    // only — see hystereticCreatureTier.
    embedTown.host.setCreatureTier(debouncedTier(walking ? "full" : hystereticCreatureTier(townDistM), now));
  }
  // The layer that OWNS the walker is stepped at full frame rate by the
  // grounded loop; every other mounted ground layer keeps living at the
  // airborne cadence — a town stays alive while you walk the fields around
  // it, the fields' fauna graze on while you walk the town's streets.
  if (embedTown && groundedIn !== "town" && !(spirit && spiritTownDriven)) {
    townStepAcc += dt;
    if (townStepAcc >= AIRBORNE_TOWN_STEP_S) {
      const t0 = performance.now();
      embedTown.host.step(Math.min(0.05, townStepAcc), now);
      perf.town = performance.now() - t0;
      townStepAcc = 0;
      syncLiveHandoff();
    }
  }
  if (embedWild && groundedIn !== "wild") {
    // Cadence step only while nothing else owns the tick: the spirit ground
    // rung steps this session at the full frame rate (spiritWildDriven).
    if (!spiritWildDriven) {
      wildStepAcc += dt;
      if (wildStepAcc >= AIRBORNE_TOWN_STEP_S) {
        embedWild.host.step(Math.min(0.05, wildStepAcc), now);
        wildStepAcc = 0;
      }
    }
    // Distance unload — but NEVER while the spirit ground rung stands on open
    // country (asked LIVE, not via spiritWildDriven, which is computed before
    // the ladder step and misses the very frame the chunk mounts): during the
    // drop's descent blend the CAMERA is still kilometres up while the glide
    // already stands on the surface, and measuring the camera here dispose/
    // remount-thrashed the chunk every few frames until the blend landed. The
    // glide's park re-anchors the chunk under the player each frame; when the
    // rung exits, the ordinary distance rule resumes.
    const glideOwnsWild = !!spirit && spirit.ladder.level === "ground" && !spirit.ladder.groundInTown();
    if (wildRoot && !glideOwnsWild) {
      wildRoot.getWorldPosition(_wildPos);
      const dWild = anchorPos.distanceTo(_wildPos);
      if (dWild > TOWN_LIVE_OUT_M) {
        traceWalk(`wild chunk out of range (d=${Math.round(dWild)} m) — unmounting`);
        disposeWilderness();
      }
    }
  }
  driveFlora(dt, anchorPos);
  driveRoadNets(dt, anchorPos);
  return { near, townEntry, inRegion };
}

// ── SPIRIT-MODE helpers (the ladder owns all level logic) ──────────────────
const DRONE_MIN_ALT = 12;   // dive floor (m)

// The spirit ladder's structure rung steps the live-town host itself;
// streamGround must NOT double-step it that frame.
let spiritTownDriven = false;
// Ground rung over OPEN COUNTRY: stepSpirit steps the wild session at the
// full frame rate (it is the player's cursor engine there) — streamGround's
// airborne-cadence step must skip those frames.
let spiritWildDriven = false;
// Which ground layer the shared board last followed the glide into (null =
// re-claim on the next ground frame — e.g. after a rung change, when a
// proximity town mount may have taken the board at boot).
let spiritBoardTown: boolean | null = null;
// FORENSICS: last-seen rung / near-town for the __walk seam trace.
let lastSpiritLevel: string | null = null;
let lastSpiritNearTown: string | null = null;

let _spiritHostFor: EmbeddedTown | null = null;
let _spiritHost: SpiritStructureHost | null = null;
const _pendDir = new THREE.Vector3();

/** The live town's dollhouse host for the spirit ladder — POSE-ONLY camera
 *  access (the ladder owns the camera), gaze-walker parking, and a step that
 *  marks the host driven this frame. Null unless the live town is mounted
 *  UNDER the focused city. */
function spiritStructureHost(fc: FlightCity): SpiritStructureHost | null {
  if (!embedTown || !liveViz || liveViz.fc.city.cell !== fc.city.cell) return null;
  const et = embedTown;
  if (_spiritHostFor !== et) {
    _spiritHostFor = et;
    _spiritHost = {
      setSpiritFocus: f => et.host.setSpiritFocus(f ?? null),
      dollhousePose: (f, az, out) => et.host.dollhousePose(f ?? null, az, out),
      placeGazeAvatar: (x, y) => et.placePlayer(x, y),
      setPointer: (cx, cy) => et.host.setPointer(cx, cy),
      clearPointer: () => et.host.clearPointer(),
      setExternalCursor: on => et.host.setExternalCursor(on),
      cursorWorld: out => et.host.cursorWorld(out),
      step: (sdt, snow) => {
        spiritTownDriven = true;
        et.host.step(sdt, snow);
        syncLiveHandoff();
      },
    };
  }
  return _spiritHost;
}

/** THE ENTITY ENGINE THE PLAYER IS STANDING IN — chosen by WHERE THE GLIDE
 *  STANDS, not by what happens to be mounted: the town's host inside that
 *  town's content band (the ladder's townRef attach gate), the wilderness
 *  session everywhere else (it glide-mounts under the spark — spiritParkWild).
 *  Preferring a mounted town outright was wrong in the ring between its mount
 *  radius and its content band: gliding open fields a kilometre out asked the
 *  TOWN about ground it has no entities on, while the wild session standing
 *  right there went unasked. The ladder asks every frame and never learns
 *  which it got: the cursor obeys the same laws on both sides of a town's
 *  edge. Town-plaza coordinates never enter — hosts report in WORLD coords. */
function spiritCursorHost(): SpiritCursorHost | null {
  const inTown = spirit ? spirit.ladder.groundInTown() : embedTown !== null;
  if (inTown && embedTown && liveViz) return spiritStructureHost(liveViz.fc);
  return embedWild?.quest ?? null;
}

/** WILD GROUND PRESENCE UNDER THE GLIDE (provider.parkWildAvatar — called
 *  every ground frame the glide stands on ground no town's content band
 *  covers). Standing on open country is the same act as standing in a street:
 *  the wilderness session mounts under the spark and its hidden gaze avatar
 *  parks on the glide, so hover/dwell/products/possession run off the SAME
 *  engine code as a town's — and as a flat region's. The chunk then FOLLOWS
 *  the glide: the parked pose drives the same floating-origin rebase the
 *  walker uses (maybeRebaseWild), so gliding cross-country re-anchors the
 *  chart instead of walking off its edge. */
function spiritParkWild(p: THREE.Vector3): void {
  if (grounded) return; // a walker owns the ground; its own loop parks/rebases
  if (!mountWildChunk(p)) return; // water/unbaked/backoff — the bare ray stands in
  const ew = embedWild;
  if (!ew || !wildAnchor) return;
  wildAnchor.updateWorldMatrix(true, false);
  const local = wildAnchor.worldToLocal(_wildPos.copy(p));
  ew.placePlayer(local.x, local.z);
  maybeRebaseWild();
}

/** THE BODY THE SPARK DRIVES in the live town under `fc` (SIM coords + facing),
 *  or null when the spark rides nothing. `drivenId === localId` IS the "no
 *  claim" state — a fresh spark drives its own formless body (engine.ts).
 *  The spirit ladder's ground rung polls this to follow a claimed avatar. */
function spiritDrivenBody(fc: FlightCity): { x: number; y: number; fx: number; fy: number } | null {
  if (!embedTown || !liveViz || liveViz.fc.city.cell !== fc.city.cell) return null;
  const st = embedTown.host.world?.state;
  if (!st || st.drivenId === st.localId) return null;
  const a = st.avatars[st.drivenId];
  return a ? { x: a.x, y: a.y, fx: a.fx, fy: a.fy } : null;
}

/** RE-PARENT THE SPARK TO SUIT THE RUNG, and set its depth test to match.
 *
 *  FLIGHT: a HUD cursor — anchored to the CAMERA, drawn on top. The flight
 *  effect (the slipstream embers, the depth lead as you dive) is authored in
 *  camera space and only reads right from there.
 *  GROUND / STRUCTURE: an object standing in the world — hung off the planet's
 *  body group, the same parent the terrain chunks, towns, trees and creatures
 *  use, so the floating-origin rebase carries it and the world occludes it.
 *
 *  The spark's remembered positions are in its GROUP's frame, so the swap goes
 *  through `GazeSpark.rebase` (old parent → new parent) and the cursor stays
 *  exactly where it was on screen instead of leaping by the whole frame shift. */
const _sparkReparent = new THREE.Matrix4();
function sparkToRung(s: SpiritRun): void {
  // THE SKY MUST NOT TOUCH THE SPARK. `forceBodyMeshesOpaque` walks the body
  // group every frame and stomps every mesh under it to
  // `transparent=false / depthWrite=true / opacity=1` — so the moment the spark
  // hangs off the planet, its additive, non-writing glow is flattened into an
  // opaque depth-writing quad and vanishes against the ground. The sky prunes
  // any subtree that owns its material state; the ground layers already claim
  // it (see mountWildernessAt), and the spark, which runs its own fades and
  // blending, claims it too. Set on the GROUP, so the core, halo and embers
  // under it are all spared.
  s.spark.group.userData[OWNS_MATERIAL_STATE] = true;
  const world = s.ladder.level === "ground" || s.ladder.level === "structure";
  const want: THREE.Object3D = world ? s.focusBody.group : camera;
  const have = s.spark.group.parent;
  if (have !== want) {
    if (have) {
      have.updateWorldMatrix(true, false);
      want.updateWorldMatrix(true, false);
      // new-frame ← old-frame, so the eased position survives the swap.
      s.spark.rebase(_sparkReparent.copy(want.matrixWorld).invert().multiply(have.matrixWorld));
    }
    want.add(s.spark.group);
  }
  s.spark.setDepthTest(world);
}

/** Does the spark ride a body right now? (the mounted town's own city). */
function spiritRiding(): boolean {
  return !!liveViz && spiritDrivenBody(liveViz.fc) !== null;
}

/** Bake/region force gates for the spirit — a veil message while terrain
 *  loads under the camera, else null (and region refinement kicks). */
function spiritForceGates(pos: THREE.Vector3): string | null {
  if (!flight) return null;
  const nb = flight.world.nearestBodyAltitudeAt(pos);
  if (nb.body?.geographyPending && Number.isFinite(nb.altitude) && nb.altitude < nb.body.radius * 0.75) {
    nb.body.startGeographyBake?.();
    return `surveying ${nb.body.id} — terrain baking…`;
  } else if (nb.body?.walkable && Number.isFinite(nb.altitude) && nb.altitude < REGION_START_ALT) {
    ensureRegionUnder(nb.body, pos);
  }
  return null;
}

/** Drive one SPIRIT frame: resolve any pending focus, feed the pointer to
 *  the ladder (which owns the camera + every level's logic), then handle the
 *  veil, status and HUD around its result. */
function stepSpirit(dt: number, now: number): void {
  if (!flight || !spirit) return;
  const s = spirit;
  // STANDING IN A TOWN TICKS IT AT THE FULL FRAME RATE — riding one of its
  // bodies, or gliding its streets on the ground rung. Claim the town's step up
  // front: streamGround (called from inside ladder.step → postFrame) skips its
  // own throttled airborne step when this flag is set, and we take the step
  // below at the real dt.
  //  • riding: left throttled, a claimed creature walks in ~2 Hz lurches while
  //    its camera tracks it smoothly;
  //  • gliding: the town host IS the player's cursor engine on that rung (it
  //    picks the walls, snaps the gaze to entities, runs the dwell), and a
  //    2 Hz gaze pipeline is exactly what made the planet cursor read as a
  //    lagging laser pointer next to the flat path's.
  // The airborne cadence is for towns you are NOT in — it stays.
  const riding = spiritRiding();
  const glidingTown = s.ladder.level === "ground" && s.ladder.groundInTown();
  const stepTownFull = riding || glidingTown;
  spiritTownDriven = stepTownFull; // also set by the structure rung's host step
  // Standing on OPEN COUNTRY steps the WILD session at the full rate for the
  // same reason a town gets it above: on the ground rung that session IS the
  // player's cursor engine (gaze pick, entity snap, dwell), and the airborne
  // cadence reads as a lagging laser pointer. Rides included — a claimed wild
  // creature must not walk in cadence lurches either.
  const glidingWild = s.ladder.level === "ground" && !glidingTown;
  spiritWildDriven = glidingWild && embedWild !== null;

  // A town-rung initial_focus resolves once the home world's cities exist
  // (the geology bake founds them): park the drone over the focus town and
  // let the ladder's own enter gate take it from there.
  if (s.pendingFocus) {
    const cities = flight.cities().filter(fc => fc.body === s.focusBody);
    if (cities.length) {
      const fc = cities[s.pendingFocus.index % cities.length]!;
      _pendDir.set(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize()
        .applyQuaternion(fc.body.orientation);
      s.drone.setGround(_pendDir, CITY_FOCUS_ALT * 1.5);
      cityTowns?.approach(fc); // found it now — the enter gate needs its plan
      s.pendingFocus = null;
    }
  }

  const pointer = flightPointer.inside
    ? { x: flightPointer.x, y: flightPointer.y, clientX: flightPointer.clientX, clientY: flightPointer.clientY }
    : null;
  const res = s.ladder.step(pointer, dt, now);

  // FORENSICS: rung + near-town transitions in the seam trace (__walk.trace) —
  // the blackout reports correlate with exactly these boundaries.
  if (s.ladder.level !== lastSpiritLevel) {
    traceWalk(`spirit rung ${lastSpiritLevel ?? "-"} → ${s.ladder.level}`);
    lastSpiritLevel = s.ladder.level;
  }
  {
    const ntKey = res.nearTown ? res.nearTown.label : null;
    if (ntKey !== lastSpiritNearTown) {
      traceWalk(`spirit nearTown ${lastSpiritNearTown ?? "-"} → ${ntKey ?? "-"}`);
      lastSpiritNearTown = ntKey;
    }
  }
  // The ladder posed the camera for this frame — floor it against the DRAWN
  // terrain skin (a pose under the LOD mesh is a fully blank screen).
  clampCameraAboveDrawnGround();

  // WHERE THE SPARK LIVES, BY RUNG. In FLIGHT it is a HUD cursor: anchored to
  // the CAMERA, drawn on top, with the slipstream authored in camera space —
  // that is the flight effect and it must not change. On the GROUND it is an
  // object standing in the world: hung off the planet's body group (the same
  // parent the terrain chunks, towns, trees and creatures use), depth-tested,
  // carried by the floating-origin rebase like everything else on the surface.
  sparkToRung(s);

  // GROUND rung: the glide is a live interlocutor — forward the pointer to
  // the live town host so dwell-to-talk / containers work mid-glide (the
  // flat quest-boot path does the same; the STRUCTURE rung forwards from
  // inside the ladder; town/flight keep the host pointer clear so an orbit
  // dwell never doubles as an interaction).
  if (embedTown) {
    if (s.ladder.level === "ground" && pointer) {
      embedTown.host.setPointer(pointer.clientX, pointer.clientY);
    } else if (s.ladder.level !== "structure") {
      embedTown.host.clearPointer();
    }
    // PLANET LAW: on the ground rung the planet's spark is the ONE cursor.
    // Asserted here for the MOUNTED host regardless of the ladder's townRef —
    // the mount band (TOWN_LIVE_IN_M) is wider than the ladder's content
    // attach radius, and in the ring between them a pointer-fed host would
    // otherwise draw its own spark next to the provider's. The ladder itself
    // re-asserts the opt-out per frame while attached, and hands the cursor
    // BACK at the structure rung (the dollhouse town-view exception).
    if (s.ladder.level === "ground") embedTown.host.setExternalCursor(true);
    // INTERIORS follow whether a REAL BODY is in the house — never the rung
    // alone. A formless spirit drifting down the street is not an occupant,
    // and letting its parked stand-in avatar count as one stripped the walls
    // off every house it passed. But CLAIM a creature (in spirit mode or not)
    // and you are a person standing in a room again, so the interior opens
    // exactly as it does for a walker. The dollhouse opens one regardless —
    // that is what the structure rung IS.
    embedTown.host.setInteriorReveal(s.ladder.level === "structure" || riding);
  }
  // The WILD session gets the same treatment on its ground (open country):
  // pointer forwarded so dwell-to-talk / containers / harvest hovers work
  // mid-glide, external-cursor asserted so the planet's spark stays the ONE
  // cursor. There is no wild structure rung — every other rung clears.
  if (embedWild?.quest) {
    if (s.ladder.level === "ground" && pointer) {
      embedWild.host.setPointer(pointer.clientX, pointer.clientY);
    } else {
      embedWild.host.clearPointer();
    }
    if (s.ladder.level === "ground") embedWild.quest.setExternalCursor(true);
  }
  // THE BOARD FOLLOWS THE GROUND UNDER THE GLIDE — the same last-wins law the
  // walker handoff runs: crossing a town's content band hands the shared
  // board to the session that now owns the player's interactions (a town's
  // streets, or the open country's wild session with its founding verbs).
  // Reset off the ground rung so a proximity mount claiming the board at
  // boot mid-flight is corrected on the next touch of ground.
  if (s.ladder.level !== "ground") {
    spiritBoardTown = null;
  } else if (glidingTown !== spiritBoardTown) {
    spiritBoardTown = glidingTown;
    if (glidingTown) embedTown?.claimBoard();
    else embedWild?.claimBoard?.();
  }

  // The town's own step while the player STANDS IN IT (riding or gliding) —
  // AFTER the ladder posed the camera and the pointer landed, for two reasons:
  // the host picks the gaze (and steers a claimed body toward it) through THIS
  // camera — a pick against last frame's matrix is a full frame of planetary
  // sweep off the surface — and its camera-dependent mesh sync wants the posed
  // camera too. The structure rung steps its host from inside the ladder for
  // exactly the same reason, so never double-step it here.
  if (stepTownFull && embedTown && s.ladder.level !== "structure") {
    const t0 = performance.now();
    embedTown.host.step(dt, now);
    perf.town = performance.now() - t0;
    syncLiveHandoff();
  }
  // The wild session's full-rate step while the glide stands on its ground —
  // same post-camera ordering, same reasons.
  if (spiritWildDriven && embedWild) {
    embedWild.host.step(dt, now);
  }

  // Force-gate veil (terrain baking under the camera — the ladder froze the
  // dive; we hold the curtain).
  if (res.waiting) {
    showVeil(res.waiting);
    forceVeil = true;
  } else if (forceVeil) {
    hideVeil();
    forceVeil = false;
  }

  (window as unknown as Record<string, unknown>).__spirit = {
    // THE LIVE LADDER + DRONE — so a probe can fly the camera down and stand
    // it on the ground without a human at the mouse (`drone.setGround(dir,
    // alt)` then `ladder.dropToGround(drone.groundPoint(...))`); every spark
    // forensic below needs a ground rung over STREAMED terrain to say anything.
    ladder: s.ladder,
    drone: s.drone,
    body: s.focusBody,
    level: s.ladder.level, ceiling: s.ladder.ceiling,
    alt: Math.round(s.drone.altitude), pointerInside: flightPointer.inside,
    // TRACE: per-frame probe history (ring, ~4 s at 60 fps). Copying the
    // status tooltip parks the mouse OUTSIDE the view, so the live tooltip can
    // never show a travel frame — this can. In the console after traveling:
    //   __spirit.trace.slice(-40).join("\n")
    trace: spiritTrace,
  };
  // One compact line per GROUND/STRUCTURE frame, oldest first.
  if (s.ladder.level === "ground" || s.ladder.level === "structure") {
    spiritTrace.push(
      `${(performance.now() / 1000).toFixed(1)}s ${s.ladder.level}` +
      ` ptr:${pointer ? `${Math.round(pointer.x)},${Math.round(pointer.y)}` : "-"}` +
      ` in:${flightPointer.inside ? 1 : 0} pm:${pmCount} pl:${plCount} tgt:${pmTarget}` +
      ` | ${s.ladder.debugGround()} cast:${castDbg} spk:${sparkProbe(s)}`,
    );
    if (spiritTrace.length > 240) spiritTrace.splice(0, spiritTrace.length - 240);
  }
  // DIAGNOSTIC readout: at the ground/structure rungs, append the live town
  // host's cutaway/gaze snapshot + the static↔live handoff state so a broken
  // dollhouse explains itself.
  let statusLine = res.status;
  if (embedTown && (s.ladder.level === "ground" || s.ladder.level === "structure")) {
    const lots = liveStage?.loadedLots?.();
    statusLine += ` ‖ ${embedTown.host.debugProbe()} | ${liveViz?.view.debugHandoff() ?? "viz:none"} lots:${
      lots ? `${lots.houses.size}h/${lots.works.size}w` : "ABSENT"
    }`;
    // ONE-CURSOR check: the LADDER's overlay spark. Pair it with the host's
    // `spk:` — amp > 0 on BOTH means two cursors are drawn at once (the flat
    // overlay one and the host's bouncing one), which reads as a single spark
    // that mostly ignores the world and occasionally hops.
  }
  // ── GROUND CURSOR PROBE ────────────────────────────────────────────────────
  // Runs with or WITHOUT a town. It used to sit INSIDE the `embedTown` block
  // above, which is why this bug hid for so long: the wilderness is the ONLY
  // place the planet's own cursor is exercised (a mounted town's host draws the
  // cursor instead — the town leak), so the one broken path had no readout at
  // all. Absent probe ≠ healthy. Reading order:
  //   cur:<owner> — `host` = TOWN drew the player's cursor (the leak);
  //                 `prov` = the planet did. ptr:- = nobody asked for a cursor.
  //   cast:       — the drawn-world raycast: n<meshes>/age<ms>/hit|miss|orphan.
  //                 `miss` = ray hit no terrain; `orphan` = hit a mesh already
  //                 detached by streaming (stale list) — both hide the spark.
  //   spk:        — the overlay spark itself: on/off, amp (0 = never drawn),
  //                 phase+core (core 0 = drawn at zero SIZE mid-dart), then
  //                 where it PROJECTS: ON@x,y = on screen, OFF@ = off-frustum.
  // That last field settles the question this hunt opened with: is the spark
  // failing to render, or is it rendering somewhere you cannot see?
  if (s.ladder.level === "ground" || s.ladder.level === "structure") {
    statusLine += ` | cur:${s.ladder.debugGround()} cast:${castDbg} spk:${sparkProbe(s)} town:${
      embedTown ? "MOUNTED" : "-"
    }`;
  }
  if (!statusEl.classList.contains("error")) setStatus(statusLine);

  if (spaceHud) {
    const w = viewEl.clientWidth || 1;
    const h = viewEl.clientHeight || 1;
    const labelled = flight.cities()
      .map(fc => ({ fc, d: camera.position.distanceTo(fc.worldPos) }))
      .filter(x => x.d < x.fc.body.radius * 12)
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
    spaceHud.update({
      body: null, lockProgress: 0, camera, playerPos: camera.position,
      canvasW: w, canvasH: h, dt,
      cities: labelled.map(({ fc }) => ({
        name: cityLabel(fc), worldPos: fc.worldPos, outward: fc.outward,
        near: res.nearTown?.ref === fc,
      })),
    });
  }
}

/** SPIRIT scope boot — the unified spirit ladder over the streaming world.
 *  initial_focus sets the START rung + the INITIAL zoom-out ceiling (the
 *  scope stays the absolute limit); a null focus flies the home planet. */
function bootSpiritWorld(game: GameSettings): void {
  const t0 = performance.now();
  clearWorld();
  setSpaceMode(true);
  const ws = game.world as { seed?: number; questCount?: number };
  const galaxySeed = (ws.seed ?? 1337) >>> 0;
  // COMPRESSION rides the spirit route too (the miniature demo with
  // avatar: "spirit" boots here, not bootSolarFlight).
  geoBaker = createGeologyBaker({ scale: () => rootLoaded?.game?.scale ?? null });
  flight = createSpaceFlight(scene, galaxySeed, 48, geoBaker.bake, {
    canFly: game.canFly, species: game.avatarSpecies,
    ...spaceScaleOpts(game.scale),
  });
  const certifyBaker = geoBaker;
  cityTowns = createCityTownLoader({
    certify: g => certifyBaker.certifyTown(g),
    questCount: ws.questCount ?? 0,
    roadBearings: cityRoadBearings, // the fallback where no route ports
    roadSeeds: cityRoadSeeds,        // the baseline IS the through road
  });
  spaceHud = createSpaceHud(viewEl);
  scene.add(flight.group);
  // SPIRIT has no body — the player is a disembodied gaze that CHOOSES an
  // avatar later by talking to a creature. Hide the flight world's walker.
  flight.setAvatarVisible(false);
  (window as unknown as Record<string, unknown>).__flightLab = flight;
  (window as unknown as Record<string, unknown>).__cityTowns = cityTowns;

  const body = flight.world.homePlanet;
  if (!body) {
    setStatus("spirit: the home world has no surface to fly over", true);
    return;
  }
  // Start high (the whole planet) — the climb ceiling — over a mid-latitude
  // spot; dive to fly down to towns and buildings.
  const maxAlt = body.radius * 2.5;
  const startDir = new THREE.Vector3(0.35, 0.5, 0.79).normalize();
  const startHeading = new THREE.Vector3(0, 1, 0); // tangentialised by the drone
  const drone = createDroneCamera(startDir, startHeading, maxAlt);
  const spark = new GazeSpark();
  // WHERE THE SPARK HANGS IS THE RUNG'S CALL (see sparkParentForRung):
  // camera-anchored in FLIGHT — it is a HUD cursor there, and the flight effect
  // (slipstream embers, depth lead) is authored in camera space — and hung off
  // the PLANET on the ground, where it is an object standing in the world.
  scene.add(camera);
  camera.add(spark.group);

  const fl = flight;
  const provider = createPlanetSpiritProvider({
    camera, viewEl, flight: fl, body, drone,
    minAlt: DRONE_MIN_ALT, maxAlt, spark,
    townPlan: fc => {
      const p = cityTowns?.entry(fc.city.cell)?.play;
      return p ? { radius: p.plan.radius, houses: p.plan.houses, works: p.plan.works } : null;
    },
    cityLabel,
    structureHost: spiritStructureHost,
    buildingFrame: lot => embedTown
      ? { x: lot.dx + liveCenter.x, y: lot.dy + liveCenter.y, w: lot.w, h: lot.h }
      : null,
    townSimOffset: fc =>
      embedTown && liveViz && liveViz.fc.city.cell === fc.city.cell
        ? { x: liveCenter.x, y: liveCenter.y }
        : null,
    drivenBody: spiritDrivenBody,
    streamGround: (pos, sdt, snow) => {
      const { near } = streamGround(pos, sdt, snow);
      return { near: near ? { entry: near.entry, distM: near.distM } : null };
    },
    forceGates: spiritForceGates,
    castGroundRay: castDrawnGround,
    cursorHost: spiritCursorHost,
    parkWildAvatar: spiritParkWild,
  });

  // The focus rung: null flies the whole scope; a town-rung focus ("site:N")
  // starts at — and is initially CAPPED at — the town (the ceiling is a
  // control limit gameplay may raise; the scope stays the absolute limit).
  const rung = focusLevel(game.initialFocus);
  const wantTown = rung === "town";
  const focusIndex = typeof game.initialFocus === "string"
    ? Number(/:(\d+)$/.exec(game.initialFocus)?.[1] ?? 0)
    : 0;
  const ladder = createSpiritLadder({
    provider,
    ceiling: wantTown ? "town" : rung === "structure" ? "structure" : "flight",
  });
  spirit = {
    ladder, drone, spark, focusBody: body,
    pendingFocus: wantTown ? { index: focusIndex } : null,
  };
  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `SPIRIT · ${game.scope} · seed ${galaxySeed} · look where you want to fly · ` +
    `look up to descend, at the bottom to climb · ${ms}ms`;
  setStatus(baseStatus);
  flightReboot = () => bootSpiritWorld(game);
  currentReboot = flightReboot;
}

// THE VACUUM PLANET (scope "planet" — a `body` root): build the planet from its
// OWN doc params and render it ALONE (no galaxy, no star yet). Editing the doc's
// geology/rain/radius re-runs buildPlanetWorld and changes what you see. Reuses
// the whole spirit ladder via a minimal `flight` stub (the provider touches only
// advanceWorld/stepStreaming/stepSky/avatarObject) + a plain `body` literal.
function bootPlanetScope(game: GameSettings): void {
  const t0 = performance.now();
  clearWorld(); // leaves normal tone-mapping on (space mode OFF) — the vacuum
                // planet renders plainly, lit by our own sun (below), NOT the
                // star-lit bloom pipeline the streaming world needs.
  scene.background = new THREE.Color(0x05060a);

  let built: ReturnType<typeof buildPlanetWorld>;
  try {
    built = buildPlanetWorld(game);
  } catch (e) {
    setStatus(`planet: ${(e as Error).message}`, true);
    return;
  }

  // The terrain mesh — the exact primitive the celestial-body factory wraps.
  const group = new THREE.Group();
  const planetObj = createPlanetObject(built.surface, {
    resolution: 33, maxDepth: 18, buildBudget: 1,
    ocean: { color: 0x1a4f7a },
  });
  group.add(planetObj.group);
  scene.add(group);

  // A lone planet has no star — add a fresh sun + sky fill (space mode hides the
  // lab lights; the streaming star-light never exists here). Patch: a real sky.
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(1, 0.7, 0.6);
  const fill = new THREE.HemisphereLight(0xbcd4ff, 0x141a28, 0.5);
  scene.add(sun, fill);
  spiritPlanet = { group, planetObj, lights: [sun, fill] };

  // The body the spirit provider drives — a plain literal at the origin (no
  // physics): the provider only reads position/orientation/radius/surface.
  const radius = built.spec.radius;
  const body = {
    id: "planet", type: "rocky", radius,
    worldPosition: new THREE.Vector3(0, 0, 0),
    orientation: new THREE.Quaternion(),
    inverseOrientation: new THREE.Quaternion(),
    rotation: { axis: new THREE.Vector3(0, 1, 0), rate: 0 },
    geography: built,
    group,
  } as unknown as CelestialBody;

  const maxAlt = radius * 2.5; // start over the whole planet; dive to descend.
  const startDir = new THREE.Vector3(0.35, 0.5, 0.79).normalize();
  const startHeading = new THREE.Vector3(0, 1, 0);
  const drone = createDroneCamera(startDir, startHeading, maxAlt);
  const spark = new GazeSpark();
  scene.add(camera);
  camera.add(spark.group); // FLIGHT anchor; the rung re-parents it (see stepSpirit)
  // The streaming flight normally sets the camera's clip planes for space
  // distances; without it, stale near/far clip the planet to black.
  camera.near = Math.max(0.5, radius * 0.0002);
  camera.far = radius * 12;
  camera.updateProjectionMatrix();

  // The minimal streaming stub — the provider touches only these four. NOTE:
  // stepStreaming's return is the CAMERA'S near/far clip planes (the ladder
  // applies them every frame) — returning {0,0} gives a degenerate projection
  // (NaN → black). Return real space-scale planes for this lone planet.
  const clip = { near: Math.max(0.5, radius * 0.0002), far: radius * 12 };
  const flightStub = {
    advanceWorld() {},
    stepStreaming() { return clip; },
    stepSky() {},
    avatarObject: { visible: false },
  } as unknown as SpaceFlight;

  const provider = createPlanetSpiritProvider({
    camera, viewEl, flight: flightStub, body, drone,
    minAlt: DRONE_MIN_ALT, maxAlt, spark,
    townPlan: () => null,
    cityLabel: () => "",
    structureHost: () => null,
    buildingFrame: () => null,
    townSimOffset: () => null,
    drivenBody: () => null,
    streamGround: () => ({ near: null }),
    forceGates: () => null,
  });

  const ladder = createSpiritLadder({ provider, ceiling: "flight" });
  spirit = { ladder, drone, spark, focusBody: body, pendingFocus: null };
  const ms = Math.round(performance.now() - t0);
  baseStatus =
    `PLANET (vacuum) · seed ${built.spec.geology.seed} · radius ${radius} · ` +
    `${built.sites.length} sites · look to fly, up to descend · ${ms}ms`;
  setStatus(baseStatus);
  flightReboot = () => bootPlanetScope(game);
  currentReboot = flightReboot;
}

/** The vacuum planet's per-frame step: gaze-drive the ladder, then LOD the mesh
 *  from the camera (body at origin, identity ⇒ camera-local = camera world). */
function stepPlanetSpirit(dt: number, now: number): void {
  if (!spirit || !spiritPlanet) return;
  const pointer = flightPointer.inside
    ? { x: flightPointer.x, y: flightPointer.y, clientX: flightPointer.clientX, clientY: flightPointer.clientY }
    : null;
  spirit.ladder.step(pointer, dt, now);
  spiritPlanet.planetObj.update(camera.position);
}

let lastT = performance.now();
// Grounded-frame streaming scratches (see the grounded branch below).
const _groundStream = new THREE.Vector3();
const _groundStreamPrev = new THREE.Vector3();

// ── WALK-SEAM FORENSICS (the leaving-a-city blackout — strip once browser-
// verified, per house rule). A ring of seam events + a per-frame exception
// guard: an exception thrown between the sim step and composer.render() kills
// the presented frame silently, which IS a black screen with no obvious cause.
// Read in the console via  __walk.trace  (or copy(__walk.trace.join("\n"))).
const walkTrace: string[] = [];
function traceWalk(ev: string): void {
  const line = `${(performance.now() / 1000).toFixed(1)}s ${ev}`;
  walkTrace.push(line);
  if (walkTrace.length > 200) walkTrace.shift();
  console.log(`[walk] ${line}`);
}
(window as unknown as Record<string, unknown>).__walk = {
  trace: walkTrace,
  snap: () => ({
    grounded, groundedIn,
    spirit: spirit ? spirit.ladder.level : null,
    town: !!embedTown, wild: !!embedWild,
    cam: camera.position.toArray().map(v => Math.round(v)),
    camFinite: Number.isFinite(camera.position.x + camera.position.y + camera.position.z),
    veil: forceVeil,
  }),
  /** What actually got drawn by the last render pass (triangles ≈ 0 with a
   *  blank screen ⇒ nothing visible; large ⇒ drawn but black — composer/NaN). */
  gl: () => ({ ...renderer.info.render }),
  /** DISCRIMINATOR: HOLD raw renderer output (no HDR composer) on screen for
   *  `seconds` (default 4) — the world freezes while it holds. Blank composer
   *  + visible raw ⇒ the composer (bloom/NaN) eats the frame; blank both ⇒
   *  the scene itself (camera inside/under geometry, nothing drawn). */
  raw: (seconds = 4) => {
    rawHoldUntil = performance.now() + seconds * 1000;
    return `raw renderer output held for ${seconds}s — is the world visible now?`;
  },
  /** Scan the scene for non-finite transforms/bounds — the usual sources of a
   *  bloom-blackened frame. Reports offender ancestry chains (first 30). */
  nan: () => {
    const bad: string[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse(o => {
      if (bad.length >= 30) return;
      const e = o.matrixWorld.elements;
      let matFinite = true;
      for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i]!)) { matFinite = false; break; }
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const bs = g?.boundingSphere;
      const bsBad = !!bs &&
        (!Number.isFinite(bs.radius) || !Number.isFinite(bs.center.x + bs.center.y + bs.center.z));
      if (matFinite && !bsBad) return;
      const chain: string[] = [];
      let n: THREE.Object3D | null = o;
      while (n && chain.length < 6) { chain.push(n.name || n.type); n = n.parent; }
      bad.push(`${matFinite ? "boundingSphere" : "matrixWorld"} ${chain.join("←")}`);
    });
    return bad.length
      ? bad
      : "no non-finite matrixWorld/boundingSphere (NaN can still hide in vertex/instance data — use raw() to test the composer)";
  },
  /** FIND THE POISON PIXELS. Renders the scene into a NON-multisampled
   *  HalfFloat target (so the readback is honest, unlike the composer's own
   *  MSAA buffers) exactly as the RenderPass does — untone-mapped, raw HDR —
   *  then reports every NaN/Inf texel, WHERE it is on screen, and what object
   *  the camera ray hits there. That names the material producing it.
   *  Still meaningful after the sanitize pass: this reads the scene BEFORE
   *  the guard, so it keeps finding the true source. */
  scan: () => {
    const dpr = renderer.getPixelRatio();
    const w = Math.round((viewEl.clientWidth || 1) * dpr);
    const h = Math.round((viewEl.clientHeight || 1) * dpr);
    if (!scanTarget || scanTarget.width !== w || scanTarget.height !== h) {
      scanTarget?.dispose();
      scanTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 });
    }
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(scanTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    const buf = new Uint16Array(w * h * 4);
    try {
      renderer.readRenderTargetPixels(scanTarget, 0, 0, w, h, buf);
    } catch (e) {
      return `scan read failed: ${(e as Error).message}`;
    }
    const badPixels: number[] = []; // pixel indices
    let nan = 0;
    let inf = 0;
    let maxAbs = 0;
    for (let p = 0; p < w * h; p++) {
      let bad = false;
      for (let c = 0; c < 3; c++) {
        const v = buf[p * 4 + c]!;
        if ((v & 0x7c00) === 0x7c00) {
          if (v & 0x03ff) nan++; else inf++;
          bad = true;
        } else {
          const f = Math.abs(halfToFloat(v));
          if (f > maxAbs) maxAbs = f;
        }
      }
      if (bad) badPixels.push(p);
    }
    if (!badPixels.length) {
      return `clean: no NaN/Inf in ${w}x${h}. Max finite value ${maxAbs.toFixed(1)} ` +
        `(HalfFloat saturates to Inf above 65504 — anything close is a latent overflow).`;
    }
    // Name the culprit: shoot the camera ray through a spread of bad pixels.
    const step = Math.max(1, Math.floor(badPixels.length / 6));
    const named: string[] = [];
    for (let i = 0; i < badPixels.length && named.length < 6; i += step) {
      const p = badPixels[i]!;
      const px = p % w;
      const py = Math.floor(p / w); // GL readback origin is BOTTOM-left
      _probeRay.setFromCamera(
        new THREE.Vector2(((px + 0.5) / w) * 2 - 1, ((py + 0.5) / h) * 2 - 1),
        camera,
      );
      _probeRay.camera = camera;
      _probeRay.far = Infinity;
      const hit = _probeRay.intersectObjects(probeMeshes(scene), false)[0];
      let what = "nothing under the ray (sky/background)";
      if (hit) {
        const chain: string[] = [];
        let n: THREE.Object3D | null = hit.object;
        while (n && chain.length < 5) { chain.push(n.name || n.type); n = n.parent; }
        what = `${chain.join("←")} @${Math.round(hit.distance)}m`;
      }
      named.push(`css(${Math.round(px / dpr)},${Math.round((h - py) / dpr)}) → ${what}`);
    }
    return {
      summary: `${badPixels.length} bad pixel(s) of ${w * h} — NaN ${nan}, Inf ${inf}, max finite ${maxAbs.toFixed(1)}`,
      culprits: named,
      note: "Inf ⇒ HalfFloat overflow (radiance > 65504); NaN ⇒ a shader producing NaN " +
        "(normalize(vec3(0)), pow of a negative, 0/0). The named object's material is the source.",
    };
  },
  /** WHY the flora renders NaN: inspect the actual data behind the trees.
   *  A NaN pixel from a lit material almost always traces to a normal that
   *  cannot be normalised — a zero-length vertex normal, or a DEGENERATE
   *  instance matrix (zero scale collapses the basis, and three's decompose
   *  cannot see that; read the COLUMNS). MeshToonMaterial is especially
   *  unforgiving: it feeds dot(normal, light) straight into a gradient-map
   *  lookup, so one NaN normal becomes a NaN texture coordinate. */
  floraCheck: () => {
    if (!flight) return "no flight";
    const body = flight.world.nearestBodyAltitudeAt(camera.position).body;
    if (!body) return "no body";
    const rows: Record<string, unknown>[] = [];
    body.group.traverse(o => {
      const m = o as THREE.InstancedMesh;
      if (!m.isInstancedMesh && !(m as unknown as THREE.Mesh).isMesh) return;
      if (!o.name.startsWith("flora-")) return;
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute("position") as THREE.BufferAttribute | undefined;
      const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
      let posNaN = 0;
      let nrmNaN = 0;
      let nrmZero = 0;
      if (pos) {
        for (let i = 0; i < pos.count; i++) {
          if (!Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))) posNaN++;
        }
      }
      if (nrm) {
        for (let i = 0; i < nrm.count; i++) {
          const x = nrm.getX(i);
          const y = nrm.getY(i);
          const z = nrm.getZ(i);
          if (!Number.isFinite(x + y + z)) nrmNaN++;
          else if (Math.hypot(x, y, z) < 1e-6) nrmZero++; // normalize(vec3(0)) = NaN
        }
      }
      // Instance matrices: check the BASIS COLUMNS, not decompose().
      let instNaN = 0;
      let instDegenerate = 0;
      const im = m.instanceMatrix;
      if (im) {
        const a = im.array as ArrayLike<number>;
        for (let i = 0; i + 15 < a.length; i += 16) {
          let finite = true;
          for (let k = 0; k < 16; k++) if (!Number.isFinite(a[i + k]!)) { finite = false; break; }
          if (!finite) { instNaN++; continue; }
          const cx = Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!);
          const cy = Math.hypot(a[i + 4]!, a[i + 5]!, a[i + 6]!);
          const cz = Math.hypot(a[i + 8]!, a[i + 9]!, a[i + 10]!);
          if (cx < 1e-6 || cy < 1e-6 || cz < 1e-6) instDegenerate++;
        }
      }
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material & {
        gradientMap?: THREE.Texture | null;
      };
      rows.push({
        mesh: o.name,
        material: mat?.type ?? "?",
        gradientMap: mat?.gradientMap ? "yes" : "no",
        instances: m.isInstancedMesh ? m.count : "(not instanced)",
        vertNormalsZero: nrmZero,
        vertNormalsNaN: nrmNaN,
        vertPosNaN: posNaN,
        instMatrixNaN: instNaN,
        instMatrixDegenerate: instDegenerate,
      });
    });
    if (!rows.length) return "no flora-* meshes under the nearest body";
    console.table(rows);
    return `${rows.length} flora mesh(es) — table logged. Any non-zero vertNormalsZero / ` +
      `instMatrixDegenerate column is the NaN source (normalize(vec3(0)) ⇒ NaN lighting).`;
  },
  /** A/B THE FLORA MATERIAL — tests the "is it the toon shader?" hypothesis
   *  directly. "basic" is UNLIT (never touches a normal): if the NaN vanishes
   *  there, the fault is in lighting/normals. "standard" swaps only the
   *  shading model: if standard is clean and toon is not, the toon gradient
   *  lookup is the amplifier. Re-run __walk.scan() after each. */
  flora: (mode: "basic" | "standard" | "restore" = "basic") => {
    if (!flight) return "no flight";
    const body = flight.world.nearestBodyAltitudeAt(camera.position).body;
    if (!body) return "no body";
    let n = 0;
    body.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !o.name.startsWith("flora-")) return;
      const ud = o.userData as { _dbgMat?: THREE.Material | THREE.Material[] };
      if (mode === "restore") {
        if (ud._dbgMat) {
          (m.material as THREE.Material | THREE.Material[]) = ud._dbgMat;
          delete ud._dbgMat;
          n++;
        }
        return;
      }
      ud._dbgMat ??= m.material;
      const src = (Array.isArray(ud._dbgMat) ? ud._dbgMat[0] : ud._dbgMat) as THREE.MeshStandardMaterial;
      m.material = mode === "basic"
        ? new THREE.MeshBasicMaterial({
            vertexColors: src?.vertexColors ?? true,
            map: src?.map ?? null,
            alphaTest: src?.alphaTest ?? 0,
            side: src?.side ?? THREE.FrontSide,
            transparent: src?.transparent ?? false,
          })
        : new THREE.MeshStandardMaterial({
            vertexColors: src?.vertexColors ?? true,
            map: src?.map ?? null,
            alphaTest: src?.alphaTest ?? 0,
            side: src?.side ?? THREE.FrontSide,
            transparent: src?.transparent ?? false,
            roughness: 1,
            metalness: 0,
          });
      n++;
    });
    return `${n} flora mesh(es) → ${mode}. Now re-run __walk.scan(): ` +
      `clean under "basic" ⇒ normals/lighting; clean under "standard" but not toon ⇒ the toon path.`;
  },
  /** ISOLATE THE PASS: turn the bloom pyramid off (composer still runs).
   *  World returns with bloom OFF ⇒ the scene emits NaN/Inf pixels and the
   *  blur pyramid smears them over the whole frame; still black ⇒ the fault
   *  is RenderPass/OutputPass/target, not bloom. */
  bloom: (on = false) => {
    bloomPass.enabled = on;
    return `bloomPass.enabled = ${on} (setSpaceMode re-asserts this on the next scope switch)`;
  },
  /** READ THE HDR PIXELS: scan the composer's float targets for non-finite
   *  (NaN/Inf) half-floats — the thing that blackens a bloomed frame while
   *  the raw render looks fine. Reports counts + the largest finite value
   *  seen (HalfFloat saturates to Inf above 65504, so a near-max magnitude is
   *  itself the smoking gun). Run it WHILE the screen is blank. */
  hdr: () => {
    const scan = (label: string, rt: THREE.WebGLRenderTarget | undefined): string => {
      if (!rt) return `${label}: absent`;
      const w = rt.width;
      const h = rt.height;
      if (!w || !h) return `${label}: ${w}x${h} — ZERO-SIZED TARGET (this alone blanks the frame)`;
      // THE DIMENSIONS ARE THE POINT. A non-integer size means the multisample
      // renderbuffer and its resolve texture disagree after truncation, and the
      // resolved image is undefined — black. (Reading pixels back from a
      // MULTISAMPLED half-float target is itself unreliable, so treat the
      // NaN/Inf counts below as advisory, never as proof.)
      const frac = !Number.isInteger(w) || !Number.isInteger(h);
      const shape = `${w}x${h}${frac ? " ⚠ FRACTIONAL — invalid target size" : ""} samples=${rt.samples ?? 0}`;
      const px = Math.min(w, 640);
      const py = Math.min(h, 360);
      const buf = new Uint16Array(px * py * 4);
      try {
        renderer.readRenderTargetPixels(rt, ((w - px) / 2) | 0, ((h - py) / 2) | 0, px, py, buf);
      } catch (e) {
        return `${label}: ${shape} — read failed (${(e as Error).message})`;
      }
      let nan = 0;
      let inf = 0;
      let maxAbs = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]!;
        if ((v & 0x7c00) === 0x7c00) {
          if (v & 0x03ff) nan++;
          else inf++;
          continue;
        }
        const f = Math.abs(halfToFloat(v));
        if (f > maxAbs) maxAbs = f;
      }
      const all = nan === buf.length;
      return `${label}: ${shape} sampled ${px}x${py} — NaN ${nan}, Inf ${inf}, max finite ${maxAbs.toFixed(1)}` +
        (all && (rt.samples ?? 0) > 0
          ? " (100% NaN on a multisampled target = READBACK ARTIFACT, not real pixels)"
          : "");
    };
    const c = composer as unknown as {
      renderTarget1?: THREE.WebGLRenderTarget;
      renderTarget2?: THREE.WebGLRenderTarget;
    };
    const bp = bloomPass as unknown as { renderTargetsHorizontal?: THREE.WebGLRenderTarget[] };
    return [
      scan("composer.renderTarget1", c.renderTarget1),
      scan("composer.renderTarget2", c.renderTarget2),
      scan("bloom mip0", bp.renderTargetsHorizontal?.[0]),
      "(NaN/Inf anywhere above ⇒ the bloom pyramid spreads it to every pixel = black frame)",
    ];
  },
  /** Scan LIGHTS + MATERIALS for non-finite values — the usual source of NaN
   *  pixels (a light whose intensity/position went NaN paints NaN wherever it
   *  reaches, invisible in a raw render, fatal through bloom). */
  lights: () => {
    const bad: string[] = [];
    scene.traverse(o => {
      const chain = (): string => {
        const c: string[] = [];
        let n: THREE.Object3D | null = o;
        while (n && c.length < 5) { c.push(n.name || n.type); n = n.parent; }
        return c.join("←");
      };
      const l = o as THREE.Light;
      if (l.isLight) {
        const finite =
          Number.isFinite(l.intensity) &&
          Number.isFinite(l.color.r + l.color.g + l.color.b) &&
          Number.isFinite(o.position.x + o.position.y + o.position.z) &&
          Number.isFinite((l as THREE.PointLight).distance ?? 0);
        if (!finite) {
          bad.push(`LIGHT ${chain()} intensity=${l.intensity} color=(${l.color.r},${l.color.g},${l.color.b}) ` +
            `pos=(${o.position.x},${o.position.y},${o.position.z}) dist=${(l as THREE.PointLight).distance}`);
        } else if (l.intensity > 1e6) {
          bad.push(`LIGHT ${chain()} intensity=${l.intensity} (huge — can overflow HalfFloat to Inf)`);
        }
      }
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        const mm = m as THREE.MeshStandardMaterial;
        const finite =
          Number.isFinite(mm.opacity) &&
          Number.isFinite(mm.color?.r ?? 0) &&
          Number.isFinite(mm.emissiveIntensity ?? 0) &&
          Number.isFinite(mm.emissive?.r ?? 0);
        if (!finite) {
          bad.push(`MATERIAL ${chain()} opacity=${mm.opacity} color.r=${mm.color?.r} ` +
            `emissiveIntensity=${mm.emissiveIntensity} emissive.r=${mm.emissive?.r}`);
        }
      }
    });
    const pts: string[] = [];
    scene.traverse(o => {
      const p = o as THREE.PointLight;
      if (!p.isPointLight) return;
      // A point light with decay 2 divides by distance² — parked ON a surface
      // (the spark's depth law rests the cursor on the drawn world), the
      // fragments right under it take intensity/d² → HalfFloat Inf → the
      // bloom pyramid spreads Inf to every pixel = black frame, stars and
      // all. `nearestGeom` is how close it actually sits to something.
      const wp = o.getWorldPosition(new THREE.Vector3());
      pts.push(`${o.name || "PointLight"} i=${p.intensity.toFixed(2)} decay=${p.decay} ` +
        `dist=${p.distance} camD=${camera.position.distanceTo(wp).toFixed(2)}m`);
    });
    return { bad: bad.length ? bad : "all lights + materials finite", pointLights: pts };
  },
  /** A/B THE POINT LIGHTS: hold every point light in the scene at zero (the
   *  spark's hover light included) — enforced EVERY frame, since the spark
   *  rewrites its own intensity. If the blank stops while they are off, an
   *  inverse-square light sitting on a surface is overflowing the HalfFloat
   *  target and the bloom pyramid is spreading it over the whole frame. */
  pointlights: (on = false) => {
    dbgKillPointLights = !on;
    return `point lights ${on ? "restored" : "held at 0 every frame"} — walk/hover as usual and watch for the blank`;
  },
  /** What encloses the camera RIGHT NOW — run WHILE the screen is blank.
   *  Each hit: distance, full ancestry chain, and whether it is effectively
   *  VISIBLE (it and every ancestor) — an invisible hit can't be what you
   *  see. `firstVisibleDown` is the drawn surface actually under the camera
   *  (ANY mesh, not just chunk_*); `underDrawnMesh` = the camera sits BELOW a
   *  visible mesh (its underside is the blank screen). */
  probe: () => {
    if (!flight) return "no flight";
    const nb = flight.world.nearestBodyAltitudeAt(camera.position);
    const body = nb.body;
    if (!body) return "no body";
    const bp = body.group.getWorldPosition(new THREE.Vector3());
    const up = camera.position.clone().sub(bp).normalize();
    const effectiveVisible = (o: THREE.Object3D): boolean => {
      let n: THREE.Object3D | null = o;
      while (n) { if (!n.visible) return false; n = n.parent; }
      return true;
    };
    const describe = (h: THREE.Intersection): string => {
      const chain: string[] = [];
      let n: THREE.Object3D | null = h.object;
      while (n && chain.length < 6) { chain.push(n.name || n.type); n = n.parent; }
      return `${Math.round(h.distance)}m ${effectiveVisible(h.object) ? "VIS" : "hidden"} ${chain.join("←")}`;
    };
    const hitsAlong = (origin: THREE.Vector3, dir: THREE.Vector3, far: number): string[] => {
      _probeRay.set(origin, dir);
      _probeRay.near = 0;
      _probeRay.far = far;
      _probeRay.camera = camera;
      return _probeRay.intersectObjects(probeMeshes(scene), false).slice(0, 6).map(describe);
    };
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const down = hitsAlong(camera.position, up.clone().negate(), 3000);
    const upHits = hitsAlong(camera.position, up, 3000);
    const firstVisibleDown = down.find(s => s.includes("VIS")) ?? "NONE within 3km";
    const underDrawnMesh = upHits.find(s => s.includes("VIS")) ?? null;
    return {
      altAnalytic: Math.round(nb.altitude),
      firstVisibleDown,
      underDrawnMesh: underDrawnMesh ?? "nothing visible overhead",
      up: upHits,
      down,
      view: hitsAlong(camera.position, fwd, 3000),
    };
  },
};
/** Decode an IEEE half-float (the HDR targets' storage) to a JS number. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
/** Scratch target for __walk.scan (non-multisampled, so it reads back honestly). */
let scanTarget: THREE.WebGLRenderTarget | null = null;

/** Where the spark actually sits versus the ground under it, measured
 *  RADIALLY (the only frame-independent way to ask on a sphere). The eased
 *  pose is GROUP-local and the group rides the camera, so it must be lifted
 *  through the group's world matrix — reading `pos` raw gives nonsense. */
function sparkGeometry(): {
  local: THREE.Vector3; world: THREE.Vector3;
  sparkAlt: number; analytic: number; drawn: number | null;
} | null {
  if (!flight || !spirit) return null;
  const local = spirit.spark.debugPose(new THREE.Vector3());
  spirit.spark.group.updateWorldMatrix(true, false);
  const world = local.clone().applyMatrix4(spirit.spark.group.matrixWorld);
  const body = flight.world.nearestBodyAltitudeAt(world).body;
  if (!body?.geography) return null;
  const bl = body.group.worldToLocal(world.clone());
  const r = bl.length();
  const dir: [number, number, number] = [bl.x / r, bl.y / r, bl.z / r];
  const up = world.clone().sub(body.group.getWorldPosition(new THREE.Vector3())).normalize();
  const hit = castDrawnTerrain(world.clone().addScaledVector(up, 200), up.clone().negate(), 600);
  return {
    local,
    world,
    sparkAlt: r - body.radius,
    analytic: Math.max(0, body.geography.surface.heightAt(dir)), // sea-clamped, like the render
    drawn: hit ? body.group.worldToLocal(hit.clone()).length() - body.radius : null,
  };
}

/** __spark.watch(): per-frame sampling, because the CONSOLE STEALS THE
 *  POINTER — a probe run by hand always reports `cur:noptr` with a hidden,
 *  stale spark. This records frames while you play, then prints them. */
let sparkWatch: { until: number; rows: Record<string, unknown>[] } | null = null;
function sampleSparkWatch(now: number): void {
  const wch = sparkWatch;
  if (!wch || !spirit) return;
  if (now >= wch.until) {
    sparkWatch = null;
    const buried = wch.rows.filter(r => String(r.alt).includes("BURIED"));
    const phases = new Map<string, number>();
    for (const r of wch.rows) {
      const ph = String(r.state).split("/")[4] ?? "?";
      phases.set(ph, (phases.get(ph) ?? 0) + 1);
    }
    console.log(
      `[spark] ${wch.rows.length} frames · ${buried.length} BURIED under the drawn ground · ` +
      `phases ${[...phases].map(([p, n]) => `${p}:${n}`).join(" ")} ` +
      `(idle should dominate — a low idle count means it is dart-storming)`,
    );
    console.table(wch.rows.slice(-60));
    return;
  }
  const g = sparkGeometry();
  // ONE STRING for the altitudes: split across five numeric columns the
  // console collapses them behind "…" and the burial question goes unanswered
  // (it did, twice). `clearDrawn` NEGATIVE = the spark is under the skin.
  const clearDrawn = g?.drawn == null ? null : g.sparkAlt - g.drawn;
  wch.rows.push({
    t: +((now % 100000) / 1000).toFixed(2),
    state: spirit.spark.debugState(),
    alt: g
      ? `spark ${g.sparkAlt.toFixed(1)} | analytic ${g.analytic.toFixed(1)} (${
          (g.sparkAlt - g.analytic >= 0 ? "+" : "") + (g.sparkAlt - g.analytic).toFixed(2)
        }) | drawn ${g.drawn == null ? "—" : g.drawn.toFixed(1)} (${
          clearDrawn == null ? "—" : (clearDrawn >= 0 ? "+" : "") + clearDrawn.toFixed(2)
        })${clearDrawn != null && clearDrawn < 0 ? "  ⚠BURIED" : ""}`
      : "no geometry",
    cursor: spirit.ladder.debugGround(),
    cast: castDbg,
  });
}

// ── SPARK FORENSICS (__spark) — "the ground cursor is missing" has four
// mutually exclusive causes and NONE of them is distinguishable by eye:
//   1. never DRAWN        (amp/core 0 — hidden, or mid-dart at zero size)
//   2. drawn OFF-SCREEN   (placed outside the frustum)
//   3. drawn but BURIED   (physically below the terrain in 3D space)
//   4. drawn, above the ground, but OCCLUDED anyway (depth/render-order —
//      sprites vs the logarithmic depth buffer, the historic offender)
// probe() separates all four with numbers; the toggles below let you SEE it.
(window as unknown as Record<string, unknown>).__spark = {
  /** Hide the drawn terrain (re-applied every frame — the LOD re-shows chunks
   *  on each subdivide/merge). If the spark appears with the ground gone, it
   *  was case 3 or 4; probe() then says which. */
  hideTerrain: (on = true) => {
    dbgHideTerrain = on;
    if (!on && flight) {
      // Let the LOD re-assert its own visibility: re-show everything now, the
      // next update() culls what should be hidden.
      const body = flight.world.nearestBodyAltitudeAt(camera.position).body;
      body?.group.traverse(o => {
        if ((o as THREE.Mesh).isMesh && o.name.startsWith("chunk_")) o.visible = true;
      });
    }
    return `terrain ${on ? "HIDDEN (LOD overridden each frame)" : "restored"}`;
  },
  /** X-RAY the terrain instead of hiding it: keep it drawn but see-through and
   *  NON-OCCLUDING (depthWrite off). Distinguishes case 3 from case 4 while
   *  keeping the landscape as spatial reference — if the spark shows up here
   *  in the right place, the geometry was occluding it. */
  xray: (on = true) => {
    if (!flight) return "no flight";
    const body = flight.world.nearestBodyAltitudeAt(camera.position).body;
    if (!body) return "no body";
    let n = 0;
    // ONE material is shared by every chunk (createPlanetObject), so the first
    // hit does the job — traverse anyway, a body may carry more than one.
    const seen = new Set<THREE.Material>();
    body.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !o.name.startsWith("chunk_")) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        const ud = mat.userData as { _dbgPrev?: { transparent: boolean; opacity: number; depthWrite: boolean } };
        if (on) {
          ud._dbgPrev ??= { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
          mat.transparent = true;
          mat.opacity = 0.25;
          mat.depthWrite = false;
        } else if (ud._dbgPrev) {
          mat.transparent = ud._dbgPrev.transparent;
          mat.opacity = ud._dbgPrev.opacity;
          mat.depthWrite = ud._dbgPrev.depthWrite;
          delete ud._dbgPrev;
        }
        mat.needsUpdate = true;
        n++;
      }
    });
    return `${n} terrain material(s) ${on ? "x-rayed (25% opacity, depthWrite off)" : "restored"}`;
  },
  /** IS IT SPRITES? Drop a plain MESH (a small ball) at the spark's exact
   *  world position every frame, depth-tested, and see whether IT survives.
   *  Nudging the seat proved the spark is not merely buried, so the question
   *  is now whether depth works at that point AT ALL:
   *    ball visible, spark not ⇒ SPRITE-specific depth failure (three's
   *      sprite path vs this scene's log-depth/composer) — and the cure is to
   *      draw the core as a mesh rather than to disable depth.
   *    neither visible         ⇒ that point really is occluded; the placement
   *      is wrong however right it looks with depth off. */
  marker: (on = true) => {
    dbgMarker = on;
    if (!on && dbgMarkerMesh) {
      dbgMarkerMesh.parent?.remove(dbgMarkerMesh);
      dbgMarkerMesh.geometry.dispose();
      (dbgMarkerMesh.material as THREE.Material).dispose();
      dbgMarkerMesh = null;
    }
    return on
      ? "red ball at the spark's position, depth ON — visible while the spark is not = the sprite path is the problem"
      : "marker removed";
  },
  /** RAISE THE CURSOR'S SEAT by `m` metres along the local up — the decisive
   *  A/B for the depth question, WITH depth left ON (`__spark.depth(null)`
   *  first, to hand the rung rule back its control):
   *    appears at a few metres  ⇒ it was BURIED; the 0.4 m seat is too thin
   *                                against the drawn LOD skin, fix the seat.
   *    still hidden at 10 m     ⇒ the depth comparison itself is broken, and
   *                                depth-off is treating the symptom. */
  nudge: (m = 3) => {
    (globalThis as unknown as { __sparkLift?: number }).__sparkLift = m;
    return `cursor seat lifted ${m} m — with __spark.depth(null) set, does it appear now?`;
  },
  /** Pin the spark's depth test (the rung rule rewrites it every frame).
   *  depth(false) + spark appears ⇒ pure occlusion/render-order (case 4);
   *  still missing ⇒ it is not being drawn or is off-screen / buried. */
  depth: (on: boolean | null = false) => {
    dbgSparkDepth = on;
    return on === null ? "spark depth test released to the game's rung rule" : `spark depthTest pinned ${on}`;
  },
  /** SAMPLE WHILE YOU PLAY. Running probe() by hand always lies about the
   *  cursor: focusing the console puts the pointer outside the canvas, so the
   *  ladder passes `null`, groundSpark hides the spark, and probe() then reads
   *  a hidden spark's stale position (`cur:noptr`). This records every frame
   *  for `seconds` — move the mouse around the view, walk to the town edge —
   *  then prints a table plus a count of frames where the spark was below the
   *  drawn ground. */
  watch: (seconds = 6) => {
    sparkWatch = { until: performance.now() + seconds * 1000, rows: [] };
    return `sampling ${seconds}s — move the pointer over the ground now; the table prints when it ends`;
  },
  /** THE NUMBERS. Where the spark is, whether it is drawn, whether it is above
   *  the ground (analytic AND drawn-mesh), whether it is on screen, what frame
   *  it lives in, and who currently owns the cursor. */
  probe: () => {
    if (!flight) return "no flight";
    if (!spirit) {
      const et = embedTown as unknown as { host?: { debugProbe?: () => string } } | null;
      return {
        mode: "NOT spirit — the embedded host owns its own spark here",
        hostProbe: et?.host?.debugProbe?.() ?? "no host probe",
      };
    }
    const s = spirit;
    const geom = sparkGeometry();
    const local = geom?.local ?? s.spark.debugPose(new THREE.Vector3());
    const world = geom?.world ?? local.clone().applyMatrix4(s.spark.group.matrixWorld);
    const stale = !flightPointer.inside;

    // ── Case 1/2: drawn at all, and on screen?
    const ndc = world.clone().project(camera);
    const vw = viewEl.clientWidth || 1;
    const vh = viewEl.clientHeight || 1;
    const onScreen = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= -1 && ndc.z <= 1;
    const px = `${Math.round((ndc.x * 0.5 + 0.5) * vw)},${Math.round((-ndc.y * 0.5 + 0.5) * vh)}`;

    // ── Case 3: is it physically under the ground? Altitudes above SEA LEVEL,
    // measured radially — the only frame-independent way to ask on a sphere.
    const altitudes: Record<string, unknown> = !geom
      ? { note: "no body under the spark" }
      : {
          sparkAltAboveSea: +geom.sparkAlt.toFixed(2),
          groundAnalyticAboveSea: +geom.analytic.toFixed(2),
          groundDrawnAboveSea: geom.drawn === null ? "no drawn hit" : +geom.drawn.toFixed(2),
          clearanceVsAnalytic: +(geom.sparkAlt - geom.analytic).toFixed(2),
          clearanceVsDrawn: geom.drawn === null ? "—" : +(geom.sparkAlt - geom.drawn).toFixed(2),
          VERDICT:
            geom.drawn !== null && geom.sparkAlt < geom.drawn
              ? "BURIED — the spark is physically BELOW the drawn terrain (case 3)"
              : geom.sparkAlt < geom.analytic
                ? "below the ANALYTIC surface but above the drawn skin (seat/datum mismatch)"
                : "above the ground — if it is invisible, it is depth/render-order (case 4) or not drawn",
          seatHint:
            "the cursor is seated 0.4 m above the DRAWN cast hit, so a clearanceVsDrawn " +
            "far from +0.4 means the cast hit something other than the visible skin " +
            "(a superseded LOD chunk), while ≈+0.4 above ANALYTIC means an analytic path seated it",
        };

    // ── Case: wrong FRAME. The spark should be metres from the camera and
    // near the walker. A town-manifold registration error shows up as an
    // offset of roughly the plaza vector (hundreds of metres).
    const chain: string[] = [];
    let n: THREE.Object3D | null = s.spark.group;
    while (n && chain.length < 6) { chain.push(n.name || n.type); n = n.parent; }
    const context: Record<string, unknown> = {
      parentChain: chain.join("←"),
      distToCamera: +camera.position.distanceTo(world).toFixed(2),
      groupLocal: local.toArray().map(v => +v.toFixed(2)),
      world: world.toArray().map(v => +v.toFixed(1)),
    };
    if (liveAnchor) {
      liveAnchor.updateWorldMatrix(true, false);
      const inTown = liveAnchor.worldToLocal(world.clone());
      context.townLocal = inTown.toArray().map(v => +v.toFixed(1));
      context.plazaCenter = [liveCenter.x, liveCenter.y];
      context.distFromPlaza = +Math.hypot(inTown.x - liveCenter.x, inTown.z - liveCenter.y).toFixed(1);
      context.frameHint =
        "if `world` looks right but the spark is invisible, the frame is fine; " +
        "a plaza-sized offset (≈|plazaCenter|) between townLocal and where you aimed = town-registration error";
    }

    return {
      drawState: s.spark.debugState(),   // on/off · amp · hover · depthTest · phase · core
      drawn: onScreen ? `ON SCREEN @${px}` : `OFF SCREEN @${px} z=${ndc.z.toFixed(2)}`,
      altitudes,
      context,
      cursorOwner: s.ladder.debugGround(),  // includes the provider's cursor verdict
      lastCast: castDbg,                    // hit / MISS / orphan / nomesh
      rung: s.ladder.level,
      logarithmicDepthBuffer: renderer.capabilities.logarithmicDepthBuffer,
      hostSpark: (embedTown as unknown as { host?: { debugProbe?: () => string } } | null)
        ?.host?.debugProbe?.() ?? "no town host",
      staleWarning: stale
        ? "POINTER IS OUTSIDE THE VIEW (you are in the console): the ladder passed null, " +
          "the spark is HIDDEN and this position is STALE. Use __spark.watch(6) and move the " +
          "mouse over the ground instead — these numbers do not describe live play."
        : "pointer inside the view — live reading",
      hint: "amp≈0 ⇒ never drawn · OFF SCREEN ⇒ placement · BURIED ⇒ geometry · " +
        "else try __spark.depth(false) (occlusion) and __spark.xray(true) (see it through the ground)",
    };
  },
};

let frameErrAt = 0;
let camNaNAt = 0;
/** While in the future, frame() presents RAW renderer output (no composer). */
let rawHoldUntil = 0;
/** __walk.pointlights(false): hold every point light at 0 (enforced per frame
 *  — the spark rewrites its own intensity in update()). */
let dbgKillPointLights = false;
/** __spark.hideTerrain(true): hold the drawn terrain hidden (the LOD re-shows
 *  chunks on every subdivide/merge, so this must be re-applied per frame). */
let dbgHideTerrain = false;
/** __spark.depth(on): pin the spark's depth test (stepSpirit rewrites it from
 *  the rung every frame). Null = leave the game's own rule alone. */
let dbgSparkDepth: boolean | null = null;
/** __spark.marker(): a depth-tested MESH parked at the spark's world position —
 *  sprite-vs-mesh discriminator for the depth failure. */
let dbgMarker = false;
let dbgMarkerMesh: THREE.Mesh | null = null;
/** __flash.clean(): hold every city beacon hidden. The town-reveal pass
 *  re-asserts marker visibility per frame, so this must fight it per frame —
 *  the beacons are HDR-bright by design and would be mistaken for the flash. */
let dbgHideCityBeacons = false;
/** __flash.hide({...}): bisection toggles for the single-texel firefly hunt.
 *  Each names a TINY BRIGHT PRIMITIVE — the shape the planet-limb and the
 *  deep-space sightings have in common. Re-asserted per frame: the sky and the
 *  town-reveal pass both rewrite visibility every frame. */
let dbgHideAtmosphere = false;
let dbgHideStarfield = false;
let dbgHideHalos = false;
/** __flash.fatBeacons(n): scale every city beacon up by n.
 *
 *  THE DIRECT TEST OF THE SUB-PIXEL THEORY. `refreshCities` caps a beacon at
 *  `body.radius * 0.012`, which is already only ~3.5px at the range these
 *  flashes were caught at and shrinks further with distance — so beacons DO go
 *  sub-pixel. Blowing them up many pixels wide, while changing nothing about
 *  their colour or material, leaves the flash only if the cause is shading
 *  rather than how a tiny primitive rasterizes. */
let dbgBeaconScale = 1;
/** __flash.fixedBeacons(m): pin every beacon to a CONSTANT world size, removing
 *  the distance compensation in `refreshCities` (`size = 5 * dist / pxPerRad`).
 *
 *  Beacons and starfield points share one trait: both hold a constant apparent
 *  size at ranges where honest perspective would shrink them away. This isolates
 *  that compensation from the beacon's size — `fatBeacons` scales the
 *  distance-derived value and did NOT stop the flashes, so the magnitude is not
 *  the trigger; this asks whether the distance-COUPLING is. */
let dbgBeaconFixedM = 0;
/** Debug overrides re-asserted every frame, right before each present —
 *  each one fights a system that rewrites the same state per frame. */
function applyDebugOverrides(): void {
  if (dbgHideCityBeacons && flight) {
    for (const fc of flight.cities()) flight.setCityMarkerVisible(fc.city.cell, false);
  }
  if (dbgBeaconFixedM > 0) {
    scene.traverse(o => {
      if (o.name.startsWith("city:")) o.scale.setScalar(dbgBeaconFixedM);
    });
  }
  if (dbgBeaconScale !== 1) {
    // refreshCities rewrites the scale every frame, so this must re-apply after
    // it — applyDebugOverrides runs right before the present.
    scene.traverse(o => {
      if (o.name.startsWith("city:")) o.scale.multiplyScalar(dbgBeaconScale);
    });
  }
  if (dbgHideAtmosphere || dbgHideStarfield || dbgHideHalos) {
    scene.traverse(o => {
      const n = o.name;
      if (dbgHideAtmosphere && (n === "atmosphere_halo" || n === "atmosphere_veil")) o.visible = false;
      if (dbgHideStarfield && n === "galaxy-points") o.visible = false;
      // The halo/marker Points clouds are built unnamed by the sky layer.
      if (dbgHideHalos && (o as THREE.Points).isPoints && n !== "galaxy-points") o.visible = false;
    });
  }
  if (dbgKillPointLights) {
    scene.traverse(o => {
      const p = o as THREE.PointLight;
      if (p.isPointLight) p.intensity = 0;
    });
  }
  if (dbgHideTerrain && flight) {
    const body = flight.world.nearestBodyAltitudeAt(camera.position).body;
    body?.group.traverse(o => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith("chunk_")) o.visible = false;
    });
  }
  if (dbgSparkDepth !== null && spirit) spirit.spark.setDepthTest(dbgSparkDepth);
  if (dbgMarker && spirit) {
    if (!dbgMarkerMesh) {
      dbgMarkerMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 12, 8),
        // Depth-TESTED and depth-WRITING, unlit: if this is occluded where the
        // spark is not (or vice versa) the difference is the sprite path.
        new THREE.MeshBasicMaterial({ color: 0xff0044, depthTest: true, depthWrite: true }),
      );
      dbgMarkerMesh.frustumCulled = false;
      scene.add(dbgMarkerMesh);
    }
    // Same world position the spark eases to (group-local, lifted through the
    // camera-parented group) — parented to the SCENE, so nothing about the
    // camera hierarchy differs between the two.
    const g = sparkGeometry();
    if (g) dbgMarkerMesh.position.copy(g.world);
  }
}

function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  // NON-FINITE CAMERA watchdog: one NaN pose OR projection frame turns the
  // whole presented frame black (stars included) — catch it in the trace even
  // when it self-heals. Checks position, quaternion, up AND the projection
  // matrix (fov/near/far/aspect feed it; a degenerate dollhouse fov poisons
  // projection while the position stays perfectly finite).
  {
    const pe = camera.projectionMatrix.elements;
    let projFinite = true;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(pe[i]!)) { projFinite = false; break; }
    const poseFinite =
      Number.isFinite(camera.position.x + camera.position.y + camera.position.z) &&
      Number.isFinite(camera.quaternion.x + camera.quaternion.y + camera.quaternion.z + camera.quaternion.w) &&
      Number.isFinite(camera.up.x + camera.up.y + camera.up.z);
    if (!poseFinite || !projFinite) {
      if (now - camNaNAt > 1000) {
        camNaNAt = now;
        traceWalk(`CAMERA NON-FINITE ${poseFinite ? "" : "pose "}${projFinite ? "" : "projection "}` +
          `fov=${camera.fov} near=${camera.near} far=${camera.far} aspect=${camera.aspect} ` +
          `up=(${camera.up.x},${camera.up.y},${camera.up.z})`);
      }
    }
  }
  // DISCRIMINATOR HOLD (__walk.raw): present the scene straight from the
  // renderer, composer bypassed, world frozen — if this is visible while the
  // normal output is blank, the composer (bloom NaN) is eating the frame.
  if (now < rawHoldUntil) {
    renderer.clear();
    renderer.render(scene, camera);
    return;
  }
  if (quest) return; // the quest host runs its own loop on its own canvas
  // VACUUM PLANET: a lone doc-built planet (no galaxy/flight) — gaze-orbit + LOD.
  // Rendered PLAINLY (renderer, not the bloom composer): the vacuum has no star
  // and no SpaceSky, so the star-lit HDR pipeline would present black.
  if (spirit && spiritPlanet) {
    stepPlanetSpirit(dt, now);
    applyDebugOverrides();
    renderer.clear();
    renderer.render(scene, camera);
    return;
  }
  // SPIRIT: a gaze camera orbits the flight world (no piloting). Its own frame
  // — advance + stream around the focus, rotate/zoom by gaze, place the camera,
  // stream the ground under it, then draw through the HDR bloom pipeline.
  if (spirit && flight) {
    stepSpirit(dt, now);
    // AFTER stepSpirit, never inside it: stepSpirit rewrites the spark's depth
    // test from the rung every frame, so an override applied earlier was being
    // silently clobbered — which made __spark.depth(false) a no-op and its
    // "still invisible" result meaningless.
    applyDebugOverrides();
    sampleSparkWatch(now);
    composer.render();
    return;
  }
  // EMBEDDED walk↔fly — GROUNDED: the town host owns this frame (walking + its
  // chase camera). Flight-sim is dormant, its ship hidden. Gaze pinned to the
  // screen-top lifts off (maybeTakeoff → flight-sim.beginFlight).
  if (grounded && flight) {
    const ctx = groundCtx();
    if (ctx) {
      // THE PLANET KEEPS STREAMING UNDER THE WALKER. Terrain-chunk LOD /
      // materialization and the floating-origin rebase are driven by
      // flight.update in the air and by the spirit's rebaseOnCamera — but a
      // grounded frame ran NEITHER, so the drawn world stayed FROZEN around
      // the touchdown point: walk far enough (the de-walling made it
      // reachable) and the walker steps off the streamed terrain into void —
      // the screen "blanks out" at the town's edge. Same call spirit makes,
      // keyed on the shared camera.
      {
        const fovRad = (camera.fov * Math.PI) / 180;
        _groundStreamPrev.copy(camera.position);
        _groundStream.copy(camera.position);
        flight.stepStreaming(_groundStream, _groundStream, viewEl.clientHeight || 1, fovRad);
        // A floating-origin rebase re-expressed that world point (mutating the
        // anchor arg) — move the camera identically so this frame's picks
        // (which precede the chase rig's rewrite) stay aligned with the scene.
        if (!_groundStream.equals(_groundStreamPrev)) camera.position.copy(_groundStream);
      }
      if (flightPointer.inside) ctx.host.setPointer(flightPointer.clientX, flightPointer.clientY);
      else ctx.host.clearPointer();
      const t0 = performance.now();
      ctx.host.step(dt, now);
      perf.town = performance.now() - t0;
      // Static instances hide exactly where live buildings materialize,
      // return behind us — the streamer's set is the one variable.
      if (groundedIn === "town") syncLiveHandoff();
      // FLOATING ORIGIN: the chart follows the walker — never a remount.
      maybeRebaseWild();
      // Crossing a town's edge transfers the walker between ground layers
      // (pose-preserving, world frame) — the town is content, not a frame.
      maybeHandoffGround();
      // The SAME planet streaming flight uses, keyed on the WALKER's world
      // position: towns mount/unmount by distance from the walker, the
      // non-owning ground layer keeps living at the airborne cadence, flora
      // and roads stream underfoot. Ground is ground.
      const fctx = groundCtx();
      const fpose = fctx?.pose();
      if (fctx && fpose) {
        fctx.anchor.updateWorldMatrix(true, false);
        fctx.anchor.localToWorld(_floraPlayer.set(fpose.x, fctx.ground(fpose.x, fpose.y), fpose.y));
        streamGround(_floraPlayer, dt, now);
      }
      maybeTakeoff();
      // The chase rig posed the camera — floor it against the drawn terrain
      // skin (an analytic pose under the LOD mesh is a fully blank screen).
      clampCameraAboveDrawnGround();
      applyDebugOverrides();
      composer.render();
      return;
    }
    // The grounded layer vanished under us — fall back to flight.
    traceWalk(`GROUNDED FALLBACK → flight (groundedIn=${groundedIn}, town=${!!embedTown}, wild=${!!embedWild})`);
    grounded = false;
    groundedIn = null;
    flight.setAvatarVisible(true);
    spaceHud?.setVisible(true);
  }
  if (flight) {
    // ── FORCE gates — the ONLY time loading pauses the game: the player
    //    outran an off-thread bake (crossed the force boundary before it
    //    landed). The veil's compositor spinner keeps turning; the worker
    //    keeps baking; the sim freezes until the load catches up. ─────────
    {
      const stF = flight.player.state;
      let wait: string | null = null;
      for (const b of flight.world.bodies) {
        if (b.geographyPending && b.altitudeAt(stF.position) < b.radius * 0.75) {
          b.startGeographyBake?.();
          wait = `surveying ${b.id} — terrain baking…`;
          break;
        }
      }
      // TIER-1 streaming: start under 120 km, force under 10 km.
      if (!wait) {
        const nb = flight.world.nearestBodyAltitudeAt(stF.position);
        if (nb.body?.walkable && Number.isFinite(nb.altitude) && nb.altitude < REGION_START_ALT) {
          const entry = ensureRegionUnder(nb.body, stF.position);
          if (entry?.state === "loading" && nb.altitude < REGION_FORCE_ALT) {
            wait = "surveying the countryside — villages settling…";
          }
        }
      }
      if (!wait && cityTowns) {
        const nc = flight.nearestCity(stF.position);
        if (nc && nc.distM < nc.regionM * 0.7 &&
            nc.entry.body.altitudeAt(stF.position) < 2500) {
          const e = cityTowns.approach(nc.entry);
          if (e.state === "founding") wait = `founding ${cityLabel(nc.entry)} — ${e.note}…`;
        }
      }
      if (wait) {
        showVeil(wait);
        forceVeil = true;
        composer.render();
        return;
      }
      if (forceVeil) { hideVeil(); forceVeil = false; }
      // The home world's terrain just landed — re-place the spawn on it
      // (the sphere-fallback spawn may sit inside a mountain).
      if (spawnFixPending) {
        const home = flight.world.homePlanet;
        if (home && !home.geographyPending && home.surfaceAt) {
          const up = home.upAt(stF.position, new THREE.Vector3());
          const surf = home.surfaceAt(stF.position, new THREE.Vector3());
          stF.position.copy(surf).addScaledVector(up, 1500);
          spawnFixPending = false;
        } else if (home && !home.startGeographyBake) {
          spawnFixPending = false; // sync path — spawn was already right
        }
      }
    }

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
    const tFly = performance.now();
    const f = flight.update(camera, aimX, aimY, wheel, dt, h, fovRad);
    perf.fly = performance.now() - tFly;
    camera.near = f.near;
    camera.far = f.far;
    camera.updateProjectionMatrix();
    // EMBEDDED walk↔fly — AIRBORNE: flight owns the frame; a touchdown hands
    // the walker to whatever ground is here — the live town when inside it,
    // else a freshly-mounted WILDERNESS chunk (ground is ground). Checked
    // every frame, town or no town.
    if (!grounded) maybeLand();

    // ── Cities + live town + flora/roads — the anchor-driven ground streaming,
    //    now SHARED with spirit mode (keyed on the ship pose here). ──
    const st = flight.player.state;
    const { near, townEntry, inRegion } = streamGround(st.position, dt, now);

    let status = f.status;
    if (near && near.distM < near.entry.body.radius * 2) {
      status += ` · ${cityLabel(near.entry)} ${Math.round(near.distM / 1000).toLocaleString()} km`;
      if (townEntry?.state === "founding") status += ` · founding (${townEntry.note})…`;
      if (townEntry?.state === "error") status += ` · the town refused: ${townEntry.error}`;
      if (inRegion && townEntry?.state === "ready") {
        status += embedTown
          ? " · the town is live — touch down to walk"
          : " · fly toward the town";
      }
    }
    // Frame-cost probe: what this thread spends on the flight vs the town.
    if (embedTown) status += ` · fly ${perf.fly.toFixed(1)}ms town ${perf.town.toFixed(1)}ms`;
    if (!statusEl.classList.contains("error")) setStatus(status);

    if (spaceHud) {
      const locked = st.lockedBodyId ? flight.world.bodies.find(b => b.id === st.lockedBodyId) ?? null : null;
      // Label the neighbourhood, not the whole sky: within ~12 radii, and
      // only the nearest few (a real-sized world has DOZENS of cities —
      // the beacons carry the rest).
      const labelled = flight.cities()
        .map(fc => ({ fc, d: st.position.distanceTo(fc.worldPos) }))
        .filter(x => x.d < x.fc.body.radius * 12)
        .sort((a, b) => a.d - b.d)
        .slice(0, 12);
      const hudCities: HudCity[] = labelled.map(({ fc }) => ({
        name: cityLabel(fc), worldPos: fc.worldPos, outward: fc.outward,
        near: inRegion && near?.entry === fc,
      }));
      spaceHud.update({
        body: locked, lockProgress: st.lockProgress, camera, playerPos: st.position,
        canvasW: viewEl.clientWidth || 1, canvasH: h, dt, cities: hudCities,
      });
    }
    composer.render(); // HDR bloom pipeline (sun/stars/halos glow)
    return;
  }
  // Nothing mounted (a refused document, or mid-boot) — nothing to render:
  // every route lands in the quest host, the spirit ladder, or flight.
}

// ── THE STAR-FLASH TRAP (`?flashwatch=1`) ──────────────────────────────────
// Single-frame bright flashes in any space-scale scope. `sample()` runs
// immediately after the present, in the SAME task as the draw — the context
// has no preserveDrawingBuffer, so a deferred readback would get a blank.
const flashWatch = new URLSearchParams(location.search).has("flashwatch")
  ? createFlashWatch(
      renderer.domElement,
      () => flight?.sky ?? null,
      () => hdrProbe?.peak ?? null,
      // NAME THE CULPRIT: raycast the peak uv and describe what is there, with
      // the material state that could explain an order-1e4 radiance spike —
      // roughness/metalness (a specular lobe collapses as roughness → 0),
      // emissive, and tone-mapping opt-outs.
      (u, v) => {
        const ray = new THREE.Raycaster();
        // gl uv is bottom-left origin; NDC y is up, so v maps straight through.
        ray.setFromCamera(new THREE.Vector2(u * 2 - 1, v * 2 - 1), camera);
        // Points/sprites need an explicit threshold or they are never hit.
        ray.params.Points = { threshold: 500 };
        const all = ray.intersectObjects(scene.children, true);
        // HUD sprites are camera-parented and report a distance of ~2e-9, so
        // they intercept EVERY ray and would mask the real hit. Scene units are
        // metres, so anything under a millimetre is camera-attached, not world
        // geometry. Keep one for the record, then report the nearest actual
        // geometry behind them.
        const CAMERA_ATTACHED_M = 1e-3;
        const sprites = all.filter(h => h.distance <= CAMERA_ATTACHED_M);
        const solid = all.filter(h => h.distance > CAMERA_ATTACHED_M);
        const hits = [...solid.slice(0, 3), ...sprites.slice(0, 1)];
        if (!hits.length) return ["(nothing hit — sky dome, a Points cloud, or behind the camera)"];
        return hits.map((h) => {
          const o = h.object as THREE.Mesh;
          const chain: string[] = [];
          for (let p: THREE.Object3D | null = o; p; p = p.parent) {
            if (p.name) chain.push(p.name);
          }
          const m = (Array.isArray(o.material) ? o.material[0] : o.material) as
            THREE.MeshStandardMaterial | undefined;
          const bits = [
            `${chain.join("<") || o.type}`,
            `d=${h.distance.toExponential(2)}`,
          ];
          if (m) {
            bits.push(m.type);
            if (m.roughness !== undefined) bits.push(`rough=${m.roughness}`);
            if (m.metalness !== undefined) bits.push(`metal=${m.metalness}`);
            if (m.emissive) {
              bits.push(`emissive=${m.emissive.getHexString()}`);
              if (m.emissiveIntensity !== undefined) bits.push(`emisInt=${m.emissiveIntensity}`);
            }
            if (m.toneMapped === false) bits.push("toneMapped=OFF");
            if (m.color) bits.push(`color=(${m.color.r.toFixed(2)},${m.color.g.toFixed(2)},${m.color.b.toFixed(2)})`);
          }
          return bits.join(" ");
        });
      },
      (u, v) => hdrProbe?.captureRaw(renderer, u, v) ?? null,
      () => {
        // Strip every OTHER bright thing, so anything that flashes is the
        // starfield and nothing else: no beacons, no star point-light, no
        // terrain, no lab fill.
        dbgHideCityBeacons = true;
        dbgKillPointLights = true;
        dbgHideTerrain = true;
        labAmbient.intensity = 0;
        labSun.intensity = 0;
      },
      (what) => {
        if (what.beacons !== undefined) dbgHideCityBeacons = what.beacons;
        if (what.terrain !== undefined) dbgHideTerrain = what.terrain;
        if (what.atmosphere !== undefined) dbgHideAtmosphere = what.atmosphere;
        if (what.starfield !== undefined) dbgHideStarfield = what.starfield;
        if (what.halos !== undefined) dbgHideHalos = what.halos;
        if (what.beaconScale !== undefined) dbgBeaconScale = what.beaconScale;
        if (what.beaconFixedM !== undefined) dbgBeaconFixedM = what.beaconFixedM;
      },
    )
  : null;
if (flashWatch) {
  (window as unknown as Record<string, unknown>).__flash = flashWatch;
  setStatus("flash watch armed — __flash.clean() then wait; __flash.save() to dump", false);
}

renderer.setAnimationLoop(() => {
  try {
    frame();
    flashWatch?.sample();
  } catch (err) {
    // A per-frame exception must never silently blank the screen: log it
    // (rate-limited), surface it on the status line, and still present a
    // frame so the world stays visible while the cause is read off __walk.
    if (performance.now() - frameErrAt > 1000) {
      frameErrAt = performance.now();
      traceWalk(`FRAME EXCEPTION ${(err as Error).message ?? String(err)}`);
      console.error("[walk] frame exception", err);
      setStatus(`frame error: ${(err as Error).message ?? String(err)}`, true);
    }
    try { composer.render(); } catch { /* renderer itself is down — nothing to present */ }
  }
});
