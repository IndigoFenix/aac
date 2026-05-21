import * as THREE from "three";
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
// hemisphere plus ~5k from inner tiers. Buffers preallocated.
const MAX_SPRITES = 12000;

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
attribute vec4 color;   // RGB + per-sprite alpha
attribute float size;   // sprite diameter in scene meters

uniform float uPixelsPerUnit;  // canvasHeight × 0.5 / tan(halfFov)
uniform float uOpacity;

varying vec4 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1.0, -mv.z);
  // Standard perspective point-size formula.
  gl_PointSize = size * uPixelsPerUnit / dist;
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

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colorsRgba, 4);
  const sizeAttr = new THREE.BufferAttribute(sizes, 1);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colorAttr);
  geom.setAttribute("size", sizeAttr);
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
  // Render after opaque scene geometry; depth-test still applies so the
  // planet surface correctly occludes clouds on the far side.
  points.renderOrder = 2;

  const group = new THREE.Group();
  group.name = "cloud_system";
  group.add(points);

  // Candidate buffer (SoA, sorted in-place by index array).
  const candPosX = new Float32Array(MAX_SPRITES);
  const candPosY = new Float32Array(MAX_SPRITES);
  const candPosZ = new Float32Array(MAX_SPRITES);
  const candColR = new Float32Array(MAX_SPRITES);
  const candColG = new Float32Array(MAX_SPRITES);
  const candColB = new Float32Array(MAX_SPRITES);
  const candAlpha = new Float32Array(MAX_SPRITES);
  const candSize = new Float32Array(MAX_SPRITES);
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

    const tiers = activeCloudTiers(field.planetRadiusM);
    const tierCount = tiers.length;
    let count = 0;

    // Layer altitude span (for fast cell-altitude pre-filter).
    let layerMinAlt = Infinity;
    let layerMaxAlt = -Infinity;
    for (const layer of field.layers) {
      if (layer.baseAltitudeM < layerMinAlt) layerMinAlt = layer.baseAltitudeM;
      if (layer.topAltitudeM > layerMaxAlt) layerMaxAlt = layer.topAltitudeM;
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
            const cx = (ix + 0.5) * cellSize;
            const cy = (iy + 0.5) * cellSize;
            const cz = (iz + 0.5) * cellSize;

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

            const alpha = _sampleOut.density * fade;
            candPosX[count] = cx;
            candPosY[count] = cy;
            candPosZ[count] = cz;
            candColR[count] = _sampleOut.color.r;
            candColG[count] = _sampleOut.color.g;
            candColB[count] = _sampleOut.color.b;
            candAlpha[count] = alpha;
            candSize[count] = cellSize * spriteOversize;
            candDist[count] = dist;
            count++;
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
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
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
  }

  function setRuntimeOpts(opts: CloudSystemRuntimeOpts): void {
    if (opts.opacity !== undefined) material.uniforms.uOpacity.value = opts.opacity;
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
