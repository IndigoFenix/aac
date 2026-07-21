/**
 * REAL-SCALE INTERSTELLAR flight in the lab — the ported seagull stack end to
 * end: the streaming galaxy world (world.ts) with floating origin, the ported
 * physics generating each system, the geography seam growing terrain on
 * approach, the ported flight physics flying it, and the ported chase rig.
 *
 * The WORLD owns the floating origin (each frame the ship collapses to the
 * scene origin and bodies rebase), so this file just drives the loop and
 * renders `world.sceneGroup`. Systems materialize/tear down as the ship flies
 * star to star; per-body geology + meshes bake when they cross ~0.5px
 * (`world.updateHalos` — the load-radius story).
 */
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS } from "@shared/world-engine/space/galaxy";
import { createWorld, type StreamingWorld } from "@shared/world-engine/space/world";
import { createPlayer, type Player } from "@shared/world-engine/space/flight-sim";
import { createFlightCamera } from "@shared/world-engine/space/flight-camera";
import { createSpaceSky, type SpaceSky } from "@shared/world-engine/space/space-sky";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { planetCities, type PlanetCity } from "@shared/world-engine/planet/cities";
import { createDynamicCreature } from "@shared/world-engine/creatures/creature-model";

export interface SpaceFrame {
  near: number;
  far: number;
  status: string;
}

/** A city standing on a flown body — its data + live world-frame position
 *  and outward surface normal (refreshed every update as the planet orbits
 *  and spins). */
export interface FlightCity {
  body: CelestialBody;
  city: PlanetCity;
  worldPos: THREE.Vector3;
  outward: THREE.Vector3;
}

export interface SpaceFlight {
  group: THREE.Group;
  update(
    camera: THREE.PerspectiveCamera,
    aimX: number | null, aimY: number | null, wheel: number,
    dt: number, screenHeightPx: number, fovRad: number,
  ): SpaceFrame;
  /** Advance every body's orbit/spin (owns the sim clock). Call once per frame
   *  before streaming, in BOTH fly and spirit modes. */
  advanceWorld(dt: number): void;
  /** The camera-agnostic world streaming: system transitions + the
   *  floating-origin rebase around `anchor` (MUTATED to the scene origin) +
   *  body materialization/LOD and city tracking measured from `camWorld`. Fly
   *  passes the ship pose as BOTH; the spirit camera passes the focus point as
   *  `anchor` and the orbiting camera as `camWorld`, and never calls the pilot
   *  (`player.update`). */
  stepStreaming(anchor: THREE.Vector3, camWorld: THREE.Vector3, screenHeightPx: number, fovRad: number): { near: number; far: number };
  /** Update the space sky/starfield from the POSITIONED camera (call after the
   *  frame's camera pose is set — fly's chase rig or the spirit orbit). */
  stepSky(camera: THREE.PerspectiveCamera, dt: number, screenHeightPx: number, fovRad: number): void;
  /** Every city on every body whose geology has baked (world positions live). */
  cities(): readonly FlightCity[];
  /** Hide/show a city's beacon (the host swaps it for real town geometry
   *  up close). */
  setCityMarkerVisible(cell: number, visible: boolean): void;
  /** Tint a settlement's beacon with its POLITY's map ink (nations P1 —
   *  "the flag"): `hex` like "#8844cc"; null returns it to the neutral
   *  warm ember. Idempotent and cheap to re-assert. */
  setCityColor(cell: number, hex: string | null): void;
  /** Hide/show the flying avatar body — the seamless walk↔fly coordinator hides
   *  the ship while an embedded town owns the ground view (its walker is drawn
   *  instead), and shows it again on take-off. */
  setAvatarVisible(visible: boolean): void;
  /** TIER-1 streaming: add a refined region's villages (composite-keyed —
   *  they flow through cities()/nearestCity like any settlement). */
  addCities(bodyId: string, cities: readonly PlanetCity[]): void;
  /** Evict settlements by key (a region left behind). */
  removeCities(cells: readonly number[]): void;
  /** The closest city by great-circle surface distance on its body, or null
   *  when no settled body has baked yet. */
  nearestCity(worldPos: THREE.Vector3): { entry: FlightCity; distM: number; regionM: number } | null;
  /** The flight walker's scene object (the creature group). Spirit mode force-
   *  hides it every frame — the drone has no body. */
  readonly avatarObject: THREE.Object3D;
  /** Debug/test surface. */
  readonly player: Player;
  readonly world: StreamingWorld;
  /** The space render layer — exposed for the flash watcher, which dissects the
   *  starfield buffers of a frame it has just flagged as a bright flash. */
  readonly sky: SpaceSky;
  snapshot(): Array<{ id: string; type: string; dist: number }>;
  dispose(): void;
}

export function createSpaceFlight(
  scene: THREE.Scene,
  seed: number,
  faceN = 12,
  bakeGeography?: import("@shared/world-engine/space/celestial-body").GeographyBaker,
  opts: { canFly?: boolean; species?: string; compression?: number } = {},
): SpaceFlight {
  const world = createWorld(seed, DEFAULT_GALAXY_PARAMS, faceN, bakeGeography, {
    ...(opts.compression ? { compression: opts.compression } : {}),
  });
  const player = createPlayer(world, { canFly: opts.canFly });
  const rig = createFlightCamera();
  // The space render layer (sky/fog/ambient + starfield + halos) lives on the
  // scene; the host renders that scene through an HDR bloom pass.
  const sky: SpaceSky = createSpaceSky(scene, world.universe);

  const group = new THREE.Group();
  group.name = "space-flight";
  group.add(world.sceneGroup);

  // THE AVATAR — the regular walker (there is no spaceship): a creature
  // body that strides on the ground and flies the full flight model when
  // it takes off (mouse to the top of the screen).
  const avatar = createDynamicCreature(opts.species ?? "human_cute", { heightM: 1.7 });
  const ship = avatar.object as THREE.Group; // keeps the transform code below verbatim
  ship.name = "avatar";
  group.add(ship);

  // The lock reticle / target preview is a DOM overlay owned by the host
  // (space-hud.ts), driven from player.state.lockedBodyId + lockProgress.

  // ── CITIES — the civ layer on every settled body ─────────────────────────
  // A body's geology bakes lazily (world.updateHalos); the first update after
  // it bakes founds its cities and parents one beacon per city to body.group
  // in PLANET-LOCAL coords, so the planet's spin and orbit carry them for
  // free. Beacon colour is pushed past the bloom threshold — a city reads as
  // a warm glowing pinprick from orbit, exactly like the town lights it is.
  const CITY_COLOR = new THREE.Color(1.15, 0.95, 0.62).multiplyScalar(2.6);
  const cityGeo = new THREE.SphereGeometry(1, 10, 8);
  const cityMat = new THREE.MeshBasicMaterial({ color: CITY_COLOR, fog: false });
  const flightCities: Array<FlightCity & { marker: THREE.Mesh; localPos: THREE.Vector3 }> = [];
  const citiedBodies = new Set<string>();

  function addCityEntries(body: CelestialBody, cities: readonly PlanetCity[]): void {
    const built = body.geography;
    if (!built) return;
    for (const city of cities) {
      const dir = new THREE.Vector3(...city.dir);
      const ground = Math.max(0, built.surface.heightAt(city.dir));
      const localPos = dir.multiplyScalar(body.radius + ground + 60);
      const marker = new THREE.Mesh(cityGeo, cityMat);
      marker.name = `city:${city.name}`;
      marker.position.copy(localPos);
      marker.frustumCulled = false;
      body.group.add(marker);
      flightCities.push({
        body, city, worldPos: new THREE.Vector3(), outward: new THREE.Vector3(), marker, localPos,
      });
    }
  }

  function foundCitiesOn(body: CelestialBody): void {
    citiedBodies.add(body.id);
    const built = body.geography;
    if (!built || built.sites.length === 0) return;
    addCityEntries(body, planetCities(built));
  }

  /** Found cities on any body whose geology has baked since the last look
   *  (the home world bakes eagerly at boot, everything else on approach). */
  function syncNewCities(): void {
    for (const b of world.bodies) {
      if (b.geography && !citiedBodies.has(b.id)) foundCitiesOn(b);
    }
  }

  const _toMarker = new THREE.Vector3();
  function refreshCities(cameraPos: THREE.Vector3, pxPerRad: number): void {
    syncNewCities();
    for (const fc of flightCities) {
      // Live world position: planet-local through the body's transform.
      fc.worldPos.copy(fc.localPos).applyQuaternion(fc.body.orientation).add(fc.body.worldPosition);
      fc.outward.copy(fc.worldPos).sub(fc.body.worldPosition).normalize();
      // Adaptive beacon size: ~5px apparent from any range, clamped so it
      // never dwarfs the town up close nor vanishes from orbit.
      const dist = _toMarker.copy(fc.worldPos).sub(cameraPos).length();
      const size = THREE.MathUtils.clamp((5 * dist) / pxPerRad, 150, fc.body.radius * 0.012);
      fc.marker.scale.setScalar(size);
    }
  }

  /** The city's "region" — landing anywhere within it counts as arriving
   *  (a founding site is a whole substrate cell, hundreds of km on an
   *  Earth-sized world). */
  const regionRadiusM = (body: CelestialBody): number => {
    const faceCells = body.geography?.spec.topology.faceN ?? 24;
    return 0.45 * ((Math.PI / 2) * body.radius) / faceCells;
  };

  const _localDir = new THREE.Vector3();
  const _cityDir = new THREE.Vector3();

  // The home world's geology baked eagerly inside createWorld — found its
  // cities now so the host can report them before the first frame.
  syncNewCities();

  let simTime = 0;
  const _streamCam = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  // ── The two concerns of a frame, split so a SPIRIT camera can drive the SAME
  //    streaming world without piloting. `update` (fly) calls all three in the
  //    original order (byte-identical); the spirit host calls advanceWorld →
  //    stepStreaming → [positions the camera itself] → stepSky. ──────────────
  function advanceWorld(dt: number): void {
    simTime += dt;
    world.advanceBodies(simTime, dt);
  }
  function stepStreaming(
    anchor: THREE.Vector3, camWorld: THREE.Vector3, screenHeightPx: number, fovRad: number,
  ): { near: number; far: number } {
    // Floating origin: transitions + rebase `anchor` to the scene origin (it
    // is MUTATED to (0,0,0); bodies rebase around it).
    world.checkActiveSystem(anchor);
    // Materialize (mesh + deferred geology) bodies crossing ~0.5px + run LOD,
    // measured from the camera; track city world positions. In fly mode
    // `camWorld` IS `anchor` (just zeroed) so this reads ≈origin, exactly as
    // before; in spirit mode it is the orbiting camera's pose.
    _streamCam.copy(camWorld);
    world.updateHalos(_streamCam, screenHeightPx, fovRad);
    refreshCities(_streamCam, screenHeightPx / fovRad);
    // Far spans past the star-field sphere (3e13); logdepth keeps it precise.
    return { near: 0.5, far: 1e14 };
  }
  function stepSky(
    camera: THREE.PerspectiveCamera, dt: number, screenHeightPx: number, fovRad: number,
  ): void {
    // Driven from the ACTUAL camera position (what the starfield centres on and
    // the halos measure against).
    const grav = world.gravityAt(camera.position);
    const starBody = world.bodies.find((b) => b.type === "star") ?? null;
    sky.update({
      bodies: world.bodies,
      star: starBody,
      dominant: grav.dominant,
      altitude: grav.altitude,
      cameraPos: camera.position,
      screenHeightPx,
      fovRad,
      sceneAnchorGalactic: world.sceneAnchorGalactic,
      dt,
    });
  }

  return {
    group,
    player,
    world,
    sky,
    update(camera, aimX, aimY, wheel, dt, screenHeightPx, fovRad) {
      const mouseX = 0.5 + (aimX ?? 0) * 0.5;
      const mouseY = 0.5 - (aimY ?? 0) * 0.5;

      // Section timers (ms) → window.__flyPerf: which part of the flight
      // frame actually costs (the "flying lags, walking doesn't" hunt).
      const tp0 = performance.now();
      advanceWorld(dt);
      const tp1 = performance.now();
      player.update({ mouseX, mouseY, wheel }, dt);
      const tp2 = performance.now();
      // Floating origin + halos + cities. The ship pose is BOTH the rebase
      // anchor and the camera measure (the camera trails by ~metres; the ship
      // sits at ~origin after the rebase).
      const nf = stepStreaming(player.state.position, player.state.position, screenHeightPx, fovRad);
      const tp3 = performance.now();

      // The avatar at the (near-)origin, facing the flight forward (creature
      // +Z = forward, +Y = up), feet an eye-height below the sim point.
      fwd.copy(player.state.forward);
      right.copy(player.state.bodyRight);
      up.crossVectors(fwd, right).normalize();
      right.crossVectors(up, fwd).normalize();
      basis.makeBasis(right, up, fwd);
      ship.quaternion.setFromRotationMatrix(basis);
      ship.position.copy(player.state.position).addScaledVector(up, -1);
      const gait = player.state.mode === "walking"
        ? Math.min(1, player.state.walkSpeed / 6)
        : 0;
      avatar.update(dt, { speed01: gait });

      rig.update(camera, player.state, dt, player.state.position);
      stepSky(camera, dt, screenHeightPx, fovRad);

      const tp4 = performance.now();
      (window as unknown as Record<string, unknown>).__flyPerf = {
        advanceBodies: +(tp1 - tp0).toFixed(2),
        playerPhysics: +(tp2 - tp1).toFixed(2),
        worldHalosLodCities: +(tp3 - tp2).toFixed(2),
        avatarRigSky: +(tp4 - tp3).toFixed(2),
      };

      const s = player.state;
      const alt = world.nearestBodyAltitudeAt(s.position).altitude;
      const status =
        `SHIP · ${world.frameMode} · ${s.mode} · speed ${Math.round(s.wingSpeed).toLocaleString()} m/s · ` +
        `×${s.wheelFactor.toFixed(s.wheelFactor < 10 ? 2 : 0)} (wheel) · hyper ${s.hyperMult.toFixed(1)} · ` +
        `alt ${Number.isFinite(alt) ? Math.round(alt).toLocaleString() + " m" : "—"} · ` +
        `${world.activeStar?.id ?? "interstellar"} · ${world.bodies.length} bodies`;
      return { near: nf.near, far: nf.far, status };
    },
    advanceWorld,
    stepStreaming,
    stepSky,
    cities: () => flightCities,
    setCityMarkerVisible(cell, visible) {
      const fc = flightCities.find(c => c.city.cell === cell);
      if (fc) fc.marker.visible = visible;
    },
    setCityColor(cell, hex) {
      const fc = flightCities.find(c => c.city.cell === cell);
      if (!fc) return;
      if (hex === null) {
        // Back to the shared neutral ember (drop any polity clone).
        if (fc.marker.material !== cityMat) {
          (fc.marker.material as THREE.Material).dispose();
          fc.marker.material = cityMat;
        }
        return;
      }
      // The polity's ink at beacon brightness (same HDR push past the bloom
      // threshold as the neutral ember, so a tinted city still glows).
      const want = new THREE.Color(hex).multiplyScalar(2.6);
      if (fc.marker.material !== cityMat) {
        const m = fc.marker.material as THREE.MeshBasicMaterial;
        if (m.color.equals(want)) return; // idempotent re-assert
        m.color.copy(want);
        return;
      }
      fc.marker.material = new THREE.MeshBasicMaterial({ color: want, fog: false });
    },
    avatarObject: ship,
    setAvatarVisible(visible) {
      ship.visible = visible;
    },
    addCities(bodyId, cities) {
      const body = world.bodies.find(b => b.id === bodyId);
      if (!body) return;
      const have = new Set(flightCities.map(c => c.city.cell));
      addCityEntries(body, cities.filter(c => !have.has(c.cell)));
    },
    removeCities(cells) {
      const drop = new Set(cells);
      for (let i = flightCities.length - 1; i >= 0; i--) {
        const fc = flightCities[i];
        if (!drop.has(fc.city.cell)) continue;
        fc.body.group.remove(fc.marker);
        if (fc.marker.material !== cityMat) (fc.marker.material as THREE.Material).dispose();
        flightCities.splice(i, 1);
      }
    },
    nearestCity(worldPos) {
      let best: FlightCity | null = null;
      let bestDist = Infinity;
      for (const fc of flightCities) {
        // Great-circle surface distance on the city's body.
        _localDir.copy(worldPos).sub(fc.body.worldPosition)
          .applyQuaternion(fc.body.inverseOrientation).normalize();
        _cityDir.set(...fc.city.dir);
        const distM = _localDir.angleTo(_cityDir) * fc.body.radius;
        if (distM < bestDist) { bestDist = distM; best = fc; }
      }
      return best ? { entry: best, distM: bestDist, regionM: regionRadiusM(best.body) } : null;
    },
    snapshot: () =>
      world.bodies.map((b) => ({
        id: b.id, type: b.type, dist: b.worldPosition.distanceTo(player.state.position),
      })),
    dispose() {
      for (const fc of flightCities) fc.body.group.remove(fc.marker);
      flightCities.length = 0;
      cityGeo.dispose();
      for (const fc of flightCities) {
        if (fc.marker.material !== cityMat) (fc.marker.material as THREE.Material).dispose();
      }
      cityMat.dispose();
      sky.dispose();
      avatar.dispose();
    },
  };
}

