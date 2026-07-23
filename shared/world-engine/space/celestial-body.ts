// shared/space/celestial-body.ts
//
// The scene-side CelestialBody FACTORY — the physics + sampler half of
// seagull's celestial-body.ts, ported. It turns a ResolvedBody (ported
// physics: state + features) into a CelestialBody the flight sim can fly:
// gravity (gm), atmosphere (scale height + surface density → the warp gate),
// transforms, and — for rocky worlds — the terrain samplers.
//
// THE TERRAIN SEAM: a rocky body's `heightAt`/`surfaceAt`/`altitudeAt`/
// `groundNormalAt` read the shared world model's geography (Stage 2
// `buildPlanetGeography` → PlanetSurface), NOT seagull's noise. Everything
// else about the body (how thick the air is, how strong gravity is, where
// mountains reach) is the ported physics.
//
// Rendering (meshes, atmosphere shells, clouds, ocean) is deferred to Stage 4c
// via `materialize`; this factory leaves the group empty so the physics
// universe is flyable + headless-testable now.

import * as THREE from "three";
import type { CelestialBody, BodyOrbit } from "./body.js";
import { computeHillRadius, computeVisualHillRadius } from "./body.js";
import type { ResolvedBody } from "./physics/index.js";
import {
  buildPlanetGeography, hasOceanFeatures, R_EARTH_M, type PlanetGeography,
} from "./planet-geography.js";
import type { PlanetSurface } from "../planet/surface.js";
import { createPlanetObject, type PlanetObject } from "../planet/three.js";
import { terrainMaterial } from "../materials.js";
import { computeTerminatorWidth, applyToonTerminator, type PlanetTerminatorOpts } from "../planet/day-night.js";
import {
  buildAtmosphereShell, buildAtmosphereVeil, buildGasBandMaterial, hazeTauFromPressure,
} from "./atmosphere.js";

const M_EARTH_KG = 5.972e24;
const G_NEWTON = 6.674e-11;
const K_BOLTZMANN = 1.380649e-23;
const AMU = 1.66053906660e-27;
/** A star's Hill sphere is overridden to ~2 ly so a system's edge is reachable. */
const STAR_HILL_M = 2e16;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** An OFF-THREAD geography bake (a worker): same contract as the
 *  synchronous buildPlanetGeography, resolved later. `compression` is the
 *  planet-compression factor (GeographyOpts.compression) — the surface must
 *  build at the body's compressed radius. */
export type GeographyBaker = (
  resolved: ResolvedBody,
  systemSeed: number,
  faceN: number,
  compression?: number,
) => Promise<PlanetGeography>;

export interface CreateBodyOpts {
  resolved: ResolvedBody;
  /** The system seed — makes each body's geography deterministic. */
  systemSeed: number;
  /** Spawn position (overwritten from the orbit on the first transform tick). */
  initialPosition: THREE.Vector3;
  orbit: BodyOrbit | null;
  /** Cube-sphere face resolution for a rocky body's geography (orbital = 24). */
  faceN?: number;
  /** When provided, a walkable body's geography bakes ASYNC (off-thread):
   *  the body shows as a smooth tinted sphere the moment it materializes,
   *  and the real terrain swaps in when the bake lands — the flight never
   *  stops for a bake unless the host's force gate says the player outran
   *  it. Without it, materialize bakes synchronously (the legacy lump). */
  bakeGeography?: GeographyBaker;
  /** PLANET COMPRESSION (space-time-compression.md §5): the miniature-world
   *  factor. Radius ÷ compression and mass ÷ compression², so SURFACE GRAVITY
   *  (gm/r²) — and with it the walk, the air, the flight feel at the ground —
   *  is exactly the real body's. Default 1 (real scale). */
  compression?: number;
}

export interface CreatedBody {
  body: CelestialBody;
  /** Non-null for the luminous primary (Stage 4c attaches its light). */
  isLuminous: boolean;
}

// Shared sampler temporaries (samplers run sequentially, single-threaded).
const _local = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _seedX = new THREE.Vector3(1, 0, 0);
const _seedY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _lc = new THREE.Vector3();
const _o1 = new THREE.Vector3();
const _o2 = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sunDir = new THREE.Vector3();

/** e-folding atmosphere scale height (m), seagull's scene-side derivation
 *  (celestial-body.ts deriveAtmosphereScaleHeight). */
function scaleHeightM(gm: number, radiusM: number, hheFrac: number, surfaceTemp: number): number {
  const gSurf = gm / (radiusM * radiusM);
  const muAmu = hheFrac > 0.3 ? 2.3 : 29;
  const h = (K_BOLTZMANN * Math.max(50, surfaceTemp)) / (muAmu * AMU * gSurf);
  return clamp(h, 1000, 2_000_000);
}

export function createCelestialBody(opts: CreateBodyOpts): CreatedBody {
  const { resolved, orbit, initialPosition } = opts;
  const { state, features } = resolved;

  const hheFrac = state.currentHHe / Math.max(1e-9, state.totalMass);
  const isLuminous = state.fusionMode === "hydrogen" || state.luminosity > 1.0;
  const isGas = !isLuminous && hheFrac > 0.3;
  const type: CelestialBody["type"] = isLuminous ? "star" : isGas ? "gas" : "rocky";

  // Miniaturization preserves surface gravity: r ÷ s, m ÷ s² ⇒ gm/r² unchanged.
  const compression = Math.max(1, opts.compression ?? 1);
  const radiusM = Math.max(1, (state.radius * R_EARTH_M) / compression);
  const massKg = (state.totalMass * M_EARTH_KG) / (compression * compression);
  const gm = G_NEWTON * massKg;
  const atmosphereScaleHeight = scaleHeightM(gm, radiusM, hheFrac, state.surfaceTemp);

  // Surface air density (kg/m³): hydrostatic P/(g·H) for rocky worlds with real
  // pressure; heavy defaults for gas/star so warp + wing feel the body.
  let surfaceAirDensity: number;
  if (isLuminous) surfaceAirDensity = 1000;
  else if (isGas) surfaceAirDensity = 50;
  else {
    const pBar = features.atmosphere.surfacePressureBar;
    surfaceAirDensity = pBar > 0 ? (pBar * 1e5) / ((gm / (radiusM * radiusM)) * atmosphereScaleHeight) : 0;
  }
  const warpDensity = isLuminous ? 0.2 : isGas ? 0.4 : 1.0;
  const bulkDensity = clamp(massKg / ((4 / 3) * Math.PI * radiusM ** 3), 100, 1e9);

  // Spin: axis tilted from the orbital pole by the axial tilt; signed rate.
  const tilt = features.rotation.axialTilt;
  const axis = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt).normalize();
  const periodH = features.rotation.periodHours;
  const rate = Math.abs(periodH) > 1e-6 ? (2 * Math.PI) / (periodH * 3600) : 0;

  const hillRadius = isLuminous || !orbit ? STAR_HILL_M : computeHillRadius(orbit, gm);
  const visualHillRadius = isLuminous || !orbit ? STAR_HILL_M : computeVisualHillRadius(orbit, radiusM);

  // Rocky worlds with a real surface are walkable. Their GEOGRAPHY (the shared
  // world model's tectonics/substrate) is DEFERRED to `materialize` — the
  // load-radius story: a distant planet is a sphere/point until it approaches
  // ~1px, at which point its geology bakes and its terrain samplers install.
  const walkable = type === "rocky" && features.terrain.maxReliefKm > 0;
  const hasOcean = walkable && hasOceanFeatures(resolved); // features-only; no bake needed
  let surface: PlanetSurface | null = null;
  const seaLevel = 0; // the geography surface puts sea at elevation 0

  const group = new THREE.Group();
  group.name = `body:${resolved.body.id}`;

  const body: CelestialBody = {
    id: resolved.body.id,
    type,
    radius: radiusM,
    influenceFalloff: hillRadius,
    gm,
    atmosphereScaleHeight,
    orbit,
    rotation: { axis, rate },
    walkable,
    hasOcean,
    seaLevel,
    group,
    worldPosition: initialPosition.clone(),
    prevWorldPosition: initialPosition.clone(),
    orientation: new THREE.Quaternion(),
    inverseOrientation: new THREE.Quaternion(),
    hillRadius,
    visualHillRadius,
    warpDensity,
    bulkDensity,
    surfaceAirDensity,
    velocity: new THREE.Vector3(),
    resolvedPhysics: resolved,
    // The distant-body halo/marker paint uses this; stars carry NO haloColor
    // (they read as their registry starfield dot, then their disc fades in).
    haloColor: type === "star" ? undefined : features.surfaceColor.clone(),

    upAt(worldPos, out = new THREE.Vector3()) {
      return out.copy(worldPos).sub(this.worldPosition).normalize();
    },
    altitudeAt(worldPos) {
      if (!surface) return worldPos.distanceTo(this.worldPosition) - radiusM;
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      const dist = _local.length();
      _localDir.copy(_local).normalize();
      const h = surface.heightAt([_localDir.x, _localDir.y, _localDir.z]);
      const surfaceH = hasOcean ? Math.max(h, seaLevel) : h;
      return dist - (radiusM + surfaceH);
    },
    update() {
      // LOD terrain walk + clouds are wired in Stage 4c; the physics body is
      // static geometry-wise.
    },
  };

  // Day/night terminator (day-night.ts). Width is derived from the illuminating
  // star's angular size + this body's atmosphere + its radius, so a small hazy
  // world gets a soft edge and a big airless one a sharp edge. Climb to the
  // luminous ancestor: a planet's parent IS the star; a moon's is its planet, so
  // step up once more and use the PLANET's orbital radius as the star distance.
  let starRadiusM = radiusM;
  let starDistanceM = Infinity;
  let starBody: CelestialBody | null = null;
  {
    let parent = orbit?.parent ?? null;
    let dist = orbit?.semiMajorAxis ?? Infinity;
    while (parent && parent.type !== "star" && parent.orbit) {
      dist = parent.orbit.semiMajorAxis;
      parent = parent.orbit.parent;
    }
    if (parent) { starRadiusM = parent.radius; starDistanceM = dist; starBody = parent; }
  }
  const terminatorOpts: PlanetTerminatorOpts = {
    width: computeTerminatorWidth({
      starRadiusM, starDistanceM, planetRadiusM: radiusM, atmosphereScaleHeightM: atmosphereScaleHeight,
    }),
  };

  // Atmosphere shells whose `uSunDir` this body drives each frame — the sun
  // direction is what makes the limb glow a day-side crescent with a dawn/dusk
  // edge instead of a symmetric halo (atmosphere.ts). Populated in materialize.
  const atmosphereMaterials: THREE.ShaderMaterial[] = [];

  // Install the terrain samplers once the geography is baked (in materialize).
  const installTerrainSamplers = (surf: PlanetSurface): void => {
    body.heightAt = (localDir: THREE.Vector3) => surf.heightAt([localDir.x, localDir.y, localDir.z]);
    body.surfaceAt = function (worldPos, out = new THREE.Vector3()) {
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      _localDir.copy(_local).normalize();
      const h = surf.heightAt([_localDir.x, _localDir.y, _localDir.z]);
      const surfaceH = hasOcean ? Math.max(h, seaLevel) : h;
      out.copy(_localDir).multiplyScalar(radiusM + surfaceH);
      return out.applyQuaternion(this.orientation).add(this.worldPosition);
    };
    body.groundNormalAt = function (worldPos, epsilon, out = new THREE.Vector3()) {
      _local.copy(worldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
      const radial = _localDir.copy(_local).normalize();
      const seed = Math.abs(radial.y) < 0.9 ? _seedY : _seedX;
      _t1.crossVectors(seed, radial).normalize();
      _t2.crossVectors(radial, _t1).normalize();
      const clampH = (h: number) => (hasOcean ? Math.max(h, seaLevel) : h);
      const hc = surf.heightAt([radial.x, radial.y, radial.z]);
      _lc.copy(radial).multiplyScalar(radiusM + clampH(hc));
      _o1.copy(_local).addScaledVector(_t1, epsilon).normalize();
      _sa.copy(_o1).multiplyScalar(radiusM + clampH(surf.heightAt([_o1.x, _o1.y, _o1.z])));
      _o2.copy(_local).addScaledVector(_t2, epsilon).normalize();
      _sb.copy(_o2).multiplyScalar(radiusM + clampH(surf.heightAt([_o2.x, _o2.y, _o2.z])));
      _sa.sub(_lc);
      _sb.sub(_lc);
      out.crossVectors(_sa, _sb).normalize();
      if (out.dot(radial) < 0) out.negate();
      return out.applyQuaternion(this.orientation);
    };
  };

  // ── Rendering (Stage 4c), deferred via `materialize` ────────────────────
  // Called when the body first approaches ~1px (Stage 4d's pixel trigger, or
  // eagerly for the home planet). Builds the THREE meshes into `body.group`;
  // rocky terrain reuses the shared planet renderer over the geography surface.
  const _camLocal = new THREE.Vector3();
  let planetObj: PlanetObject | null = null;
  let materialized = false;
  let interim: THREE.Mesh | null = null;
  let bakePromise: Promise<void> | null = null;

  const buildTerrainMesh = (): void => {
    if (!surface || planetObj) return;
    if (interim) {
      body.group.remove(interim);
      interim.geometry.dispose();
      (interim.material as THREE.Material).dispose();
      interim = null;
    }
    planetObj = createPlanetObject(surface, {
      // Seagull's chunk resolution — 33² verts. Chunk resolution is a
      // MESH density knob, independent of the substrate faceN; coupling
      // them (97² verts at faceN 48) made every chunk build ~9× seagull's
      // vertex count and each LOD subdivide a visible hitch.
      resolution: 33,
      // Deep quadtree (seagull's 18) so chunks keep subdividing right under
      // the camera — metre-scale vertex spacing up close instead of the
      // low-poly facets a shallow cap left.
      maxDepth: 18,
      // ONE subdivision (4 chunk builds, each ~1000 synchronous heightAt
      // samples) per frame: unbounded, a low fast camera forced dozens of
      // builds into single frames — the "flying lags, walking doesn't"
      // stutter. The tree converges over a handful of frames instead.
      buildBudget: 1,
      ocean: hasOcean ? { color: 0x1a4f7a } : false,
      terminator: terminatorOpts,
    });
    body.group.add(planetObj.group);
  };

  const installGeography = (geo: PlanetGeography): void => {
    // The whole built world model stays on the body: `geography.sites` is
    // where the civ layer founds this world's cities.
    body.geography = geo.built;
    surface = geo.built.surface;
    installTerrainSamplers(surface);
    // Local terrain re-sample (a refined region's streams joined the river
    // relief): chunk centers sit at ~radius from the body center, so the
    // query point is the surface point under the given direction.
    body.refreshTerrain = (localDir, withinM) => {
      planetObj?.lod.refresh(
        [localDir[0] * radiusM, localDir[1] * radiusM, localDir[2] * radiusM], withinM,
      );
    };
    if (materialized) buildTerrainMesh();
  };

  if (walkable && opts.bakeGeography) {
    const bake = opts.bakeGeography;
    body.startGeographyBake = () => {
      if (bakePromise) return;
      bakePromise = bake(resolved, opts.systemSeed, opts.faceN ?? 24, compression)
        .then(geo => { installGeography(geo); })
        .catch(err => {
          // A failed bake leaves the smooth sphere standing — visible and
          // honest, and the next session can retry.
          console.error(`geography bake failed for ${resolved.body.id}:`, err);
          bakePromise = null;
        });
      body.whenGeography = bakePromise;
    };
    Object.defineProperty(body, "geographyPending", {
      get: () => !surface,
    });
  }

  body.materialize = () => {
    body.materialize = undefined; // idempotent
    materialized = true;
    if (walkable) {
      atmosphereMaterials.push(...attachAtmosphere(body, features, radiusM)); // independent of terrain
      if (opts.bakeGeography) {
        if (surface) {
          buildTerrainMesh();
        } else {
          // The load-radius story, off-thread: a smooth tinted sphere NOW,
          // the baked terrain swapped in when the worker lands.
          const interimMat = terrainMaterial({ color: features.surfaceColor, roughness: 0.95 });
          applyToonTerminator(interimMat, terminatorOpts);
          interim = new THREE.Mesh(new THREE.SphereGeometry(radiusM, 64, 48), interimMat);
          interim.name = "interim_sphere";
          body.group.add(interim);
          body.startGeographyBake!();
        }
      } else {
        // Legacy synchronous bake (headless tests, hosts without a worker).
        installGeography(buildPlanetGeography(resolved, opts.systemSeed, { faceN: opts.faceN, compression }));
      }
    } else if (type === "gas") {
      // Banded shader sphere (latitude bands + noise wobble) instead of a
      // flat tint, then the same limb glow + haze as a rocky world.
      const geo = new THREE.SphereGeometry(radiusM, 128, 96);
      const mat = buildGasBandMaterial({
        bodyId: resolved.body.id,
        baseColor: state.color,
        atmosphericBandCount: features.atmosphericBandCount,
      });
      body.group.add(new THREE.Mesh(geo, mat));
      atmosphereMaterials.push(...attachAtmosphere(body, features, radiusM, /* gasGiant */ true));
    } else if (type === "star") {
      // The sun SHINES via HDR + bloom: the disc's emissive colour is pushed
      // far above 1.0 so the post-process UnrealBloomPass blooms it into a
      // glowing corona (seagull's approach — no separate corona sprite).
      const L = Math.max(1e-6, state.luminosity);
      const hdrBoost = 4.0 * (1 + 0.3 * Math.log10(L));
      const hdrColor = state.color.clone().multiplyScalar(Math.max(0.5, hdrBoost));
      const geo = new THREE.SphereGeometry(radiusM, 48, 32);
      const mat = new THREE.MeshBasicMaterial({ color: hdrColor, fog: false });
      const disc = new THREE.Mesh(geo, mat);
      disc.name = "lum_disc";
      disc.frustumCulled = false;
      // Base (unreddened) colour so the sky layer can scale from it each frame
      // without compounding — it reddens the disc + light by atmospheric
      // transmittance at sunset (space-sky.ts). See scattering.sunTransmittance.
      disc.userData.baseColor = hdrColor.clone();
      body.group.add(disc);
      // A point light at the star (no distance falloff) lights the system.
      const lightIntensity = Math.max(1.0, 2.0 + 0.3 * Math.log10(L));
      const starLight = new THREE.PointLight(state.color, lightIntensity, 0, 0);
      starLight.name = "star_light";
      starLight.userData.baseColor = state.color.clone();
      body.group.add(starLight);
    } else {
      // Airless / sub-relief rocky (a bare moon): a plain tinted sphere.
      const geo = new THREE.SphereGeometry(radiusM, 48, 32);
      const mat = terrainMaterial({ color: features.surfaceColor, roughness: 0.95 });
      applyToonTerminator(mat, terminatorOpts);
      body.group.add(new THREE.Mesh(geo, mat));
    }
  };

  // Per-frame body update: point the atmosphere at the star, then (rocky only)
  // walk the terrain LOD. The sun direction is world-space (planet→star), so it
  // is invariant under the group's spin and the floating-origin rebase — only
  // orbital motion moves it, but setting it every frame is trivial and keeps the
  // dawn/dusk edge tracking as the world turns. Runs even without a planetObj so
  // gas giants and interim spheres get their lit crescent too.
  body.update = function (cameraWorldPos) {
    if (starBody && atmosphereMaterials.length) {
      _sunDir.copy(starBody.worldPosition).sub(this.worldPosition).normalize();
      for (const m of atmosphereMaterials) {
        (m.uniforms.uSunDir?.value as THREE.Vector3 | undefined)?.copy(_sunDir);
      }
    }
    if (!planetObj) return;
    _camLocal.copy(cameraWorldPos).sub(this.worldPosition).applyQuaternion(this.inverseOrientation);
    planetObj.update(_camLocal);
  };

  return { body, isLuminous };
}

/** The ported atmosphere look: a BackSide slant-path limb glow (shell) + a
 *  FrontSide disc haze (veil, pressure-scaled). Gas giants always show a
 *  visible atmosphere; rocky worlds gate on surface pressure. Airless bodies
 *  (Mercury/Moon: pressure ≈ 0) get nothing.
 *
 *  Returns the sun-driven materials so the body can point their `uSunDir` at the
 *  star each frame — that is what makes the glow a lit crescent (atmosphere.ts). */
function attachAtmosphere(
  body: CelestialBody, features: ResolvedBody["features"], radiusM: number, gasGiant = false,
): THREE.ShaderMaterial[] {
  const atm = features.atmosphere;
  const topM = Math.max(radiusM * 0.02, atm.atmosphereTopKm * 1000);
  const zenith = atm.skyZenithColor ?? new THREE.Color(0x88aaff);
  const horizon = atm.skyHorizonColor ?? zenith;
  const materials: THREE.ShaderMaterial[] = [];

  if (gasGiant || atm.surfacePressureBar > 0.001) {
    const shell = buildAtmosphereShell({ radiusM, atmosphereTopM: topM, zenithColor: zenith, horizonColor: horizon });
    body.group.add(shell);
    materials.push(shell.material as THREE.ShaderMaterial);
  }
  if (gasGiant) {
    // The banded sphere IS the cloud deck, so only a thin high-altitude veil.
    const veil = buildAtmosphereVeil({ radiusM, atmosphereTopM: topM, color: zenith, hazeTau: 0.4 });
    body.group.add(veil);
    materials.push(veil.material as THREE.ShaderMaterial);
  } else if (atm.surfacePressureBar > 0.05) {
    const veil = buildAtmosphereVeil({
      radiusM, atmosphereTopM: topM, color: zenith, hazeTau: hazeTauFromPressure(atm.surfacePressureBar),
    });
    body.group.add(veil);
    materials.push(veil.material as THREE.ShaderMaterial);
  }
  return materials;
}

/** Does a body's physics character make it a habitable-ish oceaned world? */
export { hasOceanFeatures };
