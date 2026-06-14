import * as THREE from "three";
import { hashCell } from "./galaxy";
import {
  CLOUD_CELL_SIZES_M,
  activeCloudTiers,
  buildWeatherMap,
  cloudDensityAt,
  type CloudFieldParams,
  type CloudSample,
  type CloudSampleOpts,
} from "./cloud-field";
import type { WeatherMap, SynopticSample } from "./weather-map";
import type {
  CloudSystem,
  CloudSystemOpts,
  CloudSystemRuntimeOpts,
} from "./cloud-system";

// ── EXPERIMENT 1: Instanced 3-D blob renderer ──────────────────────────────
//
// See instructions/clouds-renderer-v2-plan.md. This is an ALTERNATIVE near-
// field renderer to cloud-system.ts's billboards — it implements the same
// CloudSystem interface so the cloud lab can swap it in for an A/B at every
// distance scale. The shipping billboard renderer is untouched.
//
// The thesis (from clouds-metaballs-discussion.md): the distance-shift snap is
// the billboard/impostor failure. Camera-facing quads are flat → zero motion
// parallax → dollying reads as "a sprite scaling," not a 3-D object
// approaching. The fix is a REAL 3-D primitive with FIXED topology:
//
//   • one icosphere, instanced, placed at the field maxima the cell walk finds
//   • topology never changes with distance → cannot pop
//   • cloud read comes from shading, not polycount: banded/toon light +
//     fresnel rim + billowy (hashed) vertex displacement on the silhouette
//   • sheetness is EMERGENT — squash the icosphere along planet-up by
//     cumuliformity; no second renderer, no marching cubes
//   • rendered OPAQUE (depthWrite, no blend, no sort — order-independent,
//     weak-hardware ideal). Transparency is reserved for LOD fade + cloud-entry
//     near-plane dissolve, done with DITHERED discard so we still never sort.
//
// REUSED unchanged from the shipping system: weather map (single source of
// truth), cloudDensityAt sampler, the curved column-culled cell walk, the
// continuous shell + per-pixel distance crossfade (copied below — far field
// and crossfade must exist for the A/B to be honest).

// LOD: tiers tile by distance and a blob geomorphs onto its coarse PARENT in
// the outer band (see the walk), so there are no fixed per-tier sizes and no
// alpha dissolve between tiers — a coarse blob is exactly its fine children
// merged. Band factors live inline in the walk.
const MAX_BLOBS = 14000;
const POSITION_JITTER = 0.42;
const MAX_BILLBOARD_CELL_SIZE_M = 20_000;
const SHELL_FADE_NEAR_FRAC = 0.55;
const SHELL_FADE_FAR_FRAC = 0.95;
const DEFAULT_MIN_DENSITY = 0.05;
const DEFAULT_BAKE_BUDGET_MS = 0.5;
const MAX_BAKE_ROWS_PER_FRAME = 16;
const DEFAULT_UPDATE_INTERVAL = 2;
const MAX_FRESH_SAMPLES_PER_REBUILD = 4000;
// Cross-frame blob cache (camera-independent geometry, weather-time-dependent).
// Two generations swapped every CACHE_GEN_SECONDS retire cells the camera left;
// entries refresh after a staggered TTL so refreshes don't clump into a frame.
const CACHE_TTL_SECONDS = 0.7;
const CACHE_GEN_SECONDS = 2.5;
// View-cone cull half-angle cosine. A 60° vFOV / 16:9 frustum's corners sit
// ~49° off forward, so a 72° cone never clips on-screen blobs but removes the
// whole rear hemisphere and far sides (~half the candidates). Blobs whose own
// radius subtends a large angle (dist < 3×radius) are exempt — their center can
// sit outside the cone while the blob is still visible.
const CULL_CONE_COS = Math.cos((72 * Math.PI) / 180); // ≈ 0.31
const TEXTURE_UPLOAD_ROW_BATCH = 32;
const NIGHT_AMBIENT = 0.12;

// Blob shaping. One blob per cell; radius fills the cell so neighbors overlap
// into a continuous mass under solid cover, and high-density isolated cells
// read as separate cumulus.
const BLOB_ICO_DETAIL = 2;          // 162 verts — low-poly, chunky
const BLOB_RADIUS_CELL_FRAC = 0.62; // tangential radius as a fraction of cell
const BLOB_BILLOW_AMP = 0.34;       // silhouette displacement (× radius)
const BLOB_FILL_DENSITY_BOOST = 0.4;// dense cells inflate to close gaps
// Squash along planet-up: cumulus (cum=1) stays tall/round, stratus (cum=0)
// flattens to a lens. Also hard-capped to the layer thickness so decks stay
// inside their altitude band.
const SQUASH_STRATUS = 0.22;
const SQUASH_CUMULUS = 0.95;
// Minimum synoptic cover for a coarse envelope blob to exist (a genuine clear).
const COARSE_COVER_MIN = 0.1;
// Cloud entry. The near-plane dissolve band is max(NEAR_BAND_MIN, N × per-frame
// camera movement) so a fast fly-through can't cross it in one frame and flash
// the boundary (discussion's fade_band ≥ N·v·Δt); clamped so a teleport doesn't
// dissolve the whole sky. ENTRY_FEATHER erodes the silhouette near the camera.
const NEAR_BAND_MIN = 14;
const NEAR_BAND_SPEED_N = 4;
const NEAR_BAND_MAX = 3000;
const ENTRY_FEATHER = 0.5;
// Billboard-variant edge fuzz (fraction of radius): wide & soft up close,
// thin & crisp past FUZZ_FAR_DIST so distant billboards read solid.
const FUZZ_CLOSE = 0.34;
const FUZZ_FAR = 0.05;
const FUZZ_FAR_DIST = 5000;

/** Per-update perf counters (mirrors cloudSystemStats keys the lab reads). */
export const cloudBlobStats = {
  bakeMs: 0,
  walkMs: 0,
  sortMs: 0,
  cellsIterated: 0,
  cellsPassed: 0,
  sprites: 0,
  tierSprites: [0, 0, 0, 0, 0],
};

// ── Blob shader ────────────────────────────────────────────────────────────

const BLOB_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

// Base icosphere vertex is in 'position' (unit sphere). Instance attrs:
attribute vec3 iCenter;   // planet-local meters
attribute vec3 iUp;       // planet-local up at the cell (squash + base shade)
attribute vec3 iColor;    // tinted cloud color (pre-sun-shade)
attribute float iRadius;  // tangential radius, meters
attribute float iSquash;  // up-axis scale (lens ↔ ball)
attribute float iSeed;    // per-blob hash → unique billow
attribute float iFade;    // LOD / crossfade alpha 0..1

uniform float uBillow;

varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vUp;
varying float vFade;
varying float vSeed;
varying float vUpCoord;   // -1 base .. +1 top, for the base→top gradient
varying float vRadius;    // blob radius (m) — for proximity silhouette feather

// Cheap hash-value noise on a unit direction — billowy cauliflower edge.
float h31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h31(i + vec3(0,0,0)), h31(i + vec3(1,0,0)), f.x),
        mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x),
        mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  vec3 dir = normalize(position);

  // Squash along planet-up: scale the up-component of the unit direction.
  float upc = dot(dir, iUp);
  vec3 squashed = dir + iUp * (upc * (iSquash - 1.0));

  // Billowy displacement along the (squashed) direction — two octaves so the
  // silhouette is lumpy, not wavy. Seeded per blob so neighbors differ.
  float n = vnoise(dir * 2.3 + iSeed)
    + 0.5 * vnoise(dir * 5.1 + iSeed * 1.7);
  n = (n / 1.5 - 0.5);
  float disp = 1.0 + uBillow * n;
  vec3 localOffset = squashed * iRadius * disp;

  // Precision: cancel the big planet-radius translation on the CENTER first
  // (modelMatrix carries -R·up), then add the small radius-scale offset in the
  // camera-relative frame. Never author center+vertex at full radius.
  vec4 centerW = modelMatrix * vec4(iCenter, 1.0);
  vec3 worldOffset = mat3(modelMatrix) * localOffset;
  vec3 worldPos = centerW.xyz + worldOffset;

  vColor = iColor;
  vWorldPos = worldPos;
  vUp = normalize(mat3(modelMatrix) * iUp);
  vFade = iFade;
  vSeed = iSeed;
  vUpCoord = upc;
  vRadius = iRadius;

  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const BLOB_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision highp float;

uniform vec3 uSunDirW;     // world-space sun direction (normalized)
uniform float uHasSun;
uniform float uOpacity;
uniform float uRim;
uniform float uNearFadeBand; // meters — near-plane dissolve width (speed-adaptive)
uniform float uFeather;      // proximity silhouette erosion strength
uniform float uInside;       // cloud density AT the camera (0..1) — fog takeover

varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vUp;
varying float vFade;
varying float vSeed;
varying float vUpCoord;
varying float vRadius;

// Stochastic (screen-door) transparency lets fades/dissolves work with no
// back-to-front sort. The threshold MUST be anchored in WORLD space, not screen
// space (gl_FragCoord), or it crawls as the camera moves — the dominant motion
// artifact. This is Wyman & McGuire "Hashed Alpha Testing": the hash is keyed on
// world position so a surface point keeps its threshold, while the scale is
// anchored to screen-space derivatives so the noise grain stays ~constant on
// screen regardless of distance.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float hashedAlphaThreshold(vec3 wp, float seed) {
  float maxDeriv = max(length(dFdx(wp)), length(dFdy(wp)));
  float pixScale = 1.0 / max(1e-8, maxDeriv);
  vec2 pixScales = vec2(exp2(floor(log2(pixScale))), exp2(ceil(log2(pixScale))));
  vec3 ws = wp + seed * 19.19;
  vec2 a = vec2(hash13(floor(pixScales.x * ws)), hash13(floor(pixScales.y * ws)));
  float lerpF = fract(log2(pixScale));
  float x = (1.0 - lerpF) * a.x + lerpF * a.y;
  float t = clamp(min(lerpF, 1.0 - lerpF), 1.0e-3, 0.5);
  vec3 cases = vec3(
    x * x / (2.0 * t * (1.0 - t)),
    (x - 0.5 * t) / (1.0 - t),
    1.0 - ((1.0 - x) * (1.0 - x) / (2.0 * t * (1.0 - t))));
  float thr = (x < (1.0 - t)) ? ((x < t) ? cases.x : cases.y) : cases.z;
  return clamp(thr, 1.0e-6, 1.0);
}

void main() {
  // Flat face normal from screen-space derivatives → faceted low-poly look
  // without per-face geometry. Oriented toward the camera (convex blob).
  vec3 dx = dFdx(vWorldPos);
  vec3 dy = dFdy(vWorldPos);
  vec3 N = normalize(cross(dx, dy));
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  if (dot(N, viewDir) < 0.0) N = -N;

  // Banded / toon diffuse — 3 steps. The floor is NOT black: a daylit cloud's
  // shadowed underside is bright grey from multiple scattering (skylight), so
  // the floor is lifted on the day side and only falls to night ambient on the
  // planet's night side (vUp vs sun = which hemisphere this blob sits on).
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(vUp, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);

  // Base→top gradient: flat cumulus bases read a touch darker than sunlit tops
  // (subtle — bases are still bright, just not as bright as the crown).
  float vGrad = 0.90 + 0.10 * clamp(vUpCoord, -1.0, 1.0);

  vec3 col = vColor * lit * vGrad;

  // Fresnel rim — the "cloud not rock" cue. Backlit silhouette glow, pushed
  // toward the lit cloud color.
  float fres = pow(1.0 - max(0.0, dot(N, viewDir)), 2.5);
  col += uRim * fres * vColor * (0.4 + 0.6 * lit);

  float fragDist = length(cameraPosition - vWorldPos);

  // Cloud entry — two coupled cues off camera distance, both reading the same
  // geometry the fogContribution envelope reads:
  //  (1) Near-plane soft dissolve. The face you'd punch through fades to
  //      transparent within uNearFadeBand of the camera, so you never see a
  //      hard polygon cross-section; the interior fog takes over. The band is
  //      speed-adaptive (set per frame) so a fast fly-through can't cross it in
  //      one frame and flash the boundary.
  float nearFade = smoothstep(0.0, uNearFadeBand, fragDist);
  //  (2) Proximity silhouette feather. Right before entry the billowy rim
  //      erodes into wisps so the cloud "opens up" instead of presenting a
  //      crisp edge. Kept to a SMALL absolute band (tied to the dissolve band,
  //      a few × it) — radius-relative ranges erode huge blobs from km away and
  //      grain the whole view. This band sits inside the interior-fog distance,
  //      so its stochastic grain is hidden once you're actually enveloped.
  // Once the camera is actually INSIDE cloud, the surface gives up and the
  // interior fog carries the look (discussion's regime split) — so suppress the
  // feather, whose stochastic grain would otherwise speckle the whole envelope.
  float featherAmt = uFeather * (1.0 - smoothstep(0.15, 0.55, uInside));
  float closeness = 1.0 - smoothstep(uNearFadeBand, uNearFadeBand * 4.0, fragDist);
  float feather = 1.0 - closeness * fres * featherAmt;

  float a = vFade * nearFade * feather * uOpacity;
  // World-anchored hashed-alpha discard — order-independent transparency with no
  // crawl under motion. Solid core blobs (a≈1) stay solid; only fading/edge/
  // entry fragments thin out.
  if (a < hashedAlphaThreshold(vWorldPos, vSeed)) discard;

  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

// ── Billboard variant ───────────────────────────────────────────────────────
//
// EXPERIMENT: the SAME walk/placement/sizing/geomorph/envelope as the 3-D
// blobs, but each instance is a camera-facing QUAD instead of an icosphere —
// to test whether the billboards' old failure was the billboard nature or just
// wrong sizing (now fixed by the shared walk). Two refinements over a naive
// billboard:
//   • Angle stretch — the quad is shaped into the ELLIPSE the squashed
//     ellipsoid would project to (tangential axis always full radius; up-axis
//     shrinks to radius×squash edge-on), so it occupies the same screen area as
//     the blob. Cheap: a couple of dot products + one sqrt per instance.
//   • Distance-sharpening fuzz — the soft edge band is a FRACTION of the radius
//     that shrinks with camera distance, so far billboards read crisp/solid and
//     near ones are soft and wispy.
// Opaque + world-anchored hashed alpha (no sort, no crawl) like the blobs, for
// an apples-to-apples A/B.

const BILLBOARD_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

attribute vec3 iCenter;
attribute vec3 iUp;
attribute vec3 iColor;
attribute float iRadius;
attribute float iSquash;
attribute float iSeed;
attribute float iFade;

varying vec3 vColor;
varying vec3 vWorldPos;   // billboard center (lighting view dir, fog)
varying vec3 vFragW;      // this corner's world pos (camera-stable hashed alpha)
varying vec2 vQuad;       // unit-disc coord [-1,1]
varying vec3 vUp;
varying float vFade;
varying float vSeed;
varying float vDist;

void main() {
  vec4 centerW = modelMatrix * vec4(iCenter, 1.0);
  vec3 upW = normalize(mat3(modelMatrix) * iUp);
  vec3 toCam = cameraPosition - centerW.xyz;
  float dist = length(toCam);
  vec3 viewDir = toCam / max(1.0, dist);
  float facing = abs(dot(viewDir, upW));
  // Elliptical silhouette: up-axis shrinks toward radius×squash edge-on.
  float minorScale = sqrt(facing * facing + iSquash * iSquash * (1.0 - facing * facing));

  vec4 mvPosition = viewMatrix * centerW;
  vec3 upV = (viewMatrix * vec4(upW, 0.0)).xyz;
  vec2 sUp = upV.xy;
  float sl = length(sUp);
  vec2 minorDir = sl > 1e-4 ? sUp / sl : vec2(0.0, 1.0);
  vec2 majorDir = vec2(-minorDir.y, minorDir.x);

  vec2 q = (uv - 0.5) * 2.0;
  float R = iRadius;
  vec2 off = majorDir * (q.x * R) + minorDir * (q.y * R * minorScale);
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;

  // World pos of this corner = center + camera-right/up (from the view matrix
  // rows) × the screen offset. Keeps the hashed-alpha threshold world-stable.
  mat3 vm = mat3(viewMatrix);
  vec3 camRight = vec3(vm[0][0], vm[1][0], vm[2][0]);
  vec3 camUp    = vec3(vm[0][1], vm[1][1], vm[2][1]);
  vFragW = centerW.xyz + camRight * off.x + camUp * off.y;

  vColor = iColor;
  vWorldPos = centerW.xyz;
  vQuad = q;
  vUp = upW;
  vFade = iFade;
  vSeed = iSeed;
  vDist = dist;

  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const BILLBOARD_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision highp float;

uniform vec3 uSunDirW;
uniform float uHasSun;
uniform float uOpacity;
uniform float uRim;
uniform float uBillow;
uniform float uFuzzClose;
uniform float uFuzzFar;
uniform float uFuzzFarDist;

varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vFragW;
varying vec2 vQuad;
varying vec3 vUp;
varying float vFade;
varying float vSeed;
varying float vDist;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float hashedAlphaThreshold(vec3 wp, float seed) {
  float md = max(length(dFdx(wp)), length(dFdy(wp)));
  float ps = 1.0 / max(1e-8, md);
  vec2 pss = vec2(exp2(floor(log2(ps))), exp2(ceil(log2(ps))));
  vec3 ws = wp + seed * 19.19;
  vec2 a = vec2(hash13(floor(pss.x * ws)), hash13(floor(pss.y * ws)));
  float lf = fract(log2(ps));
  float x = (1.0 - lf) * a.x + lf * a.y;
  float t = clamp(min(lf, 1.0 - lf), 1.0e-3, 0.5);
  vec3 c = vec3(x * x / (2.0 * t * (1.0 - t)), (x - 0.5 * t) / (1.0 - t),
    1.0 - ((1.0 - x) * (1.0 - x) / (2.0 * t * (1.0 - t))));
  float thr = (x < (1.0 - t)) ? ((x < t) ? c.x : c.y) : c.z;
  return clamp(thr, 1.0e-6, 1.0);
}

void main() {
  float r = length(vQuad);
  float distF = clamp(vDist / uFuzzFarDist, 0.0, 1.0);
  // Billowy silhouette (smooth, two harmonics) that flattens with distance.
  float ang = atan(vQuad.y, vQuad.x);
  float billow = uBillow * 0.5 * (sin(ang * 5.0 + vSeed * 30.0) * 0.6
    + sin(ang * 8.0 + vSeed * 17.0) * 0.4) * (1.0 - 0.7 * distF);
  float edge = 1.0 + billow;
  // Fuzz = fraction of radius, smaller at distance → far = crisp/solid.
  float fuzz = mix(uFuzzClose, uFuzzFar, distF);
  float aMask = smoothstep(edge, edge - max(0.01, fuzz), r);
  if (aMask < 0.003) discard;

  // Flat terminator shading on the cloud's up (true billboard, no per-pixel
  // normal). Day side bright, night dark.
  float d = dot(vUp, uSunDirW);
  float dayT = smoothstep(-0.15, 0.2, d);
  float lit = mix(1.0,
    mix(${NIGHT_AMBIENT.toFixed(2)}, 1.0, dayT) * (0.7 + 0.3 * max(d, 0.0)), uHasSun);
  vec3 col = vColor * lit;
  // Soft silhouette brighten — the backlit-edge "this is a cloud" cue.
  col += uRim * smoothstep(edge - 0.4, edge, r) * vColor * (0.4 + 0.6 * lit);

  float a = vFade * aMask * uOpacity;
  if (a < hashedAlphaThreshold(vFragW, vSeed)) discard;

  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

// ── Shell shaders (copied from cloud-system.ts — far field + crossfade) ─────
// Identical to the shipping shell so the A/B differs ONLY in the near field.

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

const _samplePosTmp = new THREE.Vector3();
const _sampleOut: CloudSample = {
  density: 0,
  color: new THREE.Color(),
  layerIndex: -1,
  cumuliformity: 0,
  storm: 0,
};
const _blobSample: CloudSample = {
  density: 0,
  color: new THREE.Color(),
  layerIndex: -1,
  cumuliformity: 0,
  storm: 0,
};
const _blobPos = new THREE.Vector3();
const _synTmp: SynopticSample = { cover: 0, vigor: 0, zoneT: 0, storm: 0 };
const _coarseCol = new THREE.Color();
const _sunLocal = new THREE.Vector3();
const _sunDirW = new THREE.Vector3();
const _invParent = new THREE.Matrix4();

/** Geometry of one blob at one grid cell — pure function of (cell, field,
 *  time), independent of the camera, so it caches across a rebuild and is
 *  SHARED between a fine blob (as itself) and a coarse blob (as a parent that
 *  fine children collapse onto). That sharing is what makes the LOD handoff a
 *  refinement instead of a dissolve. */
interface BlobGeom {
  cx: number; cy: number; cz: number;   // planet-local center (snapped)
  ux: number; uy: number; uz: number;   // planet-local up
  rad: number;                          // tangential radius
  squash: number;
  r: number; g: number; b: number;      // tinted color
  seed: number;
}
/** Cache slot — `geom: null` caches "empty sky" (below floor / out of layer) so
 *  clear regions don't re-sample every frame. */
interface BlobCacheEntry { geom: BlobGeom | null; expiresAt: number; }

// ── Implementation ─────────────────────────────────────────────────────────

/** Unit quad (position + uv) for the billboard variant. */
function makeQuadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** 3-D icosphere blobs (the default experimental renderer). */
export function createBlobCloudSystem(opts: CloudSystemOpts): CloudSystem {
  return createBlobLikeSystem(opts, "mesh");
}

/** Same walk/sizing/geomorph, rendered as angle-stretched soft billboards. */
export function createBillboardCloudSystem(opts: CloudSystemOpts): CloudSystem {
  return createBlobLikeSystem(opts, "billboard");
}

function createBlobLikeSystem(
  opts: CloudSystemOpts,
  variant: "mesh" | "billboard",
): CloudSystem {
  let field = opts.field;
  let map: WeatherMap = buildWeatherMap(field, opts.timeSeconds ?? 0);

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
  let shellDebug = 0;
  let opacity = 0;
  let billow = BLOB_BILLOW_AMP;
  let rim = 0.6;
  let sunWorldPos: THREE.Vector3 | null = null;

  // Previous camera position (planet-local) for the speed-adaptive entry band.
  const lastCamLocal = new THREE.Vector3();
  let haveLastCam = false;

  // Blob-geometry cache (BlobGeom). Keyed by cell hash; an entry is shared
  // whether the cell is walked as itself or looked up as a parent that fine
  // children collapse onto — that identity is what makes the LOD handoff a
  // refinement, not a dissolve. Persistent across frames (2-gen + TTL): a cell's
  // geometry depends only on (cell, weather-time), so it survives many frames.
  let blobCacheCur = new Map<number, BlobCacheEntry>();
  let blobCachePrev = new Map<number, BlobCacheEntry>();
  let lastGenSwap = 0;

  // Instance buffers.
  const iCenter = new Float32Array(MAX_BLOBS * 3);
  const iUp = new Float32Array(MAX_BLOBS * 3);
  const iColor = new Float32Array(MAX_BLOBS * 3);
  const iRadius = new Float32Array(MAX_BLOBS);
  const iSquash = new Float32Array(MAX_BLOBS);
  const iSeed = new Float32Array(MAX_BLOBS);
  const iFade = new Float32Array(MAX_BLOBS);

  const base = variant === "mesh"
    ? new THREE.IcosahedronGeometry(1, BLOB_ICO_DETAIL)
    : makeQuadGeometry();
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = base.index;
  geom.setAttribute("position", base.getAttribute("position"));
  if (variant === "billboard") geom.setAttribute("uv", base.getAttribute("uv"));
  const aCenter = new THREE.InstancedBufferAttribute(iCenter, 3);
  const aUp = new THREE.InstancedBufferAttribute(iUp, 3);
  const aColor = new THREE.InstancedBufferAttribute(iColor, 3);
  const aRadius = new THREE.InstancedBufferAttribute(iRadius, 1);
  const aSquash = new THREE.InstancedBufferAttribute(iSquash, 1);
  const aSeed = new THREE.InstancedBufferAttribute(iSeed, 1);
  const aFade = new THREE.InstancedBufferAttribute(iFade, 1);
  geom.setAttribute("iCenter", aCenter);
  geom.setAttribute("iUp", aUp);
  geom.setAttribute("iColor", aColor);
  geom.setAttribute("iRadius", aRadius);
  geom.setAttribute("iSquash", aSquash);
  geom.setAttribute("iSeed", aSeed);
  geom.setAttribute("iFade", aFade);
  geom.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uHasSun: { value: 0 },
      uOpacity: { value: 0 },
      uRim: { value: rim },
      uBillow: { value: billow },
      uNearFadeBand: { value: NEAR_BAND_MIN },
      uFeather: { value: ENTRY_FEATHER },
      uInside: { value: 0 },
      // Billboard-only (ignored by the mesh shader; harmless extras).
      uFuzzClose: { value: FUZZ_CLOSE },
      uFuzzFar: { value: FUZZ_FAR },
      uFuzzFarDist: { value: FUZZ_FAR_DIST },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    },
    vertexShader: variant === "mesh" ? BLOB_VERT : BILLBOARD_VERT,
    fragmentShader: variant === "mesh" ? BLOB_FRAG : BILLBOARD_FRAG,
    transparent: false,   // OPAQUE — dithered discard handles fade, no sort
    depthTest: true,
    depthWrite: true,
    fog: true,
    // WebGL2 (three's default) has dFdx/dFdy as core GLSL — no extension flag.
  });

  const blobs = new THREE.Mesh(geom, material);
  blobs.name = variant === "mesh" ? "cloud_blobs" : "cloud_blob_billboards";
  blobs.frustumCulled = false;
  blobs.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_blob_system";
  group.add(blobs);

  // Weather-map texture (shared bytes with the CPU sampler).
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

  // ── Shells (one per layer) — copied build from cloud-system.ts ───────────
  interface ShellEntry {
    material: THREE.ShaderMaterial;
    mesh: THREE.Mesh;
  }
  let shells: ShellEntry[] = [];
  function buildShells(): void {
    for (const shell of shells) {
      group.remove(shell.mesh);
      shell.mesh.geometry.dispose();
      shell.material.dispose();
    }
    shells = [];
    const SHELL_W_SEG = 128;
    const SHELL_H_SEG = 96;
    const segAngle = (2 * Math.PI) / SHELL_W_SEG;
    const chordSag = field.planetRadiusM * segAngle * segAngle / 8;
    for (let li = 0; li < field.layers.length; li++) {
      const layer = field.layers[li];
      const shellRadiusM = field.planetRadiusM
        + (layer.baseAltitudeM + layer.topAltitudeM) * 0.5
        + chordSag * 1.3;
      const shellMat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: mapTexture },
          uTime: { value: 0 },
          uEpoch: { value: 0 },
          uWindMult: { value: 1 },
          uJetSpeed: { value: field.synoptic.jetSpeedMs },
          uBandCells: { value: field.synoptic.bandCells },
          uPlanetRadius: { value: field.planetRadiusM },
          uLonOffset: { value: layer.mapLonOffsetRad },
          uCoverageMul: { value: layer.coverageMul },
          uZoneColor: { value: layer.zoneColor.clone() },
          uBeltColor: { value: layer.beltColor.clone() },
          uDetailScale: { value: layer.detailScaleM * 6 },
          uDetailAmp: { value: 0.35 },
          uSeed: { value: field.seed },
          uSunPosW: { value: new THREE.Vector3() },
          uHasSun: { value: 0 },
          uReach: { value: 240_000 },
          uOpacity: { value: opacity },
          uLayerDensity: { value: layer.density },
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        },
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
        side: THREE.DoubleSide,
      });
      const shellMesh = new THREE.Mesh(
        new THREE.SphereGeometry(shellRadiusM, SHELL_W_SEG, SHELL_H_SEG),
        shellMat,
      );
      shellMesh.name = `cloud_blob_shell_${li}`;
      shellMesh.frustumCulled = false;
      shellMesh.renderOrder = 1;
      group.add(shellMesh);
      shells.push({ material: shellMat, mesh: shellMesh });
    }
  }
  buildShells();

  // ── Bake pacing (copied) ─────────────────────────────────────────────────
  let initialSweepDone = false;
  const INITIAL_SWEEP_BUDGET_MS = 4;
  function bakeTick(timeSeconds: number): void {
    const budget = initialSweepDone
      ? bakeBudgetMs
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
      const measured = Math.min(10, spent / res.rows);
      msPerRowEma = msPerRowEma * 0.8 + measured * 0.2;
      rowsSinceUpload += res.rows;
      if (res.wrapped) initialSweepDone = true;
      if (rowsSinceUpload >= TEXTURE_UPLOAD_ROW_BATCH || res.wrapped) {
        mapTexture.needsUpdate = true;
        rowsSinceUpload = 0;
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

  function update(
    cameraLocalPos: THREE.Vector3,
    timeSeconds: number,
    cameraLocalForward?: THREE.Vector3,
  ): void {
    lastTimeSeconds = timeSeconds;
    if (field.layers.length === 0) {
      geom.instanceCount = 0;
      cloudBlobStats.sprites = 0;
      return;
    }

    const statT0 = performance.now();
    bakeTick(timeSeconds);
    cloudBlobStats.bakeMs = performance.now() - statT0;
    cloudBlobStats.cellsIterated = 0;
    cloudBlobStats.cellsPassed = 0;
    const statT1 = performance.now();

    const hasSun = computeSunLocal();
    // Sun direction in WORLD space for the blob shader (its normals are world).
    if (hasSun && sunWorldPos) {
      _sunDirW.copy(sunWorldPos).sub(group.getWorldPosition(_samplePosTmp)).normalize();
      material.uniforms.uSunDirW.value.copy(_sunDirW);
    }
    material.uniforms.uHasSun.value = hasSun ? 1 : 0;
    material.uniforms.uOpacity.value = opacity;
    material.uniforms.uRim.value = rim;
    material.uniforms.uBillow.value = billow;

    // Speed-adaptive cloud-entry band: widen the near-plane dissolve with how
    // far the camera moved this frame, so a fast fly-through dissolves the
    // surface over several frames instead of flashing a hard cross-section.
    let perFrameMove = 0;
    if (haveLastCam) perFrameMove = cameraLocalPos.distanceTo(lastCamLocal);
    lastCamLocal.copy(cameraLocalPos);
    haveLastCam = true;
    material.uniforms.uNearFadeBand.value = Math.min(
      NEAR_BAND_MAX,
      Math.max(NEAR_BAND_MIN, NEAR_BAND_SPEED_N * perFrameMove),
    );
    // Cloud density at the camera → "insideness": when enveloped, the fog owns
    // the look and the surface feather is suppressed (no grain in the soup).
    cloudDensityAt(field, map, cameraLocalPos, timeSeconds, sampleOpts, _sampleOut);
    material.uniforms.uInside.value = _sampleOut.density;

    let layerMinAlt = Infinity;
    let layerMaxAlt = -Infinity;
    let minDetailScale = Infinity;
    for (const layer of field.layers) {
      if (layer.baseAltitudeM < layerMinAlt) layerMinAlt = layer.baseAltitudeM;
      if (layer.topAltitudeM > layerMaxAlt) layerMaxAlt = layer.topAltitudeM;
      if (layer.detailScaleM < minDetailScale) minDetailScale = layer.detailScaleM;
    }
    // A cell wider than the detail scale straddles cloud + gap, so its center
    // sample is unrepresentative — that's the coarse-tier hole/pop. Such cells
    // get footprint sub-sampling (below).
    const coarseCellThreshold = minDetailScale;

    const camRadius = cameraLocalPos.length();
    const camAlt = camRadius - field.planetRadiusM;

    const allTiers = activeCloudTiers(field.planetRadiusM);
    const tiers = allTiers.filter(
      (t) => CLOUD_CELL_SIZES_M[t] <= MAX_BILLBOARD_CELL_SIZE_M,
    );
    const tierCount = tiers.length;
    const largestCell = CLOUD_CELL_SIZES_M[tiers[tierCount - 1]];
    const maxReachM = largestCell * 12;

    for (const shell of shells) {
      const u = shell.material.uniforms;
      u.uTime.value = timeSeconds;
      u.uEpoch.value = map.epochSec;
      u.uWindMult.value = sampleOpts.windMult;
      u.uReach.value = maxReachM;
      u.uDetailAmp.value = 0.35 * shellDetailMult;
      u.uHasSun.value = hasSun ? 1 : 0;
      u.uOpacity.value = opacity;
      if (hasSun && sunWorldPos) u.uSunPosW.value.copy(sunWorldPos);
    }

    updateCounter++;
    if (updateCounter % Math.max(1, Math.round(updateInterval)) !== 0) {
      cloudBlobStats.walkMs = 0;
      return;
    }

    if (camAlt - layerMaxAlt > maxReachM) {
      geom.instanceCount = 0;
      cloudBlobStats.sprites = 0;
      return;
    }

    let count = 0;
    let sampleBudget = MAX_FRESH_SAMPLES_PER_REBUILD;
    const planetRadius = field.planetRadiusM;
    const tierCellCount = CLOUD_CELL_SIZES_M.length;
    // View-cone cull setup (only if a forward direction was supplied).
    const cullEnabled = cameraLocalForward !== undefined;
    const fwdX = cameraLocalForward ? cameraLocalForward.x : 0;
    const fwdY = cameraLocalForward ? cameraLocalForward.y : 0;
    const fwdZ = cameraLocalForward ? cameraLocalForward.z : 0;
    // Retire cells the camera flew away from: swap generations periodically
    // (entries also expire by TTL). NOT cleared every rebuild — that's the whole
    // point of cross-frame caching.
    if (timeSeconds - lastGenSwap > CACHE_GEN_SECONDS) {
      const tmp = blobCachePrev;
      blobCachePrev = blobCacheCur;
      tmp.clear();
      blobCacheCur = tmp;
      lastGenSwap = timeSeconds;
    }

    // Pure (camera-independent) blob geometry at a grid cell, cached + shared.
    // Returns null for cells outside the layer or below the density floor.
    function computeBlob(tierIdx: number, ix: number, iy: number, iz: number): BlobGeom | null {
      const key = hashCell(field.seed, tierIdx, ix, iy, iz);
      let ce = blobCacheCur.get(key);
      if (!ce) {
        ce = blobCachePrev.get(key);
        if (ce) blobCacheCur.set(key, ce); // promote into the live generation
      }
      if (ce && timeSeconds < ce.expiresAt) return ce.geom;
      if (sampleBudget <= 0) return ce ? ce.geom : null; // reuse stale if starved
      // Staggered TTL (hash-spread) so refreshes don't clump into one frame.
      const expiresAt = timeSeconds
        + CACHE_TTL_SECONDS * (0.75 + 0.5 * (((key >>> 24) & 0xff) / 255));
      const cs = CLOUD_CELL_SIZES_M[tierIdx];
      const jx = (((key >>> 0) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
      const jy = (((key >>> 8) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
      const jz = (((key >>> 16) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
      let cx = (ix + 0.5 + jx) * cs;
      let cy = (iy + 0.5 + jy) * cs;
      let cz = (iz + 0.5 + jz) * cs;
      let radius = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const alt = radius - planetRadius;
      if (alt < layerMinAlt - cs || alt > layerMaxAlt + cs) {
        blobCacheCur.set(key, { geom: null, expiresAt }); return null;
      }

      // A cell wider than the detail scale (coarse tier) must read the SMOOTH
      // synoptic ENVELOPE — the large-scale cloud fraction — not the detail-
      // carved density. Detail carving (which puff, which gap) is the fine
      // tiers' job; sampling it at coarse spacing renders spurious holes in
      // broken regions that the fine grid fills (the distance pop). So:
      //   coarse → cover envelope (1 map read, size ∝ √cover, no gaps)
      //   fine   → full carved density (puffs + real gaps)
      const sub = cs > coarseCellThreshold;
      let bestD = 0, bR = 0, bG = 0, bB = 0, bCum = 0, bLayer = -1, coverScale = 1;
      sampleBudget--;
      if (sub) {
        const L0 = field.layers[0];
        const lat = Math.asin(Math.max(-1, Math.min(1, cy / radius)));
        const lon = Math.atan2(cz, cx);
        map.sample(lon + L0.mapLonOffsetRad, lat, timeSeconds, sampleOpts.windMult, _synTmp);
        const cover = Math.min(1, _synTmp.cover * L0.coverageMul);
        if (cover < COARSE_COVER_MIN) { blobCacheCur.set(key, { geom: null, expiresAt }); return null; }
        bestD = cover;
        bCum = L0.cumuliformity;
        bLayer = 0;
        _coarseCol.copy(L0.beltColor).lerp(L0.zoneColor, _synTmp.zoneT)
          .multiplyScalar(1 - 0.35 * _synTmp.storm);
        bR = _coarseCol.r; bG = _coarseCol.g; bB = _coarseCol.b;
        coverScale = Math.sqrt(cover); // envelope area → blob radius
      } else {
        _blobPos.set(cx, cy, cz);
        cloudDensityAt(field, map, _blobPos, timeSeconds, sampleOpts, _blobSample, cs, 0xffff);
        if (_blobSample.density < minDensity) { blobCacheCur.set(key, { geom: null, expiresAt }); return null; }
        bestD = _blobSample.density;
        bR = _blobSample.color.r; bG = _blobSample.color.g; bB = _blobSample.color.b;
        bCum = _blobSample.cumuliformity; bLayer = _blobSample.layerIndex;
      }

      const layerIdx = bLayer;
      const layer = layerIdx >= 0 ? field.layers[layerIdx] : field.layers[0];
      const layerThick = layer.topAltitudeM - layer.baseAltitudeM;
      if (cs > layerThick && layerIdx >= 0) {
        const lo = layer.baseAltitudeM + layerThick * 0.35;
        const hiA = layer.baseAltitudeM + layerThick * 0.65;
        const snapped = alt < lo ? lo : alt > hiA ? hiA : alt;
        if (snapped !== alt) {
          const sc = (planetRadius + snapped) / Math.max(1, radius);
          cx *= sc; cy *= sc; cz *= sc;
          radius = planetRadius + snapped;
        }
      }
      const invR = 1 / Math.max(1, radius);
      const fill = 1 + BLOB_FILL_DENSITY_BOOST * Math.min(1, bestD * 1.2);
      const tanRadius = cs * BLOB_RADIUS_CELL_FRAC * fill * coverScale;
      let squash = SQUASH_STRATUS + (SQUASH_CUMULUS - SQUASH_STRATUS) * bCum;
      const maxHalfH = layerThick * 0.6;
      if (tanRadius * squash > maxHalfH) squash = maxHalfH / tanRadius;
      const bg: BlobGeom = {
        cx, cy, cz,
        ux: cx * invR, uy: cy * invR, uz: cz * invR,
        rad: tanRadius, squash,
        r: bR, g: bG, b: bB,
        seed: (key & 0xffff) * 0.001,
      };
      blobCacheCur.set(key, { geom: bg, expiresAt });
      return bg;
    }

    let prevOuterFadeEnd = 0;
    for (let ti = 0; ti < tierCount; ti++) {
      const tier = tiers[ti];
      const cellSize = CLOUD_CELL_SIZES_M[tier];
      const tierStartCount = count;

      const isOutermost = ti === tierCount - 1;

      // Bands TILE (no overlap): this tier's inner edge is the finer tier's
      // outer-fade end. Within [outerExpand, outerFadeEnd] a blob geomorphs onto
      // its coarse parent; the coarser tier resumes at exactly that shape. The
      // OUTERMOST walked tier has no walked parent — it alpha-fades to the shell
      // instead (the shell is its "parent").
      const innerCull = prevOuterFadeEnd;
      // Hold full own-detail across most of the band; confine the collapse to
      // the last stretch (8×→10× cell) right before the coarse tier resumes, so
      // near/mid blobs stay sharp and only merge as they near the handoff.
      const outerExpand = cellSize * 8;
      const outerFadeEnd = isOutermost ? cellSize * 12 : cellSize * 10;
      prevOuterFadeEnd = outerFadeEnd;

      const reach = Math.ceil(outerFadeEnd / cellSize) + 1;
      const outerReject = outerFadeEnd + cellSize * 0.7;
      const outerReject2 = outerReject * outerReject;
      const ixC = Math.floor(cameraLocalPos.x / cellSize);
      const iyC = Math.floor(cameraLocalPos.y / cellSize);
      const izC = Math.floor(cameraLocalPos.z / cellSize);

      const altMargin = cellSize;
      const rLo = Math.max(0, planetRadius + layerMinAlt - altMargin);
      const rHi = planetRadius + layerMaxAlt + altMargin;
      const rLo2 = rLo * rLo;
      const rHi2 = rHi * rHi;
      const iyMinClamp = iyC - reach;
      const iyMaxClamp = iyC + reach;

      for (let dx = -reach; dx <= reach; dx++) {
        const ix = ixC + dx;
        const colX = (ix + 0.5) * cellSize;
        for (let dz = -reach; dz <= reach; dz++) {
          if (count >= MAX_BLOBS) break;
          const iz = izC + dz;
          const colZ = (iz + 0.5) * cellSize;
          const q = colX * colX + colZ * colZ;
          const hi2 = rHi2 - q;
          if (hi2 <= 0) continue;
          const cdx = colX - cameraLocalPos.x;
          const cdz = colZ - cameraLocalPos.z;
          const cyHi = Math.sqrt(hi2);
          const lo2 = rLo2 - q;
          const cyLo = lo2 > 0 ? Math.sqrt(lo2) : 0;

          for (let band = 0; band < 2; band++) {
            let yA: number;
            let yB: number;
            if (band === 0) {
              yA = cyLo > 0 ? cyLo : -cyHi;
              yB = cyHi;
            } else {
              if (cyLo <= 0) break;
              yA = -cyHi; yB = -cyLo;
            }
            let iyMin = Math.floor(yA / cellSize) - 1;
            let iyMax = Math.ceil(yB / cellSize) + 1;
            if (iyMin < iyMinClamp) iyMin = iyMinClamp;
            if (iyMax > iyMaxClamp) iyMax = iyMaxClamp;

            for (let iy = iyMin; iy <= iyMax; iy++) {
              if (count >= MAX_BLOBS) break;
              cloudBlobStats.cellsIterated++;

              const ccy = (iy + 0.5) * cellSize;
              const cdy = ccy - cameraLocalPos.y;
              const cDist2 = cdx * cdx + cdy * cdy + cdz * cdz;
              if (cDist2 > outerReject2) continue;
              const cRad2 = q + ccy * ccy;
              if (cRad2 < rLo2 || cRad2 > rHi2) continue;

              // Own blob (jitter + field sample live in computeBlob, cached).
              const own = computeBlob(tier, ix, iy, iz);
              if (!own) continue;

              const ddx = own.cx - cameraLocalPos.x;
              const ddy = own.cy - cameraLocalPos.y;
              const ddz = own.cz - cameraLocalPos.z;
              const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (dist2 > outerFadeEnd * outerFadeEnd) continue;
              const dist = Math.sqrt(dist2);
              // Inner edge: hard handoff to the finer tier, whose blobs collapse
              // onto these — so the cut is seamless and needs no fade.
              if (dist < innerCull) continue;

              // View-cone cull: drop blobs outside the camera's forward cone
              // (behind / far sides). Blobs near enough that their own radius
              // subtends a wide angle are exempt (center can be out of cone
              // while the blob is on-screen).
              if (cullEnabled && dist > own.rad * 3.0) {
                const fdot = (ddx * fwdX + ddy * fwdY + ddz * fwdZ) / dist;
                if (fdot < CULL_CONE_COS) continue;
              }

              cloudBlobStats.cellsPassed++;

              // Refinement r: 1 = full own detail; ramps to 0 across the outer
              // band where the blob COLLAPSES onto its coarse parent.
              let r = 1;
              if (dist > outerExpand) {
                r = 1 - (dist - outerExpand) / Math.max(1, outerFadeEnd - outerExpand);
              }
              if (r <= 0.001) continue;

              let cx = own.cx, cy = own.cy, cz = own.cz;
              let size = own.rad, squash = own.squash;
              let colR = own.r, colG = own.g, colB = own.b;
              let alpha = 1;

              if (isOutermost) {
                // No walked parent — fade to the shell across the outer band.
                alpha = r;
              } else {
                // Geomorph onto the coarse parent: at r→0 the blob shares the
                // parent's center + size (siblings coincide → the parent blob),
                // so the coarser tier resumes the same shape. Mass-preserving
                // refinement, not a dissolve.
                const pcs = CLOUD_CELL_SIZES_M[tier + 1];
                const parent = computeBlob(
                  tier + 1,
                  Math.floor((ix + 0.5) * cellSize / pcs),
                  Math.floor((iy + 0.5) * cellSize / pcs),
                  Math.floor((iz + 0.5) * cellSize / pcs),
                );
                if (parent) {
                  cx = parent.cx + (own.cx - parent.cx) * r;
                  cy = parent.cy + (own.cy - parent.cy) * r;
                  cz = parent.cz + (own.cz - parent.cz) * r;
                  size = parent.rad + (own.rad - parent.rad) * r;
                  squash = parent.squash + (own.squash - parent.squash) * r;
                  colR = parent.r + (own.r - parent.r) * r;
                  colG = parent.g + (own.g - parent.g) * r;
                  colB = parent.b + (own.b - parent.b) * r;
                } else {
                  // Parent cleared the density floor away — fade out instead.
                  alpha = r;
                }
              }

              const invR2 = 1 / Math.max(1, Math.sqrt(cx * cx + cy * cy + cz * cz));
              const bi3 = count * 3;
              iCenter[bi3 + 0] = cx;
              iCenter[bi3 + 1] = cy;
              iCenter[bi3 + 2] = cz;
              iUp[bi3 + 0] = cx * invR2;
              iUp[bi3 + 1] = cy * invR2;
              iUp[bi3 + 2] = cz * invR2;
              iColor[bi3 + 0] = colR;
              iColor[bi3 + 1] = colG;
              iColor[bi3 + 2] = colB;
              iRadius[count] = size;
              iSquash[count] = squash;
              iSeed[count] = own.seed;
              iFade[count] = alpha;
              count++;
            }
          }
        }
        if (count >= MAX_BLOBS) break;
      }
      cloudBlobStats.tierSprites[ti] = count - tierStartCount;
    }
    for (let ti = tierCount; ti < cloudBlobStats.tierSprites.length; ti++) {
      cloudBlobStats.tierSprites[ti] = 0;
    }

    cloudBlobStats.walkMs = performance.now() - statT1;

    if (count === 0) {
      geom.instanceCount = 0;
      cloudBlobStats.sprites = 0;
      return;
    }

    aCenter.needsUpdate = true;
    aUp.needsUpdate = true;
    aColor.needsUpdate = true;
    aRadius.needsUpdate = true;
    aSquash.needsUpdate = true;
    aSeed.needsUpdate = true;
    aFade.needsUpdate = true;
    geom.instanceCount = count;
    cloudBlobStats.sprites = count;
  }

  function fogContribution(
    cameraLocalPos: THREE.Vector3,
    out: { density: number; color: THREE.Color },
  ): void {
    out.density = 0;
    out.color.setRGB(0, 0, 0);
    if (field.layers.length === 0) return;
    cloudDensityAt(field, map, cameraLocalPos, lastTimeSeconds, sampleOpts, _sampleOut);
    out.density = _sampleOut.density;
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
    if (o.shellDebug !== undefined) shellDebug = o.shellDebug;
    // Reuse the spriteOversize slider as the rim-strength knob in the lab, and
    // detail slider already maps to detailMult; billow stays at default.
  }

  function setSunWorldPos(pos: THREE.Vector3 | null): void {
    if (pos === null) {
      sunWorldPos = null;
    } else {
      if (!sunWorldPos) sunWorldPos = new THREE.Vector3();
      sunWorldPos.copy(pos);
    }
  }

  function setProjection(_pixelsPerUnit: number, _viewportHeightPx: number): void {
    // Blob shader is unit-agnostic; the entry band is in meters and driven by
    // camera motion in update(). Nothing projection-dependent to push.
  }

  function setField(f: CloudFieldParams): void {
    field = f;
    mapTexture.dispose();
    map = buildWeatherMap(field, lastTimeSeconds);
    mapTexture = makeMapTexture(map);
    rowsSinceUpload = 0;
    initialSweepDone = false;
    blobCacheCur.clear();
    blobCachePrev.clear();
    buildShells();
    setOpacity(opacity);
  }

  function dispose(): void {
    geom.dispose();
    base.dispose();
    material.dispose();
    mapTexture.dispose();
    for (const shell of shells) {
      shell.mesh.geometry.dispose();
      shell.material.dispose();
    }
  }

  return {
    group,
    setField,
    update,
    setOpacity,
    setRuntimeOpts,
    setSunWorldPos,
    setProjection,
    fogContribution,
    dispose,
  };
}
