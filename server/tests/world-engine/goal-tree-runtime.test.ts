// Tests for the goal-tree quest runtime and the headless Space2D simulation.
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.
//
// The walk-mode integration test is the engine's own "automated playtest":
// a scripted player completes the flagship picnic game end-to-end through
// the real movement/collision/door/pickup pipeline.

import { describe, it, expect } from "@jest/globals";
import { buildLogicalWorld } from "@shared/world-engine/solver/logical-world.js";
import type { LogicalWorld } from "@shared/world-engine/solver/logical-world.js";
import {
  applyRuntimeInput,
  computeObjectives,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeState,
} from "@shared/world-engine/solver/runtime.js";
import type {
  RuntimeEvent,
  SpaceCommand,
  SpaceInput,
} from "@shared/world-engine/solver/space.js";
import type { Layout2D, Vec2 } from "@shared/world-engine/solver/layout2d.js";
import {
  applySpace2DCommand,
  createSpace2DState,
  setWalkTarget,
  tickSpace2D,
  type Space2DState,
  type WalkIntent,
} from "@shared/world-engine/solver/space2d.js";
import { validateLayout2D } from "@shared/world-engine/solver/projector2d.js";
import { picnicGame } from "../helpers/goal-tree-fixtures.js";

// ---------------------------------------------------------------------------
// Session harness: runtime + space wired the way a client would wire them
// ---------------------------------------------------------------------------

interface Session {
  ctx: RuntimeContext;
  world: LogicalWorld;
  layout: Layout2D;
  rState: RuntimeState;
  sState: Space2DState;
  events: RuntimeEvent[];
  commands: SpaceCommand[];
}

/** Hand-authored layout for the picnic game's logical world (step 4's map
 * projector will generate layouts like this automatically). */
function picnicLayout(): Layout2D {
  return {
    zones: [
      { zoneId: "start", rect: { x: 0, y: 0, w: 10, h: 10 } },
      { zoneId: "zone:gather_logs", rect: { x: 10, y: 0, w: 10, h: 10 } },
      { zoneId: "pocket:gather_logs:1", rect: { x: 20, y: 0, w: 6, h: 6 } },
      { zoneId: "zone:picnic", rect: { x: 0, y: 10, w: 10, h: 8 } },
    ],
    doors: [
      {
        passageId: "passage:start->zone:gather_logs",
        rect: { x: 9.5, y: 4, w: 1, h: 2 },
      },
      {
        passageId: "passage:zone:gather_logs->pocket:gather_logs:1",
        rect: { x: 19.5, y: 2, w: 1, h: 2 },
      },
      {
        passageId: "passage:start->zone:picnic",
        rect: { x: 4, y: 9.5, w: 2, h: 1 },
      },
    ],
    figures: [
      { nodeId: "match_key", entityId: "squirrel", pos: { x: 15, y: 5 } },
      { nodeId: "picnic", entityId: "picnic_blanket", pos: { x: 5, y: 14 } },
    ],
    items: [
      { instanceId: "item:gather_logs:0:0", entityId: "log", pos: { x: 12, y: 3 } },
      { instanceId: "item:gather_logs:0:1", entityId: "log", pos: { x: 17, y: 7 } },
      { instanceId: "item:gather_logs:1:0", entityId: "log", pos: { x: 23, y: 3 } },
      {
        instanceId: "distractor:acorn:0",
        entityId: "acorn",
        pos: { x: 13, y: 8 },
        distractor: true,
      },
    ],
    spawn: { x: 5, y: 5 },
  };
}

function createSession(): Session {
  const game = picnicGame();
  const world = buildLogicalWorld(game);
  const ctx = createRuntimeContext(game, world);
  const layout = picnicLayout();
  const session: Session = {
    ctx,
    world,
    layout,
    rState: createRuntimeState(),
    sState: createSpace2DState(layout, world),
    events: [],
    commands: [],
  };
  dispatch(session, { type: "start" });
  return session;
}

function dispatch(session: Session, input: SpaceInput): void {
  const result = applyRuntimeInput(session.ctx, session.rState, input);
  session.rState = result.state;
  session.events.push(...result.events);
  session.commands.push(...result.commands);
  for (const command of result.commands) {
    session.sState = applySpace2DCommand(session.sState, command);
  }
}

const DT = 0.05;

function tick(session: Session, steer: Vec2 | null = null): void {
  const result = tickSpace2D(session.layout, session.sState, { steer }, DT);
  session.sState = result.state;
  for (const input of result.inputs) dispatch(session, input);
}

/** Tick until the predicate holds; throws on sim-time timeout. */
function runUntil(
  session: Session,
  predicate: () => boolean,
  options: { steer?: Vec2 | null; maxSeconds?: number } = {},
): void {
  const maxSeconds = options.maxSeconds ?? 30;
  const ticks = Math.ceil(maxSeconds / DT);
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    tick(session, options.steer ?? null);
  }
  if (!predicate()) {
    throw new Error(`runUntil timed out after ${maxSeconds}s of sim time`);
  }
}

function walkTo(session: Session, point: Vec2, intent: WalkIntent): void {
  session.sState = setWalkTarget(
    session.layout,
    session.world,
    session.sState,
    point,
    intent,
  );
  runUntil(session, () => session.sState.target === null);
}

function eventsOf<T extends RuntimeEvent["type"]>(
  session: Session,
  type: T,
): Extract<RuntimeEvent, { type: T }>[] {
  return session.events.filter(
    (e): e is Extract<RuntimeEvent, { type: T }> => e.type === type,
  );
}

// ---------------------------------------------------------------------------
// Runtime (direct inputs — a mock space)
// ---------------------------------------------------------------------------

describe("goal-tree runtime", () => {
  it("hand layout passes the shared layout validator", () => {
    const session = createSession();
    expect(
      validateLayout2D(session.ctx.game, session.world, session.layout),
    ).toEqual([]);
  });

  it("expands target item instances with stable ids", () => {
    const session = createSession();
    expect(session.ctx.instances.map((i) => i.id)).toEqual([
      "item:gather_logs:0:0",
      "item:gather_logs:0:1",
      "item:gather_logs:1:0",
    ]);
  });

  it("start emits the root intro and the initial objectives", () => {
    const session = createSession();
    const narrations = eventsOf(session, "narrate");
    expect(narrations[0]).toMatchObject({
      kind: "intro",
      text: "Let's get to the picnic!",
    });
    const objectives = eventsOf(session, "objectives-changed").at(-1)!.objectives;
    // picnic's zone is locked away; everything else is on the frontier.
    expect(objectives.map((o) => [o.nodeId, o.locked])).toEqual([
      ["bridge_out", true],
      ["gather_logs", false],
      ["log_gate", true],
      ["match_key", false],
    ]);
  });

  it("plays the picnic game through with scripted inputs", () => {
    const session = createSession();

    // Touch the squirrel → choice presented, without leaking the answer.
    dispatch(session, { type: "touch-figure", nodeId: "match_key" });
    const presented = session.commands.find((c) => c.type === "present-choice");
    expect(presented).toMatchObject({
      nodeId: "match_key",
      options: [{ entityId: "key_round" }, { entityId: "key_square" }],
    });
    expect(JSON.stringify(presented)).not.toContain("correct");

    // Wrong pick → feedback, panel stays open.
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_round" });
    expect(eventsOf(session, "wrong-choice")).toHaveLength(1);
    expect(session.rState.activeChoiceNodeId).toBe("match_key");
    expect(session.rState.completed["match_key"]).toBeUndefined();

    // Correct pick → completed + dismissed.
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });
    expect(session.rState.completed["match_key"]).toBe(true);
    expect(session.commands.some((c) => c.type === "dismiss-choice")).toBe(true);

    // Gate clears now that its key is done.
    dispatch(session, {
      type: "touch-door",
      passageId: "passage:zone:gather_logs->pocket:gather_logs:1",
    });
    expect(eventsOf(session, "guard-cleared").map((e) => e.nodeId)).toEqual([
      "log_gate",
    ]);
    expect(session.commands.filter((c) => c.type === "unlock-passage")).toEqual([
      {
        type: "unlock-passage",
        passageId: "passage:zone:gather_logs->pocket:gather_logs:1",
      },
    ]);

    // Collect all three logs.
    for (const instanceId of [
      "item:gather_logs:0:0",
      "item:gather_logs:0:1",
      "item:gather_logs:1:0",
    ]) {
      dispatch(session, { type: "pick-item", instanceId, entityId: "log" });
    }
    const collected = eventsOf(session, "item-collected");
    expect(collected.map((e) => [e.have, e.need])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(session.rState.completed["gather_logs"]).toBe(true);

    // Bridge clears, picnic reachable, marker touch wins.
    dispatch(session, { type: "touch-door", passageId: "passage:start->zone:picnic" });
    expect(session.rState.completed["bridge_out"]).toBe(true);
    dispatch(session, { type: "touch-figure", nodeId: "picnic" });
    expect(session.rState.won).toBe(true);
    expect(eventsOf(session, "game-won")).toHaveLength(1);
    expect(session.commands.some((c) => c.type === "celebrate")).toBe(true);
  });

  it("keeps a locked obstacle locked and narrates its prompt", () => {
    const session = createSession();
    dispatch(session, { type: "touch-door", passageId: "passage:start->zone:picnic" });
    expect(eventsOf(session, "obstacle-locked")).toEqual([
      { type: "obstacle-locked", nodeId: "bridge_out", prompt: "The bridge is out!" },
    ]);
    expect(session.rState.completed["bridge_out"]).toBeUndefined();
    expect(session.commands.some((c) => c.type === "unlock-passage")).toBe(false);
  });

  it("treats distractor picks as feedback, never progress", () => {
    const session = createSession();
    dispatch(session, {
      type: "pick-item",
      instanceId: "distractor:acorn:0",
      entityId: "acorn",
    });
    expect(eventsOf(session, "distractor-picked")).toEqual([
      { type: "distractor-picked", entityId: "acorn" },
    ]);
    expect(session.rState.collectedCount["gather_logs"]).toBeUndefined();
  });

  it("ignores duplicate picks and stale option selections", () => {
    const session = createSession();
    dispatch(session, { type: "pick-item", instanceId: "item:gather_logs:0:0", entityId: "log" });
    dispatch(session, { type: "pick-item", instanceId: "item:gather_logs:0:0", entityId: "log" });
    expect(session.rState.collectedCount["gather_logs"]).toBe(1);

    // No choice presented → selection is a no-op.
    const before = session.events.length;
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });
    expect(session.events.length).toBe(before);
    expect(session.rState.completed["match_key"]).toBeUndefined();
  });

  it("cancel-choice closes the panel without completing, and it re-presents", () => {
    const session = createSession();
    dispatch(session, { type: "touch-figure", nodeId: "match_key" });
    expect(session.rState.activeChoiceNodeId).toBe("match_key");

    // Close without answering → dismissed, NOT completed.
    dispatch(session, { type: "cancel-choice", nodeId: "match_key" });
    expect(session.rState.activeChoiceNodeId).toBeNull();
    expect(session.commands.some((c) => c.type === "dismiss-choice")).toBe(true);
    expect(session.rState.completed["match_key"]).toBeUndefined();

    // Returning to the poser re-presents the question; it's still answerable.
    session.commands.length = 0;
    dispatch(session, { type: "touch-figure", nodeId: "match_key" });
    expect(session.commands.some((c) => c.type === "present-choice")).toBe(true);
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });
    expect(session.rState.completed["match_key"]).toBe(true);
  });

  it("updates objectives as zones unlock", () => {
    const session = createSession();
    dispatch(session, { type: "touch-figure", nodeId: "match_key" });
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });
    const objectives = computeObjectives(session.ctx, session.rState);
    // log_gate is now actionable (key complete), bridge still locked.
    expect(objectives.find((o) => o.nodeId === "log_gate")?.locked).toBe(false);
    expect(objectives.find((o) => o.nodeId === "bridge_out")?.locked).toBe(true);
    expect(objectives.find((o) => o.nodeId === "picnic")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Space2D — walk mode (point-and-click / dwell-to-walk)
// ---------------------------------------------------------------------------

describe("space2d walk mode", () => {
  it("auto-plays the full picnic game through movement and doors", () => {
    const session = createSession();

    // 1. Walk to the squirrel and answer its question.
    walkTo(session, { x: 15, y: 5 }, { kind: "figure", nodeId: "match_key" });
    expect(session.commands.some((c) => c.type === "present-choice")).toBe(true);
    dispatch(session, { type: "select-option", nodeId: "match_key", entityId: "key_square" });

    // 2. Free logs.
    walkTo(session, { x: 12, y: 3 }, { kind: "item", instanceId: "item:gather_logs:0:0" });
    walkTo(session, { x: 17, y: 7 }, { kind: "item", instanceId: "item:gather_logs:0:1" });
    expect(session.rState.collectedCount["gather_logs"]).toBe(2);

    // 3. Head for the pocket log: the locked gate interrupts the walk and
    //    clears (its key is done), then the retry goes through.
    walkTo(session, { x: 23, y: 3 }, { kind: "item", instanceId: "item:gather_logs:1:0" });
    expect(session.rState.completed["log_gate"]).toBe(true);
    walkTo(session, { x: 23, y: 3 }, { kind: "item", instanceId: "item:gather_logs:1:0" });
    expect(session.rState.completed["gather_logs"]).toBe(true);

    // 4. Head for the picnic: the broken bridge interrupts, clears, retry wins.
    walkTo(session, { x: 5, y: 14 }, { kind: "figure", nodeId: "picnic" });
    expect(session.rState.completed["bridge_out"]).toBe(true);
    walkTo(session, { x: 5, y: 14 }, { kind: "figure", nodeId: "picnic" });

    expect(session.rState.won).toBe(true);
    // Completion order matches the solver's certified plan shape.
    expect(eventsOf(session, "goal-completed").map((e) => e.nodeId)).toEqual([
      "match_key",
      "log_gate",
      "gather_logs",
      "bridge_out",
      "picnic",
    ]);
    // The player physically crossed zones along the way.
    expect(
      eventsOf(session, "zone-entered").map((e) => e.zoneId),
    ).toContain("pocket:gather_logs:1");
  });

  it("emits a single pickup per radius entry (edge-triggered)", () => {
    const session = createSession();
    walkTo(session, { x: 13, y: 8 }, { kind: "point" });
    // Standing on the acorn: exactly one feedback event despite many ticks.
    for (let i = 0; i < 40; i++) tick(session);
    expect(eventsOf(session, "distractor-picked")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Space2D — steer mode (continuous gaze)
// ---------------------------------------------------------------------------

describe("space2d steer mode", () => {
  it("steers through an open door into the next zone", () => {
    const session = createSession();
    runUntil(
      session,
      () => session.sState.zoneId === "zone:gather_logs",
      { steer: { x: 15, y: 5 }, maxSeconds: 10 },
    );
    expect(eventsOf(session, "zone-entered").map((e) => e.zoneId)).toContain(
      "zone:gather_logs",
    );
  });

  it("turns a locked door bump into an obstacle interaction, with cooldown", () => {
    const session = createSession();
    // Steer at the picnic across the broken bridge for 2.5 sim-seconds.
    const ticks = Math.ceil(2.5 / DT);
    for (let i = 0; i < ticks; i++) tick(session, { x: 5, y: 14 });

    const locked = eventsOf(session, "obstacle-locked");
    expect(locked.length).toBeGreaterThanOrEqual(1);
    expect(locked.length).toBeLessThanOrEqual(2); // cooldown limits spam
    expect(locked[0].nodeId).toBe("bridge_out");
    // Still walled off: the player never crossed.
    expect(session.sState.zoneId).toBe("start");
  });

  it("rests in place when there is no gaze", () => {
    const session = createSession();
    const before = { ...session.sState.pos };
    for (let i = 0; i < 20; i++) tick(session, null);
    expect(session.sState.pos).toEqual(before);
  });
});
