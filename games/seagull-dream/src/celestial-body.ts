import * as THREE from "three";
import { makePlanetNoise } from "./noise";
import { buildChunkGeometry } from "./chunk";
import { CHUNKS, PLANET } from "./config";
import type {
  CelestialBody,
  BodyOrbit,
  BodyRotation,
  BodyType,
} from "./body";
import { computeHillRadius, computeVisualHillRadius } from "./body";
import type { RockyPalette } from "./palettes";
import {
  EARTHLIKE_BLUE,
  EARTHLIKE_RED_GRASS,
  EARTHLIKE_VIOLET_GRASS,
  EARTHLIKE_TEAL_OCEAN,
  BARREN_MARS,
  BARREN_YELLOW,
  BARREN_GRAY_PLANET,
  BARREN_BROWN,
  BARREN_DARK,
  ICE_WORLD,
  MOON_PALETTE,
} from "./palettes";
import type {
  ScatterObject,
  ChunkScatter,
  ScatterResources,
} from "./scatter";
import {
  createScatterResources,
  createChunkScatter,
  disposeChunkScatter,
  MIN_SCATTER_DEPTH,
} from "./scatter";
import type { ResolvedBody } from "./physics-system/system";
import type { Body, BodyState } from "./physics-system/body";
import type { BodyFeatures } from "./physics-system/features";

// Unified celestial-body creator.
//
// One createCelestialBody() handles every renderable body — stars, gas
// giants, rocky planets, moons. It dispatches by the resolved physical
// state (fusion mode + envelope fraction), not by a categorical input:
//
//   - Luminous (hydrogen fusion, or significant L from a remnant)
//       → emissive HDR disc + directional light, no terrain
//   - Gas-dominated (H/He envelope > 30% of total mass)
//       → banded shader sphere, no terrain
//   - Otherwise
//       → terrain quadtree (rocky/icy worlds, moons)
//
// The CelestialBody's legacy `type` field ("star" / "gas" / "rocky") is
// derived here from the dispatch, so existing scene code that branches on
// type (pickHomePlanet, sky lit/unlit logic) keeps working.
//
// TODO(features): rings, volcanoes, life visuals (cities, ruins,
// pre-microbial biosignatures), stripped-core rocky surfaces. The physics
// layer produces all of these as `BodyFeatures` fields but the scene side
// does not render them yet — they're flagged at the dispatch points below.

// ── Physical constants (scene-unit conversions) ─────────────────────────────

const R_EARTH_M = 6.371e6;
const M_EARTH_KG = 5.972e24;
const G_NEWTON = 6.674e-11;
const KM_TO_M = 1000;
const EARTH_SEA_LEVEL_DENSITY = 1.225;  // kg/m³

/**
 * Compute surface atmospheric mass density (kg/m³) from the atmosphere
 * model. ρ = P / (R_specific × T) where R_specific = k_B × N_A / μ.
 * For Earth (1 bar, 288 K, μ=29) this returns ~1.22 kg/m³ — close to
 * the 1.225 reference. For Venus (92 bar, 740 K, μ=44) it returns
 * ~64 kg/m³ — matches the textbook value.
 *
 * Uses the body's atmosphereScaleHeight + surfacePressure to back out
 * the surface density without needing μ explicitly:
 *   ρ_surface = P / (g × H)   (hydrostatic balance: dP/dz = -ρ g, P = ρ g H)
 * which is exact for an isothermal atmosphere with the given H.
 */
function deriveSurfaceAirDensity(
  surfacePressureBar: number,
  scaleHeightM: number,
  surfaceGravityMs2: number,
): number {
  if (surfacePressureBar <= 0 || scaleHeightM <= 0 || surfaceGravityMs2 <= 0) {
    return 0;
  }
  const pPa = surfacePressureBar * 1e5;
  return pPa / (surfaceGravityMs2 * scaleHeightM);
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface CreateCelestialBodyOpts {
  /** Physics blueprint + resolved state + features for this body. */
  resolved: ResolvedBody;
  /** World-space spawn position. The orbit integrator overwrites this on
   *  the first transform advance, but it sets the initial frame. */
  initialPosition: THREE.Vector3;
  /** Orbit description if this body orbits another. null for the primary. */
  orbit: BodyOrbit | null;
  /** Scene root. Directional lights are added here directly so they can
   *  track the body independently of the body's group transform. */
  scene: THREE.Scene;
  /** Override the procedurally-selected palette for rocky bodies. Used by
   *  forced layouts (the home system) to keep familiar appearances. */
  forcedPalette?: RockyPalette;
}

export interface CelestialBodyCreation {
  body: CelestialBody;
  /** Directional light if the body emits visible light. null otherwise.
   *  Returned so the caller can manage it as a scene resource alongside
   *  the body group. */
  light: THREE.DirectionalLight | null;
}

export function createCelestialBody(opts: CreateCelestialBodyOpts): CelestialBodyCreation {
  const { resolved, initialPosition, orbit, scene, forcedPalette } = opts;
  const { body: physBody, state, features } = resolved;

  const radiusM = Math.max(1, state.radius * R_EARTH_M);
  const totalMassKg = state.totalMass * M_EARTH_KG;
  const gm = G_NEWTON * totalMassKg;
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  const isLuminous = state.fusionMode === "hydrogen" || state.luminosity > 1.0;
  const isGasDominated = !isLuminous && hheFrac > 0.3;

  // Rotation: convert features.rotation (period in hours + axial tilt) to
  // BodyRotation (axis + signed rate in rad/s). Random azimuth keyed off
  // body id so adjacent bodies don't visibly share a spin axis.
  const rotation = makeRotationFromFeatures(physBody, features);

  if (isLuminous) {
    return buildLuminousBody({
      physBody, state, radiusM, gm, orbit, rotation, initialPosition, scene,
    });
  }
  if (isGasDominated) {
    return buildGasBody({
      physBody, state, features, radiusM, gm, orbit, rotation, initialPosition,
    });
  }
  return buildRockyBody({
    physBody, state, features, radiusM, gm, orbit, rotation, initialPosition,
    forcedPalette,
  });
}

// ── Rotation conversion ─────────────────────────────────────────────────────

function makeRotationFromFeatures(physBody: Body, features: BodyFeatures): BodyRotation {
  // features.rotation.periodHours can be negative for retrograde rotation
  // (Venus-style spin flip). Take magnitude for the rate denominator, then
  // signed result gives a negative rate → reversed spin around the same axis.
  const signedSeconds = features.rotation.periodHours * 3600;
  const absSeconds = Math.max(1, Math.abs(signedSeconds));
  const rate = ((2 * Math.PI) / absSeconds) * (signedSeconds < 0 ? -1 : 1);
  const azimuth = (bodyHash(physBody.id) % 1000) / 1000 * Math.PI * 2;
  const tilt = features.rotation.axialTilt;
  const axis = new THREE.Vector3(
    Math.sin(tilt) * Math.cos(azimuth),
    Math.cos(tilt),
    Math.sin(tilt) * Math.sin(azimuth),
  ).normalize();
  return { axis, rate };
}

function bodyHash(id: string): number {
  // FNV-1a — stable, no dependencies. Matches the hash used in
  // physics-system/features.ts for per-body deterministic rolls so visual
  // and physical rolls stay correlated.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ── Luminous (star) branch ──────────────────────────────────────────────────

interface BranchOpts {
  physBody: Body;
  state: BodyState;
  radiusM: number;
  gm: number;
  orbit: BodyOrbit | null;
  rotation: BodyRotation;
  initialPosition: THREE.Vector3;
}

function buildLuminousBody(
  o: BranchOpts & { scene: THREE.Scene },
): CelestialBodyCreation {
  const { physBody, state, radiusM, gm, orbit, rotation, initialPosition, scene } = o;

  const group = new THREE.Group();
  group.name = `body_${physBody.id}_lum`;
  group.position.copy(initialPosition);

  // Emissive disc is DEFERRED — while the star is sub-pixel from the
  // camera, the registry projection handles its visual. The disc only
  // materializes when the body's apparent angular size approaches one
  // pixel (see body.materialize below).
  const HDR_BOOST = 4.0 * (1 + 0.3 * Math.log10(Math.max(0.01, state.luminosity)));
  const hdrColor = state.color.clone().multiplyScalar(Math.max(0.5, HDR_BOOST));

  // Directional light tracking the body. Tuned so a Sun-class primary
  // (L=1) gives the level of illumination the visual style was built
  // for (~2.0 intensity — bright lit-side, readable shadows). Floor at
  // 1.0 so even dim K/M dwarfs cast enough light that their planets
  // remain visibly lit at AU-scale distances. Log compression keeps
  // O-star illumination from blowing out the tone mapper.
  // TODO(features): remnant illumination — white dwarfs are blue with
  // very low total L, neutron stars are effectively invisible.
  const lightIntensity = Math.max(1.0, 2.0 + 0.3 * Math.log10(Math.max(0.01, state.luminosity)));
  const light = new THREE.DirectionalLight(state.color, lightIntensity);
  light.position.copy(initialPosition);
  scene.add(light);
  scene.add(light.target);

  const body: CelestialBody = {
    id: physBody.id,
    type: "star",
    radius: radiusM,
    // System-root reach: 200 Mm preserved from previous implementation as
    // a sensible "leaves the star's domain" boundary; tuned for game-feel.
    influenceFalloff: orbit ? radiusM * 20 : 200_000_000,
    gm,
    atmosphereScaleHeight: deriveAtmosphereScaleHeight(state, radiusM, gm),
    orbit,
    rotation,
    walkable: false,
    hasOcean: false,
    seaLevel: 0,
    group,
    worldPosition: initialPosition.clone(),
    prevWorldPosition: initialPosition.clone(),
    orientation: new THREE.Quaternion(),
    inverseOrientation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    // For the system's central star (no orbit / no parent), the "Hill
    // sphere" is effectively the boundary of the star's gravitational
    // dominance against the rest of the galaxy. ~2 ly matches the
    // Oort-cloud / interstellar-transition scale for a Sun-like star
    // and makes interplanetary positions fall inside the star's hill
    // so the dominant-body lookup never returns null in-system.
    hillRadius: orbit ? computeHillRadius(orbit, gm) : 2e16,
    visualHillRadius: orbit ? computeVisualHillRadius(orbit, radiusM) : 2e16,
    warpDensity: 0.2,
    bulkDensity: estimateBulkDensity(state, radiusM, totalMassKg(state)),
    surfaceAirDensity: 1000,  // deep stellar atmosphere
    // No haloColor — the active star is intentionally NOT excluded from
    // the galaxy registry projection, so the registry's direction-locked
    // pixel for this star persists as its sub-pixel representation. The
    // mesh fades in once the body's apparent disc grows past a few
    // pixels. This avoids the discontinuous projection→halo→mesh
    // hand-off the halo-billboard approach introduced at materialization.
    haloColor: undefined,

    upAt(worldPos, out = new THREE.Vector3()): THREE.Vector3 {
      return out.copy(worldPos).sub(this.worldPosition).normalize();
    },
    altitudeAt(worldPos: THREE.Vector3): number {
      return worldPos.distanceTo(this.worldPosition) - radiusM;
    },

    update(cameraWorldPos: THREE.Vector3, _dt: number): void {
      // Directional light: position at the body, target at the camera, so
      // (position - target) gives a light direction from the star toward
      // the player's neighborhood. Without this, both ends collapse to
      // origin and the scene goes black.
      light.position.copy(this.worldPosition);
      light.target.position.copy(cameraWorldPos);
      light.target.updateMatrixWorld();
    },

    materialize(): void {
      // Build the emissive disc the first time the star approaches
      // pixel-scale. Sub-pixel stars are represented by the registry
      // projection alone — no mesh required, no GPU resources allocated.
      const starMesh = new THREE.Mesh(
        new THREE.SphereGeometry(radiusM, 32, 24),
        new THREE.MeshBasicMaterial({
          color: hdrColor,
          fog: false,
          transparent: true,
          opacity: 0,
        }),
      );
      starMesh.name = "lum_disc";
      // Megameter-radius bounding spheres can produce false-negative
      // frustum-cull results when the camera is inside the sphere
      // (close-approach scenarios). Skip culling so the mesh always
      // submits to the GPU; the clip-space test does the right thing.
      starMesh.frustumCulled = false;
      group.add(starMesh);
      body.materialize = undefined;
    },
  };

  return { body, light };
}

// ── Gas-dominated branch ────────────────────────────────────────────────────

function buildGasBody(
  o: BranchOpts & { features: BodyFeatures },
): CelestialBodyCreation {
  const { physBody, state, features, radiusM, gm, orbit, rotation, initialPosition } = o;

  const group = new THREE.Group();
  group.name = `body_${physBody.id}_gas`;
  group.position.copy(initialPosition);

  const { colorA, colorB, bandFrequency } = selectGasBandColors(state, features);
  const seed = bodyHash(physBody.id);

  // Sphere + banded shader material are DEFERRED. Sub-pixel gas giants
  // are represented by the halo billboard; the 12k-vert sphere and
  // shader compilation only happen when the player approaches.

  const atm = features.atmosphere;
  const scaleHeightM = deriveAtmosphereScaleHeight(state, radiusM, gm);
  const surfaceGravityMs2 = (state.totalMass * M_EARTH_KG) * G_NEWTON / (radiusM * radiusM);
  const surfaceAirDensity = atm.surfacePressureBar > 0
    ? deriveSurfaceAirDensity(atm.surfacePressureBar, scaleHeightM, surfaceGravityMs2)
    : 50;

  const body: CelestialBody = {
    id: physBody.id,
    type: "gas",
    radius: radiusM,
    influenceFalloff: radiusM * 4,
    gm,
    atmosphereScaleHeight: scaleHeightM,
    orbit,
    rotation,
    walkable: false,
    hasOcean: false,
    seaLevel: 0,
    group,
    worldPosition: initialPosition.clone(),
    prevWorldPosition: initialPosition.clone(),
    orientation: new THREE.Quaternion(),
    inverseOrientation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    hillRadius: computeHillRadius(orbit, gm),
    visualHillRadius: computeVisualHillRadius(orbit, radiusM),
    warpDensity: 0.4,
    bulkDensity: estimateBulkDensity(state, radiusM, totalMassKg(state)),
    surfaceAirDensity,
    // Gas-giant sky color is the cloud-deck color from below — a player
    // descending through the deck sees the regime's tint.
    skyDay: atm.skyZenithColor.clone(),
    skyNight: darkenForNight(atm.skyZenithColor),
    skyHorizon: atm.skyHorizonColor.clone(),
    atmosphereTopAltitude: atm.atmosphereTopKm * KM_TO_M,
    visibilityRange: atm.visibilityKm * KM_TO_M,
    cloudBaseAltitude: atm.cloudType !== "none"
      ? atm.cloudBaseAltitudeKm * KM_TO_M
      : undefined,
    cloudThickness: atm.cloudType !== "none"
      ? atm.cloudThicknessKm * KM_TO_M
      : undefined,
    cloudCoverage: atm.cloudCoverage,
    cloudColor: cloudColorFor(atm.cloudType),
    haloColor: colorA.clone().lerp(colorB, 0.5),

    upAt(worldPos, out = new THREE.Vector3()): THREE.Vector3 {
      return out.copy(worldPos).sub(this.worldPosition).normalize();
    },
    altitudeAt(worldPos: THREE.Vector3): number {
      return worldPos.distanceTo(this.worldPosition) - radiusM;
    },
    update(_cameraWorldPos: THREE.Vector3, _dt: number): void {
      // No LOD; static sphere.
      // TODO(features): rings render pass here. features.rings has the
      // geometry params (inner/outer radii in body-radius units,
      // optical depth, composition).
    },

    materialize(): void {
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0.0,
        transparent: true,
        opacity: 0,
      });
      // TODO(features): atmosphericBanding intensity could fade the bands
      // to a uniform tint for low-banding bodies (Uranus-class).
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSeed = { value: seed };
        shader.uniforms.uBandFreq = { value: bandFrequency };
        shader.uniforms.uColorA = { value: colorA };
        shader.uniforms.uColorB = { value: colorB };

        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            `#include <common>
             varying vec3 vLocalPos;`,
          )
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
             vLocalPos = position;`,
          );

        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
             uniform float uSeed;
             uniform float uBandFreq;
             uniform vec3 uColorA;
             uniform vec3 uColorB;
             varying vec3 vLocalPos;

             float gasHash(vec3 p) {
               p = fract(p * 0.3183099 + uSeed * 0.1);
               p *= 17.0;
               return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
             }
             float gasValueNoise(vec3 p) {
               vec3 i = floor(p);
               vec3 f = fract(p);
               f = f * f * (3.0 - 2.0 * f);
               float n000 = gasHash(i);
               float n100 = gasHash(i + vec3(1.0, 0.0, 0.0));
               float n010 = gasHash(i + vec3(0.0, 1.0, 0.0));
               float n110 = gasHash(i + vec3(1.0, 1.0, 0.0));
               float n001 = gasHash(i + vec3(0.0, 0.0, 1.0));
               float n101 = gasHash(i + vec3(1.0, 0.0, 1.0));
               float n011 = gasHash(i + vec3(0.0, 1.0, 1.0));
               float n111 = gasHash(i + vec3(1.0, 1.0, 1.0));
               return mix(
                 mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                 mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
                 f.z
               );
             }`,
          )
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
             float lat = vLocalPos.y / uBandFreq;
             float horizontalWobble = gasValueNoise(vLocalPos * 0.0008) * 2.0 - 1.0;
             float bandT = sin(lat + horizontalWobble * 1.5) * 0.5 + 0.5;
             vec3 bandColor = mix(uColorA, uColorB, bandT);
             float fineN = gasValueNoise(vLocalPos * 0.003);
             bandColor *= 1.0 + (fineN - 0.5) * 0.2;
             diffuseColor.rgb = bandColor;`,
          );
      };

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radiusM, 128, 96),
        material,
      );
      sphere.name = "gas_sphere";
      group.add(sphere);

      // Atmosphere halo shell — same fresnel-glow technique as rocky
      // bodies. Gas giants always have a visible atmosphere, so no
      // pressure gate here.
      if (body.atmosphereTopAltitude) {
        const haloShell = buildAtmosphereShell({
          radiusM,
          atmosphereTopM: body.atmosphereTopAltitude,
          zenithColor: body.skyDay ?? atm.skyZenithColor,
          horizonColor: body.skyHorizon ?? atm.skyHorizonColor,
        });
        group.add(haloShell);
      }

      body.materialize = undefined;
    },
  };

  return { body, light: null };
}

function selectGasBandColors(state: BodyState, features: BodyFeatures): {
  colorA: THREE.Color;
  colorB: THREE.Color;
  bandFrequency: number;
} {
  // Two slight tints off the resolved base color — base goes to colorA,
  // a darker complement to colorB. Saturated gas-giant looks come from
  // the noise modulation in the shader, not the input pair.
  const colorA = state.color.clone();
  const colorB = state.color.clone().multiplyScalar(0.78);
  // bandFrequency in the shader is the divisor on local Y; lower → wider
  // bands. Map atmosphericBandCount (0..25 from features) inversely
  // through the 5000..15000 range. bandCount 0 → middle of range.
  const n = features.atmosphericBandCount;
  const bandFrequency = n > 0
    ? 5000 + 10000 * Math.min(1, n / 25)
    : 8000;
  return { colorA, colorB, bandFrequency };
}

// ── Rocky (terrain) branch ──────────────────────────────────────────────────

function buildRockyBody(
  o: BranchOpts & { features: BodyFeatures; forcedPalette?: RockyPalette },
): CelestialBodyCreation {
  const {
    physBody, state, features, radiusM, gm, orbit, rotation, initialPosition, forcedPalette,
  } = o;

  const palette = forcedPalette ?? selectRockyPalette(physBody, state, features);
  const seed = bodyHash(physBody.id);
  const noise = makePlanetNoise(seed);

  const group = new THREE.Group();
  group.name = `body_${physBody.id}_rocky`;
  group.position.copy(initialPosition);

  // ── Terrain shape parameters ────────────────────────────────────────────
  // Relief budget comes from the physics-system terrain model: maxReliefKm
  // is calibrated against real bodies (Earth ~7 km, Mars ~22 km, Mercury
  // ~5 km) via crustal-strength + gravity + tectonic-activity. We clamp
  // to ~1% of body radius so the terrain function's gravity-only scaling
  // doesn't produce visibly-bumpy silhouettes on small bodies.
  const physicalMaxKm = features.terrain.maxReliefKm;
  const maxElevation = Math.max(
    800,
    Math.min(physicalMaxKm * 1000, radiusM * 0.01),
  );
  // Ocean basins ~30% deeper than mountains — preserves shallow-edge
  // bathymetry without making the seabed unreachable.
  const maxDepth = maxElevation * 1.3;

  // Continent frequency is ANGULAR-CONSTANT: every planet shows ~3-5 large
  // continents/maria regardless of body size. Visually right even if
  // non-physical (real continent count tracks tectonic regime).
  const continentFreq = 1.5;

  // Detail noise at a fixed PHYSICAL wavelength (~80 km). Cycles per radian
  // ∝ body radius, so small bodies don't get high-frequency chatter their
  // crusts couldn't physically support. Earth → ~80 cycles around equator,
  // Mars ~42, Moon ~22 — a clean horizon instead of static.
  const DETAIL_WAVELENGTH_M = 80_000;
  const detailFreq = Math.max(8, radiusM / DETAIL_WAVELENGTH_M);

  // Detail amplitude follows the physics-system roughness score: Europa-
  // class smooth bodies (~0.16) stay smooth, Earth/Io class (~0.8-1.0)
  // get visible texture. 0.3 ceiling keeps detail subordinate to continent
  // shape rather than overpowering it.
  const detailWeight = Math.max(0.05, features.terrain.roughness * 0.3);

  // Continent threshold sets ocean coverage. Wet worlds bias the threshold
  // negative so basins fill (~30% land for Earth-class); dry worlds keep
  // the gentle +0.05 offset so the noise mostly reads as positive terrain.
  const continentOffset = palette.oceanFloor ? -0.15 : 0.05;
  const seaLevel = 0;

  // ── heightAt: shared sampler used by physics + chunk geometry ───────────
  const heightAt = (dir: THREE.Vector3): number => {
    const c = noise.continent(
      dir.x * continentFreq,
      dir.y * continentFreq,
      dir.z * continentFreq,
    );
    const d = noise.detail(
      dir.x * detailFreq,
      dir.y * detailFreq,
      dir.z * detailFreq,
    );
    const continent = c + continentOffset;
    if (continent < 0) {
      return Math.max(continent * maxDepth * 1.5, -maxDepth);
    }
    return continent * maxElevation + d * detailWeight * maxElevation;
  };

  // ── Color palette + height ramp ─────────────────────────────────────────
  const hasOcean = !!palette.oceanFloor;
  const hasVegetation = !!palette.grass;
  const hasSnow = !!palette.snow;
  const shoreShallow = 40;
  const treeLine = maxElevation * 0.5;
  const snowLine = maxElevation * 0.75;

  const colorForHeight = (h: number, out: THREE.Color) => {
    if (h <= 0) {
      const t = Math.max(0, 1 + h / maxDepth);
      if (hasOcean) {
        out.copy(palette.oceanFloor!).lerp(palette.sand, t * 0.4);
      } else {
        out.copy(palette.rock).lerp(palette.sand, t * 0.6);
      }
    } else if (h < shoreShallow) {
      out.copy(palette.sand);
    } else if (hasVegetation && h < treeLine) {
      const forestColor = palette.forest ?? palette.grass!;
      out.copy(palette.grass!).lerp(forestColor, (h - shoreShallow) / (treeLine - shoreShallow));
    } else if (h < snowLine) {
      const startColor = hasVegetation ? (palette.forest ?? palette.grass!) : palette.sand;
      const startH = hasVegetation ? treeLine : shoreShallow;
      out.copy(startColor).lerp(palette.rock, (h - startH) / (snowLine - startH));
    } else if (hasSnow) {
      out.copy(palette.rock).lerp(palette.snow!, Math.min(1, (h - snowLine) / (maxElevation - snowLine)));
    } else {
      out.copy(palette.rock);
    }
    return out;
  };

  // ── Deferred heavy state ────────────────────────────────────────────────
  // planetMaterial, scatter resources, the ocean shell, and the 6 chunk
  // roots all wait for body.materialize(). Sub-pixel rocky bodies render
  // as a halo dot only — no GPU resources allocated until the player
  // gets close enough that the disc starts to read.
  let planetMaterial: THREE.MeshStandardMaterial | null = null;
  const scatterEnabled = hasVegetation && radiusM > 1_500_000;
  const scatterRegistry: Set<ScatterObject> = new Set();
  let scatterResources: ScatterResources | null = null;
  let roots: QuadtreeNode[] = [];
  const pendingRootBuilds: QuadtreeNode[] = [];
  let materialized = false;

  // ── Quadtree machinery ──────────────────────────────────────────────────
  const FACE_NORMALS: ReadonlyArray<THREE.Vector3> = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  // Root nodes (and their chunk meshes) are built lazily inside
  // body.materialize() — sub-pixel rocky bodies don't even allocate the
  // node structs. After materialize, root meshes still build one-per-
  // frame from pendingRootBuilds to keep the per-frame cost bounded.

  function buildChunkScatterFor(node: QuadtreeNode): void {
    if (!scatterEnabled || !scatterResources) return;
    if (node.depth < MIN_SCATTER_DEPTH) return;
    if (node.scatter) return;
    node.scatter = createChunkScatter({
      faceIndex: node.faceIndex,
      uAxis: node.uAxis,
      vAxis: node.vAxis,
      faceNormal: node.faceNormal,
      uMin: node.uMin, uMax: node.uMax,
      vMin: node.vMin, vMax: node.vMax,
      seed,
      radius: radiusM,
      seaLevel,
      maxElevation,
      hasOcean,
      palette,
      heightAt,
      group,
      resources: scatterResources,
      registry: scatterRegistry,
    });
  }

  function disposeChunkScatterFor(node: QuadtreeNode): void {
    if (!node.scatter) return;
    disposeChunkScatter(node.scatter, group, scatterRegistry);
    node.scatter = null;
  }

  function buildNodeMesh(node: QuadtreeNode): void {
    const result = buildChunkGeometry({
      faceNormal: node.faceNormal,
      uAxis: node.uAxis,
      vAxis: node.vAxis,
      uMin: node.uMin,
      uMax: node.uMax,
      vMin: node.vMin,
      vMax: node.vMax,
      resolution: CHUNKS.resolution,
      radius: radiusM,
      seaLevel,
      heightAt,
      colorForHeight,
      skirtDepth: CHUNKS.skirtDepth,
    });
    node.center.copy(result.center);
    node.size = result.size;
    // planetMaterial is set in materialize() before any pendingRootBuilds
    // entry runs; LOD-triggered subdivide()→buildNodeMesh only runs when
    // body.update sees materialized=true, after planetMaterial init.
    const mesh = new THREE.Mesh(result.geometry, planetMaterial!);
    mesh.name = `chunk_d${node.depth}`;
    node.mesh = mesh;
    group.add(mesh);
  }

  function disposeNode(node: QuadtreeNode): void {
    if (node.mesh) {
      group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
    }
    disposeChunkScatterFor(node);
    if (node.children) {
      for (const c of node.children) disposeNode(c);
      node.children = null;
    }
  }

  function subdivide(node: QuadtreeNode): void {
    const uMid = (node.uMin + node.uMax) / 2;
    const vMid = (node.vMin + node.vMax) / 2;
    node.children = [
      makeNode(node.faceIndex, node.faceNormal, node.uAxis, node.vAxis, node.uMin, uMid, node.vMin, vMid, node.depth + 1),
      makeNode(node.faceIndex, node.faceNormal, node.uAxis, node.vAxis, uMid, node.uMax, node.vMin, vMid, node.depth + 1),
      makeNode(node.faceIndex, node.faceNormal, node.uAxis, node.vAxis, node.uMin, uMid, vMid, node.vMax, node.depth + 1),
      makeNode(node.faceIndex, node.faceNormal, node.uAxis, node.vAxis, uMid, node.uMax, vMid, node.vMax, node.depth + 1),
    ];
    for (const c of node.children) buildNodeMesh(c);
  }

  const _cameraLocal = new THREE.Vector3();
  function updateNode(node: QuadtreeNode): void {
    const dist = _cameraLocal.distanceTo(node.center);
    const ratio = node.size / dist;
    const canSubdivide = node.depth < CHUNKS.maxDepth;
    const shouldSubdivide = canSubdivide && (
      node.children ? ratio > CHUNKS.lodMergeThreshold : ratio > CHUNKS.lodThreshold
    );
    if (shouldSubdivide) {
      if (!node.children) subdivide(node);
      if (node.mesh) node.mesh.visible = false;
      disposeChunkScatterFor(node);
      for (const c of node.children!) updateNode(c);
    } else {
      if (node.mesh) node.mesh.visible = true;
      if (node.children) {
        for (const c of node.children) disposeNode(c);
        node.children = null;
      }
      buildChunkScatterFor(node);
    }
  }

  // Ocean shell is also deferred; created inside materialize().

  // ── Sampler API (walkable) ──────────────────────────────────────────────
  const _local = new THREE.Vector3();
  const _localDir = new THREE.Vector3();
  const _seedY = new THREE.Vector3(0, 1, 0);
  const _seedX = new THREE.Vector3(1, 0, 0);
  const _t1 = new THREE.Vector3();
  const _t2 = new THREE.Vector3();
  const _localOffset1 = new THREE.Vector3();
  const _localOffset2 = new THREE.Vector3();
  const _localCenter = new THREE.Vector3();
  const _localSurfA = new THREE.Vector3();
  const _localSurfB = new THREE.Vector3();

  const atm = features.atmosphere;
  const scaleHeightM = deriveAtmosphereScaleHeight(state, radiusM, gm);
  const surfaceGravityMs2 = (state.totalMass * M_EARTH_KG) * G_NEWTON / (radiusM * radiusM);
  const surfaceAirDensity = atm.surfacePressureBar > 0
    ? deriveSurfaceAirDensity(atm.surfacePressureBar, scaleHeightM, surfaceGravityMs2)
    : 0;
  // Sky color: the palette wins. The previous "stylized vs default"
  // detector excluded EARTHLIKE_BLUE because its skyDay literally
  // equals the detector's reference #87ceeb — Earth then fell through
  // to the physics path, which lerps the zenith toward cloud white
  // when coverage > 0.01 (features.ts) and produced a near-white sky
  // that ACES desaturated into gray. The palette is always the
  // authored intent; honour it.
  const skyDayColor = palette.skyDay.clone();
  const skyNightColor = palette.skyNight.clone();
  const skyHorizonColor = (palette.skyDay).clone();
  void isStylizedPaletteSky; // kept exported, no longer used here

  const body: CelestialBody = {
    id: physBody.id,
    type: "rocky",
    radius: radiusM,
    influenceFalloff: PLANET.influenceFalloff,
    gm,
    atmosphereScaleHeight: scaleHeightM,
    orbit,
    rotation,
    walkable: true,
    hasOcean,
    seaLevel,
    group,
    worldPosition: initialPosition.clone(),
    prevWorldPosition: initialPosition.clone(),
    orientation: new THREE.Quaternion(),
    inverseOrientation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    hillRadius: computeHillRadius(orbit, gm),
    visualHillRadius: computeVisualHillRadius(orbit, radiusM),
    warpDensity: 1.0,
    bulkDensity: estimateBulkDensity(state, radiusM, totalMassKg(state)),
    surfaceAirDensity,
    skyDay: skyDayColor,
    skyNight: skyNightColor,
    skyHorizon: skyHorizonColor,
    atmosphereTopAltitude: atm.atmosphereTopKm * KM_TO_M,
    visibilityRange: atm.visibilityKm * KM_TO_M,
    cloudBaseAltitude: atm.cloudType !== "none" && atm.cloudCoverage > 0.01
      ? atm.cloudBaseAltitudeKm * KM_TO_M
      : undefined,
    cloudThickness: atm.cloudType !== "none" && atm.cloudCoverage > 0.01
      ? atm.cloudThicknessKm * KM_TO_M
      : undefined,
    cloudCoverage: atm.cloudCoverage,
    cloudColor: cloudColorFor(atm.cloudType),
    haloColor: (palette.oceanSurface ?? palette.sand).clone(),

    heightAt,

    surfaceAt(worldPos, out = new THREE.Vector3()): THREE.Vector3 {
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      _localDir.copy(_local).normalize();
      const h = heightAt(_localDir);
      const surfaceH = hasOcean ? Math.max(h, seaLevel) : h;
      const r = radiusM + surfaceH;
      out.copy(_localDir).multiplyScalar(r);
      out.applyQuaternion(this.orientation).add(this.worldPosition);
      return out;
    },

    altitudeAt(worldPos: THREE.Vector3): number {
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      const dist = _local.length();
      _localDir.copy(_local).normalize();
      const h = heightAt(_localDir);
      const surfaceH = hasOcean ? Math.max(h, seaLevel) : h;
      const surfaceR = radiusM + surfaceH;
      return dist - surfaceR;
    },

    upAt(worldPos, out = new THREE.Vector3()): THREE.Vector3 {
      out.copy(worldPos).sub(this.worldPosition);
      return out.normalize();
    },

    groundNormalAt(worldPos, epsilon, out = new THREE.Vector3()): THREE.Vector3 {
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      const radial = _localDir.copy(_local).normalize();
      const seed = Math.abs(radial.y) < 0.9 ? _seedY : _seedX;
      _t1.crossVectors(seed, radial).normalize();
      _t2.crossVectors(radial, _t1).normalize();

      const clampH = (h: number) => (hasOcean ? Math.max(h, seaLevel) : h);
      const hCenter = heightAt(radial);
      _localCenter.copy(radial).multiplyScalar(radiusM + clampH(hCenter));

      _localOffset1.copy(_local).addScaledVector(_t1, epsilon).normalize();
      const h1 = heightAt(_localOffset1);
      _localSurfA.copy(_localOffset1).multiplyScalar(radiusM + clampH(h1));

      _localOffset2.copy(_local).addScaledVector(_t2, epsilon).normalize();
      const h2 = heightAt(_localOffset2);
      _localSurfB.copy(_localOffset2).multiplyScalar(radiusM + clampH(h2));

      _localSurfA.sub(_localCenter);
      _localSurfB.sub(_localCenter);
      out.crossVectors(_localSurfA, _localSurfB).normalize();
      if (out.dot(radial) < 0) out.negate();
      out.applyQuaternion(this.orientation);
      return out;
    },

    update(cameraWorldPos: THREE.Vector3, _dt: number): void {
      if (!materialized) return;
      // Amortize deferred root-mesh builds: one chunk per frame per body.
      // After all 6 face roots are built the LOD walk runs normally and
      // subdivides further as the player approaches.
      if (pendingRootBuilds.length > 0) {
        buildNodeMesh(pendingRootBuilds.shift()!);
      }
      _cameraLocal.copy(cameraWorldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      for (const root of roots) {
        if (!root.mesh) continue;  // root still pending — its center isn't set yet
        updateNode(root);
      }
      // TODO(features): volcano emission, life biosignatures (city
      // lights on night side for intelligent stage), tectonic crack
      // overlays. features.tectonicActivity / features.tidalHeatFlux /
      // features.life are available here.
    },

    materialize(): void {
      if (materialized) return;
      materialized = true;

      // Shader-injected planet material — shader compile happens at the
      // first render frame after a chunk is added to the scene, so this
      // cost is naturally co-located with the chunk-build amortization.
      planetMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.0,
        transparent: true,
        opacity: 0,
      });
      attachSurfaceDetailShader(planetMaterial, seed);

      // Scatter resources (instanced tree / rock GPU buffers) — only for
      // earthlike-class bodies large enough that LOD will eventually
      // reach MIN_SCATTER_DEPTH.
      if (scatterEnabled) {
        scatterResources = createScatterResources(palette);
        body.scatter = scatterRegistry;
      }

      // 6 quadtree root structs + queue their mesh builds. buildNodeMesh
      // uses planetMaterial, so this MUST run after planetMaterial init.
      roots = FACE_NORMALS.map((normal, idx) => {
        const { u, v } = faceBasis(normal);
        return makeNode(idx, normal, u, v, -1, 1, -1, 1, 0);
      });
      pendingRootBuilds.push(...roots);

      // Ocean shell (single sphere — built up front since it's relatively
      // small compared to the chunk grid).
      if (palette.oceanSurface) {
        const OCEAN_OFFSET = 3;
        const ocean = new THREE.Mesh(
          new THREE.SphereGeometry(radiusM + seaLevel - OCEAN_OFFSET, 128, 96),
          new THREE.MeshStandardMaterial({
            color: palette.oceanSurface.clone(),
            roughness: 0.3,
            metalness: 0.1,
            transparent: true,
            opacity: 0,
          }),
        );
        ocean.name = "ocean";
        group.add(ocean);
      }

      // Cloud shell — translucent sphere at cloudBaseAltitude with fBm
      // noise modulated by coverage. Skipped if the body has no
      // meaningful clouds.
      if (body.cloudBaseAltitude !== undefined
          && body.cloudCoverage !== undefined
          && body.cloudCoverage > 0.01
          && body.cloudColor) {
        const cloudShell = buildCloudShell({
          radiusM,
          cloudBaseM: body.cloudBaseAltitude,
          cloudThicknessM: body.cloudThickness ?? 4000,
          coverage: body.cloudCoverage,
          color: body.cloudColor,
          seed,
        });
        group.add(cloudShell);
      }

      // Atmosphere halo shell — backface-rendered sphere at the visible
      // top of the atmosphere with a fresnel-driven scattering tint.
      // Gives the iconic "thin blue line" silhouette from orbit. Skip
      // for airless bodies.
      if (atm.surfacePressureBar > 0.001 && body.atmosphereTopAltitude) {
        const haloShell = buildAtmosphereShell({
          radiusM,
          atmosphereTopM: body.atmosphereTopAltitude,
          zenithColor: body.skyDay ?? atm.skyZenithColor,
          horizonColor: body.skyHorizon ?? atm.skyHorizonColor,
        });
        group.add(haloShell);
      }

      body.materialize = undefined;
    },
  };

  return { body, light: null };
}

// ── Sky / cloud color helpers ───────────────────────────────────────────────

// Earth-default sky colors used by EARTHLIKE_BLUE (the only "neutral
// Earth physics" palette). Any other palette is treated as a deliberate
// artistic override.
const EARTH_PALETTE_SKY = new THREE.Color("#87ceeb");
const EARTH_PALETTE_NIGHT = new THREE.Color("#070b1c");

function isStylizedPaletteSky(palette: RockyPalette): boolean {
  // A palette is "stylized" (overriding physics) if its sky color differs
  // from the default Earth blue/night. The moon palette also counts as
  // stylized (intentional near-black sky overrides any thin atmosphere
  // the physics happens to give a small body).
  const dayDiff = Math.abs(palette.skyDay.r - EARTH_PALETTE_SKY.r)
    + Math.abs(palette.skyDay.g - EARTH_PALETTE_SKY.g)
    + Math.abs(palette.skyDay.b - EARTH_PALETTE_SKY.b);
  if (dayDiff > 0.05) return true;
  const nightDiff = Math.abs(palette.skyNight.r - EARTH_PALETTE_NIGHT.r)
    + Math.abs(palette.skyNight.g - EARTH_PALETTE_NIGHT.g)
    + Math.abs(palette.skyNight.b - EARTH_PALETTE_NIGHT.b);
  return nightDiff > 0.05;
}

function darkenForNight(color: THREE.Color): THREE.Color {
  // Night side of an atmosphere is the day color scaled down + slightly
  // shifted toward blue (residual Rayleigh from twilight terminator).
  // Pure-black for very dim daytime skies (Mercury/Moon physics).
  const intensity = (color.r + color.g + color.b) / 3;
  if (intensity < 0.02) return new THREE.Color(0, 0, 0);
  return new THREE.Color(
    color.r * 0.08,
    color.g * 0.10,
    color.b * 0.14,
  );
}

function cloudColorFor(cloudType: BodyFeatures["atmosphere"]["cloudType"]): THREE.Color | undefined {
  switch (cloudType) {
    case "water":         return new THREE.Color(0.95, 0.95, 0.97);
    case "sulfuric_acid": return new THREE.Color(0.92, 0.85, 0.70);
    case "ammonia":       return new THREE.Color(0.86, 0.78, 0.66);
    case "methane":       return new THREE.Color(0.62, 0.78, 0.88);
    case "co2_ice":       return new THREE.Color(0.85, 0.83, 0.82);
    case "iron_silicate": return new THREE.Color(0.65, 0.45, 0.35);
    case "none":
    default:              return undefined;
  }
}

// ── Atmosphere halo shell ───────────────────────────────────────────────────
//
// A sphere larger than the body, rendered with backface culling so its
// FAR side faces the camera when outside the body. The fresnel-shaped
// alpha concentrates opacity at the limb, producing the "thin blue
// line" seen from orbit.
//
// Inside-shell handling: BackSide rendering does NOT cull the shell
// when the camera is INSIDE the sphere — every face has its outward
// normal pointing away from the interior camera, so all faces qualify
// as back-faces and render. Sky color while standing on the surface
// is already painted by the createSky background pass, so the shader
// explicitly discards inside-shell fragments to avoid a screen-covering
// blue overlay.

interface AtmosphereShellOpts {
  radiusM: number;
  atmosphereTopM: number;
  zenithColor: THREE.Color;
  horizonColor: THREE.Color;
}

function buildAtmosphereShell(opts: AtmosphereShellOpts): THREE.Mesh {
  const { radiusM, atmosphereTopM, zenithColor, horizonColor } = opts;
  const shellRadius = radiusM + atmosphereTopM;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPlanetRadius: { value: radiusM },
      uShellRadius: { value: shellRadius },
      uZenith: { value: zenithColor.clone() },
      uHorizon: { value: horizonColor.clone() },
      uOpacity: { value: 0 },  // updated by world.setBodyMeshOpacity ramp
    },
    // Derive the planet center from `modelMatrix` (the body group's
    // world transform) so this works correctly regardless of the
    // body's translation — floating-origin rebases and orbital motion
    // both move the planet in world space; a baked uPlanetCenter would
    // go stale immediately.
    vertexShader: `
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vPlanetCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uPlanetRadius;
      uniform float uShellRadius;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform float uOpacity;
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;

      void main() {
        // DIAGNOSTIC: re-enabled full fade (atmThickness-scaled).
        // Final fragment color is forced RED below so we can SEE
        // exactly which pixels are the atmosphere shell. If the white
        // wash is the shell, the white will turn red. If something
        // else, the sky stays white-ish and red only appears in the
        // shell's actual location (the limb glow).
        float cameraAlt = length(cameraPosition - vPlanetCenter);
        float atmThickness = uShellRadius - uPlanetRadius;
        float fadeBand = atmThickness * 0.2;
        float exteriorT = smoothstep(
          uShellRadius - fadeBand,
          uShellRadius + fadeBand,
          cameraAlt
        );
        if (exteriorT < 0.001) discard;

        // Outward normal at this shell point, in world frame.
        vec3 toCenter = vWorldPos - vPlanetCenter;
        vec3 outwardN = normalize(toCenter);
        vec3 viewDir = normalize(cameraPosition - vWorldPos);

        // Fresnel-like: alpha is highest where the view skims the
        // shell tangentially (limb), lowest where the view looks
        // straight through. Power 1.5 (was 2.5) widens the limb band
        // so the horizon glow reads as a soft halo rather than a
        // hard line at the planet edge.
        float vd = abs(dot(viewDir, outwardN));
        float limb = pow(1.0 - vd, 1.5);

        // Vertical blend: more horizon tint near the planet's surface
        // (low local y in the planet-frame), more zenith tint at the top
        // of the shell. We approximate the "vertical" direction along
        // the view ray as the planet's outward normal, so this gradient
        // is correct from any vantage.
        float alt = length(toCenter);
        float vT = clamp((alt - uPlanetRadius) / max(1.0, uShellRadius - uPlanetRadius), 0.0, 1.0);
        vec3 atmColor = mix(uHorizon, uZenith, vT);

        float a = limb * uOpacity * 0.85 * exteriorT;
        if (a < 0.005) discard;
        gl_FragColor = vec4(atmColor, a);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // Make uOpacity participate in the mesh-fade-in path that drives
  // every other body mesh. world.setBodyMeshOpacity sets material.opacity
  // each frame; we mirror that into our shader uniform via a property
  // accessor so we don't need a custom code path.
  Object.defineProperty(material, "opacity", {
    get() { return (material.uniforms.uOpacity.value as number); },
    set(v: number) { material.uniforms.uOpacity.value = v; },
    configurable: true,
  });

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(shellRadius, 96, 64),
    material,
  );
  mesh.name = "atmosphere_halo";
  mesh.frustumCulled = false;
  // Render after the body itself so the limb glow correctly overdraws
  // the planet silhouette edge.
  mesh.renderOrder = 1;
  return mesh;
}

// ── Cloud shell ─────────────────────────────────────────────────────────────
//
// Translucent sphere at the cloud base altitude, with shader-generated
// fBm noise threshold-clipped by cloud coverage. Coverage 1.0 → fully
// opaque deck (Venus). Coverage 0.5 → patchy clouds (Earth). Coverage
// 0.1 → wisps (Mars). Rendered double-sided so both ground-view (from
// below the deck) and orbital-view (from above) look right.

interface CloudShellOpts {
  radiusM: number;
  cloudBaseM: number;
  cloudThicknessM: number;
  coverage: number;
  color: THREE.Color;
  seed: number;
}

function buildCloudShell(opts: CloudShellOpts): THREE.Mesh {
  const { radiusM, cloudBaseM, coverage, color, seed } = opts;
  const shellRadius = radiusM + cloudBaseM;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSeed: { value: seed },
      uCoverage: { value: coverage },
      uColor: { value: color.clone() },
      uOpacity: { value: 0 },
      uShellRadius: { value: shellRadius },
      uPlanetRadius: { value: radiusM },
    },
    // The cloud sphere wraps around the camera when the bird is below
    // the deck — every visible fragment is back-face cloud noise,
    // creating an enveloping haze instead of an overhead deck. We
    // compute the camera-to-fragment angle relative to the planet
    // outward direction (essentially "is this cloud fragment above
    // or below the player's horizon?") in the fragment shader and
    // suppress fragments that lie BELOW the player when the camera
    // is well under the deck. Result: looking up at the bird's
    // altitude shows a proper cloud ceiling; looking down doesn't
    // show cloud noise wrapped under your feet.
    vertexShader: `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vPlanetCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uSeed;
      uniform float uCoverage;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uShellRadius;
      uniform float uPlanetRadius;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;

      // Stable hash + value noise — same family used elsewhere in this
      // file for surface detail and gas bands.
      float cloudHash(vec3 p) {
        p = fract(p * 0.3183099 + uSeed * 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float cloudNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = cloudHash(i);
        float n100 = cloudHash(i + vec3(1.0, 0.0, 0.0));
        float n010 = cloudHash(i + vec3(0.0, 1.0, 0.0));
        float n110 = cloudHash(i + vec3(1.0, 1.0, 0.0));
        float n001 = cloudHash(i + vec3(0.0, 0.0, 1.0));
        float n101 = cloudHash(i + vec3(1.0, 0.0, 1.0));
        float n011 = cloudHash(i + vec3(0.0, 1.0, 1.0));
        float n111 = cloudHash(i + vec3(1.0, 1.0, 1.0));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z
        );
      }
      float fbm(vec3 p) {
        float n = 0.0;
        float amp = 0.5;
        float freq = 1.0;
        for (int i = 0; i < 4; i++) {
          n += amp * cloudNoise(p * freq);
          freq *= 2.0;
          amp *= 0.5;
        }
        return n;
      }

      void main() {
        // NOTE: this sphere-based cloud approach hits z-fighting at
        // planetary scale (depth precision can't separate a sphere at
        // R+2km from terrain at R+0..8km). Replaced by VolumetricCloudPass
        // (a post-process ray-march). This shader stays in the file but
        // the mesh is disabled by default (cloudMult = 0 in GFX).
        vec3 C = cameraPosition;
        vec3 O = vPlanetCenter;
        vec3 F = vWorldPos;
        vec3 d = F - C;
        float dLenSq = dot(d, d);
        float tMin = dot(O - C, d) / max(dLenSq, 1e-6);
        if (tMin > 0.0 && tMin < 1.0) {
          vec3 closest = C + tMin * d;
          float distOC = length(closest - O);
          if (distOC < uPlanetRadius) discard;
        }
        float n = fbm(vLocalPos * 8e-7);
        float threshold = mix(0.7, 0.15, uCoverage);
        float density = smoothstep(threshold, threshold + 0.2, n);
        if (density < 0.01) discard;
        gl_FragColor = vec4(uColor, density * uOpacity);
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  Object.defineProperty(material, "opacity", {
    get() { return (material.uniforms.uOpacity.value as number); },
    set(v: number) { material.uniforms.uOpacity.value = v; },
    configurable: true,
  });

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(shellRadius, 96, 64),
    material,
  );
  mesh.name = "cloud_shell";
  mesh.frustumCulled = false;
  // Render late so the cloud sphere ends up after terrain/halos. With
  // depth test off we rely on render order alone for layering.
  mesh.renderOrder = 2;
  return mesh;
}

// ── Palette selection (rocky) ───────────────────────────────────────────────

function selectRockyPalette(
  physBody: Body,
  state: BodyState,
  features: BodyFeatures,
): RockyPalette {
  // Moon-class: small bodies orbiting a non-stellar parent → classic moon.
  // TODO(features): distinct ice-moon palette (Europa) vs rock-moon
  // palette (Luna) vs sulfur-moon (Io) once features.tidalHeatFlux and
  // composition fractions are wired here.
  if (state.totalMass < 0.1) {
    return MOON_PALETTE;
  }
  // Use greenhouse-adjusted temperature so Earth-class worlds (T_eq ≈ 254 K,
  // T_eff ≈ 287 K) and Venus-class runaway (T_eq ≈ 299 K, T_eff ≈ 732 K)
  // sort into the right buckets.
  const Tk = features.effectiveSurfaceTempK;
  // Runaway-greenhouse Venus-class: thick CO2 + sulfuric clouds.
  if (features.atmosphere.composition === "thick_co2") return BARREN_YELLOW;
  // Habitable + temperate: pick from the earthlike variants.
  if (features.life.habitability > 0.3 && Tk >= 230 && Tk <= 320) {
    const variants: RockyPalette[] = [
      EARTHLIKE_BLUE, EARTHLIKE_RED_GRASS, EARTHLIKE_VIOLET_GRASS, EARTHLIKE_TEAL_OCEAN,
    ];
    return variants[bodyHash(physBody.id) % variants.length];
  }
  // Frozen.
  if (Tk < 180) return ICE_WORLD;
  // Scorched.
  if (Tk > 700) return BARREN_DARK;
  // Default barren rocky — pick deterministically from neutral options.
  const variants: RockyPalette[] = [BARREN_MARS, BARREN_GRAY_PLANET, BARREN_BROWN];
  return variants[bodyHash(physBody.id) % variants.length];
}

// ── Shared scene helpers ────────────────────────────────────────────────────

function totalMassKg(state: BodyState): number {
  return state.totalMass * M_EARTH_KG;
}

function estimateBulkDensity(state: BodyState, radiusM: number, massKg: number): number {
  if (radiusM <= 0) return 1000;
  const volumeM3 = (4 / 3) * Math.PI * radiusM * radiusM * radiusM;
  const density = massKg / volumeM3;
  // Clamp to physical limits: lowest is a fluffy gas envelope (~100), highest
  // is degenerate matter (white dwarf ~1e9). The warp-impedance formula
  // takes the 1/4 root of (density / RHO_REF_BULK) so huge extremes still
  // produce sane K values.
  return Math.max(100, Math.min(1e9, density));
}

function deriveAtmosphereScaleHeight(state: BodyState, radiusM: number, gm: number): number {
  // H ≈ k_B × T / (μ × g). Mean molecular mass assumed Earth-air-like for
  // small bodies; large H/He envelopes get a smaller μ. Picks a sensible
  // value across the full mass range without requiring composition-specific
  // tables (which are TODO).
  if (radiusM <= 0) return 8000;
  const gSurf = gm / (radiusM * radiusM);
  if (gSurf <= 0) return 8000;
  // μ in kg: 29 amu for N2/O2, dropping toward 4 amu (He) / 2 (H2) for gas
  // giants. Map by H/He fraction.
  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  const muAmu = hheFrac > 0.3 ? 2.3 : 29;
  const mu = muAmu * 1.66053906660e-27;
  const kB = 1.380649e-23;
  const T = Math.max(50, state.surfaceTemp);
  const H = (kB * T) / (mu * gSurf);
  // Clamp to a sane range so degenerate inputs (radiusM tiny, gSurf huge)
  // don't produce sub-meter scale heights that would confuse the
  // atmospheric-density model.
  return Math.max(1000, Math.min(2_000_000, H));
}

function attachSurfaceDetailShader(material: THREE.MeshStandardMaterial, seed: number): void {
  // Procedural surface-detail noise — adds local color variation that
  // fades with camera distance so distant terrain reads as smooth biome
  // color and high-frequency noise doesn't shimmer at the horizon.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeed = { value: seed };
    shader.uniforms.uDetailRange = { value: CHUNKS.surfaceDetailRange };
    shader.uniforms.uDetailAmount = { value: CHUNKS.surfaceDetailAmount };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vLocalPos;
         varying vec3 vWorldPos;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vLocalPos = position;
         vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uSeed;
         uniform float uDetailRange;
         uniform float uDetailAmount;
         varying vec3 vLocalPos;
         varying vec3 vWorldPos;

         float seagullHash3(vec3 p) {
           p = fract(p * 0.3183099 + uSeed * 0.1);
           p *= 17.0;
           return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
         }
         float seagullValueNoise(vec3 p) {
           vec3 i = floor(p);
           vec3 f = fract(p);
           f = f * f * (3.0 - 2.0 * f);
           float n000 = seagullHash3(i);
           float n100 = seagullHash3(i + vec3(1.0, 0.0, 0.0));
           float n010 = seagullHash3(i + vec3(0.0, 1.0, 0.0));
           float n110 = seagullHash3(i + vec3(1.0, 1.0, 0.0));
           float n001 = seagullHash3(i + vec3(0.0, 0.0, 1.0));
           float n101 = seagullHash3(i + vec3(1.0, 0.0, 1.0));
           float n011 = seagullHash3(i + vec3(0.0, 1.0, 1.0));
           float n111 = seagullHash3(i + vec3(1.0, 1.0, 1.0));
           return mix(
             mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
             f.z
           );
         }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float seagullDist = length(vWorldPos - cameraPosition);
         float seagullDetailMix = 1.0 - smoothstep(uDetailRange * 0.3, uDetailRange, seagullDist);
         if (seagullDetailMix > 0.001) {
           // Three octaves so walking motion reads at every scale: the
           // coarse band gives big patches of brightness, fine gives
           // ~2 m mottling, micro gives sub-meter speckle that visibly
           // moves under the bird step-by-step. Micro is gated extra
           // hard on distance so it doesn't shimmer on the horizon.
           float seagullCoarse = seagullValueNoise(vLocalPos * 0.08);
           float seagullFine = seagullValueNoise(vLocalPos * 0.45);
           float seagullMicro = seagullValueNoise(vLocalPos * 2.2);
           float seagullMicroFade = 1.0 - smoothstep(40.0, 180.0, seagullDist);
           float seagullN =
             seagullCoarse * 0.45 +
             seagullFine   * 0.35 +
             seagullMicro  * 0.20 * seagullMicroFade
             - 0.5 * (0.45 + 0.35 + 0.20 * seagullMicroFade);
           diffuseColor.rgb *= 1.0 + seagullN * uDetailAmount * seagullDetailMix;
         }`,
      );
  };
}

// ── Quadtree internals (rocky terrain LOD) ──────────────────────────────────

interface QuadtreeNode {
  faceIndex: number;
  faceNormal: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  depth: number;
  center: THREE.Vector3;
  size: number;
  mesh: THREE.Mesh | null;
  children: QuadtreeNode[] | null;
  scatter: ChunkScatter | null;
}

function faceBasis(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const up = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(up, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  return { u, v };
}

function makeNode(
  faceIndex: number,
  faceNormal: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  uMin: number, uMax: number,
  vMin: number, vMax: number,
  depth: number,
): QuadtreeNode {
  return {
    faceIndex,
    faceNormal,
    uAxis,
    vAxis,
    uMin, uMax, vMin, vMax,
    depth,
    center: new THREE.Vector3(),
    size: 0,
    mesh: null,
    children: null,
    scatter: null,
  };
}
