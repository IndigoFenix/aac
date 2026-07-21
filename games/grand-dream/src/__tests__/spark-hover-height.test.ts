/**
 * THE GAZE SPARK HOVERS OVER AN OBJECT'S TOP, NOT ITS RADIUS. `ObjectSpec.radius`
 * is the FOOTPRINT half-extent (a box's half-width) — it says nothing about
 * height, so keying the hover point off it sank the spark INSIDE tall furniture
 * (the cabinets). The height is measured from the shell's own geometry.
 *
 * Measured in the object's LOCAL frame on purpose: `Box3.setFromObject` reports
 * WORLD space, and on a spinning planet the town hangs under a rotating anchor,
 * so a world-space `max.y` is neither the object's height nor even "up".
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { localTopY } from "@shared/world-engine/render3d";

/** A cabinet: narrow footprint (radius 0.3), tall shell (2 m), base at origin. */
function cabinet(): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2, 0.6), new THREE.MeshStandardMaterial());
  box.position.y = 1; // geometry centred → base sits on the group's origin
  g.add(box);
  return g;
}

describe("gaze spark hover height — localTopY", () => {
  it("measures a tall cabinet's real height, not its footprint radius", () => {
    const top = localTopY(cabinet(), 0.3);
    expect(top).toBeCloseTo(2);
    // The bug: radius (0.3) + old 0.5 clearance = 0.8 — well INSIDE a 2 m shell.
    expect(top).toBeGreaterThan(0.3 + 0.5);
  });

  it("is frame-INDEPENDENT — a rotated/translated planet anchor cannot change it", () => {
    // The same cabinet, hung under a spinning, tilted, far-flung anchor: the
    // height it reports must not move (world-space Box3 would swing wildly).
    const anchor = new THREE.Group();
    anchor.position.set(1e6, -4e5, 3e5);
    anchor.quaternion.setFromEuler(new THREE.Euler(0.7, 2.1, -1.3));
    anchor.scale.setScalar(1);
    const c = cabinet();
    anchor.add(c);
    anchor.updateWorldMatrix(true, true);

    expect(localTopY(c, 0.3)).toBeCloseTo(2);
  });

  it("unions every part of a multi-mesh shell", () => {
    const g = cabinet();
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
    knob.position.y = 2.4; // a finial standing proud of the box
    g.add(knob);
    expect(localTopY(g, 0.3)).toBeCloseTo(2.45);
  });

  it("falls back when there is no shell to measure", () => {
    expect(localTopY(new THREE.Group(), 0.42)).toBe(0.42);
  });
});
