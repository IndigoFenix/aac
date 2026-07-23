/**
 * RIVER DEBUG OVERLAY — the extracted river network drawn as SKY RIBBONS,
 * lifted far above the terrain and shown only with the nations viewer.
 *
 * This is deliberately NOT the water render any more. Draped ribbons cannot
 * track the terrain mesh: the quadtree's height at a point changes with LOD
 * (a coarse triangle chords across a concave valley), so a draped ribbon
 * floats where the mesh is low and buries where it is high — no lift constant
 * fixes both. The VISIBLE river is now painted into the terrain itself
 * (surface.riverTintAt + the heightAt valley notch, planet/rivers.ts), which
 * tracks every LOD by construction. What remains here is a diagnostic: with
 * the nations layer lit, the whole network hangs unmissably in the sky so you
 * can fly to where the rivers are and check the ground work under them.
 *
 * SEIZURE SAFETY: static geometry, constant emissive, no specular motion.
 */
import * as THREE from "three";
import type { CelestialBody } from "@shared/world-engine/space/body";
import {
  extractRiverNetwork, riverHalfWidthM, RIVER_MIN_ACCUM, type RiverPolyline,
} from "@shared/world-engine/planet/rivers";
import { roadMaterial } from "@shared/world-engine/materials";

/** Centerline resample step. */
const RIVER_SEG_M = 1500;
/** Sky lift as a fraction of the radius — unmistakably OFF the ground. */
const SKY_LIFT_FRAC = 0.015;
const RIVER_COLOR = 0x3f8fd8;

export interface RiverRibbons {
  /** Parity with the road net's drive signature; the overlay is static. */
  update(playerWorld: THREE.Vector3): void;
  /** Mirror of the road net's `nations(on)` — the overlay shows only while
   *  the nations layer is lit. */
  nations(on: boolean): void;
  dispose(): void;
  stats(): { rivers: number; verts: number };
}

/** Arc position → planet-local point on the SKY SHELL (radius + macro height
 *  + lift). Doubles; callers subtract their center before Float32 storage. */
function samplePos(
  river: RiverPolyline, s: number, radius: number,
  heightAt: (dir: [number, number, number]) => number, liftM: number, out: THREE.Vector3,
): THREE.Vector3 {
  const { cum, dirs, lengthM } = river.route;
  const ss = Math.max(0, Math.min(lengthM, s));
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= ss) lo = mid; else hi = mid;
  }
  const a = dirs[lo]!;
  const b = dirs[Math.min(lo + 1, dirs.length - 1)]!;
  const seg = cum[Math.min(lo + 1, cum.length - 1)]! - cum[lo]!;
  const f = seg > 1e-9 ? (ss - cum[lo]!) / seg : 0;
  out.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f).normalize();
  const h = Math.max(0, heightAt([out.x, out.y, out.z]));
  return out.multiplyScalar(radius + h + liftM);
}

export function createRiverRibbons(body: CelestialBody): RiverRibbons | null {
  const built = body.geography;
  if (!built) return null;
  const rivers = extractRiverNetwork(built, { minAccum: RIVER_MIN_ACCUM });
  if (!rivers.length) return null;

  const radius = body.radius;
  const surface = built.surface;
  // Macro height: the sky shell should follow the broad terrain, and macro is
  // cheap and notch-free.
  const macroAt = surface.macroHeightAt
    ? (dir: [number, number, number]): number => surface.macroHeightAt!(dir)
    : (dir: [number, number, number]): number => surface.heightAt(dir);
  const liftM = radius * SKY_LIFT_FRAC;
  // Sky glyph: width scales up with the lift so the lines stay legible from
  // the altitudes the nations layer is read at.
  const widthScale = Math.max(2, liftM / 400);

  const material = roadMaterial(RIVER_COLOR, {
    emissive: 0x3f8fd8, emissiveIntensity: 0.9, roughness: 1,
  });

  const root = new THREE.Group();
  root.name = "rivers-debug";
  root.visible = false; // nations viewer reveals it
  body.group.add(root);

  const mid = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  let verts = 0;
  for (const river of rivers) {
    const len = river.route.lengthM;
    const steps = Math.max(1, Math.ceil(len / RIVER_SEG_M));
    const w0 = riverHalfWidthM(river.accumSource) * widthScale;
    const w1 = riverHalfWidthM(river.accumMouth) * widthScale;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      pts.push(samplePos(river, (len * i) / steps, radius, macroAt, liftM, new THREE.Vector3()));
    }
    // Per-river mesh centered on its midpoint (float32 precision, the roads
    // lesson).
    samplePos(river, len / 2, radius, macroAt, liftM, mid);
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const halfW = w0 + (w1 - w0) * (i / steps);
      tan.copy(pts[Math.min(i + 1, pts.length - 1)]!).sub(pts[Math.max(i - 1, 0)]!);
      up.copy(p).normalize();
      side.crossVectors(up, tan);
      const l = side.length();
      if (l < 1e-9) side.set(1, 0, 0); else side.divideScalar(l);
      pos.push(
        p.x + side.x * halfW - mid.x, p.y + side.y * halfW - mid.y, p.z + side.z * halfW - mid.z,
        p.x - side.x * halfW - mid.x, p.y - side.y * halfW - mid.y, p.z - side.z * halfW - mid.z,
      );
      nrm.push(up.x, up.y, up.z, up.x, up.y, up.z);
      if (i + 1 < pts.length) {
        const v = i * 2;
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    if (!idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(mid);
    mesh.frustumCulled = false; // a river's span defeats sphere culling
    root.add(mesh);
    verts += pos.length / 3;
  }

  return {
    update() { /* static overlay */ },
    nations(on: boolean) { root.visible = on; },
    dispose() {
      for (const child of root.children) {
        (child as THREE.Mesh).geometry?.dispose();
      }
      body.group.remove(root);
      material.dispose();
    },
    stats: () => ({ rivers: rivers.length, verts }),
  };
}
