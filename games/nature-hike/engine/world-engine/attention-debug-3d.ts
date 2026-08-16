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

/**
 * ONE DIRECTABLE BODY'S REACH, this frame. The direct gesture has two distances
 * that decide everything and are invisible in play: below `minM` it is already
 * there and will not re-path (the no-jitter floor), beyond `maxM` the order is
 * out of scope and refused. A body that "ignores" the spark is nearly always
 * standing on the wrong side of one of them, so the rings answer it directly.
 */
export interface AttentionDebugBody {
  /** `groundY` is the TERRAIN lift under this body (render3d.ts's
   *  `standHeightAt`, sampled by the feeder) — separate from `floor`, which
   *  is only the building storey; 0 on a flat-town session (no ground
   *  sampler), so the range rings/hold arc render unchanged. See R2,
   *  2026-08-16. */
  at: { x: number; y: number; floor: number; groundY?: number };
  /** DIRECT_MIN_M — inside this the body is already there. */
  minM: number;
  /** directMaxM — the scope-derived ceiling on a directed move. */
  maxM: number;
  /** 0..1 of the ENGAGEMENT HOLD still to run (holdRemainS / ENGAGE_DIRECT_HOLD_S),
   *  or null on a body that is not the engaged one. Drawn as a countdown arc:
   *  while it has any length, a board press still lands on THIS body. */
  hold: number | null;
}

const PATH_Y = 0.09; // a hair above the path-debug lines
const RING_RADIUS = 0.55;
const RING_SEGS = 28; // ring resolution (also the engagement granularity)
/** Radius of the engagement-hold countdown arc — just outside the engagement
 *  ring, so the two read as one dial rather than overlapping. */
const HOLD_RADIUS = 0.78;
/** Range rings are metres wide, not centimetres: their resolution scales with
 *  radius (a 26 m circle at 28 segments is a visible polygon), clamped so a
 *  tight one stays cheap and a wide one stays round. */
const RANGE_SEGS_PER_M = 5;
const RANGE_SEGS_MIN = 24;
const RANGE_SEGS_MAX = 120;
const TICK = 0.18; // half-size of the "triggered" cross at the target
const DASH_PERIOD_FAR = 0.7; // world-unit gap between dashes at trigger 0
const DASH_PERIOD_NEAR = 0.16; // …and at trigger 1 (dashes pack in)
const DASH_FILL = 0.55; // fraction of each period that is drawn
/** A handful of links, plus two RANGE RINGS per directable body — and a wide
 *  ring costs up to RANGE_SEGS_MAX on its own, so the headroom is no longer the
 *  rounding it used to be. Ten bodies of rings + their links sit around 3k. */
const MAX_SEGMENTS = 8000;

const COLOR_RING = new THREE.Color(0xc084fc); // violet — "the player's attention"
const COLOR_COOL = new THREE.Color(0x38bdf8); // cyan — attention landing, far from firing
const COLOR_HOT = new THREE.Color(0xf97316); // orange — about to trigger
const COLOR_FIRED = new THREE.Color(0x22c55e); // green — triggered
const COLOR_MIN = new THREE.Color(0x475569); // slate — DIRECT_MIN_M, the no-jitter floor
const COLOR_MAX = new THREE.Color(0x1e40af); // deep blue — directMaxM, the scope ceiling
const COLOR_HOLD = new THREE.Color(0xfbbf24); // amber — the engagement hold running out

export interface AttentionDebugOverlayDeps {
  /** This frame's links. Empty when the overlay is off. */
  getLinks: () => readonly AttentionDebugLink[];
  /** Terrain lift under a sim point (render3d's standHeightAt). Omit ⇒ flat
   *  datum — the link rings/dashes float on terrain without it. */
  groundAt?: (x: number, y: number) => number;
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
  /** This frame's directable bodies (see AttentionDebugBody), fed by the host. */
  private bodies: readonly AttentionDebugBody[] = [];

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
      this.bodies = []; // don't redraw a stale roster when the toggle comes back
      this.geom.setDrawRange(0, 0);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Feed this frame's directable bodies. The host calls it once per frame
   *  while the overlay is on; leaving it unfed draws links only, exactly as
   *  before the range rings existed. */
  setBodies(bodies: readonly AttentionDebugBody[]): void {
    this.bodies = bodies;
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
    // RANGE RINGS FIRST, under the attention dial: they are the standing
    // geometry of the gesture, and the engagement ring is the live reading on
    // top of it.
    for (const b of this.bodies) {
      const y = b.at.floor * FLOOR_HEIGHT + (b.at.groundY ?? 0) + PATH_Y;
      this.rangeRing(b.at.x, y, b.at.y, b.minM, COLOR_MIN);
      this.rangeRing(b.at.x, y, b.at.y, b.maxM, COLOR_MAX);
      if (b.hold !== null && b.hold > 0) {
        this.ring(b.at.x, y, b.at.y, b.hold, HOLD_RADIUS, COLOR_HOLD);
      }
    }
    for (const link of this.deps.getLinks()) {
      // Grounded at the FROM body (dashes are short proximity links — the
      // from-endpoint's lift is close enough for debug chrome on a slope).
      const y = link.from.floor * FLOOR_HEIGHT + (this.deps.groundAt?.(link.from.x, link.from.y) ?? 0) + PATH_Y;
      this.ring(link.from.x, y, link.from.y, link.engagement);
      if (link.to) this.dashed(link.from.x, y, link.from.y, link.to.x, link.to.y, link.trigger);
    }
    this.geom.setDrawRange(0, this.n * 2);
    (this.geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.geom.computeBoundingSphere();
  }

  /** A progress ring: a fraction `frac` of a circle at the creature. Defaults
   *  to the ENGAGEMENT dial (violet, at the body's own radius); the countdown
   *  arc passes its own radius and colour through the same primitive so the two
   *  are drawn by one piece of code and can never drift apart. */
  private ring(
    cx: number, y: number, cz: number, frac: number,
    radius: number = RING_RADIUS, color: THREE.Color = COLOR_RING,
  ): void {
    const filled = Math.round(Math.max(0, Math.min(1, frac)) * RING_SEGS);
    for (let i = 0; i < filled; i++) {
      const a0 = (i / RING_SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SEGS) * Math.PI * 2;
      this.seg(
        cx + Math.cos(a0) * radius, y, cz + Math.sin(a0) * radius,
        cx + Math.cos(a1) * radius, y, cz + Math.sin(a1) * radius,
        color,
      );
    }
  }

  /** A closed RANGE circle (a distance, not a progress) — resolution scales
   *  with the radius so a 26 m ceiling doesn't read as a hexagon. */
  private rangeRing(cx: number, y: number, cz: number, radius: number, color: THREE.Color): void {
    if (!(radius > 0)) return;
    const segs = Math.max(
      RANGE_SEGS_MIN,
      Math.min(RANGE_SEGS_MAX, Math.round(radius * RANGE_SEGS_PER_M)),
    );
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      this.seg(
        cx + Math.cos(a0) * radius, y, cz + Math.sin(a0) * radius,
        cx + Math.cos(a1) * radius, y, cz + Math.sin(a1) * radius,
        color,
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
