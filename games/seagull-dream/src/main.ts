import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { onPlatformMessage, sendToParent, type PlatformMessage } from "@shared/games-bridge";
import { createWorld, createSky } from "./world";
import { createPlayer, type Input } from "./player";
import { createCameraRig } from "./camera";
import { PLAYER, CONTROLS, SKY, GALAXY, SPEED, GFX } from "./config";
import { DEFAULT_GALAXY_PARAMS } from "./galaxy";
import { VolumetricCloudPass } from "./cloud-volume";

// ── Generation overrides from URL hash ──────────────────────────────────────
// The dev panel lets the user edit generation constants (galaxy radius,
// scene scale, materialize thresholds, arm shape, etc.) and press
// "regenerate & reload" — which writes the values to the URL hash and
// reloads the page. We parse the hash here BEFORE createWorld so the
// world is built with the overridden values. No hash → defaults.
const _hashParams = new URLSearchParams(window.location.hash.slice(1));
function _hashNumber(key: string): number | null {
  const v = _hashParams.get(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
let universeSeed = 0xCAFEBABE;
{
  const seed = _hashNumber("seed"); if (seed !== null) universeSeed = seed;
  const radius = _hashNumber("radius"); if (radius !== null) DEFAULT_GALAXY_PARAMS.radius = radius;
  const arms = _hashNumber("arms"); if (arms !== null) DEFAULT_GALAXY_PARAMS.arms = Math.max(1, Math.floor(arms));
  const armStr = _hashNumber("armstr"); if (armStr !== null) DEFAULT_GALAXY_PARAMS.armStrength = armStr;
  const ltsm = _hashNumber("ltsm"); if (ltsm !== null) GALAXY.lyToSceneMeters = ltsm;
  const mat = _hashNumber("mat"); if (mat !== null) GALAXY.materializeLy = mat;
  const demat = _hashNumber("demat"); if (demat !== null) GALAXY.dematerializeLy = demat;
}

// ── Scene setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("scene") as HTMLCanvasElement;
// Logarithmic depth buffer keeps depth precision usable across the full
// 0.1m–50,000km near/far range we span. Without it, distant geometry
// (planets at 1000s of km) jitters and Z-fights — float24 depth would only
// give ~m precision past a few thousand km. Log depth decouples near and
// far precision.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// HDR pipeline. Tonemapping rolls off bright values softly (instead of
// hard-clamping) so an HDR star can be visibly hot at the core while
// retaining detail in its corona. SRGB output gives us correct
// gamma-corrected display; without it, MeshStandardMaterial surfaces
// look noticeably dim because the linear-light intermediate buffer
// gets sent to the screen as if it were already sRGB.
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = GFX.exposure;

const scene = new THREE.Scene();
const sky = createSky(scene);
const world = createWorld(scene, { seed: universeSeed });

const rig = createCameraRig();
const player = createPlayer(world, scene);

// Apply the floating-origin rebase BEFORE the first render. The player
// spawns at the home planet's scene-local position (which may be
// 10^11 m from scene origin at real-scale orbital distances); without
// this initial rebase, the very first frame would upload float32
// model-view matrices with ~18 km ULP at the camera and produce visible
// jitter / hyperspeed-looking artifacts. After this call, the player is
// at scene origin (0,0,0) and every body is at a small offset relative
// to them — same state as any subsequent frame.
world.checkActiveSystem(player.state.position);
world.gravityAt(player.state.position, player.state.gravity);
player.sync();

// ── Post-process pipeline ───────────────────────────────────────────────────
// HalfFloat render target so values >1 (bright star cores, lit-side
// halo boosts) survive the RenderPass into bloom. With the default
// UnsignedByte target these get hard-clipped to 1.0 and bloom never
// sees anything bright enough to glow.
// Private scene target (HalfFloat HDR + depth texture). We render the
// scene to THIS target ourselves each frame instead of using RenderPass
// in the composer. RenderPass writes to the composer's swap-chain
// buffers, which alternate between renderTarget1/2 across frames — and
// a depth texture attached to one of them creates a feedback loop the
// moment the cloud pass ends up writing to the same buffer whose depth
// it's reading from. Owning our own scene target keeps the depth
// reference stable.
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

// Volumetric clouds — full-screen ray-march post-process. Reads scene
// color + depth from the fixed sceneTarget (not the composer's swap
// chain) and writes the composited result into the composer pipeline.
// Because it's the FIRST pass in the composer, its output becomes the
// input to the subsequent BloomPass.
const cloudPass = new VolumetricCloudPass();
cloudPass.setSceneTarget(sceneTarget);
composer.addPass(cloudPass);

// Bloom — gives bright stars and lit planets a glow. The active star
// (HDR-boosted to ~4× nominal in its MeshBasicMaterial color) reaches
// well above threshold so its corona reads strongly even when it
// covers most of the screen. Background starfield pinpricks bloom
// softly. Threshold high enough to keep lit terrain from glowing.
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
      // Radial stretch — quadratic in dist so the centre is crisp.
      // Number of samples kept low so the cost is reasonable.
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

// Final HDR → sRGB conversion + tonemapping. Without this pass, the
// HDR HalfFloat buffer would be sent to the screen as linear values,
// which display as much darker than intended (and the bright bloom
// halos would clip rather than roll off).
composer.addPass(new OutputPass());

// ── Input ───────────────────────────────────────────────────────────────────
// Mouse is the *only* input. We track normalized position (0..1) in the canvas
// rect. Eyegaze platform messages will overwrite the same values via the
// `gaze` bridge message.

const input: Input = { mouseX: 0.5, mouseY: 0.5 };
const crosshair = document.getElementById("crosshair")!;

const moveCrosshair = () => {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const x = input.mouseX * w;
  const y = input.mouseY * h;
  // Translate by the delta from screen-center (where CSS positions it).
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

// ── Bridge ──────────────────────────────────────────────────────────────────
let paused = false;
onPlatformMessage((msg: PlatformMessage) => {
  if (msg.type === "gaze" && msg.mode !== "off") {
    // Bridge gives iframe-local pixel coords.
    input.mouseX = THREE.MathUtils.clamp(msg.x / canvas.clientWidth, 0, 1);
    input.mouseY = THREE.MathUtils.clamp(msg.y / canvas.clientHeight, 0, 1);
    moveCrosshair();
  } else if (msg.type === "pause") {
    paused = true;
  } else if (msg.type === "resume") {
    paused = false;
  } else if (msg.type === "request_close") {
    sendToParent({ type: "session_end", reason: "quit" });
  }
});

sendToParent({ type: "ready", gameId: "seagull-dream", version: "0.1.0" });

// ── HUD ─────────────────────────────────────────────────────────────────────
const stateLabel = document.getElementById("state-label")!;
const dbgSpeed = document.getElementById("dbg-speed")!;
const dbgVelocity = document.getElementById("dbg-velocity")!;
const dbgWarp = document.getElementById("dbg-warp")!;
const dbgAltitude = document.getElementById("dbg-altitude")!;
const dbgDist = document.getElementById("dbg-dist")!;
const dbgGround = document.getElementById("dbg-ground")!;
const dbgSurface = document.getElementById("dbg-surface")!;
const dbgInfluence = document.getElementById("dbg-influence")!;
const dbgDominant = document.getElementById("dbg-dominant")!;
const dbgFinite = document.getElementById("dbg-finite")!;
let lastMode = "";
// Track dominant-body transitions so we can log the moment one happens.
let lastDominantId: string | null = null;
let warnedNonFinite = false;

const _surfacePt = new THREE.Vector3();
const _dirToCenter = new THREE.Vector3();
const _displayVel = new THREE.Vector3();

// Format a number with a unit, switching to km when ≥ 1000 m.
function fmtMeters(m: number): string {
  if (!Number.isFinite(m)) return "—";
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
}
function fmtSpeed(mps: number): string {
  if (Math.abs(mps) >= 1000) return `${(mps / 1000).toFixed(2)} km/s`;
  return `${mps.toFixed(1)} m/s`;
}

let dbgTimer = 0;
const DBG_INTERVAL = 0.1; // seconds — don't thrash the DOM every frame

// ── Tuning sliders (mutate PLAYER config live) ──────────────────────────────
// `const` only freezes the variable binding; property writes are fine, and
// every use-site reads the field per frame so changes take effect immediately.
function bindSlider(
  id: string,
  target: Record<string, number>,
  key: string,
  format: (v: number) => string = (v) => v.toFixed(1),
): void {
  const slider = document.getElementById(id) as HTMLInputElement;
  const valSpan = document.getElementById(id + "-v");
  if (!slider || !valSpan) return;
  slider.value = String(target[key]);
  valSpan.textContent = format(target[key]);
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    target[key] = v;
    valSpan.textContent = format(v);
  });
}
const fmtInt = (v: number) => v.toFixed(0);
const fmtBoost = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k×` : `${v.toFixed(0)}×`);
bindSlider("t-flyspeed", PLAYER as unknown as Record<string, number>, "flySpeed", fmtInt);
bindSlider("t-walkspeed", PLAYER as unknown as Record<string, number>, "walkSpeedMax", (v) => v.toFixed(1));
bindSlider("t-warpboost", PLAYER as unknown as Record<string, number>, "warpMaxBoost", fmtBoost);
bindSlider("t-spacethrust", PLAYER as unknown as Record<string, number>, "spaceThrust", fmtInt);
bindSlider("t-atmdrag", PLAYER as unknown as Record<string, number>, "atmosphericDragRate", (v) => v.toFixed(1));
bindSlider("t-gravalign", CONTROLS as unknown as Record<string, number>, "gravityAlignRate", (v) => v.toFixed(2));
bindSlider("t-pitchrate", PLAYER as unknown as Record<string, number>, "flyPitchRate", (v) => v.toFixed(2));
bindSlider("t-yawrate", PLAYER as unknown as Record<string, number>, "flyYawRate", (v) => v.toFixed(2));
bindSlider("t-spacedrag", PLAYER as unknown as Record<string, number>, "spaceDragRate", (v) => v.toFixed(2));
bindSlider("t-atmstart", SKY as unknown as Record<string, number>, "atmosphereStart", fmtInt);
bindSlider("t-spacealt", SKY as unknown as Record<string, number>, "spaceAltitude", fmtInt);
bindSlider("t-warpgrav", PLAYER as unknown as Record<string, number>, "warpGravityMultiplier", (v) => `${v.toFixed(2)}×`);
bindSlider("t-warpfriction", PLAYER as unknown as Record<string, number>, "warpFrictionRate", (v) => v.toFixed(1));
bindSlider("t-warpovershoot", PLAYER as unknown as Record<string, number>, "warpOvershootDrag", (v) => v.toFixed(1));
bindSlider("t-warpbleed", PLAYER as unknown as Record<string, number>, "warpAtmosphereTransferRate", (v) => v.toFixed(2));
bindSlider("t-flythrust", PLAYER as unknown as Record<string, number>, "flyThrust", (v) => v.toFixed(1));
bindSlider("t-flydrag", PLAYER as unknown as Record<string, number>, "flyDrag", (v) => v.toFixed(3));
bindSlider("t-clusterglow", GALAXY as unknown as Record<string, number>, "aggregateBrightness", (v) => v.toFixed(3));
bindSlider("t-clusterscale", GALAXY as unknown as Record<string, number>, "aggregateIntrinsicScale", (v) => v.toExponential(1));
// Three-mode speed constants — see seagull-dream-improvements.md. These
// are the primary tuning knobs for the wing/rocket/warp blend.
const speedRec = SPEED as unknown as Record<string, number>;
const fmtSpeedV = (v: number): string =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)} Gm/s`
    : v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mm/s`
    : v >= 1e3 ? `${(v / 1e3).toFixed(2)} km/s`
    : `${v.toFixed(0)} m/s`;
bindSlider("t-vwing", speedRec, "V_WING_UP", fmtSpeedV);
bindSlider("t-vrocket", speedRec, "V_ROCKET_MAX", fmtSpeedV);
bindSlider("t-vwarp", speedRec, "V_WARP_BASE", fmtSpeedV);
bindSlider("t-sigma", speedRec, "V_WING_DOWN", fmtSpeedV);
bindSlider("t-warppow", speedRec, "WARP_POWER", (v) => v.toFixed(2));
bindSlider("t-warpmult", speedRec, "WARP_MULT", (v) => v.toFixed(2));
bindSlider("t-warpgate", speedRec, "WARP_GATE_POWER", (v) => v.toFixed(1));
bindSlider("t-blend", speedRec, "BLEND_POWER", (v) => v.toFixed(1));

// Render-tuning sliders bound to GFX (config.ts). All read per-frame.
const gfxRec = GFX as unknown as Record<string, number>;
bindSlider("t-bloomthr", gfxRec, "bloomThreshold", (v) => v.toFixed(2));
bindSlider("t-bloomstr", gfxRec, "bloomStrength", (v) => v.toFixed(2));
bindSlider("t-exposure", gfxRec, "exposure", (v) => v.toFixed(2));
bindSlider("t-cloudvolmult", gfxRec, "cloudVolMult", (v) => `${v.toFixed(2)}×`);
bindSlider("t-clouddebug", gfxRec, "cloudDebug", (v) => {
  const labels = ["normal", "no-depth", "shell mask", "density", "constant"];
  return labels[Math.max(0, Math.min(4, Math.floor(v)))];
});
bindSlider("t-cloudsteps", gfxRec, "cloudSteps", (v) => v.toFixed(0));
bindSlider("t-cloudinner", gfxRec, "cloudInnerM", (v) => `${v.toFixed(0)} m`);
bindSlider("t-cloudouter", gfxRec, "cloudOuterM", (v) => `${v.toFixed(0)} m`);

// ── Generation panel ────────────────────────────────────────────────────────
// Fields for the generation constants used by the universe + galactic
// frame. Editing a value here updates only the input; pressing the
// "regenerate & reload" button serializes the current values into the
// URL hash and reloads the page — generation happens fresh against
// the overridden constants in the new page load.
function _bindGenInput(id: string, currentValue: number): HTMLInputElement | null {
  const inp = document.getElementById(id) as HTMLInputElement | null;
  if (inp) inp.value = String(currentValue);
  return inp;
}
const gSeed = _bindGenInput("g-seed", universeSeed);
const gRadius = _bindGenInput("g-galradius", DEFAULT_GALAXY_PARAMS.radius);
const gArms = _bindGenInput("g-arms", DEFAULT_GALAXY_PARAMS.arms);
const gArmStr = _bindGenInput("g-armstr", DEFAULT_GALAXY_PARAMS.armStrength);
const gLtsm = _bindGenInput("g-ltsm", GALAXY.lyToSceneMeters);
const gMat = _bindGenInput("g-matly", GALAXY.materializeLy);
const gDemat = _bindGenInput("g-dematly", GALAXY.dematerializeLy);

const regenBtn = document.getElementById("g-regen") as HTMLButtonElement | null;
if (regenBtn) {
  regenBtn.addEventListener("click", () => {
    const params = new URLSearchParams();
    if (gSeed) params.set("seed", gSeed.value);
    if (gRadius) params.set("radius", gRadius.value);
    if (gArms) params.set("arms", gArms.value);
    if (gArmStr) params.set("armstr", gArmStr.value);
    if (gLtsm) params.set("ltsm", gLtsm.value);
    if (gMat) params.set("mat", gMat.value);
    if (gDemat) params.set("demat", gDemat.value);
    window.location.hash = params.toString();
    window.location.reload();
  });
}

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
// Throttle for periodic cloud-pass diagnostic logging.
let cloudDiagAccum = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    // World first — advances planet rotation. Player then applies the same
    // rotation delta to itself if it's attached to a planet, so it stays
    // glued to the surface (or carried along by the atmosphere). The
    // camera reads from the up-to-date player state at the end.
    world.update(rig.camera, canvas.clientHeight, dt);
    player.update(input, dt);
    // After player physics, check whether the player has moved into a
    // different star's domain. checkActiveSystem may rebase the scene
    // (mutating state.position by subtracting the delta), so do this
    // BEFORE rig.update and sky.update — both of which read positions
    // that the rebase will have shifted. If a rebase happened,
    // player.state.gravity still points to a body from the disposed
    // system; re-query it against the new bodies so the sky reads
    // a fresh dominant for its sun-direction / sky-tint math.
    world.checkActiveSystem(player.state.position);
    world.gravityAt(player.state.position, player.state.gravity);
    // Re-sync the bird mesh AFTER the floating-origin rebase.
    // `player.update` doesn't write to `object.position` any more;
    // doing it here ensures the bird tracks `state.position` even
    // when the world has reset it to 0 by floating-origin.
    player.sync();
    rig.update(player.state, dt);
    sky.update(player.state.gravity, rig.camera.position, world);
  }
  if (player.state.mode !== lastMode) {
    stateLabel.textContent = player.state.mode;
    lastMode = player.state.mode;
  }

  // Debug HUD — refresh every DBG_INTERVAL seconds so we don't churn the DOM.
  dbgTimer += dt;
  if (dbgTimer >= DBG_INTERVAL) {
    dbgTimer = 0;
    const ctx = player.state.gravity;
    const pos = player.state.position;

    // Effective speed: in flight, base × warp. In walk, walkSpeed.
    const baseSpeed = player.state.mode === "walking" ? player.state.walkSpeed : PLAYER.flySpeed;
    const warp = player.state.lastWarpFactor;
    const effSpeed = player.state.mode === "walking" ? Math.abs(baseSpeed) : Math.abs(baseSpeed) * warp;
    dbgSpeed.textContent = fmtSpeed(effSpeed);
    dbgWarp.textContent = warp >= 1.05 ? `${warp.toFixed(1)}×` : "—";

    // Velocity in the DOMINANT BODY's translational frame, not world.
    // World-frame velocity includes the planet's orbital motion (~km/s
    // at our scales), which makes the readout dominated by something
    // the player doesn't experience. Subtracting body.velocity gives
    // velocity as the player feels it: how fast they're moving relative
    // to their current "system."
    _displayVel.copy(player.state.velocity);
    if (ctx.dominant) _displayVel.sub(ctx.dominant.velocity);
    dbgVelocity.textContent = fmtSpeed(_displayVel.length());

    // NaN / Infinity check on position and velocity. If anything's gone bad
    // we want to know IMMEDIATELY, with a console message that tells us
    // which fields are bad and what the last sane values were.
    const posFinite =
      Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
    const velFinite =
      Number.isFinite(player.state.velocity.x) &&
      Number.isFinite(player.state.velocity.y) &&
      Number.isFinite(player.state.velocity.z);
    const finite = posFinite && velFinite;
    dbgFinite.textContent = finite ? "ok" : `BAD (pos:${posFinite} vel:${velFinite})`;
    if (!finite && !warnedNonFinite) {
      warnedNonFinite = true;
      // eslint-disable-next-line no-console
      console.error("[seagull] Non-finite player state!", {
        pos: pos.toArray(),
        vel: player.state.velocity.toArray(),
        forward: player.state.forward.toArray(),
        bodyRight: player.state.bodyRight.toArray(),
      });
    }

    if (ctx.dominant) {
      const body = ctx.dominant;
      _dirToCenter.copy(pos).sub(body.worldPosition);
      const distToCenter = _dirToCenter.length();

      dbgAltitude.textContent = fmtMeters(ctx.altitude);
      dbgDist.textContent = fmtMeters(distToCenter);
      dbgDominant.textContent = `${body.type} ${body.id.slice(-6)}`;
      // Only walkable bodies expose heightAt / surfaceAt.
      if (body.walkable && body.heightAt && body.surfaceAt) {
        const groundHeight = body.heightAt(_dirToCenter.clone().normalize());
        body.surfaceAt(pos, _surfacePt);
        dbgGround.textContent = fmtMeters(groundHeight);
        dbgSurface.textContent = `${_surfacePt.x.toFixed(0)}, ${_surfacePt.y.toFixed(0)}, ${_surfacePt.z.toFixed(0)}`;
      } else {
        dbgGround.textContent = `(${body.type})`;
        dbgSurface.textContent = "—";
      }
      dbgInfluence.textContent = ctx.influence.toFixed(3);

      if (lastDominantId && lastDominantId !== body.id) {
        // eslint-disable-next-line no-console
        console.log(`[seagull] Dominant body changed: ${lastDominantId} → ${body.id}`);
      }
      lastDominantId = body.id;
    } else {
      dbgAltitude.textContent = "(deep space)";
      dbgDist.textContent = "—";
      dbgGround.textContent = "—";
      dbgSurface.textContent = "—";
      dbgInfluence.textContent = "0.000";
      dbgDominant.textContent = "—";

      if (lastDominantId) {
        // eslint-disable-next-line no-console
        console.warn(`[seagull] Lost dominant body (was ${lastDominantId}). pos=${pos.toArray()} vel=${player.state.velocity.toArray()} speed=${player.state.velocity.length().toFixed(1)}m/s`);
        lastDominantId = null;
      }
    }
  }

  // Drive the warp distortion shader from current warp factor. Normalize
  // to [0,1] so the shader's strength constant is the dominant tunable
  // — at maximum-warp the radial-blur is maxed; at no-warp the shader
  // is a no-op (samples collapse to the source pixel).
  const warpNorm = Math.min(
    1,
    Math.max(0, (player.state.lastWarpFactor - 1) / Math.max(1, PLAYER.warpMaxBoost - 1)),
  );
  (warpPass.uniforms as Record<string, { value: number }>).uWarp.value = warpNorm;

  // Push tuning values into the bloom pass each frame so the sliders
  // take effect live without a reload. UnrealBloomPass exposes these
  // as direct properties.
  bloomPass.threshold = GFX.bloomThreshold;
  bloomPass.strength = GFX.bloomStrength;
  bloomPass.radius = GFX.bloomRadius;
  // Tone-mapping exposure — live tunable too.
  renderer.toneMappingExposure = GFX.exposure;

  // ── Volumetric cloud pass uniforms ────────────────────────────────────
  // Cloud pass is ALWAYS enabled so debug modes can iterate even when
  // the dominant body has no cloud config. When there's a cloud-bearing
  // body in gravity context, use its parameters; otherwise fall back
  // to the home planet (Earth) so geometry/shell math still works.
  //
  // IMPORTANT: rig.update() above sets position/quat but DOESN'T update
  // matrixWorld. Three.js updates matrixWorld inside renderer.render() —
  // which runs LATER in this frame. Without an explicit update here,
  // the cloud pass reads the previous frame's matrixWorld (or identity
  // on the first frame). That makes computeViewRay produce the same
  // direction for every pixel, shell intersection never hits anything
  // meaningful, and clouds are invisible.
  rig.camera.updateMatrixWorld(true);
  cloudDiagAccum += dt;
  const shouldLogCloud = cloudDiagAccum >= 1.0;
  if (shouldLogCloud) cloudDiagAccum = 0;
  {
    const star = world.star;
    const dom = player.state.gravity.dominant;
    const home = world.homePlanet;
    // Prefer the dominant body if it has clouds; else fall back to home.
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
      // No cloud body anywhere — just keep camera matrices fresh so
      // debug mode 2 (shell mask) can still test geometry with the
      // fallback planet center = origin.
      cloudPass.setParams({
        cameraPosition: rig.camera.position,
        cameraProjectionInverse: rig.camera.projectionMatrixInverse,
        cameraMatrixWorld: rig.camera.matrixWorld,
        cameraNear: rig.camera.near,
        cameraFar: rig.camera.far,
        densityMult: GFX.cloudVolMult ?? 1,
      });
    }

    // Periodic diagnostic dump.
    if (shouldLogCloud) {
      const refBody = target ?? null;
      const cp = rig.camera.position;
      const pi = rig.camera.projectionMatrixInverse.elements;
      const mw = rig.camera.matrixWorld.elements;
      // eslint-disable-next-line no-console
      console.log("[cloud-pass matrices]", {
        cameraPos: [cp.x.toFixed(2), cp.y.toFixed(2), cp.z.toFixed(2)],
        cameraQuat: [
          rig.camera.quaternion.x.toFixed(3),
          rig.camera.quaternion.y.toFixed(3),
          rig.camera.quaternion.z.toFixed(3),
          rig.camera.quaternion.w.toFixed(3),
        ],
        projectionInverse: [
          [pi[0].toFixed(3), pi[4].toFixed(3), pi[8].toFixed(3), pi[12].toFixed(3)],
          [pi[1].toFixed(3), pi[5].toFixed(3), pi[9].toFixed(3), pi[13].toFixed(3)],
          [pi[2].toFixed(3), pi[6].toFixed(3), pi[10].toFixed(3), pi[14].toFixed(3)],
          [pi[3].toFixed(3), pi[7].toFixed(3), pi[11].toFixed(3), pi[15].toFixed(3)],
        ],
        matrixWorld: [
          [mw[0].toFixed(3), mw[4].toFixed(3), mw[8].toFixed(3), mw[12].toFixed(3)],
          [mw[1].toFixed(3), mw[5].toFixed(3), mw[9].toFixed(3), mw[13].toFixed(3)],
          [mw[2].toFixed(3), mw[6].toFixed(3), mw[10].toFixed(3), mw[14].toFixed(3)],
          [mw[3].toFixed(3), mw[7].toFixed(3), mw[11].toFixed(3), mw[15].toFixed(3)],
        ],
      });
      // eslint-disable-next-line no-console
      console.log("[cloud-pass]", {
        target: refBody?.id ?? "(none)",
        debug: GFX.cloudDebug,
        cloudInner: GFX.cloudInnerM,
        cloudOuter: GFX.cloudOuterM,
        planetCenter: refBody?.worldPosition
          ? [refBody.worldPosition.x.toFixed(0), refBody.worldPosition.y.toFixed(0), refBody.worldPosition.z.toFixed(0)]
          : null,
      });
    }
  }

  // Render the scene to our private sceneTarget first (with depth
  // texture). The composer's first pass (VolumetricCloudPass) reads
  // from this fixed target instead of from the composer's swap chain.
  renderer.setRenderTarget(sceneTarget);
  renderer.clear();
  renderer.render(scene, rig.camera);
  renderer.setRenderTarget(null);

  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
