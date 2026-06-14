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
import type { WeatherMap } from "./weather-map";
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

// LOD constants — mirror cloud-system.ts so the A/B is apples-to-apples.
const EXPAND_FACTOR = 4;
const FADE_FACTOR = 1.6;
const MAX_BLOBS = 14000;
const POSITION_JITTER = 0.42;
const MAX_BILLBOARD_CELL_SIZE_M = 20_000;
const SHELL_FADE_NEAR_FRAC = 0.55;
const SHELL_FADE_FAR_FRAC = 0.95;
const DEFAULT_MIN_DENSITY = 0.05;
const DEFAULT_BAKE_BUDGET_MS = 0.5;
const MAX_BAKE_ROWS_PER_FRAME = 16;
const DEFAULT_UPDATE_INTERVAL = 2;
const MAX_FRESH_SAMPLES_PER_REBUILD = 1400;
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
uniform float uNearFadeBand; // meters — near-plane dissolve width
uniform float uCamNear;

varying vec3 vColor;
varying vec3 vWorldPos;
varying vec3 vUp;
varying float vFade;
varying float vSeed;
varying float vUpCoord;

// Ordered-ish hashed dither so fade/dissolve need no back-to-front sort.
float dither(vec2 fc, float seed) {
  return fract(sin(dot(fc + seed, vec2(12.9898, 78.233))) * 43758.5453);
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
  float fres = pow(1.0 - max(0.0, dot(N, viewDir)), 3.0);
  col += uRim * fres * vColor * (0.4 + 0.6 * lit);

  // Cloud entry: near-plane soft dissolve. The face nearest the camera goes
  // transparent before it clips, so you never punch through a hard polygon —
  // the fogContribution envelope carries the interior.
  float fragDist = length(cameraPosition - vWorldPos);
  float nearFade = clamp((fragDist - uCamNear) / max(1.0, uNearFadeBand), 0.0, 1.0);

  float a = vFade * nearFade * uOpacity;
  // Dithered (screen-door) discard — order-independent transparency. Solid
  // core blobs (a≈1) stay solid; only fading/edge fragments thin out.
  if (a < dither(gl_FragCoord.xy, vSeed * 7.0)) discard;

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
const _sunLocal = new THREE.Vector3();
const _sunDirW = new THREE.Vector3();
const _invParent = new THREE.Matrix4();

// ── Implementation ─────────────────────────────────────────────────────────

export function createBlobCloudSystem(opts: CloudSystemOpts): CloudSystem {
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

  // Instance buffers.
  const iCenter = new Float32Array(MAX_BLOBS * 3);
  const iUp = new Float32Array(MAX_BLOBS * 3);
  const iColor = new Float32Array(MAX_BLOBS * 3);
  const iRadius = new Float32Array(MAX_BLOBS);
  const iSquash = new Float32Array(MAX_BLOBS);
  const iSeed = new Float32Array(MAX_BLOBS);
  const iFade = new Float32Array(MAX_BLOBS);

  const base = new THREE.IcosahedronGeometry(1, BLOB_ICO_DETAIL);
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = base.index;
  geom.setAttribute("position", base.getAttribute("position"));
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
      uNearFadeBand: { value: 600 },
      uCamNear: { value: 1 },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    },
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    transparent: false,   // OPAQUE — dithered discard handles fade, no sort
    depthTest: true,
    depthWrite: true,
    fog: true,
    // WebGL2 (three's default) has dFdx/dFdy as core GLSL — no extension flag.
  });

  const blobs = new THREE.Mesh(geom, material);
  blobs.name = "cloud_blobs";
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

  function update(cameraLocalPos: THREE.Vector3, timeSeconds: number): void {
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

    let layerMinAlt = Infinity;
    let layerMaxAlt = -Infinity;
    for (const layer of field.layers) {
      if (layer.baseAltitudeM < layerMinAlt) layerMinAlt = layer.baseAltitudeM;
      if (layer.topAltitudeM > layerMaxAlt) layerMaxAlt = layer.topAltitudeM;
    }

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
    let freshSampleBudget = MAX_FRESH_SAMPLES_PER_REBUILD;
    const planetRadius = field.planetRadiusM;

    for (let ti = 0; ti < tierCount; ti++) {
      const tier = tiers[ti];
      const cellSize = CLOUD_CELL_SIZES_M[tier];
      const tierStartCount = count;

      const childTier = ti > 0 ? tiers[ti - 1] : -1;
      const childCellSize = childTier >= 0 ? CLOUD_CELL_SIZES_M[childTier] : 0;
      const isInnermost = ti === 0;
      const isOutermost = ti === tierCount - 1;

      const innerExpand = isInnermost ? 0 : childCellSize * EXPAND_FACTOR;
      const innerFadeEnd = isInnermost ? 0 : innerExpand * FADE_FACTOR;
      const outerExpand = isOutermost ? cellSize * 8 : cellSize * EXPAND_FACTOR;
      const outerFadeEnd = isOutermost ? cellSize * 12 : outerExpand * FADE_FACTOR;

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

              const jh = hashCell(field.seed, tier, ix, iy, iz);
              const jx = (((jh >>> 0) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              const jy = (((jh >>> 8) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              const jz = (((jh >>> 16) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              let cx = (ix + 0.5 + jx) * cellSize;
              let cy = (iy + 0.5 + jy) * cellSize;
              let cz = (iz + 0.5 + jz) * cellSize;

              let radius = Math.sqrt(cx * cx + cy * cy + cz * cz);
              let alt = radius - planetRadius;
              if (alt < layerMinAlt - altMargin || alt > layerMaxAlt + altMargin) continue;

              const ddx = cx - cameraLocalPos.x;
              const ddy = cy - cameraLocalPos.y;
              const ddz = cz - cameraLocalPos.z;
              const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (dist2 > outerFadeEnd * outerFadeEnd) continue;
              const dist = Math.sqrt(dist2);

              let innerWeight = 1;
              if (!isInnermost) {
                if (dist < innerExpand) continue;
                if (dist < innerFadeEnd) {
                  innerWeight = (dist - innerExpand) / Math.max(1, innerFadeEnd - innerExpand);
                }
              }
              let outerWeight = 1;
              if (dist > outerExpand) {
                outerWeight = 1 - (dist - outerExpand) / Math.max(1, outerFadeEnd - outerExpand);
              }
              const fade = innerWeight * outerWeight;
              if (fade < 0.02) continue;

              cloudBlobStats.cellsPassed++;

              // Field sample (no cache in the experiment — fresh, capped).
              if (freshSampleBudget <= 0) continue;
              freshSampleBudget--;
              _samplePosTmp.set(cx, cy, cz);
              cloudDensityAt(field, map, _samplePosTmp, timeSeconds, sampleOpts, _sampleOut, cellSize, 0xffff);
              if (_sampleOut.density < minDensity) continue;

              const layerIdx = _sampleOut.layerIndex;
              const layer = layerIdx >= 0 ? field.layers[layerIdx] : field.layers[0];
              const layerThick = layer.topAltitudeM - layer.baseAltitudeM;
              const cum = _sampleOut.cumuliformity;

              // Snap a coarse-tier blob (cell wider than the layer) into the
              // layer's meaty band so it doesn't float above / sag below.
              if (cellSize > layerThick && layerIdx >= 0) {
                const lo = layer.baseAltitudeM + layerThick * 0.35;
                const hiA = layer.baseAltitudeM + layerThick * 0.65;
                const snapped = alt < lo ? lo : alt > hiA ? hiA : alt;
                if (snapped !== alt) {
                  const sc = (planetRadius + snapped) / Math.max(1, radius);
                  cx *= sc; cy *= sc; cz *= sc;
                  radius = planetRadius + snapped;
                  alt = snapped;
                }
              }

              const invR = 1 / Math.max(1, radius);
              const upX = cx * invR, upY = cy * invR, upZ = cz * invR;

              // Tangential radius fills the cell; dense cells inflate to close
              // inter-cell gaps under solid cover.
              const fill = 1 + BLOB_FILL_DENSITY_BOOST * Math.min(1, _sampleOut.density * 1.2);
              const tanRadius = cellSize * BLOB_RADIUS_CELL_FRAC * fill;

              // Squash along up: stratus → lens, cumulus → ball, but never
              // taller than the layer band.
              let squash = SQUASH_STRATUS + (SQUASH_CUMULUS - SQUASH_STRATUS) * cum;
              const maxHalfH = layerThick * 0.6;
              if (tanRadius * squash > maxHalfH) squash = maxHalfH / tanRadius;

              const bi3 = count * 3;
              iCenter[bi3 + 0] = cx;
              iCenter[bi3 + 1] = cy;
              iCenter[bi3 + 2] = cz;
              iUp[bi3 + 0] = upX;
              iUp[bi3 + 1] = upY;
              iUp[bi3 + 2] = upZ;
              iColor[bi3 + 0] = _sampleOut.color.r;
              iColor[bi3 + 1] = _sampleOut.color.g;
              iColor[bi3 + 2] = _sampleOut.color.b;
              iRadius[count] = tanRadius;
              iSquash[count] = squash;
              iSeed[count] = (jh & 0xffff) * 0.001;
              iFade[count] = fade;
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
    // Blob shader is unit-agnostic; near-fade band is in meters. Keep the near
    // plane in sync for the dissolve.
    material.uniforms.uCamNear.value = 1;
  }

  function setField(f: CloudFieldParams): void {
    field = f;
    mapTexture.dispose();
    map = buildWeatherMap(field, lastTimeSeconds);
    mapTexture = makeMapTexture(map);
    rowsSinceUpload = 0;
    initialSweepDone = false;
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
