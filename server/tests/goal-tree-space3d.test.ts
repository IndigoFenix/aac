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
import { certifyGoalTreeGame } from "@shared/goal-tree/index.js";
import type { LogicalWorld } from "@shared/goal-tree/logical-world.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeState,
} from "@shared/goal-tree/runtime.js";
import type { RuntimeEvent, SpaceInput } from "@shared/goal-tree/space.js";
import { rectCenter, rectContains, type Vec2 } from "@shared/goal-tree/layout2d.js";
import {
  applySpace3DCommand,
  createSpace3DState,
  detectSpace3D,
  embedLayoutInWorld,
  makeWallConstraint,
  PLAYER_ID,
  type Space3DState,
  type WorldEmbedding,
} from "@shared/goal-tree/space3d.js";
import { createWorldState, steerAvatar, type WorldState } from "@shared/world-engine/engine.js";
import { picnicGame } from "./helpers/goal-tree-fixtures.js";

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
function figurePos(session: Session, nodeId: string): Vec2 {
  const f = session.embedding.layout.figures.find((x) => x.nodeId === nodeId);
  if (!f) throw new Error(`no figure for node ${nodeId}`);
  return f.pos;
}
function itemPos(session: Session, instanceId: string): Vec2 {
  const it = session.embedding.layout.items.find((x) => x.instanceId === instanceId);
  if (!it) throw new Error(`no item ${instanceId}`);
  return it.pos;
}
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

const P_LOGS = "passage:start->zone:gather_logs";
const P_POCKET = "passage:zone:gather_logs->pocket:gather_logs:1";
const P_PICNIC = "passage:start->zone:picnic";
const Z_LOGS = "zone:gather_logs";
const Z_POCKET = "pocket:gather_logs:1";
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

  it("plays the picnic game to a win driven by world-engine locomotion", () => {
    const session = createSession();
    const reached = (z: string) => () => session.sState.zoneId === z;
    const done = (id: string) => () => session.rState.completed[id] === true;
    const got = (id: string) => () => session.sState.removed[id] === true;

    // 1. Through the (open) passage into the log room, gather the two free logs.
    expect(steerUntil(session, throughPoint(session, P_LOGS, Z_LOGS), reached(Z_LOGS))).toBe(true);
    expect(steerUntil(session, itemPos(session, "item:gather_logs:0:0"), got("item:gather_logs:0:0"))).toBe(true);
    expect(steerUntil(session, itemPos(session, "item:gather_logs:0:1"), got("item:gather_logs:0:1"))).toBe(true);

    // 2. Answer the squirrel (the gate's key).
    expect(
      steerUntil(session, figurePos(session, "match_key"),
        () => session.rState.activeChoiceNodeId === "match_key"),
    ).toBe(true);
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });
    expect(session.rState.completed["match_key"]).toBe(true);

    // 3. Walk into the locked gate → it clears (key done) → pocket opens.
    expect(steerUntil(session, throughPoint(session, P_POCKET, Z_POCKET), done("log_gate"))).toBe(true);

    // 4. Collect the third log → finishes the collect goal (the bridge's key).
    expect(steerUntil(session, itemPos(session, "item:gather_logs:1:0"), done("gather_logs"))).toBe(true);

    // 5. Head back to the start room and fix the bridge.
    expect(steerUntil(session, throughPoint(session, P_POCKET, Z_LOGS), reached(Z_LOGS))).toBe(true);
    expect(steerUntil(session, throughPoint(session, P_LOGS, "start"), reached("start"))).toBe(true);
    expect(steerUntil(session, throughPoint(session, P_PICNIC, Z_PICNIC), done("bridge_out"))).toBe(true);

    // 6. The bridge is open — reach the picnic and win.
    expect(steerUntil(session, figurePos(session, "picnic"), () => session.rState.won === true)).toBe(true);
    expect(session.events.some((e) => e.type === "game-won")).toBe(true);
  });
});
