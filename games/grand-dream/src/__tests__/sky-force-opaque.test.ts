/**
 * THE SKY MUST NOT TOUCH THE GROUND. A body's shell meshes are forced opaque
 * by apparent size, but every ground layer (a town, a wilderness chunk) hangs
 * planet-LOCAL INSIDE `body.group` so the planet's spin carries it — putting
 * it in the same subtree. A blanket traverse therefore stomped the live town's
 * materials flat EVERY frame: the dollhouse wall/roof fade restarted from
 * opacity 1 before it could finish (walls sealed, the cutaway never appeared),
 * and `transparent = false` + `depthWrite = true` were forced onto meshes that
 * must blend (creatures drew as opaque depth-writing rectangles).
 *
 * The anchor claims its subtree with OWNS_MATERIAL_STATE; the walk prunes it.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { forceBodyMeshesOpaque, OWNS_MATERIAL_STATE } from "@shared/world-engine/space/space-sky";

/** A mid-fade dollhouse wall: the state the cutaway needs to survive a frame. */
function fadingWall(): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial();
  mat.opacity = 0.66; // one fade step from 1 — exactly what the bug pinned it to
  mat.transparent = true;
  mat.depthWrite = false;
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
}

const matOf = (m: THREE.Mesh): THREE.MeshStandardMaterial => m.material as THREE.MeshStandardMaterial;

describe("space-sky force-opaque — prunes subtrees that own their material state", () => {
  it("leaves an anchored ground layer's fade untouched", () => {
    const body = new THREE.Group();
    const anchor = new THREE.Group();
    anchor.userData[OWNS_MATERIAL_STATE] = true;
    body.add(anchor);
    // The town sits UNDER the anchor, several levels deep (group → town → wall).
    const town = new THREE.Group();
    anchor.add(town);
    const wall = fadingWall();
    town.add(wall);

    forceBodyMeshesOpaque(body);

    expect(matOf(wall).opacity).toBeCloseTo(0.66);
    expect(matOf(wall).transparent).toBe(true);
    expect(matOf(wall).depthWrite).toBe(false);
  });

  it("still forces the body's OWN shell meshes opaque", () => {
    const body = new THREE.Group();
    const shell = fadingWall(); // not under an anchor — the planet's own surface
    body.add(shell);

    forceBodyMeshesOpaque(body);

    expect(matOf(shell).opacity).toBe(1);
    expect(matOf(shell).transparent).toBe(false);
    expect(matOf(shell).depthWrite).toBe(true);
  });

  it("keeps atmosphere shells translucent (forcing them opaque punches depth holes)", () => {
    const body = new THREE.Group();
    const halo = fadingWall();
    halo.name = "atmosphere_halo";
    body.add(halo);

    forceBodyMeshesOpaque(body);

    expect(matOf(halo).opacity).toBe(1); // ATM_SHELL_MULT
    expect(matOf(halo).transparent).toBe(true); // NOT forced opaque
  });

  it("prunes the whole subtree, not just the anchor node", () => {
    // The pin: an unflagged wall DIRECTLY under the body is stomped, while the
    // identical wall under the anchor survives — same walk, same frame.
    const body = new THREE.Group();
    const loose = fadingWall();
    body.add(loose);
    const anchor = new THREE.Group();
    anchor.userData[OWNS_MATERIAL_STATE] = true;
    const claimed = fadingWall();
    anchor.add(claimed);
    body.add(anchor);

    forceBodyMeshesOpaque(body);

    expect(matOf(loose).opacity).toBe(1);
    expect(matOf(claimed).opacity).toBeCloseTo(0.66);
  });
});
