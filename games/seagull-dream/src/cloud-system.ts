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

// Per-body cloud renderer.
//
// Three cooperating views of ONE weather authority (the body's baked
// WeatherMap — see weather-map.ts):
//
//   • SHELL (orbit / far) — a sphere mesh per layer whose fragment shader
//     samples the weather map texture directly, with per-latitude zonal
//     scroll and sun shading. What you see from space IS the map.
//   • BILLBOARDS (flight / ground) — a hierarchical 3D cell grid around
//     the camera; each cell samples cloudDensityAt (the same map + local
//     3D detail) and emits a soft Gaussian sprite. Sun-shaded per sprite.
//   • FOG (inside a cloud) — fogContribution samples the same function at
//     the camera so the sky pass can thicken fog when enveloped.
//
// Because billboards and shell read the same bytes, the pattern no longer
// morphs at the LOD crossfade — climbing from the deck to orbit keeps the
// same cyclones in the same places.
//
// LOD fade band — for each billboard tier:
//   • cells closer than `innerExpand` are dropped (child tier covers them)
//   • cells between `innerExpand` and `innerFadeEnd` fade in from 0 → 1
//   • cells between `outerExpand` and `outerFadeEnd` fade out from 1 → 0
//   • cells beyond `outerFadeEnd` are dropped (parent tier covers them, or
//     they're past the planet's visible cloud extent)
// Matches the EXPAND / FADE pattern used by galaxy.ts.
//
// Sorting — sprites must render back-to-front for correct alpha-over
// blending. The candidate buffer carries dist²; we sort indices and
// write the final geometry buffers in sorted order. Cost is bounded
// by MAX_SPRITES (~10⁴) so a single Array.prototype.sort each frame is
// cheap relative to the noise sampling itself.

// LOD constants — same family of numbers as galaxy.ts uses for star cells.
const EXPAND_FACTOR = 4;
const FADE_FACTOR = 1.6;

// Hard upper bound on emitted sprites. Sized for "Earth in close-range
// orbit": ~5k candidates from the outer tier covering the visible
// hemisphere plus ~5k from inner tiers, with up to 3× expansion for
// cumulus parallax in the innermost tier. Buffers preallocated.
const MAX_SPRITES = 24000;

// Cells per LOD tier are jittered by up to ±JITTER × cellSize to break
// the visible cubic-grid pattern. Hash-deterministic, so cells stay in
// the same place across frames and across runs.
const POSITION_JITTER = 0.4;

// ── Cluster emission ───────────────────────────────────────────────────────
// A cell emits a CLOUD, not a sprite. A lone Gaussian circle never reads
// as a cloud — it reads as a ball — so every puff-mode cell emits 3–6
// overlapping puffs with hash-deterministic offsets (stable across
// frames). Cluster geometry is anchored to the LAYER, not the cell cube:
//   • puff diameter ≤ PUFF_LAYER_THICK_FRAC × layer thickness — a 20 km
//     cell becomes a bank of ~5 km puffs, not one 28 km ball (also less
//     GPU fill than the single giant sprite was)
//   • puff bottoms clamp to the layer base (flat condensation-level
//     bases) — big sprites no longer reach below the deck into terrain
//   • tangential spread covers the cell footprint; radial (vertical)
//     spread scales with cumuliformity, and vigorous cells raise a top
//     puff into a tower (subsumes the old parallax stack)
// Cells whose orientation blend is sheet-like (stratus, or any cell far
// enough to collapse to the deck plane) emit tangent DISCS instead —
// they tile cleanly with neighbors and cannot clip terrain. A lone disc
// gets a small companion disc so deck edges don't read as circles.
const SHEET_ORIENTATION_THRESHOLD = 0.75;
const MIN_CLUSTER_PUFFS = 3;
const MAX_CLUSTER_PUFFS = 6;
const PUFF_LAYER_THICK_FRAC = 0.9;
/** Vertical (radial) cluster spread as a fraction of layer thickness,
 *  scaled by cumuliformity. */
const PUFF_RADIAL_SPREAD_FRAC = 0.3;
/** Puff bottoms sit at or above layerBase + radius × this. */
const PUFF_BASE_CLEARANCE = 0.7;
/** Top-puff raise (× puff diameter) for vigorous (cum > 0.5) cells. */
const TOWER_RAISE_FRAC = 0.45;
/** Built-in size factors (the GFX spriteOversize slider multiplies
 *  these). Discs oversize so adjacent deck cells fuse; puffs stay near
 *  true size — their overlap comes from the cluster, not inflation. */
const DISC_OVERSIZE = 1.35;
const PUFF_OVERSIZE = 1.15;

// Largest cell size (m) we render as billboards. Tiers above this are
// handled by the continuous shell mesh, which represents planet-scale
// macro structure as a wrapping sphere — much cleaner than trying to
// draw a 200 km sprite at the cloud altitude.
const MAX_BILLBOARD_CELL_SIZE_M = 20_000;

// Shell crossfade altitudes (m above the layer top). Below LOW, shell
// is hidden — billboards alone render. Above HIGH, shell is fully
// opaque. Because shell and billboards now share the weather map, the
// blend band can be tight without visible pattern swaps.
const SHELL_FADE_LOW_MULT = 2;
const SHELL_FADE_HIGH_MULT = 8;

// Default density floor — below this a cell contributes nothing and is
// dropped before sorting. Live-overridable via setRuntimeOpts.
const DEFAULT_MIN_DENSITY = 0.04;

// Default user sprite-size multiplier. Pure multiplier on top of the
// built-in DISC_OVERSIZE / PUFF_OVERSIZE factors — overlap now comes
// from cluster emission, not from inflating single sprites.
// Live-overridable via setRuntimeOpts.
const DEFAULT_SPRITE_OVERSIZE = 1.0;

// Default per-frame weather-map bake budget (ms). The synoptic field
// re-bakes continuously, a few rows per frame — that's how weather
// evolves. ~0.5 ms sweeps a 512×256 map in roughly 5–15 s.
const DEFAULT_BAKE_BUDGET_MS = 0.5;
const MAX_BAKE_ROWS_PER_FRAME = 16;

// Billboard rebuild cadence. Sprites live in planet-local space (they
// ride the planet's group between rebuilds), so rebuilding the candidate
// set every Nth frame is visually indistinguishable at flight speeds —
// only the LOD fade weights and sun shading go briefly stale. Halves or
// quarters the steady-state walk cost. Live-tunable from the GFX panel.
const DEFAULT_UPDATE_INTERVAL = 2;

// Distance sort buckets for the counting sort. Sprites are translucent
// Gaussians — ordering errors *within* one bucket (≈0.4% of the view
// distance) are invisible, and the counting sort is allocation-free and
// O(n), unlike Array.prototype.sort with a comparator.
//
// SORT_SUB: deterministic per-sprite sub-key within a distance bucket.
// Counting sort is stable w.r.t. INPUT order — but the input order is
// the cell-walk iteration order, which changes as the camera crosses
// cell boundaries (and the column merged/split band logic can outright
// reverse a column's iteration). Same-bucket overlapping sprites then
// swap blend order between frames → visible flicker. A hash-derived
// sub-key pins each sprite's order within its bucket regardless of how
// the walk visited it.
const SORT_BUCKETS = 256;
const SORT_SUB = 16;
const SORT_KEYS = SORT_BUCKETS * SORT_SUB;

// Cap on fresh (cache-miss) field samples per rebuild. In steady flight
// only a few dozen cells miss per frame; the cap exists for cold-cache
// moments (teleport, warp arrival, cache clear) where thousands of cells
// would otherwise sample in one frame. Skipped cells condense in over
// the next few rebuilds — a brief "clouds forming" fade instead of a
// frame hitch.
const MAX_FRESH_SAMPLES_PER_REBUILD = 700;
// Re-upload the DataTexture only every N baked rows (full-texture upload
// is the only path three exposes; batching keeps it off most frames).
const TEXTURE_UPLOAD_ROW_BATCH = 32;

// Cell-sample cache. A cell's field sample depends only on (cell, time)
// — never on the camera — and the field evolves on weather timescales,
// so samples stay valid for many frames. Entries refresh after a TTL
// (staggered per-cell so refreshes don't clump into one frame) and the
// cache runs as two generations swapped every CACHE_GEN_SECONDS, which
// evicts cells the camera has left behind without any bookkeeping.
// This removes ~90% of the noise/map sampling from the steady-state
// frame — the dominant CPU cost on weak hardware.
const CACHE_TTL_SECONDS = 0.7;
const CACHE_GEN_SECONDS = 2.5;

// Sun shading. Sprites and shell darken through the terminator to a dim
// night ambient. Diffuse term brightens cloud tops facing the sun.
const NIGHT_AMBIENT = 0.12;
const SHADE_DIFFUSE_FLOOR = 0.62;
// Vertical brightness gradient across a cluster: cumulus bases read
// darker than their sunlit tops.
const CLUSTER_BASE_DARKEN = 0.18;

/** Per-frame tuning values pushed from the GFX config slider panel. */
export interface CloudSystemRuntimeOpts {
  opacity?: number;
  spriteOversize?: number;
  minDensity?: number;
  /** Drift speed multiplier — scales both the residual map scroll and
   *  the detail-noise advection. 0 freezes the sky. */
  windMult?: number;
  /** Multiplier on detail-noise contrast. */
  detailMult?: number;
  /** Multiplier on the synoptic vigor channel (tower development). */
  vigorMult?: number;
  /** Per-frame weather-map bake budget in ms. 0 freezes evolution. */
  bakeBudgetMs?: number;
  /** Rebuild the billboard set every N update calls (≥1). */
  updateInterval?: number;
}

export interface CloudSystemOpts {
  /** The body's cloud field. Sampled per-frame at cell centers. */
  field: CloudFieldParams;
  /** Sim-time (seconds) at creation — used for the initial map prebake. */
  timeSeconds?: number;
}

export interface CloudSystem {
  /** Root Group. Add this to the body's group so it rotates with the planet. */
  group: THREE.Group;
  /** Set the field (used by debug live-edit). Rebuilds the weather map. */
  setField(field: CloudFieldParams): void;
  /** Per-frame update. cameraLocalPos is the camera in the body's local
   *  frame (after subtracting body.worldPosition and applying
   *  body.inverseOrientation). */
  update(cameraLocalPos: THREE.Vector3, timeSeconds: number): void;
  /** Set the opacity multiplier for the entire cloud system (used by the
   *  mesh-fade-in path so clouds appear with the rest of the body). */
  setOpacity(opacity: number): void;
  /** Push live-edit values from the GFX slider panel. Unset keys leave
   *  the current value untouched. */
  setRuntimeOpts(opts: CloudSystemRuntimeOpts): void;
  /** World-space star position for sun shading (null = unlit). */
  setSunWorldPos(pos: THREE.Vector3 | null): void;
  /** Push the camera projection factor (computeCloudPixelsPerUnit) and
   *  the viewport height in px (near-sprite dissolve scale). */
  setProjection(pixelsPerUnit: number, viewportHeightPx: number): void;
  /** Get the average density + color near the camera (for fog modulation). */
  fogContribution(cameraLocalPos: THREE.Vector3, out: { density: number; color: THREE.Color }): void;
  dispose(): void;
}

// ── Sprite shader ──────────────────────────────────────────────────────────
//
// Vertex: world-space sprite center → clip space. gl_PointSize scaled so
// `size` (in scene meters) projects to the correct pixel size at the
// sprite's view-space distance.
//
// Fragment: analytical Gaussian falloff from gl_PointCoord. Center alpha
// is full, edge alpha decays to zero. No texture lookup — the math is
// cheaper than a 64² CanvasTexture sample and stays sharp at any size.
// Sun shading is baked into the per-sprite color on the CPU.

const VERT = /* glsl */ `
// The renderer runs with logarithmicDepthBuffer — every built-in material
// writes log-encoded gl_FragDepth. Custom shaders MUST include the
// logdepthbuf chunks too, or their depth tests against terrain/ocean are
// comparisons between two unrelated encodings (which displays as clouds
// randomly clipped by / floating over geometry).
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

attribute vec4 color;        // RGB (sun-shaded) + per-sprite alpha
attribute float size;        // sprite diameter in scene meters
attribute float orientation; // 0 = camera-facing puff, 1 = planet-tangent disc

uniform float uPixelsPerUnit;  // canvasHeight × 0.5 / tan(halfFov)
uniform float uOpacity;
uniform float uViewportPx;     // canvas height in px — near-sprite dissolve scale

varying vec4 vColor;

void main() {
  vec4 worldP = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * worldP;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  float dist = max(1.0, -mvPosition.z);

  // Planet-tangent disc mode: shrink the sprite by |dot(viewDir, upDir)|
  // where upDir is the planet-local up at the cell. From above the disc
  // shows at full size; from edge-on it collapses to zero. The model
  // matrix's translation column is the planet center in world space, so
  // upDir is just normalize(worldP - planetCenter).
  vec3 planetCenter = modelMatrix[3].xyz;
  vec3 upDir = normalize(worldP.xyz - planetCenter);
  vec3 viewDir = normalize(cameraPosition - worldP.xyz);
  float facing = abs(dot(viewDir, upDir));
  float orientScale = mix(1.0, facing, orientation);

  float rawPx = size * uPixelsPerUnit / dist * orientScale;

  // Near-sprite dissolve. A gl_Point is culled ENTIRELY the moment its
  // CENTER leaves the frustum, and gl_PointSize silently clamps at the
  // driver limit — so a puff that has grown to screen scale pops in and
  // out as the camera flies past/through it ("clouds jumping around").
  // Fade the sprite out as it approaches screen scale instead: by the
  // time its center can exit the view, it no longer contributes. The
  // "inside a cloud" job is handed to the scene-fog boost
  // (fogContribution), which already models envelopment.
  float nearFade = 1.0 - smoothstep(uViewportPx * 0.75, uViewportPx * 2.0, rawPx);

  // Explicit cap so mid-size sprites degrade predictably on low
  // point-size-limit GPUs rather than at an invisible driver clamp.
  gl_PointSize = min(rawPx, uViewportPx * 2.0);
  vColor = vec4(color.rgb, color.a * uOpacity * nearFade);
}
`;

const FRAG = /* glsl */ `
// Log-depth + fog chunk declarations sit BEFORE the mediump default so
// vFragDepth / vFogDepth stay highp — both hold view-distance-scale
// values (up to 1e7+) that overflow fp16.
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
precision mediump float;
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  // exp(-k r²) Gaussian, normalised so r²=0 → 1 and r²=0.25 → ~0.05.
  // The smoothstep makes the very edge fall to exactly 0 so the sprite
  // has no hard rim.
  float falloff = exp(-r2 * 12.0) * smoothstep(0.25, 0.20, r2);
  float a = vColor.a * falloff;
  if (a < 0.005) discard;
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vColor.rgb, a);
  #include <fog_fragment>
}
`;

// ── Shell shaders (continuous planet-wide layer) ───────────────────────────
//
// Sphere mesh at the layer's mid-altitude. The fragment shader samples
// the body's baked weather-map TEXTURE — the same bytes the billboard
// sampler reads on the CPU — applying the residual zonal scroll since
// the bake epoch (drift math mirrors weather-map.ts exactly). A small
// value-noise octave breaks the bilinear softness at medium range, and
// the sun direction lights the deck through the terminator.
//
// Position is treated as planet-local Cartesian because the shell mesh
// is parented to body.group, which rotates with the planet — so the
// cloud pattern stays attached to the planet's spin.

const SHELL_VERT = /* glsl */ `
// Log-depth + fog chunks — see the billboard VERT comment.
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormalW;
void main() {
  vLocalPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // Sphere centered at local origin → normal is just the normalized
  // local position, rotated to world space.
  vNormalW = normalize(mat3(modelMatrix) * normalize(position));
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

uniform sampler2D uMap;           // synoptic weather (R=cover G=vigor B=zoneT A=storm)
uniform float uTime;
uniform float uEpoch;             // bake epoch — residual drift = uTime - uEpoch
uniform float uWindMult;
uniform float uJetSpeed;          // m/s — must match weather-map.ts zonalSpeedMs
uniform float uBandCells;
uniform float uPlanetRadius;      // m
uniform float uLonOffset;         // per-layer decorrelation (radians)
uniform float uCoverageMul;       // per-layer coverage multiplier
uniform vec3 uZoneColor;
uniform vec3 uBeltColor;
uniform float uDetailScale;       // m — sparkle octave wavelength
uniform float uDetailAmp;
uniform float uSeed;
uniform vec3 uSunPosW;
uniform float uHasSun;            // 0 = unlit
uniform float uShellOpacity;      // camera-altitude crossfade
uniform float uOpacity;           // global cloudMult slider
uniform float uLayerDensity;

varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormalW;

float shellHash(vec3 p) {
  p = fract(p * 0.3183099 + uSeed * 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float shellValueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = shellHash(i);
  float n100 = shellHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = shellHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = shellHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = shellHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = shellHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = shellHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = shellHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

void main() {
  #include <logdepthbuf_fragment>
  float r = length(vLocalPos);
  float lat = asin(clamp(vLocalPos.y / r, -1.0, 1.0));
  float lon = atan(vLocalPos.z, vLocalPos.x);

  // Residual zonal drift since the bake epoch. MUST mirror
  // zonalSpeedMs / zonalDriftRadPerSec in weather-map.ts.
  float zonal = -uJetSpeed * sin(2.0 * uBandCells * lat);
  float drift = zonal / (uPlanetRadius * max(0.08, cos(lat)))
    * (uTime - uEpoch) * uWindMult;

  float u = (lon + uLonOffset - drift) / 6.28318530718 + 0.5;
  float v = clamp(lat / 3.14159265359 + 0.5, 0.0, 1.0);
  vec4 syn = texture2D(uMap, vec2(u, v));

  float cover = syn.r * uCoverageMul;
  if (cover < 0.02) discard;

  // Detail sparkle — two octaves of value noise so the deck isn't a
  // bilinear blur at medium range. Macro structure stays the map's job.
  vec3 dp = vLocalPos / uDetailScale;
  float dn = shellValueNoise(dp) + 0.5 * shellValueNoise(dp * 2.07);
  dn /= 1.5;
  float a = cover * (1.0 + uDetailAmp * (dn - 0.5) * 2.0) * uLayerDensity;
  a = clamp(a, 0.0, 1.0);
  if (a < 0.02) discard;

  vec3 col = mix(uBeltColor, uZoneColor, syn.b);
  col *= 1.0 - 0.35 * syn.a;  // storm darkening — matches cloud-field.ts

  // Sun shading — terminator + diffuse on the deck normal.
  vec3 sunDir = normalize(uSunPosW - vWorldPos);
  float d = dot(vNormalW, sunDir);
  float dayT = smoothstep(-0.12, 0.2, d);
  float lit = 0.12 + 0.88 * dayT * (0.62 + 0.38 * max(d, 0.0));
  col *= mix(1.0, lit, uHasSun);

  gl_FragColor = vec4(col, a * uShellOpacity * uOpacity);
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
const _invParent = new THREE.Matrix4();

/** Per-update perf counters for the debug readout / tuning. */
export const cloudSystemStats = {
  bakeMs: 0,
  walkMs: 0,
  sortMs: 0,
  cellsIterated: 0,
  cellsPassed: 0,
};

// ── Implementation ─────────────────────────────────────────────────────────

export function createCloudSystem(opts: CloudSystemOpts): CloudSystem {
  let field = opts.field;
  let map: WeatherMap = buildWeatherMap(field, opts.timeSeconds ?? 0);

  // Runtime-tunable values (driven from the debug UI).
  let minDensity = DEFAULT_MIN_DENSITY;
  let spriteOversize = DEFAULT_SPRITE_OVERSIZE;
  let bakeBudgetMs = DEFAULT_BAKE_BUDGET_MS;
  const sampleOpts: CloudSampleOpts = { windMult: 1, vigorMult: 1, detailMult: 1 };

  // Adaptive bake pacing — EMA of measured per-row cost converts the ms
  // budget into a row count. Starts PESSIMISTIC (bake one row, measure,
  // speed up) — an optimistic start would blow hundreds of ms on the
  // first frame before the estimate corrects. The deficit accumulator
  // banks budget across frames: when the budget is smaller than one row
  // costs, we bake a row every few frames instead of one EVERY frame,
  // so the configured budget is honored as an average.
  let msPerRowEma = 2.0;
  let bakeDeficitMs = 0;
  let rowsSinceUpload = 0;
  let lastTimeSeconds = 0;
  let updateCounter = 0;
  let updateInterval = DEFAULT_UPDATE_INTERVAL;

  let sunWorldPos: THREE.Vector3 | null = null;

  // GPU buffers.
  const positions = new Float32Array(MAX_SPRITES * 3);
  const colorsRgba = new Float32Array(MAX_SPRITES * 4);
  const sizes = new Float32Array(MAX_SPRITES);
  const orientations = new Float32Array(MAX_SPRITES);

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colorsRgba, 4);
  const sizeAttr = new THREE.BufferAttribute(sizes, 1);
  const orientAttr = new THREE.BufferAttribute(orientations, 1);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colorAttr);
  geom.setAttribute("size", sizeAttr);
  geom.setAttribute("orientation", orientAttr);
  geom.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelsPerUnit: { value: 800 }, // pushed per-frame via setProjection
      uViewportPx: { value: 1080 },   // pushed per-frame via setProjection
      uOpacity: { value: 0 },
      // fog:true below makes the renderer push the scene's FogExp2
      // color/density into these every frame — distant clouds then fade
      // into the same haze as the terrain instead of staying crisp.
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: true,
  });

  const points = new THREE.Points(geom, material);
  points.name = "cloud_sprites";
  // Bounding sphere can't be computed automatically (positions change
  // every frame). The camera-relative iteration bounds visibility.
  points.frustumCulled = false;
  // Render after the shell so sprite detail composites on top of the
  // shell's painted macro layer.
  points.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_system";
  group.add(points);

  // Weather-map texture — shared bytes with the CPU sampler.
  let mapTexture = makeMapTexture(map);

  function makeMapTexture(m: WeatherMap): THREE.DataTexture {
    const tex = new THREE.DataTexture(
      m.data, m.width, m.height, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    tex.wrapS = THREE.RepeatWrapping;       // longitude wraps
    tex.wrapT = THREE.ClampToEdgeWrapping;  // latitude clamps at poles
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  // ── Continuous shells — one per layer ──────────────────────────────────
  interface ShellEntry {
    layerIndex: number;
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
    for (let li = 0; li < field.layers.length; li++) {
      const layer = field.layers[li];
      const shellRadiusM = field.planetRadiusM
        + (layer.baseAltitudeM + layer.topAltitudeM) * 0.5;
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
          uShellOpacity: { value: 0 },
          uOpacity: { value: material.uniforms.uOpacity.value },
          uLayerDensity: { value: layer.density },
          // Renderer-managed FogExp2 uniforms (fog: true).
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        },
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
        // Double-sided so a player descending through the layer still
        // sees the deck overhead from below.
        side: THREE.DoubleSide,
      });
      const shellMesh = new THREE.Mesh(
        new THREE.SphereGeometry(shellRadiusM, 96, 64),
        shellMat,
      );
      shellMesh.name = `cloud_shell_${li}`;
      shellMesh.frustumCulled = false;
      // Renders BEFORE sprites so sprite detail composites on top. Both
      // depth-test against the planet surface and write no depth so they
      // don't occlude each other.
      shellMesh.renderOrder = 1;
      group.add(shellMesh);
      shells.push({ layerIndex: li, material: shellMat, mesh: shellMesh });
    }
  }
  buildShells();

  // Candidate buffer (SoA, sorted in-place by index array).
  const candPosX = new Float32Array(MAX_SPRITES);
  const candPosY = new Float32Array(MAX_SPRITES);
  const candPosZ = new Float32Array(MAX_SPRITES);
  const candColR = new Float32Array(MAX_SPRITES);
  const candColG = new Float32Array(MAX_SPRITES);
  const candColB = new Float32Array(MAX_SPRITES);
  const candAlpha = new Float32Array(MAX_SPRITES);
  const candSize = new Float32Array(MAX_SPRITES);
  const candOrient = new Float32Array(MAX_SPRITES);
  const candDist = new Float32Array(MAX_SPRITES);
  const candSub = new Uint8Array(MAX_SPRITES);
  // Counting-sort scratch — all preallocated, zero per-frame allocation.
  const candBucket = new Uint16Array(MAX_SPRITES);
  const bucketCount = new Uint32Array(SORT_KEYS);
  const bucketStart = new Uint32Array(SORT_KEYS);
  const sortedIdx = new Uint32Array(MAX_SPRITES);

  // ── Cell-sample cache ──────────────────────────────────────────────────
  // Keyed by the cell's jitter hash (already computed for positioning);
  // ix/iy/iz stored for collision verification. density 0 entries cache
  // "empty sky" — most of the walked volume — so clear regions cost one
  // map read per TTL instead of per frame.
  interface CellEntry {
    ix: number; iy: number; iz: number;
    density: number;
    r: number; g: number; b: number;
    cum: number;
    layerIdx: number;
    expiresAt: number;
  }
  let cacheCur = new Map<number, CellEntry>();
  let cachePrev = new Map<number, CellEntry>();
  let lastGenSwap = 0;

  function cacheLookup(key: number, ix: number, iy: number, iz: number, now: number): CellEntry | null {
    let e = cacheCur.get(key);
    if (!e) {
      e = cachePrev.get(key);
      if (e) cacheCur.set(key, e); // promote into the live generation
    }
    if (!e || e.ix !== ix || e.iy !== iy || e.iz !== iz) return null;
    if (now >= e.expiresAt) return null;
    return e;
  }

  function clearSampleCache(): void {
    cacheCur.clear();
    cachePrev.clear();
  }

  // Until the first full sweep completes, bake at an elevated budget so
  // weather develops within a couple of seconds of materialize (the body
  // is still fading in from its halo at that point, so the latitude
  // sweep is invisible). After that, the user-tunable budget paces
  // evolution.
  let initialSweepDone = false;
  const INITIAL_SWEEP_BUDGET_MS = 4;

  function bakeTick(timeSeconds: number): void {
    const budget = initialSweepDone
      ? bakeBudgetMs
      : Math.max(bakeBudgetMs, INITIAL_SWEEP_BUDGET_MS);
    if (budget <= 0) return;
    // Bank this frame's budget; bake only when we can afford a row.
    // The bank is capped so a long stall doesn't trigger a burst.
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
      // Clamped blend — GC pauses landing inside the timing window would
      // otherwise poison the estimate for many frames.
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

  /** Sun direction in planet-local frame, derived from the stored world
   *  position via the parent (body.group) world matrix. Returns false if
   *  there's no sun or the group isn't in the scene graph yet. */
  function computeSunLocal(): boolean {
    if (!sunWorldPos || !group.parent) return false;
    _invParent.copy(group.parent.matrixWorld).invert();
    _sunLocal.copy(sunWorldPos).applyMatrix4(_invParent);
    // Star distance >> planet radius, so center-relative direction is
    // accurate for every cloud cell.
    if (_sunLocal.lengthSq() < 1) return false;
    _sunLocal.normalize();
    return true;
  }

  function update(cameraLocalPos: THREE.Vector3, timeSeconds: number): void {
    lastTimeSeconds = timeSeconds;
    if (field.layers.length === 0) {
      geom.setDrawRange(0, 0);
      return;
    }

    // Weather evolution — a few map rows per frame within the ms budget.
    const statT0 = performance.now();
    bakeTick(timeSeconds);
    cloudSystemStats.bakeMs = performance.now() - statT0;
    cloudSystemStats.cellsIterated = 0;
    cloudSystemStats.cellsPassed = 0;
    const statT1 = performance.now();

    // Cache generation swap — retires cells the camera flew away from.
    if (timeSeconds - lastGenSwap > CACHE_GEN_SECONDS) {
      const old = cachePrev;
      cachePrev = cacheCur;
      old.clear();
      cacheCur = old;
      lastGenSwap = timeSeconds;
    }

    const hasSun = computeSunLocal();

    // Layer altitude span (for fast cell-altitude pre-filter).
    let layerMinAlt = Infinity;
    let layerMaxAlt = -Infinity;
    let layerTopMax = 0;
    for (const layer of field.layers) {
      if (layer.baseAltitudeM < layerMinAlt) layerMinAlt = layer.baseAltitudeM;
      if (layer.topAltitudeM > layerMaxAlt) layerMaxAlt = layer.topAltitudeM;
      if (layer.topAltitudeM > layerTopMax) layerTopMax = layer.topAltitudeM;
    }

    // Shell crossfade — derived from camera altitude relative to the
    // tallest layer's top.
    const camRadius = cameraLocalPos.length();
    const camAlt = camRadius - field.planetRadiusM;
    const fadeLow = Math.max(1, layerTopMax * SHELL_FADE_LOW_MULT);
    const fadeHigh = Math.max(fadeLow + 1, layerTopMax * SHELL_FADE_HIGH_MULT);
    const shellOpacity = THREE.MathUtils.smoothstep(camAlt, fadeLow, fadeHigh);

    for (const shell of shells) {
      const u = shell.material.uniforms;
      u.uTime.value = timeSeconds;
      u.uEpoch.value = map.epochSec;
      u.uWindMult.value = sampleOpts.windMult;
      u.uShellOpacity.value = shellOpacity;
      u.uHasSun.value = hasSun ? 1 : 0;
      if (hasSun && sunWorldPos) u.uSunPosW.value.copy(sunWorldPos);
    }

    // Billboard rebuild cadence — off-frames keep the previous sprite
    // set (planet-anchored, so it stays visually coherent) and skip the
    // whole walk. Shell uniforms above still updated every frame so the
    // orbital drift stays smooth.
    updateCounter++;
    if (updateCounter % Math.max(1, Math.round(updateInterval)) !== 0) {
      cloudSystemStats.walkMs = 0;
      cloudSystemStats.sortMs = 0;
      return;
    }

    // Billboard tiers — only sizes the shell doesn't own.
    const allTiers = activeCloudTiers(field.planetRadiusM);
    const tiers = allTiers.filter(
      (t) => CLOUD_CELL_SIZES_M[t] <= MAX_BILLBOARD_CELL_SIZE_M,
    );
    const tierCount = tiers.length;

    // High-altitude early-out: when the camera is so far above the layer
    // that no billboard cell can be within its outermost fade distance,
    // skip the whole walk — the shell alone represents the planet. This
    // is the common case for every materialized body seen from space.
    const largestCell = CLOUD_CELL_SIZES_M[tiers[tierCount - 1]];
    const maxReachM = largestCell * 12; // outermost tier's outerFadeEnd
    if (camAlt - layerMaxAlt > maxReachM) {
      geom.setDrawRange(0, 0);
      return;
    }

    let count = 0;
    let freshSampleBudget = MAX_FRESH_SAMPLES_PER_REBUILD;
    const planetRadius = field.planetRadiusM;

    for (let ti = 0; ti < tierCount; ti++) {
      const tier = tiers[ti];
      const cellSize = CLOUD_CELL_SIZES_M[tier];

      // LOD fade band.
      const childTier = ti > 0 ? tiers[ti - 1] : -1;
      const childCellSize = childTier >= 0 ? CLOUD_CELL_SIZES_M[childTier] : 0;
      const isInnermost = ti === 0;
      const isOutermost = ti === tierCount - 1;

      const innerExpand = isInnermost ? 0 : childCellSize * EXPAND_FACTOR;
      const innerFadeEnd = isInnermost ? 0 : innerExpand * FADE_FACTOR;
      // Outermost billboard tier has no parent billboard to fade to (the
      // shell takes over) — cap at a multiple of its own cell size.
      const outerExpand = isOutermost
        ? cellSize * 8
        : cellSize * EXPAND_FACTOR;
      const outerFadeEnd = isOutermost
        ? cellSize * 12
        : outerExpand * FADE_FACTOR;

      const reach = Math.ceil(outerFadeEnd / cellSize) + 1;
      // Coarse-reject distance — outer fade end plus the furthest the
      // jitter can pull a cell back into range.
      const outerReject = outerFadeEnd + cellSize * 0.7;
      const outerReject2 = outerReject * outerReject;
      const ixC = Math.floor(cameraLocalPos.x / cellSize);
      const iyC = Math.floor(cameraLocalPos.y / cellSize);
      const izC = Math.floor(cameraLocalPos.z / cellSize);

      // Altitude pre-filter margin. A cell can intersect the layer even
      // if its center altitude is up to cellSize away from the layer's
      // altitude range (cube can poke into the layer from outside; the
      // ±0.4-cell jitter is also absorbed by this margin).
      const altMargin = cellSize;
      const minOkAlt = layerMinAlt - altMargin;
      const maxOkAlt = layerMaxAlt + altMargin;
      const rLo = Math.max(0, planetRadius + minOkAlt);
      const rHi = planetRadius + maxOkAlt;
      const rLo2 = rLo * rLo;
      const rHi2 = rHi * rHi;

      const iyMinClamp = iyC - reach;
      const iyMaxClamp = iyC + reach;

      for (let dx = -reach; dx <= reach; dx++) {
        const ix = ixC + dx;
        const colX = (ix + 0.5) * cellSize;
        for (let dz = -reach; dz <= reach; dz++) {
          if (count >= MAX_SPRITES) break;
          const iz = izC + dz;
          const colZ = (iz + 0.5) * cellSize;

          // ── Column culling. Clouds live in a thin spherical shell, so
          // for each (x, z) column only a short run of y cells can ever
          // intersect it: cy² ∈ [rLo² − q, rHi² − q] where q = x² + z².
          // This replaces the old full-cube walk — the iteration drops
          // from O(reach³) to O(reach² × shellThickness), which is the
          // bulk of the win on the big outer tiers.
          const q = colX * colX + colZ * colZ;
          const hi2 = rHi2 - q;
          if (hi2 <= 0) continue; // column entirely outside the shell
          const cyHi = Math.sqrt(hi2);
          const lo2 = rLo2 - q;
          const cyLo = lo2 > 0 ? Math.sqrt(lo2) : 0;

          // Two mirrored bands: [cyLo, cyHi] and [−cyHi, −cyLo]; they
          // merge into one [−cyHi, cyHi] when the column passes inside
          // the inner radius (cyLo = 0).
          for (let band = 0; band < 2; band++) {
            let yA: number;
            let yB: number;
            if (band === 0) {
              yA = cyLo > 0 ? cyLo : -cyHi;
              yB = cyHi;
            } else {
              if (cyLo <= 0) break; // bands merged — band 0 covered it
              yA = -cyHi; yB = -cyLo;
            }
            // ±1 covers the 0.5-cell center offset plus position jitter;
            // the fine per-cell altitude check culls the excess.
            let iyMin = Math.floor(yA / cellSize) - 1;
            let iyMax = Math.ceil(yB / cellSize) + 1;
            if (iyMin < iyMinClamp) iyMin = iyMinClamp;
            if (iyMax > iyMaxClamp) iyMax = iyMaxClamp;

            for (let iy = iyMin; iy <= iyMax; iy++) {
              if (count >= MAX_SPRITES) break;
              cloudSystemStats.cellsIterated++;

              // ── Cheap rejects FIRST, on the unjittered center — no
              // hash, no sqrt, no Map lookup for the (majority of)
              // cells that are out of range. Margins absorb the ≤0.7×
              // cellSize the jitter can move a cell.
              const ccy = (iy + 0.5) * cellSize;
              const cdx = colX - cameraLocalPos.x;
              const cdy = ccy - cameraLocalPos.y;
              const cdz = colZ - cameraLocalPos.z;
              const cDist2 = cdx * cdx + cdy * cdy + cdz * cdz;
              if (cDist2 > outerReject2) continue;
              const cRad2 = q + ccy * ccy;
              if (cRad2 < rLo2 || cRad2 > rHi2) continue;

              // Hash-jitter: shift the cell center by up to ±JITTER ×
              // cellSize so the grid pattern breaks visually. Hash is
              // deterministic per (seed, tier, ix, iy, iz) → cells stay
              // put across frames AND across runs.
              const jh = hashCell(field.seed, tier, ix, iy, iz);
              const jx = (((jh >>> 0) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              const jy = (((jh >>> 8) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              const jz = (((jh >>> 16) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
              const cx = (ix + 0.5 + jx) * cellSize;
              const cy = (iy + 0.5 + jy) * cellSize;
              const cz = (iz + 0.5 + jz) * cellSize;

              // Fine altitude check (curvature-correct, post-jitter).
              const radius2 = cx * cx + cy * cy + cz * cz;
              const radius = Math.sqrt(radius2);
              const alt = radius - planetRadius;
              if (alt < minOkAlt || alt > maxOkAlt) continue;

              // Camera-distance and LOD weight (post-jitter).
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
              cloudSystemStats.cellsPassed++;

              // Field sample — weather map + local detail — through the
              // cell cache. Samples are camera-independent, so they
              // survive across frames until their staggered TTL expires.
              let entry = cacheLookup(jh, ix, iy, iz, timeSeconds);
              if (!entry) {
                if (freshSampleBudget <= 0) continue; // condense next rebuild
                freshSampleBudget--;
                _samplePosTmp.set(cx, cy, cz);
                cloudDensityAt(field, map, _samplePosTmp, timeSeconds, sampleOpts, _sampleOut);
                entry = {
                  ix, iy, iz,
                  density: _sampleOut.density,
                  r: _sampleOut.color.r,
                  g: _sampleOut.color.g,
                  b: _sampleOut.color.b,
                  cum: _sampleOut.cumuliformity,
                  layerIdx: _sampleOut.layerIndex,
                  // Staggered expiry — hash-spread so refreshes don't
                  // clump into a single frame.
                  expiresAt: timeSeconds
                    + CACHE_TTL_SECONDS * (0.75 + 0.5 * (((jh >>> 24) & 0xff) / 255)),
                };
                cacheCur.set(jh, entry);
              }
              if (entry.density < minDensity) continue;

              const layerIdx = entry.layerIdx;
              const cum = entry.cum;
              const layer = layerIdx >= 0 ? field.layers[layerIdx] : field.layers[0];
              const layerThick = layer.topAltitudeM - layer.baseAltitudeM;

              // Sprite orientation:
              //   flat deck (cum=0) → 1 always (planet-tangent disc)
              //   tower (cum=1)     → 0 close (puff), 1 far (disc)
              // Distance metric in cell-sizes so it scales with tier.
              const distInCells = dist / cellSize;
              const distFactor = Math.min(1, Math.max(0, (distInCells - 1) / 3));
              const orientation = (1 - cum) + cum * distFactor;

              // Planet-local "up" at the cell — used for sun shading and
              // cluster offsets.
              const invRadius = 1 / Math.max(1, radius);
              const upX = cx * invRadius;
              const upY = cy * invRadius;
              const upZ = cz * invRadius;

              // Sun shading — terminator + diffuse. CPU-side so the
              // sprite shader stays a cheap Gaussian splat.
              let shade = 1;
              if (hasSun) {
                const sd = upX * _sunLocal.x + upY * _sunLocal.y + upZ * _sunLocal.z;
                const dayT = THREE.MathUtils.smoothstep(sd, -0.12, 0.2);
                const diffuse = sd > 0 ? sd : 0;
                shade = NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * dayT
                  * (SHADE_DIFFUSE_FLOOR + (1 - SHADE_DIFFUSE_FLOOR) * diffuse);
              }

              const baseAlpha = entry.density * fade;

              if (orientation >= SHEET_ORIENTATION_THRESHOLD) {
                // ── Sheet regime: tangent disc(s). Tiles with neighbor
                // cells into a continuous deck; collapses edge-on so it
                // can't clip terrain. The half-size companion disc keeps
                // an ISOLATED deck-edge cell from reading as one circle.
                const discSize = cellSize * DISC_OVERSIZE * spriteOversize;
                for (let si = 0; si < 2; si++) {
                  if (count >= MAX_SPRITES) break;
                  let sx = cx, sy = cy, sz = cz;
                  let size = discSize;
                  let alpha = baseAlpha;
                  if (si === 1) {
                    const sh = jh ^ 0x68bc21eb;
                    // Tangential offset via a hashed direction with the
                    // radial component projected out.
                    let ox = (((sh >>> 0) & 0xff) / 255 - 0.5);
                    let oy = (((sh >>> 8) & 0xff) / 255 - 0.5);
                    let oz = (((sh >>> 16) & 0xff) / 255 - 0.5);
                    const dotUp = ox * upX + oy * upY + oz * upZ;
                    ox -= dotUp * upX; oy -= dotUp * upY; oz -= dotUp * upZ;
                    const olen = Math.sqrt(ox * ox + oy * oy + oz * oz);
                    if (olen < 1e-6) continue;
                    const om = (cellSize * 0.4) / olen;
                    sx += ox * om; sy += oy * om; sz += oz * om;
                    size = discSize * 0.6;
                    // Ramp in just past the regime threshold so cells
                    // arriving from the puff branch don't pop a disc.
                    const ramp = Math.min(1,
                      (orientation - SHEET_ORIENTATION_THRESHOLD) / 0.08);
                    alpha = baseAlpha * 0.55 * ramp;
                    if (alpha < 0.01) continue;
                  }
                  candPosX[count] = sx;
                  candPosY[count] = sy;
                  candPosZ[count] = sz;
                  candColR[count] = entry.r * shade;
                  candColG[count] = entry.g * shade;
                  candColB[count] = entry.b * shade;
                  candAlpha[count] = alpha;
                  candSize[count] = size;
                  // Keep the continuous blend value (≥ threshold here,
                  // → 1 with distance) so cells arriving from the puff
                  // branch don't pop in edge-on size.
                  candOrient[count] = orientation;
                  candDist[count] = dist;
                  candSub[count] = ((jh >>> 9) ^ (si * 7)) & 15;
                  count++;
                }
              } else {
                // ── Puff regime: a cluster of overlapping puffs, sized
                // by the LAYER (≤ ~thickness) so big-tier cells become
                // banks of cloud rather than one giant ball, spread
                // tangentially across the cell footprint, bottoms
                // clamped to the layer base (flat condensation level —
                // also what keeps sprites out of the terrain).
                const puffD = Math.min(cellSize, layerThick * PUFF_LAYER_THICK_FRAC);
                let puffs = Math.round((cellSize / puffD) * 1.5);
                if (puffs < MIN_CLUSTER_PUFFS) puffs = MIN_CLUSTER_PUFFS;
                if (puffs > MAX_CLUSTER_PUFFS) puffs = MAX_CLUSTER_PUFFS;

                // Tangent frame at the cell (poles handled by helper-axis
                // switch on the dominant up component).
                let hx = 0, hy = 1, hz = 0;
                if (upY > 0.9 || upY < -0.9) { hx = 1; hy = 0; }
                let t1x = upY * hz - upZ * hy;
                let t1y = upZ * hx - upX * hz;
                let t1z = upX * hy - upY * hx;
                const t1len = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z);
                t1x /= t1len; t1y /= t1len; t1z /= t1len;
                const t2x = upY * t1z - upZ * t1y;
                const t2y = upZ * t1x - upX * t1z;
                const t2z = upX * t1y - upY * t1x;

                // Sheet convergence — as orientation approaches the
                // sheet threshold (stratus, or any cell receding into
                // the distance), the cluster continuously collapses to
                // a single cell-sized disc: spreads shrink, sizes grow,
                // and surplus puffs fade out one at a time. The regime
                // switch is then seamless instead of a 6-puff→disc pop.
                const sheetT = THREE.MathUtils.smoothstep(
                  orientation, 0.5, SHEET_ORIENTATION_THRESHOLD,
                );
                const spreadMul = 1 - sheetT;
                const discSize = cellSize * DISC_OVERSIZE * spriteOversize;

                const tanSpread = Math.max(puffD * 0.35, (cellSize - puffD) * 0.5) * spreadMul;
                const radSpread = layerThick * PUFF_RADIAL_SPREAD_FRAC * cum * spreadMul;
                // Overlapping-alpha conservation — the cluster center is
                // covered by ~2-3 puffs, so each carries less alpha. The
                // effective count shrinks as surplus puffs fade.
                const effPuffs = Math.max(1, puffs * (1 - sheetT));
                const subAlpha = baseAlpha / Math.sqrt(Math.max(1, effPuffs * 0.75));

                for (let si = 0; si < puffs; si++) {
                  if (count >= MAX_SPRITES) break;
                  // Per-puff fade-out as the cluster converges: puff si
                  // is fully present while effPuffs > si+1, fades across
                  // one unit, then drops.
                  const presence = Math.min(1, Math.max(0, effPuffs - si));
                  if (presence < 0.02) break;
                  const sh = jh ^ ((si + 1) * 0x85ebca6b);
                  const h1 = ((sh >>> 0) & 0xff) / 255;
                  const h2 = ((sh >>> 8) & 0xff) / 255;
                  const h3 = ((sh >>> 16) & 0xff) / 255;
                  const h4 = ((sh >>> 24) & 0xff) / 255;

                  const o1 = (h1 - 0.5) * 2 * tanSpread;
                  const o2 = (h2 - 0.5) * 2 * tanSpread;
                  let or = (h3 - 0.5) * 2 * radSpread;
                  // Vigorous cells raise their last puff into a tower.
                  if (cum > 0.5 && si === puffs - 1) or += puffD * TOWER_RAISE_FRAC * spreadMul;

                  const puffSize = puffD * (0.7 + 0.6 * h4) * PUFF_OVERSIZE * spriteOversize;
                  const size = puffSize + (discSize - puffSize) * sheetT;

                  // Flat-base clamp: puff bottom stays at/above the
                  // layer base regardless of where the cell center sits.
                  // Clearance scales with puffiness — a tangent disc has
                  // no vertical extent, so a sheet-converged sprite needs
                  // (and must not get) any lift.
                  const minCenterAlt = layer.baseAltitudeM
                    + size * 0.5 * PUFF_BASE_CLEARANCE * (1 - orientation);
                  if (alt + or < minCenterAlt) or = minCenterAlt - alt;

                  const sx = cx + t1x * o1 + t2x * o2 + upX * or;
                  const sy = cy + t1y * o1 + t2y * o2 + upY * or;
                  const sz = cz + t1z * o1 + t2z * o2 + upZ * or;

                  // Vertical brightness gradient — dark flat bases,
                  // bright tops.
                  const vn = Math.max(-1, Math.min(1, or / Math.max(1, layerThick * 0.5)));
                  const lum = shade * (1 + vn * CLUSTER_BASE_DARKEN);

                  candPosX[count] = sx;
                  candPosY[count] = sy;
                  candPosZ[count] = sz;
                  candColR[count] = entry.r * lum;
                  candColG[count] = entry.g * lum;
                  candColB[count] = entry.b * lum;
                  candAlpha[count] = subAlpha * presence;
                  candSize[count] = size;
                  candOrient[count] = orientation;
                  candDist[count] = dist;
                  candSub[count] = ((jh >>> 9) ^ (si * 7)) & 15;
                  count++;
                }
              }
            }
          }
        }
        if (count >= MAX_SPRITES) break;
      }
    }

    cloudSystemStats.walkMs = performance.now() - statT1;
    const statT2 = performance.now();

    if (count === 0) {
      geom.setDrawRange(0, 0);
      return;
    }

    // Order far-to-near for correct alpha-over compositing. Counting
    // sort over (distance bucket × deterministic sub-key) — O(n), no
    // allocation, no comparator. Bucket width is maxReachM / 256;
    // ordering errors within a bucket are invisible between translucent
    // Gaussians, and the hash sub-key keeps same-bucket order STABLE
    // across frames regardless of cell-walk iteration order.
    bucketCount.fill(0);
    const invDist = (SORT_BUCKETS - 1) / maxReachM;
    for (let i = 0; i < count; i++) {
      let b = (candDist[i] * invDist) | 0;
      if (b > SORT_BUCKETS - 1) b = SORT_BUCKETS - 1;
      const key = b * SORT_SUB + candSub[i];
      candBucket[i] = key;
      bucketCount[key]++;
    }
    let acc = 0;
    for (let k = SORT_KEYS - 1; k >= 0; k--) {
      bucketStart[k] = acc;
      acc += bucketCount[k];
    }
    for (let i = 0; i < count; i++) sortedIdx[bucketStart[candBucket[i]]++] = i;

    // Pack into render buffers in sorted order.
    for (let i = 0; i < count; i++) {
      const src = sortedIdx[i];
      const dst3 = i * 3;
      const dst4 = i * 4;
      positions[dst3 + 0] = candPosX[src];
      positions[dst3 + 1] = candPosY[src];
      positions[dst3 + 2] = candPosZ[src];
      colorsRgba[dst4 + 0] = candColR[src];
      colorsRgba[dst4 + 1] = candColG[src];
      colorsRgba[dst4 + 2] = candColB[src];
      colorsRgba[dst4 + 3] = candAlpha[src];
      sizes[i] = candSize[src];
      orientations[i] = candOrient[src];
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    orientAttr.needsUpdate = true;
    geom.setDrawRange(0, count);
    cloudSystemStats.sortMs = performance.now() - statT2;
  }

  function fogContribution(
    cameraLocalPos: THREE.Vector3,
    out: { density: number; color: THREE.Color },
  ): void {
    out.density = 0;
    out.color.setRGB(0, 0, 0);
    if (field.layers.length === 0) return;
    // Sample at the camera position. If we're inside a dense cloud, the
    // sky's fog density gets boosted by this contribution — the visual
    // equivalent of being enveloped by a cumulus puff.
    cloudDensityAt(field, map, cameraLocalPos, lastTimeSeconds, sampleOpts, _sampleOut);
    out.density = _sampleOut.density;
    out.color.copy(_sampleOut.color);
  }

  function setOpacity(opacity: number): void {
    material.uniforms.uOpacity.value = opacity;
    for (const shell of shells) {
      shell.material.uniforms.uOpacity.value = opacity;
    }
  }

  function setRuntimeOpts(o: CloudSystemRuntimeOpts): void {
    if (o.opacity !== undefined) setOpacity(o.opacity);
    if (o.spriteOversize !== undefined) spriteOversize = o.spriteOversize;
    if (o.minDensity !== undefined) minDensity = o.minDensity;
    if (o.windMult !== undefined) sampleOpts.windMult = o.windMult;
    if (o.detailMult !== undefined) sampleOpts.detailMult = o.detailMult;
    if (o.vigorMult !== undefined) sampleOpts.vigorMult = o.vigorMult;
    if (o.bakeBudgetMs !== undefined) bakeBudgetMs = o.bakeBudgetMs;
    if (o.updateInterval !== undefined) updateInterval = o.updateInterval;
  }

  function setSunWorldPos(pos: THREE.Vector3 | null): void {
    if (pos === null) {
      sunWorldPos = null;
    } else {
      if (!sunWorldPos) sunWorldPos = new THREE.Vector3();
      sunWorldPos.copy(pos);
    }
  }

  function setProjection(pixelsPerUnit: number, viewportHeightPx: number): void {
    material.uniforms.uPixelsPerUnit.value = pixelsPerUnit;
    material.uniforms.uViewportPx.value = viewportHeightPx;
  }

  function setField(f: CloudFieldParams): void {
    field = f;
    mapTexture.dispose();
    map = buildWeatherMap(field, lastTimeSeconds);
    mapTexture = makeMapTexture(map);
    rowsSinceUpload = 0;
    initialSweepDone = false; // re-run the elevated first sweep
    clearSampleCache();
    buildShells();
    setOpacity(material.uniforms.uOpacity.value);
  }

  function dispose(): void {
    geom.dispose();
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

/** Helper: compute the `uPixelsPerUnit` factor the cloud shader expects
 *  from a perspective camera + viewport height. The caller should push
 *  this via setProjection each frame (or on FOV / resize changes).
 *  Formula: pixels per scene-meter at distance 1, when the geometry
 *  projects through `projectionMatrix`. */
export function computeCloudPixelsPerUnit(
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
): number {
  const halfFov = (camera.fov * Math.PI) / 360;
  return (viewportHeightPx * 0.5) / Math.tan(halfFov);
}
