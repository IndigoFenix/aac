// shared/world-engine/interaction/quest/zone-overlay-3d.ts
//
// AREA CHARTERS ON THE GROUND (city-expansion ③): the render half of the
// zoning surface — board words must VISIBLY change the world, so a spoken
// "area farms here" tints the chartered ground the moment the charter
// lands. A SceneOverlay (render3d) riding the quest host's composed
// overlay slot, exactly like the goal-tree layer and the path debugger.
//
// Kept deliberately simple: ONE flat translucent plane over the charters'
// bounding box, textured from a canvas where each charter disc is painted
// in ord order — so the LATEST charter visibly wins where discs overlap
// and a CLEARING charter (category null) honestly ERASES the tint under
// it (destination-out), the exact semantics of zoning.ts zoneAt. Colors
// are a deterministic hash of the category string, so the same category
// wears the same tint in every session and every peer.
//
// Render-only by design: the overlay READS the charter list through a
// getter each frame and re-paints only when the deltas version moves —
// no zoning mechanics live here.

import * as THREE from "three";
import type { SceneOverlay } from "../../render3d.js";
import type { ZoneCharter } from "../../kernel/town/zoning.js";

/** What the overlay draws — pulled once per frame. Null = no zone surface
 *  in this session (no town, no founded site): the overlay idles empty. */
export interface ZoneOverlayView {
  /** Charters in ord order (TownDeltas.zones()). */
  zones: readonly ZoneCharter[];
  /** World point the charters' town-local coordinates hang off. */
  center: { x: number; y: number };
  /** The deltas store version — the repaint key (bumped by addZone). */
  version: number;
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
    // Bounding box of every charter disc (town-local), padded a touch.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const z of view.zones) {
      x0 = Math.min(x0, z.x - z.r);
      y0 = Math.min(y0, z.y - z.r);
      x1 = Math.max(x1, z.x + z.r);
      y1 = Math.max(y1, z.y + z.r);
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
    // Paint charters in ORD ORDER — the later disc covers the earlier one
    // (the zoneAt overlap rule, visibly). A clearing charter erases.
    for (const z of view.zones) {
      const cx = (z.x - x0) * scale;
      const cy = (z.y - y0) * scale;
      const cr = z.r * scale;
      if (z.category === null) {
        g.globalCompositeOperation = "destination-out";
        g.fillStyle = "rgba(0,0,0,1)";
        g.beginPath();
        g.arc(cx, cy, cr, 0, Math.PI * 2);
        g.fill();
        g.globalCompositeOperation = "source-over";
        continue;
      }
      const color = zoneCategoryColor(z.category);
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
