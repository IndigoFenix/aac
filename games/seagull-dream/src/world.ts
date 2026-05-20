import * as THREE from "three";
import { SKY, GALAXY, SPEED, GFX } from "./config";
import type { CelestialBody } from "./body";
import { advanceBodyTransform, atmosphericDensityForBody, windAt } from "./body";
import { generateSolarSystem, type SolarSystem } from "./solar-system";
import {
  generateUniverse,
  projectGalaxy,
  findNearestStar,
  largestAngularSizeFromRegistry,
  DEFAULT_GALAXY_PARAMS,
  type GalaxyParams,
  type Universe,
  type StarRecord,
} from "./galaxy";

// Space-first world.
//
// The world owns a Universe registry of stars (a few thousand entries, each
// just metadata) and materializes ONE solar system at a time — the one
// whose star the player is currently nearest. That active system sits
// near scene origin and runs full physics: every CelestialBody has a
// worldPosition in scene meters, gravity/atmosphere queries iterate them,
// and rendering happens in this frame.
//
// As the player flies between stars, `checkActiveSystem` detects when a
// different star is now closer (and within `GALAXY.materializeLy`) and
// rebases: dispose the old system, generate the new star's system at
// scene origin, and shift every external position (notably the player's)
// by the delta so the player's relative trajectory is preserved.
//
// Stars that aren't the active one render as:
//   - halo billboards at their true scene positions if within `haloLy`
//   - direction-locked starfield points beyond that (the night-sky band)
//
// `sceneAnchorGalactic` is the galactic-frame coordinate that corresponds
// to scene origin. It updates on rebase. The player's galactic position
// is `sceneAnchorGalactic + state.position / GALAXY.lyToSceneMeters`.

export interface GravityContext {
  /** Strongest-influence body at this world position, or null in deep space. */
  dominant: CelestialBody | null;
  /** Influence factor [0..1]. 1 = at the surface, 0 = no influence. */
  influence: number;
  /** Unit "up" away from the dominant body's center. Identity (+Y) if none. */
  up: THREE.Vector3;
  /** Altitude above the dominant body's surface. Infinity if no dominant. */
  altitude: number;
}

export interface AtmosphericReading {
  /** Max density across all bodies. 1 at any body's surface, decays with altitude. */
  density: number;
  /** The body responsible for that max density. null if every body's
   *  atmosphere is effectively zero at this position. */
  body: CelestialBody | null;
}

/**
 * Reference frame the player is currently anchored to. Mirrors the
 * planet→star→galaxy hierarchy of gravitational frames:
 *
 *   STAR     — an active solar system is materialized at scene origin;
 *              the player flies relative to its star, can land on
 *              planets, etc. Anchor = star's galactic position.
 *
 *   GALACTIC — interstellar space. No active system. The scene is
 *              anchored to the galaxy's origin (0,0,0 in galactic
 *              coords) so the player's scene position equals their
 *              galactic position × lyToSceneMeters. Star halos and
 *              the starfield render in this absolute frame.
 *
 * Transitions follow the same materialize/dematerialize thresholds
 * that previously governed star-to-star swaps: the player leaves a
 * star's domain when they pass `dematerializeLy`; they enter a new
 * star's domain when they pass `materializeLy`.
 */
export type FrameMode = "STAR" | "GALACTIC";

export interface World {
  scene: THREE.Scene;
  /** Bodies in the active system. Empty in GALACTIC mode. */
  readonly bodies: CelestialBody[];
  /** First rocky body in the active system, used as the player's
   *  spawn target. Null after the player leaves the initial home
   *  system (player has already spawned at this point, so null is
   *  harmless). */
  readonly homePlanet: CelestialBody | null;
  /** Active system's central star body. Null in GALACTIC mode. */
  readonly star: CelestialBody | null;
  /** Persistent star registry — sky uses this for starfield projection. */
  readonly universe: Universe;
  /** Galactic position of scene origin. STAR mode: the active star's
   *  galactic position. GALACTIC mode: (0,0,0). */
  readonly sceneAnchorGalactic: THREE.Vector3;
  /** Currently-materialized star, or null in GALACTIC mode. */
  readonly activeStar: StarRecord | null;
  /** Which reference frame the scene is anchored to. */
  readonly frameMode: FrameMode;
  gravityAt(worldPos: THREE.Vector3, out?: GravityContext): GravityContext;
  gravityAccelerationAt(worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  atmosphericDensityAt(worldPos: THREE.Vector3, out?: AtmosphericReading): AtmosphericReading;
  windAtPoint(body: CelestialBody, worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /**
   * Atmospheric density at `worldPos`, summed across all bodies and
   * normalized to Earth sea-level (1.225 kg/m³). Used by the three-mode
   * speed model — gates wing mode (α weight) and warp mode ((1-α)^N).
   */
  atmosphericAlphaAt(worldPos: THREE.Vector3): number;
  /**
   * Largest angular size (radians) of any body or registry star as seen
   * from `worldPos`. Materialized scene bodies dominate near a system;
   * registry stars (walked within a few-ly radius of the player's
   * galactic position) take over in interstellar mode and add a small
   * contribution near system edges. `r` is clamped to `R` so a
   * position inside a body returns θ = π. Returns 0 only if no
   * registry star is reachable within the search radius — callers
   * apply their own floor.
   */
  largestAngularSizeAt(worldPos: THREE.Vector3): number;
  /**
   * Altitude above the nearest body's surface, plus the body itself.
   * Used by the rocket mode (speed scales with altitude over body
   * radius). `body` is null and `altitude` is `Infinity` when no
   * bodies are materialized.
   */
  nearestBodyAltitudeAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number };
  /**
   * "Local-system dominant body" — the body whose Hill sphere contains
   * the player AND whose Hill sphere is the smallest such containing
   * sphere. This is the body that determines the player's local
   * gravitational neighborhood:
   *   • Inside Earth's hill but outside Moon's       → Earth
   *   • Inside Moon's hill                            → Moon
   *   • Outside Earth's hill but inside Sun's hill   → Sun
   *
   * Falls back to the geometrically nearest body when no body's hill
   * contains the player (true interstellar void). Never returns null
   * as long as any body is materialized. `hillFraction` is the
   * player's altitude as a fraction of the body's hill span — clamped
   * above 1 in the fallback case so the warp gate stays fully open.
   */
  dominantBodyAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number; hillFraction: number };
  update(camera: THREE.PerspectiveCamera, screenHeightPx: number, dt: number): void;
  /**
   * Resolve frame transitions for the player's current position.
   *   STAR mode + player beyond dematerializeLy of activeStar:
   *     - If another star is within materializeLy → STAR mode swap.
   *     - Otherwise → STAR → GALACTIC.
   *   GALACTIC mode + a star within materializeLy → GALACTIC → STAR.
   * Any transition is a rebase: scene origin moves in galactic coords,
   * `playerPosition` is shifted by the inverse delta so the player's
   * physical trajectory is preserved. Returns the scene-space delta
   * (or null if no rebase occurred).
   */
  checkActiveSystem(playerPosition: THREE.Vector3): THREE.Vector3 | null;
  /** Rebuild the universe registry with new config. Tears down the
   *  current system and rematerializes the home star. */
  regenerateUniverse(seed: number, params?: GalaxyParams): void;
}

export function createWorld(
  scene: THREE.Scene,
  options: { seed?: number; params?: GalaxyParams } = {},
): World {
  // ── Universe ────────────────────────────────────────────────────────────
  let universe: Universe = generateUniverse(
    options.seed ?? 0xCAFEBABE,
    options.params ?? DEFAULT_GALAXY_PARAMS,
  );

  // Mutable frame state. Initial mode is STAR with the home system
  // materialized — the player spawns on the home planet.
  let frameMode: FrameMode = "STAR";
  let sceneAnchorGalactic: THREE.Vector3 = universe.homeStar.galacticPosition.clone();
  let activeStar: StarRecord | null = universe.homeStar;
  let activeSystem: SolarSystem | null = generateSolarSystem({
    star: universe.homeStar,
    galaxyParams: universe.params,
    centerPosition: new THREE.Vector3(0, 0, 0),
    scene,
  });
  let bodies: CelestialBody[] = activeSystem.bodies;

  // Two-pass init: advance bodies to t=0, then nudge by VEL_INIT_DT so
  // body.velocity is populated with each body's actual orbital tangent.
  let simTime = 0;
  initializeSystem(bodies);

  function initializeSystem(b: CelestialBody[]): void {
    for (const body of b) advanceBodyTransform(body, 0, 0);
    const VEL_INIT_DT = 1 / 60;
    simTime = VEL_INIT_DT;
    for (const body of b) advanceBodyTransform(body, simTime, VEL_INIT_DT);
  }

  let homePlanet: CelestialBody | null = pickHomePlanet(bodies);
  // Player spawn requires real terrain — surfaceAt is callable while the
  // body is unmaterialized (heightAt closure built eagerly), but the
  // visible mesh isn't there until materialize runs. Force it now so
  // the first frame shows ground instead of a sub-pixel-only stub.
  homePlanet?.materialize?.();
  function pickHomePlanet(b: CelestialBody[]): CelestialBody | null {
    // In the home Sol blueprint, Earth has id "Ap2" — pick it
    // directly so the spawn lands on the right body regardless of
    // procedural palette logic. The forced EARTHLIKE_BLUE palette in
    // solar-system.ts makes hasOcean=true on Ap2, so the second
    // clause matches it too in non-home systems where an oceanic
    // rocky exists. Final fallbacks cover dead seeds.
    return (
      b.find((x) => x.id === "Ap2") ??
      b.find((x) => x.type === "rocky" && x.hasOcean) ??
      b.find((x) => x.type === "rocky") ??
      b[1] ??
      b[0] ??
      null
    );
  }

  // ── Spatial-query temporaries ───────────────────────────────────────────
  const _gravDir = new THREE.Vector3();
  const _galacticTmp = new THREE.Vector3();

  // ── Registry-walk cache for largestAngularSizeAt ────────────────────────
  // The 7×7×7 leaf-cell walk through the universe is expensive when it
  // forces expansion of new cells (each star runs resolveStellarState).
  // We cache the result keyed on the leaf cell the player is inside —
  // the walk's box only shifts when the player crosses a cell boundary
  // (~5 ly), so within a cell the cached value is exact, and across a
  // cell crossing it's stale by at most one cell-width. At interstellar
  // speeds a 5 ly cell is traversed in seconds, so the cache hit rate
  // is very high during normal play.
  const REGISTRY_CACHE_LEAF_SIZE = 5; // ly, must match CELL_SIZES[MAX_LEVEL]
  let _registryAngularCache = 0;
  let _registryCacheIx = Number.NaN;
  let _registryCacheIy = Number.NaN;
  let _registryCacheIz = Number.NaN;
  let _registryCacheStarId: string | null | undefined = undefined;

  // ── Halo system for materialized bodies ─────────────────────────────────
  // One vertex per body in a shared Points cloud. Buffers are rebuilt on
  // rebase since the body count changes. The buffer is sized to the
  // exact body count (no padding) so we don't waste GPU draw calls on
  // zeroed slots — but that means we must dispose the old geometry and
  // material on rebuild.
  const haloTexture = makeHaloTexture();
  let haloPositions = new Float32Array(0);
  let haloColorsBuf = new Float32Array(0);
  let haloGeom = new THREE.BufferGeometry();
  let halos: THREE.Points = new THREE.Points(
    haloGeom,
    new THREE.PointsMaterial({
      // Small fixed sprite — a body's halo is meant to be visible as a
      // few-pixel dot from any distance, NOT a billboard standing in for
      // the body's apparent disc. At system-scale distances every body
      // is sub-pixel for most of the approach; this sprite makes them
      // readable without obscuring nearby stars. Pixel size kept small
      // enough that two bodies an arc-minute apart still resolve as
      // separate dots.
      size: 5,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: haloTexture,
      alphaTest: 0.01,
    }),
  );
  halos.frustumCulled = false;
  scene.add(halos);

  // ── In-system planet markers (testing aid) ──────────────────────────────
  // Separate, deliberately larger sprite drawn for every non-star body in
  // the active system. Ring shape + saturated halo color so it's
  // recognisably a planet rather than a star pinprick. Fades out as the
  // body's real mesh approaches pixel-scale, hand-off mirroring the
  // small-halo / mesh crossover.
  const planetMarkerTexture = makePlanetMarkerTexture();
  let markerPositions = new Float32Array(0);
  let markerColorsBuf = new Float32Array(0);
  let markerGeom = new THREE.BufferGeometry();
  const planetMarkers: THREE.Points = new THREE.Points(
    markerGeom,
    new THREE.PointsMaterial({
      // Big enough to read as a marker even at the edge of the visual
      // field; small enough that two adjacent inner planets don't
      // overlap into a single blob.
      size: 22,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      // NORMAL (not additive) blending so the ring reads as a solid
      // overlay against any sky brightness — additive would make it
      // disappear against bright daytime skies the way the halos do.
      blending: THREE.NormalBlending,
      // Depth-tested: a marker at body.worldPosition is at the actual
      // body distance; if the bird (or any opaque foreground geometry)
      // is closer, it should occlude the marker rather than the marker
      // floating over it. The starfield draws without depth-write, so
      // markers still appear over the starry background.
      depthWrite: false,
      depthTest: true,
      map: planetMarkerTexture,
      alphaTest: 0.02,
    }),
  );
  planetMarkers.frustumCulled = false;
  scene.add(planetMarkers);

  rebuildHaloBuffers();

  function rebuildHaloBuffers(): void {
    haloPositions = new Float32Array(bodies.length * 3);
    haloColorsBuf = new Float32Array(bodies.length * 3);
    haloGeom.setAttribute("position", new THREE.BufferAttribute(haloPositions, 3));
    haloGeom.setAttribute("color", new THREE.BufferAttribute(haloColorsBuf, 3));
    haloGeom.setDrawRange(0, bodies.length);

    markerPositions = new Float32Array(bodies.length * 3);
    markerColorsBuf = new Float32Array(bodies.length * 3);
    markerGeom.setAttribute("position", new THREE.BufferAttribute(markerPositions, 3));
    markerGeom.setAttribute("color", new THREE.BufferAttribute(markerColorsBuf, 3));
    markerGeom.setDrawRange(0, bodies.length);
  }

  const _toCamera = new THREE.Vector3();
  const _toSun = new THREE.Vector3();
  const _haloBuf = new THREE.Color();
  const _haloWhite = new THREE.Color(1, 1, 1);

  // Pixel-aware halo behavior. The halo represents a body when it would
  // otherwise be sub-pixel — at system-scale distances that's most of
  // the approach. Once the body's apparent angular size exceeds a few
  // pixels, the halo fades out so it doesn't obscure the real geometry.
  //
  //   pixelSize ≤ HALO_FULL_BELOW_PX → halo at full opacity (1.0)
  //   pixelSize ≥ HALO_GONE_ABOVE_PX → halo invisible (real mesh takes over)
  //   between                          → smooth ramp
  //
  // The transition band overlaps with the mesh fade-in in celestial-body.ts
  // (driven by the same pixel-size value) so the visible "dot → disc"
  // hand-off is continuous.
  const HALO_FULL_BELOW_PX = 1.5;
  const HALO_GONE_ABOVE_PX = 8;
  // Pixel size at which a body's heavy GPU construction is triggered.
  // Sits below HALO_FULL_BELOW_PX so root chunks have a few frames to
  // build during the fade-in before the mesh actually needs to be
  // visible. Sub-pixel bodies never cross this threshold and stay as
  // halo/projection dots only.
  const MATERIALIZE_TRIGGER_PX = 0.5;
  // Boost on the halo color magnitude when it's fully visible.
  // Bumped from 1.6 — the prior value left even fully-lit halos dim
  // enough that they barely registered against any non-black sky.
  const HALO_PLANET_BOOST = 4.0;
  // Ambient floor for planet halos so unlit silhouettes are still
  // visible as dots against the starfield rather than disappearing
  // entirely. Bumped from 0.05 — at the prior value, unlit-side
  // planets dropped to ~0.08× their already-dim palette color, which
  // displayed as black for moon-grey palettes.
  const HALO_PLANET_AMBIENT = 0.35;

  // Show or hide the body's whole mesh group based on its apparent
  // pixel size. We use BINARY visibility rather than a smooth opacity
  // ramp because the dark (unlit) side of a low-albedo body has a
  // near-black material color — and a transparent near-black mesh in
  // standard alpha blending SUBTRACTS from the background (out = src×a
  // + bg×(1-a) ≈ bg×(1-a) when src is dark), producing a visible
  // "anti-glare" black overlay as the body fades in across the sky.
  //
  // The hand-off is: while sub-pixel, body.group is hidden and the
  // halo represents the body; once the body crosses the visibility
  // threshold, the whole group switches on at full opacity. The halo
  // still ramps out over the existing fade band so it overlaps the
  // mesh appearance for a few frames and the transition reads as
  // gradual rather than a snap.
  //
  // `opacity` argument is kept (call sites pass a 0..1 ramp value)
  // and used purely as the visibility decision input.
  const MESH_VISIBLE_THRESHOLD = 0.6;
  function setBodyMeshOpacity(body: CelestialBody, opacity: number): void {
    const visible = opacity >= MESH_VISIBLE_THRESHOLD;
    if (body.group.visible !== visible) body.group.visible = visible;
    if (!visible) return;
    // When visible, snap every material to fully opaque + depth-writing
    // so we're never in the dark-overlay state for a single frame.
    // EXCEPT: cloud_shell and atmosphere_halo are translucent shells
    // whose opacity drives the alpha of their full-screen contribution,
    // and the live-tuning multipliers (GFX.cloudMult, GFX.atmShellMult)
    // need to scale them so the player can dial each layer down to
    // isolate visual issues. Detect by mesh.name.
    body.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material;
      let opacityValue = 1;
      if (mesh.name === "cloud_shell") opacityValue = GFX.cloudMult;
      else if (mesh.name === "atmosphere_halo") opacityValue = GFX.atmShellMult;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          m.opacity = opacityValue;
          m.depthWrite = true;
        }
      } else if (mat) {
        mat.opacity = opacityValue;
        mat.depthWrite = true;
      }
      // Live cloud color override — when on, force the cloud_shell
      // shader's uColor uniform to the slider RGB. Lets the user see
      // exactly where clouds are by setting them to pure red.
    });
  }

  function updateHalos(camera: THREE.PerspectiveCamera, screenHeightPx: number): void {
    // Body halos only exist in STAR mode. Bodies is empty in GALACTIC
    // mode so the loop is a no-op; the local star reference is only
    // dereferenced inside the loop and is guaranteed non-null when
    // bodies has any entries (we always materialize a system together
    // with its star).
    const cameraPos = camera.position;
    const fovRad = camera.fov * Math.PI / 180;
    const pxPerRad = screenHeightPx / fovRad;
    const sysStar = activeSystem?.star;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];

      // Pixel-size + materialize trigger + mesh fade-in apply to ALL
      // bodies (including stars, which have no halo billboard but still
      // need their disc to fade in once close enough). Halo painting
      // below is skipped for bodies without haloColor.
      const dist = b.worldPosition.distanceTo(cameraPos);
      const safeDist = Math.max(dist, b.radius);
      const angularSize = 2 * Math.atan(b.radius / safeDist);
      const pixelSize = angularSize * pxPerRad;

      // Trigger heavy construction (sphere meshes, materials, ocean,
      // scatter, terrain root chunks) the first time the body's
      // apparent disc starts to approach pixel-scale. Sub-pixel bodies
      // are represented by their halo / registry projection alone — no
      // GPU resources allocated until they're actually approaching
      // visibility. Threshold sits below HALO_FULL_BELOW_PX so root
      // chunks have a few frames to build during the fade-in.
      if (pixelSize > MATERIALIZE_TRIGGER_PX && b.materialize) {
        b.materialize();
      }
      const meshOpacity = THREE.MathUtils.smoothstep(
        pixelSize, HALO_FULL_BELOW_PX, HALO_GONE_ABOVE_PX,
      );
      setBodyMeshOpacity(b, meshOpacity);

      // Position is shared between the halo dot and the marker disk.
      haloPositions[i * 3 + 0] = b.worldPosition.x;
      haloPositions[i * 3 + 1] = b.worldPosition.y;
      haloPositions[i * 3 + 2] = b.worldPosition.z;
      markerPositions[i * 3 + 0] = b.worldPosition.x;
      markerPositions[i * 3 + 1] = b.worldPosition.y;
      markerPositions[i * 3 + 2] = b.worldPosition.z;

      // Halo painting — only for non-star bodies (stars rely on the
      // unchanged registry projection for their sub-pixel dot).
      if (!b.haloColor) {
        haloColorsBuf[i * 3 + 0] = 0;
        haloColorsBuf[i * 3 + 1] = 0;
        haloColorsBuf[i * 3 + 2] = 0;
        // No marker for stars either — they're the system's bright
        // central source; the registry projection handles them.
        markerColorsBuf[i * 3 + 0] = 0;
        markerColorsBuf[i * 3 + 1] = 0;
        markerColorsBuf[i * 3 + 2] = 0;
        continue;
      }

      const haloOpacity = 1 - meshOpacity;  // inverse of the mesh ramp
      _toCamera.copy(cameraPos).sub(b.worldPosition);
      const toCameraLen = _toCamera.length();
      if (toCameraLen > 0) _toCamera.divideScalar(toCameraLen);

      // Planet marker — testing-aid overlay. Color is haloColor mixed
      // toward a bright white BASELINE so the ring stays visible
      // regardless of palette darkness (linear-space dim palettes
      // like the moon's grey would otherwise show as near-black after
      // the OutputPass sRGB conversion). The body's own color tints
      // the marker for identification but never dominates.
      //
      // We deliberately skip the halo's phase dimming so the marker
      // is visible from any angle to the star.
      if (haloOpacity > 0) {
        const baseline = 0.7;
        const tint = 0.5;
        markerColorsBuf[i * 3 + 0] = (baseline + tint * b.haloColor.r) * haloOpacity;
        markerColorsBuf[i * 3 + 1] = (baseline + tint * b.haloColor.g) * haloOpacity;
        markerColorsBuf[i * 3 + 2] = (baseline + tint * b.haloColor.b) * haloOpacity;
      } else {
        markerColorsBuf[i * 3 + 0] = 0;
        markerColorsBuf[i * 3 + 1] = 0;
        markerColorsBuf[i * 3 + 2] = 0;
      }

      if (haloOpacity <= 0) {
        haloColorsBuf[i * 3 + 0] = 0;
        haloColorsBuf[i * 3 + 1] = 0;
        haloColorsBuf[i * 3 + 2] = 0;
        continue;
      }

      // Reflected light from the system primary. Phase = lit²: a
      // crescent (lit ≈ 0.3) reads at ~10% the full-phase brightness,
      // matching real planet visibility curves. Small ambient floor
      // keeps the silhouette readable as a dot rather than vanishing.
      let lit = 0;
      if (sysStar) {
        _toSun.copy(sysStar.worldPosition).sub(b.worldPosition);
        const toSunLen = _toSun.length();
        if (toSunLen > 0) _toSun.divideScalar(toSunLen);
        lit = Math.max(0, _toCamera.dot(_toSun));
      }
      const phase = lit * lit;
      const intensity = HALO_PLANET_BOOST * (HALO_PLANET_AMBIENT + (1 - HALO_PLANET_AMBIENT) * phase)
        * GFX.haloMult;
      // Lerp toward white on the lit side — distant lit planets read
      // closer to "pale dot" than to their full albedo color.
      _haloBuf.copy(b.haloColor).lerp(_haloWhite, lit * 0.5);
      _haloBuf.multiplyScalar(haloOpacity * intensity);
      haloColorsBuf[i * 3 + 0] = _haloBuf.r;
      haloColorsBuf[i * 3 + 1] = _haloBuf.g;
      haloColorsBuf[i * 3 + 2] = _haloBuf.b;
    }
    (haloGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (haloGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (markerGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (markerGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ── Frame-transition primitives ─────────────────────────────────────────
  //
  // Every frame transition is a scene rebase: the galactic position
  // mapped to scene origin changes by `newAnchor - oldAnchor`, and the
  // scene-space position of every external piece of state (notably the
  // player) shifts by the inverse so the player's physical trajectory
  // is preserved.
  //
  //   STAR → STAR (different star): tear down the old system, generate
  //                                  the new one at scene origin.
  //   STAR → GALACTIC:               tear down the old system, anchor
  //                                  moves to galactic origin.
  //   GALACTIC → STAR:               generate a new system at scene
  //                                  origin, anchor moves to that star.
  //
  // Each transition routes through `applyRebase` to compute and apply
  // the player shift, then through `tearDownSystem` / `materializeAt`
  // to manage the active-system state.

  function tearDownSystem(): void {
    if (activeSystem) {
      // Remove scene presence. Full GPU disposal is a TODO — each body
      // type (rocky w/ chunk LOD, gas, star) needs its own dispose
      // hook. For now we leak per-system geometry on rebase.
      disposeSolarSystem(activeSystem, scene);
      activeSystem = null;
    }
    activeStar = null;
    bodies = [];
    homePlanet = null;
  }

  function materializeAt(star: StarRecord): void {
    activeSystem = generateSolarSystem({
      star,
      galaxyParams: universe.params,
      centerPosition: new THREE.Vector3(0, 0, 0),
      scene,
    });
    bodies = activeSystem.bodies;
    initializeSystem(bodies);
    homePlanet = pickHomePlanet(bodies);
    // Force home planet's heavy construction at materialize time even
    // though the player may be far away — the spawn target needs real
    // geometry. Other bodies wait for proximity-driven materialize.
    homePlanet?.materialize?.();
    activeStar = star;
  }

  function applyRebase(
    newAnchorGalactic: THREE.Vector3,
    playerPosition: THREE.Vector3,
  ): THREE.Vector3 {
    const deltaLy = new THREE.Vector3()
      .copy(newAnchorGalactic)
      .sub(sceneAnchorGalactic);
    const deltaScene = deltaLy.clone().multiplyScalar(GALAXY.lyToSceneMeters);
    sceneAnchorGalactic.copy(newAnchorGalactic);
    playerPosition.sub(deltaScene);
    return deltaScene;
  }

  function transitionToStar(
    newStar: StarRecord,
    playerPosition: THREE.Vector3,
  ): THREE.Vector3 {
    const deltaScene = applyRebase(newStar.galacticPosition, playerPosition);
    tearDownSystem();
    materializeAt(newStar);
    frameMode = "STAR";
    rebuildHaloBuffers();
    return deltaScene;
  }

  const _galacticOrigin = new THREE.Vector3(0, 0, 0);
  function transitionToGalactic(playerPosition: THREE.Vector3): THREE.Vector3 {
    const deltaScene = applyRebase(_galacticOrigin, playerPosition);
    tearDownSystem();
    frameMode = "GALACTIC";
    rebuildHaloBuffers();
    return deltaScene;
  }

  /**
   * Continuous floating-origin rebase. Each frame, after physics, the
   * player's scene position is collapsed to (0,0,0): we shift the
   * scene anchor in galactic coords by the equivalent ly amount, and
   * translate every body's worldPosition by `-playerPosition`. Velocity
   * and orbital math are unaffected (everything shifts together).
   * Keeps Float32 precision tight at galactic scale — without this,
   * `state.position` would grow unbounded during interstellar warp.
   */
  const _floatTmp = new THREE.Vector3();
  function applyFloatingOrigin(playerPosition: THREE.Vector3): void {
    if (playerPosition.lengthSq() < 1e-4) return;
    _floatTmp.copy(playerPosition).divideScalar(GALAXY.lyToSceneMeters);
    sceneAnchorGalactic.add(_floatTmp);
    for (const b of bodies) {
      b.worldPosition.sub(playerPosition);
      b.prevWorldPosition.sub(playerPosition);
      b.group.position.copy(b.worldPosition);
    }
    // The halo geometry was filled by `updateHalos` BEFORE the rebase
    // (inside `world.update`), so its positions are still in pre-rebase
    // world coords (~1e11 at real-scale orbits). Without shifting them
    // here, halos float at quadrillion-m offsets relative to the now-
    // rebased camera, producing one-frame flashes as float32 model-view
    // matrix precision causes the halo positions to jitter wildly each
    // frame. Subtracting playerPosition keeps them in sync with their
    // bodies and the camera.
    for (let i = 0; i < haloPositions.length; i += 3) {
      haloPositions[i + 0] -= playerPosition.x;
      haloPositions[i + 1] -= playerPosition.y;
      haloPositions[i + 2] -= playerPosition.z;
    }
    for (let i = 0; i < markerPositions.length; i += 3) {
      markerPositions[i + 0] -= playerPosition.x;
      markerPositions[i + 1] -= playerPosition.y;
      markerPositions[i + 2] -= playerPosition.z;
    }
    (haloGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (markerGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    playerPosition.set(0, 0, 0);
  }

  // ── World API ────────────────────────────────────────────────────────────
  const world: World = {
    scene,
    get bodies() { return bodies; },
    get homePlanet() { return homePlanet; },
    get star() { return activeSystem?.star ?? null; },
    get universe() { return universe; },
    get sceneAnchorGalactic() { return sceneAnchorGalactic; },
    get activeStar() { return activeStar; },
    get frameMode() { return frameMode; },
    gravityAccelerationAt(worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
      out.set(0, 0, 0);
      let dominant: CelestialBody | null = null;
      let smallestHill = Infinity;
      for (const b of bodies) {
        const dist = worldPos.distanceTo(b.worldPosition);
        if (dist < b.hillRadius && b.hillRadius < smallestHill) {
          smallestHill = b.hillRadius;
          dominant = b;
        }
      }
      if (!dominant) return out;

      _gravDir.copy(dominant.worldPosition).sub(worldPos);
      let r2 = _gravDir.lengthSq();
      if (r2 >= 1) {
        const accel = dominant.gm / r2;
        out.addScaledVector(_gravDir, accel / Math.sqrt(r2));
      }

      let current: CelestialBody = dominant;
      while (current.orbit) {
        const parent = current.orbit.parent;
        _gravDir.copy(parent.worldPosition).sub(current.worldPosition);
        r2 = _gravDir.lengthSq();
        if (r2 >= 1) {
          const accel = parent.gm / r2;
          out.addScaledVector(_gravDir, accel / Math.sqrt(r2));
        }
        current = parent;
      }
      return out;
    },
    atmosphericDensityAt(worldPos: THREE.Vector3, out?: AtmosphericReading): AtmosphericReading {
      const reading = out ?? { density: 0, body: null };
      reading.density = 0;
      reading.body = null;
      for (const b of bodies) {
        const d = atmosphericDensityForBody(b, worldPos);
        if (d > reading.density) {
          reading.density = d;
          reading.body = b;
        }
      }
      return reading;
    },
    windAtPoint(body: CelestialBody, worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
      return windAt(body, worldPos, out);
    },
    atmosphericAlphaAt(worldPos: THREE.Vector3): number {
      // Sum kg/m³ contributions from every body, then normalize by Earth
      // sea-level density. A body's local density is its surface density
      // × exp(-altitude / scaleHeight), clamped to "at-surface" inside
      // the body. We don't track "the body responsible" here — callers
      // wanting that should use `atmosphericDensityAt` (per-body max).
      let kgm3 = 0;
      for (const b of bodies) {
        const altRaw = worldPos.distanceTo(b.worldPosition) - b.radius;
        const altitude = altRaw < 0 ? 0 : altRaw;
        kgm3 += b.surfaceAirDensity * Math.exp(-altitude / b.atmosphereScaleHeight);
      }
      return kgm3 / SPEED.RHO_REF_AIR;
    },
    largestAngularSizeAt(worldPos: THREE.Vector3): number {
      // Local materialized bodies — angular size from scene coords directly.
      // In STAR mode these usually dominate by many orders of magnitude.
      let maxAngular = 0;
      for (const b of bodies) {
        const distRaw = worldPos.distanceTo(b.worldPosition);
        const ratio = distRaw < b.radius ? 1 : b.radius / distRaw;
        const angular = 2 * Math.asin(Math.min(1, ratio));
        if (angular > maxAngular) maxAngular = angular;
      }
      // Registry stars — handles GALACTIC-mode interstellar warp (where
      // `bodies` is empty), and edge-of-system cases where a nearby
      // off-system star might rival the active-system contribution.
      // Cached on the player's current leaf cell: the registry walk
      // only changes its 7³ box when we cross a cell boundary, so
      // within one cell the cached angular is exact.
      _galacticTmp.copy(worldPos)
        .divideScalar(GALAXY.lyToSceneMeters)
        .add(sceneAnchorGalactic);
      const ix = Math.floor(_galacticTmp.x / REGISTRY_CACHE_LEAF_SIZE);
      const iy = Math.floor(_galacticTmp.y / REGISTRY_CACHE_LEAF_SIZE);
      const iz = Math.floor(_galacticTmp.z / REGISTRY_CACHE_LEAF_SIZE);
      const excludeId = activeStar?.id ?? null;
      if (
        ix !== _registryCacheIx ||
        iy !== _registryCacheIy ||
        iz !== _registryCacheIz ||
        excludeId !== _registryCacheStarId
      ) {
        _registryAngularCache = largestAngularSizeFromRegistry(
          universe, _galacticTmp, excludeId,
        );
        _registryCacheIx = ix;
        _registryCacheIy = iy;
        _registryCacheIz = iz;
        _registryCacheStarId = excludeId;
      }
      if (_registryAngularCache > maxAngular) maxAngular = _registryAngularCache;
      return maxAngular;
    },
    nearestBodyAltitudeAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number } {
      let nearest: CelestialBody | null = null;
      let bestAlt = Infinity;
      for (const b of bodies) {
        const alt = worldPos.distanceTo(b.worldPosition) - b.radius;
        if (alt < bestAlt) {
          bestAlt = alt;
          nearest = b;
        }
      }
      return { body: nearest, altitude: nearest ? Math.max(0, bestAlt) : Infinity };
    },
    dominantBodyAt(worldPos: THREE.Vector3): { body: CelestialBody | null; altitude: number; hillFraction: number } {
      // First pass: smallest hill sphere containing the player.
      let dominant: CelestialBody | null = null;
      let smallestHill = Infinity;
      let dominantDist = 0;
      for (const b of bodies) {
        const dist = worldPos.distanceTo(b.worldPosition);
        if (dist < b.hillRadius && b.hillRadius < smallestHill) {
          smallestHill = b.hillRadius;
          dominant = b;
          dominantDist = dist;
        }
      }
      if (dominant) {
        const hillSpan = Math.max(1, dominant.hillRadius - dominant.radius);
        const alt = Math.max(0, dominantDist - dominant.radius);
        return { body: dominant, altitude: alt, hillFraction: alt / hillSpan };
      }
      // Fallback: no body contains the player (true interstellar void).
      // Use the geometrically nearest body so the readouts and warp
      // gate keep functioning. hillFraction reports above 1 so the
      // hillGate clamps to fully-open (warp unrestricted).
      let nearest: CelestialBody | null = null;
      let bestDist = Infinity;
      for (const b of bodies) {
        const d = worldPos.distanceTo(b.worldPosition);
        if (d < bestDist) {
          bestDist = d;
          nearest = b;
        }
      }
      if (!nearest) return { body: null, altitude: Infinity, hillFraction: Infinity };
      const hillSpan = Math.max(1, nearest.hillRadius - nearest.radius);
      const alt = Math.max(0, bestDist - nearest.radius);
      return { body: nearest, altitude: alt, hillFraction: alt / hillSpan };
    },
    gravityAt(worldPos: THREE.Vector3, out?: GravityContext): GravityContext {
      const ctx = out ?? {
        dominant: null,
        influence: 0,
        up: new THREE.Vector3(0, 1, 0),
        altitude: Infinity,
      };
      let dominant: CelestialBody | null = null;
      let smallestHill = Infinity;
      for (const b of bodies) {
        const dist = worldPos.distanceTo(b.worldPosition);
        if (dist < b.hillRadius && b.hillRadius < smallestHill) {
          smallestHill = b.hillRadius;
          dominant = b;
        }
      }
      ctx.dominant = dominant;
      if (dominant) {
        dominant.upAt(worldPos, ctx.up);
        ctx.altitude = dominant.altitudeAt(worldPos);
        const dist = worldPos.distanceTo(dominant.worldPosition);
        const span = dominant.hillRadius - dominant.radius;
        ctx.influence =
          span > 0
            ? THREE.MathUtils.clamp(1 - (dist - dominant.radius) / span, 0, 1)
            : 0;
      } else {
        ctx.up.set(0, 1, 0);
        ctx.altitude = Infinity;
        ctx.influence = 0;
      }
      return ctx;
    },
    update(camera, screenHeightPx, dt) {
      simTime += dt;
      const cameraPos = camera.position;
      for (const b of bodies) {
        advanceBodyTransform(b, simTime, dt);
      }
      for (const b of bodies) {
        b.update(cameraPos, dt);
      }
      updateHalos(camera, screenHeightPx);
    },
    checkActiveSystem(playerPosition: THREE.Vector3): THREE.Vector3 | null {
      // Player's galactic position = anchor + sceneOffset / ltsm.
      const playerGalactic = new THREE.Vector3()
        .copy(playerPosition)
        .divideScalar(GALAXY.lyToSceneMeters)
        .add(sceneAnchorGalactic);

      const nearest = findNearestStar(
        universe, playerGalactic, GALAXY.materializeLy * 1.5,
      );

      let result: THREE.Vector3 | null = null;
      if (activeStar) {
        const distFromActive = activeStar.galacticPosition.distanceTo(playerGalactic);
        if (distFromActive > GALAXY.dematerializeLy) {
          if (nearest && nearest.star.id !== activeStar.id && nearest.distanceLy < GALAXY.materializeLy) {
            result = transitionToStar(nearest.star, playerPosition);
          } else {
            result = transitionToGalactic(playerPosition);
          }
        }
      } else if (nearest && nearest.distanceLy < GALAXY.materializeLy) {
        result = transitionToStar(nearest.star, playerPosition);
      }

      // Continuous floating-origin rebase: collapse player back to scene
      // origin after the materialize logic settles. Keeps Float32 precision
      // tight at galactic scales (player.state.position never grows
      // unbounded during interstellar warp).
      applyFloatingOrigin(playerPosition);
      return result;
    },
    regenerateUniverse(seed: number, params?: GalaxyParams): void {
      tearDownSystem();
      universe = generateUniverse(seed, params ?? DEFAULT_GALAXY_PARAMS);
      sceneAnchorGalactic = universe.homeStar.galacticPosition.clone();
      materializeAt(universe.homeStar);
      frameMode = "STAR";
      rebuildHaloBuffers();
      // Invalidate registry-angular cache: it pointed at the old
      // universe's stars.
      _registryCacheIx = Number.NaN;
    },
  };

  return world;
}

/**
 * Tear down a solar system's scene presence. Removes body groups and
 * (for stars) the directional light. Does NOT yet dispose geometry /
 * materials — each body type would need its own dispose hook. For the
 * single-active-system case the leak is bounded; once the player
 * traverses many systems this will need to be addressed.
 */
function disposeSolarSystem(system: SolarSystem, scene: THREE.Scene): void {
  for (const b of system.bodies) {
    scene.remove(b.group);
  }
  if (system.starLight) {
    scene.remove(system.starLight);
    scene.remove(system.starLight.target);
  }
}

// ── Halo / starfield textures ───────────────────────────────────────────────

function makeStarTexture(): THREE.CanvasTexture {
  // Tight gradient — a small hot core, fast falloff to transparent.
  // Combined with HDR + bloom this reads as a sharp pinprick of light
  // with a soft glow.
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.15, "rgba(255,255,255,0.95)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(0.6, "rgba(255,255,255,0.05)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  // CRITICAL: disable mipmaps. The star sprite renders at 3-4 pixels
  // (sizeAttenuation:false) and three.js's default LOD picks a heavily
  // blurred mip level for that sprite size — averaging the bright
  // center with the transparent edges. Result: dim, washed-out
  // pinpricks that fall below the bloom threshold and flicker as
  // bird altitude / atmospheric opacity changes shift them around the
  // edge of detectability. With mipmaps off the brightest texel is
  // preserved at every render size.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Ring with a small central dot — clearly distinct from the filled-circle
// star/halo sprite. Used by the in-system planet markers so the player
// can pick planets out of the starfield.
function makePlanetMarkerTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  // Outer ring — wide, opaque rim, soft outer edge.
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  // Faint halo glow around the ring so it blooms slightly.
  const g = ctx.createRadialGradient(cx, cy, size * 0.32, cx, cy, size * 0.5);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.4, "rgba(255,255,255,0.18)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Central dot.
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function makeHaloTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.75)");
  g.addColorStop(0.55, "rgba(255,255,255,0.25)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  // Same mipmap issue as the star texture — halos render at 14 px
  // with sizeAttenuation:false, and mip filtering eats the bright
  // core. Keep base-mip linear sampling.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// ── Sky / atmosphere ────────────────────────────────────────────────────────

export interface Sky {
  scene: THREE.Scene;
  /**
   * Update background, fog, starfield, and day/night ambient. Pulls the
   * current universe + scene anchor from the world each frame so the
   * starfield is correctly re-projected as the player moves through
   * the galaxy (or after a system swap).
   */
  update(
    ctx: GravityContext,
    cameraPos: THREE.Vector3,
    world: World,
  ): void;
}

export function createSky(scene: THREE.Scene): Sky {
  const DEFAULT_DAY = new THREE.Color("#87ceeb");
  const DEFAULT_NIGHT = new THREE.Color("#070b1c");
  const spaceColor = new THREE.Color("#04060c");
  const dayColor = DEFAULT_DAY.clone();
  const nightColor = DEFAULT_NIGHT.clone();
  scene.background = dayColor.clone();
  // FogExp2 — density-based, exponential falloff. Never fully obscures
  // (linear fog with a finite fog.far hits 100% obscuration past the
  // far plane, which combined with bloom produced a white "haze band"
  // covering distant terrain visible from altitude). Real Rayleigh
  // scattering is exponential too. Density updated per-frame.
  scene.fog = new THREE.FogExp2(dayColor.clone(), 0);

  const AMBIENT_DAY = 0.35;
  const AMBIENT_NIGHT = 0.05;
  const ambientDayColor = new THREE.Color(0xbcd4ff);
  const ambientNightColor = new THREE.Color(0x1b2a4a);
  const ambient = new THREE.AmbientLight(ambientDayColor, AMBIENT_DAY);
  scene.add(ambient);

  // ── Unified galaxy point cloud ─────────────────────────────────────────
  // One Points mesh draws both the smudged blob aggregates (multi-tier
  // LOD cells) and the individual stars within the leaf-cell shell.
  // Each vertex carries its own pixel size, color, and direction — a
  // custom ShaderMaterial reads them all from per-vertex attributes so
  // a single draw call handles both visual tiers.
  //
  // The mesh is parented to the camera each frame so vertex positions
  // are camera-relative (direction × STARFIELD_RADIUS). With depthTest
  // and depthWrite both off and renderOrder = -10 the mesh draws as a
  // pure background pass; subsequent opaque geometry (planets, bird)
  // overwrites it with normal blending where it covers.
  const STARFIELD_RADIUS = 30000;
  const haloTexture = makeHaloTexture();
  const galaxyMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: haloTexture },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        if (t.a < 0.005) discard;
        gl_FragColor = vec4(vColor * t.rgb, t.a * uOpacity);
      }
    `,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // Generous fixed buffer — projection writes per-vertex pos/color/size
  // and we set drawRange to the count returned. ~100k vertices × 7
  // floats ≈ 2.8 MB. Cheap; avoids reallocation churn across LOD
  // transitions where the per-frame count varies.
  const MAX_GALAXY_VERTS = 100000;
  let starPositionsBuf = new Float32Array(MAX_GALAXY_VERTS * 3);
  let starColorsBuf = new Float32Array(MAX_GALAXY_VERTS * 3);
  let starSizesBuf = new Float32Array(MAX_GALAXY_VERTS);
  const starGeom = new THREE.BufferGeometry();
  const starPosAttr = new THREE.BufferAttribute(starPositionsBuf, 3);
  const starColAttr = new THREE.BufferAttribute(starColorsBuf, 3);
  const starSizeAttr = new THREE.BufferAttribute(starSizesBuf, 1);
  starGeom.setAttribute("position", starPosAttr);
  starGeom.setAttribute("color", starColAttr);
  starGeom.setAttribute("size", starSizeAttr);
  const stars = new THREE.Points(starGeom, galaxyMat);
  stars.name = "galaxy-points";
  stars.renderOrder = -10;
  stars.frustumCulled = false;
  scene.add(stars);

  const _bg = new THREE.Color();
  const _fogColor = new THREE.Color();
  const _localUp = new THREE.Vector3();
  const _sunDirection = new THREE.Vector3();
  const _atmosphereColor = new THREE.Color();
  const _ambientColor = new THREE.Color();
  const _playerGalactic = new THREE.Vector3();

  return {
    scene,
    update(ctx: GravityContext, cameraPos: THREE.Vector3, world: World) {
      const star = world.star;
      stars.position.copy(cameraPos);

      // Player's current galactic position. The camera is offset from
      // the player by a few scene-meters at most (third-person rig),
      // which converts to << one ly — negligible for star directions
      // that are computed against multi-ly distances. We project the
      // starfield from THIS position so directions update smoothly
      // every frame as the player flies through interstellar space.
      // Anchor-based projection would only refresh on scene rebase,
      // producing the visible flicker the player notices in deep
      // space.
      _playerGalactic.copy(cameraPos)
        .divideScalar(GALAXY.lyToSceneMeters)
        .add(world.sceneAnchorGalactic);

      // We intentionally do NOT exclude the active star anymore — the
      // registry's projected pixel for the current system's primary
      // continues to serve as its sub-pixel representation, smoothly
      // handing off to the materialized mesh once the player is close
      // enough for the mesh to fade in (no halo billboard for stars).
      const count = projectGalaxy(
        world.universe,
        _playerGalactic,
        STARFIELD_RADIUS,
        null,
        starPositionsBuf,
        starColorsBuf,
        starSizesBuf,
      );
      starGeom.setDrawRange(0, count);
      starPosAttr.needsUpdate = true;
      starColAttr.needsUpdate = true;
      starSizeAttr.needsUpdate = true;

      // Per-body sky tint comes from the dominant body if it carries one;
      // stars and gas planets fall back to the default sky palette.
      // skyDay is the zenith color; skyHorizon (if present) is the
      // long-path tint near the horizon — different physics on Mars and
      // Earth (Earth: blue→white horizon; Mars: butterscotch→blue horizon).
      // For background we use the zenith; horizon tint participates via
      // the dynamic-light fog color.
      dayColor.copy(ctx.dominant?.skyDay ?? DEFAULT_DAY);
      nightColor.copy(ctx.dominant?.skyNight ?? DEFAULT_NIGHT);
      const horizonColor = ctx.dominant?.skyHorizon ?? dayColor;

      // Sky→space transition altitudes come from the body's atmosphere
      // top (5 scale heights). For bodies with a real atmosphere we use
      // 1 scale height (atmosphereTop/5) as the "thinning starts" mark
      // and atmosphereTop itself as the "effectively space" mark. For
      // airless bodies (Moon/Mercury) the body falls back to the global
      // SKY constants — there's no atmosphere to fade, but the player
      // can still leave gravitational influence.
      let atmStart: number;
      let atmEnd: number;
      if (ctx.dominant?.atmosphereTopAltitude && ctx.dominant.atmosphereTopAltitude > 100) {
        atmEnd = ctx.dominant.atmosphereTopAltitude;
        atmStart = atmEnd * 0.2;  // ~1 scale height — visible thinning begins
      } else {
        atmStart = SKY.atmosphereStart;
        atmEnd = SKY.spaceAltitude;
      }

      let atmosphereT: number;
      if (!ctx.dominant) {
        atmosphereT = 1;
      } else {
        atmosphereT = THREE.MathUtils.clamp(
          (ctx.altitude - atmStart) / Math.max(1, atmEnd - atmStart),
          0,
          1,
        );
      }

      // Day/night requires both a dominant body (planet under the
      // player) AND an active star (to compute sun direction). In
      // GALACTIC mode neither exists, so we default to night/space —
      // ambient stays low and stars stay visible.
      let dayT = 0;
      if (ctx.dominant && star) {
        _localUp.subVectors(cameraPos, ctx.dominant.worldPosition).normalize();
        _sunDirection.subVectors(star.worldPosition, ctx.dominant.worldPosition).normalize();
        const sunDot = _localUp.dot(_sunDirection);
        dayT = THREE.MathUtils.smoothstep(sunDot, -0.15, 0.15);
      }
      const nightT = 1 - dayT;

      _atmosphereColor.copy(dayColor).lerp(nightColor, nightT);
      _bg.copy(_atmosphereColor).lerp(spaceColor, atmosphereT);
      (scene.background as THREE.Color).copy(_bg);

      if (scene.fog instanceof THREE.FogExp2) {
        // Fog tint uses the horizon color, not the zenith — that's
        // what objects in the distance fade toward (long light path
        // through the atmosphere reaches the player tinted by horizon
        // scattering).
        _fogColor.copy(horizonColor).lerp(nightColor, nightT)
          .lerp(spaceColor, atmosphereT);
        scene.fog.color.copy(_fogColor);
        // FogExp2 density: factor = 1 - exp(-density² × depth²).
        // Pick density so half-obscuration happens at the body's
        // clear-air visibility. Solving for density: density =
        // sqrt(ln(2)) / visRange ≈ 0.833 / visRange. Airless bodies
        // (visibilityRange = 0 or undefined) get density 0 → no fog
        // at all. As atmosphereT → 1 (camera leaves atmosphere) the
        // density fades to 0 as well so distant terrain and bodies
        // are crisp from orbit.
        const rawVis = ctx.dominant?.visibilityRange;
        const hasAtmosphere = rawVis !== undefined && rawVis > 100;
        if (hasAtmosphere) {
          const baseDensity = 0.833 / rawVis;
          scene.fog.density = baseDensity * (1 - atmosphereT) * GFX.fogDensityMult;
        } else {
          scene.fog.density = 0;
        }
      }

      galaxyMat.uniforms.uOpacity.value =
        Math.max(atmosphereT, nightT * 0.85) * GFX.starfieldMult;

      ambient.intensity = THREE.MathUtils.lerp(AMBIENT_NIGHT, AMBIENT_DAY, dayT) * GFX.ambientMult;
      _ambientColor.copy(ambientNightColor).lerp(ambientDayColor, dayT);
      ambient.color.copy(_ambientColor);
    },
  };
}
