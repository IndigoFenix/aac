// Space Trader — Pure game logic. No DOM / React.

import type {
  AsteroidPOI,
  Cluster,
  ClusterTrade,
  FlyingRock,
  GameMessage,
  GameState,
  Item,
  ItemKind,
  PiratePOI,
  POI,
  Shape,
  Ship,
  TradeRequirement,
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

// Pirate speeds are tiered by what the player is carrying. SHIP_SPEED is 220.
// All tiers exceed SHIP_SPEED so the player can never run a pirate down by ramming.
export const PIRATE_SPEED_SLOW = 245;        // tier 1: just faster than the ship
export const PIRATE_SPEED_MEDIUM = 290;      // tier 2: noticeably quicker
export const PIRATE_SPEED_FAST = 350;        // tier 3: outright dangerous
export const PIRATE_FLEE_SPEED = 380;
export const PIRATE_FLEE_DURATION = 4000;    // ms before fleeing pirate despawns
export const PIRATE_STEAL_ROCKS = 4;         // max rocks taken per attack
// Pirates turn slightly slower than the ship (SHIP_TURN_RATE = 3.2) so a
// confident pilot can stay nose-on through their evasive arc.
export const PIRATE_HEADING_TURN_RATE = 2.7;

export const POI_DESPAWN_DIST = 2400;        // far-from-ship cull distance
export const POI_SPAWN_RING_MIN = 700;       // spawn just outside view
export const POI_SPAWN_RING_MAX = 1300;

export const TARGET_ASTEROIDS = 6;
export const PIRATE_CHECK_INTERVAL = 4000;
export const WORLD_CHECK_INTERVAL = 1500;

// Cluster sizing — clusters get larger at higher levels so the player has to
// hold the puzzle in memory while the star trader is off-screen.
export const CLUSTER_RADIUS_BASE = 380;
export const CLUSTER_RADIUS_PER_LEVEL = 140;
export const CLUSTER_RADIUS_MAX = 1100;
export const CLUSTER_DESPAWN_DIST = 3000;   // ship distance from cluster centre to despawn
export const CLUSTER_SPAWN_RING_MIN = 1100; // a little beyond the radar arc
export const CLUSTER_SPAWN_RING_MAX = 1800;
export const CLUSTER_SPACING_PAD = 360;     // min gap between two cluster boundaries
export const TARGET_CLUSTERS = 2;           // keep this many active clusters near the ship
export const TRADER_MIN_SPACING = 220;      // within a cluster, traders should be at least this far apart
export const TRADER_RESPAWN_DELAY = 4500;   // ms before a lost trader re-pops in its cluster
export const TRADER_SPAWN_FADE_MS = 700;    // ms — ripple-in fade duration for traders

export const ROCK_FLIGHT_DURATION = 550;     // ms — chip flies from asteroid to ship
export const TRAIL_FADE_MS = 1500;           // ms — trail samples fully fade after this

// Inventory-item motion: items lock to their chain point and only tween when
// they shift slots (a new item arrives or one is removed/stolen).
export const ITEM_MOVE_DURATION = 380;       // ms — slot-shift tween length
export const CHAIN_SPACING = 24;             // world units — gap between chain points

// Level-end warp transition. Speed eases sin(0→π/2) on warp_out and cos(0→π/2)
// on warp_in. The travel distance is a constant slightly wider than any
// reasonable game window, so the ship always spawns comfortably off-screen
// regardless of heading.
export const WARP_OUT_DURATION = 1400;       // ms — ship streaks off the camera frame
export const WARP_IN_DURATION = 1200;        // ms — ship streaks back in from the opposite edge
export const WARP_TOTAL_DURATION = WARP_OUT_DURATION + WARP_IN_DURATION;
export const WARP_OFFSCREEN_DIST = 1800;     // world units past the camera for warp endpoints

// Pirates — morale-based sneak/confront model. Pirates circle behind the ship,
// aim for trailing items, and lose morale while the ship faces them. At 0
// morale they flee even without contact. Morale slowly regenerates whenever
// nothing is depleting it.
export const PIRATE_BASE_MORALE = 45;            // morale every pirate starts (and recovers to)
export const PIRATE_MORALE_DRAIN = 60;           // morale/sec at max exposure × proximity
export const PIRATE_MORALE_RECOVERY = 18;        // morale/sec regen while unobserved + away from traders
export const PIRATE_TRADER_MORALE_DRAIN = 75;    // morale/sec at max trader-proximity factor
export const PIRATE_DETECTION_RANGE = 420;       // world units — exposure falls off past this
export const PIRATE_APPROACH_DIST = 90;          // world units — preferred circling radius
export const PIRATE_BACKOFF_DIST = 280;          // world units — base radius while being faced down
export const PIRATE_BACKOFF_MORALE_BONUS = 260;  // extra radius added as morale depletes (full at 0 morale)
export const PIRATE_TRADER_AVOIDANCE = 360;      // world units — pirates keep this far from any active trader
export const ASTEROID_TRADER_EXCLUSION = 360;    // world units — asteroids never spawn this close to a trader
export const ASTEROID_FADE_OUT_MS = 700;         // ms — fade-out duration when a cluster lands on top of an asteroid
export const PIRATE_TURN_RATE = 2.4;             // rad/sec — how fast the pirate slides around the ship
export const PIRATE_EXPOSURE_THRESHOLD = 0.25;   // alignment above this counts as "being faced"
export const PIRATE_ITEM_GRAB_PAD = 12;          // world units — collision pad to snatch an item
export const PIRATE_TRADER_SPAWN_GUARD = 0.75;   // fraction of screen width: min trader distance before spawning
export const PIRATE_MUTUAL_REPULSION_DIST = 90;  // world units — pirates inside this radius of each other push apart

// Trader outro (swap → smile → ripple → fade → removed).
export const TRADER_SWAP_MS = 450;
export const TRADER_SMILE_START_MS = 250;
export const TRADER_RIPPLE_START_MS = 750;
export const TRADER_FADE_START_MS = 850;
export const TRADER_OUTRO_DURATION = 1600;
/** Bubble appears generously — well outside trade range. */
export const TRADER_BUBBLE_DIST = INTERACT_RADIUS + 220;
/** Inside this range without the wanted item, the trader pulls the offer in. */
export const TRADER_DEFENSIVE_DIST = INTERACT_RADIUS + 50;

const SHAPES: Shape[] = ['circle', 'triangle', 'square'];

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

function makeItem(state: GameState, kind: ItemKind, shape?: Shape): Item {
  const item: Item = {
    id: state.nextId++,
    kind,
    prevPos: { x: 0, y: 0 },
    moveStart: 0,
    moveDuration: ITEM_MOVE_DURATION,
    locked: true,
  };
  if (shape && (kind === 'blue' || kind === 'purple')) item.shape = shape;
  return item;
}

/** Eased progress: fast acceleration then slower brake into position. */
export function easeAccelBrake(t: number): number {
  const tt = Math.max(0, Math.min(1, t));
  const accelEnd = 0.3;
  const accelFrac = 0.55;
  if (tt < accelEnd) {
    const u = tt / accelEnd;
    return accelFrac * u * u;
  }
  const u = (tt - accelEnd) / (1 - accelEnd);
  return accelFrac + (1 - accelFrac) * (1 - (1 - u) * (1 - u));
}

/**
 * Current rendered world position for the inventory item at `idx`. Locked items
 * sit exactly on their chain point; in-flight items ease from `prevPos` toward
 * their chain point.
 */
export function itemRenderPos(state: GameState, idx: number, now: number): Vec2 {
  const item = state.ship.inventory[idx];
  const target =
    state.ship.chain[idx]?.pos ?? state.ship.pos;
  if (item.locked || item.moveDuration <= 0) {
    return { x: target.x, y: target.y };
  }
  const t = (now - item.moveStart) / item.moveDuration;
  const k = easeAccelBrake(t);
  return {
    x: item.prevPos.x + (target.x - item.prevPos.x) * k,
    y: item.prevPos.y + (target.y - item.prevPos.y) * k,
  };
}

/**
 * Each chain point catches up to the one ahead of it (or the ship for index 0)
 * only when the gap exceeds `CHAIN_SPACING`. The result is a snake-like tail
 * that holds its spacing when the ship is still and stretches naturally as it moves.
 */
function updateChain(ship: Ship): void {
  for (let i = 0; i < ship.chain.length; i++) {
    const ahead = i === 0 ? ship.pos : ship.chain[i - 1].pos;
    const pt = ship.chain[i].pos;
    const dx = ahead.x - pt.x;
    const dy = ahead.y - pt.y;
    const d = Math.hypot(dx, dy);
    if (d > CHAIN_SPACING) {
      const overshoot = d - CHAIN_SPACING;
      pt.x += (dx / d) * overshoot;
      pt.y += (dy / d) * overshoot;
    }
  }
}

/** Lock inventory items whose slot-shift tween has finished. */
function updateInventoryAnimations(state: GameState, now: number): void {
  for (const item of state.ship.inventory) {
    if (!item.locked && now - item.moveStart >= item.moveDuration) {
      item.locked = true;
    }
  }
}

/**
 * Capture each item's current rendered position so a fresh slot-shift tween can
 * start from where it visually sits right now.
 */
function freezeItemRenderPositions(state: GameState, now: number): void {
  for (let i = 0; i < state.ship.inventory.length; i++) {
    const item = state.ship.inventory[i];
    const cur = itemRenderPos(state, i, now);
    item.prevPos = cur;
    item.moveStart = now;
    item.locked = false;
  }
}

function shapeCount(ship: Ship): number {
  let n = 0;
  for (const it of ship.inventory) {
    if (it.kind === 'blue' || it.kind === 'purple') n++;
  }
  return n;
}

function pirateSpeedFor(ship: Ship): number {
  const rocks = ship.rocks;
  const shapes = shapeCount(ship);
  if (rocks > 12 || shapes > 3) return PIRATE_SPEED_FAST;
  if (rocks > 8 || shapes > 2) return PIRATE_SPEED_MEDIUM;
  return PIRATE_SPEED_SLOW;
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
      cursorOffset: { x: 0, y: 0 },
      rocks: 0,
      shields: 0,
      inventory: [],
      trailPositions: [],
      // Empty inventory still gets one "spare" point so the first arrival has
      // somewhere to land into.
      chain: [{ pos: { x: 0, y: 0 } }],
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
    cameraPos: { x: 0, y: 0 },
    transitionStart: null,
    transitionMidpointReached: false,
    clusters: [],
  };

  // Seed the world: asteroids + a couple of starter clusters.
  for (let i = 0; i < TARGET_ASTEROIDS; i++) state.pois.push(createAsteroid(state, 0));
  for (let i = 0; i < TARGET_CLUSTERS; i++) {
    spawnCluster(state, 0);
  }

  return state;
}

export function resizeGame(state: GameState, width: number, height: number): void {
  state.width = width;
  state.height = height;
}

// ── Spawn factories ───────────────────────────────────────────────────────

function createAsteroid(state: GameState, now: number): AsteroidPOI {
  const rocks = Math.round(rand(2, 5));
  // Base size scales with rock content so the player can read how much an
  // asteroid carries at a glance; visual radius later shrinks via sqrt(remaining/initial).
  const radius = 24 + rocks * 7 + rand(-2, 2);

  // Asteroids only yield rocks now; high-value items live in trader puzzles.
  // Keep a constant exclusion radius around each trader (not the cluster disc)
  // so the world reads as irregular trading vs. mining zones instead of one
  // big circular "puzzle bubble" hole.
  const exclSq = ASTEROID_TRADER_EXCLUSION * ASTEROID_TRADER_EXCLUSION;
  let pos = spawnRingPosition(state.ship);
  for (let attempt = 0; attempt < 12; attempt++) {
    let nearTrader = false;
    for (const p of state.pois) {
      if (p.kind !== 'trader') continue;
      const dx = pos.x - p.pos.x;
      const dy = pos.y - p.pos.y;
      if (dx * dx + dy * dy < exclSq) {
        nearTrader = true;
        break;
      }
    }
    if (!nearTrader) break;
    pos = spawnRingPosition(state.ship);
  }

  return {
    id: state.nextId++,
    kind: 'asteroid',
    pos,
    radius,
    rocksRemaining: rocks,
    initialRocks: rocks,
    breakProgress: 0,
    breakInterval: ASTEROID_BREAK_INTERVAL,
    spawnTime: now,
  };
}

/**
 * Effective visual radius for an asteroid: shrinks as rocks are chipped off.
 * Floored to a minimum so the asteroid stays clickable until the last rock pops.
 */
export function asteroidVisualRadius(poi: AsteroidPOI): number {
  if (poi.initialRocks <= 0) return poi.radius;
  const frac = poi.rocksRemaining / poi.initialRocks;
  // sqrt so area shrinks linearly with rocks; clamp so the last rock isn't a speck.
  const scale = Math.max(0.35, Math.sqrt(frac));
  return poi.radius * scale;
}

/**
 * Build a trader POI from a cluster trade definition. Position is picked inside
 * the cluster disc with light spacing checks. The offer item is stamped with
 * cluster + trade-index source info so it can be tracked back if the player
 * loses it (pirate theft).
 */
function buildTraderFromTrade(
  state: GameState,
  cluster: Cluster,
  trade: ClusterTrade,
  tradeIdx: number,
  now: number,
): TraderPOI {
  const existing = state.pois
    .filter((p): p is TraderPOI => p.kind === 'trader' && p.clusterId === cluster.id)
    .map(t => t.pos);
  const pos = pickTraderPosInCluster(cluster, existing);
  const offer: Item = makeItem(state, trade.offerKind, trade.offerShape);
  offer.sourceClusterId = cluster.id;
  offer.sourceTradeIdx = tradeIdx;
  return {
    id: state.nextId++,
    kind: 'trader',
    pos,
    radius: 44,
    want: trade.want,
    offer,
    done: false,
    hoverProgress: 0,
    hoverDuration: TRADE_HOVER_DURATION,
    encountered: false,
    clusterId: cluster.id,
    spawnTime: now,
  };
}

/**
 * Pick a position inside a cluster's disc that is at least TRADER_MIN_SPACING
 * from every existing trader's position. Falls back to a random in-disc point
 * after `maxAttempts` rejections.
 */
function pickTraderPosInCluster(cluster: Cluster, existing: Vec2[]): Vec2 {
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * cluster.radius * 0.9;
    const pos = {
      x: cluster.center.x + Math.cos(a) * r,
      y: cluster.center.y + Math.sin(a) * r,
    };
    let ok = true;
    for (const e of existing) {
      const dx = pos.x - e.x;
      const dy = pos.y - e.y;
      if (dx * dx + dy * dy < TRADER_MIN_SPACING * TRADER_MIN_SPACING) {
        ok = false;
        break;
      }
    }
    if (ok) return pos;
  }
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * cluster.radius * 0.9;
  return {
    x: cluster.center.x + Math.cos(a) * r,
    y: cluster.center.y + Math.sin(a) * r,
  };
}

/**
 * Whether this trader will accept any purple item as a fall-back trade-down.
 * The game-wide rule: any trader who wants rocks or a blue shape also accepts
 * a purple shape per missing item, regardless of what they offer. This is what
 * makes "burn a purple to bypass a missing blue" puzzles solvable.
 * Star traders (and any trade whose primary want is a purple) are excluded.
 */
export function traderAcceptsPurpleFallback(trader: TraderPOI): boolean {
  return trader.want.kind === 'rock' || trader.want.kind === 'blue';
}

// ── Cluster / puzzle generation ──────────────────────────────────────────

function clusterRadiusForLevel(level: number): number {
  return Math.min(
    CLUSTER_RADIUS_MAX,
    CLUSTER_RADIUS_BASE + level * CLUSTER_RADIUS_PER_LEVEL,
  );
}

/**
 * Pick a centre for a new cluster. Prefers the spawn ring around the ship, but
 * rejects positions that would put the cluster border too close to an existing
 * cluster's border. Falls back after a few rejections so we never deadlock.
 */
function pickClusterCenter(state: GameState, radius: number): Vec2 {
  for (let attempt = 0; attempt < 16; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = rand(CLUSTER_SPAWN_RING_MIN, CLUSTER_SPAWN_RING_MAX);
    const center: Vec2 = {
      x: state.ship.pos.x + Math.cos(a) * r,
      y: state.ship.pos.y + Math.sin(a) * r,
    };
    let ok = true;
    for (const c of state.clusters) {
      const d = Math.hypot(center.x - c.center.x, center.y - c.center.y);
      if (d < radius + c.radius + CLUSTER_SPACING_PAD) {
        ok = false;
        break;
      }
    }
    if (ok) return center;
  }
  // Last-ditch fallback: just take a random ring point.
  const a = Math.random() * Math.PI * 2;
  const r = rand(CLUSTER_SPAWN_RING_MIN, CLUSTER_SPAWN_RING_MAX);
  return { x: state.ship.pos.x + Math.cos(a) * r, y: state.ship.pos.y + Math.sin(a) * r };
}

/**
 * Build the abstract trade graph for a cluster at the given level. Always
 * includes a star trade and guarantees at least one rocks-only path to it.
 */
function generateClusterTrades(level: number): ClusterTrade[] {
  const trades: ClusterTrade[] = [];

  if (level <= 0) {
    // Level 0: a single star trader who wants rocks.
    trades.push({
      isStar: true,
      offerKind: 'star',
      want: { kind: 'rock', rockCount: 8 },
    });
    return trades;
  }

  if (level === 1) {
    // Star wants a specific blue shape. 2-3 helper traders all offer that
    // shape for rocks (multiple traders offering the same trade).
    const targetShape = pickShape();
    trades.push({
      isStar: true,
      offerKind: 'star',
      want: { kind: 'blue', shape: targetShape },
    });
    const helpers = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < helpers; i++) {
      trades.push({
        isStar: false,
        offerKind: 'blue',
        offerShape: targetShape,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      });
    }
    return trades;
  }

  if (level === 2) {
    // Star wants one blue shape; helpers offer a mix of shapes including the
    // target. Player must remember which one to grab.
    const targetShape = pickShape();
    trades.push({
      isStar: true,
      offerKind: 'star',
      want: { kind: 'blue', shape: targetShape },
    });
    const shapes = new Set<Shape>([targetShape]);
    while (shapes.size < 3) shapes.add(pickShape());
    for (const shape of shapes) {
      const dupes = shape === targetShape ? 2 : 1;
      for (let i = 0; i < dupes; i++) {
        trades.push({
          isStar: false,
          offerKind: 'blue',
          offerShape: shape,
          want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
        });
      }
    }
    return trades;
  }

  if (level === 3) {
    // Two-step blue chain: rocks → blue intermShape → blue targetShape → star.
    const targetShape = pickShape();
    const intermShape = pickDifferentShape(targetShape);
    trades.push({
      isStar: true,
      offerKind: 'star',
      want: { kind: 'blue', shape: targetShape },
    });
    // Trader(s) who give the target shape for the intermediate shape.
    trades.push({
      isStar: false,
      offerKind: 'blue',
      offerShape: targetShape,
      want: { kind: 'blue', shape: intermShape },
    });
    trades.push({
      isStar: false,
      offerKind: 'blue',
      offerShape: targetShape,
      want: { kind: 'blue', shape: intermShape },
    });
    // Leaf traders give the intermediate shape for rocks.
    for (let i = 0; i < 2; i++) {
      trades.push({
        isStar: false,
        offerKind: 'blue',
        offerShape: intermShape,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      });
    }
    return trades;
  }

  // Level 4+: pick a high-complexity template, then add noise traders that
  // scale with the level so the player has to filter signal from clutter.
  const { trades: tplTrades, forbiddenNoiseShapes } = pickHighLevelTemplate(level);
  trades.push(...tplTrades);

  const noiseCount = Math.max(0, Math.min(3, level - 5));
  for (let i = 0; i < noiseCount; i++) {
    const noise = pickShapeExcluding(forbiddenNoiseShapes);
    if (noise === null) continue;
    trades.push({
      isStar: false,
      offerKind: 'blue',
      offerShape: noise,
      want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
    });
  }
  return trades;
}

function pickShapeExcluding(exclude: Shape[]): Shape | null {
  const opts = SHAPES.filter(s => !exclude.includes(s));
  if (opts.length === 0) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}

function pickDifferentShape(other: Shape): Shape {
  const opts: Shape[] = SHAPES.filter(s => s !== other);
  return opts[Math.floor(Math.random() * opts.length)];
}

/**
 * Result of a puzzle template: the actual trades, plus any blue shapes that
 * noise traders MUST NOT offer (e.g. a "missing blue" required by a trade-down
 * puzzle that the player is supposed to bypass via the purple fall-back).
 */
interface TemplateResult {
  trades: ClusterTrade[];
  forbiddenNoiseShapes: Shape[];
}

/** Pick a non-trivial puzzle template for level 4+. */
function pickHighLevelTemplate(level: number): TemplateResult {
  if (level === 4) return templateBasicPurpleChain();
  // Level 5+: rotate through trade-down and intermediate purple chains; level
  // 6 unlocks multi-item star demands; level 7+ stacks trade-down + extras.
  const pool: (() => TemplateResult)[] = [
    templateTradeDownRequired,
    templateIntermediatePurpleChain,
  ];
  if (level >= 6) pool.push(templateMultiPurpleStar);
  if (level >= 7) pool.push(templateTradeDownPlusIntermediate);
  return pool[Math.floor(Math.random() * pool.length)]();
}

/** Basic four-trade chain: rocks → blue → purple → star. */
function templateBasicPurpleChain(): TemplateResult {
  const targetPurple = pickShape();
  const intermBlue = pickShape();
  return {
    trades: [
      { isStar: true, offerKind: 'star', want: { kind: 'purple', shape: targetPurple } },
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: targetPurple,
        want: { kind: 'blue', shape: intermBlue },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: intermBlue,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 6)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: intermBlue,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 6)) },
      },
    ],
    forbiddenNoiseShapes: [],
  };
}

/**
 * Trade-down required: a trader wants a blue shape that's not for sale, but
 * offers the target purple. The player burns a "side" purple as fall-back to
 * unlock the target purple.
 *   rocks → blue X → purple Y → (fall-back) → purple target → star
 */
function templateTradeDownRequired(): TemplateResult {
  const target = pickShape();
  const filler = pickDifferentShape(target);
  const sidePurple = pickDifferentShape(target);
  const sideBlue = pickDifferentShape(filler);
  return {
    trades: [
      { isStar: true, offerKind: 'star', want: { kind: 'purple', shape: target } },
      // The trade-down trader: wants the missing blue, offers the target purple.
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: target,
        want: { kind: 'blue', shape: filler },
      },
      // Side chain yielding the disposable purple.
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: sidePurple,
        want: { kind: 'blue', shape: sideBlue },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: sideBlue,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: sideBlue,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
    ],
    // Noise must not offer the filler — that's the shape the puzzle requires
    // the player to bypass via the purple fall-back.
    forbiddenNoiseShapes: [filler],
  };
}

/**
 * Intermediate purple-to-purple step: rocks → blue X → purple Y → purple target → star.
 * The Y→target trader wants a purple specifically, so the fall-back rule
 * doesn't bypass it — the player has to actually walk the chain.
 */
function templateIntermediatePurpleChain(): TemplateResult {
  const target = pickShape();
  const interm = pickDifferentShape(target);
  const blueShape = pickShape();
  return {
    trades: [
      { isStar: true, offerKind: 'star', want: { kind: 'purple', shape: target } },
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: target,
        want: { kind: 'purple', shape: interm },
      },
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: interm,
        want: { kind: 'blue', shape: blueShape },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: blueShape,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: blueShape,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
    ],
    forbiddenNoiseShapes: [],
  };
}

/**
 * Multi-item star: the star trader wants TWO different purple shapes at once,
 * each obtained from its own little side chain.
 */
function templateMultiPurpleStar(): TemplateResult {
  const purples = [...SHAPES].sort(() => Math.random() - 0.5);
  const [p1, p2] = purples;
  const blueA = pickShape();
  const blueB = pickDifferentShape(blueA);
  return {
    trades: [
      {
        isStar: true,
        offerKind: 'star',
        want: {
          kind: 'purple',
          shape: p1,
          extras: [{ kind: 'purple', shape: p2 }],
        },
      },
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: p1,
        want: { kind: 'blue', shape: blueA },
      },
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: p2,
        want: { kind: 'blue', shape: blueB },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: blueA,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: blueB,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
    ],
    forbiddenNoiseShapes: [],
  };
}

/**
 * Trade-down PLUS an intermediate purple step. The intermediate trader wants
 * two different blue shapes at once (multi-item), making the side chain longer.
 */
function templateTradeDownPlusIntermediate(): TemplateResult {
  const target = pickShape();
  const filler = pickDifferentShape(target);
  const sidePurple = pickDifferentShape(target);
  const sideBlueA = pickDifferentShape(filler);
  const sideBlueB = pickDifferentShape(sideBlueA);
  return {
    trades: [
      { isStar: true, offerKind: 'star', want: { kind: 'purple', shape: target } },
      // Fall-back gate.
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: target,
        want: { kind: 'blue', shape: filler },
      },
      // Side-purple trader wants two blues simultaneously.
      {
        isStar: false,
        offerKind: 'purple',
        offerShape: sidePurple,
        want: {
          kind: 'blue',
          shape: sideBlueA,
          extras: [{ kind: 'blue', shape: sideBlueB }],
        },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: sideBlueA,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: sideBlueB,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
      {
        isStar: false,
        offerKind: 'blue',
        offerShape: sideBlueA,
        want: { kind: 'rock', rockCount: Math.round(rand(3, 5)) },
      },
    ],
    forbiddenNoiseShapes: [filler],
  };
}

/**
 * Materialise a new cluster: pick its centre, generate its puzzle, and
 * instantiate trader POIs. The cluster is added to state.clusters and the
 * traders to state.pois.
 */
function spawnCluster(state: GameState, now: number): Cluster | null {
  const radius = clusterRadiusForLevel(state.level);
  const center = pickClusterCenter(state, radius);
  const trades = generateClusterTrades(state.level);
  const cluster: Cluster = {
    id: state.nextId++,
    center,
    radius,
    level: state.level,
    createdAt: now,
    trades,
    pendingRespawnAt: [],
    traderIds: [],
  };
  for (let i = 0; i < trades.length; i++) {
    const t = buildTraderFromTrade(state, cluster, trades[i], i, now);
    cluster.traderIds.push(t.id);
    state.pois.push(t);
  }
  state.clusters.push(cluster);
  // Any asteroids that ended up inside the new traders' exclusion zone start
  // fading out — the world keeps trading and mining zones cleanly separated.
  fadeOutAsteroidsNearClusterTraders(state, cluster, now);
  return cluster;
}

function fadeOutAsteroidsNearClusterTraders(
  state: GameState,
  cluster: Cluster,
  now: number,
): void {
  const exclSq = ASTEROID_TRADER_EXCLUSION * ASTEROID_TRADER_EXCLUSION;
  const traderPositions: Vec2[] = state.pois
    .filter((p): p is TraderPOI => p.kind === 'trader' && p.clusterId === cluster.id)
    .map(t => t.pos);
  for (const poi of state.pois) {
    if (poi.kind !== 'asteroid') continue;
    if (poi.fadeOutStart !== undefined) continue;
    for (const t of traderPositions) {
      const dx = poi.pos.x - t.x;
      const dy = poi.pos.y - t.y;
      if (dx * dx + dy * dy < exclSq) {
        poi.fadeOutStart = now;
        break;
      }
    }
  }
}

/**
 * Drop clusters whose centres are far from the ship. All of their traders are
 * also removed so the puzzle is cleared as a group.
 */
function pruneFarClusters(state: GameState): void {
  const ship = state.ship;
  const survivors: Cluster[] = [];
  const cullIds = new Set<number>();
  for (const c of state.clusters) {
    const d = Math.hypot(c.center.x - ship.pos.x, c.center.y - ship.pos.y);
    if (d > CLUSTER_DESPAWN_DIST + c.radius) {
      for (const tid of c.traderIds) cullIds.add(tid);
    } else {
      survivors.push(c);
    }
  }
  if (cullIds.size > 0) {
    state.pois = state.pois.filter(
      p => !(p.kind === 'trader' && cullIds.has(p.id)),
    );
  }
  state.clusters = survivors;
}

/**
 * Called when a player loses an item (pirate steal). If the item still has a
 * known source cluster + trade index AND that cluster is still in the world AND
 * no live trader is already covering that specific trade, schedules a respawn.
 */
function onItemLost(state: GameState, item: Item, now: number): void {
  if (item.sourceClusterId === undefined || item.sourceTradeIdx === undefined) return;
  const cluster = state.clusters.find(c => c.id === item.sourceClusterId);
  if (!cluster) return;
  const trade = cluster.trades[item.sourceTradeIdx];
  if (!trade || trade.isStar) return;
  // Already pending?
  if (cluster.pendingRespawnAt.some(p => p.tradeIdx === item.sourceTradeIdx)) return;
  // Already covered by a live trader with the same offer?
  for (const tid of cluster.traderIds) {
    const live = state.pois.find(
      (p): p is TraderPOI => p.kind === 'trader' && p.id === tid,
    );
    if (
      live &&
      live.offer.kind === trade.offerKind &&
      live.offer.shape === trade.offerShape &&
      !live.done
    ) {
      return;
    }
  }
  cluster.pendingRespawnAt.push({
    tradeIdx: item.sourceTradeIdx,
    at: now + TRADER_RESPAWN_DELAY,
  });
}

/** Materialise any cluster respawns whose timer has elapsed. */
function processClusterRespawns(state: GameState, now: number): void {
  for (const cluster of state.clusters) {
    if (cluster.pendingRespawnAt.length === 0) continue;
    const ready: typeof cluster.pendingRespawnAt = [];
    const remaining: typeof cluster.pendingRespawnAt = [];
    for (const p of cluster.pendingRespawnAt) {
      if (p.at <= now) ready.push(p);
      else remaining.push(p);
    }
    cluster.pendingRespawnAt = remaining;
    for (const p of ready) {
      const trade = cluster.trades[p.tradeIdx];
      if (!trade) continue;
      const t = buildTraderFromTrade(state, cluster, trade, p.tradeIdx, now);
      cluster.traderIds.push(t.id);
      state.pois.push(t);
    }
  }
}

function createPirate(state: GameState, now: number): PiratePOI {
  const pos = spawnRingPosition(state.ship);
  // Morale no longer scales with level — every pirate spawns with the same
  // baseline, and harder difficulty comes from spawn pressure / cargo, not
  // from individual pirate toughness.
  const moraleMax = PIRATE_BASE_MORALE;
  const heading = Math.atan2(state.ship.pos.y - pos.y, state.ship.pos.x - pos.x);
  return {
    id: state.nextId++,
    kind: 'pirate',
    pos,
    radius: 18,
    heading,
    speed: pirateSpeedFor(state.ship),
    fleeing: false,
    despawnAt: 0,
    morale: moraleMax,
    moraleMax,
    spawnTime: now,
  };
}

// ── Tick ───────────────────────────────────────────────────────────────────

/** Advance the simulation by `dt` seconds; `now` is wall-clock ms. */
export function tick(state: GameState, dt: number, now: number): void {
  if (state.transitionStart !== null) {
    advanceTransition(state, dt, now);
    return;
  }

  updateShip(state, dt, now);
  // Camera tracks the ship during normal play.
  state.cameraPos.x = state.ship.pos.x;
  state.cameraPos.y = state.ship.pos.y;
  updatePOIs(state, dt, now);
  pruneFarPOIs(state);
  pruneFarClusters(state);
  maybeSpawn(state, now);
  pruneMessages(state, now);
  pruneFlyingRocks(state, now);

  // If the player just won, kick off the warp transition. We do this AFTER the
  // tick so the trade/collection animation lands a frame first.
  if (state.won && state.transitionStart === null) {
    state.transitionStart = now;
    state.transitionMidpointReached = false;
  }
}

export type TransitionPhase = 'none' | 'warp_out' | 'warp_in' | 'complete';

export function transitionPhase(state: GameState, now: number): TransitionPhase {
  if (state.transitionStart === null) return 'none';
  const elapsed = now - state.transitionStart;
  if (elapsed < WARP_OUT_DURATION) return 'warp_out';
  if (elapsed < WARP_TOTAL_DURATION) return 'warp_in';
  return 'complete';
}

/**
 * Returns the screen-black overlay alpha (0..1) for the current transition state.
 * Peaks at 1.0 at the midpoint (when the world regenerates).
 */
export function transitionFadeAlpha(state: GameState, now: number): number {
  if (state.transitionStart === null) return 0;
  const elapsed = now - state.transitionStart;
  if (elapsed < WARP_OUT_DURATION) {
    // Ease in: world dims as the ship streaks away.
    const t = elapsed / WARP_OUT_DURATION;
    return Math.min(1, t * t * 1.4);
  }
  if (elapsed < WARP_TOTAL_DURATION) {
    const t = (elapsed - WARP_OUT_DURATION) / WARP_IN_DURATION;
    const u = 1 - t;
    return Math.min(1, u * u * 1.4);
  }
  return 0;
}

/**
 * Normalised warp speed [0, 1]: 0 at the start of warp_out, 1 at the midpoint,
 * 0 again at the end of warp_in. Drives both ship motion (via the peak speed
 * implied by `WARP_OFFSCREEN_DIST`) and star-streak length.
 */
export function warpSpeedFractionAt(state: GameState, now: number): number {
  if (state.transitionStart === null) return 0;
  const elapsed = now - state.transitionStart;
  if (elapsed < WARP_OUT_DURATION) {
    const t = elapsed / WARP_OUT_DURATION;
    return Math.sin(t * Math.PI / 2);
  }
  if (elapsed < WARP_TOTAL_DURATION) {
    const t = (elapsed - WARP_OUT_DURATION) / WARP_IN_DURATION;
    return Math.cos(t * Math.PI / 2);
  }
  return 0;
}

/**
 * Current warp speed in world units per second. The peak is sized so the ship
 * exactly covers `WARP_OFFSCREEN_DIST` during the current phase, then eases off.
 */
export function warpSpeedAt(state: GameState, now: number): number {
  if (state.transitionStart === null) return 0;
  const elapsed = now - state.transitionStart;
  if (elapsed < WARP_OUT_DURATION) {
    const dur = WARP_OUT_DURATION / 1000;
    const peak = (WARP_OFFSCREEN_DIST * Math.PI) / (2 * dur);
    const t = elapsed / WARP_OUT_DURATION;
    return peak * Math.sin(t * Math.PI / 2);
  }
  if (elapsed < WARP_TOTAL_DURATION) {
    const dur = WARP_IN_DURATION / 1000;
    const peak = (WARP_OFFSCREEN_DIST * Math.PI) / (2 * dur);
    const t = (elapsed - WARP_OUT_DURATION) / WARP_IN_DURATION;
    return peak * Math.cos(t * Math.PI / 2);
  }
  return 0;
}

function advanceTransition(state: GameState, dt: number, now: number): void {
  const phase = transitionPhase(state, now);
  const ship = state.ship;

  // Streak the ship forward at the current eased warp speed.
  const speed = warpSpeedAt(state, now);
  ship.pos.x += Math.cos(ship.heading) * speed * dt;
  ship.pos.y += Math.sin(ship.heading) * speed * dt;

  // Sample the trail so the warp streak is visible.
  ship.trailPositions.push({ x: ship.pos.x, y: ship.pos.y, t: now });

  pruneMessages(state, now);
  pruneFlyingRocks(state, now);

  if (phase === 'warp_in' && !state.transitionMidpointReached) {
    // Mid-warp: regenerate the world at the next difficulty and place the ship
    // off-screen on the opposite side of the camera so it can streak back in.
    // Total distance for warp_in under the cos-ease is WARP_SPEED * dur * 2/π;
    // place the new ship that far behind the camera so it lands at the camera
    // position exactly when warp_in completes.
    state.transitionMidpointReached = true;
    const heading = ship.heading;
    const startCam = { x: state.cameraPos.x, y: state.cameraPos.y };
    const nextLevel = state.level + 1;
    const fresh = createGameState(state.width, state.height, nextLevel);
    state.ship = fresh.ship;
    state.ship.heading = heading;
    state.pois = fresh.pois;
    state.nextId = fresh.nextId;
    state.won = false;
    state.lastPirateCheck = now;
    state.lastWorldCheck = now;
    state.messages = [];
    state.flyingRocks = [];
    state.level = nextLevel;
    state.cameraPos = startCam;
    state.clusters = fresh.clusters;
    // Spawn the new ship a constant distance behind the camera along its
    // heading — large enough to be off any reasonable screen on any axis.
    state.ship.pos.x = startCam.x - Math.cos(heading) * WARP_OFFSCREEN_DIST;
    state.ship.pos.y = startCam.y - Math.sin(heading) * WARP_OFFSCREEN_DIST;
    state.ship.trailPositions = [{ x: state.ship.pos.x, y: state.ship.pos.y, t: now }];
    return;
  }

  if (phase === 'complete') {
    state.transitionStart = null;
    state.transitionMidpointReached = false;
    state.cameraPos.x = ship.pos.x;
    state.cameraPos.y = ship.pos.y;
  }
}

function updateShip(state: GameState, dt: number, now: number): void {
  const ship = state.ship;
  // Cursor offset is in screen pixels relative to ship; treat it as a continuous
  // steering vector so the ship keeps tracking a stationary cursor.
  const dx = ship.cursorOffset.x;
  const dy = ship.cursorOffset.y;
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

  // Sample trail positions. While the ship is stationary, refresh the tail's
  // timestamp so the ship's anchor stays alive while older samples age out — the
  // visible trail shrinks toward the ship instead of sitting at fixed length.
  const tail = ship.trailPositions[ship.trailPositions.length - 1];
  if (!tail || dist(tail, ship.pos) > 6) {
    ship.trailPositions.push({ x: ship.pos.x, y: ship.pos.y, t: now });
  } else {
    tail.t = now;
  }
  // Drop samples older than the fade window.
  let firstAlive = 0;
  while (
    firstAlive < ship.trailPositions.length - 1 &&
    now - ship.trailPositions[firstAlive].t > TRAIL_FADE_MS
  ) firstAlive++;
  if (firstAlive > 0) ship.trailPositions.splice(0, firstAlive);
}

function updatePOIs(state: GameState, dt: number, now: number): void {
  const dtMs = dt * 1000;
  const ship = state.ship;
  const survivors: POI[] = [];

  for (const poi of state.pois) {
    if (poi.kind === 'asteroid') {
      // Asteroids that are fading out (a cluster spawned over them) skip
      // interaction and disappear once the fade completes.
      if (poi.fadeOutStart !== undefined) {
        if (now - poi.fadeOutStart < ASTEROID_FADE_OUT_MS) survivors.push(poi);
        continue;
      }
      const inRange =
        dist(poi.pos, ship.pos) < INTERACT_RADIUS + asteroidVisualRadius(poi);
      if (inRange && poi.rocksRemaining > 0) {
        poi.breakProgress += dtMs;
        while (poi.breakProgress >= poi.breakInterval && poi.rocksRemaining > 0) {
          poi.breakProgress -= poi.breakInterval;
          poi.rocksRemaining -= 1;
          ship.rocks += 1;
          spawnFlyingRock(state, poi.pos, now);
        }
      } else if (!inRange) {
        poi.breakProgress = 0;
      }
      if (poi.rocksRemaining > 0) survivors.push(poi);
    } else if (poi.kind === 'trader') {
      if (!poi.done) {
        const distToShip = dist(poi.pos, ship.pos);
        if (!poi.encountered && distToShip < TRADER_BUBBLE_DIST) {
          poi.encountered = true;
        }
        // Trading area = trader body. Player must fly INTO the trader to deal.
        const inRange = distToShip < poi.radius;
        if (inRange && shipCanCompleteTrade(ship, poi)) {
          poi.hoverProgress += dtMs;
          if (poi.hoverProgress >= poi.hoverDuration) {
            completeTrade(state, poi, now);
          }
        } else {
          poi.hoverProgress = 0;
        }
        survivors.push(poi);
      } else if (poi.tradeStartAt && now - poi.tradeStartAt < TRADER_OUTRO_DURATION) {
        survivors.push(poi);
      } else {
        // Trader's outro has finished — drop it and unregister from its cluster.
        const cluster = state.clusters.find(c => c.id === poi.clusterId);
        if (cluster) {
          cluster.traderIds = cluster.traderIds.filter(id => id !== poi.id);
        }
      }
    } else if (poi.kind === 'pirate') {
      const stillAlive = updatePirate(state, poi, dt, now);
      if (stillAlive) survivors.push(poi);
    }
  }

  state.pois = survivors;
  updateChain(state.ship);
  updateInventoryAnimations(state, now);
}

function updatePirate(state: GameState, pirate: PiratePOI, dt: number, now: number): boolean {
  const ship = state.ship;

  if (pirate.fleeing) {
    if (now >= pirate.despawnAt) return false;
    // Flee with the same rotate-and-thrust model so it doesn't snap directions.
    const fleeTargetX = pirate.pos.x + (pirate.pos.x - ship.pos.x);
    const fleeTargetY = pirate.pos.y + (pirate.pos.y - ship.pos.y);
    steerPirateTowards(pirate, fleeTargetX, fleeTargetY, PIRATE_FLEE_SPEED, dt);
    return true;
  }

  pirate.speed = pirateSpeedFor(ship);

  // Geometry around the ship.
  const px = pirate.pos.x - ship.pos.x;
  const py = pirate.pos.y - ship.pos.y;
  const distToShip = Math.hypot(px, py) || 1;
  const pirateAngle = Math.atan2(py, px);
  const headingX = Math.cos(ship.heading);
  const headingY = Math.sin(ship.heading);
  // Exposure: 1 if the ship looks straight at the pirate, 0 if looking away.
  const exposure = Math.max(0, (headingX * px + headingY * py) / distToShip);
  const proximity = Math.max(
    0,
    Math.min(1, (PIRATE_DETECTION_RANGE - distToShip) / PIRATE_DETECTION_RANGE),
  );

  // Strongest "this pirate is too close to a trader" factor (0..1).
  let traderProximity = 0;
  let nearestTraderOffset = { x: 0, y: 0, weight: 0 };
  for (const p of state.pois) {
    if (p.kind !== 'trader' || p.done) continue;
    const dx = pirate.pos.x - p.pos.x;
    const dy = pirate.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < PIRATE_TRADER_AVOIDANCE) {
      const factor = (PIRATE_TRADER_AVOIDANCE - d) / PIRATE_TRADER_AVOIDANCE;
      if (factor > traderProximity) traderProximity = factor;
      const m = Math.max(d, 1);
      // Accumulate weighted "push away from traders" vector for retargeting.
      const w = factor * factor;
      nearestTraderOffset.x += (dx / m) * w;
      nearestTraderOffset.y += (dy / m) * w;
      nearestTraderOffset.weight += w;
    }
  }

  // Heavy cargo makes pirates braver — morale drains slower.
  const shapes = shapeCount(ship);
  const cargoBoost = Math.min(0.7, shapes * 0.18 + ship.rocks * 0.018);
  const drain =
    PIRATE_MORALE_DRAIN * exposure * proximity * (1 - cargoBoost) +
    PIRATE_TRADER_MORALE_DRAIN * traderProximity;
  // Recover only when nothing is actively draining morale.
  const recovery = drain < 0.5 ? PIRATE_MORALE_RECOVERY : 0;
  pirate.morale = Math.max(
    0,
    Math.min(pirate.moraleMax, pirate.morale + (recovery - drain) * dt),
  );

  if (pirate.morale <= 0) {
    pirate.fleeing = true;
    pirate.despawnAt = now + PIRATE_FLEE_DURATION;
    pushMessage(state, 'You drove off a pirate!');
    return true;
  }

  // Backoff distance grows as morale depletes — a rattled pirate gives the
  // player a wider berth than a fresh one.
  const moraleFrac = pirate.moraleMax > 0 ? pirate.morale / pirate.moraleMax : 1;
  const backoffDist = PIRATE_BACKOFF_DIST + (1 - moraleFrac) * PIRATE_BACKOFF_MORALE_BONUS;
  const exposedNow = exposure > PIRATE_EXPOSURE_THRESHOLD && distToShip < backoffDist;

  let targetPos: Vec2;
  if (ship.inventory.length > 0 && !exposedNow && traderProximity < 0.5) {
    targetPos = itemRenderPos(state, ship.inventory.length - 1, now);
  } else {
    const desiredDist = exposedNow ? backoffDist : PIRATE_APPROACH_DIST;
    const desiredAngle = ship.heading + Math.PI;
    let delta = desiredAngle - pirateAngle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const step = Math.max(-PIRATE_TURN_RATE * dt, Math.min(PIRATE_TURN_RATE * dt, delta));
    const newAngle = pirateAngle + step;
    targetPos = {
      x: ship.pos.x + Math.cos(newAngle) * desiredDist,
      y: ship.pos.y + Math.sin(newAngle) * desiredDist,
    };
  }

  // Bias the target away from any traders within the avoidance radius — the
  // closer the trader, the harder the push.
  if (nearestTraderOffset.weight > 0) {
    const m = Math.hypot(nearestTraderOffset.x, nearestTraderOffset.y) || 1;
    const push = PIRATE_TRADER_AVOIDANCE * 0.6 * traderProximity;
    targetPos = {
      x: targetPos.x + (nearestTraderOffset.x / m) * push,
      y: targetPos.y + (nearestTraderOffset.y / m) * push,
    };
  }

  // Mutual repulsion: pirates that get too close to each other steer apart so
  // they don't stack on top of one another while chasing the same target.
  let pirateRepulseX = 0;
  let pirateRepulseY = 0;
  let pirateRepulseWeight = 0;
  for (const other of state.pois) {
    if (other === pirate) continue;
    if (other.kind !== 'pirate') continue;
    if (other.fleeing) continue;
    const dx = pirate.pos.x - other.pos.x;
    const dy = pirate.pos.y - other.pos.y;
    const d = Math.hypot(dx, dy);
    if (d >= PIRATE_MUTUAL_REPULSION_DIST || d < 0.0001) continue;
    const factor = (PIRATE_MUTUAL_REPULSION_DIST - d) / PIRATE_MUTUAL_REPULSION_DIST;
    const w = factor * factor;
    pirateRepulseX += (dx / d) * w;
    pirateRepulseY += (dy / d) * w;
    pirateRepulseWeight += w;
  }
  if (pirateRepulseWeight > 0) {
    const m = Math.hypot(pirateRepulseX, pirateRepulseY) || 1;
    const push = PIRATE_MUTUAL_REPULSION_DIST * 0.9;
    targetPos = {
      x: targetPos.x + (pirateRepulseX / m) * push,
      y: targetPos.y + (pirateRepulseY / m) * push,
    };
  }

  steerPirateTowards(pirate, targetPos.x, targetPos.y, pirate.speed, dt);

  // Item grab — touching a trailing item snatches that item, then flees.
  for (let i = 0; i < ship.inventory.length; i++) {
    const item = ship.inventory[i];
    const ip = itemRenderPos(state, i, now);
    if (Math.hypot(pirate.pos.x - ip.x, pirate.pos.y - ip.y) < pirate.radius + PIRATE_ITEM_GRAB_PAD) {
      pirate.carriedItem = item;
      removeInventoryItem(state, i, now);
      onItemLost(state, item, now);
      pushMessage(state, `Pirate stole your ${describeItem(item.kind, item.shape)}!`);
      pirate.fleeing = true;
      pirate.despawnAt = now + PIRATE_FLEE_DURATION;
      return true;
    }
  }

  // Ship contact — only happens when there are no items to grab. Shield first,
  // then rocks; falls back to "nothing to steal" on an empty hold.
  if (distToShip < SHIP_RADIUS + pirate.radius) {
    if (ship.shields > 0) {
      ship.shields -= 1;
      pushMessage(state, 'Shield blocked the attack!');
    } else if (ship.rocks > 0) {
      const taken = Math.min(PIRATE_STEAL_ROCKS, ship.rocks);
      ship.rocks -= taken;
      pushMessage(state, taken === 1 ? 'Pirate stole a rock!' : `Pirate stole ${taken} rocks!`);
    } else {
      pushMessage(state, 'Pirate found nothing to steal.');
    }
    pirate.fleeing = true;
    pirate.despawnAt = now + PIRATE_FLEE_DURATION;
  }

  return true;
}

/**
 * Ship-style steering for pirates: rotate the heading toward the target, then
 * thrust forward (faded by alignment) so it accelerates smoothly into a turn
 * rather than skidding sideways toward a moving target.
 */
function steerPirateTowards(
  pirate: PiratePOI,
  tx: number,
  ty: number,
  maxSpeed: number,
  dt: number,
): void {
  const dx = tx - pirate.pos.x;
  const dy = ty - pirate.pos.y;
  if (dx * dx + dy * dy < 0.25) return;
  const desired = Math.atan2(dy, dx);
  let delta = desired - pirate.heading;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const turn = Math.max(
    -PIRATE_HEADING_TURN_RATE * dt,
    Math.min(PIRATE_HEADING_TURN_RATE * dt, delta),
  );
  pirate.heading += turn;
  // Reduce thrust when the nose isn't pointed at the target — turn first, dash second.
  const alignment = Math.max(0, Math.cos(delta));
  const speed = maxSpeed * (0.35 + 0.65 * alignment);
  pirate.pos.x += Math.cos(pirate.heading) * speed * dt;
  pirate.pos.y += Math.sin(pirate.heading) * speed * dt;
}

function pruneFarPOIs(state: GameState): void {
  const ship = state.ship;
  // Cluster-owned traders are managed by `pruneFarClusters` — they're allowed
  // to live further than POI_DESPAWN_DIST so a cluster spawned out near the
  // edge of the spawn ring isn't half-culled the moment it materialises.
  state.pois = state.pois.filter(p => {
    if (p.kind === 'trader') return true;
    return dist(p.pos, ship.pos) < POI_DESPAWN_DIST;
  });
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
    while (state.pois.filter(p => p.kind === 'asteroid').length < TARGET_ASTEROIDS) {
      state.pois.push(createAsteroid(state, now));
    }
    // Maintain the target cluster count near the ship.
    while (state.clusters.length < TARGET_CLUSTERS) {
      if (!spawnCluster(state, now)) break;
    }
    processClusterRespawns(state, now);
  }

  if (now - state.lastPirateCheck >= PIRATE_CHECK_INTERVAL) {
    state.lastPirateCheck = now;
    const ship = state.ship;
    const shapes = shapeCount(ship);
    // Pirates only show up once the player is hauling a worthwhile load.
    if (ship.rocks > 4 || shapes > 1) {
      // Don't spawn a pirate while the player is bunched up with a trader —
      // pirates avoid traders, so spawning one nearby is just immediate flight.
      const guardDist = state.width * PIRATE_TRADER_SPAWN_GUARD;
      let nearestTraderDist = Infinity;
      for (const p of state.pois) {
        if (p.kind === 'trader' && !p.done) {
          const d = dist(p.pos, ship.pos);
          if (d < nearestTraderDist) nearestTraderDist = d;
        }
      }
      if (nearestTraderDist >= guardDist) {
        const pirateCount = state.pois.filter(p => p.kind === 'pirate' && !(p as PiratePOI).fleeing).length;
        // Spawn pressure scales with how dangerous the haul is.
        const tier = ship.rocks > 12 || shapes > 3 ? 3 : ship.rocks > 8 || shapes > 2 ? 2 : 1;
        const chance = tier === 3 ? 0.7 : tier === 2 ? 0.45 : 0.25;
        const cap = tier === 3 ? 3 : tier === 2 ? 2 : 1;
        if (pirateCount < cap && Math.random() < chance) {
          state.pois.push(createPirate(state, now));
        }
      }
    }
  }
}

// ── Trade logic ───────────────────────────────────────────────────────────

/** All individual requirements that must be paid to complete the trade. */
export function wantRequirements(want: TradeWant): TradeRequirement[] {
  const reqs: TradeRequirement[] = [
    { kind: want.kind, shape: want.shape, rockCount: want.rockCount },
  ];
  if (want.extras) reqs.push(...want.extras);
  return reqs;
}

interface TradePlan {
  /** Inventory indices to remove (descending so splices stay valid). */
  inventoryRemove: number[];
  rocks: number;
  shields: number;
}

/**
 * Direct-match payment: every requirement must be paid in the exact item the
 * trader asked for. No purple-for-blue substitution, no rocks-for-purple shortcut.
 */
function planNormalTradePayment(ship: Ship, trader: TraderPOI): TradePlan | null {
  const reqs = wantRequirements(trader.want);
  const usedInventory = new Set<number>();
  let rocksNeeded = 0;
  let shieldsNeeded = 0;

  for (const req of reqs) {
    if (req.kind === 'rock') {
      rocksNeeded += req.rockCount ?? 1;
      continue;
    }
    if (req.kind === 'shield') {
      shieldsNeeded += 1;
      continue;
    }
    let idx = -1;
    for (let i = 0; i < ship.inventory.length; i++) {
      if (usedInventory.has(i)) continue;
      const it = ship.inventory[i];
      if (it.kind === req.kind && (!req.shape || it.shape === req.shape)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    usedInventory.add(idx);
  }

  if (ship.rocks < rocksNeeded) return null;
  if (ship.shields < shieldsNeeded) return null;
  return {
    inventoryRemove: Array.from(usedInventory).sort((a, b) => b - a),
    rocks: rocksNeeded,
    shields: shieldsNeeded,
  };
}

/**
 * Trade-down ("burn a purple") payment. Only valid when the normal payment is
 * NOT possible. Rule sequence:
 *   1. If primary want is a purple shape → no alternate.
 *   2. If primary want is rocks (single requirement) and the player has any
 *      purple → one purple substitutes for the entire rocks demand.
 *   3. Otherwise (primary is blue), match each requirement directly first;
 *      every remaining blue requirement consumes one purple (oldest first).
 *      Anything that isn't a blue requirement must be satisfied directly.
 */
function planAlternateTradePayment(ship: Ship, trader: TraderPOI): TradePlan | null {
  // Step 2: no alternate when the primary want is a purple shape.
  if (trader.want.kind === 'purple') return null;

  // Step 3: rocks-only trade. Any purple substitutes for the entire pile.
  if (trader.want.kind === 'rock' && (!trader.want.extras || trader.want.extras.length === 0)) {
    const idx = oldestPurpleIndex(ship.inventory, new Set());
    if (idx < 0) return null;
    return { inventoryRemove: [idx], rocks: 0, shields: 0 };
  }

  // Step 4: blue-want trade (possibly multi-item). Direct-match every
  // requirement first; substitute purples for unmatched blue requirements.
  const reqs = wantRequirements(trader.want);
  const usedInventory = new Set<number>();
  let rocksNeeded = 0;
  let shieldsNeeded = 0;
  let unmatchedBlues = 0;

  for (const req of reqs) {
    if (req.kind === 'rock') {
      rocksNeeded += req.rockCount ?? 1;
      continue;
    }
    if (req.kind === 'shield') {
      shieldsNeeded += 1;
      continue;
    }
    let idx = -1;
    for (let i = 0; i < ship.inventory.length; i++) {
      if (usedInventory.has(i)) continue;
      const it = ship.inventory[i];
      if (it.kind === req.kind && (!req.shape || it.shape === req.shape)) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      usedInventory.add(idx);
      continue;
    }
    if (req.kind === 'blue') {
      unmatchedBlues += 1;
      continue;
    }
    // Unmatched non-blue (purple/star/etc.) — no substitution available.
    return null;
  }

  for (let i = 0; i < unmatchedBlues; i++) {
    const idx = oldestPurpleIndex(ship.inventory, usedInventory);
    if (idx < 0) return null;
    usedInventory.add(idx);
  }

  if (ship.rocks < rocksNeeded) return null;
  if (ship.shields < shieldsNeeded) return null;
  return {
    inventoryRemove: Array.from(usedInventory).sort((a, b) => b - a),
    rocks: rocksNeeded,
    shields: shieldsNeeded,
  };
}

/**
 * Inventory index of the oldest unused purple, or -1. inventory[0] is the
 * newest item (unshifted on collection), so we walk from the back.
 */
function oldestPurpleIndex(inv: Item[], used: Set<number>): number {
  for (let i = inv.length - 1; i >= 0; i--) {
    if (used.has(i)) continue;
    if (inv[i].kind === 'purple') return i;
  }
  return -1;
}

/** True if any trade plan (normal or alt) can settle this trade right now. */
export function shipCanCompleteTrade(ship: Ship, trader: TraderPOI): boolean {
  return planNormalTradePayment(ship, trader) !== null ||
    planAlternateTradePayment(ship, trader) !== null;
}

/** True iff every requirement is paid in its exact item (no substitutions). */
export function shipMeetsTraderWant(ship: Ship, want: TradeWant): boolean {
  for (const req of wantRequirements(want)) {
    if (req.kind === 'rock') {
      if (ship.rocks < (req.rockCount ?? 1)) return false;
    } else if (req.kind === 'shield') {
      if (ship.shields <= 0) return false;
    } else {
      const found = ship.inventory.some(
        it => it.kind === req.kind && (!req.shape || it.shape === req.shape),
      );
      if (!found) return false;
    }
  }
  return true;
}

/**
 * The exact list of items the player will hand over under the alternate trade,
 * or null when the alt trade isn't currently available (or normal trade already
 * works — alt is suppressed in that case). Used by the renderer to draw the
 * trade-down bubble with the *actual* substitution items, not a placeholder.
 */
export function getAlternateTradeItems(
  ship: Ship,
  trader: TraderPOI,
): TradeRequirement[] | null {
  if (planNormalTradePayment(ship, trader) !== null) return null;
  const plan = planAlternateTradePayment(ship, trader);
  if (plan === null) return null;
  const items: TradeRequirement[] = [];
  if (plan.rocks > 0) items.push({ kind: 'rock', rockCount: plan.rocks });
  if (plan.shields > 0) items.push({ kind: 'shield' });
  for (const idx of [...plan.inventoryRemove].sort((a, b) => a - b)) {
    const it = ship.inventory[idx];
    items.push({ kind: it.kind, shape: it.shape });
  }
  return items;
}

/**
 * Apply the trade's payment. Prefers the normal plan; only burns a purple
 * fallback when the normal plan can't be satisfied. Items are removed and
 * reported as "lost" so any originating trader can be queued for respawn.
 */
function consumeTraderPayment(state: GameState, trader: TraderPOI, now: number): boolean {
  const plan = planNormalTradePayment(state.ship, trader)
    ?? planAlternateTradePayment(state.ship, trader);
  if (!plan) return false;
  for (const idx of plan.inventoryRemove) {
    onItemLost(state, state.ship.inventory[idx], now);
    removeInventoryItem(state, idx, now);
  }
  state.ship.rocks = Math.max(0, state.ship.rocks - plan.rocks);
  state.ship.shields = Math.max(0, state.ship.shields - plan.shields);
  return true;
}

function completeTrade(state: GameState, trader: TraderPOI, now: number): void {
  if (!consumeTraderPayment(state, trader, now)) return;
  grantItemToShip(state, trader.offer, now, trader.pos);
  trader.done = true;
  trader.hoverProgress = 0;
  trader.tradeStartAt = now;
  pushMessage(state, `Traded for ${describeItem(trader.offer.kind)}.`);
}

/**
 * Move an item into the ship. Trail items (blue/purple/star) are unshifted so
 * the newest item occupies slot 0 (closest to the ship). Each existing item
 * starts a fresh tween from its current render position to its new chain slot,
 * and a new chain point is appended at the back so there's always one more
 * point than there are items.
 */
function grantItemToShip(state: GameState, item: Item, now: number, sourcePos?: Vec2): void {
  if (item.kind === 'rock') {
    state.ship.rocks += 1;
    pushMessage(state, 'Got a rock!');
    return;
  }
  if (item.kind === 'shield') {
    state.ship.shields += 1;
    pushMessage(state, 'Picked up a shield!');
    return;
  }

  // Capture existing items' on-screen positions before they shift back.
  freezeItemRenderPositions(state, now);

  // Append a new chain point at the position of the current last point so the
  // back item has somewhere to slide into.
  const lastChain = state.ship.chain[state.ship.chain.length - 1];
  const seed = lastChain ? lastChain.pos : state.ship.pos;
  state.ship.chain.push({ pos: { x: seed.x, y: seed.y } });

  // New item flies in from its source (asteroid / trader hands).
  const startPos = sourcePos ?? state.ship.pos;
  item.prevPos = { x: startPos.x, y: startPos.y };
  item.moveStart = now;
  item.locked = false;
  state.ship.inventory.unshift(item);

  if (item.kind === 'star') {
    state.won = true;
    pushMessage(state, 'You found the Star! Mission complete.', 6000);
  } else {
    pushMessage(state, `Got ${describeItem(item.kind, item.shape)}!`);
  }
}

/**
 * Remove an inventory item by index, triggering a slot-shift tween for items
 * behind it and dropping the trailing chain point.
 */
function removeInventoryItem(state: GameState, idx: number, now: number): void {
  // Freeze current positions for items that will shift down a slot.
  for (let i = idx + 1; i < state.ship.inventory.length; i++) {
    const item = state.ship.inventory[i];
    const cur = itemRenderPos(state, i, now);
    item.prevPos = cur;
    item.moveStart = now;
    item.locked = false;
  }
  state.ship.inventory.splice(idx, 1);
  state.ship.chain.pop();
}

// ── Public input handlers ─────────────────────────────────────────────────

/** Set the ship's steering target from a screen-space (canvas) point. */
export function setShipTargetFromScreen(state: GameState, screenX: number, screenY: number): void {
  state.ship.cursorOffset.x = screenX - state.width / 2;
  state.ship.cursorOffset.y = screenY - state.height / 2;
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
  state.cameraPos = { x: 0, y: 0 };
  state.transitionStart = null;
  state.transitionMidpointReached = false;
  state.clusters = fresh.clusters;
}

export function setLevel(state: GameState, level: number): void {
  state.level = level;
  resetGame(state);
}

// ── UI helpers ────────────────────────────────────────────────────────────

export function describeItem(kind: ItemKind, shape?: Shape): string {
  if (kind === 'rock') return 'rock';
  if (kind === 'shield') return 'shield';
  if (kind === 'star') return 'star';
  if (shape) return `${kind} ${shape}`;
  return kind;
}

export function describeWant(want: TradeWant): string {
  if (want.kind === 'rock') return `${want.rockCount ?? 1} rocks`;
  return describeItem(want.kind, want.shape);
}

/** Convert a world position to canvas (screen) coordinates centered on the camera. */
export function worldToScreen(state: GameState, p: Vec2): Vec2 {
  return {
    x: p.x - state.cameraPos.x + state.width / 2,
    y: p.y - state.cameraPos.y + state.height / 2,
  };
}

export function isOnScreen(state: GameState, p: Vec2, pad = 50): boolean {
  const s = worldToScreen(state, p);
  return s.x > -pad && s.x < state.width + pad && s.y > -pad && s.y < state.height + pad;
}

export function activeMessages(state: GameState, now: number): GameMessage[] {
  return state.messages.filter(m => m.expiresAt > now);
}
