import * as THREE from "three";
import { hashCell } from "./galaxy";
import {
  CLOUD_CELL_SIZES_M,
  activeCloudTiers,
  cloudDensityAt,
  type CloudFieldParams,
  type CloudSample,
} from "./cloud-field";

// Per-body cloud renderer.
//
// Walks a hierarchical 3D cell grid around the camera (in planet-local
// coords), samples the CloudField at each cell center, and emits a soft
// Gaussian billboard for every cell whose density crosses the threshold.
// All sprites live in one THREE.Points geometry; a custom shader does
// view-space size attenuation and analytical Gaussian alpha (no texture).
//
// LOD fade band — for each tier:
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
// the visible cubic-grid pattern. Same trick as galaxy.ts's per-cell
// position perturbation; the jitter is hash-deterministic, so cells
// stay in the same place across frames and across runs.
const POSITION_JITTER = 0.4;

// Inner-tier-only multi-sprite parallax. When a cell has cumuliformity
// above this threshold, emit PARALLAX_LAYER_COUNT sprites at vertical
// offsets within the layer thickness. Cheap depth illusion at medium
// distance without needing real volumetric rendering.
const PARALLAX_THRESHOLD = 0.3;
const PARALLAX_LAYER_COUNT = 3;
const PARALLAX_VERTICAL_FRACTION = 0.35;

// Largest cell size (m) we render as billboards. Tiers above this are
// handled by the continuous shell mesh (Mode C), which represents
// planet-scale macro structure as a wrapping sphere — much cleaner than
// trying to draw a 200 km sprite at the cloud altitude. Earth keeps
// tiers 0–2 (200 m, 2 km, 20 km); Jupiter keeps the same plus drops the
// 200 km and 2000 km tiers into the shell.
const MAX_BILLBOARD_CELL_SIZE_M = 20_000;

// Shell crossfade altitudes (m above the layer top). Below LOW, shell
// is hidden — billboards alone render. Above HIGH, shell is fully
// opaque. In between, smooth blend. Tuned so the shell only fades in
// when the camera is meaningfully outside the layer; otherwise the
// billboards' parallax produces the depth illusion.
const SHELL_FADE_LOW_MULT = 2;
const SHELL_FADE_HIGH_MULT = 8;

// Default density floor — below this a cell contributes nothing and is
// dropped before sorting. Helps cull empty cells in clear sky regions.
// Live-overridable via setRuntimeOpts.
const DEFAULT_MIN_DENSITY = 0.04;

// Default sprite size multiplier — each cell becomes a sprite of
// cellSize × this in scene meters. Slightly oversized so adjacent cells
// overlap and the puff field reads as a continuous mass rather than a
// grid of disks. Live-overridable via setRuntimeOpts.
const DEFAULT_SPRITE_OVERSIZE = 1.4;

/** Per-frame tuning values pushed from the GFX config slider panel. */
export interface CloudSystemRuntimeOpts {
  opacity?: number;
  spriteOversize?: number;
  minDensity?: number;
  /** Drift speed multiplier — pre-scaled into the time value passed to
   *  the sampler. 0 freezes the cloud field; >1 exaggerates wind. */
  windMult?: number;
}

export interface CloudSystemOpts {
  /** The body's cloud field. Sampled per-frame at cell centers. */
  field: CloudFieldParams;
}

export interface CloudSystem {
  /** Root Group. Add this to the body's group so it rotates with the planet. */
  group: THREE.Group;
  /** Set the field (used by debug live-edit). */
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
  /** Get the average density + color near the camera (for fog modulation). */
  fogContribution(cameraLocalPos: THREE.Vector3, out: { density: number; color: THREE.Color }): void;
  dispose(): void;
}

// ── Shader ─────────────────────────────────────────────────────────────────
//
// Vertex: world-space sprite center → clip space. gl_PointSize scaled so
// `size` (in scene meters) projects to the correct pixel size at the
// sprite's view-space distance.
//
// Fragment: analytical Gaussian falloff from gl_PointCoord. Center alpha
// is full, edge alpha decays to zero. No texture lookup — the math is
// cheaper than a 64² CanvasTexture sample and stays sharp at any size.

const VERT = /* glsl */ `
attribute vec4 color;        // RGB + per-sprite alpha
attribute float size;        // sprite diameter in scene meters
attribute float orientation; // 0 = camera-facing puff, 1 = planet-tangent disc

uniform float uPixelsPerUnit;  // canvasHeight × 0.5 / tan(halfFov)
uniform float uOpacity;

varying vec4 vColor;

void main() {
  vec4 worldP = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * worldP;
  gl_Position = projectionMatrix * mv;
  float dist = max(1.0, -mv.z);

  // Planet-tangent disc mode: shrink the sprite by |dot(viewDir, upDir)|
  // where upDir is the planet-local up at the cell. From above the disc
  // shows at full size; from edge-on it collapses to zero. The model
  // matrix's translation column is the planet center in world space, so
  // upDir is just normalize(worldP - planetCenter).
  //
  // This is an approximation — a real horizontal disc would project to
  // an ellipse, but a circular sprite scaled by |cos θ| produces a
  // similar shape at most viewing angles and is far cheaper.
  vec3 planetCenter = modelMatrix[3].xyz;
  vec3 upDir = normalize(worldP.xyz - planetCenter);
  vec3 viewDir = normalize(cameraPosition - worldP.xyz);
  float facing = abs(dot(viewDir, upDir));
  float orientScale = mix(1.0, facing, orientation);

  gl_PointSize = size * uPixelsPerUnit / dist * orientScale;
  vColor = vec4(color.rgb, color.a * uOpacity);
}
`;

const FRAG = /* glsl */ `
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
  gl_FragColor = vec4(vColor.rgb, a);
}
`;

// ── Shell shaders (Mode C — continuous planet-wide layer) ──────────────────
//
// Sphere mesh at the layer's mid-altitude. Fragment shader samples a 3D
// value-noise FBM (cheaper GLSL alternative to the JS sampler's simplex
// noise — only used for macro shape, so the difference is invisible).
// Then applies coverage threshold, Hadley-cell circulation banding, and
// zonal wind drift. Result: a soft painted-clouds wrap seen correctly
// from any orbital angle.
//
// Position is treated as planet-local Cartesian because the shell mesh
// is parented to body.group, which rotates with the planet — so the
// noise pattern stays attached to the planet's spin.

const SHELL_VERT = /* glsl */ `
varying vec3 vLocalPos;
varying vec3 vWorldPos;
void main() {
  vLocalPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAG = /* glsl */ `
precision mediump float;

uniform float uSeed;
uniform float uHorizScale;        // m per wave cycle
uniform float uCoverage;          // 0..1
uniform vec3 uZoneColor;
uniform vec3 uBeltColor;
uniform float uCirculationCells;
uniform float uCirculationStrength;
uniform float uJetSpeed;          // m/s
uniform float uTime;
uniform float uWindMult;
uniform float uShellOpacity;      // base opacity from camera-altitude fade
uniform float uOpacity;           // global cloudMult slider

varying vec3 vLocalPos;
varying vec3 vWorldPos;

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

float shellFbm(vec3 p) {
  // Three octaves of value noise. Sufficient for macro shape that the
  // shell is responsible for; high-frequency detail is the billboard
  // tiers' job.
  float n = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    n += amp * shellValueNoise(p * freq);
    amp *= 0.5;
    freq *= 2.07;
  }
  return n * 1.7; // re-normalize to ~[0..1] range
}

void main() {
  // Latitude in planet-local frame (+Y = spin axis).
  float r = length(vLocalPos);
  float sinLat = clamp(vLocalPos.y / r, -1.0, 1.0);
  float lat = asin(sinLat);

  // Circulation banding — same formula as the JS sampler.
  float vertical = cos(2.0 * uCirculationCells * lat);
  float circulationFactor = 1.0 + uCirculationStrength * vertical;
  float zoneT = (vertical + 1.0) * 0.5;
  vec3 cloudColor = mix(uBeltColor, uZoneColor, zoneT);

  // Zonal wind drift — eastward at zonal speed determined by latitude.
  // Drift is purely tangent to the planet, so it doesn't change radius
  // or latitude. We subtract wind × time from the sample position so
  // clouds appear to scroll east at the jet speed.
  //
  // At the poles cross(+Y, upDir) is zero; protect normalize from NaN.
  // The wind speed itself is also ~0 at the poles (sin(Nπ) = 0), so the
  // east direction here doesn't actually matter — the guard is just to
  // avoid an undefined value propagating.
  vec3 upDir = vLocalPos / r;
  vec3 eastRaw = cross(vec3(0.0, 1.0, 0.0), upDir);
  float eastLen = max(1e-4, length(eastRaw));
  vec3 east = eastRaw / eastLen;
  float zonalSpeed = -uJetSpeed * sin(2.0 * uCirculationCells * lat);
  vec3 driftPos = vLocalPos - east * (zonalSpeed * uTime * uWindMult);

  // Sample noise at the layer's horizontal scale.
  float n = shellFbm(driftPos / uHorizScale);

  // Coverage threshold + circulation modulation.
  float threshold = 1.0 - uCoverage;
  float span = max(0.05, 1.0 - threshold);
  float density = clamp((n - threshold) / span, 0.0, 1.0) * circulationFactor;
  if (density < 0.02) discard;

  float a = density * uShellOpacity * uOpacity;
  if (a < 0.005) discard;
  gl_FragColor = vec4(cloudColor, a);
}
`;

// ── Candidate buffer ───────────────────────────────────────────────────────
//
// Sprites are first collected into parallel typed arrays, then sorted by
// distance, then copied into the GL attribute buffers in render order.
// Stored as SoA (struct of arrays) instead of AoS so the sort can avoid
// per-sprite object overhead.

const _camPosTmp = new THREE.Vector3();
const _sampleOut: CloudSample = {
  density: 0,
  color: new THREE.Color(),
  layerIndex: -1,
};
const _fogColor = new THREE.Color();

// ── Implementation ─────────────────────────────────────────────────────────

export function createCloudSystem(opts: CloudSystemOpts): CloudSystem {
  let field = opts.field;

  // Runtime-tunable values (driven from the debug UI). Defaults match
  // the module-level constants; setRuntimeOpts overrides per-frame.
  let minDensity = DEFAULT_MIN_DENSITY;
  let spriteOversize = DEFAULT_SPRITE_OVERSIZE;
  let windMult = 1;

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
      uPixelsPerUnit: { value: 800 }, // updated below; placeholder
      uOpacity: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geom, material);
  points.name = "cloud_sprites";
  // Bounding sphere can't be computed automatically (positions change
  // every frame and we'd over-cull or under-cull anyway). Skip
  // frustum-culling — the camera-relative iteration bounds visibility
  // naturally.
  points.frustumCulled = false;
  // Render after the shell so sprite detail composites on top of the
  // shell's painted macro layer.
  points.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_system";
  group.add(points);

  // ── Continuous shell (Mode C) ──────────────────────────────────────────
  // One shell per layer; collected so per-frame uniforms can be pushed.
  // Each shell is a low-poly sphere at the layer's mid-altitude with a
  // fragment shader that samples the layer's macro structure directly.
  // Replaces the >20 km LOD tiers which would otherwise produce huge
  // billboard discs that clip into terrain at oblique angles.
  interface ShellEntry {
    layerIndex: number;
    material: THREE.ShaderMaterial;
    mesh: THREE.Mesh;
  }
  const shells: ShellEntry[] = [];
  for (let li = 0; li < field.layers.length; li++) {
    const layer = field.layers[li];
    const shellRadiusM = field.planetRadiusM
      + (layer.baseAltitudeM + layer.topAltitudeM) * 0.5;
    const shellMat = new THREE.ShaderMaterial({
      uniforms: {
        uSeed: { value: field.seed },
        uHorizScale: { value: layer.horizScaleM },
        uCoverage: { value: layer.coverage },
        uZoneColor: { value: layer.zoneColor.clone() },
        uBeltColor: { value: layer.beltColor.clone() },
        uCirculationCells: { value: field.circulation.cellsPerHemisphere },
        uCirculationStrength: { value: field.circulation.strength },
        uJetSpeed: { value: field.circulation.jetSpeedMs },
        uTime: { value: 0 },
        uWindMult: { value: 1 },
        uShellOpacity: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
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
  // Index array — we sort this and read candidates in sorted order.
  // Pre-allocated and reused; we only sort the first `count` entries.
  const candIndex = new Uint32Array(MAX_SPRITES);
  // Stable sort key buffer — JS Array.sort is the only widely-supported
  // sort here; we wrap candIndex in a regular Array of (the same)
  // numbers, sort it, and read back into the typed array.
  let sortScratch: number[] = [];

  function update(cameraLocalPos: THREE.Vector3, timeSeconds: number): void {
    if (field.layers.length === 0) {
      geom.setDrawRange(0, 0);
      return;
    }

    // Sized-up viewport projection coefficient. We don't have access to
    // the camera here — the caller (or the body update) sets
    // uPixelsPerUnit externally via the material. Default value still
    // produces something visible if the caller forgets.

    // Filter to only billboard-eligible tiers — anything larger than
    // MAX_BILLBOARD_CELL_SIZE_M is handled by the continuous shell. The
    // outermost billboard tier here gets the "is the largest visible
    // billboard" treatment.
    const allTiers = activeCloudTiers(field.planetRadiusM);
    const tiers = allTiers.filter(
      (t) => CLOUD_CELL_SIZES_M[t] <= MAX_BILLBOARD_CELL_SIZE_M,
    );
    const tierCount = tiers.length;
    let count = 0;

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
    // tallest layer's top. Above SHELL_FADE_HIGH_MULT × layerTop the
    // shell is fully opaque; below SHELL_FADE_LOW_MULT × layerTop it's
    // invisible. Pushed to every shell's uShellOpacity uniform below.
    const camRadius = cameraLocalPos.length();
    const camAlt = camRadius - field.planetRadiusM;
    const fadeLow = Math.max(1, layerTopMax * SHELL_FADE_LOW_MULT);
    const fadeHigh = Math.max(fadeLow + 1, layerTopMax * SHELL_FADE_HIGH_MULT);
    const shellOpacity = THREE.MathUtils.smoothstep(camAlt, fadeLow, fadeHigh);

    for (const shell of shells) {
      const u = shell.material.uniforms;
      u.uTime.value = timeSeconds;
      u.uWindMult.value = windMult;
      u.uShellOpacity.value = shellOpacity;
    }

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
      // Outermost tier has no parent to fade to. Cap it at a multiple of
      // its own cell size so we don't try to iterate an infinite shell.
      const outerExpand = isOutermost
        ? cellSize * 8
        : cellSize * EXPAND_FACTOR;
      const outerFadeEnd = isOutermost
        ? cellSize * 12
        : outerExpand * FADE_FACTOR;

      // Cube reach (per axis) around camera.
      const reach = Math.ceil(outerFadeEnd / cellSize) + 1;
      const ixC = Math.floor(cameraLocalPos.x / cellSize);
      const iyC = Math.floor(cameraLocalPos.y / cellSize);
      const izC = Math.floor(cameraLocalPos.z / cellSize);

      // Altitude pre-filter margin. A cell can intersect the layer even
      // if its center altitude is up to cellSize away from the layer's
      // altitude range (cube can poke into the layer from outside).
      const altMargin = cellSize;
      const minOkAlt = layerMinAlt - altMargin;
      const maxOkAlt = layerMaxAlt + altMargin;
      const planetRadius = field.planetRadiusM;

      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dz = -reach; dz <= reach; dz++) {
            if (count >= MAX_SPRITES) break;

            const ix = ixC + dx;
            const iy = iyC + dy;
            const iz = izC + dz;

            // Hash-jitter: shift the cell center by up to ±POSITION_JITTER
            // × cellSize so the grid pattern breaks visually. Same trick
            // galaxy.ts uses for top-tier star cells. The hash is
            // deterministic per (seed, tier, ix, iy, iz), so cells stay
            // in the same place across frames AND across runs.
            const jh = hashCell(field.seed, tier, ix, iy, iz);
            const jx = (((jh >>>  0) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
            const jy = (((jh >>>  8) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
            const jz = (((jh >>> 16) & 0xff) / 255 - 0.5) * 2 * POSITION_JITTER;
            const cx = (ix + 0.5 + jx) * cellSize;
            const cy = (iy + 0.5 + jy) * cellSize;
            const cz = (iz + 0.5 + jz) * cellSize;

            // Altitude check (curvature-correct).
            const radius2 = cx * cx + cy * cy + cz * cz;
            const radius = Math.sqrt(radius2);
            const alt = radius - planetRadius;
            if (alt < minOkAlt || alt > maxOkAlt) continue;

            // Camera-distance and LOD weight.
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

            // Field sample. windMult pre-scales the time value so the
            // sampler computes drift at the user-controlled speed.
            _camPosTmp.set(cx, cy, cz);
            cloudDensityAt(field, _camPosTmp, timeSeconds * windMult, _sampleOut);
            if (_sampleOut.density < minDensity) continue;

            // Resolve the layer's cumuliformity for mode selection.
            const layerIdx = _sampleOut.layerIndex;
            const cumuliformity = layerIdx >= 0
              ? field.layers[layerIdx].cumuliformity
              : 0;

            // Sprite orientation:
            //   stratus (cumuliformity=0) → 1 always (planet-tangent disc)
            //   cumulus (cumuliformity=1) → smoothly: 0 close (puff), 1 far (disc)
            //   mix → linear blend of the two regimes
            // Distance metric in cell-sizes so it scales with LOD tier.
            const distInCells = dist / cellSize;
            const distFactor = Math.min(1, Math.max(0, (distInCells - 1) / 3));
            const orientation = (1 - cumuliformity) + cumuliformity * distFactor;

            // Parallax expansion — emit PARALLAX_LAYER_COUNT sprites at
            // vertical offsets for cumulus cells in the innermost tier.
            // Cell extent in cell-units below the camera is what gives
            // visible parallax; outer tiers don't need this because the
            // multi-layer effect would not be visible at their distance.
            const wantParallax = isInnermost
              && cumuliformity >= PARALLAX_THRESHOLD
              && layerIdx >= 0;
            const subSpriteCount = wantParallax ? PARALLAX_LAYER_COUNT : 1;

            // Planet-local "up" at the cell — needed to shift sub-sprites
            // along the vertical axis through the cloud layer.
            const invRadius = 1 / Math.max(1, radius);
            const upX = cx * invRadius;
            const upY = cy * invRadius;
            const upZ = cz * invRadius;

            // Layer thickness drives the vertical spread of parallax
            // sprites. Capped so a layer thicker than the cell doesn't
            // disperse sub-sprites beyond useful distance.
            let verticalSpread = 0;
            if (wantParallax) {
              const layer = field.layers[layerIdx];
              const layerThick = layer.topAltitudeM - layer.baseAltitudeM;
              verticalSpread = Math.min(cellSize, layerThick) * PARALLAX_VERTICAL_FRACTION;
            }

            const baseAlpha = _sampleOut.density * fade;
            // Per-sub-sprite alpha attenuation so total opacity is
            // roughly conserved across multi-sprite emission.
            const subAlpha = baseAlpha / Math.sqrt(subSpriteCount);

            for (let si = 0; si < subSpriteCount; si++) {
              if (count >= MAX_SPRITES) break;
              let sx = cx, sy = cy, sz = cz;
              if (wantParallax) {
                // Offset distributed symmetrically around center:
                // si = 0 → -0.5, 1 → 0, 2 → +0.5 for count=3.
                const t = subSpriteCount > 1
                  ? (si / (subSpriteCount - 1) - 0.5) * 2
                  : 0;
                const vOff = t * verticalSpread;
                sx += upX * vOff;
                sy += upY * vOff;
                sz += upZ * vOff;
                // Small lateral scatter per sub-sprite — hashed off the
                // cell jitter so it stays deterministic. Magnitude in
                // cell-fraction so cumulus puffs spread laterally too.
                const sh = jh ^ ((si + 1) * 0x85ebca6b);
                const lh1 = (((sh >>>  0) & 0xff) / 255 - 0.5) * cellSize * 0.25;
                const lh2 = (((sh >>>  8) & 0xff) / 255 - 0.5) * cellSize * 0.25;
                const lh3 = (((sh >>> 16) & 0xff) / 255 - 0.5) * cellSize * 0.25;
                sx += lh1;
                sy += lh2;
                sz += lh3;
              }
              candPosX[count] = sx;
              candPosY[count] = sy;
              candPosZ[count] = sz;
              candColR[count] = _sampleOut.color.r;
              candColG[count] = _sampleOut.color.g;
              candColB[count] = _sampleOut.color.b;
              candAlpha[count] = subAlpha;
              candSize[count] = cellSize * spriteOversize;
              candOrient[count] = orientation;
              candDist[count] = dist;
              count++;
            }
          }
          if (count >= MAX_SPRITES) break;
        }
        if (count >= MAX_SPRITES) break;
      }
    }

    if (count === 0) {
      geom.setDrawRange(0, 0);
      return;
    }

    // Sort indices by distance, far-to-near, so alpha-over composites
    // correctly. Reuses sortScratch; resize if grown.
    if (sortScratch.length !== count) sortScratch = new Array(count);
    for (let i = 0; i < count; i++) sortScratch[i] = i;
    sortScratch.sort((a, b) => candDist[b] - candDist[a]);

    // Pack into render buffers in sorted order.
    for (let i = 0; i < count; i++) {
      const src = sortScratch[i];
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
    cloudDensityAt(field, cameraLocalPos, 0, _sampleOut);
    out.density = _sampleOut.density;
    _fogColor.copy(_sampleOut.color);
    out.color.copy(_fogColor);
  }

  function setOpacity(opacity: number): void {
    material.uniforms.uOpacity.value = opacity;
    for (const shell of shells) {
      shell.material.uniforms.uOpacity.value = opacity;
    }
  }

  function setRuntimeOpts(opts: CloudSystemRuntimeOpts): void {
    if (opts.opacity !== undefined) {
      material.uniforms.uOpacity.value = opts.opacity;
      for (const shell of shells) {
        shell.material.uniforms.uOpacity.value = opts.opacity;
      }
    }
    if (opts.spriteOversize !== undefined) spriteOversize = opts.spriteOversize;
    if (opts.minDensity !== undefined) minDensity = opts.minDensity;
    if (opts.windMult !== undefined) windMult = opts.windMult;
  }

  function setField(f: CloudFieldParams): void {
    field = f;
  }

  function dispose(): void {
    geom.dispose();
    material.dispose();
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
    fogContribution,
    dispose,
  };
}

/** Helper: compute the `uPixelsPerUnit` factor the cloud shader expects
 *  from a perspective camera + viewport height. The caller should push
 *  this to the cloud material each frame (or on FOV / resize changes).
 *  Formula: pixels per scene-meter at distance 1, when the geometry
 *  projects through `projectionMatrix`. */
export function computeCloudPixelsPerUnit(
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
): number {
  const halfFov = (camera.fov * Math.PI) / 360;
  return (viewportHeightPx * 0.5) / Math.tan(halfFov);
}

/** Apply per-frame uniforms to the cloud system's material. Convenience
 *  wrapper so the body update doesn't have to know the uniform names. */
export function updateCloudUniforms(
  system: CloudSystem,
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
): void {
  const pts = system.group.children[0] as THREE.Points;
  const mat = pts.material as THREE.ShaderMaterial;
  mat.uniforms.uPixelsPerUnit.value = computeCloudPixelsPerUnit(
    camera, viewportHeightPx,
  );
}
