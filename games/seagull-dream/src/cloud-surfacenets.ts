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

// ── EXPERIMENT: Surface Nets cloud renderer ────────────────────────────────
//
// See instructions/clouds-renderer-v2-plan.md. The blob/billboard renderers
// place one primitive per field maximum and rely on OVERLAP to read as a mass —
// so a dense field draws many overlapping opaque layers and the fill cost
// scales with TOTAL coverage (made worse because the dithered `discard` defeats
// early-Z). This renderer instead extracts the cloud ISOSURFACE: it samples the
// density field on a local grid around the camera, finds the cells straddling
// the threshold (the cloud boundary), drops one vertex per boundary cell, and
// stitches them into a mesh (naive/smooth Surface Nets). Only the SURFACE is
// drawn, so a dense field costs the same as a sparse one — and a real mesh has
// real normals, giving correct world-anchored shading for free.
//
// Scope (v1): single-resolution grid over a ~7 km patch, the shipping shell for
// the far field, threshold = minDensity (so it matches the cover slider + fog).

const SURF_GRID_M = 600;          // grid resolution (coarse v1)
const SURF_REACH_M = 7200;        // horizontal half-extent of the patch
const SURF_VERT_MARGIN_M = 600;   // altitude margin so the surface caps cleanly
// Billow: high-frequency 3-D noise added to density before extraction, so the
// isosurface (and its gradient normals) becomes lumpy cauliflower instead of a
// smooth deck. Wavelengths stay above the grid's Nyquist (~2× cell) or they
// alias. Gated by density so clear sky stays clear.
const SURF_BILLOW_AMP = 0.5;
const SURF_BILLOW_W1 = 2400;
const SURF_BILLOW_W2 = 1500;

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
/** Signed billow ∈ [-1,1], two octaves above the grid's Nyquist. */
function billow3(wx: number, wy: number, wz: number): number {
  const n1 = vnoise3(wx / SURF_BILLOW_W1, wy / SURF_BILLOW_W1, wz / SURF_BILLOW_W1);
  const n2 = vnoise3(wx / SURF_BILLOW_W2 + 11.3, wy / SURF_BILLOW_W2, wz / SURF_BILLOW_W2 + 7.1);
  return (n1 * 0.6 + n2 * 0.4 - 0.5) * 2.0;
}
const DEFAULT_MIN_DENSITY = 0.05;
const DEFAULT_BAKE_BUDGET_MS = 0.5;
const MAX_BAKE_ROWS_PER_FRAME = 16;
const TEXTURE_UPLOAD_ROW_BATCH = 32;
const DEFAULT_UPDATE_INTERVAL = 2;
const NIGHT_AMBIENT = 0.12;
const SHELL_FADE_NEAR_FRAC = 0.55;
const SHELL_FADE_FAR_FRAC = 0.95;

// Buffer caps for the extracted mesh.
const MAX_VERTS = 60000;
const MAX_INDICES = 360000;

/** Per-update perf counters (mirrors cloudSystemStats keys the lab reads). */
export const cloudSurfaceStats = {
  bakeMs: 0,
  walkMs: 0,
  sortMs: 0,
  cellsIterated: 0,
  cellsPassed: 0,
  sprites: 0, // = triangle count here
  tierSprites: [0, 0, 0, 0, 0],
};

// ── Surface material — real normals → banded toon, world-anchored shading ───

const SURF_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCamDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vCamDist = distance(cameraPosition, wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const SURF_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision highp float;
uniform vec3 uSunDirW;
uniform float uHasSun;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uUpW;        // planet-up at the camera (day/night for the patch)
uniform float uReach;     // patch edge (m) — fade to the shell here
uniform float uNearFade;  // near-plane dissolve band (m)
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCamDist;

float dither(vec2 fc) {
  return fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  #include <logdepthbuf_fragment>
  // Double-sided: orient the normal toward the camera.
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vNormal);
  if (dot(N, viewDir) < 0.0) N = -N;

  // Banded toon off the REAL surface normal — correct world-anchored shading.
  float band = clamp(floor((dot(N, uSunDirW) * 0.5 + 0.5) * 3.0) / 3.0 + 0.16, 0.0, 1.0);
  float dayT = smoothstep(-0.15, 0.2, dot(uUpW, uSunDirW));
  float floorLit = mix(${NIGHT_AMBIENT.toFixed(2)}, 0.62, dayT);
  float lit = mix(1.0, mix(floorLit, 1.0, band), uHasSun);
  vec3 col = uColor * lit;

  // Patch-edge fade by HORIZONTAL distance from the camera column (the patch is
  // centered under the camera) — NOT 3-D distance, or a deck viewed from
  // altitude fades just for being far below. Hands to the shell at the boundary.
  // + near-plane dissolve (cloud entry). Dithered discard → no sorting.
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

// ── Shell shaders (copied from cloud-system.ts — far field + crossfade) ─────

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

const _samplePos = new THREE.Vector3();
const _sampleOut: CloudSample = {
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

// 8 cube corners (local 0/1) and the 12 edges (corner index pairs).
const CC: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
];

// ── Implementation ─────────────────────────────────────────────────────────

export function createSurfaceNetsCloudSystem(opts: CloudSystemOpts): CloudSystem {
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
  let opacity = 0;
  let sunWorldPos: THREE.Vector3 | null = null;

  // ── Surface mesh ────────────────────────────────────────────────────────
  const positions = new Float32Array(MAX_VERTS * 3);
  const normals = new Float32Array(MAX_VERTS * 3);
  const indices = new Uint32Array(MAX_INDICES);
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const normAttr = new THREE.BufferAttribute(normals, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  normAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("normal", normAttr);
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uHasSun: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0xf2f4f7) },
      uUpW: { value: new THREE.Vector3(0, 1, 0) },
      uReach: { value: SURF_REACH_M },
      uNearFade: { value: 80 },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    },
    vertexShader: SURF_VERT,
    fragmentShader: SURF_FRAG,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  const surfMesh = new THREE.Mesh(geom, material);
  surfMesh.name = "cloud_surface";
  surfMesh.frustumCulled = false;
  surfMesh.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_surfacenets_system";
  group.add(surfMesh);

  // Density grid scratch (reallocated if dims grow).
  let gridData = new Float32Array(0);
  let gridDims = [0, 0, 0];
  let cellVert = new Int32Array(0);

  // ── Weather-map texture + shells (copied from cloud-blobs) ────────────────
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
          uReach: { value: SURF_REACH_M / SHELL_FADE_NEAR_FRAC },
          uOpacity: { value: opacity }, uLayerDensity: { value: layer.density },
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        },
        vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
        transparent: true, depthTest: true, depthWrite: false,
        blending: THREE.NormalBlending, fog: true, side: THREE.DoubleSide,
      });
      const shellMesh = new THREE.Mesh(
        new THREE.SphereGeometry(shellRadiusM, SHELL_W_SEG, SHELL_H_SEG), shellMat,
      );
      shellMesh.name = `cloud_surf_shell_${li}`;
      shellMesh.frustumCulled = false;
      shellMesh.renderOrder = 1;
      group.add(shellMesh);
      shells.push({ material: shellMat, mesh: shellMesh });
    }
  }
  buildShells();

  // ── Bake pacing (copied) ──────────────────────────────────────────────────
  let initialSweepDone = false;
  const INITIAL_SWEEP_BUDGET_MS = 4;
  function bakeTick(timeSeconds: number): void {
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

  /** Sample the density grid around the camera and extract the isosurface. */
  function rebuildSurface(cameraLocalPos: THREE.Vector3, timeSeconds: number): void {
    const R = field.planetRadiusM;
    // Tangent frame at the camera's ground point.
    _up.copy(cameraLocalPos).normalize();
    _east.crossVectors(_yAxis, _up);
    if (_east.lengthSq() < 1e-6) _east.set(1, 0, 0); // pole guard
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
    _ground.copy(_up).multiplyScalar(R); // planet-local point under the camera

    // v1 extracts only the MAIN deck (layer 0): a thin smooth cirrus veil on top
    // would otherwise cap the stack flat (hiding the deck's bumps) and double the
    // grid's vertical span. Span = the deck's altitude band + a margin so the
    // surface caps cleanly where the profile falls to zero.
    const L0 = field.layers[0];
    const altBase = L0.baseAltitudeM - SURF_VERT_MARGIN_M;
    const altTop = L0.topAltitudeM + SURF_VERT_MARGIN_M;

    const nu = Math.floor((2 * SURF_REACH_M) / SURF_GRID_M) + 1;
    const nv = nu;
    const nw = Math.max(2, Math.floor((altTop - altBase) / SURF_GRID_M) + 1);
    const nCorners = nu * nv * nw;
    if (gridData.length < nCorners) gridData = new Float32Array(nCorners);
    gridDims = [nu, nv, nw];
    const nCells = (nu - 1) * (nv - 1) * (nw - 1);
    if (cellVert.length < nCells) cellVert = new Int32Array(nCells);

    // Mesh anchor = ground point → vertex positions are stored RELATIVE to it
    // (small, so float32 stays precise at planetary radius).
    surfMesh.position.copy(_ground);

    // ── 1. Sample density at every corner. gridData = density − threshold.
    let samples = 0;
    const ex = _east.x, ey = _east.y, ez = _east.z;
    const nx = _north.x, ny = _north.y, nz = _north.z;
    const ux = _up.x, uy = _up.y, uz = _up.z;
    const gx = _ground.x, gy = _ground.y, gz = _ground.z;
    for (let iw = 0; iw < nw; iw++) {
      const a = altBase + iw * SURF_GRID_M;
      for (let iv = 0; iv < nv; iv++) {
        const off = iv * SURF_GRID_M - SURF_REACH_M;
        for (let iu = 0; iu < nu; iu++) {
          const ou = iu * SURF_GRID_M - SURF_REACH_M;
          const wx = gx + ex * ou + nx * off + ux * a;
          const wy = gy + ey * ou + ny * off + uy * a;
          const wz = gz + ez * ou + nz * off + uz * a;
          _samplePos.set(wx, wy, wz);
          cloudDensityAt(field, map, _samplePos, timeSeconds, sampleOpts, _sampleOut, SURF_GRID_M, 1);
          samples++;
          // Roughen the surface with billow, gated by density so clear sky stays
          // clear (no spurious puffs) — bumps only the existing cloud boundary.
          const dbase = _sampleOut.density;
          const gate = Math.min(1, dbase / Math.max(1e-3, minDensity));
          const d = dbase + billow3(wx, wy, wz) * SURF_BILLOW_AMP * gate;
          gridData[iu + iv * nu + iw * nu * nv] = d - minDensity;
        }
      }
    }
    cloudSurfaceStats.cellsIterated = samples;

    // ── 2. Place one vertex per surface cell (avg of edge crossings).
    cellVert.fill(-1, 0, nCells);
    let vCount = 0;
    const g = new Float32Array(8);
    for (let cw = 0; cw < nw - 1; cw++) {
      for (let cv = 0; cv < nv - 1; cv++) {
        for (let cu = 0; cu < nu - 1; cu++) {
          const base = cu + cv * nu + cw * nu * nv;
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            const cc = CC[c];
            const val = gridData[base + cc[0] + cc[1] * nu + cc[2] * nu * nv];
            g[c] = val;
            if (val > 0) mask |= 1 << c; // inside = density above threshold
          }
          if (mask === 0 || mask === 255) continue;
          let vu = 0, vv = 0, vw = 0, ec = 0;
          for (let e = 0; e < 12; e++) {
            const a0 = EDGES[e][0], b0 = EDGES[e][1];
            const ga = g[a0], gb = g[b0];
            if ((ga > 0) === (gb > 0)) continue;
            const t = ga / (ga - gb); // crossing (where density − threshold = 0)
            vu += CC[a0][0] + t * (CC[b0][0] - CC[a0][0]);
            vv += CC[a0][1] + t * (CC[b0][1] - CC[a0][1]);
            vw += CC[a0][2] + t * (CC[b0][2] - CC[a0][2]);
            ec++;
          }
          if (ec === 0 || vCount >= MAX_VERTS) continue;
          const inv = 1 / ec;
          const fu = cu + vu * inv, fv = cv + vv * inv, fw = cw + vw * inv;
          const ou = fu * SURF_GRID_M - SURF_REACH_M;
          const offv = fv * SURF_GRID_M - SURF_REACH_M;
          const a = altBase + fw * SURF_GRID_M;
          // Position RELATIVE to the ground anchor (small).
          const v3 = vCount * 3;
          positions[v3] = ex * ou + nx * offv + ux * a;
          positions[v3 + 1] = ey * ou + ny * offv + uy * a;
          positions[v3 + 2] = ez * ou + nz * offv + uz * a;
          // Outward normal from the density GRADIENT — free (uses the 8 corners
          // already gathered), smooth, and winding-independent. Outward = toward
          // DECREASING density, so negate the gradient.
          const gu = (g[1] + g[3] + g[5] + g[7]) - (g[0] + g[2] + g[4] + g[6]);
          const gv = (g[2] + g[3] + g[6] + g[7]) - (g[0] + g[1] + g[4] + g[5]);
          const gw = (g[4] + g[5] + g[6] + g[7]) - (g[0] + g[1] + g[2] + g[3]);
          let nwx = -(gu * ex + gv * nx + gw * ux);
          let nwy = -(gu * ey + gv * ny + gw * uy);
          let nwz = -(gu * ez + gv * nz + gw * uz);
          const nl = Math.sqrt(nwx * nwx + nwy * nwy + nwz * nwz);
          if (nl > 1e-9) { nwx /= nl; nwy /= nl; nwz /= nl; } else { nwx = ux; nwy = uy; nwz = uz; }
          normals[v3] = nwx; normals[v3 + 1] = nwy; normals[v3 + 2] = nwz;
          cellVert[cu + cv * (nu - 1) + cw * (nu - 1) * (nv - 1)] = vCount;
          vCount++;
        }
      }
    }

    // ── 3. Connect quads across surface-crossing grid edges (indices only;
    // normals already come from the gradient).
    let iCount = 0;
    const cni = nu - 1, cnj = nv - 1; // cell-grid strides
    const cellId = (cu: number, cv: number, cw: number) => cu + cv * cni + cw * cni * cnj;
    const emitQuad = (va: number, vb: number, vc: number, vd: number): void => {
      if (va < 0 || vb < 0 || vc < 0 || vd < 0) return;
      if (iCount + 6 > MAX_INDICES) return;
      indices[iCount++] = va; indices[iCount++] = vb; indices[iCount++] = vc;
      indices[iCount++] = va; indices[iCount++] = vc; indices[iCount++] = vd;
    };

    for (let iw = 0; iw < nw; iw++) {
      for (let iv = 0; iv < nv; iv++) {
        for (let iu = 0; iu < nu; iu++) {
          const idx = iu + iv * nu + iw * nu * nv;
          const in0 = gridData[idx] > 0;
          // +u edge → 4 cells in the (v,w) plane share it.
          if (iu < nu - 1 && iv > 0 && iw > 0) {
            const in1 = gridData[idx + 1] > 0;
            if (in0 !== in1) {
              const a = cellVert[cellId(iu, iv - 1, iw - 1)];
              const b = cellVert[cellId(iu, iv, iw - 1)];
              const c = cellVert[cellId(iu, iv, iw)];
              const d = cellVert[cellId(iu, iv - 1, iw)];
              if (in0) emitQuad(a, b, c, d); else emitQuad(a, d, c, b);
            }
          }
          // +v edge → 4 cells in the (u,w) plane.
          if (iv < nv - 1 && iu > 0 && iw > 0) {
            const in1 = gridData[idx + nu] > 0;
            if (in0 !== in1) {
              const a = cellVert[cellId(iu - 1, iv, iw - 1)];
              const b = cellVert[cellId(iu, iv, iw - 1)];
              const c = cellVert[cellId(iu, iv, iw)];
              const d = cellVert[cellId(iu - 1, iv, iw)];
              if (in0) emitQuad(a, d, c, b); else emitQuad(a, b, c, d);
            }
          }
          // +w edge → 4 cells in the (u,v) plane.
          if (iw < nw - 1 && iu > 0 && iv > 0) {
            const in1 = gridData[idx + nu * nv] > 0;
            if (in0 !== in1) {
              const a = cellVert[cellId(iu - 1, iv - 1, iw)];
              const b = cellVert[cellId(iu, iv - 1, iw)];
              const c = cellVert[cellId(iu, iv, iw)];
              const d = cellVert[cellId(iu - 1, iv, iw)];
              if (in0) emitQuad(a, b, c, d); else emitQuad(a, d, c, b);
            }
          }
        }
      }
    }

    posAttr.needsUpdate = true;
    normAttr.needsUpdate = true;
    geom.index!.needsUpdate = true;
    geom.setDrawRange(0, iCount);
    cloudSurfaceStats.cellsPassed = vCount;
    cloudSurfaceStats.sprites = iCount / 3; // triangles
  }

  function update(
    cameraLocalPos: THREE.Vector3, timeSeconds: number, _fwd?: THREE.Vector3,
  ): void {
    lastTimeSeconds = timeSeconds;
    if (field.layers.length === 0) { geom.setDrawRange(0, 0); cloudSurfaceStats.sprites = 0; return; }

    const t0 = performance.now();
    bakeTick(timeSeconds);
    cloudSurfaceStats.bakeMs = performance.now() - t0;

    const hasSun = computeSunLocal();
    if (hasSun && sunWorldPos) {
      _sunDirW.copy(sunWorldPos).sub(group.getWorldPosition(_samplePos)).normalize();
      material.uniforms.uSunDirW.value.copy(_sunDirW);
    }
    material.uniforms.uHasSun.value = hasSun ? 1 : 0;
    material.uniforms.uOpacity.value = opacity;
    material.uniforms.uUpW.value.copy(cameraLocalPos).normalize()
      .applyQuaternion(group.getWorldQuaternion(_tmpQuat));

    // Shell uniforms (every frame for smooth drift).
    const maxReachM = SURF_REACH_M / SHELL_FADE_NEAR_FRAC;
    for (const shell of shells) {
      const u = shell.material.uniforms;
      u.uTime.value = timeSeconds; u.uEpoch.value = map.epochSec;
      u.uWindMult.value = sampleOpts.windMult; u.uReach.value = maxReachM;
      u.uDetailAmp.value = 0.35 * shellDetailMult; u.uHasSun.value = hasSun ? 1 : 0;
      u.uOpacity.value = opacity;
      if (hasSun && sunWorldPos) u.uSunPosW.value.copy(sunWorldPos);
    }

    updateCounter++;
    if (updateCounter % Math.max(1, Math.round(updateInterval)) !== 0) {
      cloudSurfaceStats.walkMs = 0;
      return;
    }

    const t1 = performance.now();
    rebuildSurface(cameraLocalPos, timeSeconds);
    cloudSurfaceStats.walkMs = performance.now() - t1;
  }
  const _tmpQuat = new THREE.Quaternion();

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
    mapTexture.dispose();
    map = buildWeatherMap(field, lastTimeSeconds);
    mapTexture = makeMapTexture(map);
    rowsSinceUpload = 0; initialSweepDone = false;
    if (field.layers.length > 0) {
      material.uniforms.uColor.value.copy(field.layers[0].zoneColor);
    }
    buildShells();
    setOpacity(opacity);
  }
  function dispose(): void {
    geom.dispose(); material.dispose(); mapTexture.dispose();
    for (const shell of shells) { shell.mesh.geometry.dispose(); shell.material.dispose(); }
  }

  if (field.layers.length > 0) material.uniforms.uColor.value.copy(field.layers[0].zoneColor);

  return {
    group, setField, update, setOpacity, setRuntimeOpts,
    setSunWorldPos, setProjection, fogContribution, dispose,
  };
}
