import * as THREE from "three";
import {
  buildWeatherMap,
  cloudDensityAt,
  type CloudFieldParams,
  type CloudSample,
  type CloudSampleOpts,
} from "./cloud-field";
import type { WeatherMap } from "./weather-map";
import type {
  CloudSystem,
  CloudSystemOpts,
  CloudSystemRuntimeOpts,
} from "./cloud-system";
import { GFX } from "./config"; // debug-isolation depth toggles

// ── Cloud Renderer v3, Phase 1: the DECK HEIGHTMAP ─────────────────────────
//
// See instructions/clouds-renderer-v3-plan.md. A stratus / non-overhanging
// deck is single-valued in altitude (z = h(x,y)) — the discussion's "overhang
// test" says the efficient representation is a HEIGHTMAP, not a swarm of
// squashed blobs. This renderer draws the deck as ONE displaced grid mesh:
//
//   • a regular (nu × nv) tangent grid under the camera (STATIC index buffer —
//     a deck is one sheet, its topology never changes; only vertex
//     altitude/normal/coverage are rebuilt per update)
//   • per column: a short vertical search finds the cloud TOP (the highest
//     altitude where density crosses the threshold) → the vertex altitude
//   • columns with no cloud are HOLES (coverage 0 → discarded in the shader),
//     so a broken deck reads as cloud with clear gaps, tied to the cover slider
//   • billow displaces the top for cauliflower relief, gated by coverage
//
// An overcast deck that used to cost ~10k squashed blobs is now one mesh with
// a few thousand triangles and zero overdraw. Towers are NOT this renderer's
// job — Phase 2 adds blobs on top for the multivalued (overhang) excess; here
// every column collapses to its topmost surface, so cumulus read as lumpy
// bumps (expected for the base layer alone).
//
// Reuses the surfacenets plumbing wholesale: the shipping shell for the far
// field + crossfade, the weather-map bake pacing, floating origin (mesh
// anchored at the ground point, vertices stored relative), and the cover-slider
// / fog coupling.

// The deck is a FIXED-vertex-count grid whose patch half-extent (and therefore
// grid spacing) scales with camera altitude — so it always fills the view at a
// constant CPU cost, fine near the ground and coarse from altitude (where you
// can't resolve fine detail anyway, and the shell owns the far field).
const DECK_GRID_N = 44;             // cells per side (→ 45×45 vertices, fixed)
const DECK_REACH_MIN_M = 6000;      // patch half-extent at the ground
const DECK_REACH_MAX_M = 40000;     // patch half-extent ceiling
const DECK_REACH_ALT_K = 2.5;       // half-extent grows this × altitude
const DECK_TOP_SEARCH_STEPS = 6;    // vertical samples per column for the top
const DECK_VERT_MARGIN_M = 400;     // search past the layer band so tops cap
// The deck is the THIN, single-valued BASE — not the full vertical development.
// Cap its thickness above the condensation base; columns that tower past the
// cap simply clamp here (the excess is Phase 2's blob towers). Keeping the
// surface low means it reads as a real overcast ceiling from below and a broad
// sheet from above, instead of floating at the tower tops out of frame.
const DECK_MAX_THICK_M = 1500;
// High-altitude early-out: skip the rebuild once the shell owns the far field.
// It MUST NOT fire before the shell is fully opaque overhead, or the hard cut
// leaves a hole the shell hasn't faded in to replace (a pop as you climb). The
// directly-below deck point sits ~altitude away, and the shell reaches full at
// reach·SHELL_FADE_FAR_FRAC (reach is clamped to DECK_REACH_MAX_M up high), so
// the floor is that altitude + a margin; it also scales up with the cloud top
// for giant planets whose layer is deeper than the patch.
const DECK_EARLY_OUT_TOP_MULT = 1.5;

// Billow: high-frequency world-anchored noise added to the top altitude so the
// deck isn't a smooth sheet. Gated by coverage (clear sky stays flat). Same
// noise family as surfacenets so the two renderers agree on relief scale.
const DECK_CELL_AMP_M = 350; // amplitude of the deck's cell-scale (terrain-like) lumpiness
const DECK_BILLOW_W1 = 2400;
const DECK_BILLOW_W2 = 1500;

// ── Cheap deterministic 3-D value noise (world-anchored → stable bumps) ──────
function hash31(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c000 = hash31(ix, iy, iz), c100 = hash31(ix + 1, iy, iz);
  const c010 = hash31(ix, iy + 1, iz), c110 = hash31(ix + 1, iy + 1, iz);
  const c001 = hash31(ix, iy, iz + 1), c101 = hash31(ix + 1, iy, iz + 1);
  const c011 = hash31(ix, iy + 1, iz + 1), c111 = hash31(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz; // [0,1]
}
/** Signed billow ∈ [-1,1], two octaves. */
function billow3(wx: number, wy: number, wz: number): number {
  const n1 = vnoise3(wx / DECK_BILLOW_W1, wy / DECK_BILLOW_W1, wz / DECK_BILLOW_W1);
  const n2 = vnoise3(wx / DECK_BILLOW_W2 + 11.3, wy / DECK_BILLOW_W2, wz / DECK_BILLOW_W2 + 7.1);
  return (n1 * 0.6 + n2 * 0.4 - 0.5) * 2.0;
}

// ── Bubble clusters (stratocumulus bumps) ──────────────────────────────────
// The universal cloud-surface decorator: a small cluster of intersecting opaque
// spheres at a CONSISTENT world scale + frequency, sitting on the deck surface.
// On a flat deck this reads as stratocumulus (white bump tops, off-white
// valleys); the SAME primitive will later skin large cumulus spheres as their
// surface sub-structure. World-anchored (lattice-snapped) so they don't swim;
// LOD-dropped past a render radius so distant deck is carried by the shell.
const MAX_EDGE_BLOBS = 14000;
const BUBBLE_LATTICE_M = 2000;     // SPARSE — sub-structure detail, not a covering
const BUBBLE_PER_CELL = 3;         // spheres per cluster → irregular lump
const BUBBLE_RADIUS_M = 90;        // REAL bump radius (fine sub-structure scale)
const BUBBLE_SIZE_MIN = 0.6;       // per-sphere random size (× base radius)
const BUBBLE_SIZE_MAX = 1.5;
// LOD: a bump is drawn only once it's bigger than this on screen. Below it the
// bump would be sub-pixel, so culling it is imperceptible (NO shrink — real size
// always). The lattice walk is bounded to where the biggest bump goes sub-pixel
// so the walk-edge cull and the per-bump cull coincide (no pop), capped for cost.
const BUBBLE_MIN_PX = 1.2;
const BUBBLE_WALK_MAX_M = 40000;
const BUBBLE_JITTER_FRAC = 0.5;    // cluster spread within the cell (× lattice)
const BUBBLE_RISE_M = 40;          // mostly EMBEDDED in the surface (texture, not floating)
const EDGE_BILLOW = 0.35;          // surface billow on each sphere
// Albedo gradient — off-white at the base/undersides, white at the bump tops.
const CLOUD_BASE_ALBEDO = 0.82;

// ── Towers / cumulus clumps ────────────────────────────────────────────────
// Occasional ~6-sphere clumps that protrude from the deck (and stand alone as
// cumulus where there's no deck). Coarse lattice → sparse; gated by the field's
// convective development (cumuliformity) + a hash so not every cell towers.
// REAL size + apparent-size LOD like the bumps (invisible from orbit, appear at
// individual visibility), reusing the same instanced-sphere mesh + shader.
const TOWER_LATTICE_M = 4500;
const TOWER_SPHERES = 6;
const TOWER_RADIUS_M = 520;        // base sphere radius
const TOWER_HEIGHT_M = 1050;       // vertical extent — kept low so clumps read WIDE, not tall
const TOWER_CUM_MIN = 0.5;         // cumuliformity gate (developed cells only)
const TOWER_PROB = 0.5;            // fraction of qualifying cells that tower
const TOWER_WALK_MAX_M = 60000;    // cap on the lattice walk (cost vs pop at edge)

// TEMP toggles while the system is in flux:
const SHELL_ENABLED = false;       // shell off — "white splotches", being reworked
const BUBBLES_ENABLED = false;     // fine sub-detail bumps off — read as stray single spheres

/** Deterministic 0..1 hash of an integer key + salt (world-stable per-blob
 *  randoms — same lattice cell always gets the same jitter/size). */
function keyRand(key: number, salt: number): number {
  let h = Math.imul((key ^ salt) >>> 0, 2654435761);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const DEFAULT_MIN_DENSITY = 0.05;
const DEFAULT_BAKE_BUDGET_MS = 0.5;
const MAX_BAKE_ROWS_PER_FRAME = 16;
const TEXTURE_UPLOAD_ROW_BATCH = 32;
const DEFAULT_UPDATE_INTERVAL = 2;
const NIGHT_AMBIENT = 0.12;
const SHELL_FADE_NEAR_FRAC = 0.55;
const SHELL_FADE_FAR_FRAC = 0.95;

/** Per-update perf counters (mirrors cloudSystemStats keys the lab reads). */
export const cloudDeckStats = {
  bakeMs: 0,
  walkMs: 0,
  sortMs: 0,
  cellsIterated: 0,
  cellsPassed: 0,
  sprites: 0, // = triangle count here
  tierSprites: [0, 0, 0, 0, 0],
};

// ── Deck material — heightmap normals → banded toon, world-anchored shading ──

const DECK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute float aCoverage;
attribute vec3 aColor;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCamDist;
varying float vCoverage;
varying vec3 vColor;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vCamDist = distance(cameraPosition, wp.xyz);
  vCoverage = aCoverage;
  vColor = aColor;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const DECK_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision highp float;
uniform vec3 uSunDirW;
uniform float uHasSun;
uniform float uOpacity;
uniform vec3 uUpW;        // planet-up at the camera (day/night for the patch)
uniform float uReach;     // patch edge (m) — fade to the shell here
uniform float uNearFade;  // near-plane dissolve band (m)
uniform float uCoverThresh;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCamDist;
varying float vCoverage;
varying vec3 vColor;
float dither(vec2 fc){ return fract(sin(dot(fc, vec2(12.9898,78.233)))*43758.5453); }

void main() {
  #include <logdepthbuf_fragment>
  // Double-sided: orient the normal toward the camera (underside lit too).
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vNormal);
  if (dot(N, viewDir) < 0.0) N = -N;

  // Banded toon off the heightmap normal.
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(uUpW, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);
  // SAME albedo gradient as the bubbles (off-white base/valleys → white bump
  // tops). This is what makes the cell lumpiness read as form: the gentle
  // heightmap normals stay inside one toon band, but the smooth dot(N,up) ramp
  // shows the bulges (white) against the valleys (off-white). Keyed on planet-up.
  float topness = smoothstep(-0.4, 0.9, dot(N, uUpW));
  vec3 col = vColor * mix(${CLOUD_BASE_ALBEDO.toFixed(2)}, 1.0, topness) * lit;

  // Coverage gate → broken deck with clear gaps. OPAQUE with a hashed-alpha
  // discard (hard outlines, depth-writing) so the bubble bumps occlude
  // correctly against it — clouds from space have hard boundaries, not haze.
  float cov = smoothstep(uCoverThresh, uCoverThresh + 0.10, vCoverage);
  vec3 toFrag = vWorldPos - cameraPosition;
  float horiz = length(toFrag - uUpW * dot(toFrag, uUpW));
  float edge = 1.0 - smoothstep(uReach * 0.82, uReach, horiz);
  float near = smoothstep(0.0, uNearFade, vCamDist);
  float a = cov * edge * near * uOpacity;
  if (a < dither(gl_FragCoord.xy)) discard;

  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

// ── Edge-blob shaders (instanced icosphere skinning the mound flanks) ───────
// Shading is deliberately the SAME banded-toon ramp as the deck so the blobs
// and the hill read as one cloud (no two-tone). Opaque (depthWrite) — a sparse
// rim shell, so no sort needed.

const EDGE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 iCenter;   // planet-local meters (relative to the ground anchor)
attribute vec3 iUp;       // planet-local up at the blob
attribute vec3 iColor;
attribute float iRadius;
attribute float iSeed;
varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vUp;
float h31(vec3 p){ p = fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
uniform float uBillow;
void main() {
  vec3 dir = normalize(position);
  float n = vn(dir*2.3 + iSeed) + 0.5*vn(dir*5.1 + iSeed*1.7);
  n = (n/1.5 - 0.5);
  // REAL size (no distance shrink). FLOATING-ORIGIN PRECISION: combine model+view
  // on the CPU (modelViewMatrix) so the huge planet-scale world coordinate never
  // exists in float32 — forming it (modelMatrix*center then viewMatrix) and
  // subtracting the camera loses precision and JITTERS the whole sphere under
  // fast motion. Offset added in view space.
  vec3 localOffset = dir * iRadius * (1.0 + uBillow*n);
  vec4 mvCenter = modelViewMatrix * vec4(iCenter, 1.0);
  vec3 viewOffset = mat3(viewMatrix) * (mat3(modelMatrix) * localOffset);
  vec4 mvPosition = vec4(mvCenter.xyz + viewOffset, 1.0);
  vColor = iColor;
  vNormalW = normalize(mat3(modelMatrix) * dir);
  vUp = normalize(mat3(modelMatrix) * iUp);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const EDGE_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision highp float;
uniform vec3 uSunDirW;
uniform float uHasSun;
uniform float uOpacity;
uniform vec3 uUpW;
varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vUp;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  // Sun-driven banded toon.
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(uUpW, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);
  // Albedo gradient: off-white on undersides/sides, WHITE on the bump tops
  // (the ice-bright cumulus/anvil top look). Keyed on the sphere's own up so
  // it's world-stable, not view-dependent. Opaque — LOD is done by SHRINKING
  // in the vertex shader (no dither grain).
  float topness = smoothstep(-0.35, 0.85, dot(N, vUp));
  vec3 albedo = vColor * mix(${CLOUD_BASE_ALBEDO.toFixed(2)}, 1.0, topness);
  vec3 col = albedo * lit;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

// ── Shell shaders (copied from cloud-blobs.ts — far field + crossfade) ──────

const SHELL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCamDist;
void main() {
  vLocalPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normalize(position));
  vCamDist = distance(cameraPosition, wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform float uTime;
uniform float uEpoch;
uniform float uWindMult;
uniform float uJetSpeed;
uniform float uBandCells;
uniform float uPlanetRadius;
uniform float uLonOffset;
uniform float uCoverageMul;
uniform vec3 uZoneColor;
uniform vec3 uBeltColor;
uniform float uDetailScale;
uniform float uDetailAmp;
uniform float uSeed;
uniform vec3 uSunPosW;
uniform float uHasSun;
uniform float uReach;
uniform float uOpacity;
uniform float uLayerDensity;
uniform float uMinDensity;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCamDist;
float shellHash(vec3 p) {
  p = fract(p * 0.3183099 + uSeed * 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float shellValueNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(shellHash(i + vec3(0,0,0)), shellHash(i + vec3(1,0,0)), f.x),
        mix(shellHash(i + vec3(0,1,0)), shellHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(shellHash(i + vec3(0,0,1)), shellHash(i + vec3(1,0,1)), f.x),
        mix(shellHash(i + vec3(0,1,1)), shellHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
void main() {
  #include <logdepthbuf_fragment>
  float shellFade = smoothstep(uReach * ${SHELL_FADE_NEAR_FRAC.toFixed(2)},
    uReach * ${SHELL_FADE_FAR_FRAC.toFixed(2)}, vCamDist);
  if (shellFade < 0.01) discard;
  float r = length(vLocalPos);
  float lat = asin(clamp(vLocalPos.y / r, -1.0, 1.0));
  float lon = atan(vLocalPos.z, vLocalPos.x);
  float zonal = -uJetSpeed * sin(2.0 * uBandCells * lat);
  float drift = zonal / (uPlanetRadius * max(0.08, cos(lat)))
    * (uTime - uEpoch) * uWindMult;
  float u = (lon + uLonOffset - drift) / 6.28318530718 + 0.5;
  float v = clamp(lat / 3.14159265359 + 0.5, 0.0, 1.0);
  vec4 syn = texture2D(uMap, vec2(u, v));
  // Smooth display of the density field with fuzzy boundaries (alpha ∝ cover +
  // detail sparkle). This is the ORIGINAL shell look; do NOT threshold it into
  // hard splotches — the shell is the far/orbit view of the synoptic field.
  float cover = syn.r * uCoverageMul;
  if (cover < 0.02) discard;
  vec3 dp = vLocalPos / uDetailScale;
  float dn = shellValueNoise(dp) + 0.5 * shellValueNoise(dp * 2.07);
  dn /= 1.5;
  float detailAmp = uDetailAmp
    * (1.0 - smoothstep(uPlanetRadius * 0.5, uPlanetRadius * 1.5, vCamDist));
  float a = cover * (1.0 + detailAmp * (dn - 0.5) * 2.0) * uLayerDensity;
  a = clamp(a, 0.0, 1.0);
  if (a < 0.02) discard;
  vec3 col = mix(uBeltColor, uZoneColor, syn.b);
  col *= 1.0 - 0.35 * syn.a;
  vec3 sunDir = normalize(uSunPosW - vWorldPos);
  float d = dot(vNormalW, sunDir);
  float dayT = smoothstep(-0.12, 0.2, d);
  float litS = 0.12 + 0.88 * dayT * (0.62 + 0.38 * max(d, 0.0));
  col *= mix(1.0, litS, uHasSun);
  gl_FragColor = vec4(col, a * shellFade * uOpacity);
  #include <fog_fragment>
}
`;

// ── Scratch ────────────────────────────────────────────────────────────────

const _samplePos = new THREE.Vector3();
const _sampleOut: CloudSample = {
  density: 0, color: new THREE.Color(), layerIndex: -1, cumuliformity: 0, storm: 0,
};
const _topOut: CloudSample = {
  density: 0, color: new THREE.Color(), layerIndex: -1, cumuliformity: 0, storm: 0,
};
const _sunLocal = new THREE.Vector3();
const _sunDirW = new THREE.Vector3();
const _invParent = new THREE.Matrix4();
const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _ground = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _tmpQuat = new THREE.Quaternion();

// ── Implementation ─────────────────────────────────────────────────────────

export function createDeckCloudSystem(opts: CloudSystemOpts): CloudSystem {
  let field = opts.field;
  // In the structured renderer the deck OWNS the shared map's bake + shell; the
  // blob-tower pass reads the same map. Standalone, it builds its own.
  const usingSharedMap = opts.sharedMap !== undefined;
  let map: WeatherMap = opts.sharedMap ?? buildWeatherMap(field, opts.timeSeconds ?? 0);
  const noShell = opts.noShell === true;
  const externallyBaked = opts.externallyBaked === true;
  // "base" = thin flat base deck; "mound" = surface tracks the full cloud top
  // so it rises into hills (the tower bulk) where the column towers.
  const deckMode = opts.deckMode ?? "base";

  let minDensity = DEFAULT_MIN_DENSITY;
  let bakeBudgetMs = DEFAULT_BAKE_BUDGET_MS;
  const sampleOpts: CloudSampleOpts = { windMult: 1, vigorMult: 1, detailMult: 1 };
  let msPerRowEma = 2.0;
  let bakeDeficitMs = 0;
  let rowsSinceUpload = 0;
  let lastTimeSeconds = 0;
  let updateCounter = 0;
  let updateInterval = DEFAULT_UPDATE_INTERVAL;
  let shellDetailMult = 1;
  let opacity = 0;
  let sunWorldPos: THREE.Vector3 | null = null;
  let pixelsPerUnit = 800; // projection scale (px per world-unit at dist 1) for the bubble LOD

  // ── Heightmap grid (fixed dimensions → static index buffer). The patch
  // half-extent `reach` and grid spacing `gridM` are recomputed per frame from
  // camera altitude; the vertex COUNT never changes, so the topology is baked
  // once and cost is constant. ─────────────────────────────────────────────
  const NU = DECK_GRID_N + 1;
  const NV = NU;
  const VERT_COUNT = NU * NV;
  const QUAD_COUNT = (NU - 1) * (NV - 1);

  const positions = new Float32Array(VERT_COUNT * 3);
  const normals = new Float32Array(VERT_COUNT * 3);
  const colors = new Float32Array(VERT_COUNT * 3);
  const coverage = new Float32Array(VERT_COUNT);
  const indices = new Uint32Array(QUAD_COUNT * 6);
  // Per-column scratch (heights + validity) so normals can finite-difference.
  const colAlt = new Float32Array(VERT_COUNT);
  const colCov = new Float32Array(VERT_COUNT);
  const colAlt2 = new Float32Array(VERT_COUNT); // scratch for the hill smoothing

  // Static topology — a regular grid; only vertex data changes per frame.
  {
    let o = 0;
    for (let iv = 0; iv < NV - 1; iv++) {
      for (let iu = 0; iu < NU - 1; iu++) {
        const a = iu + iv * NU;
        const b = iu + 1 + iv * NU;
        const c = iu + 1 + (iv + 1) * NU;
        const d = iu + (iv + 1) * NU;
        indices[o++] = a; indices[o++] = b; indices[o++] = c;
        indices[o++] = a; indices[o++] = c; indices[o++] = d;
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const normAttr = new THREE.BufferAttribute(normals, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  const covAttr = new THREE.BufferAttribute(coverage, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  normAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  covAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("normal", normAttr);
  geom.setAttribute("aColor", colAttr);
  geom.setAttribute("aCoverage", covAttr);
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uHasSun: { value: 0 },
      uOpacity: { value: 0 },
      uUpW: { value: new THREE.Vector3(0, 1, 0) },
      uReach: { value: DECK_REACH_MIN_M },
      uNearFade: { value: 80 },
      uCoverThresh: { value: 0 },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    },
    vertexShader: DECK_VERT,
    fragmentShader: DECK_FRAG,
    // OPAQUE base deck (the off-white stratocumulus base/valleys) — writes depth
    // so the bubble bumps occlude correctly against it; hard outlines, no haze.
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  const deckMesh = new THREE.Mesh(geom, material);
  deckMesh.name = "cloud_deck";
  deckMesh.frustumCulled = false;
  deckMesh.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_deck_system";
  group.add(deckMesh);

  // ── Bubble clusters: instanced icospheres decorating the deck surface ──────
  const edgeEnabled = true; // stratocumulus bumps on every deck
  void deckMode;
  const eCenter = new Float32Array(MAX_EDGE_BLOBS * 3);
  const eUp = new Float32Array(MAX_EDGE_BLOBS * 3);
  const eColor = new Float32Array(MAX_EDGE_BLOBS * 3);
  const eRadius = new Float32Array(MAX_EDGE_BLOBS);
  const eSeed = new Float32Array(MAX_EDGE_BLOBS);
  let edgeMesh: THREE.Mesh | null = null;
  let edgeMaterial: THREE.ShaderMaterial | null = null;
  let edgeGeom: THREE.InstancedBufferGeometry | null = null;
  const edgeSeen = new Set<number>(); // world-lattice dedupe per rebuild
  if (edgeEnabled) {
    const ico = new THREE.IcosahedronGeometry(1, 2); // ~162 verts, rounder blobs
    edgeGeom = new THREE.InstancedBufferGeometry();
    edgeGeom.setIndex(ico.index);
    edgeGeom.setAttribute("position", ico.attributes.position);
    const mk = (arr: Float32Array, n: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage); return a;
    };
    edgeGeom.setAttribute("iCenter", mk(eCenter, 3));
    edgeGeom.setAttribute("iUp", mk(eUp, 3));
    edgeGeom.setAttribute("iColor", mk(eColor, 3));
    edgeGeom.setAttribute("iRadius", mk(eRadius, 1));
    edgeGeom.setAttribute("iSeed", mk(eSeed, 1));
    edgeGeom.instanceCount = 0;
    edgeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
        uHasSun: { value: 0 }, uOpacity: { value: 0 },
        uUpW: { value: new THREE.Vector3(0, 1, 0) },
        uBillow: { value: EDGE_BILLOW },
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      },
      vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG,
      transparent: false, depthTest: true, depthWrite: true, fog: true,
      side: THREE.DoubleSide, // flying INTO a clump shows cloud interior, not nothing
    });
    edgeMesh = new THREE.Mesh(edgeGeom, edgeMaterial);
    edgeMesh.name = "cloud_deck_edge_blobs";
    edgeMesh.frustumCulled = false;
    edgeMesh.renderOrder = 3; // over the hill mesh
    group.add(edgeMesh);
  }

  // ── Weather-map texture + shells (copied from cloud-blobs / surfacenets) ──
  let mapTexture = makeMapTexture(map);
  function makeMapTexture(m: WeatherMap): THREE.DataTexture {
    const tex = new THREE.DataTexture(
      m.data, m.width, m.height, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  interface ShellEntry { material: THREE.ShaderMaterial; mesh: THREE.Mesh; }
  let shells: ShellEntry[] = [];
  function buildShells(): void {
    for (const shell of shells) {
      group.remove(shell.mesh);
      shell.mesh.geometry.dispose();
      shell.material.dispose();
    }
    shells = [];
    const SHELL_W_SEG = 128, SHELL_H_SEG = 96;
    const segAngle = (2 * Math.PI) / SHELL_W_SEG;
    const chordSag = field.planetRadiusM * segAngle * segAngle / 8;
    for (let li = 0; li < field.layers.length; li++) {
      const layer = field.layers[li];
      const shellRadiusM = field.planetRadiusM
        + (layer.baseAltitudeM + layer.topAltitudeM) * 0.5 + chordSag * 1.3;
      const shellMat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: mapTexture },
          uTime: { value: 0 }, uEpoch: { value: 0 }, uWindMult: { value: 1 },
          uJetSpeed: { value: field.synoptic.jetSpeedMs },
          uBandCells: { value: field.synoptic.bandCells },
          uPlanetRadius: { value: field.planetRadiusM },
          uLonOffset: { value: layer.mapLonOffsetRad },
          uCoverageMul: { value: layer.coverageMul },
          uZoneColor: { value: layer.zoneColor.clone() },
          uBeltColor: { value: layer.beltColor.clone() },
          uDetailScale: { value: layer.detailScaleM * 6 },
          uDetailAmp: { value: 0.35 }, uSeed: { value: field.seed },
          uSunPosW: { value: new THREE.Vector3() }, uHasSun: { value: 0 },
          uReach: { value: DECK_REACH_MIN_M / SHELL_FADE_NEAR_FRAC },
          uOpacity: { value: opacity }, uLayerDensity: { value: layer.density },
          uMinDensity: { value: minDensity },
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        },
        vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
        transparent: true, depthTest: true, depthWrite: false,
        blending: THREE.NormalBlending, fog: true, side: THREE.DoubleSide,
      });
      const shellMesh = new THREE.Mesh(
        new THREE.SphereGeometry(shellRadiusM, SHELL_W_SEG, SHELL_H_SEG), shellMat,
      );
      shellMesh.name = `cloud_deck_shell_${li}`;
      shellMesh.frustumCulled = false;
      shellMesh.renderOrder = 1;
      group.add(shellMesh);
      shells.push({ material: shellMat, mesh: shellMesh });
    }
  }
  if (!noShell && SHELL_ENABLED) buildShells();

  // ── Bake pacing (copied) ──────────────────────────────────────────────────
  let initialSweepDone = false;
  const INITIAL_SWEEP_BUDGET_MS = 4;
  function bakeTick(timeSeconds: number): void {
    if (externallyBaked) return; // another sub-system owns the shared map's bake
    const budget = initialSweepDone ? bakeBudgetMs
      : Math.max(bakeBudgetMs, INITIAL_SWEEP_BUDGET_MS);
    if (budget <= 0) return;
    const rowCost = Math.max(0.05, msPerRowEma);
    bakeDeficitMs = Math.min(bakeDeficitMs + budget, rowCost * MAX_BAKE_ROWS_PER_FRAME);
    if (bakeDeficitMs < rowCost) return;
    const rows = Math.min(MAX_BAKE_ROWS_PER_FRAME, Math.floor(bakeDeficitMs / rowCost));
    const t0 = performance.now();
    const res = map.bake(rows, timeSeconds, sampleOpts.windMult);
    const spent = performance.now() - t0;
    bakeDeficitMs -= Math.max(spent, rows * rowCost);
    if (bakeDeficitMs < 0) bakeDeficitMs = 0;
    if (res.rows > 0) {
      msPerRowEma = msPerRowEma * 0.8 + Math.min(10, spent / res.rows) * 0.2;
      rowsSinceUpload += res.rows;
      if (res.wrapped) initialSweepDone = true;
      if (rowsSinceUpload >= TEXTURE_UPLOAD_ROW_BATCH || res.wrapped) {
        mapTexture.needsUpdate = true; rowsSinceUpload = 0;
      }
    }
  }

  function computeSunLocal(): boolean {
    if (!sunWorldPos || !group.parent) return false;
    _invParent.copy(group.parent.matrixWorld).invert();
    _sunLocal.copy(sunWorldPos).applyMatrix4(_invParent);
    if (_sunLocal.lengthSq() < 1) return false;
    _sunLocal.normalize();
    return true;
  }

  /** Find the cloud TOP altitude in one column (highest crossing of the
   *  threshold) + a coverage value. Returns true if cloud was found; fills
   *  `_topOut` with the colour at the top sample. */
  function columnTop(
    wbx: number, wby: number, wbz: number, // column base world point (at altBase)
    timeSeconds: number, altBase: number, altStep: number, footprintM: number,
    res: { alt: number; cov: number },
  ): boolean {
    // March DOWN from the top so the first crossing is the cloud top.
    let prevD = 0;
    let prevA = 0;
    let maxD = 0;
    for (let s = DECK_TOP_SEARCH_STEPS; s >= 0; s--) {
      const da = s * altStep;
      _samplePos.set(
        wbx + _up.x * da, wby + _up.y * da, wbz + _up.z * da,
      );
      cloudDensityAt(field, map, _samplePos, timeSeconds, sampleOpts, _sampleOut, footprintM, 1);
      const d = _sampleOut.density;
      if (d > maxD) { maxD = d; _topOut.color.copy(_sampleOut.color); }
      if (d >= minDensity) {
        // Crossing between this (inside) and the previous (outside, higher)
        // sample. Linear-interpolate the altitude of the threshold.
        let topAlt = altBase + da;
        if (s < DECK_TOP_SEARCH_STEPS && prevD < minDensity) {
          const t = (minDensity - prevD) / Math.max(1e-4, d - prevD);
          topAlt = altBase + prevA + (da - prevA) * t;
        }
        res.alt = topAlt;
        res.cov = Math.min(1, maxD);
        return true;
      }
      prevD = d; prevA = da;
    }
    res.alt = altBase;
    res.cov = 0;
    return false;
  }

  /** Sample the column grid around the camera and build the heightmap mesh.
   *  `reach` = patch half-extent (m), `gridM` = `2·reach/(NU-1)` grid spacing —
   *  both altitude-adaptive, computed in update(). */
  function rebuildDeck(
    cameraLocalPos: THREE.Vector3, timeSeconds: number, reach: number, gridM: number,
  ): void {
    const R = field.planetRadiusM;
    _up.copy(cameraLocalPos).normalize();
    _east.crossVectors(_yAxis, _up);
    if (_east.lengthSq() < 1e-6) _east.set(1, 0, 0); // pole guard
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
    _ground.copy(_up).multiplyScalar(R);
    deckMesh.position.copy(_ground); // floating origin

    // MAIN deck (layer 0). "base" mode caps thickness to a thin flat base; in
    // "mound" mode the surface tracks the full top so it rises into hills.
    const L0 = field.layers[0];
    const deckTopCap = deckMode === "mound"
      ? L0.topAltitudeM
      : L0.baseAltitudeM + Math.min(L0.topAltitudeM - L0.baseAltitudeM, DECK_MAX_THICK_M);
    const altBase = Math.max(0, L0.baseAltitudeM - DECK_VERT_MARGIN_M);
    const altTop = deckTopCap + DECK_VERT_MARGIN_M;
    const altStep = (altTop - altBase) / DECK_TOP_SEARCH_STEPS;
    // Deck-mid altitude — the reference height for the cell-scale lumpy surface
    // and the sub-detail bumps (both sample the same billow at this altitude).
    const smoothBase = L0.baseAltitudeM
      + Math.min(L0.topAltitudeM - L0.baseAltitudeM, DECK_MAX_THICK_M) * 0.5;

    const ex = _east.x, ey = _east.y, ez = _east.z;
    const nx = _north.x, ny = _north.y, nz = _north.z;
    const ux = _up.x, uy = _up.y, uz = _up.z;
    const gx = _ground.x, gy = _ground.y, gz = _ground.z;
    void R;
    const colRes = { alt: 0, cov: 0 };

    // ── 1. Per column: find the cloud top + coverage. Store altitude (relative
    // to the layer band) and coverage for the normal pass.
    let samples = 0;
    for (let iv = 0; iv < NV; iv++) {
      const offv = iv * gridM - reach;
      for (let iu = 0; iu < NU; iu++) {
        const ou = iu * gridM - reach;
        // Column base point at altBase (tangent offsets + radial lift).
        const wbx = gx + ex * ou + nx * offv + ux * altBase;
        const wby = gy + ey * ou + ny * offv + uy * altBase;
        const wbz = gz + ez * ou + nz * offv + uz * altBase;
        const found = columnTop(wbx, wby, wbz, timeSeconds, altBase, altStep, gridM, colRes);
        samples += DECK_TOP_SEARCH_STEPS + 1;
        const cov = colRes.cov;
        // Surface = a smooth, cell-scale LUMPY sheet (terrain-like), NOT the
        // quantized search top (which terraces into ridges). Flat base + billow
        // undulation, gated by cover. Evaluated at the deck-MID altitude so the
        // sub-detail bumps (which sample the same billow) sit on this surface.
        const wmx = gx + ex * ou + nx * offv + ux * smoothBase;
        const wmy = gy + ey * ou + ny * offv + uy * smoothBase;
        const wmz = gz + ez * ou + nz * offv + uz * smoothBase;
        const alt = smoothBase + (found ? billow3(wmx, wmy, wmz) * DECK_CELL_AMP_M * cov : 0);
        const vi = iu + iv * NU;
        colAlt[vi] = alt;
        colCov[vi] = cov;
        const c3 = vi * 3;
        colors[c3] = _topOut.color.r; colors[c3 + 1] = _topOut.color.g; colors[c3 + 2] = _topOut.color.b;
      }
    }
    cloudDeckStats.cellsIterated = samples;

    // ── 1b. Smooth the hill (mound mode). The raw per-column top terraces
    // (vertical-search quantization) and tracks every wind streak, giving harsh
    // sawtooth ridges. A couple of box-blur passes leave a SIMPLE hill; the edge
    // blobs carry the cauliflower detail on top. Coverage holes are preserved
    // (blur only where there's cloud, so gaps stay gaps).
    if (deckMode === "mound") {
      for (let pass = 0; pass < 2; pass++) {
        for (let iv = 0; iv < NV; iv++) {
          for (let iu = 0; iu < NU; iu++) {
            const vi = iu + iv * NU;
            if (colCov[vi] <= 0) { colAlt2[vi] = colAlt[vi]; continue; }
            let sum = colAlt[vi], wsum = 1;
            if (iu > 0 && colCov[vi - 1] > 0) { sum += colAlt[vi - 1]; wsum++; }
            if (iu < NU - 1 && colCov[vi + 1] > 0) { sum += colAlt[vi + 1]; wsum++; }
            if (iv > 0 && colCov[vi - NU] > 0) { sum += colAlt[vi - NU]; wsum++; }
            if (iv < NV - 1 && colCov[vi + NU] > 0) { sum += colAlt[vi + NU]; wsum++; }
            colAlt2[vi] = sum / wsum;
          }
        }
        colAlt.set(colAlt2);
      }
    }

    // ── 2. Build vertex positions (relative to the ground anchor) + heightmap
    // normals (finite difference of neighbour altitudes) + coverage attribute.
    let drawn = 0;
    for (let iv = 0; iv < NV; iv++) {
      const offv = iv * gridM - reach;
      for (let iu = 0; iu < NU; iu++) {
        const ou = iu * gridM - reach;
        const vi = iu + iv * NU;
        const alt = colAlt[vi];
        // Position relative to ground anchor: tangent offset + radial lift.
        const v3 = vi * 3;
        const px = ex * ou + nx * offv + ux * alt;
        const py = ey * ou + ny * offv + uy * alt;
        const pz = ez * ou + nz * offv + uz * alt;
        positions[v3] = px;
        positions[v3 + 1] = py;
        positions[v3 + 2] = pz;

        // Heightmap normal: n = U − (dh/du)·E − (dh/dv)·N, all in world axes.
        const iuL = iu > 0 ? vi - 1 : vi;
        const iuR = iu < NU - 1 ? vi + 1 : vi;
        const ivL = iv > 0 ? vi - NU : vi;
        const ivR = iv < NV - 1 ? vi + NU : vi;
        const spanU = (iu > 0 && iu < NU - 1) ? 2 * gridM : gridM;
        const spanV = (iv > 0 && iv < NV - 1) ? 2 * gridM : gridM;
        const dhu = (colAlt[iuR] - colAlt[iuL]) / spanU;
        const dhv = (colAlt[ivR] - colAlt[ivL]) / spanV;
        let nwx = ux - dhu * ex - dhv * nx;
        let nwy = uy - dhu * ey - dhv * ny;
        let nwz = uz - dhu * ez - dhv * nz;
        const nl = Math.sqrt(nwx * nwx + nwy * nwy + nwz * nwz);
        if (nl > 1e-9) { nwx /= nl; nwy /= nl; nwz /= nl; } else { nwx = ux; nwy = uy; nwz = uz; }
        normals[v3] = nwx; normals[v3 + 1] = nwy; normals[v3 + 2] = nwz;

        coverage[vi] = colCov[vi];
        if (colCov[vi] > 0) drawn++;
      }
    }

    // ── 3. Bubble clusters — iterate the WORLD lattice DIRECTLY (not the deck
    // grid). The deck grid is camera-relative and coarsens with altitude, so
    // piggybacking on it under-samples the lattice up high and bubbles POP in/out
    // as the grid slides. A dedicated lattice walk visits every cell in range
    // each frame → world-stable, no popping; the per-fragment LOD fade handles
    // the smooth appear/disappear at the render radius.
    let edgeCount = 0;
    edgeSeen.clear();
    if (edgeEnabled && BUBBLES_ENABLED) {
      const L = BUBBLE_LATTICE_M, invLat = 1 / L;
      const deckAlt = L0.baseAltitudeM
        + Math.min(L0.topAltitudeM - L0.baseAltitudeM, DECK_MAX_THICK_M) * 0.5;
      const cax = cameraLocalPos.x, cay = cameraLocalPos.y, caz = cameraLocalPos.z;
      // Walk out to where the BIGGEST bump goes sub-pixel (so the walk edge and
      // the per-bump apparent-size cull coincide → no pop), capped for cost.
      const maxRad = BUBBLE_RADIUS_M * BUBBLE_SIZE_MAX;
      const walkBound = Math.min(BUBBLE_WALK_MAX_M, maxRad * pixelsPerUnit / BUBBLE_MIN_PX);
      const minApparentDen = BUBBLE_MIN_PX / pixelsPerUnit; // rad/dist must exceed this
      const reachCells = Math.ceil(walkBound / L) + 1;
      const wb2 = walkBound * walkBound;
      for (let dv = -reachCells; dv <= reachCells; dv++) {
        if (edgeCount + BUBBLE_PER_CELL > MAX_EDGE_BLOBS) break;
        const ov = dv * L;
        for (let du = -reachCells; du <= reachCells; du++) {
          if (edgeCount + BUBBLE_PER_CELL > MAX_EDGE_BLOBS) break;
          const ou = du * L;
          if (ou * ou + ov * ov > wb2) continue;
          // Tangent point at the deck altitude, snapped to the planet-local
          // lattice for a world-stable position + dedupe.
          const wx = gx + ex * ou + nx * ov + ux * deckAlt;
          const wy = gy + ey * ou + ny * ov + uy * deckAlt;
          const wz = gz + ez * ou + nz * ov + uz * deckAlt;
          const sx = Math.round(wx * invLat), sy = Math.round(wy * invLat), sz = Math.round(wz * invLat);
          const key = (((sx & 0x3ff) << 20) ^ ((sy & 0x3ff) << 10) ^ (sz & 0x3ff)) >>> 0;
          if (edgeSeen.has(key)) continue;
          // Coverage gate — same field/layer as the deck so bubbles sit on cloud.
          _samplePos.set(wx, wy, wz);
          cloudDensityAt(field, map, _samplePos, timeSeconds, sampleOpts, _sampleOut, L, 1);
          if (_sampleOut.density < minDensity) continue;
          edgeSeen.add(key);
          const ul0r = Math.sqrt(sx * sx + sy * sy + sz * sz) * L || 1;
          const upx = sx * L / ul0r, upy = sy * L / ul0r, upz = sz * L / ul0r;
          // Lift the cluster onto the lumpy deck SURFACE — same billow the deck
          // mesh uses, so the bumps sit ON the surface, not floating above a haze.
          const surfRise = billow3(sx * L, sy * L, sz * L) * DECK_CELL_AMP_M;
          const ccx = sx * L + upx * surfRise, ccy = sy * L + upy * surfRise, ccz = sz * L + upz * surfRise;
          const cr = _sampleOut.color.r, cg = _sampleOut.color.g, cb = _sampleOut.color.b;
          for (let k = 0; k < BUBBLE_PER_CELL; k++) {
            const skk = (key ^ (k * 0x9e37)) >>> 0;
            const jt = (keyRand(skk, 0x11) - 0.5) * 2 * BUBBLE_JITTER_FRAC * L;
            const js = (keyRand(skk, 0x22) - 0.5) * 2 * BUBBLE_JITTER_FRAC * L;
            const rise = BUBBLE_RISE_M * (0.35 + 0.65 * keyRand(skk, 0x33));
            const rad = BUBBLE_RADIUS_M
              * (BUBBLE_SIZE_MIN + (BUBBLE_SIZE_MAX - BUBBLE_SIZE_MIN) * keyRand(skk, 0x44));
            const bx = ccx + ex * jt + nx * js + upx * rise;
            const by = ccy + ey * jt + ny * js + upy * rise;
            const bz = ccz + ez * jt + nz * js + upz * rise;
            // Apparent-size cull (REAL size, no shrink): drop bumps that would be
            // sub-pixel (imperceptible to add/remove); skip if camera is inside.
            const ddx = bx - cax, ddy = by - cay, ddz = bz - caz;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (rad / dist < minApparentDen) continue; // apparent-size cull only (no inside-cull → flying into a clump shows cloud, not a blink)
            const e3 = edgeCount * 3;
            eCenter[e3] = bx - gx; eCenter[e3 + 1] = by - gy; eCenter[e3 + 2] = bz - gz;
            eUp[e3] = upx; eUp[e3 + 1] = upy; eUp[e3 + 2] = upz;
            eColor[e3] = cr; eColor[e3 + 1] = cg; eColor[e3 + 2] = cb;
            eRadius[edgeCount] = rad;
            eSeed[edgeCount] = (skk & 0xffff) * 0.001;
            edgeCount++;
          }
        }
      }
    }

    // ── 3b. Towers / cumulus clumps — occasional ~6-sphere clusters where the
    // field is convectively developed, on a COARSE lattice (sparse). Same sphere
    // buffer + apparent-LOD; bigger spheres so they're visible from much farther
    // (a cumulus is "invisible from orbit, appears at individual visibility").
    if (edgeEnabled) {
      const TL = TOWER_LATTICE_M, invTL = 1 / TL;
      const cax = cameraLocalPos.x, cay = cameraLocalPos.y, caz = cameraLocalPos.z;
      const minApparentDen = BUBBLE_MIN_PX / pixelsPerUnit;
      const towWalk = Math.min(TOWER_WALK_MAX_M, TOWER_RADIUS_M * pixelsPerUnit / BUBBLE_MIN_PX);
      const towCells = Math.ceil(towWalk / TL) + 1;
      const tw2 = towWalk * towWalk;
      for (let dv = -towCells; dv <= towCells; dv++) {
        if (edgeCount + TOWER_SPHERES > MAX_EDGE_BLOBS) break;
        const ov = dv * TL;
        for (let du = -towCells; du <= towCells; du++) {
          if (edgeCount + TOWER_SPHERES > MAX_EDGE_BLOBS) break;
          const ou = du * TL;
          if (ou * ou + ov * ov > tw2) continue;
          const wx = gx + ex * ou + nx * ov + ux * smoothBase;
          const wy = gy + ey * ou + ny * ov + uy * smoothBase;
          const wz = gz + ez * ou + nz * ov + uz * smoothBase;
          const sx = Math.round(wx * invTL), sy = Math.round(wy * invTL), sz = Math.round(wz * invTL);
          const key = (((sx & 0x3ff) << 20) ^ ((sy & 0x3ff) << 10) ^ (sz & 0x3ff)) >>> 0;
          if (edgeSeen.has(key)) continue;
          _samplePos.set(wx, wy, wz);
          cloudDensityAt(field, map, _samplePos, timeSeconds, sampleOpts, _sampleOut, TL, 1);
          if (_sampleOut.density < minDensity || _sampleOut.cumuliformity < TOWER_CUM_MIN) continue;
          if (keyRand(key, 0x77) > TOWER_PROB) continue; // occasional, not every cell
          edgeSeen.add(key);
          const ccx0 = sx * TL, ccy0 = sy * TL, ccz0 = sz * TL;
          const ul0 = Math.sqrt(ccx0 * ccx0 + ccy0 * ccy0 + ccz0 * ccz0) || 1;
          const upx = ccx0 / ul0, upy = ccy0 / ul0, upz = ccz0 / ul0;
          // Base on the lumpy deck surface (same billow); develop upward.
          const surfRise = billow3(ccx0, ccy0, ccz0) * DECK_CELL_AMP_M;
          const baseX = ccx0 + upx * surfRise, baseY = ccy0 + upy * surfRise, baseZ = ccz0 + upz * surfRise;
          const cr = _sampleOut.color.r, cg = _sampleOut.color.g, cb = _sampleOut.color.b;
          const devH = TOWER_HEIGHT_M * Math.min(1, _sampleOut.cumuliformity);
          for (let k = 0; k < TOWER_SPHERES; k++) {
            const skk = (key ^ (k * 0x51ed)) >>> 0;
            // Cauliflower form, HORIZONTALLY biased: most spheres spread wide near
            // the base, only a few rise. h^1.6 packs the cluster low; wide spread.
            const hl = TOWER_SPHERES > 1 ? k / (TOWER_SPHERES - 1) : 0;
            const h = Math.pow(hl, 1.6);            // 0 base → 1 top, weighted low
            const up = h * devH;
            const spread = TOWER_RADIUS_M * (2.1 - 1.1 * h);
            const jt = (keyRand(skk, 0x11) - 0.5) * 2 * spread;
            const js = (keyRand(skk, 0x22) - 0.5) * 2 * spread;
            const rad = TOWER_RADIUS_M * (0.7 + 0.5 * keyRand(skk, 0x44)) * (1.0 - 0.2 * h);
            const bx = baseX + ex * jt + nx * js + upx * up;
            const by = baseY + ey * jt + ny * js + upy * up;
            const bz = baseZ + ez * jt + nz * js + upz * up;
            const ddx = bx - cax, ddy = by - cay, ddz = bz - caz;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (rad / dist < minApparentDen) continue; // apparent-size cull only (no inside-cull → flying into a clump shows cloud, not a blink)
            const e3 = edgeCount * 3;
            eCenter[e3] = bx - gx; eCenter[e3 + 1] = by - gy; eCenter[e3 + 2] = bz - gz;
            eUp[e3] = upx; eUp[e3 + 1] = upy; eUp[e3 + 2] = upz;
            eColor[e3] = cr; eColor[e3 + 1] = cg; eColor[e3 + 2] = cb;
            eRadius[edgeCount] = rad;
            eSeed[edgeCount] = (skk & 0xffff) * 0.001;
            edgeCount++;
          }
        }
      }
    }

    posAttr.needsUpdate = true;
    normAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    covAttr.needsUpdate = true;
    // Whole grid is one mesh; per-fragment coverage discards the holes.
    geom.setDrawRange(0, drawn > 0 ? QUAD_COUNT * 6 : 0);
    cloudDeckStats.cellsPassed = drawn;
    cloudDeckStats.sprites = drawn > 0 ? QUAD_COUNT * 2 : 0; // triangles (upper bound)

    if (edgeEnabled && edgeGeom) {
      edgeMesh!.position.copy(_ground);
      (edgeGeom.getAttribute("iCenter") as THREE.BufferAttribute).needsUpdate = true;
      (edgeGeom.getAttribute("iUp") as THREE.BufferAttribute).needsUpdate = true;
      (edgeGeom.getAttribute("iColor") as THREE.BufferAttribute).needsUpdate = true;
      (edgeGeom.getAttribute("iRadius") as THREE.BufferAttribute).needsUpdate = true;
      (edgeGeom.getAttribute("iSeed") as THREE.BufferAttribute).needsUpdate = true;
      edgeGeom.instanceCount = edgeCount;
      cloudDeckStats.tierSprites[0] = edgeCount;
    }
  }

  function update(
    cameraLocalPos: THREE.Vector3, timeSeconds: number, _fwd?: THREE.Vector3,
  ): void {
    lastTimeSeconds = timeSeconds;
    // Debug-isolation depth toggles — flip the cloud materials' depth behaviour
    // live so we can tell whether the clump flicker is the depth TEST failing
    // (no-depth-test should stop it) or the depth WRITE conflicting.
    const dTest = !GFX.dbgCloudNoDepthTest, dWrite = !GFX.dbgCloudNoDepthWrite;
    material.depthTest = dTest; material.depthWrite = dWrite;
    if (edgeMaterial) { edgeMaterial.depthTest = dTest; edgeMaterial.depthWrite = dWrite; }
    if (field.layers.length === 0) {
      geom.setDrawRange(0, 0); cloudDeckStats.sprites = 0;
      if (edgeGeom) edgeGeom.instanceCount = 0;
      return;
    }

    const t0 = performance.now();
    bakeTick(timeSeconds);
    cloudDeckStats.bakeMs = performance.now() - t0;

    const hasSun = computeSunLocal();
    if (hasSun && sunWorldPos) {
      _sunDirW.copy(sunWorldPos).sub(group.getWorldPosition(_samplePos)).normalize();
      material.uniforms.uSunDirW.value.copy(_sunDirW);
    }
    material.uniforms.uHasSun.value = hasSun ? 1 : 0;
    material.uniforms.uOpacity.value = opacity;
    material.uniforms.uCoverThresh.value = minDensity;
    material.uniforms.uUpW.value.copy(cameraLocalPos).normalize()
      .applyQuaternion(group.getWorldQuaternion(_tmpQuat));
    if (edgeMaterial) {
      const e = edgeMaterial.uniforms;
      if (hasSun) e.uSunDirW.value.copy(_sunDirW);
      e.uHasSun.value = hasSun ? 1 : 0;
      e.uOpacity.value = opacity;
      e.uUpW.value.copy(material.uniforms.uUpW.value);
    }

    // Altitude-adaptive patch: half-extent grows with altitude so the deck
    // always fills the view; grid spacing follows (fixed vertex count → fixed
    // cost). The deck owns horiz < reach·0.82, crossfading to the shell, which
    // is keyed to reach/SHELL_FADE_NEAR_FRAC so the handoff stays seamless.
    const altitude = cameraLocalPos.length() - field.planetRadiusM;
    const reach = Math.max(DECK_REACH_MIN_M,
      Math.min(DECK_REACH_MAX_M, DECK_REACH_MIN_M + altitude * DECK_REACH_ALT_K));
    const gridM = (2 * reach) / (NU - 1);
    material.uniforms.uReach.value = reach;
    const maxReachM = reach / SHELL_FADE_NEAR_FRAC;

    // Shell uniforms (every frame for smooth drift).
    for (const shell of shells) {
      const u = shell.material.uniforms;
      u.uTime.value = timeSeconds; u.uEpoch.value = map.epochSec;
      u.uWindMult.value = sampleOpts.windMult; u.uReach.value = maxReachM;
      u.uDetailAmp.value = 0.35 * shellDetailMult; u.uHasSun.value = hasSun ? 1 : 0;
      u.uOpacity.value = opacity; u.uMinDensity.value = minDensity;
      if (hasSun && sunWorldPos) u.uSunPosW.value.copy(sunWorldPos);
    }

    // High-altitude early-out — far above the deck the shell owns the whole far
    // field, so building the heightmap patch is wasted work (it's sub-pixel and
    // entirely below the view). Drop it (the shell keeps rendering).
    const shellFullAlt = DECK_REACH_MAX_M * SHELL_FADE_FAR_FRAC + 4000;
    const earlyOutAlt = Math.max(shellFullAlt,
      field.layers[0].topAltitudeM * DECK_EARLY_OUT_TOP_MULT);
    if (altitude > earlyOutAlt) {
      geom.setDrawRange(0, 0);
      if (edgeGeom) edgeGeom.instanceCount = 0;
      cloudDeckStats.walkMs = 0; cloudDeckStats.sprites = 0; cloudDeckStats.cellsPassed = 0;
      return;
    }

    updateCounter++;
    if (updateCounter % Math.max(1, Math.round(updateInterval)) !== 0) {
      cloudDeckStats.walkMs = 0;
      return;
    }

    const t1 = performance.now();
    rebuildDeck(cameraLocalPos, timeSeconds, reach, gridM);
    cloudDeckStats.walkMs = performance.now() - t1;
  }

  function fogContribution(
    cameraLocalPos: THREE.Vector3, out: { density: number; color: THREE.Color },
  ): void {
    out.density = 0; out.color.setRGB(0, 0, 0);
    if (field.layers.length === 0) return;
    cloudDensityAt(field, map, cameraLocalPos, lastTimeSeconds, sampleOpts, _sampleOut);
    const d = _sampleOut.density;
    if (d <= minDensity) return;
    out.density = (d - minDensity) / Math.max(1e-3, 1 - minDensity);
    out.color.copy(_sampleOut.color);
  }

  function setOpacity(o: number): void {
    opacity = o;
    material.uniforms.uOpacity.value = o;
    for (const shell of shells) shell.material.uniforms.uOpacity.value = o;
  }
  function setRuntimeOpts(o: CloudSystemRuntimeOpts): void {
    if (o.opacity !== undefined) setOpacity(o.opacity);
    if (o.minDensity !== undefined) minDensity = o.minDensity;
    if (o.windMult !== undefined) sampleOpts.windMult = o.windMult;
    if (o.detailMult !== undefined) sampleOpts.detailMult = o.detailMult;
    if (o.vigorMult !== undefined) sampleOpts.vigorMult = o.vigorMult;
    if (o.bakeBudgetMs !== undefined) bakeBudgetMs = o.bakeBudgetMs;
    if (o.updateInterval !== undefined) updateInterval = o.updateInterval;
    if (o.shellDetailMult !== undefined) shellDetailMult = o.shellDetailMult;
  }
  function setSunWorldPos(pos: THREE.Vector3 | null): void {
    if (pos === null) sunWorldPos = null;
    else { if (!sunWorldPos) sunWorldPos = new THREE.Vector3(); sunWorldPos.copy(pos); }
  }
  function setProjection(p: number, _v: number): void { pixelsPerUnit = p; }
  function setField(f: CloudFieldParams): void {
    field = f;
    if (!usingSharedMap) {
      mapTexture.dispose();
      map = buildWeatherMap(field, lastTimeSeconds);
      mapTexture = makeMapTexture(map);
      rowsSinceUpload = 0; initialSweepDone = false;
    }
    if (!noShell && SHELL_ENABLED) buildShells();
    setOpacity(opacity);
  }
  function dispose(): void {
    geom.dispose(); material.dispose(); mapTexture.dispose();
    if (edgeGeom) edgeGeom.dispose();
    if (edgeMaterial) edgeMaterial.dispose();
    for (const shell of shells) { shell.mesh.geometry.dispose(); shell.material.dispose(); }
  }

  return {
    group, setField, update, setOpacity, setRuntimeOpts,
    setSunWorldPos, setProjection, fogContribution, dispose,
  };
}
