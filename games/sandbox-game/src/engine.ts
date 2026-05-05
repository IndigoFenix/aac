// Sandbox Game — Core engine (pure logic, no React dependency)

import type { CellType, GameCell, GameState, TimerEvent, RuleEffect, Rule, ToolId } from './types';
import ELEMENTS, { getElement } from './elements';

const NEIGHBOR_OFFSETS: [number, number][] = [
  [0, -1], [0, 1], [-1, 0], [1, 0], // cardinal only
];

/** Max cascade iterations to prevent runaway loops */
const MAX_CASCADE_STEPS = 500;

// --- Factory ---

export function createNewGame(width = 16, height = 16): GameState {
  const grid: GameCell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: GameCell[] = [];
    for (let x = 0; x < width; x++) {
      row.push({ type: 'empty', energy: 0, state: 0 });
    }
    grid.push(row);
  }
  return {
    grid,
    width,
    height,
    playerEnergy: 50,
    maxPlayerEnergy: 50,
    lastUpdateTime: Date.now(),
    timers: [],
    harvested: 0,
    flowQueue: [],
  };
}

// --- Helpers ---

function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && x < state.width && y >= 0 && y < state.height;
}

function getCell(state: GameState, x: number, y: number): GameCell {
  return state.grid[y][x];
}

function setCell(state: GameState, x: number, y: number, cell: GameCell): void {
  state.grid[y][x] = cell;
}

function getNeighbors(state: GameState, x: number, y: number): { x: number; y: number; cell: GameCell }[] {
  const result: { x: number; y: number; cell: GameCell }[] = [];
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(state, nx, ny)) {
      result.push({ x: nx, y: ny, cell: getCell(state, nx, ny) });
    }
  }
  return result;
}

/** Check if a cell already has a timer for a specific target */
function hasTimerForTarget(state: GameState, x: number, y: number, targetState: number, targetType?: CellType): boolean {
  return state.timers.some(t =>
    t.x === x && t.y === y && t.targetState === targetState &&
    (targetType === undefined ? t.targetType === undefined : t.targetType === targetType)
  );
}

/** Remove all timers for a cell */
function removeTimersFor(state: GameState, x: number, y: number): void {
  state.timers = state.timers.filter(t => !(t.x === x && t.y === y));
}

/** Insert a timer, keeping the array sorted by fireAt */
function addTimer(state: GameState, timer: TimerEvent): void {
  // Don't duplicate timers for same cell + targetState + targetType
  if (hasTimerForTarget(state, timer.x, timer.y, timer.targetState, timer.targetType)) return;

  state.timers.push(timer);
  state.timers.sort((a, b) => a.fireAt - b.fireAt);
}

// --- Rule evaluation ---

function matchesNeighborRule(rule: Rule, myCell: GameCell, neighborCell: GameCell): boolean {
  if (rule.myState !== null && myCell.state !== rule.myState) return false;
  if (neighborCell.type !== rule.neighborType) return false;
  if (rule.neighborState !== null && neighborCell.state !== rule.neighborState) return false;
  if (rule.neighborStateMin !== undefined && neighborCell.state < rule.neighborStateMin) return false;
  return true;
}

/**
 * Check if active irrigation makes this cell act like it has adjacent water.
 * Active irrigation (state=1) counts as water at DAMP level for neighbor checks.
 */
function isEffectiveWater(cell: GameCell): boolean {
  return cell.type === 'water' || (cell.type === 'irrigation' && cell.state === 1);
}

/** Extract the target state from a rule's effect (for once-check deduplication) */
function getEffectTimerTarget(effect: RuleEffect): { targetState: number; targetType?: CellType } | null {
  if (effect.type === 'startMyTimer') return { targetState: effect.targetState, targetType: effect.targetType };
  if (effect.type === 'startNeighborTimer') return { targetState: effect.targetState, targetType: effect.targetType };
  return null;
}

/** Evaluate all rules for a cell against its neighbors, returning effects to apply */
function evaluateRules(
  state: GameState,
  x: number,
  y: number,
): { effect: RuleEffect; energyCost: number; nx: number; ny: number }[] {
  const cell = getCell(state, x, y);
  if (cell.type === 'empty') return [];

  const element = getElement(cell.type);
  const results: { effect: RuleEffect; energyCost: number; nx: number; ny: number }[] = [];

  for (const rule of element.rules) {
    if (rule.myState !== null && cell.state !== rule.myState) continue;
    if (rule.energyCost > cell.energy) continue;

    // For "once" rules: skip if there's already a timer for this specific target
    if (rule.once) {
      const target = getEffectTimerTarget(rule.effect);
      if (target && hasTimerForTarget(state, x, y, target.targetState, target.targetType)) continue;
    }

    // Unconditional rule (neighborType === null): fires without neighbor check
    if (rule.neighborType === null) {
      results.push({ effect: rule.effect, energyCost: rule.energyCost, nx: x, ny: y });
      continue;
    }

    // Neighbor-based rule: find first matching neighbor
    const neighbors = getNeighbors(state, x, y);
    for (const n of neighbors) {
      let neighborForCheck = n.cell;

      // Active irrigation acts as damp water for rule checking
      if (rule.neighborType === 'water' && n.cell.type === 'irrigation' && isEffectiveWater(n.cell)) {
        neighborForCheck = { type: 'water', state: 1, energy: n.cell.energy };
      }

      if (!matchesNeighborRule(rule, cell, neighborForCheck)) continue;

      results.push({ effect: rule.effect, energyCost: rule.energyCost, nx: n.x, ny: n.y });
      break; // Only one match per rule (first matching neighbor)
    }
  }

  return results;
}

// --- Effect application ---

function applyEffect(
  state: GameState,
  x: number,
  y: number,
  nx: number,
  ny: number,
  effect: RuleEffect,
  energyCost: number,
  now: number,
): { changedCells: [number, number][] } {
  const cell = getCell(state, x, y);

  // Re-check energy before deducting (prevents going negative from batched effects)
  if (energyCost > cell.energy) return { changedCells: [] };
  cell.energy -= energyCost;

  const changed: [number, number][] = [];

  switch (effect.type) {
    case 'changeMyState':
      cell.state = effect.newState;
      setCell(state, x, y, cell);
      changed.push([x, y]);
      break;

    case 'changeNeighborState': {
      const neighbor = getCell(state, nx, ny);
      neighbor.state = effect.newState;
      setCell(state, nx, ny, neighbor);
      changed.push([nx, ny]);
      break;
    }

    case 'startMyTimer':
      addTimer(state, {
        x, y,
        fireAt: now + effect.duration,
        targetState: effect.targetState,
        targetType: effect.targetType,
        targetEnergy: effect.targetEnergy,
      });
      break;

    case 'startNeighborTimer':
      addTimer(state, {
        x: nx, y: ny,
        fireAt: now + effect.duration,
        targetState: effect.targetState,
        targetType: effect.targetType,
        targetEnergy: effect.targetEnergy,
      });
      break;

    case 'spawnOnEmpty': {
      // Find an adjacent empty tile and spawn there after duration
      const emptyNeighbors = getNeighbors(state, x, y).filter(n2 => n2.cell.type === 'empty');
      if (emptyNeighbors.length > 0) {
        const target = emptyNeighbors[Math.floor(Math.random() * emptyNeighbors.length)];
        addTimer(state, {
          x: target.x, y: target.y,
          fireAt: now + effect.duration,
          targetState: effect.spawnState,
          targetType: effect.spawnType,
          targetEnergy: effect.spawnEnergy,
        });
      }
      break;
    }

    case 'convertNeighbor': {
      const neighbor = getCell(state, nx, ny);
      if (neighbor.type === 'empty') {
        setCell(state, nx, ny, {
          type: effect.newType,
          state: effect.newState,
          energy: effect.newEnergy,
        });
        changed.push([nx, ny]);
      }
      break;
    }

    case 'consumeSelf': {
      // Boost neighbor's state by 1 first
      const neighbor = getCell(state, nx, ny);
      if (neighbor.state < getElement(neighbor.type).states.length - 1) {
        neighbor.state += 1;
        setCell(state, nx, ny, neighbor);
        changed.push([nx, ny]);
      }
      // Replace self
      setCell(state, x, y, {
        type: effect.replacementType,
        state: effect.replacementState,
        energy: effect.replacementEnergy,
      });
      removeTimersFor(state, x, y);
      changed.push([x, y]);
      break;
    }
  }

  return { changedCells: changed };
}

// --- Cascade resolution ---

/**
 * Run cascading neighbor reactions starting from changed cells.
 * Energy-bounded: each reaction costs energy, preventing infinite loops.
 */
function runCascade(state: GameState, initialChanged: [number, number][], now: number): void {
  const queue = [...initialChanged];
  const visited = new Set<string>();
  let steps = 0;

  while (queue.length > 0 && steps < MAX_CASCADE_STEPS) {
    const [cx, cy] = queue.shift()!;
    const key = `${cx},${cy}`;

    // Prevent re-evaluating the same cell in the same cascade pass
    // (it can be added back if a NEIGHBOR changes it)
    if (visited.has(key)) continue;
    visited.add(key);
    steps++;

    // Evaluate rules for this cell
    const effects = evaluateRules(state, cx, cy);
    for (const { effect, energyCost, nx, ny } of effects) {
      const { changedCells } = applyEffect(state, cx, cy, nx, ny, effect, energyCost, now);
      for (const [chx, chy] of changedCells) {
        // Allow re-evaluation of changed cells
        visited.delete(`${chx},${chy}`);
        queue.push([chx, chy]);
      }
    }

    // Also evaluate neighbors (they might react to this cell's presence)
    const neighbors = getNeighbors(state, cx, cy);
    for (const n of neighbors) {
      const nKey = `${n.x},${n.y}`;
      if (visited.has(nKey)) continue;
      visited.add(nKey);

      const nEffects = evaluateRules(state, n.x, n.y);
      for (const { effect, energyCost, nx, ny } of nEffects) {
        const { changedCells } = applyEffect(state, n.x, n.y, nx, ny, effect, energyCost, now);
        for (const [chx, chy] of changedCells) {
          visited.delete(`${chx},${chy}`);
          queue.push([chx, chy]);
        }
      }
    }
  }
}

// --- Water flow (tick-based, 250ms per ring) ---

/**
 * Process one tick of water flow. Water spreads to ALL adjacent empty cells
 * simultaneously, one ring at a time.
 * Returns true if any flow happened (queue still active).
 */
export function flowTick(state: GameState, now: number): boolean {
  if (state.flowQueue.length === 0) return false;

  const toProcess = state.flowQueue;
  state.flowQueue = [];
  const newCells: [number, number][] = [];

  for (const [x, y] of toProcess) {
    const cell = getCell(state, x, y);
    if (cell.type !== 'water' || cell.energy <= 0) continue;

    // Water level determines what it creates: FLOODED→WET, WET→DAMP
    const nextLevel = cell.state - 1;
    if (nextLevel < 1) continue; // DAMP (1) and below don't spread

    const neighbors = getNeighbors(state, x, y);
    for (const n of neighbors) {
      if (cell.energy <= 0) break;
      if (n.cell.type !== 'empty') continue;

      // Create new water cell
      const newEnergy = Math.max(1, Math.floor(cell.energy / 2));
      setCell(state, n.x, n.y, {
        type: 'water',
        state: nextLevel,
        energy: newEnergy,
      });
      cell.energy -= 1;
      newCells.push([n.x, n.y]);

      // WET (2) and above can continue flowing next tick
      if (nextLevel >= 2) {
        state.flowQueue.push([n.x, n.y]);
      }
    }
  }

  // Trigger cascading neighbor reactions on newly created water cells
  // (e.g., soil starts fertility timer, seeds detect water, irrigation activates)
  if (newCells.length > 0) {
    runCascade(state, newCells, now);
  }

  return state.flowQueue.length > 0;
}

/**
 * Drain the flow queue completely (used during catch-up).
 * Energy-bounded so it always halts.
 */
export function drainFlow(state: GameState, now: number): void {
  let safety = 0;
  while (state.flowQueue.length > 0 && safety < 100) {
    flowTick(state, now);
    safety++;
  }
}

// --- Timer processing (catch-up) ---

/**
 * Process all pending timer events up to `now`.
 * This is the core catch-up algorithm.
 */
export function processTimers(state: GameState, now: number): void {
  let safety = 0;
  const MAX_TIMER_ROUNDS = 5000;

  while (state.timers.length > 0 && safety < MAX_TIMER_ROUNDS) {
    // Find the next timer that has fired
    const nextIndex = state.timers.findIndex(t => t.fireAt <= now);
    if (nextIndex === -1) break;

    safety++;
    const timer = state.timers.splice(nextIndex, 1)[0];
    const cell = getCell(state, timer.x, timer.y);

    // Apply the timer's state change
    if (timer.targetType && timer.targetType !== cell.type) {
      // Type change (e.g., stone → soil, fruit → compost, water → empty)
      setCell(state, timer.x, timer.y, {
        type: timer.targetType,
        state: timer.targetState,
        energy: timer.targetEnergy ?? getElement(timer.targetType).defaultEnergy,
      });
    } else {
      cell.state = timer.targetState;
      if (timer.targetEnergy !== undefined) {
        cell.energy = timer.targetEnergy;
      }
      setCell(state, timer.x, timer.y, cell);
    }

    // Run cascade from this change
    runCascade(state, [[timer.x, timer.y]], Math.min(timer.fireAt, now));
  }
}

// --- Player energy regeneration ---

/** Regenerate player energy based on elapsed time. 1 energy per 10 minutes. */
export function regenerateEnergy(state: GameState, now: number): void {
  const elapsed = now - state.lastUpdateTime;
  if (elapsed <= 0) return;
  const gained = Math.floor(elapsed / (10 * 60 * 1000)); // 1 per 10 min
  state.playerEnergy = Math.min(state.maxPlayerEnergy, state.playerEnergy + gained);
}

// --- Main update (called on load or periodically) ---

export function updateGame(state: GameState, now: number = Date.now()): void {
  regenerateEnergy(state, now);
  drainFlow(state, now); // resolve any pending water flow before timers
  processTimers(state, now);
  state.lastUpdateTime = now;
}

// --- Player actions ---

export function canPlace(state: GameState, x: number, y: number, toolId: ToolId): boolean {
  if (!inBounds(state, x, y)) return false;
  const cell = getCell(state, x, y);

  if (toolId === 'harvest') {
    return (cell.type === 'seed' || cell.type === 'bloom') && cell.state === 4; // Fruiting
  }
  if (toolId === 'remove') {
    return cell.type !== 'empty';
  }

  const element = getElement(toolId as CellType);
  if (state.playerEnergy < element.placeCost) return false;

  // Check placement targets
  if (element.placeOn && element.placeOn.length > 0) {
    return element.placeOn.includes(cell.type);
  }

  // Default: can only place on empty tiles
  return cell.type === 'empty';
}

export function playerAction(state: GameState, x: number, y: number, toolId: ToolId): boolean {
  if (!canPlace(state, x, y, toolId)) return false;

  const now = Date.now();

  if (toolId === 'harvest') {
    // Harvest: replace with soil (fair fertility)
    setCell(state, x, y, { type: 'soil', state: 2, energy: 10 });
    removeTimersFor(state, x, y);
    state.harvested += 1;
    state.playerEnergy -= 1;
    runCascade(state, [[x, y]], now);
    return true;
  }

  if (toolId === 'remove') {
    setCell(state, x, y, { type: 'empty', state: 0, energy: 0 });
    removeTimersFor(state, x, y);
    state.playerEnergy -= 1;
    return true;
  }

  const element = getElement(toolId as CellType);
  state.playerEnergy -= element.placeCost;

  setCell(state, x, y, {
    type: toolId as CellType,
    state: element.defaultState ?? 0,
    energy: element.defaultEnergy,
  });
  removeTimersFor(state, x, y);

  // Water placement: add to flow queue for animated spreading
  if (toolId === 'water') {
    state.flowQueue.push([x, y]);
  }

  // Trigger cascading effects from this placement
  runCascade(state, [[x, y]], now);

  return true;
}

// --- Skip time (for testing) ---

export function skipTime(state: GameState, ms: number): void {
  const now = state.lastUpdateTime + ms;
  updateGame(state, now);
}

// --- Weed spawning (called periodically on neglected soil) ---

export function checkWeedSpawns(state: GameState, now: number): void {
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const cell = getCell(state, x, y);
      if (cell.type !== 'soil') continue;
      if (cell.state > 1) continue; // Fair or Rich soil doesn't get weeds

      // Check if any neighbor is a scarecrow (prevents weeds)
      const neighbors = getNeighbors(state, x, y);
      if (neighbors.some(n => n.cell.type === 'scarecrow')) continue;

      // Check if any neighbor is already a plant (soil is "occupied")
      if (neighbors.some(n => ['seed', 'bloom', 'weed'].includes(n.cell.type))) continue;

      // Low chance of weed spawning — add a timer if none exists
      if (!state.timers.some(t => t.x === x && t.y === y) && Math.random() < 0.02) {
        addTimer(state, {
          x, y,
          fireAt: now + 12 * 60 * 60 * 1000, // 12 hours
          targetState: 0,
          targetType: 'weed',
          targetEnergy: 8,
        });
      }
    }
  }
}

// --- Serialization ---

export function serializeState(state: GameState): string {
  return JSON.stringify(state);
}

export function deserializeState(json: string): GameState | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.grid && parsed.width && parsed.height) {
      if (!parsed.flowQueue) parsed.flowQueue = [];
      return parsed as GameState;
    }
    return null;
  } catch {
    return null;
  }
}
