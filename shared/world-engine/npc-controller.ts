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
  /** Injected RNG (deterministic in tests; Math.random in the app). */
  rng: () => number;
  /**
   * Optional walkability oracle (the host passes the same composed constraint
   * locomotion moves under). Wander waypoints are rejected when blocked, so an
   * NPC stops AIMING into buildings instead of merely bouncing off their walls.
   */
  walkable?: (p: Vec2, radius: number) => boolean;
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
 *  at a shelf. Plain Vec2s remain valid points. */
export interface NpcErrandPoint extends Vec2 {
  dwell?: number;
}

export interface NpcErrand {
  points: NpcErrandPoint[];
  /** Fired once when the NPC reaches points[index]. */
  onArrive?: (index: number) => void;
  /** Fired after the last point's onArrive; the errand then clears. */
  onDone?: () => void;
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
}

const DEAD = WORLD_ENGINE_DEFAULTS.aimDeadRadius;
/** Default conversational hold distance / engagement range (world units). Matches
 *  the proximity-circle radius so "in conversation range" == "audible". */
export const DEFAULT_CONVERSATION_RADIUS = 8;

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
  private errandWaypointSince = -1;
  private errandLegDeadline = Infinity;
  /** When ≥ 0, standing at the current waypoint until this time (dwell). */
  private errandDwellUntil = -1;

  /** Tether anchor when `wanderRadius` is set: `behavior.home`, else the spawn point. */
  private readonly home: Vec2;
  private readonly wanderRadius: number | undefined;

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

  setErrand(e: NpcErrand | null): void {
    this.errand = e;
    this.errandIndex = 0;
    this.errandWaypointSince = -1;
    this.errandDwellUntil = -1;
  }

  /** Walk the errand's waypoints; fire callbacks on arrival, stand out a
   *  waypoint's `dwell` before moving on. Returns the aim, or null on the frame
   *  the errand completes (and while dwelling). A waypoint that can't be reached
   *  within its leg budget counts as arrived — an errand may cut a corner, but an
   *  NPC must NEVER wedge into a wall forever (it would become uninteractable).
   *  The budget is DISTANCE-AWARE (4 s + 1 s per unit): a slow walker on a long
   *  leg isn't cut short, a truly blocked one gives up within seconds. */
  private errandAim(ctx: NpcControlCtx): Vec2 | null {
    const ERRAND_ARRIVE = 0.9;
    const errand = this.errand!;
    const pt = errand.points[this.errandIndex];
    if (!pt) {
      this.errand = null;
      return null;
    }
    if (this.errandDwellUntil >= 0) {
      // Standing at the waypoint (a shopper at the stall).
      if (ctx.now < this.errandDwellUntil) return null;
      this.errandDwellUntil = -1;
      return this.errandAdvance(errand);
    }
    if (this.errandWaypointSince < 0) {
      this.errandWaypointSince = ctx.now;
      this.errandLegDeadline = ctx.now + 4 + dist(ctx.self, pt);
    }
    if (dist(ctx.self, pt) <= ERRAND_ARRIVE || ctx.now > this.errandLegDeadline) {
      errand.onArrive?.(this.errandIndex);
      if (this.errand !== errand) return null; // a callback replaced/cleared it
      if (pt.dwell && pt.dwell > 0) {
        this.errandDwellUntil = ctx.now + pt.dwell;
        return null;
      }
      return this.errandAdvance(errand);
    }
    return pt;
  }

  /** Step to the next errand waypoint (or finish). */
  private errandAdvance(errand: NpcErrand): Vec2 | null {
    this.errandIndex += 1;
    this.errandWaypointSince = -1; // next call stamps the new leg's budget
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
      if (this.wanderRadius !== undefined) {
        // Tethered roam: a point in the disc around home, clamped in-bounds.
        const a = ctx.rng() * Math.PI * 2;
        const r = Math.sqrt(ctx.rng()) * this.wanderRadius;
        return {
          x: clamp(this.home.x + Math.cos(a) * r, m, Math.max(m, ctx.width - m)),
          y: clamp(this.home.y + Math.sin(a) * r, m, Math.max(m, ctx.height - m)),
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
    if (!ctx.walkable) return draw();
    for (let i = 0; i < 8; i++) {
      const p = draw();
      if (ctx.walkable(p, 0.6)) return p;
    }
    return { ...this.home };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Build a steering controller for an NPC spec. */
export function createNpcController(spec: NpcSpec): NpcController {
  return new BaseController(spec);
}
