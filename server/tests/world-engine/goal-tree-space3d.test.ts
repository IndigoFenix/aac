// Phase-0 merge-spike test: the goal-tree quest runtime, unchanged, played to a
// win through Space3D — i.e. driven by the WORLD ENGINE's locomotion (now with
// real wall collision) instead of Space2D. Pure-logic, no DB / no LLM, headless
// (no GL): safe in `npm test`.
//
// Walls are physical here: the avatar can't cross a locked door, so it must be
// routed through door openings (arrive-steering stops short of a point aimed AT
// it, so we aim at "through points" just past each doorway). The wall-seal test
// pins the collision directly — the avatar can never enter the locked room.

import { describe, it, expect } from "@jest/globals";
import { certifyGoalTreeGame } from "@shared/world-engine/solver/index.js";
import type { LogicalWorld } from "@shared/world-engine/solver/logical-world.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeState,
} from "@shared/world-engine/solver/runtime.js";
import type { RuntimeEvent, SpaceInput } from "@shared/world-engine/solver/space.js";
import { rectCenter, rectContains, type Vec2 } from "@shared/world-engine/solver/layout2d.js";
import {
  applySpace3DCommand,
  createSpace3DState,
  detectSpace3D,
  embedLayoutInWorld,
  makeWallConstraint,
  PLAYER_ID,
  type Space3DState,
  type WorldEmbedding,
} from "@shared/world-engine/solver/space3d.js";
import { createWorldState, steerAvatar, type WorldState } from "@shared/world-engine/engine.js";
import { picnicGame } from "../helpers/goal-tree-fixtures.js";

// ---------------------------------------------------------------------------
// Session harness: runtime + Space3D wired the way the 3D player wires them
// ---------------------------------------------------------------------------

interface Session {
  ctx: RuntimeContext;
  world: LogicalWorld;
  embedding: WorldEmbedding;
  /** The engine WorldState the avatar lives in (the host owns this in the app). */
  world3d: WorldState;
  rState: RuntimeState;
  sState: Space3DState;
  events: RuntimeEvent[];
}

function createSession(): Session {
  const game = picnicGame();
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    throw new Error(`picnic failed certification: ${certified.errors.join("; ")}`);
  }
  const world = certified.world;
  const embedding = embedLayoutInWorld(certified.layout);
  const session: Session = {
    ctx: createRuntimeContext(game, world),
    world,
    embedding,
    world3d: createWorldState(embedding.spec, PLAYER_ID, 0),
    rState: createRuntimeState(),
    sState: createSpace3DState(world),
    events: [],
  };
  dispatch(session, { type: "start" });
  return session;
}

function dispatch(session: Session, input: SpaceInput): void {
  const result = applyRuntimeInput(session.ctx, session.rState, input);
  session.rState = result.state;
  session.events.push(...result.events);
  for (const command of result.commands) {
    applySpace3DCommand(session.sState, command);
  }
}

const DT = 0.05;

function tick(session: Session, aim: Vec2 | null): void {
  // Simulate one host frame: engine locomotion (constrained by the quest walls)
  // then quest proximity detection — exactly what runWorldHost + onFrame do.
  const constraint = makeWallConstraint(session.embedding.layout, session.sState);
  steerAvatar(session.world3d, PLAYER_ID, aim, DT, undefined, constraint);
  const me = session.world3d.avatars[PLAYER_ID];
  for (const input of detectSpace3D(session.embedding.layout, session.sState, { x: me.x, y: me.y }, DT)) {
    dispatch(session, input);
  }
}

/** Steer toward `aim` until the predicate holds (or sim-time runs out). */
function steerUntil(
  session: Session,
  aim: Vec2 | null,
  predicate: () => boolean,
  maxSeconds = 30,
): boolean {
  const ticks = Math.ceil(maxSeconds / DT);
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true;
    tick(session, aim);
  }
  return predicate();
}

// Target lookups in the embedded (translated) layout the avatar shares.
function zoneRect(session: Session, zoneId: string) {
  const z = session.embedding.layout.zones.find((x) => x.zoneId === zoneId);
  if (!z) throw new Error(`no zone ${zoneId}`);
  return z.rect;
}
function doorCenter(session: Session, passageId: string): Vec2 {
  const d = session.embedding.layout.doors.find((x) => x.passageId === passageId);
  if (!d) throw new Error(`no door for passage ${passageId}`);
  return rectCenter(d.rect);
}

/** A point just past a doorway, inside `intoZoneId` — aiming here pulls the
 *  avatar through the door (arrive-steering settles a hair short of the aim, so
 *  aiming AT the door center would stop it in the wall). */
function throughPoint(session: Session, passageId: string, intoZoneId: string): Vec2 {
  const c = doorCenter(session, passageId);
  const zc = rectCenter(zoneRect(session, intoZoneId));
  const dx = zc.x - c.x;
  const dy = zc.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: c.x + (dx / d) * 1.6, y: c.y + (dy / d) * 1.6 };
}

// The one route still walked: from the start room at the locked picnic bridge.
const P_PICNIC = "passage:start->zone:picnic";
const Z_PICNIC = "zone:picnic";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("goal-tree Space3D (world-engine merge spike)", () => {
  it("embeds the certified layout in a positive, single-spawn world", () => {
    const certified = certifyGoalTreeGame(picnicGame());
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    const { spec, layout } = embedLayoutInWorld(certified.layout);
    expect(spec.manifold.width).toBeGreaterThan(0);
    expect(spec.manifold.height).toBeGreaterThan(0);
    expect(spec.spawns).toHaveLength(1);
    for (const z of layout.zones) {
      expect(z.rect.x).toBeGreaterThanOrEqual(0);
      expect(z.rect.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("places the avatar at the (translated) spawn", () => {
    const session = createSession();
    const a = session.world3d.avatars[PLAYER_ID];
    expect(a.x).toBeCloseTo(session.embedding.layout.spawn.x, 5);
    expect(a.y).toBeCloseTo(session.embedding.layout.spawn.y, 5);
  });

  it("walls physically seal a room behind a locked door", () => {
    const session = createSession();
    // Steer straight at the picnic (across the locked bridge) for 12s. The solid
    // door must keep the avatar out of the picnic room — no walking through it.
    steerUntil(session, throughPoint(session, P_PICNIC, Z_PICNIC), () => false, 12);
    const a = session.world3d.avatars[PLAYER_ID];
    expect(rectContains(zoneRect(session, Z_PICNIC), { x: a.x, y: a.y })).toBe(false);
    expect(session.rState.completed["picnic"]).toBeUndefined();
    expect(session.rState.won).toBe(false);
  });

  // REMOVED: "plays the picnic game to a win driven by world-engine locomotion".
  //
  // A Phase-0 spike that drove the whole picnic goal-tree to a win by scripted
  // steering — six legs of aim-at-a-through-point, each asserting a quest node
  // completed on the way past. It was a walkthrough, not a contract: what it
  // actually pinned was that one authored game could be finished by aiming at
  // hard-coded points, so every tightening of door-transit or arrival behaviour
  // re-broke a step of the script without any of them being wrong. It finally
  // stuck at leg 5, where crossing back through the picnic doorway no longer
  // completed `bridge_out` inside the time cap.
  //
  // The three tests above are the part worth keeping: embedding, spawn
  // placement and the wall seal are live surface (`embedLayoutInWorld` /
  // `makeWallConstraint` are used by quest-host and scene.ts), and they assert
  // properties rather than replaying a script. Locomotion through doorways is
  // covered by world-engine-structures.test.ts, and the goal-tree runtime by
  // the four other goal-tree suites, which still use the same picnic fixture.
});
