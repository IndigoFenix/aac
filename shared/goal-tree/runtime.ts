// shared/goal-tree/runtime.ts
//
// The space-agnostic quest runtime: a pure reducer over the goal tree.
// It is the playable mirror of the solver's completion rules:
//   reach    — completes when its marker figure is touched
//   choose   — present on poser touch; correct option completes, wrong
//              options give feedback and keep the panel open (failure-free)
//   collect  — completes when `count` target instances are picked;
//              distractor picks emit gentle feedback only
//   overcome — touching the obstacle/door clears it iff its key goal is
//              complete; otherwise it stays locked with a prompt
//   observe  — touching the stage plays its demonstration + completes (a beat
//              the child watches; it never gates)
//
// State is JSON-serializable; the immutable context (game, world, lookup
// maps, expanded item instances) is built once per session. All inputs are
// idempotent/no-op safe — repeated touches and stale picks cannot corrupt
// state, which matters for eyegaze input.

import type { GoalNode, GoalTreeGame, OvercomeNode } from "./types.js";
import type { LogicalWorld, PassageSpec } from "./logical-world.js";
import { walkGoalTree } from "./walk.js";
import type {
  NarrationKind,
  ObjectiveSummary,
  RuntimeEvent,
  SpaceCommand,
  SpaceInput,
} from "./space.js";

// ---------------------------------------------------------------------------
// Context + state
// ---------------------------------------------------------------------------

/** A concrete collectible placed in the world. Targets only — distractor
 * instances are space-side garnish the runtime never tracks. */
export interface ItemInstance {
  id: string;
  entityId: string;
  forNodeId: string;
  zoneId: string;
}

export interface RuntimeContext {
  game: GoalTreeGame;
  world: LogicalWorld;
  nodeById: Map<string, GoalNode>;
  instances: ItemInstance[];
  instanceById: Map<string, ItemInstance>;
  /** Passages each overcome node guards (usually one). */
  passagesByGuard: Map<string, PassageSpec[]>;
}

export interface RuntimeState {
  started: boolean;
  won: boolean;
  completed: Record<string, true>;
  /** Picked target instances. */
  picked: Record<string, true>;
  /** Collected count per collect node. */
  collectedCount: Record<string, number>;
  /** Choose node currently presented, if any. */
  activeChoiceNodeId: string | null;
}

export interface RuntimeResult {
  state: RuntimeState;
  events: RuntimeEvent[];
  commands: SpaceCommand[];
}

export function createRuntimeContext(
  game: GoalTreeGame,
  world: LogicalWorld,
): RuntimeContext {
  const nodeById = new Map<string, GoalNode>();
  for (const { node } of walkGoalTree(game.root)) nodeById.set(node.id, node);

  const instances: ItemInstance[] = [];
  world.items.forEach((placement, placementIndex) => {
    for (let i = 0; i < placement.count; i++) {
      instances.push({
        id: `item:${placement.forNodeId}:${placementIndex}:${i}`,
        entityId: placement.itemEntityIds[i % placement.itemEntityIds.length],
        forNodeId: placement.forNodeId,
        zoneId: placement.zoneId,
      });
    }
  });

  const passagesByGuard = new Map<string, PassageSpec[]>();
  for (const passage of world.passages) {
    for (const guard of passage.guards) {
      const list = passagesByGuard.get(guard.overcomeNodeId) ?? [];
      list.push(passage);
      passagesByGuard.set(guard.overcomeNodeId, list);
    }
  }

  return {
    game,
    world,
    nodeById,
    instances,
    instanceById: new Map(instances.map((inst) => [inst.id, inst])),
    passagesByGuard,
  };
}

export function createRuntimeState(): RuntimeState {
  return {
    started: false,
    won: false,
    completed: {},
    picked: {},
    collectedCount: {},
    activeChoiceNodeId: null,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyRuntimeInput(
  ctx: RuntimeContext,
  state: RuntimeState,
  input: SpaceInput,
): RuntimeResult {
  const out: RuntimeResult = {
    state: cloneState(state),
    events: [],
    commands: [],
  };
  if (out.state.won && input.type !== "enter-zone") return out;

  switch (input.type) {
    case "start":
      handleStart(ctx, out);
      break;
    case "touch-figure":
      handleTouchFigure(ctx, out, input.nodeId);
      break;
    case "touch-door":
      handleTouchDoor(ctx, out, input.passageId);
      break;
    case "pick-item":
      handlePickItem(ctx, out, input.instanceId, input.entityId);
      break;
    case "select-option":
      handleSelectOption(ctx, out, input.nodeId, input.entityId);
      break;
    case "cancel-choice":
      // Close the panel WITHOUT completing the goal. The choose re-presents
      // when the player returns to the poser, so nothing is lost — this just
      // frees a player from a confusing/stuck question (failure-free).
      if (out.state.activeChoiceNodeId === input.nodeId) {
        out.state.activeChoiceNodeId = null;
        out.commands.push({ type: "dismiss-choice", nodeId: input.nodeId });
      }
      break;
    case "enter-zone": {
      const zone = ctx.world.zones.find((z) => z.id === input.zoneId);
      out.events.push({ type: "zone-entered", zoneId: input.zoneId, hint: zone?.hint });
      break;
    }
  }
  return out;
}

function cloneState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    completed: { ...state.completed },
    picked: { ...state.picked },
    collectedCount: { ...state.collectedCount },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleStart(ctx: RuntimeContext, out: RuntimeResult): void {
  if (out.state.started) return;
  out.state.started = true;
  narrate(out, "intro", ctx.game.root.intro, ctx.game.root.id);
  pushObjectives(ctx, out);
}

function handleTouchFigure(
  ctx: RuntimeContext,
  out: RuntimeResult,
  nodeId: string,
): void {
  const node = ctx.nodeById.get(nodeId);
  if (!node || out.state.completed[node.id]) return;

  switch (node.type) {
    case "reach":
      complete(ctx, out, node);
      break;
    case "choose":
      if (out.state.activeChoiceNodeId === node.id) return;
      out.state.activeChoiceNodeId = node.id;
      narrate(out, "prompt", node.prompt, node.id);
      out.commands.push({
        type: "present-choice",
        nodeId: node.id,
        posedByEntityId: node.posedByEntityId,
        prompt: node.prompt,
        options: node.options.map((o) => ({ entityId: o.entityId })),
      });
      break;
    case "overcome":
      attemptOvercome(ctx, out, node);
      break;
    case "observe":
      // Reaching the stage plays the demonstration, surfaces the taught glyph to
      // observers/AI, then completes — observe never gates, it just teaches.
      out.commands.push({
        type: "demonstrate",
        nodeId: node.id,
        targetGlyph: node.targetGlyph,
        contrastGlyph: node.contrastGlyph,
        cues: node.demonstrate,
      });
      out.events.push({
        type: "demonstration-shown",
        nodeId: node.id,
        targetGlyph: node.targetGlyph,
      });
      complete(ctx, out, node);
      break;
    case "collect":
      // Collect has no single figure; nothing to do.
      break;
  }
}

function handleTouchDoor(
  ctx: RuntimeContext,
  out: RuntimeResult,
  passageId: string,
): void {
  const passage = ctx.world.passages.find((p) => p.id === passageId);
  if (!passage) return;
  const pending = passage.guards.find(
    (g) => !out.state.completed[g.overcomeNodeId],
  );
  if (!pending) return; // already unlocked
  const node = ctx.nodeById.get(pending.overcomeNodeId);
  if (node?.type === "overcome") attemptOvercome(ctx, out, node);
}

function attemptOvercome(
  ctx: RuntimeContext,
  out: RuntimeResult,
  node: OvercomeNode,
): void {
  if (out.state.completed[node.id]) return;

  if (!out.state.completed[node.key.id]) {
    narrate(out, "prompt", node.prompt, node.id);
    out.events.push({ type: "obstacle-locked", nodeId: node.id, prompt: node.prompt });
    return;
  }

  out.events.push({ type: "guard-cleared", nodeId: node.id });
  out.commands.push({ type: "clear-obstacle", nodeId: node.id });
  complete(ctx, out, node);

  // Open any passage whose guards are now all cleared.
  for (const passage of ctx.passagesByGuard.get(node.id) ?? []) {
    if (passage.guards.every((g) => out.state.completed[g.overcomeNodeId])) {
      out.commands.push({ type: "unlock-passage", passageId: passage.id });
    }
  }
}

function handlePickItem(
  ctx: RuntimeContext,
  out: RuntimeResult,
  instanceId: string,
  entityId: string,
): void {
  if (out.state.picked[instanceId]) return;

  const instance = ctx.instanceById.get(instanceId);
  if (!instance) {
    out.events.push({ type: "distractor-picked", entityId });
    return;
  }

  const node = ctx.nodeById.get(instance.forNodeId);
  if (node?.type !== "collect" || out.state.completed[node.id]) return;

  out.state.picked[instanceId] = true;
  const have = (out.state.collectedCount[node.id] ?? 0) + 1;
  out.state.collectedCount[node.id] = have;
  out.commands.push({ type: "collect-item", instanceId });
  out.events.push({
    type: "item-collected",
    nodeId: node.id,
    entityId: instance.entityId,
    have,
    need: node.count,
  });
  if (have >= node.count) complete(ctx, out, node);
}

function handleSelectOption(
  ctx: RuntimeContext,
  out: RuntimeResult,
  nodeId: string,
  entityId: string,
): void {
  if (out.state.activeChoiceNodeId !== nodeId) return;
  const node = ctx.nodeById.get(nodeId);
  if (node?.type !== "choose") return;

  const option = node.options.find((o) => o.entityId === entityId);
  if (!option) return;

  if (option.correct === true) {
    out.state.activeChoiceNodeId = null;
    out.commands.push({ type: "dismiss-choice", nodeId });
    complete(ctx, out, node);
  } else {
    if (option.feedback) narrate(out, "feedback", option.feedback, nodeId);
    out.events.push({
      type: "wrong-choice",
      nodeId,
      entityId,
      feedback: option.feedback,
    });
    // Panel stays open — the player retries. Failure-free by design.
  }
}

// ---------------------------------------------------------------------------
// Completion + objectives
// ---------------------------------------------------------------------------

function complete(ctx: RuntimeContext, out: RuntimeResult, node: GoalNode): void {
  if (out.state.completed[node.id]) return;
  out.state.completed[node.id] = true;
  out.events.push({ type: "goal-completed", nodeId: node.id, nodeType: node.type });
  narrate(out, "outro", node.outro, node.id);

  if (node.id === ctx.game.root.id) {
    out.state.won = true;
    out.events.push({ type: "game-won" });
    out.commands.push({ type: "celebrate", scope: "game" });
    return;
  }
  pushObjectives(ctx, out);
}

function narrate(
  out: RuntimeResult,
  kind: NarrationKind,
  text: string | undefined,
  nodeId: string,
): void {
  if (!text) return;
  out.events.push({ type: "narrate", kind, text, nodeId });
}

function pushObjectives(ctx: RuntimeContext, out: RuntimeResult): void {
  out.events.push({
    type: "objectives-changed",
    objectives: computeObjectives(ctx, out.state),
  });
}

/**
 * The current frontier: uncompleted goals whose site zone is reachable given
 * the guards cleared so far. Overcome nodes with an incomplete key are
 * included but flagged locked (HUD shows them as "find the way to open …").
 */
export function computeObjectives(
  ctx: RuntimeContext,
  state: RuntimeState,
): ObjectiveSummary[] {
  const reachable = reachableZones(ctx, state);
  const objectives: ObjectiveSummary[] = [];
  for (const { node } of walkGoalTree(ctx.game.root)) {
    if (state.completed[node.id]) continue;
    const zoneId = ctx.world.sites[node.id];
    if (!reachable.has(zoneId)) continue;
    objectives.push({
      nodeId: node.id,
      type: node.type,
      zoneId,
      locked: node.type === "overcome" && !state.completed[node.key.id],
    });
  }
  return objectives;
}

export function reachableZones(
  ctx: RuntimeContext,
  state: RuntimeState,
): Set<string> {
  const reachable = new Set<string>([ctx.world.startZoneId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const passage of ctx.world.passages) {
      const fromIn = reachable.has(passage.from);
      const toIn = reachable.has(passage.to);
      if (fromIn === toIn) continue;
      if (passage.guards.every((g) => state.completed[g.overcomeNodeId])) {
        reachable.add(fromIn ? passage.to : passage.from);
        changed = true;
      }
    }
  }
  return reachable;
}
