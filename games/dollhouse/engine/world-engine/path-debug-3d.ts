/**
 * PATH DEBUG OVERLAY — draw what every hosted NPC is steering at, right now.
 *
 * A `SceneOverlay` (render3d) that reads WorldHost.npcPaths() each frame and
 * paints, per body:
 *
 *   • CYAN   the errand PLAN — the door-routed waypoint polyline still to walk,
 *            body → live waypoint → each remaining point. Small ticks mark the
 *            waypoints themselves. This is the route the body INTENDS.
 *   • YELLOW the live leg: body → the waypoint it is walking to now.
 *   • RED    the DETOUR — body → the detour-bent aim locomotion actually steers
 *            at, drawn only when it differs from the plan's waypoint.
 *   • GREY   a body with no errand at all (wandering/idle): body → wander aim.
 *
 *  Reading it: yellow and red agreeing means the body walks straight at its
 *  waypoint. A red line swinging wildly while the cyan plan sits still is the
 *  detour thrashing — the body is bouncing off something the planner can't see.
 *  A plan whose next hop crosses a wall means doorRouteErrand mis-routed.
 *
 * Lines sit slightly off the floor (PATH_Y) to clear the ground plane, and are
 * drawn depth-test-free so furniture/walls can't hide them — a debug tool you
 * have to hunt for is useless.
 *
 * Everything is preallocated: ONE LineSegments with a fixed-capacity buffer,
 * rewritten in place each frame. No per-frame allocation, no churn — this runs
 * inside the render loop while a town hosts hundreds of bodies.
 */
import * as THREE from "three";
import type { SceneOverlay } from "./render3d.js";
import type { NpcPathSnapshot } from "./world-host.js";
import { FLOOR_HEIGHT } from "./render3d.js";

/** Height above the floor the lines are drawn at (clears the ground/road ribbons). */
const PATH_Y = 0.08;
/** Half-size of the cross drawn at each waypoint. */
const TICK = 0.16;
/** Half-size of a FED MARKER's cross — deliberately much bigger than a
 *  waypoint tick, so the three answers to "where is the player pointing, where
 *  is the spark, where is this body actually going" read at a glance in a
 *  frame that may already be full of route lines. */
const MARK = 0.5;
/** Max line SEGMENTS the buffer holds. Each body costs ~(waypoints + 3); a few
 *  hundred live bodies fit comfortably, and the overflow is reported, never
 *  silently truncated (see `overflowed`). */
const MAX_SEGMENTS = 12000;

const COLOR_PLAN = new THREE.Color(0x38bdf8); // cyan — the intended route
const COLOR_LEG = new THREE.Color(0xfacc15); // yellow — the live leg
const COLOR_DETOUR = new THREE.Color(0xef4444); // red — the bent aim
const COLOR_IDLE = new THREE.Color(0x94a3b8); // grey — no errand
const COLOR_CURSOR = new THREE.Color(0xff3ff0); // magenta — the cursor's ground hit
const COLOR_SPARK = new THREE.Color(0xffffff); // white — the player's spark
const COLOR_GOAL = new THREE.Color(0x22c55e); // green — a pursuit's goal point

/** A point the HOST feeds in each frame (`setMarks`), in game coords. `floor`
 *  defaults to the ground storey when the feeder has no better answer.
 *  `groundY` is the TERRAIN lift under this exact point (render3d.ts's
 *  `standHeightAt`, sampled by the feeder) — separate from `floor`, which is
 *  only the building storey; on a flat-town session (no ground sampler) it is
 *  always 0, so the drawn geometry is unchanged. See R2, 2026-08-16. */
export interface PathDebugMark {
  x: number;
  y: number;
  floor?: number;
  groundY?: number;
}

/**
 * THE THREE POINTS THE ROUTE LINES CANNOT SHOW, fed from outside.
 *
 * `getPaths` answers "what is each body walking", which is a fact about the
 * LEG. It cannot answer the questions a stuck gesture actually raises: where
 * the player is pointing, where the spark that bodies chase currently sits, and
 * what GOAL a pursuit is ultimately steering at (the leg is only the current
 * hop of it). Those three come from the quest host's `debugSnapshot`, so the
 * lines and the lab readout are the same numbers.
 */
export interface PathDebugMarks {
  /** MAGENTA — the cursor's settled ground hit. */
  cursor: PathDebugMark | null;
  /** WHITE — the player's spark / spiritPos. Also the origin of the goal lines. */
  spark: PathDebugMark | null;
  /** GREEN — one per directable body with a live pursuit. */
  goals: readonly PathDebugMark[];
}

export interface PathDebugOverlayDeps {
  /** This frame's snapshots (WorldHost.npcPaths()). Empty when capture is off. */
  getPaths: () => readonly NpcPathSnapshot[];
  /** Terrain lift under a sim point (render3d's standHeightAt). Omit ⇒ flat
   *  datum, which is only correct in flat-floored towns — on terrain the
   *  routes must hug the ground the same way the fed marks do. */
  groundAt?: (x: number, y: number) => number;
}

export class PathDebugOverlay3D implements SceneOverlay {
  private readonly deps: PathDebugOverlayDeps;
  private readonly group = new THREE.Group();
  private readonly positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly colors = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial;
  private lines!: THREE.LineSegments;
  private enabled = false;
  private n = 0; // segments written this frame
  /** This frame's fed points (see PathDebugMarks). Null = nobody fed any. */
  private marks: PathDebugMarks | null = null;
  /** True while the last frame's paths didn't fit — surfaced, not swallowed. */
  overflowed = false;

  constructor(deps: PathDebugOverlayDeps) {
    this.deps = deps;
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geom.setDrawRange(0, 0);
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false, // never let a wall hide the diagnostic
    });
  }

  /** Show/hide the overlay. While off, update() does no work at all. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) {
      this.n = 0;
      this.marks = null; // never redraw a stale spark when the toggle comes back
      this.geom.setDrawRange(0, 0);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Feed this frame's cursor / spark / goal points. The host calls it once per
   *  frame while the overlay is on; passing null (or simply not calling it)
   *  draws routes only, exactly as before this existed. */
  setMarks(marks: PathDebugMarks | null): void {
    this.marks = marks;
  }

  mount(scene: THREE.Scene): void {
    this.lines = new THREE.LineSegments(this.geom, this.mat);
    this.lines.frustumCulled = false; // the buffer spans the whole town
    this.lines.renderOrder = 999; // with depthTest off, draw last
    this.group.add(this.lines);
    this.group.visible = this.enabled;
    scene.add(this.group);
  }

  update(_dt: number): void {
    if (!this.enabled) return;
    this.n = 0;
    this.overflowed = false;
    const g = this.deps.groundAt;
    for (const p of this.deps.getPaths()) {
      // Terrain lift per ENDPOINT, not per snapshot — a route crossing a
      // slope must hug it. Flat towns: groundAt yields 0 = the old datum.
      const yAt = (x: number, z: number) => p.floor * FLOOR_HEIGHT + (g?.(x, z) ?? 0) + PATH_Y;
      const errand = p.errand;
      if (errand) {
        const pts = errand.points;
        const live = pts[errand.index];
        // The live leg: where it is → the waypoint it's walking to.
        if (live) {
          this.seg(p.at.x, yAt(p.at.x, p.at.y), p.at.y, live.x, yAt(live.x, live.y), live.y, COLOR_LEG);
          this.tick(live.x, yAt(live.x, live.y), live.y, COLOR_LEG);
        }
        // The rest of the PLAN, waypoint to waypoint.
        for (let i = errand.index; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          this.seg(a.x, yAt(a.x, a.y), a.y, b.x, yAt(b.x, b.y), b.y, COLOR_PLAN);
          this.tick(b.x, yAt(b.x, b.y), b.y, COLOR_PLAN);
        }
      } else if (p.aim) {
        // No errand — a wander/idle aim. Dimmer: not a route, just a heading.
        this.seg(p.at.x, yAt(p.at.x, p.at.y), p.at.y, p.aim.x, yAt(p.aim.x, p.aim.y), p.aim.y, COLOR_IDLE);
      }
      // The DETOUR: what locomotion actually steers at, when the bend fired.
      if (p.detoured && p.bent) {
        this.seg(p.at.x, yAt(p.at.x, p.at.y), p.at.y, p.bent.x, yAt(p.bent.x, p.bent.y), p.bent.y, COLOR_DETOUR);
        this.tick(p.bent.x, yAt(p.bent.x, p.bent.y), p.bent.y, COLOR_DETOUR);
      }
    }
    this.drawMarks();
    this.geom.setDrawRange(0, this.n * 2);
    (this.geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.geom.computeBoundingSphere();
  }

  /** The fed points: cursor (magenta), spark (white), each pursuit goal (green),
   *  and a SPARK → GOAL line per goal — the line that makes "this body is
   *  chasing my cursor" and "this body is going somewhere of its own" tell
   *  themselves apart at a glance. */
  private drawMarks(): void {
    const m = this.marks;
    if (!m) return;
    const yOf = (p: PathDebugMark) => (p.floor ?? 0) * FLOOR_HEIGHT + (p.groundY ?? 0) + PATH_Y;
    if (m.cursor) this.mark(m.cursor.x, yOf(m.cursor), m.cursor.y, COLOR_CURSOR);
    for (const g of m.goals) {
      const gy = yOf(g);
      this.mark(g.x, gy, g.y, COLOR_GOAL);
      if (m.spark) this.seg(m.spark.x, yOf(m.spark), m.spark.y, g.x, gy, g.y, COLOR_GOAL);
    }
    // The spark LAST, so its white cross draws over the goal lines leaving it.
    if (m.spark) this.mark(m.spark.x, yOf(m.spark), m.spark.y, COLOR_SPARK);
  }

  /** A flat cross at a waypoint, so a point is visible even head-on. */
  private tick(x: number, y: number, z: number, c: THREE.Color): void {
    this.seg(x - TICK, y, z, x + TICK, y, z, c);
    this.seg(x, y, z - TICK, x, y, z + TICK, c);
  }

  /** A FED point: a big cross plus a diamond around it, so it stays legible on
   *  top of a mesh of route lines and reads as a different KIND of thing than a
   *  waypoint tick. */
  private mark(x: number, y: number, z: number, c: THREE.Color): void {
    this.seg(x - MARK, y, z, x + MARK, y, z, c);
    this.seg(x, y, z - MARK, x, y, z + MARK, c);
    this.seg(x - MARK, y, z, x, y, z - MARK, c);
    this.seg(x, y, z - MARK, x + MARK, y, z, c);
    this.seg(x + MARK, y, z, x, y, z + MARK, c);
    this.seg(x, y, z + MARK, x - MARK, y, z, c);
  }

  private seg(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    c: THREE.Color,
  ): void {
    if (this.n >= MAX_SEGMENTS) {
      this.overflowed = true;
      return;
    }
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
