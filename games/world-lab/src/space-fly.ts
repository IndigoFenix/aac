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
import { DEFAULT_GALAXY_PARAMS } from "@shared/space/galaxy";
import { createWorld, type StreamingWorld } from "@shared/space/world";
import { createPlayer, type Player } from "@shared/space/flight-sim";
import { createFlightCamera } from "@shared/space/flight-camera";
import { createSpaceSky, type SpaceSky } from "@shared/space/space-sky";

export interface SpaceFrame {
  near: number;
  far: number;
  status: string;
}

export interface SpaceFlight {
  group: THREE.Group;
  update(
    camera: THREE.PerspectiveCamera,
    aimX: number | null, aimY: number | null, wheel: number,
    dt: number, screenHeightPx: number, fovRad: number,
  ): SpaceFrame;
  /** Debug/test surface. */
  readonly player: Player;
  readonly world: StreamingWorld;
  snapshot(): Array<{ id: string; type: string; dist: number }>;
  dispose(): void;
}

export function createSpaceFlight(scene: THREE.Scene, seed: number, faceN = 12): SpaceFlight {
  const world = createWorld(seed, DEFAULT_GALAXY_PARAMS, faceN);
  const player = createPlayer(world);
  const rig = createFlightCamera();
  // The space render layer (sky/fog/ambient + starfield + halos) lives on the
  // scene; the host renders that scene through an HDR bloom pass.
  const sky: SpaceSky = createSpaceSky(scene, world.universe);

  const group = new THREE.Group();
  group.name = "space-flight";
  group.add(world.sceneGroup);

  // Generic ship placeholder (real models later).
  const shipGeo = new THREE.ConeGeometry(2.4, 12, 12);
  shipGeo.rotateX(Math.PI / 2); // nose down local +z
  const shipMat = new THREE.MeshStandardMaterial({ color: 0xdfe8f4, emissive: 0x1a2740, roughness: 0.4, metalness: 0.3 });
  const ship = new THREE.Mesh(shipGeo, shipMat);
  ship.name = "ship";
  group.add(ship);

  // The lock reticle / target preview is a DOM overlay owned by the host
  // (space-hud.ts), driven from player.state.lockedBodyId + lockProgress.

  let simTime = 0;
  const camWorld = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  return {
    group,
    player,
    world,
    update(camera, aimX, aimY, wheel, dt, screenHeightPx, fovRad) {
      const mouseX = 0.5 + (aimX ?? 0) * 0.5;
      const mouseY = 0.5 - (aimY ?? 0) * 0.5;
      simTime += dt;

      world.advanceBodies(simTime, dt);
      player.update({ mouseX, mouseY, wheel }, dt);
      // Floating origin: transitions + rebase the player to the scene origin.
      world.checkActiveSystem(player.state.position);
      // The camera trails the ship by ~metres; the ship sits at ~origin now.
      camWorld.copy(player.state.position);
      // Materialize (mesh + deferred geology) bodies crossing ~0.5px + LOD.
      world.updateHalos(camWorld, screenHeightPx, fovRad);

      // Ship at the (near-)origin, nose along the flight forward.
      ship.position.copy(player.state.position);
      fwd.copy(player.state.forward);
      right.copy(player.state.bodyRight);
      up.crossVectors(fwd, right).normalize();
      right.crossVectors(up, fwd).normalize();
      basis.makeBasis(right, up, fwd);
      ship.quaternion.setFromRotationMatrix(basis);

      rig.update(camera, player.state, dt, player.state.position);

      // Space render layer — driven from the ACTUAL camera position (what the
      // starfield centres on and halos measure against).
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

      const s = player.state;
      const alt = world.nearestBodyAltitudeAt(s.position).altitude;
      const status =
        `SHIP · ${world.frameMode} · ${s.mode} · speed ${Math.round(s.wingSpeed).toLocaleString()} m/s · ` +
        `×${s.wheelFactor.toFixed(s.wheelFactor < 10 ? 2 : 0)} (wheel) · hyper ${s.hyperMult.toFixed(1)} · ` +
        `alt ${Number.isFinite(alt) ? Math.round(alt).toLocaleString() + " m" : "—"} · ` +
        `${world.activeStar?.id ?? "interstellar"} · ${world.bodies.length} bodies`;
      // Far spans past the star-field sphere (3e13); logdepth keeps it precise.
      return { near: 0.5, far: 1e14, status };
    },
    snapshot: () =>
      world.bodies.map((b) => ({
        id: b.id, type: b.type, dist: b.worldPosition.distanceTo(player.state.position),
      })),
    dispose() {
      sky.dispose();
      shipGeo.dispose();
      shipMat.dispose();
    },
  };
}

