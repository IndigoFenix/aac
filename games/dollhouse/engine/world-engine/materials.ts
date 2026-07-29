// Lit-material factory for the world engine.
//
// Every LIT surface in the engine — creatures, plants, terrain, buildings,
// roads, props — is built through this module so the shading model is ONE
// variable instead of ~80 hand-written `new MeshStandardMaterial` calls.
//
// WHAT IS NOT HERE (deliberately):
//   Unlit and effect materials are NOT part of the swap and must keep calling
//   THREE directly — swapping them would break carefully-tuned pipelines:
//     • the sky dome + starfield (space-sky.ts) — colours are pre-compensated
//       through an INVERTED ACES fit and are `toneMapped:false` on purpose;
//     • atmosphere shells/veils/gas bands (atmosphere.ts) — ShaderMaterial, and
//       they must carry the `logdepthbuf` chunks or depth-test against
//       log-encoded terrain breaks;
//     • plant impostors/billboards (plant-lod.ts) — unlit by design so a baked
//       card matches the lit mesh it replaces;
//     • the vignette (render3d.ts) and any 2D/overlay material.
//   The rule: if lighting doesn't touch it, it doesn't belong in this file.
//
// SWITCHING MODE: the mode is read at CONSTRUCTION time. Materials already in
// the scene do not change class when you flip it — the host must rebuild its
// world (world-lab's clearWorld()/boot* path does exactly this). This is a
// deliberate trade: a live re-class would mean tracking every material ever
// made, and every consumer already has a reboot path.

import * as THREE from "three";

// ── Mode ────────────────────────────────────────────────────────────────────

/** How lit surfaces are shaded.
 *  - `standard` — physically-based (MeshStandardMaterial). The historical look.
 *  - `toon`     — cel/banded lighting (MeshToonMaterial) against a step ramp. */
export type ShadingMode = "standard" | "toon";

let shadingMode: ShadingMode = "standard";

/** Set the engine-wide shading model. Takes effect for materials built AFTER
 *  this call — rebuild the world to apply it to an existing scene. */
export function setShadingMode(mode: ShadingMode): void {
  shadingMode = mode;
}

export function getShadingMode(): ShadingMode {
  return shadingMode;
}

/** Both shading models, for consumers that hold materials and poke shared
 *  properties on them (colour, emissive, opacity — all present on both). */
export type LitMaterial = THREE.MeshStandardMaterial | THREE.MeshToonMaterial;

// ── Toon ramp ───────────────────────────────────────────────────────────────
// The gradient map MeshToonMaterial quantizes lighting against. Nearest-filtered
// so the steps stay hard — a linear filter here just reproduces smooth shading.

let toonRamp: THREE.DataTexture | null = null;
let rampSteps: readonly number[] = [70, 135, 200, 255];

/** Retune the cel ramp — the main knob for how the toon look reads. Fewer,
 *  further-apart steps = harder/more graphic; more steps = softer. Invalidates
 *  the shared ramp, so rebuild the world afterwards. */
export function setToonRamp(steps: readonly number[]): void {
  if (steps.length === 0) throw new Error("toon ramp needs at least one step");
  rampSteps = [...steps];
  toonRamp?.dispose();
  toonRamp = null;
}

/** Lazy shared singleton — every toon material points at this one texture.
 *  Never disposed with a mesh (it outlives any single world). */
export function getToonRamp(): THREE.DataTexture {
  if (!toonRamp) {
    const steps = new Uint8Array(rampSteps);
    toonRamp = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
    toonRamp.minFilter = THREE.NearestFilter;
    toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

// ── Core factory ────────────────────────────────────────────────────────────

/** Parameters for a lit surface, expressed in STANDARD terms.
 *
 *  `roughness`/`metalness`/`flatShading` describe the standard look; toon has
 *  no equivalent for any of them (this three version's MeshToonMaterial has no
 *  `flatShading`, and passing an unknown key makes THREE warn and drop it), so
 *  they are silently ignored in toon mode. Toon reads curvature through the
 *  ramp with SMOOTH normals — that banding IS the cel look, and it's why the
 *  facets you get from `flatShading` aren't needed to sell it.
 *
 *  CONSEQUENCE — geometry handed to a lit material MUST carry vertex normals,
 *  even when it asks for `flatShading`. Under standard shading flatShading
 *  derives face normals in-shader, so a builder can (and one did) skip
 *  computeVertexNormals; switch that same geometry to toon and the shader
 *  reads the absent attribute as (0,0,0), normalize(vec3(0)) is NaN, and every
 *  lit pixel renders NaN — black meshes, and a black FRAME once bloom blurs
 *  those texels across the image. See plant-lod.ts's merge for the write-up. */
export interface LitOpts {
  /** Force a mode for THIS material instead of following the engine-wide one.
   *  For side-by-side comparison (creature-lab toggles one creature's shading
   *  while the world around it stays put). Leave unset in engine code. */
  mode?: ShadingMode;
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  /** Colour texture — e.g. a baked plant impostor card. */
  map?: THREE.Texture | null;
  alphaTest?: number;
  /** Standard only — ignored in toon mode. */
  roughness?: number;
  /** Standard only — ignored in toon mode. */
  metalness?: number;
  /** Standard only — ignored in toon mode (see above). */
  flatShading?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  /** Escape hatch for HDR surfaces that must bypass the host's tone mapping. */
  toneMapped?: boolean;
  name?: string;
}

/** Build a lit material in the current shading mode. Prefer a role helper
 *  below — reach for this only when no role fits. */
export function litMaterial(opts: LitOpts = {}): LitMaterial {
  // Properties both models share, passed through untouched.
  const shared = {
    ...(opts.color !== undefined ? { color: new THREE.Color(opts.color) } : {}),
    ...(opts.vertexColors !== undefined ? { vertexColors: opts.vertexColors } : {}),
    ...(opts.map !== undefined ? { map: opts.map } : {}),
    ...(opts.alphaTest !== undefined ? { alphaTest: opts.alphaTest } : {}),
    ...(opts.side !== undefined ? { side: opts.side } : {}),
    ...(opts.transparent !== undefined ? { transparent: opts.transparent } : {}),
    ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
    ...(opts.depthWrite !== undefined ? { depthWrite: opts.depthWrite } : {}),
    ...(opts.emissive !== undefined ? { emissive: new THREE.Color(opts.emissive) } : {}),
    ...(opts.emissiveIntensity !== undefined ? { emissiveIntensity: opts.emissiveIntensity } : {}),
    ...(opts.toneMapped !== undefined ? { toneMapped: opts.toneMapped } : {}),
  };
  const m: LitMaterial = (opts.mode ?? shadingMode) === "toon"
    ? new THREE.MeshToonMaterial({ ...shared, gradientMap: getToonRamp() })
    : new THREE.MeshStandardMaterial({
      ...shared,
      roughness: opts.roughness ?? 1,
      metalness: opts.metalness ?? 0,
      ...(opts.flatShading !== undefined ? { flatShading: opts.flatShading } : {}),
    });
  if (opts.name !== undefined) m.name = opts.name;
  return m;
}

// ── Roles ───────────────────────────────────────────────────────────────────
// Named for what a surface IS, not what it looks like — so a mode change (or a
// future third mode) has one place to redefine each kind of surface.

// Each role fills its defaults with `??` rather than spread order: callers
// routinely forward optional fields straight through (`{ roughness: opts.rough }`),
// and an explicitly-undefined key SPREADS — clobbering the role's default with
// undefined instead of falling back to it.

/** Organic vertex-coloured geometry: creatures, fruit, grown plants. The
 *  engine's dominant idiom — faceted + matte under standard shading. */
export function surfaceMaterial(opts: LitOpts = {}): LitMaterial {
  return litMaterial({
    ...opts,
    vertexColors: opts.vertexColors ?? true,
    roughness: opts.roughness ?? 0.85,
    flatShading: opts.flatShading ?? true,
  });
}

/** Built structure: walls, storey slabs, roofs. Fully matte — these read by
 *  silhouette and colour, never by specular. */
export function structureMaterial(color: THREE.ColorRepresentation, opts: LitOpts = {}): LitMaterial {
  return litMaterial({ ...opts, color, roughness: opts.roughness ?? 1 });
}

/** Ground: the flat field, terrain chunks, planet surfaces. */
export function terrainMaterial(opts: LitOpts = {}): LitMaterial {
  return litMaterial({ ...opts, roughness: opts.roughness ?? 1 });
}

/** Flat ground ribbons — roads, streets, trade routes. Double-sided because
 *  ribbons are drawn as open strips. */
export function roadMaterial(color: THREE.ColorRepresentation, opts: LitOpts = {}): LitMaterial {
  return litMaterial({
    ...opts,
    color,
    roughness: opts.roughness ?? 1,
    side: opts.side ?? THREE.DoubleSide,
  });
}

/** Props and object-model parts — the one role that is routinely glossier than
 *  matte, and the one whose colour is retinted at runtime by descriptors. */
export function propMaterial(color: THREE.ColorRepresentation, opts: LitOpts = {}): LitMaterial {
  return litMaterial({ ...opts, color, roughness: opts.roughness ?? 0.6 });
}
