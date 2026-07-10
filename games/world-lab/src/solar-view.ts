/**
 * 3D solar-system viewer — the system model as an orrery: an emissive star
 * at its physical color, orbit rings, and planets at log-compressed
 * distances (real AU spans two orders of magnitude; the eye wants them on
 * one table). Radii are log-scaled too, or Jupiter erases Mercury.
 */
import * as THREE from "three";
import { mulberry32 } from "@shared/space/galaxy";
import type { BuiltSolarSystem } from "@shared/space/space-game";
import type { SystemPlanet } from "@shared/space/solar";

const KIND_COLOR: Record<SystemPlanet["kind"], number> = {
  rocky: 0xb59a6a,
  gas: 0xd8a45a,
  ice: 0x9fc4de,
};

export interface SolarView {
  group: THREE.Group;
  radius: number;
  planetPos(index: number): [number, number, number];
  dispose(): void;
}

/** AU → display distance (log-compressed). */
const displayAU = (au: number): number => 9 + 15 * Math.log2(1 + au);

export function createSolarView(built: BuiltSolarSystem): SolarView {
  const { system } = built;
  const disposables: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  group.name = "solar-system";
  const rng = mulberry32((system.seed ^ 0x2c1b3c6d) >>> 0);

  // The star, at its stellar-physics color (a red dwarf is red, a giant
  // is a giant).
  const starR = 3.2 * Math.max(0.5, Math.log10(1 + system.star.state.radius * 9));
  const starGeo = new THREE.SphereGeometry(starR, 32, 16);
  const starMat = new THREE.MeshBasicMaterial({ color: system.star.state.color });
  disposables.push(starGeo, starMat);
  group.add(new THREE.Mesh(starGeo, starMat));
  const glow = new THREE.PointLight(system.star.state.color, 3, 0, 0.4);
  group.add(glow);

  const ringMat = new THREE.LineBasicMaterial({ color: 0x2e4361, transparent: true, opacity: 0.8 });
  disposables.push(ringMat);
  const positions: Array<[number, number, number]> = [];

  for (const p of system.planets) {
    const d = displayAU(p.orbitAU);
    // Orbit ring.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * d, 0, Math.sin(t) * d));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(pts);
    disposables.push(ringGeo);
    group.add(new THREE.Line(ringGeo, ringMat));

    // The planet, parked at a deterministic phase on its ring.
    const phase = rng() * Math.PI * 2;
    const pr = 0.9 + 1.6 * Math.log10(1 + p.radiusRe);
    const geo = new THREE.SphereGeometry(pr, 20, 12);
    const mat = new THREE.MeshStandardMaterial({ color: KIND_COLOR[p.kind], roughness: 0.8, metalness: 0 });
    disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    const pos: [number, number, number] = [Math.cos(phase) * d, 0, Math.sin(phase) * d];
    mesh.position.set(...pos);
    group.add(mesh);
    positions.push(pos);
  }

  const outer = system.planets.length
    ? displayAU(system.planets[system.planets.length - 1].orbitAU)
    : 30;

  return {
    group,
    radius: outer * 1.15,
    planetPos: i => positions[i] ?? [0, 0, 0],
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
