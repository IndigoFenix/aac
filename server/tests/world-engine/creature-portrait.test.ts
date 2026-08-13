// CREATURE PORTRAITS (creatures/portrait.ts): the camera that frames a body for
// a board button. Headless THREE (no WebGL) like the sibling creature suites —
// the BAKE needs a GL context and a DOM, but the framing and the scene assembly
// are pure, and they are where a portrait goes wrong: a camera behind the skull,
// a frustum that crops the face, a grazing animal photographed pointing at the
// grass, a dog's own back filling the frame behind its face.

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import {
  buildPortraitView,
  framePortrait,
  portraitKey,
  PORTRAIT_YAW_DEG,
} from "@shared/world-engine/creatures/portrait.js";
import { buildSkeleton } from "@shared/world-engine/creatures/skeleton.js";
import { clampBlueprint } from "@shared/world-engine/creatures/blueprint.js";
import { getSpecies, listSpecies, SPARK_SPECIES_ID } from "@shared/world-engine/creatures/species.js";
import { outfitPresetFor } from "@shared/world-engine/creatures/clothing.js";

const skeletonOf = (id: string, outfit?: number) => {
  const base = getSpecies(id)!.blueprint;
  return buildSkeleton(clampBlueprint(outfit === undefined ? base : { ...base, outfit: outfitPresetFor(outfit) }));
};

/** Species that stand on two legs (the dollhouse's people and animal-people). */
const UPRIGHT = ["human", "human_cute", "frog_person", "bear_person", "dog_person", "rabbit_person"];
/** Species that stand on four (a body shot, not a face). */
const FOUR_LEGGED = ["quadruped", "cow", "dog", "cat", "horse", "deer", "sheep"];

describe("framePortrait — where the portrait camera stands", () => {
  it("gives an UPRIGHT body a head portrait, framed on its skull", () => {
    for (const id of UPRIGHT) {
      const skel = skeletonOf(id);
      const frame = framePortrait(skel);
      expect(frame.framedHead).toBe(true);
      // The crop is HEAD-SIZED: bigger than the braincase (so the face isn't
      // clipped at the ears), far smaller than the whole standing body.
      const head = skel.head!;
      const headSize = Math.max(head.radius, head.domeHalf, head.halfLen);
      const bodyHeight = skel.bounds.max.y - skel.bounds.min.y;
      expect(frame.halfW).toBeGreaterThan(headSize);
      expect(frame.halfW).toBeLessThan(bodyHeight / 2);
      expect(frame.halfH).toBeCloseTo(frame.halfW, 6); // a head portrait is square
      // Looking at the head, not past it.
      expect(Math.abs(frame.target.y - head.center.y)).toBeLessThanOrEqual(frame.halfH);
    }
  });

  it("gives a FOUR-LEGGED body a whole-body shot instead of a muzzle close-up", () => {
    for (const id of FOUR_LEGGED) {
      const skel = skeletonOf(id);
      const frame = framePortrait(skel);
      expect(frame.framedHead).toBe(false);
      // Every corner of the animal is inside the frame — nothing is cropped.
      const eye = frame.eye;
      const right = eye.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      const camUp = right.clone().cross(eye).normalize();
      for (const cx of [skel.bounds.min.x, skel.bounds.max.x]) {
        for (const cy of [skel.bounds.min.y, skel.bounds.max.y]) {
          for (const cz of [skel.bounds.min.z, skel.bounds.max.z]) {
            const d = new THREE.Vector3(cx, cy, cz).sub(frame.target);
            expect(Math.abs(d.dot(right))).toBeLessThanOrEqual(frame.halfW + 1e-6);
            expect(Math.abs(d.dot(camUp))).toBeLessThanOrEqual(frame.halfH + 1e-6);
          }
        }
      }
      // Side-on-ish, not down the length of the animal: the spine must not run
      // straight into the lens, or the body hides behind its own head.
      const spineBones = skel.bones.filter((b) => b.chain === "spine");
      const spine = new THREE.Vector3(
        spineBones[spineBones.length - 1]!.tail.x - spineBones[0]!.head.x,
        0,
        spineBones[spineBones.length - 1]!.tail.z - spineBones[0]!.head.z,
      ).normalize();
      expect(Math.abs(spine.dot(new THREE.Vector3(eye.x, 0, eye.z).normalize()))).toBeLessThan(0.75);
    }
  });

  it("stands a head portrait at EYE LEVEL — never chasing a head that points down", () => {
    // An animal-person's skull still pitches; a camera that followed it would
    // bake the floor. (Four-legged bodies get a deliberate downward tilt.)
    for (const id of UPRIGHT) {
      const frame = framePortrait(skeletonOf(id));
      expect(Math.abs(frame.eye.y)).toBeLessThan(1e-6);
      expect(frame.eye.length()).toBeCloseTo(1, 6);
    }
  });

  it("turns off dead-on by the requested yaw, and only by that", () => {
    const skel = skeletonOf("human");
    const straight = framePortrait(skel, { yawDeg: 0 });
    const turned = framePortrait(skel, { yawDeg: PORTRAIT_YAW_DEG });
    const angle = (straight.eye.angleTo(turned.eye) * 180) / Math.PI;
    expect(angle).toBeCloseTo(PORTRAIT_YAW_DEG, 3);
    // Same subject either way — only the vantage moved.
    expect(turned.target.toArray()).toEqual(straight.target.toArray());
    expect(turned.halfW).toBeCloseTo(straight.halfW, 6);
  });

  it("frames the whole plant when there is no skull to find", () => {
    expect(getSpecies("oak")).toBeDefined();
    const skel = skeletonOf("oak");
    const frame = framePortrait(skel);
    if (skel.head) return; // a plant that grew a head is not this test's subject
    expect(frame.framedHead).toBe(false);
    expect(frame.halfH).toBeGreaterThanOrEqual((skel.bounds.max.y - skel.bounds.min.y) / 2);
  });
});

describe("buildPortraitView — the scene handed to the renderer", () => {
  it("puts the camera outside the body, aimed at the frame's target", () => {
    const view = buildPortraitView({ speciesId: "human" })!;
    expect(view).not.toBeNull();
    const skel = skeletonOf("human");
    const span = Math.hypot(
      skel.bounds.max.x - skel.bounds.min.x,
      skel.bounds.max.y - skel.bounds.min.y,
      skel.bounds.max.z - skel.bounds.min.z,
    );
    // Outside the body's own extent, so no torso geometry sits between the
    // camera and the face.
    expect(view.camera.position.distanceTo(view.frame.target)).toBeGreaterThan(span);
    // Aimed at it: the camera's -Z axis points from the camera to the target.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(view.camera.quaternion);
    const toTarget = view.frame.target.clone().sub(view.camera.position).normalize();
    expect(forward.dot(toTarget)).toBeCloseTo(1, 5);
    // The whole subject is inside the near/far slab.
    const reach = Math.max(view.frame.halfW, view.frame.halfH);
    expect(view.camera.near).toBeLessThan(view.camera.position.distanceTo(view.frame.target) - reach);
    expect(view.camera.far).toBeGreaterThan(view.camera.position.distanceTo(view.frame.target) + span);
    // The frustum IS the frame — a mismatch would stretch the baked picture.
    expect(view.camera.right - view.camera.left).toBeCloseTo(view.frame.halfW * 2, 6);
    expect(view.camera.top - view.camera.bottom).toBeCloseTo(view.frame.halfH * 2, 6);
    view.dispose();
  });

  it("draws a body with geometry in it, and leaves the shared assets alone", () => {
    const view = buildPortraitView({ speciesId: "cat" })!;
    let mesh: THREE.Mesh | undefined;
    view.scene.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    expect(mesh).toBeDefined();
    const geometry = mesh!.geometry;
    expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
    // The scene is lit — the bodies use lit materials, and an unlit portrait
    // would bake a silhouette.
    const lights = view.scene.children.filter((o) => (o as THREE.Light).isLight);
    expect(lights.length).toBeGreaterThan(0);
    view.dispose();
    // dispose() drops what the VIEW made; the cached species geometry survives
    // for the next portrait and for the world itself.
    expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
  });

  it("dresses the body when an outfit index is given", () => {
    const bare = buildPortraitView({ speciesId: "human" })!;
    const dressed = buildPortraitView({ speciesId: "human", outfit: 3 })!;
    const vertsOf = (v: typeof bare): number => {
      let n = 0;
      v.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) n += m.geometry.getAttribute("position").count;
      });
      return n;
    };
    // Clothes are lofted geometry — a dressed body carries more of it.
    expect(vertsOf(dressed)).toBeGreaterThan(vertsOf(bare));
    bare.dispose();
    dressed.dispose();
  });

  it("refuses a bodiless species rather than standing a stranger in its place", () => {
    expect(buildPortraitView({ speciesId: SPARK_SPECIES_ID })).toBeNull();
    expect(buildPortraitView({ speciesId: "no_such_species" })).toBeNull();
  });
});

describe("portraitKey — one bake per body, not per creature", () => {
  it("collapses two creatures wearing the same species + preset", () => {
    expect(portraitKey({ speciesId: "human", outfit: 4 })).toBe(portraitKey({ speciesId: "human", outfit: 4 }));
    expect(portraitKey({ speciesId: "human", outfit: 4 })).not.toBe(portraitKey({ speciesId: "human", outfit: 5 }));
    expect(portraitKey({ speciesId: "human" })).not.toBe(portraitKey({ speciesId: "human", outfit: 0 }));
    expect(portraitKey({ speciesId: "human" })).not.toBe(portraitKey({ speciesId: "dog" }));
  });
});
