// shared/world-engine/npc-controller.ts
//
// The STEERING brain for an AI-driven NPC — its body, not its mind. Given the
// world around it each frame, a controller returns a single steering AIM (a world
// point to move toward, or null to coast to a stop). The world-host feeds that aim
// to engine.steerAvatar, which uses the exact same locomotion as a player avatar —
// so an NPC moves like a person and can never diverge the sim.
//
// The MIND (what the NPC says, via the social-trainer DirectedSession) lands in
// Phase 2; this module exposes a `setEngagement` seam so a live conversation can
// bias the body (lean in when engaged, drift off when withdrawn) without the
// controller knowing anything about language.
//
// Behaviors are deliberately tiny and parameter-free beyond the spec: the value of
// an NPC here is presence + plausible motion, not pathfinding.

import { WORLD_ENGINE_DEFAULTS, type AvatarState } from "./engine.js";
import type { NpcMovement, NpcSpec, Vec2 } from "./types.js";

/** Everything a controller needs to decide where to move this frame. */
export interface NpcControlCtx {
  /** The NPC's own current avatar state. */
  self: AvatarState;
  /** Every NON-NPC avatar (the local player + remote peers) — the NPC's "people". */
  humans: AvatarState[];
  /** Sim time in seconds (state.time) — monotonic; drives wander pacing. */
  now: number;
  /** Manifold extent, so wander waypoints stay in bounds. */
  width: number;
  height: number;
  /**
   * False when the manifold is unbounded (a planet-mounted session): the
   * extent then describes content, not walls, and waypoints must NOT be
   * clamped to it — roam range is the behavioral tether (home + wanderRadius)
   * alone. Defaults to true (bounded) when absent.
   */
  bounded?: boolean;
  /** Injected RNG (deterministic in tests; Math.random in the app). */
  rng: () => number;
  /**
   * Optional walkability oracle (the host passes the same composed constraint
   * locomotion moves under). Wander waypoints are rejected when blocked, so an
   * NPC stops AIMING into buildings instead of merely bouncing off their walls.
   */
  walkable?: (p: Vec2, radius: number) => boolean;
  /**
   * The mover's COLLISION radius (its config's avatarRadius). Planner probes
   * must test walkability at the SAME radius locomotion collides at: the
   * furniture solver certifies indoor service lanes at exactly the body's
   * radius, so a fatter probe reads a perfectly passable lane as a wall — the
   * planner then fights a body that fits (the round-7 doorway/table shake).
   */
  radius?: number;
  /**
   * THE CROWDING ORACLE — is `p` too close to ANOTHER body for a body of
   * `radius` to stand there? (true = occupied.) The host builds it over the
   * live avatars, excluding this NPC, at the combined-radii separation
   * (`bodyR + otherR` — scales with body size, never a magic constant). Idle
   * WANDER waypoints prefer un-occupied ground so milling townsfolk spread out
   * instead of piling onto the same spot. A SOFT preference: when every
   * candidate is crowded the roam still picks one (termination over fidelity).
   * Absent ⇒ no crowding avoidance (bodies may overlap, as before).
   */
  occupied?: (p: Vec2, radius: number) => boolean;
}

/**
 * Conversation feedback from the social brain (Phase 2). `pull` biases the body:
 * +1 = drawn in (hold closer), 0 = neutral, -1 = withdrawing (give space).
 */
export interface NpcEngagement {
  /** The human the NPC is conversing with, if any. */
  partnerId: string | null;
  /** -1..1; how much the conversation should pull the NPC toward its partner. */
  pull: number;
}

/** One NPC the local player is currently within conversation range of. */
export interface NpcProximity {
  npcId: string;
  /** World-unit distance from the local player (sorted nearest-first by the host). */
  distance: number;
}

/**
 * A scripted body TASK: walk the waypoints in order, firing `onArrive` at each.
 * While an errand is active it overrides the NPC's behavior aim (a stationary
 * vendor walks off to fetch an item, then returns). The game layer performs the
 * world effects (pick up / put down an object) inside the callbacks — the
 * controller only steers.
 */
/** An errand waypoint; `dwell` holds the NPC there (standing) for that many
 *  seconds after arrival before it walks on — a shopper at a stall, a vendor
 *  at a shelf. `arrive` overrides the default arrival radius (0.9) for THIS
 *  point: DOOR TRANSIT points need a tight one (~0.4) — advancing a transit
 *  from 0.9 away lets the body cut the corner into the door jamb, where the
 *  straight to the next transit crosses the wall and every detour probe fails
 *  (the observed permanent wedge at hall doors). Plain Vec2s remain valid. */
export interface NpcErrandPoint extends Vec2 {
  dwell?: number;
  arrive?: number;
}

export interface NpcErrand {
  points: NpcErrandPoint[];
  /** Fired once when the NPC reaches points[index]. */
  onArrive?: (index: number) => void;
  /** Fired after the last point's onArrive; the errand then clears. */
  onDone?: () => void;
}

/** TEMP (view-distance-lod-tiers.md): wander waypoint-pick counter — picks
 *  should be SECONDS apart per body; a per-frame pick storm is the aim-phase
 *  cost. Reported/reset by world-host's frame-phase probe. Remove with it. */
export const __npcStats = { picks: 0, pickFails: 0 };

/** DEBUG READOUT of a live errand: the PLAN (`points`, door-routed by
 *  doorRouteErrand) and which leg is live. `index` is the point being walked to
 *  right now — points before it are done, points after are still to come. */
export interface NpcErrandPath {
  points: readonly NpcErrandPoint[];
  index: number;
  /** Standing out the current point's `dwell` rather than walking. */
  dwelling: boolean;
}

export interface NpcController {
  readonly npcId: string;
  readonly movement: NpcMovement;
  /** The range at which this NPC engages a person — the host uses it for proximity. */
  readonly conversationRadius: number;
  /** Decide the steering aim for this frame (world point, or null to brake). */
  computeAim(ctx: NpcControlCtx): Vec2 | null;
  /** Phase-2 hook: feed live conversation state in to bias the body. */
  setEngagement(e: NpcEngagement | null): void;
  /** Run (or cancel with null) a scripted waypoint errand; replaces any current one. */
  setErrand(e: NpcErrand | null): void;
  /** Is a scripted errand still running? (The body is EN ROUTE — feeds
   *  "where are you going?" when the pure schedule already says "home".) */
  hasErrand(): boolean;
  /** Confine idle WANDER to a designated clear rect (an IDLE PAD — a
   *  furniture-free rectangle the host computed for the room). Free roaming
   *  has no router, so in a furnished interior it walks into furniture and
   *  reads as lost; inside a pad every straight line is walkable by
   *  construction. A body OUTSIDE its pad stands still instead of roaming —
   *  the host PATHS it to the pad (a routed errand), never a blind walk.
   *  Null clears (open-world roam as before). */
  setWanderRect(rect: { x: number; y: number; w: number; h: number } | null): void;
  /** Is the CURRENT errand leg a routed PASS-THROUGH point (tight `arrive` —
   *  a door transit or an indoor dogleg corner from floor-route.ts)? The host
   *  must NOT detour-bend these aims: the plan already avoids the furniture,
   *  and a local bend drags the body off its verified corridor (observed: a
   *  bend around the table's wrong side, then fighting the carrot forever). */
  errandLegTight(): boolean;
  /** DEBUG: the live errand's waypoints + which leg is being walked, for a path
   *  overlay. Null when no errand runs (the body wanders/idles). Read-only —
   *  the returned `points` is the controller's own array, never mutate it. */
  errandPath(): NpcErrandPath | null;
  /** CHART REBASE (planet-mounted ground): the sim's tangent chart moved under
   *  the world (floating-origin re-anchor) — re-express every sim point this
   *  controller remembers (home, wander waypoint, errand polyline) through
   *  `map` so the body keeps doing exactly what it was doing at the same WORLD
   *  spot. The caller guarantees `map` preserves world poses. */
  rebase(map: (p: Vec2) => Vec2): void;
}

const DEAD = WORLD_ENGINE_DEFAULTS.aimDeadRadius;
/** Default conversational hold distance / engagement range (world units). Matches
 *  the proximity-circle radius so "in conversation range" == "audible". */
export const DEFAULT_CONVERSATION_RADIUS = 8;
/** Roam disc radius (world units) around home for an UNTETHERED wanderer on an
 *  UNBOUNDED manifold — open ground has no rect to confine it, but presence
 *  motion is local by design, so a default tether stands in. */
export const UNBOUNDED_WANDER_RADIUS = 30;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The closest human to the NPC, or null if it's alone. */
function nearestHuman(ctx: NpcControlCtx): AvatarState | null {
  let best: AvatarState | null = null;
  let bestD = Infinity;
  for (const h of ctx.humans) {
    const d = dist(ctx.self, h);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/**
 * An aim that makes the avatar TURN to face `target` WITHOUT walking there: a
 * point just inside the avatar's aim-dead-radius, in the target's direction. The
 * locomotion treats an aim this close as "already there" — it brakes and only
 * rotates to face it. Null when the target is right on top of the NPC.
 */
function faceAim(self: AvatarState, target: { x: number; y: number }): Vec2 | null {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return null;
  const r = DEAD * 0.5;
  return { x: self.x + (dx / d) * r, y: self.y + (dy / d) * r };
}

/** A point on the line between NPC and `target`, `hold` units out from the target
 *  on the NPC's side — the spot to stand to hold a conversational distance. */
function holdPoint(self: AvatarState, target: { x: number; y: number }, hold: number): Vec2 {
  const dx = self.x - target.x;
  const dy = self.y - target.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return { x: target.x + hold, y: target.y }; // degenerate: pick a side
  return { x: target.x + (dx / d) * hold, y: target.y + (dy / d) * hold };
}

class BaseController implements NpcController {
  readonly npcId: string;
  readonly movement: NpcMovement;
  readonly conversationRadius: number;
  protected get convRadius(): number { return this.conversationRadius; }
  protected engagement: NpcEngagement | null = null;

  // Wander state.
  private waypoint: Vec2 | null = null;
  private pauseUntil = 0;
  // Wander stuck detection (see wanderAim).
  private stuckFrom: Vec2 | null = null;
  private stuckSince = 0;

  // Errand state (scripted waypoint task; overrides behavior while active).
  private errand: NpcErrand | null = null;
  private errandIndex = 0;
  /** Body position when the errand began — the polyline's segment-0 start. */
  private errandEntry: Vec2 | null = null;
  /** Arc length of the segments already passed (pure-pursuit bookkeeping). */
  private errandArcBase = 0;
  /** Progress watchdog: best arc position reached + when it last improved. */
  private errandBestArc = -1;
  private errandGainAt = -1;
  /** When ≥ 0, standing at the current waypoint until this time (dwell). */
  private errandDwellUntil = -1;

  /** Tether anchor when `wanderRadius` is set: `behavior.home`, else the spawn
   *  point. Mutable ONLY by rebase() — a chart re-anchor re-expresses it. */
  private home: Vec2;
  private readonly wanderRadius: number | undefined;
  /** Idle-pad confinement for wander (see NpcController.setWanderRect). */
  private wanderRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(spec: NpcSpec) {
    this.npcId = spec.id;
    this.movement = spec.behavior?.movement ?? "wander";
    this.conversationRadius = spec.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS;
    this.home = spec.behavior?.home ?? { x: spec.x, y: spec.y };
    this.wanderRadius = spec.behavior?.wanderRadius;
  }

  setEngagement(e: NpcEngagement | null): void {
    this.engagement = e;
  }

  errandLegTight(): boolean {
    const pt = this.errand?.points[this.errandIndex];
    return !!pt && (pt.arrive ?? 1) < 0.8;
  }

  setWanderRect(rect: { x: number; y: number; w: number; h: number } | null): void {
    this.wanderRect = rect;
    this.waypoint = null; // an old free-roam target must not outlive the pad
  }

  rebase(map: (p: Vec2) => Vec2): void {
    this.home = map(this.home);
    if (this.waypoint) this.waypoint = map(this.waypoint);
    if (this.stuckFrom) this.stuckFrom = map(this.stuckFrom);
    if (this.errandEntry) this.errandEntry = map(this.errandEntry);
    // The errand's polyline is re-expressed IN PLACE (dwell/arrive fields ride
    // along untouched): arc-length bookkeeping (errandArcBase/BestArc) is
    // invariant — the map is a rigid re-expression, distances don't change.
    if (this.errand) {
      for (const pt of this.errand.points) {
        const m = map(pt);
        pt.x = m.x;
        pt.y = m.y;
      }
    }
    // A wander pad keeps its size; only its corner moves (the chart rotation
    // between neighbouring anchors is negligible at re-anchor distances, and
    // planet-mounted ground — the only rebase caller — never sets pads).
    if (this.wanderRect) {
      const c = map({ x: this.wanderRect.x, y: this.wanderRect.y });
      this.wanderRect.x = c.x;
      this.wanderRect.y = c.y;
    }
  }

  setErrand(e: NpcErrand | null): void {
    this.errand = e;
    this.errandIndex = 0;
    this.errandEntry = null;
    this.errandArcBase = 0;
    this.errandBestArc = -1;
    this.errandGainAt = -1;
    this.errandDwellUntil = -1;
  }

  hasErrand(): boolean {
    return this.errand !== null;
  }

  errandPath(): NpcErrandPath | null {
    if (!this.errand) return null;
    return { points: this.errand.points, index: this.errandIndex, dwelling: this.errandDwellUntil >= 0 };
  }

  /** Walk the errand's polyline by PURE PURSUIT: project the body onto the
   *  planned path (monotone — vertices only ever advance) and aim at the
   *  point a fixed LOOKAHEAD further along the path's arc. The aim moves
   *  continuously along ground the planner already verified, so there is
   *  nothing to vibrate between, and an overshoot self-corrects — the carrot
   *  is always AHEAD of the body's projection, never behind it.
   *
   *  FLOW vertices (door transits, route corners) are passed by PROJECTION —
   *  the body never has to touch them. STOP vertices (a `dwell` point, the
   *  final target) are reached by DISTANCE, and the carrot clamps at them so
   *  the mover's own close-brake lands the stop.
   *
   *  Termination: a progress WATCHDOG. If the body's best arc position stops
   *  improving for a few seconds, the current vertex counts as passed — an
   *  errand may cut a corner, but an NPC must NEVER wedge forever (it would
   *  become uninteractable). Fires callbacks/dwell exactly like a real pass. */
  private errandAim(ctx: NpcControlCtx): Vec2 | null {
    const ERRAND_ARRIVE = 0.9;
    const LOOKAHEAD = 1.1; // > the mover's aim-dead-radius (0.8): mid-path aims never brake
    const STALL_S = 5;
    const errand = this.errand!;
    const pts = errand.points;
    if (this.errandDwellUntil >= 0) {
      // Standing at the waypoint (a shopper at the stall).
      if (ctx.now < this.errandDwellUntil) return null;
      this.errandDwellUntil = -1;
      return this.errandAdvance(errand);
    }
    if (!this.errandEntry) {
      this.errandEntry = { x: ctx.self.x, y: ctx.self.y };
      this.errandGainAt = ctx.now;
    }
    const segStart = (i: number): Vec2 => (i === 0 ? this.errandEntry! : pts[i - 1]!);
    const isStop = (i: number): boolean => i >= pts.length - 1 || !!(pts[i]!.dwell && pts[i]!.dwell! > 0);

    // 0. SKIP-AHEAD RECOVERY: a cut corner can land the body alongside a
    //    LATER stretch of the path — pursuing the earlier vertex then aims
    //    BEHIND the body, and it thrashes between returning and continuing.
    //    Find the farthest upcoming segment the body already stands beside
    //    (never scanning past a STOP vertex — a dwell must not be skipped)
    //    and resume from there, passing the skipped flow vertices properly.
    {
      const SKIP_NEAR = 0.8;
      let resume = this.errandIndex;
      for (let probe = this.errandIndex; probe + 1 < pts.length && !isStop(probe); probe++) {
        const a = pts[probe]!;
        const b = pts[probe + 1]!;
        const bx = b.x - a.x;
        const by = b.y - a.y;
        const len2 = bx * bx + by * by;
        const t = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((ctx.self.x - a.x) * bx + (ctx.self.y - a.y) * by) / len2));
        const qx = a.x + bx * t;
        const qy = a.y + by * t;
        if (Math.hypot(ctx.self.x - qx, ctx.self.y - qy) <= SKIP_NEAR) resume = probe + 1;
      }
      while (this.errandIndex < resume) {
        errand.onArrive?.(this.errandIndex);
        if (this.errand !== errand) return null; // a callback replaced/cleared it
        this.errandAdvance(errand); // skipped vertices are FLOW by construction — no dwell
        if (this.errand !== errand) return null;
        this.errandGainAt = ctx.now;
        this.errandBestArc = Math.max(this.errandBestArc, this.errandArcBase);
      }
    }

    // 1. PROJECT + PASS: advance the pursued vertex while the projection has
    //    moved past it (flow) or the body stands on it (stop).
    for (;;) {
      const pt = pts[this.errandIndex];
      if (!pt) {
        this.errand = null;
        this.errandIndex = 0;
        errand.onDone?.();
        return null;
      }
      const a = segStart(this.errandIndex);
      const bx = pt.x - a.x;
      const by = pt.y - a.y;
      const segLen = Math.hypot(bx, by);
      const t =
        segLen < 1e-4
          ? 1
          : Math.max(0, ((ctx.self.x - a.x) * bx + (ctx.self.y - a.y) * by) / (segLen * segLen));
      const d = dist(ctx.self, pt);
      const arrive = pt.arrive ?? ERRAND_ARRIVE;
      // WATCHDOG: arc progress must keep improving, else force the pass. A FLOW
      // force-pass is the dangerous one on-screen: skipping a routing corner the
      // body couldn't reach jumps the aim to the NEXT waypoint, whose straight may
      // cross furniture — an "impossible move" a watcher sees. So a flow skip is
      // suppressed while a person can see the body or the errand's end (the host
      // re-routes visible bodies instead — walkTo). A STOP force-pass only makes
      // the body give up AT its destination and stand there (no teleport, and the
      // host's own in-place action is separately view-gated), so it always fires —
      // that is the never-wedge-forever + honest-termination backstop.
      const VIEW_R = 42;
      const last = pts[pts.length - 1]!;
      const watched = ctx.humans.some(
        (hu) => dist(hu, ctx.self) < VIEW_R || dist(hu, last) < VIEW_R,
      );
      const arc = this.errandArcBase + Math.min(t, 1) * segLen;
      if (arc > this.errandBestArc + 0.15) {
        this.errandBestArc = arc;
        this.errandGainAt = ctx.now;
      }
      const stalled = ctx.now - this.errandGainAt > STALL_S;
      const passed = isStop(this.errandIndex)
        ? d <= arrive || stalled
        : t >= 1 || d <= arrive || (stalled && !watched);
      if (!passed) break;
      this.errandGainAt = ctx.now; // fresh budget for the next vertex
      errand.onArrive?.(this.errandIndex);
      if (this.errand !== errand) return null; // a callback replaced/cleared it
      if (pt.dwell && pt.dwell > 0) {
        this.errandDwellUntil = ctx.now + pt.dwell;
        return null;
      }
      this.errandAdvance(errand);
      if (this.errand !== errand) return null; // finished (onDone fired) or replaced
    }

    // 2. THE CARROT: from the body's projection on the current segment, walk
    //    LOOKAHEAD along the remaining path; clamp at the next STOP vertex so
    //    the close-brake lands stops instead of orbiting them. The returned
    //    aim is the carrot's DIRECTION projected out to AIM_REACH: locomotion
    //    speed is proportional to aim distance (engine: gain × (d − dead)),
    //    so an aim that hovers a constant 1.1 m ahead walks at a permanent
    //    crawl — direction is what tracks the path; reach sets the pace.
    const AIM_REACH = 2.4;
    const a0 = segStart(this.errandIndex);
    let i = this.errandIndex;
    let from = a0;
    {
      // Projection point on the current segment.
      const pt = pts[i]!;
      const bx = pt.x - a0.x;
      const by = pt.y - a0.y;
      const len2 = bx * bx + by * by;
      const t = len2 < 1e-9 ? 1 : Math.min(1, Math.max(0, ((ctx.self.x - a0.x) * bx + (ctx.self.y - a0.y) * by) / len2));
      from = { x: a0.x + bx * t, y: a0.y + by * t };
    }
    const reach = (carrot: Vec2): Vec2 => {
      const gx = carrot.x - ctx.self.x;
      const gy = carrot.y - ctx.self.y;
      const g = Math.hypot(gx, gy);
      if (g < 1e-4 || g >= AIM_REACH) return carrot;
      return { x: ctx.self.x + (gx / g) * AIM_REACH, y: ctx.self.y + (gy / g) * AIM_REACH };
    };
    let budget = LOOKAHEAD;
    for (;;) {
      const pt = pts[i]!;
      const remaining = dist(from, pt);
      if (isStop(i)) {
        // Clamp at a stop: aim straight at it once it's within the lookahead
        // (NOT reach-extended — the brake is what lands the stop).
        if (remaining <= budget) return pt;
      }
      if (remaining >= budget) {
        const ux = (pt.x - from.x) / (remaining || 1);
        const uy = (pt.y - from.y) / (remaining || 1);
        return reach({ x: from.x + ux * budget, y: from.y + uy * budget });
      }
      budget -= remaining;
      from = pt;
      i += 1;
      if (i >= pts.length) return pts[pts.length - 1]!;
    }
  }

  /** Step to the next errand waypoint (or finish). */
  private errandAdvance(errand: NpcErrand): Vec2 | null {
    // Bank the passed segment's arc length (pure-pursuit bookkeeping).
    const passed = errand.points[this.errandIndex];
    if (passed) {
      const a = this.errandIndex === 0 ? this.errandEntry ?? passed : errand.points[this.errandIndex - 1]!;
      this.errandArcBase += Math.hypot(passed.x - a.x, passed.y - a.y);
    }
    this.errandIndex += 1;
    if (this.errandIndex >= errand.points.length) {
      this.errand = null;
      this.errandIndex = 0;
      errand.onDone?.();
      return null;
    }
    return errand.points[this.errandIndex] ?? null;
  }

  computeAim(ctx: NpcControlCtx): Vec2 | null {
    if (this.errand) return this.errandAim(ctx);
    switch (this.movement) {
      case "stationary":
        return this.stationaryAim(ctx);
      case "approach_nearest":
        return this.approachAim(ctx);
      case "wander":
      default:
        return this.wanderAim(ctx);
    }
  }

  /** Hold position; turn to face the nearest person (or rest facing if alone). */
  private stationaryAim(ctx: NpcControlCtx): Vec2 | null {
    const h = nearestHuman(ctx);
    return h ? faceAim(ctx.self, h) : null;
  }

  /** Roam to random waypoints, pausing on arrival so motion looks unhurried. */
  private wanderAim(ctx: NpcControlCtx): Vec2 | null {
    const ARRIVE = 1.5;
    const STUCK_SEC = 3; // no ground gained for this long → give up on the waypoint
    // OUTSIDE the idle pad: stand rather than blind-roam toward it — the host
    // PATHS bodies to their pads (a routed errand). Roaming only happens on
    // ground the pad guarantees clear.
    if (this.wanderRect) {
      const r = this.wanderRect;
      const inside =
        ctx.self.x >= r.x - 0.5 && ctx.self.x <= r.x + r.w + 0.5 &&
        ctx.self.y >= r.y - 0.5 && ctx.self.y <= r.y + r.h + 0.5;
      if (!inside) return null;
    }
    if (ctx.now < this.pauseUntil) return null; // standing at a waypoint
    if (this.waypoint && dist(ctx.self, this.waypoint) < ARRIVE) {
      // Arrived — pause a beat, then repick next frame.
      this.pauseUntil = ctx.now + 1.5 + ctx.rng() * 2.5;
      this.waypoint = null;
      return null;
    }
    if (!this.waypoint) {
      this.waypoint = this.pickWaypoint(ctx);
      this.stuckFrom = null;
    }
    // Stuck detection: waypoints are picked blind to walls, so an aim
    // inside a building pins the NPC against a wall FOREVER (errands
    // time out per waypoint; wander had no such escape). If the body
    // hasn't gained a meter in STUCK_SEC, drop the waypoint and repick.
    if (!this.stuckFrom || dist(ctx.self, this.stuckFrom) > 1) {
      this.stuckFrom = { x: ctx.self.x, y: ctx.self.y };
      this.stuckSince = ctx.now;
    } else if (ctx.now - this.stuckSince > STUCK_SEC) {
      this.waypoint = null;
      this.stuckFrom = null;
      this.pauseUntil = ctx.now + 0.5 + ctx.rng();
      return null;
    }
    return this.waypoint;
  }

  /** Approach the nearest person to a conversational distance, then hold + face.
   *  Roams when nobody is present. The engagement `pull` (Phase 2) widens the hold
   *  when the NPC is withdrawing and tightens it when it's drawn in. */
  private approachAim(ctx: NpcControlCtx): Vec2 | null {
    const h = nearestHuman(ctx);
    if (!h) return this.wanderAim(ctx);

    // Hold distance: half the conversation radius, nudged by engagement.
    const pull = this.engagement?.pull ?? 0;
    const hold = clamp(
      this.convRadius * (0.5 - pull * 0.2),
      1.2,
      this.convRadius,
    );
    const d = dist(ctx.self, h);

    if (d <= this.convRadius) {
      // In range. If we're roughly at the hold ring, just face them; otherwise
      // ease to the ring (stepping in when too far, backing off when too close).
      if (Math.abs(d - hold) < 0.6) return faceAim(ctx.self, h);
      const target = holdPoint(ctx.self, h, hold);
      return dist(ctx.self, target) < 0.4 ? faceAim(ctx.self, h) : target;
    }
    // Out of range — walk to the hold ring.
    return holdPoint(ctx.self, h, hold);
  }

  private pickWaypoint(ctx: NpcControlCtx): Vec2 {
    const m = 2; // keep clear of the manifold edge
    const draw = (): Vec2 => {
      if (this.wanderRect) {
        // Idle-pad pacing: any point in the designated clear rect, inset so
        // the body's own girth never grazes the pad's edge fixtures.
        const r = this.wanderRect;
        const inset = Math.min(0.4, r.w / 4, r.h / 4);
        return {
          x: r.x + inset + ctx.rng() * Math.max(0, r.w - 2 * inset),
          y: r.y + inset + ctx.rng() * Math.max(0, r.h - 2 * inset),
        };
      }
      const unbounded = ctx.bounded === false;
      if (this.wanderRadius !== undefined || unbounded) {
        // Tethered roam: a point in the disc around home. On a bounded
        // manifold the point is clamped in-bounds; unbounded, the tether IS
        // the range (behavioral, city-legit) and the rect never confines —
        // an untethered NPC on open ground gets a default disc rather than
        // the content rect.
        const a = ctx.rng() * Math.PI * 2;
        const r = Math.sqrt(ctx.rng()) * (this.wanderRadius ?? UNBOUNDED_WANDER_RADIUS);
        const x = this.home.x + Math.cos(a) * r;
        const y = this.home.y + Math.sin(a) * r;
        if (unbounded) return { x, y };
        return {
          x: clamp(x, m, Math.max(m, ctx.width - m)),
          y: clamp(y, m, Math.max(m, ctx.height - m)),
        };
      }
      return {
        x: m + ctx.rng() * Math.max(0, ctx.width - 2 * m),
        y: m + ctx.rng() * Math.max(0, ctx.height - 2 * m),
      };
    };
    // With a walkability oracle, refuse to AIM at blocked ground (a waypoint
    // inside a neighbor's house walks the NPC into the wall — or through an
    // auto-opening door — until stuck detection fires). A few redraws almost
    // always find open ground; home is the safe fallback.
    if (!ctx.walkable) {
      // No walkability oracle (open-world roam). Still avoid piling onto a
      // neighbour when the crowding oracle is present — pick the first draw
      // clear of other bodies, else any draw.
      if (!ctx.occupied) return draw();
      const r = ctx.radius ?? 0.6;
      for (let i = 0; i < 8; i++) {
        const p = draw();
        if (!ctx.occupied(p, r)) return p;
      }
      return draw();
    }
    __npcStats.picks++; // TEMP
    const radius = ctx.radius ?? 0.6;
    // The first structurally-good draw that is also clear of OTHER bodies wins;
    // remember the first structurally-good-but-crowded one as a fallback so a
    // packed area still yields a waypoint (the crowding rule is a preference,
    // never a deadlock — termination over fidelity).
    let crowdedFallback: Vec2 | null = null;
    for (let i = 0; i < 8; i++) {
      const p = draw();
      // Probe at the BODY's radius (ctx.radius), not a padded one: indoors,
      // padding rejects every spot in a furnished room and starves the roam.
      // The endpoint being open is NOT enough — an open spot behind a wall is
      // unreachable, and wander has no router (errands get doorRouteErrand; a
      // roam does not). Such a waypoint pins the body against the wall until
      // STUCK_SEC fires, which is the aimless-wander getting-stuck that reads
      // so badly. Require a clear straight CORRIDOR too, so a roam only ever
      // targets ground it can actually walk to. This keeps idle roaming within
      // line of sight — through a doorway when the line passes the gap, else
      // inside the current room — which is exactly the honest range for a
      // walker that cannot route.
      if (!(ctx.walkable(p, radius) && this.corridorClear(ctx, p, radius))) continue;
      // Prefer ground no other body already occupies (the crowding rule) so
      // milling townsfolk fan out rather than converging on one point.
      if (!ctx.occupied || !ctx.occupied(p, radius)) return p;
      crowdedFallback ??= p;
    }
    if (crowdedFallback) return crowdedFallback; // structurally fine, just crowded
    __npcStats.pickFails++; // TEMP — all 8 draws failed; fallback
    // Safe fallback: the pad's center when confined (home may lie outside it).
    if (this.wanderRect) {
      return { x: this.wanderRect.x + this.wanderRect.w / 2, y: this.wanderRect.y + this.wanderRect.h / 2 };
    }
    return { ...this.home };
  }

  /** Is the straight line self→p walkable end to end, at the body's radius?
   *  Sampled at CORRIDOR_STEP; the endpoint is the caller's business.
   *  PROBE-BOUNDED: a body far from its home (an errand left it across town)
   *  draws candidates near home — a 100m+ corridor at a fixed fine step cost
   *  ~200 probes PER DRAW × 8 draws × many bodies (the aim-phase storm). The
   *  step widens with length so one corridor never exceeds ~24 probes; a
   *  coarser march on a LONG roam can miss a thin wall, and the wander
   *  stuck-detection (3s, repick) copes exactly as it always has. Short
   *  corridors keep the fine door-gap-safe step. */
  private corridorClear(ctx: NpcControlCtx, p: Vec2, radius: number): boolean {
    const walk = ctx.walkable;
    if (!walk) return true;
    const dx = p.x - ctx.self.x;
    const dy = p.y - ctx.self.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const step = Math.max(0.75, len / 24); // fine when near; bounded when far
    for (let d = step; d < len; d += step) {
      if (!walk({ x: ctx.self.x + (dx / len) * d, y: ctx.self.y + (dy / len) * d }, radius)) return false;
    }
    return true;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * LOCAL OBSTACLE DETOUR — "walk around it, don't grind on it". If the straight
 * line from `self` toward `aim` hits blocked ground within the next few meters
 * (sampled against the SAME walkability the locomotion collides on), return a
 * side-step point that clears the obstacle instead of the raw aim. Re-computed
 * every frame with no stored state: as the body advances, the blocked sample and
 * its bypass slide along the obstacle face and around its corner — a cheap
 * wall-walk, no pathfinding. Door gaps stay usable (a sample INSIDE a doorway is
 * walkable, so a door-bound aim is never deflected); a fully-walled aim returns
 * unchanged and the slide + leg timeouts handle it as before. Serves NPC steering
 * AND the player's walk aim.
 *
 * `radius` MUST be the mover's collision radius (config.avatarRadius): probing
 * fatter than the body reads the furniture solver's exactly-body-wide service
 * lanes as walls, and the detour then shoves a body sideways through a passage
 * it walks straight through just fine — the visible back-and-forth shake.
 *
 * `prefer` is side HYSTERESIS, held by the caller: stateless re-computation
 * flips the bypass side frame to frame when both sides look similar, dithering
 * the body in place. The caller remembers which side last won (sign of the
 * cross product of aim-direction × bend) and feeds it back, so an in-progress
 * detour keeps committing to the same shoulder until the way is clear.
 */
export function detourAim(
  self: Vec2,
  aim: Vec2,
  walkable: (p: Vec2, radius: number) => boolean,
  radius = 0.5,
  prefer: 1 | -1 = 1,
): Vec2 {
  const dx = aim.x - self.x;
  const dy = aim.y - self.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return aim;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy; // unit perpendicular
  const py = ux;
  const STEP = 1.0;
  const LOOK = Math.min(len, 6); // only the next few meters matter
  for (let d = STEP; d <= LOOK; d += STEP) {
    const sx = self.x + ux * d;
    const sy = self.y + uy * d;
    if (walkable({ x: sx, y: sy }, radius)) continue;
    // Blocked at distance d — probe side-steps at the blocked sample. THE
    // PREFERRED SHOULDER IS TRIED AT EVERY WIDTH BEFORE THE OTHER SIDE GETS A
    // LOOK: a commitment must beat a narrower gap on the fresh side, or the
    // memory means nothing — width-outermost probing flipped the bend to
    // whichever side cleared narrowest as the body arced around a table, the
    // record() call then overwrote the memory with the flip, and the body
    // dithered exactly as if there were no memory at all (the surviving half
    // of the table-spin bug). Flip only when the committed side is walled at
    // every width. The whole CORRIDOR to the bypass must be clear — marched
    // at a step no thin interior wall (0.4 + two body radii ≈ 1.2 blocked
    // band) can slip through: the old single-midpoint check let a bend point
    // straight through a partition wall, and the body ground on it forever.
    for (const s of [prefer, -prefer]) {
      for (let w = 1.2; w <= 6; w += 1.2) {
        const c = { x: sx + px * w * s, y: sy + py * w * s };
        if (!walkable(c, radius)) continue;
        const reach = Math.hypot(c.x - self.x, c.y - self.y);
        const steps = Math.max(1, Math.ceil(reach / 0.6));
        // ESCAPE-THEN-STAY-CLEAR: samples may start blocked (a body wedged
        // inside a fixture box — the engine's already-inside failsafe lets it
        // walk out, and the bend is exactly how it escapes), but once the
        // corridor clears it must STAY clear — a blocked sample after a clear
        // one means the bend crosses a wall.
        let seenClear = false;
        let corridor = true;
        for (let k = 1; k < steps; k++) {
          const q = { x: self.x + ((c.x - self.x) * k) / steps, y: self.y + ((c.y - self.y) * k) / steps };
          if (walkable(q, radius)) {
            seenClear = true;
          } else if (seenClear) {
            corridor = false;
            break;
          }
        }
        if (corridor) return c;
      }
    }
    return aim; // walled in every direction — let slide/timeouts cope
  }
  return aim;
}

/** Which shoulder did a bend take, relative to the straight aim? The sign of
 *  cross(aim-dir, bend-dir) — and, by construction, exactly the `prefer` that
 *  produced it (detourAim offsets along ±perp(aim-dir), so the cross reduces to
 *  len·w·prefer). That round-trip is what lets a caller store the side it got
 *  and feed it back next frame. */
export function sideOfBend(self: Vec2, aim: Vec2, bent: Vec2): 1 | -1 {
  const cross = (aim.x - self.x) * (bent.y - self.y) - (aim.y - self.y) * (bent.x - self.x);
  return cross >= 0 ? 1 : -1;
}

/** Default seconds a detour shoulder stays committed after the last bent frame. */
export const DETOUR_HOLD_S = 2;

/**
 * DETOUR SHOULDER MEMORY — the hysteresis `detourAim`'s `prefer` needs to mean
 * anything. Held per mover (NPC id, or the player).
 *
 * The rule that matters: a commitment EXPIRES on a timer; it is NOT cleared the
 * moment the way ahead reads straight. A bypass is a MANEUVER, not a frame.
 * Halfway around a table the straight line to the target clears for a frame or
 * two — clearing the memory there restarts the next blocked frame from the
 * default shoulder, which may be the OTHER one. The body then reverses,
 * re-blocks, flips back, and orbits the obstacle while its facing (which tracks
 * velocity) whips around. That was the spin-next-to-the-table bug.
 */
export interface DetourMemory {
  /** The shoulder to try first for `id` at `now` — the live commitment, else +1. */
  prefer(id: string, now: number): 1 | -1;
  /** Commit (or renew) `id`'s shoulder. Call on every BENT frame, never on a clear one. */
  record(id: string, side: 1 | -1, now: number): void;
  /** Drop a mover's memory entirely (it left the world). */
  forget(id: string): void;
}

export function createDetourMemory(holdSeconds: number = DETOUR_HOLD_S): DetourMemory {
  const sides = new Map<string, { side: 1 | -1; until: number }>();
  return {
    prefer(id, now) {
      const m = sides.get(id);
      return m && now < m.until ? m.side : 1;
    },
    record(id, side, now) {
      sides.set(id, { side, until: now + holdSeconds });
    },
    forget(id) {
      sides.delete(id);
    },
  };
}

/** Build a steering controller for an NPC spec. */
export function createNpcController(spec: NpcSpec): NpcController {
  return new BaseController(spec);
}
