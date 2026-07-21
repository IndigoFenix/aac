/**
 * RIVERS AS DRAPED RIBBONS — the flow network drawn as the thin water lines it
 * actually is, instead of tinted cell-blobs.
 *
 * The DATA is shared and deterministic: `extractRiverNetwork` (planet/rivers.ts)
 * traces the flow-accumulation field into source→mouth polylines, the same way
 * planet/routes.ts traces roads. This module RENDERS that into the flight scene,
 * mirroring trade-roads.ts's FAR layer: each river is one terrain-draped ribbon,
 * conformed to the carved valley floor (surface.heightAt), its width TAPERING
 * from a thread at the source to a band at the mouth (√accumulation — a
 * watercourse's section grows with the root of its discharge).
 *
 * Reads the BASE substrate surface, because that is the only terrain the flight
 * renderer draws (refined regions never build a mesh). Render-only, no
 * simulation — the sibling of trade-roads, pointed at water instead of roads.
 *
 * SEIZURE SAFETY: the water is DULL and STATIC — high roughness, zero metalness,
 * no envMap, no animation. A static blue ribbon has no moving specular to
 * strobe (the hazard the terrain water shader guards against with WATER_SAFETY);
 * if a flowing look is wanted later it must go through that same clamped path.
 */
import * as THREE from "three";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { extractRiverNetwork, type RiverPolyline } from "@shared/world-engine/planet/rivers";
import { litMaterial } from "@shared/world-engine/materials";

// ── Tunables (life-size metres; glyph-exaggerated for orbit legibility, the
//    way roads' FAR ribbons are — tune against a real fly-over). ─────────────
const RIVER_MIN_ACCUM = 16; // draw watercourses above this (travel.ts's line)
/** Half-width at the minimum accumulation, in metres. */
const RIVER_W_BASE = 120;
const RIVER_W_MIN = 80;
const RIVER_W_MAX = 1200;
/** Centerline resample step. Rivers follow valley floors (monotone descent),
 *  so a straight segment rides just ABOVE the floor mid-span, never clipping —
 *  a coarse step is safe and cheap. */
const RIVER_SEG_M = 1500;
/** Small lift off the valley floor to beat z-fighting; rivers sit at the LOW
 *  point, so unlike roads they need no ridge-clearance margin. */
const RIVER_LIFT_M = 8;
/** Water blue. Saturated so it reads as water over green land from orbit. */
const RIVER_COLOR = 0x2f6fa8;

const halfWidthOf = (accum: number): number =>
  Math.max(RIVER_W_MIN, Math.min(RIVER_W_MAX, RIVER_W_BASE * Math.sqrt(accum / RIVER_MIN_ACCUM)));

export interface RiverRibbons {
  /** Kept for parity with the road net's drive signature; rivers are static
   *  and visible at every altitude, so this is a no-op today. */
  update(playerWorld: THREE.Vector3): void;
  dispose(): void;
  stats(): { rivers: number; verts: number };
}

/** Arc position → planet-local surface point, draped onto the terrain. Doubles
 *  throughout; the caller subtracts its own center before Float32 storage. */
function samplePos(
  river: RiverPolyline, s: number, radius: number,
  heightAt: (dir: [number, number, number]) => number, out: THREE.Vector3,
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
  return out.multiplyScalar(radius + h + RIVER_LIFT_M);
}

/** One tapered, terrain-draped ribbon for a river, vertices relative to
 *  `center`. Half-width ramps from the source accumulation to the mouth's. */
function buildRiverRibbon(
  river: RiverPolyline, radius: number,
  heightAt: (dir: [number, number, number]) => number,
  center: THREE.Vector3, pos: number[], nrm: number[], idx: number[],
): void {
  const len = river.route.lengthM;
  const steps = Math.max(1, Math.ceil(len / RIVER_SEG_M));
  const w0 = halfWidthOf(river.accumSource);
  const w1 = halfWidthOf(river.accumMouth);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) pts.push(samplePos(river, (len * i) / steps, radius, heightAt, new THREE.Vector3()));

  const base = pos.length / 3;
  const tan = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const halfW = w0 + (w1 - w0) * (i / steps); // narrow source → wide mouth
    tan.copy(pts[Math.min(i + 1, pts.length - 1)]!).sub(pts[Math.max(i - 1, 0)]!);
    up.copy(p).normalize();
    side.crossVectors(up, tan);
    const l = side.length();
    if (l < 1e-9) side.set(1, 0, 0); else side.divideScalar(l);
    pos.push(
      p.x + side.x * halfW - center.x, p.y + side.y * halfW - center.y, p.z + side.z * halfW - center.z,
      p.x - side.x * halfW - center.x, p.y - side.y * halfW - center.y, p.z - side.z * halfW - center.z,
    );
    nrm.push(up.x, up.y, up.z, up.x, up.y, up.z);
    if (i + 1 < pts.length) {
      const v = base + i * 2;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
}

export function createRiverRibbons(body: CelestialBody): RiverRibbons | null {
  const built = body.geography;
  if (!built) return null;
  const rivers = extractRiverNetwork(built, { minAccum: RIVER_MIN_ACCUM });
  if (!rivers.length) return null;

  const radius = body.radius;
  const heightAt = (dir: [number, number, number]): number => built.surface.heightAt(dir);
  const material = litMaterial({ color: RIVER_COLOR, roughness: 0.7, metalness: 0.0 });
  material.side = THREE.DoubleSide;

  const root = new THREE.Group();
  root.name = "rivers";
  body.group.add(root);

  const mid = new THREE.Vector3();
  let verts = 0;
  for (const river of rivers) {
    // Per-river mesh, centered on the river's midpoint: planet-local Float32 at
    // a real radius quantizes to ~0.5 m, so a globe-spanning single mesh would
    // ripple. Center-relative vertices keep the river crisp (the roads lesson).
    samplePos(river, river.route.lengthM / 2, radius, heightAt, mid);
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
    buildRiverRibbon(river, radius, heightAt, mid, pos, nrm, idx);
    if (!idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(mid);
    // A river's span defeats sphere frustum culling (its bounding sphere can
    // dwarf the view), the same reason the FAR road ribbons opt out.
    mesh.frustumCulled = false;
    root.add(mesh);
    verts += pos.length / 3;
  }

  return {
    update() { /* static + always visible; parity with the road net's drive */ },
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
