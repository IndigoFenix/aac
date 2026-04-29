/**
 * Game engine reducer. Pure functions — no React, no DOM.
 *
 * dispatch(state, action, def) => { state, events }
 *
 * Cascading effects (signals, state changes) are processed in the same tick,
 * capped at CASCADE_LIMIT to prevent infinite loops.
 */

import type {
  Effect,
  GameDefinition,
  GridCoord,
  Interaction,
  OverridableProp,
  RoomDef,
  RoomEntityInstance,
  StateDef,
  TriggerEvent,
} from "@shared/custom-app-types";
import type {
  EngineAction,
  EngineEvent,
  EntityInstance,
  RuntimeState,
  TickResult,
  Turn,
} from "./engine-types";
import {
  canDropAt,
  canDropInsideContainer,
  entityMatchesSpec,
  getClass,
  getRoom,
  resolveOther,
} from "./selectors";

const CASCADE_LIMIT = 32;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initState(def: GameDefinition): RuntimeState {
  const state: RuntimeState = {
    currentRoomId: def.startRoom,
    entities: {},
    buttons: {},
    turn: "player",
    turnBased: def.turnBased ?? false,
    pendingAiInstructions: [],
    gameOver: false,
    uidSeq: 0,
    placedSeq: 0,
  };
  for (const b of def.buttons) {
    state.buttons[b.id] = { enabled: b.enabledByDefault ?? false };
  }
  loadRoom(state, def, def.startRoom);
  return state;
}

function loadRoom(state: RuntimeState, def: GameDefinition, roomId: string) {
  state.entities = {};
  state.currentRoomId = roomId;
  const room = getRoom(def, roomId);

  for (const b of def.buttons) {
    state.buttons[b.id] = { enabled: b.enabledByDefault ?? false };
  }
  if (room.buttons) {
    for (const id of room.buttons) {
      if (state.buttons[id]) state.buttons[id].enabled = true;
    }
  }

  if (room.tiles) spawnFromTiles(state, def, room);
  for (const ent of room.entities ?? []) spawnEntity(state, def, ent);
}

function spawnFromTiles(state: RuntimeState, def: GameDefinition, room: RoomDef) {
  if (!room.tiles) return;
  const charToClass = new Map<string, string>();
  for (const c of def.classes) {
    if (c.char) charToClass.set(c.char, c.id);
  }
  const lines = room.tiles.split("\n");
  for (let y = 0; y < lines.length; y++) {
    const row = lines[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === room.defaultTile) continue;
      const classId = charToClass.get(ch);
      if (classId) spawnEntity(state, def, { classId, position: [x, y] });
    }
  }
}

function spawnEntity(
  state: RuntimeState,
  def: GameDefinition,
  spec: RoomEntityInstance,
): EntityInstance {
  const cls = getClass(def, spec.classId);
  const uid = `e${++state.uidSeq}`;

  const counters: Record<string, number> = {};
  for (const counter of cls.counters ?? []) {
    counters[counter.id] = spec.counters?.[counter.id] ?? counter.initial;
  }

  const entity: EntityInstance = {
    uid,
    classId: spec.classId,
    position: [...spec.position] as GridCoord,
    state: "_default",
    counters,
    overrides: { ...(spec.overrides ?? {}) },
    placedSeq: ++state.placedSeq,
  };

  if (spec.state && spec.state !== "_default") {
    applyStateOverrides(def, entity, spec.state);
    entity.state = spec.state;
  }

  state.entities[uid] = entity;
  return entity;
}

function applyStateOverrides(def: GameDefinition, entity: EntityInstance, stateId: string) {
  const cls = getClass(def, entity.classId);
  const st = (cls.states ?? []).find((s) => s.id === stateId);
  if (!st) return;
  for (const op of st.overrideProps ?? []) {
    entity.overrides[op.prop] = op.value;
  }
}

// ---------------------------------------------------------------------------
// Dispatch context
// ---------------------------------------------------------------------------

interface TickCtx {
  state: RuntimeState;
  def: GameDefinition;
  events: EngineEvent[];
  cascadeDepth: number;
  pendingSignals: string[];
  turnEndRequest?: "endTurn" | "endPlayerTurn" | "endAiTurn";
  cascadeAborted: boolean;
}

function newCtx(state: RuntimeState, def: GameDefinition): TickCtx {
  return {
    state,
    def,
    events: [],
    cascadeDepth: 0,
    pendingSignals: [],
    cascadeAborted: false,
  };
}

function bumpCascade(ctx: TickCtx): boolean {
  if (ctx.cascadeAborted) return false;
  ctx.cascadeDepth++;
  if (ctx.cascadeDepth > CASCADE_LIMIT) {
    ctx.events.push({ type: "cascadeAborted", reason: `cascade exceeded ${CASCADE_LIMIT}` });
    ctx.cascadeAborted = true;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public: dispatch
// ---------------------------------------------------------------------------

export function dispatch(
  prev: RuntimeState,
  action: EngineAction,
  def: GameDefinition,
): TickResult {
  const state: RuntimeState = structuredClone(prev);
  const ctx = newCtx(state, def);

  if (isAiAction(action) && state.turnBased && state.turn !== "ai") {
    ctx.events.push({ type: "error", message: "AI action attempted outside AI turn" });
    return { state, events: ctx.events };
  }

  switch (action.type) {
    case "click":
      handleClick(ctx, action.targetUid);
      break;
    case "move":
      handleMove(ctx, action.movingUid, action.to);
      break;
    case "dropIntoContainer":
      handleDropIntoContainer(ctx, action.movingUid, action.containerUid);
      break;
    case "buttonPress":
      handleButtonPress(ctx, action.buttonId);
      break;
    case "aiTrigger":
      handleAiTrigger(ctx, action);
      break;
    case "aiCreate":
      handleAiCreate(ctx, action);
      break;
  }

  flushSignals(ctx);
  flushTurnEnd(ctx);
  return { state, events: ctx.events };
}

function isAiAction(a: EngineAction): boolean {
  return a.type === "aiTrigger" || a.type === "aiCreate";
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleClick(ctx: TickCtx, targetUid: string) {
  const self = ctx.state.entities[targetUid];
  if (!self) return;
  fireEvent(ctx, self, { type: "onClick" });
}

function handleMove(ctx: TickCtx, movingUid: string, to: GridCoord) {
  const self = ctx.state.entities[movingUid];
  if (!self) return;
  if (!canDropAt(ctx.def, ctx.state, self, to)) {
    ctx.events.push({
      type: "error",
      message: `invalid drop location (${to[0]},${to[1]}) for ${movingUid}`,
    });
    return;
  }
  const from: GridCoord = [...self.position] as GridCoord;
  if (self.containerUid) self.containerUid = undefined;
  self.position = [...to] as GridCoord;
  self.placedSeq = ++ctx.state.placedSeq;
  ctx.events.push({ type: "entityMoved", uid: self.uid, from, to });
  fireEvent(ctx, self, { type: "onMoved" });
}

function handleDropIntoContainer(ctx: TickCtx, movingUid: string, containerUid: string) {
  const self = ctx.state.entities[movingUid];
  const container = ctx.state.entities[containerUid];
  if (!self || !container) return;
  if (!canDropInsideContainer(ctx.def, ctx.state, self, container)) {
    ctx.events.push({
      type: "error",
      message: `cannot drop ${movingUid} into ${containerUid}`,
    });
    return;
  }
  self.containerUid = containerUid;
  self.position = [...container.position] as GridCoord;
  self.placedSeq = ++ctx.state.placedSeq;
  fireEvent(ctx, self, { type: "onMoved" });
}

function handleButtonPress(ctx: TickCtx, buttonId: string) {
  const btnState = ctx.state.buttons[buttonId];
  if (!btnState || !btnState.enabled) return;
  const btn = ctx.def.buttons.find((b) => b.id === buttonId);
  if (!btn) return;
  for (const e of btn.effects) {
    if (!bumpCascade(ctx)) return;
    if (e.type === "createEntity") {
      const created = spawnEntity(ctx.state, ctx.def, {
        classId: e.classId,
        position: e.position,
        overrides: e.overrides,
      });
      ctx.events.push({
        type: "entityCreated",
        uid: created.uid,
        classId: created.classId,
        position: created.position,
      });
    } else {
      applyEffect(ctx, undefined, undefined, e);
    }
  }
}

function handleAiTrigger(
  ctx: TickCtx,
  action: Extract<EngineAction, { type: "aiTrigger" }>,
) {
  const self = ctx.state.entities[action.selfUid];
  if (!self) return;
  if (self.classId !== action.classId) return;
  const cls = getClass(ctx.def, action.classId);
  const inter = cls.interactions?.[action.interactionIndex];
  if (!inter) return;
  tryInteraction(ctx, self, inter, { type: "onAiTrigger", instructions: "" }, action.otherUid);
}

function handleAiCreate(
  ctx: TickCtx,
  action: Extract<EngineAction, { type: "aiCreate" }>,
) {
  const cls = getClass(ctx.def, action.classId);
  if (!cls.aiCreatable) {
    ctx.events.push({ type: "error", message: `class ${action.classId} is not aiCreatable` });
    return;
  }
  const whitelist = new Set<OverridableProp>(cls.aiCreatableProperties ?? []);
  const filtered: Partial<Record<OverridableProp, unknown>> = {};
  for (const [k, v] of Object.entries(action.overrides ?? {})) {
    if (whitelist.has(k as OverridableProp)) filtered[k as OverridableProp] = v;
  }

  const tempUid = `tmp${++ctx.state.uidSeq}`;
  const tmp: EntityInstance = {
    uid: tempUid,
    classId: action.classId,
    position: [...action.position] as GridCoord,
    state: "_default",
    counters: {},
    overrides: filtered,
    placedSeq: 0,
  };
  ctx.state.entities[tempUid] = tmp;
  const ok = canDropAt(ctx.def, ctx.state, tmp, action.position);
  delete ctx.state.entities[tempUid];
  ctx.state.uidSeq--;
  if (!ok) {
    ctx.events.push({
      type: "error",
      message: `aiCreate placement invalid at (${action.position[0]},${action.position[1]})`,
    });
    return;
  }
  const created = spawnEntity(ctx.state, ctx.def, {
    classId: action.classId,
    position: action.position,
    overrides: filtered,
  });
  ctx.events.push({
    type: "entityCreated",
    uid: created.uid,
    classId: created.classId,
    position: created.position,
  });
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

function fireEvent(ctx: TickCtx, self: EntityInstance, event: TriggerEvent) {
  if (ctx.cascadeAborted) return;
  const cls = getClass(ctx.def, self.classId);
  for (const inter of cls.interactions ?? []) {
    if (!inter.triggers.events.some((e) => eventMatches(e, event))) continue;
    tryInteraction(ctx, self, inter, event);
    if (ctx.cascadeAborted) return;
  }
}

function eventMatches(defined: TriggerEvent, fired: TriggerEvent): boolean {
  if (defined.type !== fired.type) return false;
  if (defined.type === "onSignalReceived" && fired.type === "onSignalReceived") {
    return defined.id === fired.id;
  }
  return true;
}

function tryInteraction(
  ctx: TickCtx,
  self: EntityInstance,
  inter: Interaction,
  _event: TriggerEvent,
  forcedOtherUid?: string,
) {
  const { self: selfSpec, other: otherSpec } = inter.triggers;
  if (selfSpec && !entityMatchesSpec(ctx.def, self, selfSpec)) return;

  let other: EntityInstance | undefined;
  if (otherSpec) {
    if (forcedOtherUid) {
      const forced = ctx.state.entities[forcedOtherUid];
      if (!forced || !entityMatchesSpec(ctx.def, forced, otherSpec)) return;
      other = forced;
    } else {
      other = resolveOther(ctx.def, ctx.state, self, otherSpec);
      if (!other) return;
    }
  }

  for (const eff of inter.effects) {
    if (!bumpCascade(ctx)) return;
    applyEffect(ctx, self, other, eff);
  }

  if (inter.aiInstructions) ctx.state.pendingAiInstructions.push(inter.aiInstructions);
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function applyEffect(
  ctx: TickCtx,
  self: EntityInstance | undefined,
  other: EntityInstance | undefined,
  eff: Effect,
) {
  switch (eff.type) {
    case "changeState":
      if (self) changeState(ctx, self, eff.id);
      return;
    case "changeStateOther":
      if (other) changeState(ctx, other, eff.id);
      return;
    case "emitSignal":
      ctx.events.push({ type: "signalEmitted", id: eff.id });
      ctx.pendingSignals.push(eff.id);
      return;
    case "incrementCounterSelf":
      if (self) incrementCounter(ctx, self, eff.id, eff.amount);
      return;
    case "incrementCounterOther":
      if (other) incrementCounter(ctx, other, eff.id, eff.amount);
      return;
    case "destroySelf":
      if (self) destroyEntity(ctx, self);
      return;
    case "destroyOther":
      if (other) destroyEntity(ctx, other);
      return;
    case "transformSelf":
      if (self) transformEntity(ctx, self, eff.id);
      return;
    case "transformOther":
      if (other) transformEntity(ctx, other, eff.id);
      return;
    case "setRoom":
      setRoom(ctx, eff.id);
      return;
    case "endTurn":
      ctx.turnEndRequest = "endTurn";
      return;
    case "endPlayerTurn":
      ctx.turnEndRequest = "endPlayerTurn";
      return;
    case "endAiTurn":
      ctx.turnEndRequest = "endAiTurn";
      return;
    case "sendAiInstruction":
      ctx.state.pendingAiInstructions.push(eff.message);
      ctx.events.push({ type: "aiInstruction", message: eff.message });
      return;
  }
}

function changeState(ctx: TickCtx, entity: EntityInstance, newStateId: string) {
  const cls = getClass(ctx.def, entity.classId);
  const valid = newStateId === "_default" || (cls.states ?? []).some((s) => s.id === newStateId);
  if (!valid) {
    ctx.events.push({ type: "error", message: `unknown state ${newStateId} on ${entity.classId}` });
    return;
  }
  if (entity.state === newStateId) return;
  const from = entity.state;

  const oldState: StateDef | undefined = (cls.states ?? []).find((s) => s.id === from);
  if (oldState?.overrideProps) {
    for (const op of oldState.overrideProps) delete entity.overrides[op.prop];
  }
  entity.state = newStateId;
  if (newStateId !== "_default") applyStateOverrides(ctx.def, entity, newStateId);
  ctx.events.push({ type: "stateChanged", uid: entity.uid, from, to: newStateId });
}

function incrementCounter(
  ctx: TickCtx,
  entity: EntityInstance,
  counterId: string,
  amount: number,
) {
  const cls = getClass(ctx.def, entity.classId);
  const counterDef = (cls.counters ?? []).find((c) => c.id === counterId);
  if (!counterDef) {
    ctx.events.push({ type: "error", message: `unknown counter ${counterId} on ${entity.classId}` });
    return;
  }
  const prev = entity.counters[counterId] ?? counterDef.initial;
  let next = prev + amount;
  if (counterDef.min !== undefined && next < counterDef.min) next = counterDef.min;
  if (counterDef.max !== undefined && next > counterDef.max) next = counterDef.max;
  if (next === prev) return;
  entity.counters[counterId] = next;
  ctx.events.push({
    type: "counterChanged",
    uid: entity.uid,
    counter: counterId,
    from: prev,
    to: next,
  });
}

function destroyEntity(ctx: TickCtx, entity: EntityInstance) {
  for (const e of Object.values(ctx.state.entities)) {
    if (e.containerUid === entity.uid) destroyEntity(ctx, e);
  }
  delete ctx.state.entities[entity.uid];
  ctx.events.push({ type: "entityDestroyed", uid: entity.uid, classId: entity.classId });
}

function transformEntity(ctx: TickCtx, entity: EntityInstance, newClassId: string) {
  const newCls = ctx.def.classes.find((c) => c.id === newClassId);
  if (!newCls) {
    ctx.events.push({ type: "error", message: `unknown class for transform: ${newClassId}` });
    return;
  }
  const fromClass = entity.classId;
  entity.classId = newClassId;
  entity.state = "_default";
  const counters: Record<string, number> = {};
  for (const c of newCls.counters ?? []) counters[c.id] = c.initial;
  entity.counters = counters;
  entity.overrides = {};
  ctx.events.push({
    type: "entityTransformed",
    uid: entity.uid,
    fromClass,
    toClass: newClassId,
  });
}

function setRoom(ctx: TickCtx, roomId: string) {
  let targetId = roomId;
  if (roomId === "_next") {
    const idx = ctx.def.rooms.findIndex((r) => r.id === ctx.state.currentRoomId);
    if (idx < 0 || idx + 1 >= ctx.def.rooms.length) {
      ctx.events.push({ type: "error", message: "setRoom(_next): no next room" });
      return;
    }
    targetId = ctx.def.rooms[idx + 1].id;
  }
  const from = ctx.state.currentRoomId;
  if (from === targetId) return;
  loadRoom(ctx.state, ctx.def, targetId);
  ctx.events.push({ type: "roomChanged", from, to: targetId });
}

// ---------------------------------------------------------------------------
// Signal + turn flush
// ---------------------------------------------------------------------------

function flushSignals(ctx: TickCtx) {
  while (ctx.pendingSignals.length > 0 && !ctx.cascadeAborted) {
    const id = ctx.pendingSignals.shift()!;
    const uids = Object.keys(ctx.state.entities);
    for (const uid of uids) {
      const e = ctx.state.entities[uid];
      if (!e) continue;
      fireEvent(ctx, e, { type: "onSignalReceived", id });
      if (ctx.cascadeAborted) return;
    }
  }
}

function flushTurnEnd(ctx: TickCtx) {
  if (!ctx.turnEndRequest) return;
  if (!ctx.state.turnBased) {
    ctx.turnEndRequest = undefined;
    return;
  }
  const req = ctx.turnEndRequest;
  ctx.turnEndRequest = undefined;
  const shouldSwitch =
    req === "endTurn" ||
    (req === "endPlayerTurn" && ctx.state.turn === "player") ||
    (req === "endAiTurn" && ctx.state.turn === "ai");
  if (!shouldSwitch) return;
  const from: Turn = ctx.state.turn;
  const to: Turn = from === "player" ? "ai" : "player";
  ctx.state.turn = to;
  ctx.events.push({ type: "turnChanged", from, to });
}

// ---------------------------------------------------------------------------
// Utility for callers to consume and clear AI instructions.
// ---------------------------------------------------------------------------

export function drainPendingAiInstructions(state: RuntimeState): string[] {
  const out = state.pendingAiInstructions;
  state.pendingAiInstructions = [];
  return out;
}
