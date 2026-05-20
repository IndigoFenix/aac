import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { onPlatformMessage, sendToParent, type PlatformMessage } from "@shared/games-bridge";
import { createWorld, createSky } from "./world";
import { createPlayer, type Input } from "./player";
import { createCameraRig } from "./camera";
import { PLAYER, GALAXY, GFX, PLANET, CHUNKS } from "./config";
import { DEFAULT_GALAXY_PARAMS } from "./galaxy";
import { VolumetricCloudPass } from "./cloud-volume";
import { setupDebugUI } from "./debug-ui";

// ── Generation overrides from URL hash ──────────────────────────────────────
// The generation panel lets the user edit constants and press
// "regenerate & reload" — which writes them to the URL hash and reloads.
// We parse the hash here BEFORE createWorld so the world is built with the
// overridden values.
const _hashParams = new URLSearchParams(window.location.hash.slice(1));
function _hashNumber(key: string): number | null {
  const v = _hashParams.get(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _applyHash(target: Record<string, number>, key: string, hashKey: string) {
  const v = _hashNumber(hashKey);
  if (v !== null) target[key] = v;
}
let universeSeed = 0xCAFEBABE;
{
  const seed = _hashNumber("seed"); if (seed !== null) universeSeed = seed;
  _applyHash(DEFAULT_GALAXY_PARAMS as unknown as Record<string, number>, "radius", "radius");
  const arms = _hashNumber("arms"); if (arms !== null) DEFAULT_GALAXY_PARAMS.arms = Math.max(1, Math.floor(arms));
  _applyHash(DEFAULT_GALAXY_PARAMS as unknown as Record<string, number>, "armStrength", "armstr");
  _applyHash(GALAXY as unknown as Record<string, number>, "lyToSceneMeters", "ltsm");
  _applyHash(GALAXY as unknown as Record<string, number>, "materializeLy", "mat");
  _applyHash(GALAXY as unknown as Record<string, number>, "dematerializeLy", "demat");
  // Planet / chunks generation-time constants
  const P = PLANET as unknown as Record<string, number>;
  const C = CHUNKS as unknown as Record<string, number>;
  _applyHash(P, "radius", "planet_radius");
  _applyHash(P, "seaLevel", "planet_seaLevel");
  _applyHash(P, "maxElevation", "planet_maxElevation");
  _applyHash(P, "maxDepth", "planet_maxDepth");
  _applyHash(P, "continentFreq", "planet_continentFreq");
  _applyHash(P, "detailFreq", "planet_detailFreq");
  _applyHash(P, "detailWeight", "planet_detailWeight");
  _applyHash(P, "influenceFalloff", "planet_influenceFalloff");
  _applyHash(C, "resolution", "chunks_resolution");
  _applyHash(C, "maxDepth", "chunks_maxDepth");
  _applyHash(C, "lodThreshold", "chunks_lodThreshold");
  _applyHash(C, "lodMergeThreshold", "chunks_lodMergeThreshold");
  _applyHash(C, "skirtDepth", "chunks_skirtDepth");
  _applyHash(C, "surfaceDetailRange", "chunks_surfaceDetailRange");
  _applyHash(C, "surfaceDetailAmount", "chunks_surfaceDetailAmount");
}

// ── Scene setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("scene") as HTMLCanvasElement;
// Logarithmic depth buffer keeps depth precision usable across the full
// 0.1m–50,000km near/far range we span.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = GFX.exposure;

const scene = new THREE.Scene();
const sky = createSky(scene);
const world = createWorld(scene, { seed: universeSeed });

const rig = createCameraRig();
const player = createPlayer(world, scene);

// Apply the floating-origin rebase BEFORE the first render so the very
// first frame doesn't upload float32 model-view matrices with km-scale
// ULP at the camera.
world.checkActiveSystem(player.state.position);
world.gravityAt(player.state.position, player.state.gravity);
player.sync();

// ── Post-process pipeline ───────────────────────────────────────────────────
const sceneTarget = new THREE.WebGLRenderTarget(
  canvas.clientWidth,
  canvas.clientHeight,
  { type: THREE.HalfFloatType },
);
sceneTarget.depthTexture = new THREE.DepthTexture(canvas.clientWidth, canvas.clientHeight);
sceneTarget.depthTexture.type = THREE.UnsignedShortType;

const hdrTarget = new THREE.WebGLRenderTarget(
  canvas.clientWidth,
  canvas.clientHeight,
  { type: THREE.HalfFloatType },
);
const composer = new EffectComposer(renderer, hdrTarget);

const cloudPass = new VolumetricCloudPass();
cloudPass.setSceneTarget(sceneTarget);
composer.addPass(cloudPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
  GFX.bloomStrength,
  GFX.bloomRadius,
  GFX.bloomThreshold,
);
composer.addPass(bloomPass);

const warpPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uWarp: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uWarp;
    void main() {
      vec2 center = vec2(0.5);
      vec2 toCenter = vUv - center;
      float dist = length(toCenter);
      vec3 color = vec3(0.0);
      const int SAMPLES = 6;
      float strength = uWarp * dist * dist * 0.45;
      for (int i = 0; i < SAMPLES; i++) {
        float t = float(i) / float(SAMPLES - 1);
        vec2 sampleUv = vUv - toCenter * strength * t;
        color += texture2D(tDiffuse, sampleUv).rgb;
      }
      color /= float(SAMPLES);
      gl_FragColor = vec4(color, 1.0);
    }
  `,
});
// composer.addPass(warpPass);

composer.addPass(new OutputPass());

// ── Input ───────────────────────────────────────────────────────────────────
const input: Input = { mouseX: 0.5, mouseY: 0.5 };
const crosshair = document.getElementById("crosshair")!;

const moveCrosshair = () => {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const x = input.mouseX * w;
  const y = input.mouseY * h;
  crosshair.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px)`;
};

const setFromClient = (clientX: number, clientY: number) => {
  const r = canvas.getBoundingClientRect();
  input.mouseX = THREE.MathUtils.clamp((clientX - r.left) / r.width, 0, 1);
  input.mouseY = THREE.MathUtils.clamp((clientY - r.top) / r.height, 0, 1);
  moveCrosshair();
};

window.addEventListener("mousemove", (e) => setFromClient(e.clientX, e.clientY));
window.addEventListener("touchmove", (e) => {
  if (e.touches.length > 0) setFromClient(e.touches[0].clientX, e.touches[0].clientY);
});

// ── Pause state ─────────────────────────────────────────────────────────────
// Two pause channels: platform-bridge messages (parent app puts the iframe
// to sleep) and local Escape key. They share the same `paused` flag so
// either source can pause / resume cleanly.
let paused = false;
const pauseOverlay = document.getElementById("pause-overlay")!;
function setPaused(next: boolean) {
  if (paused === next) return;
  paused = next;
  pauseOverlay.classList.toggle("visible", paused);
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    setPaused(!paused);
  }
});

// ── Bridge ──────────────────────────────────────────────────────────────────
onPlatformMessage((msg: PlatformMessage) => {
  if (msg.type === "gaze" && msg.mode !== "off") {
    input.mouseX = THREE.MathUtils.clamp(msg.x / canvas.clientWidth, 0, 1);
    input.mouseY = THREE.MathUtils.clamp(msg.y / canvas.clientHeight, 0, 1);
    moveCrosshair();
  } else if (msg.type === "pause") {
    setPaused(true);
  } else if (msg.type === "resume") {
    setPaused(false);
  } else if (msg.type === "request_close") {
    sendToParent({ type: "session_end", reason: "quit" });
  }
});

sendToParent({ type: "ready", gameId: "seagull-dream", version: "0.1.0" });

// ── HUD label ───────────────────────────────────────────────────────────────
const stateLabel = document.getElementById("state-label")!;
let lastMode = "";
let lastDominantId: string | null = null;
let warnedNonFinite = false;

// ── Debug UI ────────────────────────────────────────────────────────────────
const debugUI = setupDebugUI({ player, world, input, universeSeed });

// ── Resize ──────────────────────────────────────────────────────────────────
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  sceneTarget.setSize(w, h);
  rig.camera.aspect = w / h;
  rig.camera.updateProjectionMatrix();
}
resize();
window.addEventListener("resize", resize);

// ── Main loop ───────────────────────────────────────────────────────────────
let prev = performance.now();
let dbgTimer = 0;
const DBG_INTERVAL = 0.1; // seconds — don't thrash the DOM every frame
let cloudDiagAccum = 0;

function frame(now: number) {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    world.update(rig.camera, canvas.clientHeight, dt);
    player.update(input, dt);
    world.checkActiveSystem(player.state.position);
    world.gravityAt(player.state.position, player.state.gravity);
    player.sync();
    rig.update(player.state, dt);
    sky.update(player.state.gravity, rig.camera.position, world);
  }
  if (player.state.mode !== lastMode) {
    stateLabel.textContent = player.state.mode;
    lastMode = player.state.mode;
  }

  // Debug UI refresh + diagnostic console logs at fixed cadence.
  dbgTimer += dt;
  if (dbgTimer >= DBG_INTERVAL) {
    dbgTimer = 0;
    debugUI.refresh();

    // Position / velocity finiteness — one-shot console alert if anything
    // goes bad. (Visible in the readouts panel too.)
    const pos = player.state.position;
    const vel = player.state.velocity;
    const posFinite = Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
    const velFinite = Number.isFinite(vel.x) && Number.isFinite(vel.y) && Number.isFinite(vel.z);
    if (!(posFinite && velFinite) && !warnedNonFinite) {
      warnedNonFinite = true;
      // eslint-disable-next-line no-console
      console.error("[seagull] Non-finite player state!", {
        pos: pos.toArray(),
        vel: vel.toArray(),
        forward: player.state.forward.toArray(),
        bodyRight: player.state.bodyRight.toArray(),
      });
    }

    // Log when the dominant body changes — useful for diagnosing rebases
    // and weird mode-flip behavior at frame boundaries.
    const dom = player.state.gravity.dominant;
    if (dom && lastDominantId && lastDominantId !== dom.id) {
      // eslint-disable-next-line no-console
      console.log(`[seagull] Dominant body changed: ${lastDominantId} → ${dom.id}`);
    }
    if (dom) {
      lastDominantId = dom.id;
    } else if (lastDominantId) {
      // eslint-disable-next-line no-console
      console.warn(`[seagull] Lost dominant body (was ${lastDominantId}). pos=${pos.toArray()} vel=${vel.toArray()} speed=${vel.length().toFixed(1)}m/s`);
      lastDominantId = null;
    }
  }

  // Drive the warp distortion shader from current warp factor.
  const warpNorm = Math.min(
    1,
    Math.max(0, (player.state.lastWarpFactor - 1) / Math.max(1, PLAYER.warpMaxBoost - 1)),
  );
  (warpPass.uniforms as Record<string, { value: number }>).uWarp.value = warpNorm;

  // Push live tuning values into the bloom pass + tonemap each frame.
  bloomPass.threshold = GFX.bloomThreshold;
  bloomPass.strength = GFX.bloomStrength;
  bloomPass.radius = GFX.bloomRadius;
  renderer.toneMappingExposure = GFX.exposure;

  // ── Volumetric cloud pass uniforms ────────────────────────────────────
  // rig.update() above sets position/quat but DOESN'T update matrixWorld
  // (three.js does that inside renderer.render(), which runs later) — so
  // force it here before the cloud pass reads from camera matrices.
  rig.camera.updateMatrixWorld(true);
  cloudDiagAccum += dt;
  const shouldLogCloud = cloudDiagAccum >= 1.0;
  if (shouldLogCloud) cloudDiagAccum = 0;
  {
    const star = world.star;
    const dom = player.state.gravity.dominant;
    const home = world.homePlanet;
    const target =
      dom && dom.cloudBaseAltitude !== undefined && dom.cloudColor
        ? dom
        : home && home.cloudBaseAltitude !== undefined && home.cloudColor
          ? home
          : null;

    cloudPass.setEnabled(true);
    cloudPass.setTime(performance.now() / 1000);
    cloudPass.setDebugMode(GFX.cloudDebug);
    cloudPass.setMarchSteps(GFX.cloudSteps);
    cloudPass.setCloudAltitudes(GFX.cloudInnerM, GFX.cloudOuterM);

    if (target && target.cloudColor) {
      const refBody = dom ?? target;
      const sunDir = new THREE.Vector3();
      if (star) {
        sunDir.copy(star.worldPosition).sub(refBody.worldPosition).normalize();
      } else {
        sunDir.set(0, 1, 0);
      }
      cloudPass.setParams({
        planetCenter: refBody.worldPosition,
        planetRadius: refBody.radius,
        cloudInner: GFX.cloudInnerM,
        cloudOuter: GFX.cloudOuterM,
        color: target.cloudColor,
        coverage: target.cloudCoverage ?? 0.5,
        densityMult: GFX.cloudVolMult ?? 1,
        sunDirection: sunDir,
        sunColor: new THREE.Color(1.4, 1.3, 1.15),
        ambientColor: new THREE.Color(0.25, 0.3, 0.4),
        cameraPosition: rig.camera.position,
        cameraProjectionInverse: rig.camera.projectionMatrixInverse,
        cameraMatrixWorld: rig.camera.matrixWorld,
        cameraNear: rig.camera.near,
        cameraFar: rig.camera.far,
      });
    } else {
      cloudPass.setParams({
        cameraPosition: rig.camera.position,
        cameraProjectionInverse: rig.camera.projectionMatrixInverse,
        cameraMatrixWorld: rig.camera.matrixWorld,
        cameraNear: rig.camera.near,
        cameraFar: rig.camera.far,
        densityMult: GFX.cloudVolMult ?? 1,
      });
    }

    if (shouldLogCloud) {
      const refBody = target ?? null;
      const cp = rig.camera.position;
      // eslint-disable-next-line no-console
      console.log("[cloud-pass]", {
        target: refBody?.id ?? "(none)",
        debug: GFX.cloudDebug,
        cloudInner: GFX.cloudInnerM,
        cloudOuter: GFX.cloudOuterM,
        cameraPos: [cp.x.toFixed(2), cp.y.toFixed(2), cp.z.toFixed(2)],
      });
    }
  }

  renderer.setRenderTarget(sceneTarget);
  renderer.clear();
  renderer.render(scene, rig.camera);
  renderer.setRenderTarget(null);

  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
