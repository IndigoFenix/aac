/**
 * ATTENTION DEBUG OVERLAY — make the soft-control attention field VISIBLE, so a
 * playtester can see whether a creature is registering the player's attention at
 * all, and how close that attention is to triggering an action.
 *
 * A `SceneOverlay` (render3d) riding the SAME toggle as the path debug (world-lab
 * "paths" button → setPathDebug). Per attention link it paints:
 *
 *   • an ENGAGEMENT RING around the creature — a progress arc whose filled
 *     fraction is how much attention the player has ON that creature (0 = none,
 *     full ring = fully engaged). This answers "is it registering me at all?"
 *   • a DOTTED LINE from the creature to the thing it's being drawn to. The
 *     dashes pack CLOSER TOGETHER the nearer the creature is to being TRIGGERED
 *     (the need about to fire) — sparse dashes = barely moved, dense = about to
 *     act, solid-bright + a cross at the target = triggered.
 *
 * Lines sit just off the floor and draw depth-test-free (a debug tool must not
 * hide behind furniture). One preallocated LineSegments buffer, rewritten in
 * place each frame — no per-frame allocation.
 */
import * as THREE from "three";
import type { SceneOverlay } from "./render3d.js";
import { FLOOR_HEIGHT } from "./render3d.js";

/** One creature's attention state, this frame. */
export interface AttentionDebugLink {
  /** The engaged creature's body. */
  from: { x: number; y: number; floor: number };
  /** The object/point its attention is drawn to, or null (engaged, no target). */
  to: { x: number; y: number } | null;
  /** 0..1 — how much attention the player has ON this creature (the ring). */
  engagement: number;
  /** 0..1 — how close the attention effect is to firing (the dash density). */
  trigger: number;
}

const PATH_Y = 0.09; // a hair above the path-debug lines
const RING_RADIUS = 0.55;
const RING_SEGS = 28; // ring resolution (also the engagement granularity)
const TICK = 0.18; // half-size of the "triggered" cross at the target
const DASH_PERIOD_FAR = 0.7; // world-unit gap between dashes at trigger 0
const DASH_PERIOD_NEAR = 0.16; // …and at trigger 1 (dashes pack in)
const DASH_FILL = 0.55; // fraction of each period that is drawn
const MAX_SEGMENTS = 4000; // a handful of links — plenty

const COLOR_RING = new THREE.Color(0xc084fc); // violet — "the player's attention"
const COLOR_COOL = new THREE.Color(0x38bdf8); // cyan — attention landing, far from firing
const COLOR_HOT = new THREE.Color(0xf97316); // orange — about to trigger
const COLOR_FIRED = new THREE.Color(0x22c55e); // green — triggered

export interface AttentionDebugOverlayDeps {
  /** This frame's links. Empty when the overlay is off. */
  getLinks: () => readonly AttentionDebugLink[];
}

export class AttentionDebugOverlay3D implements SceneOverlay {
  private readonly deps: AttentionDebugOverlayDeps;
  private readonly group = new THREE.Group();
  private readonly positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly colors = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial;
  private lines!: THREE.LineSegments;
  private enabled = false;
  private n = 0;

  constructor(deps: AttentionDebugOverlayDeps) {
    this.deps = deps;
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geom.setDrawRange(0, 0);
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) {
      this.n = 0;
      this.geom.setDrawRange(0, 0);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  mount(scene: THREE.Scene): void {
    this.lines = new THREE.LineSegments(this.geom, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1000; // above the path debug
    this.group.add(this.lines);
    this.group.visible = this.enabled;
    scene.add(this.group);
  }

  update(_dt: number): void {
    if (!this.enabled) return;
    this.n = 0;
    for (const link of this.deps.getLinks()) {
      const y = link.from.floor * FLOOR_HEIGHT + PATH_Y;
      this.ring(link.from.x, y, link.from.y, link.engagement);
      if (link.to) this.dashed(link.from.x, y, link.from.y, link.to.x, link.to.y, link.trigger);
    }
    this.geom.setDrawRange(0, this.n * 2);
    (this.geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.geom.computeBoundingSphere();
  }

  /** The engagement progress ring: a fraction `frac` of a circle at the creature. */
  private ring(cx: number, y: number, cz: number, frac: number): void {
    const filled = Math.round(Math.max(0, Math.min(1, frac)) * RING_SEGS);
    for (let i = 0; i < filled; i++) {
      const a0 = (i / RING_SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SEGS) * Math.PI * 2;
      this.seg(
        cx + Math.cos(a0) * RING_RADIUS, y, cz + Math.sin(a0) * RING_RADIUS,
        cx + Math.cos(a1) * RING_RADIUS, y, cz + Math.sin(a1) * RING_RADIUS,
        COLOR_RING,
      );
    }
  }

  /** The dotted attention line: dashes whose period shrinks as `trigger` → 1. */
  private dashed(x1: number, y: number, z1: number, x2: number, z2: number, trigger: number): void {
    const t = Math.max(0, Math.min(1, trigger));
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const ux = dx / len;
    const uz = dz / len;
    // Colour warms from cyan → orange with trigger, then flips green once fired.
    const col = t >= 1 ? COLOR_FIRED : COLOR_COOL.clone().lerp(COLOR_HOT, t);
    const period = DASH_PERIOD_FAR + (DASH_PERIOD_NEAR - DASH_PERIOD_FAR) * t;
    const dash = period * DASH_FILL;
    // Skip the ring radius at the creature end so the line starts outside it.
    for (let s = RING_RADIUS; s < len; s += period) {
      const e = Math.min(s + dash, len);
      this.seg(x1 + ux * s, y, z1 + uz * s, x1 + ux * e, y, z1 + uz * e, col);
    }
    if (t >= 1) this.tick(x2, y, z2, COLOR_FIRED); // a cross marks the triggered target
  }

  private tick(x: number, y: number, z: number, c: THREE.Color): void {
    this.seg(x - TICK, y, z, x + TICK, y, z, c);
    this.seg(x, y, z - TICK, x, y, z + TICK, c);
  }

  private seg(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    c: THREE.Color,
  ): void {
    if (this.n >= MAX_SEGMENTS) return;
    const i = this.n * 6;
    this.positions[i] = x1; this.positions[i + 1] = y1; this.positions[i + 2] = z1;
    this.positions[i + 3] = x2; this.positions[i + 4] = y2; this.positions[i + 5] = z2;
    this.colors[i] = c.r; this.colors[i + 1] = c.g; this.colors[i + 2] = c.b;
    this.colors[i + 3] = c.r; this.colors[i + 4] = c.g; this.colors[i + 5] = c.b;
    this.n++;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.geom.dispose();
    this.mat.dispose();
  }
}
