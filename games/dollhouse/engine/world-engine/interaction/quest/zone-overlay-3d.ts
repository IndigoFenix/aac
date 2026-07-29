// shared/world-engine/interaction/quest/zone-overlay-3d.ts
//
// "SHOW AREAS" (city-founding areas): the TOGGLEABLE map-reading overlay —
// never persistent world texture (areas otherwise show only through their
// consequences). The host's getView returns null while the toggle is off;
// on, the named units tint: district ground (legacy discs, with "over"
// repaints resolved through the charter chain) as translucent washes, and
// town-wide preferences as boundary rings at the town's radius. A
// SceneOverlay (render3d) riding the quest host's composed overlay slot,
// exactly like the goal-tree layer and the path debugger.
//
// Kept deliberately simple: ONE flat translucent plane over the shapes'
// bounding box, textured from a canvas where each disc is painted in ord
// order — so the LATEST designation visibly wins where discs overlap and
// a CLEARING row honestly ERASES the tint under it (destination-out), the
// exact semantics of zoning.ts zoneAt. Colors are a deterministic hash of
// the category string, so the same category wears the same tint in every
// session and every peer. Static matte paint — never bright or moving.
//
// Render-only by design: the overlay READS the charter list through a
// getter each frame and re-paints only when the deltas version moves —
// no zoning mechanics live here.

import * as THREE from "three";
import type { SceneOverlay } from "../../render3d.js";
import { townPreferredCategories, type ZoneCharter } from "../../kernel/town/zoning.js";

/** What the overlay draws — pulled once per frame. Null = the toggle is
 *  off, or no zone surface in this session: the overlay idles empty. */
export interface ZoneOverlayView {
  /** Charters in ord order (TownDeltas.zones()). */
  zones: readonly ZoneCharter[];
  /** World point the charters' town-local coordinates hang off. */
  center: { x: number; y: number };
  /** The deltas store version — the repaint key (bumped by addZone). */
  version: number;
  /** The town's radius — town-wide preference rings draw just past it. */
  radius: number;
}

export interface ZoneOverlayDeps {
  getView: () => ZoneOverlayView | null;
  /** Terrain height at a world (x, y) — the plane sits just above the
   *  ground at the charters' center. Omit = flat ground (y = 0). */
  groundAt?: (x: number, y: number) => number;
}

/** Ground-tint alpha of a chartered disc (subtle — a wash, not paint). */
const ZONE_ALPHA = 0.30;
/** A slightly stronger rim so the brush edge reads. */
const RIM_ALPHA = 0.55;
const RIM_WIDTH_M = 0.6;
/** Canvas pixels per world meter (texture resolution). */
const PX_PER_M = 3;
const MAX_TEX = 1024;
/** The plane floats this far above the ground (z-fight clearance under
 *  roads' 0.02 lift is 0.05 — stay just above the road ribbons). */
const LIFT = 0.06;

/** Deterministic category → tint. Same word, same color, every peer. */
export function zoneCategoryColor(category: string): { h: number; s: number; l: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < category.length; i++) {
    h ^= category.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return { h: (h >>> 0) % 360, s: 62, l: 52 };
}

const cssColor = (c: { h: number; s: number; l: number }, a: number): string =>
  `hsla(${c.h}, ${c.s}%, ${c.l}%, ${a})`;

export class ZoneOverlay3D implements SceneOverlay {
  private readonly deps: ZoneOverlayDeps;
  private readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private paintedVersion = -1;
  private paintedCount = -1;

  constructor(deps: ZoneOverlayDeps) {
    this.deps = deps;
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(): void {
    const view = this.deps.getView();
    if (!view || view.zones.length === 0) {
      if (this.paintedCount !== 0) this.clearMesh();
      this.paintedCount = 0;
      return;
    }
    if (view.version === this.paintedVersion && view.zones.length === this.paintedCount) return;
    this.paintedVersion = view.version;
    this.paintedCount = view.zones.length;
    this.repaint(view);
  }

  dispose(): void {
    this.clearMesh();
    this.group.parent?.remove(this.group);
  }

  private clearMesh(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material?.dispose();
    this.material = null;
    this.texture?.dispose();
    this.texture = null;
  }

  private repaint(view: ZoneOverlayView): void {
    // "over" rows repaint an EXISTING district by reference (nations §3c —
    // no geometry of their own): resolve each disc's EFFECTIVE category
    // through the chain, then paint discs only.
    const eff = new Map<number, string | null>(); // root disc ord → live category
    const rootOf = new Map<number, number>(); // any row ord → its root disc
    for (const z of view.zones) {
      const shape = z.shape ?? "disc";
      if (shape === "disc") {
        eff.set(z.ord, z.category);
        rootOf.set(z.ord, z.ord);
      } else if (shape === "over" && z.of !== undefined) {
        const r = rootOf.get(z.of);
        if (r !== undefined) {
          eff.set(r, z.category);
          rootOf.set(z.ord, r);
        }
      }
    }
    const discs = view.zones.filter((z) => (z.shape ?? "disc") === "disc");
    // Town-wide preferences draw as boundary rings just past the radius.
    const prefs = [...townPreferredCategories(view.zones)];
    const RING_GAP = 4;
    const maxRingR = prefs.length ? view.radius + 6 + RING_GAP * (prefs.length - 1) + 2 : 0;

    // Bounding box of every drawn shape (town-local), padded a touch.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const z of discs) {
      x0 = Math.min(x0, z.x - z.r);
      y0 = Math.min(y0, z.y - z.r);
      x1 = Math.max(x1, z.x + z.r);
      y1 = Math.max(y1, z.y + z.r);
    }
    if (prefs.length) {
      x0 = Math.min(x0, -maxRingR);
      y0 = Math.min(y0, -maxRingR);
      x1 = Math.max(x1, maxRingR);
      y1 = Math.max(y1, maxRingR);
    }
    if (x0 === Infinity) {
      this.clearMesh();
      return; // only shape rows with nothing to draw (e.g. cleared prefs)
    }
    const pad = 2;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const scale = Math.min(PX_PER_M, MAX_TEX / Math.max(w, h));
    const pw = Math.max(8, Math.round(w * scale));
    const ph = Math.max(8, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    const g = canvas.getContext("2d");
    if (!g) return;
    // Paint discs in ORD ORDER — the later disc covers the earlier one
    // (the zoneAt overlap rule, visibly). An erased/cleared disc erases.
    for (const z of discs) {
      const cx = (z.x - x0) * scale;
      const cy = (z.y - y0) * scale;
      const cr = z.r * scale;
      const category = eff.get(z.ord) ?? null;
      if (category === null) {
        g.globalCompositeOperation = "destination-out";
        g.fillStyle = "rgba(0,0,0,1)";
        g.beginPath();
        g.arc(cx, cy, cr, 0, Math.PI * 2);
        g.fill();
        g.globalCompositeOperation = "source-over";
        continue;
      }
      const color = zoneCategoryColor(category);
      // Later wins: clear this disc's ground first so an overlapping older
      // tint never blends through, then lay the fill + rim.
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = "rgba(0,0,0,1)";
      g.beginPath();
      g.arc(cx, cy, cr, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = "source-over";
      g.fillStyle = cssColor(color, ZONE_ALPHA);
      g.beginPath();
      g.arc(cx, cy, cr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = cssColor(color, RIM_ALPHA);
      g.lineWidth = Math.max(1, RIM_WIDTH_M * scale);
      g.beginPath();
      g.arc(cx, cy, Math.max(1, cr - g.lineWidth / 2), 0, Math.PI * 2);
      g.stroke();
    }
    // Preference rings: one per category, staggered outward from the town
    // radius (the town's own extent is the unit — a boundary, not a fill).
    prefs.forEach((cat, i) => {
      const color = zoneCategoryColor(cat);
      const rr = (view.radius + 6 + RING_GAP * i) * scale;
      g.strokeStyle = cssColor(color, RIM_ALPHA);
      g.lineWidth = Math.max(1, 1.6 * scale);
      g.beginPath();
      g.arc((0 - x0) * scale, (0 - y0) * scale, Math.max(1, rr), 0, Math.PI * 2);
      g.stroke();
    });

    this.clearMesh();
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.rotation.x = -Math.PI / 2;
    const wx = view.center.x + (x0 + x1) / 2;
    const wy = view.center.y + (y0 + y1) / 2;
    const ground = this.deps.groundAt?.(wx, wy) ?? 0;
    mesh.position.set(wx, ground + LIFT, wy);
    mesh.renderOrder = 1; // over the ground + road ribbons, under everything solid
    this.mesh = mesh;
    this.group.add(mesh);
  }
}
