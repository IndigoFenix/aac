/**
 * 3D town viewer — the canvas town drawing (grand-dream's city view /
 * town plan painter) ported to THREE: same TownPlan, same colors, same
 * shapes, drawn as geometry instead of fills. Plan-space (x, y) maps to
 * (x, z) with y up; the town center is the origin.
 *
 *   ground   → a disc in the plan's ground color
 *   fields   → flat cultivated patches
 *   streets  → thin ribbons along each street polyline (the organic tree)
 *   plaza    → a sand disc at the center
 *   houses   → boxes, `floors` storeys tall, the plan's house colors
 *   works    → boxes in each work type's registry color
 *
 * Pure view: everything here reads the plan; nothing writes it (the
 * renderer-parity law — the canvas map and this 3D view show the same
 * town because they stream the same model).
 */
import * as THREE from "three";
import type { TownPlan } from "@shared/engine/town/plan";

const STOREY_M = 3.2;
const STREET_W = 3.5;

export interface TownView {
  group: THREE.Group;
  /** Edge of the built-up area, meters — the orbit camera's scale. */
  radius: number;
  dispose(): void;
}

export function createTownView(plan: TownPlan): TownView {
  const group = new THREE.Group();
  group.name = `town_${plan.key}`;
  const disposables: Array<{ dispose(): void }> = [];
  const mat = (color: string | number, extra?: Partial<THREE.MeshStandardMaterialParameters>): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra });
    disposables.push(m);
    return m;
  };
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
    disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  };

  // Ground disc (a skirt beyond the built edge so the town sits on land).
  const ground = add(new THREE.CircleGeometry(plan.radius + 120, 64), mat(plan.groundColor));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;

  // Cultivated fields — slightly proud of the ground so they read.
  const fieldMat = mat("#7a9c4e");
  for (const f of plan.fields) {
    const m = add(new THREE.BoxGeometry(f.w, 0.15, f.h), fieldMat);
    m.position.set(f.dx + f.w / 2, 0.05, f.dy + f.h / 2);
  }

  // Streets: one thin ribbon per polyline segment.
  const streetMat = mat("#6e6659");
  for (const street of plan.streets.streets) {
    for (let i = 0; i + 1 < street.pts.length; i++) {
      const a = street.pts[i];
      const b = street.pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) continue;
      const m = add(new THREE.BoxGeometry(len + STREET_W * 0.5, 0.1, STREET_W), streetMat);
      m.position.set((a.x + b.x) / 2, 0.06, (a.y + b.y) / 2);
      m.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
    }
  }

  // Plaza disc on top of the street ring.
  const plaza = add(new THREE.CircleGeometry(plan.streets.plazaR, 48), mat("#c2b28a"));
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.12;

  // Houses — floors storeys tall, flat-roofed boxes (the canvas view's
  // footprints, extruded).
  for (const h of plan.houses) {
    const height = h.floors * STOREY_M;
    const m = add(new THREE.BoxGeometry(h.w, height, h.h), mat(h.color));
    m.position.set(h.dx + h.w / 2, height / 2, h.dy + h.h / 2);
  }

  // Works — halls, markets, and every economy building in its own color.
  for (const w of plan.works) {
    const height = STOREY_M * 1.4;
    const m = add(new THREE.BoxGeometry(w.w, height, w.h), mat(w.color));
    m.position.set(w.dx + w.w / 2, height / 2, w.dy + w.h / 2);
  }

  return {
    group,
    radius: plan.radius,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
