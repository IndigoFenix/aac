/**
 * 3D galaxy viewer — the density field made visible: a deterministic
 * rejection-sampled point cloud over `densityAt` (the same field the
 * on-demand star cells integrate), plus bright sprites for the focusable
 * neighbourhood stars. Scaled so the galaxy fits a 1000-unit radius —
 * the orbit camera doesn't care about light-years.
 */
import * as THREE from "three";
import { densityAt, mulberry32, type StarRecord } from "@shared/space/galaxy";
import type { BuiltGalaxy } from "@shared/space/space-game";

const CLOUD_POINTS = 18_000;

export interface GalaxyView {
  group: THREE.Group;
  /** Orbit scale, view units. */
  radius: number;
  /** A star's position in view units. */
  starPos(star: StarRecord): [number, number, number];
  dispose(): void;
}

export function createGalaxyView(built: BuiltGalaxy): GalaxyView {
  const { params, spec } = built;
  const scale = 1000 / params.radius;
  const disposables: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  group.name = "galaxy";

  // Rejection-sample the density field (deterministic — the cloud is the
  // same picture every boot).
  const rng = mulberry32((spec.seed ^ 0x51ed270b) >>> 0);
  const maxDensity = Math.max(
    densityAt(params, 0, 0, 0),
    densityAt(params, params.radius * 0.05, 0, 0),
    1e-12,
  );
  const positions = new Float32Array(CLOUD_POINTS * 3);
  const colors = new Float32Array(CLOUD_POINTS * 3);
  let placed = 0;
  let guard = 0;
  const R = params.radius * 1.1;
  while (placed < CLOUD_POINTS && guard++ < CLOUD_POINTS * 60) {
    const x = (rng() * 2 - 1) * R;
    const y = (rng() * 2 - 1) * R * 0.25;
    const z = (rng() * 2 - 1) * R;
    const d = densityAt(params, x, y, z);
    // Acceptance carries the DISC SHAPE (compressed so the rim survives
    // the core's orders of magnitude); per-point brightness carries the
    // ARM CONTRAST — local density against its own azimuthal average.
    // Point-count alone can't show both: raw density buries the ~2× arm
    // edge under the radial falloff.
    if (d <= 0 || Math.pow(d / maxDensity, 0.5) < rng()) continue;
    positions[placed * 3] = x * scale;
    positions[placed * 3 + 1] = y * scale;
    positions[placed * 3 + 2] = z * scale;
    const r = Math.hypot(x, z);
    let axi = 0;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      axi += densityAt(params, r * Math.cos(a), y, r * Math.sin(a));
    }
    axi /= 6;
    const contrast = axi > 0 ? Math.max(0.25, Math.min(1, (d / axi) * 0.55)) : 0.6;
    // Warm core, blue-white arms — the classic galactic gradient.
    const t = Math.min(1, (r / params.radius) * 1.4);
    colors[placed * 3] = (1 - 0.25 * t) * contrast;
    colors[placed * 3 + 1] = (0.9 - 0.15 * t) * contrast;
    colors[placed * 3 + 2] = (0.75 + 0.25 * t) * contrast;
    placed++;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, placed * 3), 3));
  cloudGeo.setAttribute("color", new THREE.BufferAttribute(colors.subarray(0, placed * 3), 3));
  const cloudMat = new THREE.PointsMaterial({
    // Pixel-sized (no attenuation): the cloud is a MAP of the density
    // field — world-unit points vanish at overview distance.
    size: 2.5, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.85, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  disposables.push(cloudGeo, cloudMat);
  group.add(new THREE.Points(cloudGeo, cloudMat));

  // The focusable neighbourhood: real stars, brighter and pickable.
  const nearGeo = new THREE.BufferGeometry();
  const nearPos = new Float32Array(built.stars.length * 3);
  const nearCol = new Float32Array(built.stars.length * 3);
  built.stars.forEach((s, i) => {
    nearPos[i * 3] = s.galacticPosition.x * scale;
    nearPos[i * 3 + 1] = s.galacticPosition.y * scale;
    nearPos[i * 3 + 2] = s.galacticPosition.z * scale;
    nearCol[i * 3] = s.color.r;
    nearCol[i * 3 + 1] = s.color.g;
    nearCol[i * 3 + 2] = s.color.b;
  });
  nearGeo.setAttribute("position", new THREE.BufferAttribute(nearPos, 3));
  nearGeo.setAttribute("color", new THREE.BufferAttribute(nearCol, 3));
  const nearMat = new THREE.PointsMaterial({
    size: 5, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.95, depthWrite: false,
  });
  disposables.push(nearGeo, nearMat);
  group.add(new THREE.Points(nearGeo, nearMat));

  return {
    group,
    radius: 1000,
    starPos: s => [s.galacticPosition.x * scale, s.galacticPosition.y * scale, s.galacticPosition.z * scale],
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
