/**
 * Stage 4d: the streaming galaxy world — floating origin keeps the player at
 * the scene origin at real scale, and flying far enough tears the home system
 * down (interstellar). The ported flight sim flies it.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DEFAULT_GALAXY_PARAMS, GALAXY } from "@shared/space/galaxy";
import { createWorld } from "@shared/space/world";
import { createPlayer } from "@shared/space/flight-sim";

const LY_M = GALAXY.lyToSceneMeters;

describe("streaming world — floating origin + interstellar", () => {
  it("boots in the home system with the home world spawnable", { timeout: 120000 }, () => {
    const world = createWorld(1337, DEFAULT_GALAXY_PARAMS);
    expect(world.frameMode).toBe("STAR");
    expect(world.activeStar?.id).toBe("home_star");
    expect(world.bodies.length).toBeGreaterThan(4);
    expect(world.homePlanet).not.toBeNull();
    // The spawn world is materialized (its terrain samplers exist).
    expect(world.homePlanet!.surfaceAt).toBeDefined();
    // A far-off planet has NOT baked (deferred to approach).
    const farRocky = world.bodies.find((b) => b.walkable && b !== world.homePlanet);
    expect(farRocky?.heightAt).toBeUndefined();

    const player = createPlayer(world);
    expect(player.state.mode).toBe("flying");
  });

  it("floating origin collapses the player toward the scene origin each frame", { timeout: 120000 }, () => {
    const world = createWorld(1337, DEFAULT_GALAXY_PARAMS);
    const player = createPlayer(world);
    let simTime = 0;
    let maxMag = 0;
    for (let i = 0; i < 60; i++) {
      simTime += 0.05;
      world.advanceBodies(simTime, 0.05);
      player.update({ mouseX: 0.5, mouseY: 0.5, wheel: i < 20 ? 6 : 0 }, 0.05);
      world.checkActiveSystem(player.state.position); // rebases player → origin
      maxMag = Math.max(maxMag, player.state.position.length());
    }
    // Despite flying (wheel boost), the player is re-collapsed to the origin
    // every frame — its post-rebase magnitude stays a single frame's travel, not
    // an ever-growing world coordinate.
    expect(maxMag).toBeLessThan(1e9); // one frame's flight, not 1e11 orbital coords
    expect(world.frameMode).toBe("STAR"); // still near home
  });

  it("flying beyond the dematerialize radius leaves the home system", { timeout: 120000 }, () => {
    const world = createWorld(1337, DEFAULT_GALAXY_PARAMS);
    const player = createPlayer(world);
    expect(world.frameMode).toBe("STAR");
    const homeStarId = world.activeStar!.id;

    // Jump the player ~2 ly out along the galactic plane and resolve.
    player.state.position.set(2 * LY_M, 0, 0.3 * LY_M);
    world.checkActiveSystem(player.state.position);

    // Either we drifted into interstellar space (GALACTIC, no bodies) or we
    // materialized a DIFFERENT star's system — never still the home Sol.
    if (world.frameMode === "GALACTIC") {
      expect(world.bodies.length).toBe(0);
      expect(world.activeStar).toBeNull();
    } else {
      expect(world.activeStar!.id).not.toBe(homeStarId);
      expect(world.bodies.length).toBeGreaterThan(0);
    }
    // The player was rebased back to (near) the origin by the floating origin.
    expect(player.state.position.length()).toBeLessThan(1e13);
  });

  it("galactic density varies with position (drives the hyperdrive cap)", () => {
    const world = createWorld(1337, DEFAULT_GALAXY_PARAMS);
    const dHome = world.galacticDensityAt(new THREE.Vector3(0, 0, 0));
    const dFar = world.galacticDensityAt(new THREE.Vector3(0, 400 * LY_M, 0)); // far above the disc
    expect(dHome).toBeGreaterThan(0);
    expect(dFar).toBeLessThan(dHome); // thinner away from the disc plane
  });
});
