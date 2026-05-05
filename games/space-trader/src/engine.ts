// Space Trader — Pure game logic. No DOM / React.

import type {
  AsteroidPOI,
  FlyingRock,
  GameMessage,
  GameState,
  Item,
  ItemKind,
  PiratePOI,
  POI,
  Shape,
  Ship,
  TradeWant,
  TraderPOI,
  Vec2,
} from './types';

// ── Tunables ───────────────────────────────────────────────────────────────

export const SHIP_SPEED = 220;        // world units / second
export const SHIP_TURN_RATE = 3.2;    // rad / second
export const SHIP_RADIUS = 16;        // world units
export const INTERACT_RADIUS = 70;    // ship must be this close to engage POI
export const ASTEROID_BREAK_INTERVAL = 1400; // ms per rock chip
export const TRADE_HOVER_DURATION = 1400;    // ms to complete a trade

export const PIRATE_BASE_SPEED = 130;
export const PIRATE_SPEED_PER_VALUE = 8;     // pirate speed += value(carried) * this
export const PIRATE_FLEE_SPEED = 260;
export const PIRATE_FLEE_DURATION = 4000;    // ms before fleeing pirate despawns

export const POI_DESPAWN_DIST = 2400;        // far-from-ship cull distance
export const POI_SPAWN_RING_MIN = 700;       // spawn just outside view
export const POI_SPAWN_RING_MAX = 1300;

export const TARGET_ASTEROIDS = 6;
export const TARGET_TRADERS = 3;
export const PIRATE_CHECK_INTERVAL = 4000;
export const WORLD_CHECK_INTERVAL = 1500;

export const ROCK_FLIGHT_DURATION = 550;     // ms — chip flies from asteroid to ship

const SHAPES: Shape[] = ['circle', 'triangle', 'square'];

// Numeric ranking used for "highest-value item" decisions and bad-deal detection.
const KIND_VALUE: Record<ItemKind, number> = {
  rock: 1,
  shield: 3,
  blue: 5,
  gold: 12,
  spiral: 100,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickShape(): Shape {
  return SHAPES[Math.floor(Math.random() * SHAPES.length)];
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(dist2(a, b));
}

function valueOf(item: Item): number {
  return KIND_VALUE[item.kind];
}

/** Total inventory value, used to gate pirate aggression. */
function inventoryValue(ship: Ship): number {
  let v = ship.rocks * KIND_VALUE.rock;
  v += ship.shields * KIND_VALUE.shield;
  for (const it of ship.inventory) v += valueOf(it);
  return v;
}

function makeItem(state: GameState, kind: ItemKind, shape?: Shape): Item {
  const item: Item = { id: state.nextId++, kind };
  if (shape && (kind === 'blue' || kind === 'gold')) item.shape = shape;
  return item;
}

function spawnRingPosition(ship: Ship): Vec2 {
  const a = Math.random() * Math.PI * 2;
  const r = rand(POI_SPAWN_RING_MIN, POI_SPAWN_RING_MAX);
  return { x: ship.pos.x + Math.cos(a) * r, y: ship.pos.y + Math.sin(a) * r };
}

function pushMessage(state: GameState, text: string, durationMs = 2400): void {
  state.messages.push({ id: state.nextId++, text, expiresAt: Date.now() + durationMs });
}

// ── World construction ────────────────────────────────────────────────────

export function createGameState(width: number, height: number, level = 0): GameState {
  const state: GameState = {
    ship: {
      pos: { x: 0, y: 0 },
      heading: 0,
      target: { x: 0, y: 0 },
      rocks: 0,
      shields: 0,
      inventory: [],
      trailPositions: [],
    },
    pois: [],
    nextId: 1,
    width,
    height,
    level,
    won: false,
    lastPirateCheck: 0,
    lastWorldCheck: 0,
    messages: [],
    flyingRocks: [],
  };

  // Seed the world with starter POIs around the ship.
  for (let i = 0; i < TARGET_ASTEROIDS; i++) state.pois.push(createAsteroid(state));
  for (let i = 0; i < TARGET_TRADERS; i++) state.pois.push(createTrader(state, i === 0));

  return state;
}

export function resizeGame(state: GameState, width: number, height: number): void {
  state.width = width;
  state.height = height;
}

// ── Spawn factories ───────────────────────────────────────────────────────

function createAsteroid(state: GameState): AsteroidPOI {
  const pos = spawnRingPosition(state.ship);
  const radius = rand(28, 52);
  const rocks = Math.round(rand(2, 5));

  // Probability the asteroid contains a hidden item — depends on level.
  // Level 0: only the win-trader spawns the spiral; asteroids hold blues sometimes.
  let containedItem: Item | undefined;
  const roll = Math.random();
  if (state.level === 0) {
    // No items inside asteroids on level 0 — all rocks.
  } else if (state.level === 1) {
    if (roll < 0.25) containedItem = makeItem(state, 'blue', pickShape());
  } else {
    if (roll < 0.18) containedItem = makeItem(state, 'gold', pickShape());
    else if (roll < 0.5) containedItem = makeItem(state, 'blue', pickShape());
  }

  return {
    id: state.nextId++,
    kind: 'asteroid',
    pos,
    radius,
    rocksRemaining: rocks,
    containedItem,
    breakProgress: 0,
    breakInterval: ASTEROID_BREAK_INTERVAL,
  };
}

/**
 * Build a trader. If `winTrader`, the trader holds the spiral as their offer
 * (game-winning trade). Otherwise produces an exchange or a rock-for-item deal.
 */
function createTrader(state: GameState, winTrader: boolean): TraderPOI {
  const pos = spawnRingPosition(state.ship);

  let want: TradeWant;
  let offer: Item;
  let badDeal = false;

  if (winTrader) {
    // Win condition: the spiral is offered. Demand depends on level.
    offer = makeItem(state, 'spiral');
    if (state.level === 0) {
      want = { kind: 'rock', rockCount: 8 };
    } else if (state.level === 1) {
      want = { kind: 'blue', shape: pickShape() };
    } else {
      want = { kind: 'gold', shape: pickShape() };
    }
  } else {
    // Mix of helpful traders and occasional bad deals.
    const role = Math.random();
    if (role < 0.4) {
      // Rocks → mid-tier item.
      const shape = pickShape();
      offer = makeItem(state, state.level >= 2 ? 'gold' : 'blue', shape);
      want = { kind: 'rock', rockCount: Math.round(rand(3, 6)) };
    } else if (role < 0.7) {
      // Item-for-item upgrade (blue → gold).
      const wantShape = pickShape();
      const offerShape = pickShape();
      offer = makeItem(state, 'gold', offerShape);
      want = { kind: 'blue', shape: wantShape };
    } else if (role < 0.85) {
      // Shield trader: rocks → shield. Always helpful.
      offer = makeItem(state, 'shield');
      want = { kind: 'rock', rockCount: Math.round(rand(2, 4)) };
    } else {
      // Bad deal: gold → blue (downgrade for player).
      offer = makeItem(state, 'blue', pickShape());
      want = { kind: 'gold', shape: pickShape() };
      badDeal = true;
    }
  }

  return {
    id: state.nextId++,
    kind: 'trader',
    pos,
    radius: 26,
    want,
    offer,
    done: false,
    hoverProgress: 0,
    hoverDuration: TRADE_HOVER_DURATION,
    badDeal,
  };
}

function createPirate(state: GameState): PiratePOI {
  const pos = spawnRingPosition(state.ship);
  return {
    id: state.nextId++,
    kind: 'pirate',
    pos,
    radius: 18,
    speed: PIRATE_BASE_SPEED + inventoryValue(state.ship) * PIRATE_SPEED_PER_VALUE,
    fleeing: false,
    despawnAt: 0,
  };
}

// ── Tick ───────────────────────────────────────────────────────────────────

/** Advance the simulation by `dt` seconds; `now` is wall-clock ms. */
export function tick(state: GameState, dt: number, now: number): void {
  if (state.won) return;

  updateShip(state, dt, now);
  updatePOIs(state, dt, now);
  pruneFarPOIs(state);
  maybeSpawn(state, now);
  pruneMessages(state, now);
  pruneFlyingRocks(state, now);
}

function updateShip(state: GameState, dt: number, now: number): void {
  const ship = state.ship;
  const dx = ship.target.x - ship.pos.x;
  const dy = ship.target.y - ship.pos.y;
  const distToTarget = Math.hypot(dx, dy);

  if (distToTarget > 1) {
    // Rotate toward the target at a bounded turn rate.
    const desiredHeading = Math.atan2(dy, dx);
    let delta = desiredHeading - ship.heading;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const turn = Math.max(-SHIP_TURN_RATE * dt, Math.min(SHIP_TURN_RATE * dt, delta));
    ship.heading += turn;

    // Slow down as we approach the target so the ship settles instead of orbiting it.
    const arriveScale = Math.min(1, distToTarget / 80);
    // Fade thrust when poorly aligned (so the ship rotates before bursting forward).
    const alignment = Math.max(0, Math.cos(delta));
    const speed = SHIP_SPEED * arriveScale * (0.3 + 0.7 * alignment);
    ship.pos.x += Math.cos(ship.heading) * speed * dt;
    ship.pos.y += Math.sin(ship.heading) * speed * dt;
  }

  // Sample trail positions for towed items.
  const tail = ship.trailPositions[ship.trailPositions.length - 1];
  if (!tail || dist(tail, ship.pos) > 6) {
    ship.trailPositions.push({ x: ship.pos.x, y: ship.pos.y });
  }
  // Cap trail length proportional to inventory (plus headroom).
  const maxTrail = Math.max(40, ship.inventory.length * 30 + 40);
  if (ship.trailPositions.length > maxTrail) {
    ship.trailPositions.splice(0, ship.trailPositions.length - maxTrail);
  }
  void now;
}

function updatePOIs(state: GameState, dt: number, now: number): void {
  const dtMs = dt * 1000;
  const ship = state.ship;
  const survivors: POI[] = [];

  for (const poi of state.pois) {
    if (poi.kind === 'asteroid') {
      const inRange =
        dist(poi.pos, ship.pos) < INTERACT_RADIUS + poi.radius;
      if (inRange && poi.rocksRemaining > 0) {
        poi.breakProgress += dtMs;
        while (poi.breakProgress >= poi.breakInterval && poi.rocksRemaining > 0) {
          poi.breakProgress -= poi.breakInterval;
          poi.rocksRemaining -= 1;
          ship.rocks += 1;
          spawnFlyingRock(state, poi.pos, now);
          if (poi.rocksRemaining === 0 && poi.containedItem) {
            grantItemToShip(state, poi.containedItem);
            poi.containedItem = undefined;
          }
        }
      } else if (!inRange) {
        poi.breakProgress = 0;
      }
      if (poi.rocksRemaining > 0 || poi.containedItem) survivors.push(poi);
      // else: asteroid fully consumed → drop from world
    } else if (poi.kind === 'trader') {
      if (!poi.done) {
        const inRange = dist(poi.pos, ship.pos) < INTERACT_RADIUS + poi.radius;
        if (inRange && shipMeetsTraderWant(ship, poi.want)) {
          poi.hoverProgress += dtMs;
          if (poi.hoverProgress >= poi.hoverDuration) {
            completeTrade(state, poi);
          }
        } else {
          poi.hoverProgress = 0;
        }
      }
      survivors.push(poi);
    } else if (poi.kind === 'pirate') {
      const stillAlive = updatePirate(state, poi, dt, now);
      if (stillAlive) survivors.push(poi);
    }
  }

  state.pois = survivors;
}

function updatePirate(state: GameState, pirate: PiratePOI, dt: number, now: number): boolean {
  const ship = state.ship;

  if (pirate.fleeing) {
    if (now >= pirate.despawnAt) return false;
    // Flee directly away from ship.
    const dx = pirate.pos.x - ship.pos.x;
    const dy = pirate.pos.y - ship.pos.y;
    const m = Math.hypot(dx, dy) || 1;
    pirate.pos.x += (dx / m) * PIRATE_FLEE_SPEED * dt;
    pirate.pos.y += (dy / m) * PIRATE_FLEE_SPEED * dt;
    return true;
  }

  // Chase ship.
  const dx = ship.pos.x - pirate.pos.x;
  const dy = ship.pos.y - pirate.pos.y;
  const m = Math.hypot(dx, dy) || 1;
  pirate.pos.x += (dx / m) * pirate.speed * dt;
  pirate.pos.y += (dy / m) * pirate.speed * dt;

  // Contact?
  if (dist(pirate.pos, ship.pos) < SHIP_RADIUS + pirate.radius) {
    if (ship.shields > 0) {
      ship.shields -= 1;
      pushMessage(state, 'Shield blocked the attack!');
    } else {
      const stolen = takeHighestValueFromShip(ship);
      if (stolen) {
        if (stolen === 'rock') pushMessage(state, 'Pirate stole a rock!');
        else pushMessage(state, `Pirate stole your ${describeItem(stolen)}!`);
      } else {
        pushMessage(state, 'Pirate found nothing to steal.');
      }
    }
    pirate.fleeing = true;
    pirate.despawnAt = now + PIRATE_FLEE_DURATION;
  }

  return true;
}

function pruneFarPOIs(state: GameState): void {
  const ship = state.ship;
  state.pois = state.pois.filter(p => dist(p.pos, ship.pos) < POI_DESPAWN_DIST);
}

function pruneMessages(state: GameState, now: number): void {
  state.messages = state.messages.filter(m => m.expiresAt > now);
}

function spawnFlyingRock(state: GameState, fromPos: Vec2, now: number): void {
  const flyer: FlyingRock = {
    id: state.nextId++,
    startPos: { x: fromPos.x, y: fromPos.y },
    startTime: now,
    duration: ROCK_FLIGHT_DURATION,
  };
  state.flyingRocks.push(flyer);
}

function pruneFlyingRocks(state: GameState, now: number): void {
  state.flyingRocks = state.flyingRocks.filter(f => now - f.startTime < f.duration);
}

function maybeSpawn(state: GameState, now: number): void {
  if (now - state.lastWorldCheck >= WORLD_CHECK_INTERVAL) {
    state.lastWorldCheck = now;
    const winTraderExists = state.pois.some(
      p => p.kind === 'trader' && (p as TraderPOI).offer.kind === 'spiral',
    );
    while (state.pois.filter(p => p.kind === 'asteroid').length < TARGET_ASTEROIDS) {
      state.pois.push(createAsteroid(state));
    }
    if (!winTraderExists) {
      // Always keep the spiral-bearing trader alive.
      state.pois.push(createTrader(state, true));
    }
    while (
      state.pois.filter(p => p.kind === 'trader' && !(p as TraderPOI).done).length <
        TARGET_TRADERS
    ) {
      state.pois.push(createTrader(state, false));
    }
  }

  if (now - state.lastPirateCheck >= PIRATE_CHECK_INTERVAL) {
    state.lastPirateCheck = now;
    const value = inventoryValue(state.ship);
    // Threshold at 4: a few rocks alone won't bring pirates.
    if (value > 4) {
      const pirateCount = state.pois.filter(p => p.kind === 'pirate' && !(p as PiratePOI).fleeing).length;
      // Probability scales with carried value, capped.
      const chance = Math.min(0.7, value / 60);
      const cap = Math.min(3, 1 + Math.floor(value / 25));
      if (pirateCount < cap && Math.random() < chance) {
        state.pois.push(createPirate(state));
      }
    }
  }
}

// ── Trade logic ───────────────────────────────────────────────────────────

function shipMeetsTraderWant(ship: Ship, want: TradeWant): boolean {
  if (want.kind === 'rock') {
    return ship.rocks >= (want.rockCount ?? 1);
  }
  if (want.kind === 'shield') return ship.shields > 0;
  return ship.inventory.some(it => it.kind === want.kind && (!want.shape || it.shape === want.shape));
}

function consumeWantFromShip(ship: Ship, want: TradeWant): void {
  if (want.kind === 'rock') {
    ship.rocks = Math.max(0, ship.rocks - (want.rockCount ?? 1));
    return;
  }
  if (want.kind === 'shield') {
    ship.shields = Math.max(0, ship.shields - 1);
    return;
  }
  const idx = ship.inventory.findIndex(
    it => it.kind === want.kind && (!want.shape || it.shape === want.shape),
  );
  if (idx >= 0) ship.inventory.splice(idx, 1);
}

function completeTrade(state: GameState, trader: TraderPOI): void {
  consumeWantFromShip(state.ship, trader.want);
  grantItemToShip(state, trader.offer);
  trader.done = true;
  trader.hoverProgress = 0;
  pushMessage(state, `Traded for ${describeItem(trader.offer.kind)}.`);
}

function grantItemToShip(state: GameState, item: Item): void {
  if (item.kind === 'rock') {
    state.ship.rocks += 1;
    pushMessage(state, 'Got a rock!');
  } else if (item.kind === 'shield') {
    state.ship.shields += 1;
    pushMessage(state, 'Picked up a shield!');
  } else if (item.kind === 'spiral') {
    state.ship.inventory.push(item);
    state.won = true;
    pushMessage(state, 'You found the Spiral! Mission complete.', 6000);
  } else {
    state.ship.inventory.push(item);
    pushMessage(state, `Got ${describeItem(item.kind, item.shape)}!`);
  }
}

function takeHighestValueFromShip(ship: Ship): ItemKind | null {
  // Prefer items in inventory (most valuable first), then rocks.
  if (ship.inventory.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < ship.inventory.length; i++) {
      if (valueOf(ship.inventory[i]) > valueOf(ship.inventory[bestIdx])) bestIdx = i;
    }
    const [taken] = ship.inventory.splice(bestIdx, 1);
    return taken.kind;
  }
  if (ship.rocks > 0) {
    ship.rocks -= 1;
    return 'rock';
  }
  return null;
}

// ── Public input handlers ─────────────────────────────────────────────────

/** Set the ship's steering target from a screen-space (canvas) point. */
export function setShipTargetFromScreen(state: GameState, screenX: number, screenY: number): void {
  state.ship.target.x = state.ship.pos.x + (screenX - state.width / 2);
  state.ship.target.y = state.ship.pos.y + (screenY - state.height / 2);
}

export function resetGame(state: GameState): void {
  const fresh = createGameState(state.width, state.height, state.level);
  state.ship = fresh.ship;
  state.pois = fresh.pois;
  state.nextId = fresh.nextId;
  state.won = false;
  state.lastPirateCheck = 0;
  state.lastWorldCheck = 0;
  state.messages = [];
  state.flyingRocks = [];
}

export function setLevel(state: GameState, level: number): void {
  state.level = level;
  resetGame(state);
}

// ── UI helpers ────────────────────────────────────────────────────────────

export function describeItem(kind: ItemKind, shape?: Shape): string {
  if (kind === 'rock') return 'rock';
  if (kind === 'shield') return 'shield';
  if (kind === 'spiral') return 'spiral';
  if (shape) return `${kind} ${shape}`;
  return kind;
}

export function describeWant(want: TradeWant): string {
  if (want.kind === 'rock') return `${want.rockCount ?? 1} rocks`;
  return describeItem(want.kind, want.shape);
}

/** Convert a world position to canvas (screen) coordinates centered on the ship. */
export function worldToScreen(state: GameState, p: Vec2): Vec2 {
  return {
    x: p.x - state.ship.pos.x + state.width / 2,
    y: p.y - state.ship.pos.y + state.height / 2,
  };
}

export function isOnScreen(state: GameState, p: Vec2, pad = 50): boolean {
  const s = worldToScreen(state, p);
  return s.x > -pad && s.x < state.width + pad && s.y > -pad && s.y < state.height + pad;
}

export function activeMessages(state: GameState, now: number): GameMessage[] {
  return state.messages.filter(m => m.expiresAt > now);
}

// Re-export some constants used in rendering
export const KIND_VALUES = KIND_VALUE;
