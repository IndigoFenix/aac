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
const DECK_BILLOW_AMP_M = 260;
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

// ── Edge blobs (mound mode) ────────────────────────────────────────────────
// The hill mesh is single-valued and can't overhang; cumulus cauliflower IS
// overhang. So we skin the mound's STEEP FLANKS (high heightmap gradient) with
// instanced icosphere blobs — the one job worth spending blobs on, and only
// there (flat deck gets none). Positions snap to a WORLD lattice so the blobs
// don't swim as the camera-relative grid slides underfoot.
const MAX_EDGE_BLOBS = 9000;
const EDGE_TOWER_MIN_M = 250;      // mound rise above the base deck to count as a tower
const EDGE_LATTICE_MIN_M = 1100;   // world snap lattice floor — coarse → big balls
// The blobs ARE the visible cloud (the hill is just a depth mask). They want to
// be LARGE and IRREGULAR, not a uniform bumpy skin — so the radius is ~1× the
// spacing (heavy overlap → one solid mass) and per-blob hashed randoms jitter
// position, size and height so the silhouette reads random, not gridded.
const EDGE_BLOB_RADIUS_FRAC = 1.4;  // > spacing → heavy overlap, no gaps
const EDGE_SIZE_MIN = 0.7;          // random size range (× base radius)
const EDGE_SIZE_MAX = 1.6;
const EDGE_JITTER_FRAC = 0.4;       // tangential position jitter (× lattice)
const EDGE_VJITTER_FRAC = 0.4;      // vertical position jitter (× lattice)
const EDGE_BILLOW = 0.4;            // cauliflower displacement amplitude

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

void main() {
  #include <logdepthbuf_fragment>
  // Double-sided: orient the normal toward the camera (underside lit too).
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vNormal);
  if (dot(N, viewDir) < 0.0) N = -N;

  // Banded toon off the REAL heightmap normal — world-anchored shading.
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(uUpW, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);
  vec3 col = vColor * lit;

  // Coverage gate → broken deck with clear gaps (holes are coverage 0; the
  // soft 0→1 interpolation across edge quads feathers cloud boundaries). The
  // gap fraction tracks the cover-thresh slider, exactly like the blob walk.
  float cov = smoothstep(uCoverThresh, uCoverThresh + 0.12, vCoverage);

  // Patch-edge fade by HORIZONTAL distance from the camera column (the patch is
  // centered under the camera) — hands to the shell at the boundary. + near-
  // plane dissolve (cloud entry). The deck is a CONNECTED manifold (a
  // heightmap, near depth-sorted from any angle), so unlike a blob swarm it can
  // ALPHA-BLEND for smooth edges without a per-fragment sort — depthWrite off,
  // depthTest on (terrain still occludes it correctly).
  vec3 toFrag = vWorldPos - cameraPosition;
  float horiz = length(toFrag - uUpW * dot(toFrag, uUpW));
  float edge = 1.0 - smoothstep(uReach * 0.82, uReach, horiz);
  float near = smoothstep(0.0, uNearFade, vCamDist);
  float a = cov * edge * near * uOpacity;
  if (a < 0.004) discard;

  gl_FragColor = vec4(col, a);
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
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCamDist;
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
  vec3 localOffset = dir * iRadius * (1.0 + uBillow*n);
  vec4 centerW = modelMatrix * vec4(iCenter, 1.0);
  vec3 worldOffset = mat3(modelMatrix) * localOffset;
  vec3 worldPos = centerW.xyz + worldOffset;
  vColor = iColor;
  vWorldPos = worldPos;
  vNormalW = normalize(mat3(modelMatrix) * dir);
  vCamDist = distance(cameraPosition, worldPos);
  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
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
uniform float uReach;
uniform float uNearFade;
varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCamDist;
float dither(vec2 fc){ return fract(sin(dot(fc, vec2(12.9898,78.233)))*43758.5453); }
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  // SAME ramp as the deck → blobs and hill match.
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(uUpW, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);
  vec3 col = vColor * lit;
  // Patch-edge + near-plane fade, folded into a dithered discard (opaque, no
  // sort). The blobs are sparse so the grain is far less visible than a swarm.
  vec3 toFrag = vWorldPos - cameraPosition;
  float horiz = length(toFrag - uUpW * dot(toFrag, uUpW));
  float edge = 1.0 - smoothstep(uReach * 0.82, uReach, horiz);
  float near = smoothstep(0.0, uNearFade, vCamDist);
  float a = edge * near * uOpacity;
  if (a < dither(gl_FragCoord.xy)) discard;
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
    // "mound" mode = an INVISIBLE DEPTH MASK: it writes depth (so it occludes
    // the far-side / interior edge blobs and kills see-through) but draws no
    // colour — the blobs ARE the visible cloud. "base" mode = the visible flat
    // base, alpha-blended for clean edges.
    transparent: deckMode !== "mound",
    depthTest: true,
    depthWrite: deckMode === "mound",
    colorWrite: deckMode !== "mound",
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const deckMesh = new THREE.Mesh(geom, material);
  deckMesh.name = deckMode === "mound" ? "cloud_hill_mask" : "cloud_deck";
  deckMesh.frustumCulled = false;
  deckMesh.renderOrder = deckMode === "mound" ? 1 : 2; // mask before blobs

  const group = new THREE.Group();
  group.name = "cloud_deck_system";
  group.add(deckMesh);

  // ── Edge blobs (mound mode only): instanced icosphere skinning the flanks ──
  const edgeEnabled = deckMode === "mound";
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
        uReach: { value: DECK_REACH_MIN_M }, uNearFade: { value: 80 },
        uBillow: { value: EDGE_BILLOW },
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      },
      vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG,
      transparent: false, depthTest: true, depthWrite: true, fog: true,
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
  if (!noShell) buildShells();

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
    // Reference height of the thin BASE deck — edge blobs skin a column only
    // where the mound rises above this (i.e. where it genuinely towers).
    const baseDeckTop = L0.baseAltitudeM
      + Math.min(L0.topAltitudeM - L0.baseAltitudeM, DECK_MAX_THICK_M);

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
        let alt = colRes.alt;
        let cov = colRes.cov;
        if (found) {
          // Billow the top for cauliflower relief, gated by coverage.
          const tx = wbx + ux * (alt - altBase);
          const ty = wby + uy * (alt - altBase);
          const tz = wbz + uz * (alt - altBase);
          alt += billow3(tx, ty, tz) * DECK_BILLOW_AMP_M * cov;
        }
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
    // In mound mode, where the flank is steep we ALSO drop edge blobs (the
    // cauliflower the single-valued hill can't represent), world-lattice-snapped.
    let drawn = 0;
    let edgeCount = 0;
    if (edgeEnabled) edgeSeen.clear();
    // Blob spacing tracks the grid spacing (≥ a floor) so the skin stays
    // continuous from any distance.
    const latticeM = Math.max(EDGE_LATTICE_MIN_M, gridM);
    const invLat = 1 / latticeM;
    const edgeRadius = latticeM * EDGE_BLOB_RADIUS_FRAC;
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

        // Edge blob where the mound TOWERS above the thin base deck — that
        // robustly identifies cumulus regardless of grid spacing (gradient alone
        // gets smoothed away at coarse spacing). Snap the blob's PLANET-LOCAL
        // position to a world lattice + dedupe so it doesn't swim as the
        // camera-relative grid slides. Gradient just modulates the blob size
        // (steeper flank → bigger cauliflower lobe).
        if (edgeEnabled && colCov[vi] > 0 && edgeCount < MAX_EDGE_BLOBS) {
          const towerH = alt - baseDeckTop;
          if (towerH > EDGE_TOWER_MIN_M) {
            const grad = Math.sqrt(dhu * dhu + dhv * dhv);
            const lx = gx + px, ly = gy + py, lz = gz + pz; // planet-local center
            const sx = Math.round(lx * invLat);
            const sy = Math.round(ly * invLat);
            const sz = Math.round(lz * invLat);
            // Pack the lattice cell into one number for the dedupe set.
            const key = (((sx & 0x3ff) << 20) ^ ((sy & 0x3ff) << 10) ^ (sz & 0x3ff)) >>> 0;
            if (!edgeSeen.has(key)) {
              edgeSeen.add(key);
              void grad;
              // Snapped lattice point, then per-blob hashed randoms (world-stable)
              // jitter it into an irregular, non-gridded cluster.
              const upx0 = (gx + px), upy0 = (gy + py), upz0 = (gz + pz);
              const ul0 = Math.sqrt(upx0 * upx0 + upy0 * upy0 + upz0 * upz0) || 1;
              const upx = upx0 / ul0, upy = upy0 / ul0, upz = upz0 / ul0;
              const jt = (keyRand(key, 0x11) - 0.5) * 2 * EDGE_JITTER_FRAC * latticeM;
              const js = (keyRand(key, 0x22) - 0.5) * 2 * EDGE_JITTER_FRAC * latticeM;
              const jv = (keyRand(key, 0x33) - 0.5) * 2 * EDGE_VJITTER_FRAC * latticeM;
              const rad = edgeRadius
                * (EDGE_SIZE_MIN + (EDGE_SIZE_MAX - EDGE_SIZE_MIN) * keyRand(key, 0x44));
              const bx = sx * latticeM + ex * jt + nx * js + upx * jv;
              const by = sy * latticeM + ey * jt + ny * js + upy * jv;
              const bz = sz * latticeM + ez * jt + nz * js + upz * jv;
              const e3 = edgeCount * 3;
              // iCenter relative to the ground anchor (the edge mesh shares it).
              eCenter[e3] = bx - gx; eCenter[e3 + 1] = by - gy; eCenter[e3 + 2] = bz - gz;
              eUp[e3] = upx; eUp[e3 + 1] = upy; eUp[e3 + 2] = upz;
              eColor[e3] = colors[vi * 3]; eColor[e3 + 1] = colors[vi * 3 + 1]; eColor[e3 + 2] = colors[vi * 3 + 2];
              eRadius[edgeCount] = rad;
              eSeed[edgeCount] = (key & 0xffff) * 0.001;
              edgeCount++;
            }
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
    if (edgeMaterial) edgeMaterial.uniforms.uReach.value = reach;
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
  function setProjection(_p: number, _v: number): void { /* unit-agnostic */ }
  function setField(f: CloudFieldParams): void {
    field = f;
    if (!usingSharedMap) {
      mapTexture.dispose();
      map = buildWeatherMap(field, lastTimeSeconds);
      mapTexture = makeMapTexture(map);
      rowsSinceUpload = 0; initialSweepDone = false;
    }
    if (!noShell) buildShells();
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
