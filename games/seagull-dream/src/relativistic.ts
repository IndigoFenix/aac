// ── Relativistic camera effects (NOT CURRENTLY WIRED IN) ─────────────────────
//
// Reference implementation of the three light-side effects from
// instructions/relativistic.md — aberration, Doppler shift, and beaming —
// entirely on the GPU. This module is intentionally STANDALONE: nothing in the
// game imports it right now. It was removed from the render path because, at the
// celerities needed to cross interstellar distances in a playable timeframe
// (γ ~ 1e7), real aberration compresses essentially the whole sky into a
// sub-pixel forward point — physically correct but visually unusable. See the
// note at the bottom of instructions/relativistic.md / the project history.
//
// Kept here so a future update/branch can revive it. To re-enable, drive a
// VISUAL celerity decoupled from the real one (e.g. log-compressed and capped at
// u_vis ≈ 5–10) so the streaming stays legible, then re-wire the integration
// points that were reverted:
//   • world.ts galaxy ShaderMaterial — inject REL_GLSL into the vertex shader,
//     aberrate the view-space position, call assignRelUniforms(mat.uniforms).
//   • celestial-body.ts — call patchBodyShader(shader) at the end of each
//     onBeforeCompile.
//   • main.ts — call updateRelativistic(player.state, rig.camera) per frame.
//   • (optional) a per-vertex blackbody `temp` attribute on the starfield for
//     the physical Doppler recolor — see git history for the projectGalaxy
//     plumbing.
//
// Everything is driven by ONE shared uniform block (relUniforms): each material
// points its uniform entries at these exact objects by reference, so a single
// per-frame updateRelativistic() call propagates everywhere.

import * as THREE from "three";

/** Tunables for the effect. Inlined here (rather than in config.ts) so this
 *  module stays self-contained while it's unused. */
const REL = {
  masterStrength: 1.0,
  /** Celerity (units of c) where the effect starts / reaches full strength. A
   *  future revive should feed these a COMPRESSED visual celerity, not raw u. */
  fadeStartU: 0.05,
  fadeFullU: 2.0,
  /** Geometric aberration weight (0 = none, 1 = full direction remap). */
  aberration: 1.0,
  /** Flat, always-on starfield brightness multiplier (visibility aid). */
  starBoost: 1.5,
  /** Stylized Doppler hue-shift gain (used by relColorShift). */
  colorGain: 0.6,
  /** Beaming surplus over the exact D^-2 conservation baseline (0 = conserved). */
  beam: 0.0,
  /** log2 clamp on the beaming surplus only. */
  beamClamp: 6.0,
  /** Per-sprite Reinhard brightness ceiling. */
  starCeil: 2.5,
};

/** Speed of light, m/s. Celerity is expressed in the same m/s units as the
 *  player's velocity, so u = w / C directly. */
export const C = 299_792_458;

// ── Shared uniform block ─────────────────────────────────────────────────────
export const relUniforms = {
  /** Apparent direction of motion in VIEW space (camera at origin, −Z forward). */
  uVelView: { value: new THREE.Vector3(0, 0, -1) },
  /** u = w / C (celerity in units of c). γ and β are derived in-shader. */
  uU: { value: 0 },
  /** Flat, always-on brightness multiplier on the starfield so the stars read
   *  more easily in general. NOT speed-dependent — purely a visibility aid. */
  uStarBoost: { value: 1.5 },
  /** Master 0→1 fade so the whole look eases in with speed (and can be killed). */
  uStrength: { value: 0 },
  /** Geometric-aberration weight (0 = no warp tunnel, 1 = full remap). */
  uAberration: { value: 1 },
  /** Doppler hue-shift aggressiveness (stylized RGB approximation). */
  uColorGain: { value: 0.6 },
  /** Beaming exponent. Physical surface brightness ∝ D⁴. */
  uBeam: { value: 4 },
  /** log2 clamp on the BEAMING SURPLUS only (uBeam term). The conservation
   *  baseline is never clamped, so visibility stays conserved at all speeds. */
  uBeamClamp: { value: 6 },
  /** Per-sprite brightness ceiling (Reinhard rolloff). Keeps any single star
   *  from blasting far past the bloom threshold and flooding the screen. */
  uStarCeil: { value: 2.5 },
};

type RelUniformName = keyof typeof relUniforms;
const REL_UNIFORM_NAMES = Object.keys(relUniforms) as RelUniformName[];

// ── Shared GLSL (uniforms + helper functions), valid in both stages ──────────
// NOTE: this declares the uniforms, so any ShaderMaterial that injects it must
// also point its `uniforms` entries at relUniforms (see assignRelUniforms).
export const REL_GLSL = /* glsl */ `
uniform vec3  uVelView;
uniform float uU;
uniform float uStarBoost;
uniform float uStrength;
uniform float uAberration;
uniform float uColorGain;
uniform float uBeam;
uniform float uBeamClamp;
uniform float uStarCeil;

void relParams(out float gamma, out float beta) {
  float u = uU;
  gamma = sqrt(1.0 + u * u);     // = time-dilation multiplier
  beta  = u / gamma;             // = u / sqrt(1+u^2), asymptotes to 1
}

// Remap a VIEW-space position by relativistic aberration. Objects carry their
// TRUE direction, so we use the forward map (+β): true → apparent (the inverse
// of relativistic.md's camera-ray formula, which goes apparent → true).
// Distance is preserved — light-travel delay is ignored, so no LOS contraction.
vec3 relAberrate(vec3 viewPos) {
  float r = length(viewPos);
  if (r < 1e-6 || uStrength <= 0.0) return viewPos;
  float gamma, beta; relParams(gamma, beta);
  vec3 dir = viewPos / r;
  vec3 v = uVelView;
  float cosT = clamp(dot(dir, v), -1.0, 1.0);
  float cosA = clamp((cosT + beta) / (1.0 + beta * cosT), -1.0, 1.0);
  vec3 perp = dir - cosT * v;
  float pl = length(perp);
  vec3 newDir;
  if (pl < 1e-6) {
    newDir = (cosT >= 0.0) ? v : -v;     // on the motion axis — stays on it
  } else {
    perp /= pl;
    float sinA = sqrt(max(0.0, 1.0 - cosA * cosA));
    newDir = cosA * v + sinA * perp;
  }
  newDir = normalize(mix(dir, newDir, clamp(uStrength * uAberration, 0.0, 1.0)));
  return newDir * r;
}

// Doppler factor D for an already-aberrated (apparent) view direction.
// D = γ(1 + β·cosθ_apparent);  >1 forward (blueshift), <1 rear (redshift).
float relDoppler(vec3 apparentViewDir) {
  float gamma, beta; relParams(gamma, beta);
  float cosT = clamp(dot(normalize(apparentViewDir), uVelView), -1.0, 1.0);
  return gamma * (1.0 + beta * cosT);
}

// Stylized RGB Doppler tint. (Physical upgrade per relativistic.md: carry a
// per-vertex blackbody temperature and recolor blackbody(T·D) instead of
// shifting a baked RGB — the temperature multiply is the clean version.)
vec3 relColorShift(vec3 c, float D) {
  float lg = clamp(log2(max(D, 1e-6)) * uColorGain, -1.0, 1.0);
  vec3 shifted;
  if (lg >= 0.0) {
    // blueshift → pull toward blue-white, lift toward violet at the extreme
    vec3 blue = c * vec3(0.55, 0.75, 1.0) + vec3(0.10, 0.05, 0.30) * lg;
    shifted = mix(c, blue, lg);
  } else {
    // redshift → pull toward deep red, fading the far rear toward black
    shifted = mix(c, c * vec3(1.0, 0.35, 0.12), -lg);
  }
  return mix(c, shifted, clamp(uStrength, 0.0, 1.0));
}

// Normalized blackbody RGB for a temperature in Kelvin (Tanner-Helland fit) —
// mirrors colorFromTeff() in stellar.ts so rest-frame star colors are identical.
// Used by the starfield for the *physical* Doppler recolor: a Doppler shift of
// a blackbody is just a temperature multiply (T_obs = T_emit · D), so shifting
// blackbody(teff·D) is correct rather than nudging a baked RGB.
vec3 relBlackbody(float teff) {
  if (teff <= 0.0) return vec3(0.0);
  float T = clamp(teff, 1000.0, 40000.0) / 100.0;
  float r = (T <= 66.0) ? 255.0 : 329.698727446 * pow(T - 60.0, -0.1332047592);
  float g = (T <= 66.0)
    ? (99.4708025861 * log(T) - 161.1195681661)
    : (288.1221695283 * pow(T - 60.0, -0.0755148492));
  float b = (T >= 66.0)
    ? 255.0
    : (T <= 19.0 ? 0.0 : 138.5177312231 * log(T - 10.0) - 305.0447927307);
  return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
}

// Per-star brightness on the Doppler factor D, faded by the master strength so
// it's an exact identity at rest.
//   • Conservation baseline D^(−2): the EXACT aberration solid-angle Jacobian,
//     left UNCLAMPED so visibility is conserved at every speed — forward stars
//     dim exactly as fast as aberration crams them, rear stars brighten exactly
//     as they spread. This is a power law, so it never "runs out" the way the
//     old clamped term did. uBeam = 0 ⇒ perfectly flat, speed-invariant field.
//   • uBeam adds beaming brightness back on top (forward brighter / rear dimmer),
//     and ONLY this surplus is clamped (uBeamClamp) so it can't blow out.
float relBeam(float D) {
  float lD = log2(max(D, 1e-6));
  float conservation = -2.0 * lD;                              // exact, unclamped
  float beaming = clamp(uBeam * lD, -uBeamClamp, uBeamClamp);  // bounded surplus
  return mix(1.0, exp2(conservation + beaming), clamp(uStrength, 0.0, 1.0));
}

// Per-channel Reinhard rolloff toward uStarCeil — soft-caps a sprite's brightness
// so the additively-blended forward core glows without flooding into pure white.
// Faded by the master strength so it's an exact identity at rest.
vec3 relToneCeil(vec3 c) {
  vec3 capped = c / (1.0 + c / max(uStarCeil, 1e-3));
  return mix(c, capped, clamp(uStrength, 0.0, 1.0));
}
`;

// View-space project_vertex that aberrates mvPosition and exports vRelView for
// the fragment stage. Mirrors three's stock <project_vertex> (r184) so batching
// / instancing keep working, then inserts the aberration before projection.
const REL_PROJECT_VERTEX = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
mvPosition.xyz = relAberrate( mvPosition.xyz );
vRelView = mvPosition.xyz;
gl_Position = projectionMatrix * mvPosition;
`;

// Fragment apply: Doppler tint + beaming, injected just before tone mapping so
// the (possibly very bright) forward beaming stays in linear HDR and feeds bloom.
const REL_FRAG_APPLY = /* glsl */ `
{
  float relD = relDoppler( vRelView );
  gl_FragColor.rgb = relColorShift( gl_FragColor.rgb, relD );
  gl_FragColor.rgb *= relBeam( relD );
}
`;

/** Point a shader's `uniforms` at the shared relativistic uniform objects. */
export function assignRelUniforms(uniforms: Record<string, THREE.IUniform>): void {
  for (const name of REL_UNIFORM_NAMES) {
    uniforms[name] = relUniforms[name];
  }
}

// three doesn't export the onBeforeCompile shader-parameter type by name across
// versions, so describe just what we touch.
interface PatchableShader {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
}

/** Inject relativistic aberration (vertex) + Doppler/beaming (fragment) into a
 *  standard-material shader. Call at the END of an existing onBeforeCompile,
 *  after any other `#include <common>` rewrites — they keep the include line so
 *  this still finds it. Safe to call on MeshStandard/MeshPhysical/MeshBasic
 *  materials, all of which use <project_vertex> and <tonemapping_fragment>. */
export function patchBodyShader(shader: PatchableShader): void {
  assignRelUniforms(shader.uniforms);
  // Position-only: aberrate the body's vertices in view space (the same warp the
  // starfield gets), leaving brightness/color to the body's own shading. The
  // Doppler/beaming fragment pass was removed — the conservation dimming made no
  // sense for finite lit surfaces and dimmed planets you fly toward.
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>\n${REL_GLSL}\nvarying vec3 vRelView;`,
    )
    .replace("#include <project_vertex>", REL_PROJECT_VERTEX);
  // Declare the (now unused) varying in the fragment stage too so it stays
  // matched across stages.
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <common>",
    `#include <common>\nvarying vec3 vRelView;`,
  );
}

// ── Per-frame uniform update ─────────────────────────────────────────────────
const _vel = new THREE.Vector3();
const _q = new THREE.Quaternion();

interface RelState {
  velocity: THREE.Vector3;
  warpVelocity: THREE.Vector3;
}

/** Refresh the shared uniforms from the player's celerity + heading. Call once
 *  per frame after the camera rig has been updated, before rendering. */
export function updateRelativistic(state: RelState, camera: THREE.Camera): void {
  // Celerity = magnitude of the combined apparent velocity; direction = its unit.
  _vel.copy(state.velocity).add(state.warpVelocity);
  const speed = _vel.length();
  const u = speed / C;
  relUniforms.uU.value = u;

  // Master fade eases the look in across u ∈ [fadeStartU, fadeFullU] (units of c).
  const span = Math.max(1e-6, REL.fadeFullU - REL.fadeStartU);
  const s = THREE.MathUtils.clamp((u - REL.fadeStartU) / span, 0, 1);
  relUniforms.uStrength.value = s * REL.masterStrength;
  relUniforms.uStarCeil.value = REL.starCeil;

  // Motion direction in view space. Use the camera's WORLD quaternion (inverted)
  // so this is robust whether or not the camera's matrices are up to date.
  if (speed > 1e-6) {
    camera.getWorldQuaternion(_q).invert();
    relUniforms.uVelView.value.copy(_vel).divideScalar(speed).applyQuaternion(_q).normalize();
  } else {
    relUniforms.uVelView.value.set(0, 0, -1);
  }

  // Push live tunables.
  relUniforms.uStarBoost.value = REL.starBoost;
  relUniforms.uAberration.value = REL.aberration;
  relUniforms.uColorGain.value = REL.colorGain;
  relUniforms.uBeam.value = REL.beam;
  relUniforms.uBeamClamp.value = REL.beamClamp;
}
