// shared/world-engine/interaction/quest/furniture-anchor.ts
//
// THE FURNITURE-USE ANCHOR STATE MACHINE — the sim-side half of the use-point
// contract. The renderer already composes the *pose* onto a fixture (render3d
// resolveActivityAnchor → creature-model's eased slide onto the use point); this
// module gets the SIM BODY legally there so the two agree and the pose settles.
//
// THE BUG IT FIXES: a bed / toilet is a SOLID collider when not in use, so a body
// walking up to sleep/sit COLLIDES with the fixture's edge and stops ~a body-
// radius in FRONT of it. The renderer's slide then fights the steering: the body
// keeps trying to reach the fixture, its smoothed speed never falls to zero, the
// slide level never reaches 1, and the pose is left played PART-WAY onto the
// piece — the chronic "asleep standing in front of the bed" picture.
//
// THE FIX (the user's design): when a body that has CLAIMED a fixture for use
// (its `activity.objId` names an ON-FIXTURE kind — a bed/chair/toilet) reaches it,
// that contact is the HANDOFF. The anchor takes over the body's movement and
// INTERPOLATES it between fixed endpoints (never velocity/collision physics — the
// slide is a straight ease from a captured start to a captured end, so it can
// cross the fixture's own footprint that blocks the steered walk):
//   1. sliding-in  — lerp the sim body from where it stopped to the use point
//                    (the fixture centre for a bed/seat).
//   2. anchored    — pin the body at the use point, facing the fixture; held out
//                    of the crowding-separation pass so it can't be shoved off.
//   3. sliding-out — on release (need met / interrupted / commanded away — EVERY
//                    exit path clears `activity`), lerp to a VALIDATED dismount
//                    spot (walkable, on a use-direction side, clear of colliders
//                    and other bodies) before locomotion resumes.
// No snap while visible: each slide is an EASED position interpolation over a
// short, distance-scaled duration (project_walk_unification), never a teleport.
//
// PURE + test:engine-drivable: quest-host needs WebGL, so this state machine
// lives on the sim side where a headless test can drive it via `tickFurnitureAnchor`
// over a flat WorldState. world-host wires it into the live NPC loop.

import {
  WORLD_ENGINE_DEFAULTS,
  type WorldState,
  type AvatarState,
  type WorldEngineConfig,
} from "../../engine.js";
import { useContractFor, useAnchorPlan } from "../../furniture-use.js";
import { standPointFor, standClear, bodiesClear, nearestClearSpot, type BodyAvoidance } from "./stand-points.js";
import { DEFAULT_BODY_RADIUS_M } from "../../creatures/species.js";

/** THE ENGAGE TRIGGER IS THE ARRIVAL SPOT, NOT A RING AROUND THE PIECE.
 *
 *  A use-walk steers to the piece's stand-off (`standPointFor`: fixture radius +
 *  body radius + 0.22, on a use side) and — with corner-cutting disabled indoors —
 *  genuinely gets there, so the handoff is a SMALL circle around that spot. A
 *  fixture-centre ring has to be wide enough to cover the stand-off and then
 *  covers far more: at the old 1.6 m margin it spanned the TABLE a dining chair
 *  was tucked against, so a body across the tabletop read "arrived" (2.35 m ≤
 *  2.42), rested in place, and never rounded the table to its seat (observed
 *  live). The spot circle covers the use-leg's own arrival tolerance (0.45) plus
 *  braking, and nothing else.
 *
 *  Only a body whose `activity` already NAMES this fixture (the claim) is ever
 *  tested, so an unrelated pass-by never engages. */
const ENGAGE_SPOT_REACH = 0.9;

/** Pressed-contact fallback: a body already against the piece's solid box — or
 *  standing ON a pass-through seat, whose centre is itself a legal walk target —
 *  engages regardless of where the computed stand spot sits (the spot is
 *  body-relative and can land on the far side of the piece it is touching). */
const ENGAGE_CONTACT_SLACK = 0.35;

/** The glide pace (m/s) the slide interpolation targets — a natural walk-on speed,
 *  not a dash. The per-slide DURATION is the distance at this pace, clamped to a
 *  short window so a tiny slide still eases (never snaps) and a long one never
 *  crawls. */
const SLIDE_SPEED = 1.6;
const SLIDE_MIN_S = 0.2;
const SLIDE_MAX_S = 0.7;

/** Smooth ease-in-out on the 0..1 slide parameter (project_walk_unification: no
 *  snap while visible — the body accelerates off the start and settles onto the
 *  end rather than moving at a hard constant rate). */
function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Per-body inputs the anchor needs from the host (world-host supplies these). */
export interface AnchorDeps {
  /** This body's collision radius (world-host `npcRadiusOf`). Default = design. */
  bodyR?: number;
  /** Per-body radius for the crowding / dismount clearance checks. */
  radiusOf?: (id: string) => number;
}

/** The fixture an `activity.objId` names IF it is an ON-FIXTURE kind (a bed /
 *  chair / toilet — a body poses ON it), with the plan use point and its centre;
 *  null for a beside kind (a table / chest — the body stands beside it, no
 *  anchor) or a missing / non-fixture object. */
function onFixtureTargetOf(
  state: WorldState,
  objId: string | undefined,
): { fixtureId: string; target: { x: number; y: number }; center: { x: number; y: number } } | null {
  if (!objId) return null;
  const spec = state.spec.objects.find((s) => s.id === objId);
  const obj = state.objects[objId];
  if (!spec?.fixture || !obj) return null;
  const contract = useContractFor(spec.fixture);
  if (!contract.onFixture) return null; // a reach (table/chest) poses in place — no anchor
  const target = useAnchorPlan(contract, {
    x: obj.x,
    y: obj.y,
    radius: spec.radius,
    facing: spec.facing,
    groundZ: 0,
  });
  return { fixtureId: objId, target, center: { x: obj.x, y: obj.y } };
}

/** Is this body claiming (using) THIS fixture right now — i.e. its live activity
 *  names it and the kind is still an on-fixture use? The release trigger reads
 *  the negation: the moment the claim drops, the body slides out. */
export function bodyClaimsFixture(state: WorldState, a: AvatarState, fixtureId: string): boolean {
  return a.activity?.objId === fixtureId && !!onFixtureTargetOf(state, fixtureId);
}

/** THE VALIDATED DISMOUNT (mission §2): where a body leaving a fixture is placed
 *  before locomotion resumes — walkable, on a use-direction side, clear of solid
 *  colliders AND of every other body, in the fixture's own room. Falls back
 *  through `standPointFor` (which already prefers the use-direction side + avoids
 *  bodies) to `nearestClearSpot` to a best-effort side spot — anything OUTSIDE
 *  the collider beats leaving the body dropped inside the geometry (termination
 *  over fidelity). The eased slide-out then interpolates the body there straight
 *  across the fixture it is leaving. */
export function dismountSpot(
  state: WorldState,
  a: AvatarState,
  fixtureId: string,
  deps: AnchorDeps = {},
): { x: number; y: number } {
  const bodyR = deps.bodyR ?? DEFAULT_BODY_RADIUS_M;
  const avoid: BodyAvoidance = { selfId: a.id, radiusOf: deps.radiusOf };
  const obj = state.objects[fixtureId];
  const center = obj ? { x: obj.x, y: obj.y } : { x: a.x, y: a.y };
  // `from` = the body's current (on-fixture) position, so standPointFor biases
  // toward the side it entered from; the use-direction preference leads regardless.
  const sp = standPointFor(state, fixtureId, center, { x: a.x, y: a.y }, bodyR, avoid);
  if (standClear(state, sp, bodyR) && bodiesClear(state, sp, a.id, bodyR, deps.radiusOf)) return sp;
  // standPointFor returned a best-effort (blocked) fallback — try a general clear
  // spot near the fixture centre next.
  const near = nearestClearSpot(state, center, { x: a.x, y: a.y }, bodyR, avoid);
  if (standClear(state, near, bodyR)) return near;
  return sp; // still better than the collider centre — the slide-out heads for the edge
}

/**
 * THE CONTACT HANDOFF TEST — is this body close enough to `fixtureId` for the
 * anchor to take it and slide it on? True when the body stands within
 * {@link ENGAGE_SPOT_REACH} of the piece's stand-off (the point every use-walk
 * actually steers to — recomputed here from pure geometry, body-avoidance left
 * out so the answer is deterministic), or is pressed right against / standing on
 * the piece itself. A walk that ends anywhere else has NOT arrived — the
 * pursuit's own arrival gate judges by the same contract (distance to the
 * committed arrival spot), so the two can never disagree about whether the last
 * leg still needs walking.
 */
export function withinEngageReach(
  state: WorldState,
  fixtureId: string,
  body: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
): boolean {
  const spec = state.spec.objects.find((s) => s.id === fixtureId);
  const obj = state.objects[fixtureId];
  if (!spec || !obj) return false;
  const r = spec.radius ?? 0.5;
  if (Math.hypot(body.x - obj.x, body.y - obj.y) <= r + bodyR + ENGAGE_CONTACT_SLACK) return true;
  const sp = standPointFor(state, fixtureId, { x: obj.x, y: obj.y }, body, bodyR);
  return Math.hypot(body.x - sp.x, body.y - sp.y) <= ENGAGE_SPOT_REACH;
}

/** ENGAGE: start easing a claiming body onto its fixture. Sets the anchor to
 *  `sliding-in`, capturing the CURRENT position as the slide start and the use
 *  point as the end. Only fires when the body's activity NAMES an on-fixture kind
 *  and it passes {@link withinEngageReach} (the contact handoff). No-op (returns
 *  false) otherwise / if already anchored. */
export function engageFurnitureAnchor(
  state: WorldState,
  avatarId: string,
  deps: AnchorDeps = {},
): boolean {
  const a = state.avatars[avatarId];
  if (!a || a.anchor) return false;
  const t = onFixtureTargetOf(state, a.activity?.objId);
  if (!t) return false;
  const bodyR = deps.bodyR ?? DEFAULT_BODY_RADIUS_M;
  if (!withinEngageReach(state, t.fixtureId, a, bodyR)) return false;
  a.anchor = { fixtureId: t.fixtureId, phase: "sliding-in", from: { x: a.x, y: a.y }, target: t.target, t: 0 };
  return true;
}

/** RELEASE: begin sliding a body OFF its fixture toward a validated dismount spot
 *  — capturing the current position as the new slide start. Idempotent — no-op if
 *  not anchored or already sliding out. Exposed so a host can force a dismount (a
 *  command to walk away) as well as the automatic release when the claim drops. */
export function releaseFurnitureAnchor(
  state: WorldState,
  avatarId: string,
  deps: AnchorDeps = {},
): void {
  const a = state.avatars[avatarId];
  const anc = a?.anchor;
  if (!a || !anc || anc.phase === "sliding-out") return;
  anc.from = { x: a.x, y: a.y };
  anc.target = dismountSpot(state, a, anc.fixtureId, deps);
  anc.t = 0;
  anc.phase = "sliding-out";
}

/** Hold a body EXACTLY on its use point, dead still, facing the fixture's own
 *  facing — the heading the use-point contract expects for an on-fixture use
 *  (furnitureUsePoseDump reads it, so the debug yaw delta reads ~0) and what a 2D
 *  view points the body at. The 3D pose owns its own yaw via the render mirror
 *  (bedSleeperYaw / sitterYaw), independent of this. */
function pinOnUsePoint(state: WorldState, a: AvatarState, anc: NonNullable<AvatarState["anchor"]>): void {
  a.x = anc.target.x;
  a.y = anc.target.y;
  a.vx = 0;
  a.vy = 0;
  const spec = state.spec.objects.find((s) => s.id === anc.fixtureId);
  const facing = spec?.facing ?? 0;
  a.fx = Math.cos(facing);
  a.fy = Math.sin(facing);
}

/** Advance one slide phase by `step` seconds: interpolate the body from the
 *  captured start toward the end along an eased parameter. Position is set
 *  directly (not integrated from velocity); `vx`/`vy` and the facing are DERIVED
 *  from the position delta purely so the renderer's speed-driven pose blend and a
 *  2D view read a sensible motion. Returns true once the slide has completed
 *  (t reached 1). */
function advanceSlide(a: AvatarState, anc: NonNullable<AvatarState["anchor"]>, step: number): boolean {
  const dx = anc.target.x - anc.from.x;
  const dy = anc.target.y - anc.from.y;
  const dist = Math.hypot(dx, dy);
  const dur = Math.min(SLIDE_MAX_S, Math.max(SLIDE_MIN_S, dist / SLIDE_SPEED));
  anc.t = Math.min(1, anc.t + (step > 0 ? step / dur : 1));
  const e = smoothstep(anc.t);
  const ox = a.x;
  const oy = a.y;
  a.x = anc.from.x + dx * e;
  a.y = anc.from.y + dy * e;
  // Derived motion (for the renderer's speed-gated slide + facing) — NOT the
  // driver of position.
  a.vx = step > 0 ? (a.x - ox) / step : 0;
  a.vy = step > 0 ? (a.y - oy) / step : 0;
  const sp = Math.hypot(a.vx, a.vy);
  if (sp > 1e-4) {
    a.fx = a.vx / sp;
    a.fy = a.vy / sp;
  }
  return anc.t >= 1;
}

/**
 * THE PER-FRAME DRIVER — call once per body per frame BEFORE the ordinary
 * steering. Returns TRUE when the anchor owns this body's movement this frame (so
 * the caller must SKIP its normal steer — no tug-of-war). Returns FALSE when the
 * body is free (no on-fixture claim in reach, or the slide-out just finished).
 *
 * It engages on contact, releases the instant the claim drops, and drives the
 * active phase:
 *   • sliding-in  — interpolate to the use point; on arrival → anchored (pinned +
 *                   facing the fixture).
 *   • anchored    — hold the body exactly on the use point, velocity zero.
 *   • sliding-out — interpolate to the dismount spot; on arrival → clear the
 *                   anchor and hand control back.
 */
export function tickFurnitureAnchor(
  state: WorldState,
  avatarId: string,
  dt: number,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
  deps: AnchorDeps = {},
): boolean {
  const a = state.avatars[avatarId];
  if (!a) return false;

  // RELEASE first: an anchored body whose claim has dropped (need met, interrupted,
  // commanded away — every path clears/replaces `activity`) starts sliding out.
  if (a.anchor && a.anchor.phase !== "sliding-out" && !bodyClaimsFixture(state, a, a.anchor.fixtureId)) {
    releaseFurnitureAnchor(state, avatarId, deps);
  }

  // ENGAGE: a claiming body within reach of an unclaimed anchor takes it.
  if (!a.anchor) {
    if (!engageFurnitureAnchor(state, avatarId, deps)) return false;
  }

  const anc = a.anchor;
  if (!anc) return false;
  const step = Math.min(Math.max(dt, 0), config.maxStep);

  if (anc.phase === "anchored") {
    pinOnUsePoint(state, a, anc);
    return true;
  }

  // sliding-in / sliding-out: an eased position interpolation between the captured
  // endpoints (crosses the claimed fixture's footprint freely — it is set, not
  // steered).
  const done = advanceSlide(a, anc, step);
  if (done) {
    if (anc.phase === "sliding-in") {
      // Settle exactly ON the use point AND face the fixture in the SAME tick — so
      // the body reads correct the instant it anchors (no one-frame stale heading).
      anc.phase = "anchored";
      pinOnUsePoint(state, a, anc);
    } else {
      // sliding-out complete — the body is at a validated spot outside the
      // collider; drop the anchor so normal locomotion (and separation) resume.
      delete a.anchor;
      return false;
    }
  }
  return true;
}

/** Is this body currently held by the anchor (any phase)? world-host excludes
 *  such bodies from the crowding-separation pass — a body ON a fixture must not be
 *  pushed off it, and it blocks the room no more than the fixture already does. */
export function isFurnitureAnchored(a: AvatarState | undefined): boolean {
  return !!a?.anchor;
}
