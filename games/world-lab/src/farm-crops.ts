// games/world-lab/src/farm-crops.ts
//
// LIVE CROPS OVER THE FIELD PAINT (depletion↔render bridge R1b, ruling Ⓐ).
// While a town is MOUNTED — the only time its farm record exists — the
// record drives a planted layer over the painted rects: how much stands
// sown vs mature (the stand's byClass), and how much of the field carries
// ripe crop (stock vs cap: a just-harvested field goes visibly bare-green
// and refills at the FIELD PULSE). Distant towns keep the ground paint
// alone — books canonical, bodies projections; the far LOD asserts no
// harvest state nobody's books quote.
//
// STRICTLY A RENDERER: reads `areaQuotes()` (the typed, serializable
// READ the host exposes — the multiplayer rider's shape), writes nothing,
// remembers no plants. Positions are dealt from `fieldRegion.seed` — the
// determinism handle the plan mints for exactly this consumer ("the
// renderer's determinism", wild-area.ts) — so the same record always
// plants the same field.

import * as THREE from "three";
import { farmAreaKey, type WildAreaQuote } from "@shared/world-engine/interaction/quest/wild-area";
import type { TownGround } from "./city-visuals";

/** Plants per m² the render aims for (a visual density, NOT the record's
 *  population — content dial), capped by MAX_PLANTS across the whole farm. */
const PLANTS_PER_M2 = 0.14;
const MAX_PLANTS = 4000;
/** Tuft geometry: a squat cone reads as a leafy crop at walking distance. */
const TUFT_R = 0.16, TUFT_H = 0.5;
/** Sown (class-0) plants render at this scale of a mature tuft. */
const SOWN_SCALE = 0.4;
const GREEN = new THREE.Color(0.22, 0.42, 0.16);
/** Ripe rows warm toward this — "ready to pull" without pretending fruit. */
const RIPE = new THREE.Color(0.45, 0.46, 0.12);

const mulberry = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface FarmCrops {
  /** Feed the latest quotes (~1 Hz is plenty); rebuilds only on change. */
  update(quotes: readonly WildAreaQuote[]): void;
  dispose(): void;
}

export function createFarmCrops(
  parent: THREE.Object3D,
  plan: {
    key: string;
    fields: ReadonlyArray<{ dx: number; dy: number; w: number; h: number }>;
    fieldRegion?: { seed: number };
  },
  ground: TownGround,
): FarmCrops {
  const key = farmAreaKey(plan.key);
  let mesh: THREE.InstancedMesh | null = null;
  let geom: THREE.ConeGeometry | null = null;
  let mat: THREE.MeshLambertMaterial | null = null;
  let lastStamp = "";

  // Deterministic plant sites, dealt ONCE per farm from the region seed —
  // the record decides how many are standing and how they look, never where.
  const sites: Array<{ x: number; z: number; jitter: number }> = [];
  {
    const rng = mulberry((plan.fieldRegion?.seed ?? 1) >>> 0);
    const areaTotal = plan.fields.reduce((a, f) => a + f.w * f.h, 0);
    const want = Math.min(MAX_PLANTS, Math.max(0, Math.round(areaTotal * PLANTS_PER_M2)));
    for (const f of plan.fields) {
      const share = areaTotal > 0 ? Math.round((want * f.w * f.h) / areaTotal) : 0;
      // Rows along the patch's long axis — a planted field, not a meadow.
      const alongW = f.w >= f.h;
      const rows = Math.max(1, Math.round(Math.sqrt(share * (alongW ? f.h / f.w : f.w / f.h))));
      const perRow = Math.max(1, Math.ceil(share / rows));
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < perRow; i++) {
          if (sites.length >= want) break;
          const a = (i + 0.5) / perRow;
          const b = (r + 0.5) / rows;
          const jx = (rng() - 0.5) * 0.35;
          const jz = (rng() - 0.5) * 0.35;
          sites.push({
            x: f.dx + (alongW ? a * f.w : b * f.w) + jx,
            z: f.dy + (alongW ? b * f.h : a * f.h) + jz,
            jitter: rng(),
          });
        }
      }
    }
  }

  const ensureMesh = (): THREE.InstancedMesh | null => {
    if (mesh || !sites.length) return mesh;
    geom = new THREE.ConeGeometry(TUFT_R, TUFT_H, 5);
    geom.translate(0, TUFT_H / 2, 0);
    mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    mesh = new THREE.InstancedMesh(geom, mat, sites.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  };

  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const col = new THREE.Color();

  return {
    update(quotes) {
      const quote = quotes.find((q) => q.key === key);
      const stand = quote?.stands[0];
      if (!stand) {
        // No record (town not stepping yet, or no farm): the paint alone.
        if (mesh) mesh.visible = false;
        return;
      }
      const total = stand.byClass.reduce((a, b) => a + b, 0);
      const sownFrac = total > 0 ? (stand.byClass[0] ?? 0) / total : 0;
      const matureFrac = stand.byClass.length > 1 ? 1 - sownFrac : 1;
      let stock = 0, cap = 0;
      for (const n of Object.values(stand.stock)) stock += n;
      for (const n of Object.values(stand.cap)) cap += n;
      const ripeFrac = cap > 0 ? stock / cap : 0;
      // Rebuild only when the visible summary moves (percent grain).
      const stamp = `${total}:${Math.round(sownFrac * 100)}:${Math.round(ripeFrac * 100)}`;
      const im = ensureMesh();
      if (!im) return;
      im.visible = total > 0;
      if (stamp === lastStamp || !im.visible) return;
      lastStamp = stamp;
      for (let i = 0; i < sites.length; i++) {
        const p = sites[i]!;
        // The i-th site's role is a pure function of the record: the first
        // sown-fraction of sites (by jitter order) are the young planting.
        const young = p.jitter < sownFrac;
        const ripe = !young && p.jitter > 1 - matureFrac * ripeFrac;
        const scale = young ? SOWN_SCALE : 0.85 + p.jitter * 0.3;
        v3.set(p.x, ground(p.x, p.z) + 0.02, p.z);
        s3.set(scale, scale, scale);
        m4.compose(v3, q0, s3);
        im.setMatrixAt(i, m4);
        col.copy(ripe ? RIPE : GREEN);
        if (young) col.multiplyScalar(1.15); // fresh shoots read lighter
        im.setColorAt(i, col);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    },

    dispose() {
      if (mesh) {
        mesh.parent?.remove(mesh);
        mesh.dispose();
        mesh = null;
      }
      geom?.dispose();
      mat?.dispose();
      geom = null;
      mat = null;
    },
  };
}
