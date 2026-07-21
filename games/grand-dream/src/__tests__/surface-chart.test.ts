/**
 * SurfaceChart — the engine's world↔ground transform. The whole coordinate-mode
 * migration rests on ONE invariant: a chart stood at a surface point coincides,
 * byte-for-byte, with a THREE.Group placed the way the streamed town mesh / city
 * anchor is placed (child of the body group at `dir·(R+h)` with `up→dir` shortest
 * arc). These tests pin that, plus the round-trips.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  createSurfaceChart,
  chartAtPoint,
  type ChartBody,
} from "../../../../shared/world-engine/space/surface-chart";

const UP = new THREE.Vector3(0, 1, 0);

/** A body with a non-trivial world position + axial orientation. */
function makeBody(): ChartBody {
  return {
    worldPosition: new THREE.Vector3(1.5e9, -3.2e8, 7.7e8),
    orientation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, 1.3, -0.4)),
    radius: 6_371_000,
  };
}

/** The town-anchor convention as a real scene graph, for a byte-for-byte compare. */
function anchorGroup(body: ChartBody, dir: THREE.Vector3, h: number): THREE.Group {
  const bodyGroup = new THREE.Group();
  bodyGroup.position.copy(body.worldPosition);
  bodyGroup.quaternion.copy(body.orientation);
  const anchor = new THREE.Group();
  anchor.position.copy(dir).multiplyScalar(body.radius + h);
  anchor.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  bodyGroup.add(anchor);
  bodyGroup.updateWorldMatrix(true, true);
  return anchor;
}

describe("SurfaceChart — town-anchor convention agreement", () => {
  it("origin + orientation match a city-anchor group byte-for-byte", () => {
    const body = makeBody();
    const dir = new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    const h = 420;
    const chart = createSurfaceChart(body, dir, h);
    const anchor = anchorGroup(body, dir, h);

    const wp = anchor.getWorldPosition(new THREE.Vector3());
    const wq = anchor.getWorldQuaternion(new THREE.Quaternion());
    expect(chart.origin.distanceTo(wp)).toBeLessThan(1e-3);
    expect(chart.quat.angleTo(wq)).toBeLessThan(1e-6);
  });

  it("chart (x,z) plan coords equal the anchor's localToWorld (buildings land right)", () => {
    const body = makeBody();
    const dir = new THREE.Vector3(-0.2, 0.9, 0.35).normalize();
    const chart = createSurfaceChart(body, dir, 0);
    const anchor = anchorGroup(body, dir, 0);
    for (const [px, pz] of [[0, 0], [120, -40], [-300, 260]] as const) {
      const viaChart = chart.toWorld(px, pz);
      const viaMesh = anchor.localToWorld(new THREE.Vector3(px, 0, pz));
      expect(viaChart.distanceTo(viaMesh)).toBeLessThan(1e-2);
    }
  });
});

describe("SurfaceChart — round-trips", () => {
  it("fromWorld ∘ toWorld is identity", () => {
    const body = makeBody();
    const chart = createSurfaceChart(body, new THREE.Vector3(0.1, 1, 0.2).normalize(), 88);
    for (const [x, z, y] of [[0, 0, 0], [50, -120, 5], [-900, 640, -3]] as const) {
      const back = chart.fromWorld(chart.toWorld(x, z, y));
      expect(back.x).toBeCloseTo(x, 3);
      expect(back.z).toBeCloseTo(z, 3);
      expect(back.y).toBeCloseTo(y, 3);
    }
  });

  it("east/north/up are an orthonormal right-handed basis with up = surface normal", () => {
    const body = makeBody();
    const dir = new THREE.Vector3(0.5, 0.5, 0.7).normalize();
    const chart = createSurfaceChart(body, dir, 0);
    expect(chart.east.length()).toBeCloseTo(1, 6);
    expect(chart.north.length()).toBeCloseTo(1, 6);
    expect(chart.up.length()).toBeCloseTo(1, 6);
    expect(chart.east.dot(chart.north)).toBeCloseTo(0, 6);
    expect(chart.east.dot(chart.up)).toBeCloseTo(0, 6);
    // up equals the body-local dir carried by the body orientation.
    const worldUp = dir.clone().applyQuaternion(body.orientation);
    expect(chart.up.angleTo(worldUp)).toBeLessThan(1e-6);
  });

  it("worldDirToHeading inverts headingToWorldQuat", () => {
    const body = makeBody();
    const chart = createSurfaceChart(body, new THREE.Vector3(0, 1, 0.05).normalize(), 0);
    for (const a of [0, 0.7, -1.9, 3.0]) {
      const q = chart.headingToWorldQuat(a);
      // A quaternion built from heading `a` turns local +north to a world dir…
      const worldDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(chart.worldDirToHeading(worldDir)).toBeCloseTo(a, 5);
    }
  });

  it("chartAtPoint equals createSurfaceChart on the same address", () => {
    const body = makeBody();
    const dir = new THREE.Vector3(0.3, 0.9, -0.2).normalize();
    const a = createSurfaceChart(body, dir, 55);
    const b = chartAtPoint({ body, localDir: dir, elevation: 55 });
    expect(a.origin.distanceTo(b.origin)).toBeLessThan(1e-6);
    expect(a.quat.angleTo(b.quat)).toBeLessThan(1e-9);
  });
});
