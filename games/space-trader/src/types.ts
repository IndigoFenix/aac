// Space Trader — Core type definitions

export type Shape = 'circle' | 'triangle' | 'square';

/** Item kinds, ordered by ascending value (rock cheapest, star wins). */
export type ItemKind = 'rock' | 'blue' | 'purple' | 'star' | 'shield';

export interface Item {
  /** Unique id used to render trails / animations consistently. */
  id: number;
  kind: ItemKind;
  /** Required for blue/purple items, optional otherwise. */
  shape?: Shape;
  /**
   * Slot-transition tween. Items normally render LOCKED to their assigned
   * chain point (`Ship.chain[idx]`). When the item shifts slots (a new item
   * arrives or one is removed), `locked` flips to false and the render position
   * eases from `prevPos` to the new chain point over `moveDuration`; once the
   * tween completes the item locks again.
   */
  prevPos: Vec2;
  moveStart: number;
  moveDuration: number;
  locked: boolean;
  /** Cluster the item came from — used to respawn the trader if the player loses it. */
  sourceClusterId?: number;
  /** Index into the cluster's `trades` array identifying which trader offered this item. */
  sourceTradeIdx?: number;
}

/**
 * Invisible follow-point in the trailing chain. Slides toward the point ahead
 * (or the ship for slot 0) only when farther than `CHAIN_SPACING`, so the chain
 * preserves its spacing when the ship is stationary.
 */
export interface ChainPoint {
  pos: Vec2;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A trail-position sample with the wall-clock time it was recorded. */
export type TrailSample = Vec2 & { t: number };

/** One requirement entry inside a (possibly multi-item) `TradeWant`. */
export interface TradeRequirement {
  kind: ItemKind;
  shape?: Shape;
  rockCount?: number;
}

/**
 * Trader's stated demand. Always carries a primary requirement (`kind`/`shape`/
 * `rockCount`); `extras` allows multi-item trades where the player must pay
 * with several distinct items at once. Multi-item examples: "I want a blue
 * triangle AND a blue square," or "give me two different purples."
 */
export interface TradeWant extends TradeRequirement {
  extras?: TradeRequirement[];
}

export interface Ship {
  pos: Vec2;
  /** Current heading in radians (0 = right, +y = down, π/2 = down). */
  heading: number;
  /**
   * Cursor position relative to the ship in screen pixels (cursor − screen-center).
   * Re-evaluated each frame so the ship keeps tracking a stationary cursor; the
   * magnitude doubles as a throttle (close to ship → slow / stop).
   */
  cursorOffset: Vec2;
  /** Rocks held (stack count, not individual items). */
  rocks: number;
  /** Shields held — passive defense, count rendered as orbiting dots. */
  shields: number;
  /** Items being towed (renders as a trail behind the ship). */
  inventory: Item[];
  /** Recent ship positions used to render the item trail. Older samples fade out. */
  trailPositions: TrailSample[];
  /**
   * Chain of follow-points behind the ship. Always exactly `inventory.length + 1`
   * entries — the extra "spare" point at the back gives the next-bumped item
   * somewhere to slide into. Items at inventory index `i` render at `chain[i]`.
   */
  chain: ChainPoint[];
}

export interface AsteroidPOI {
  id: number;
  kind: 'asteroid';
  pos: Vec2;
  /**
   * Full-size visual radius (when at `initialRocks`). Effective drawn radius
   * scales with remaining rocks.
   */
  radius: number;
  /** Total rocks the asteroid will yield as it breaks down. */
  rocksRemaining: number;
  /** Original rocks count — used to scale visual size as the asteroid shrinks. */
  initialRocks: number;
  /** ms accumulator while the ship is within range; resets after each rock pop. */
  breakProgress: number;
  /** ms required to break off one rock. */
  breakInterval: number;
  /** ms timestamp the asteroid spawned — drives the radar fade-in. */
  spawnTime: number;
  /** ms timestamp when this asteroid started fading out (cleared by a cluster spawn). */
  fadeOutStart?: number;
}

export interface TraderPOI {
  id: number;
  kind: 'trader';
  pos: Vec2;
  radius: number;
  want: TradeWant;
  /** Item the trader hands over once `want` is satisfied. */
  offer: Item;
  /** True once the trade has been completed (trader becomes idle). */
  done: boolean;
  /** ms accumulator while the ship is in range (must hover to trade). */
  hoverProgress: number;
  /** ms required to complete a trade. */
  hoverDuration: number;
  /** ms timestamp when the trade completed — drives swap/smile/ripple animation. */
  tradeStartAt?: number;
  /** True once the player has approached close enough to read this trader's bubble. */
  encountered: boolean;
  /** Cluster this trader belongs to. */
  clusterId: number;
  /** ms timestamp the trader spawned — drives the inwards-ripple fade-in. */
  spawnTime: number;
}

/**
 * A cluster of traders forming a single "puzzle" leading to a star trade.
 * Generated and destroyed as a unit so puzzles aren't half-loaded across the map.
 */
export interface Cluster {
  id: number;
  /** Invisible centre in world coordinates. */
  center: Vec2;
  /** Invisible radius — traders spawn inside this disc. */
  radius: number;
  /** Difficulty level used to generate the puzzle. */
  level: number;
  /** ms timestamp the cluster was created (for fade-in / staleness checks). */
  createdAt: number;
  /**
   * Original trade definitions used to repopulate the cluster if a trader is
   * lost (e.g. pirate steals an offer item). Indexed alongside `traderIds`.
   */
  trades: ClusterTrade[];
  /** ms timestamp when a missing trader is due to respawn (lost-item recovery). */
  pendingRespawnAt: { tradeIdx: number; at: number }[];
  /** ids of currently-living TraderPOIs spawned from this cluster. */
  traderIds: number[];
}

/** Abstract trade definition stored on the cluster for respawning purposes. */
export interface ClusterTrade {
  want: TradeWant;
  /** Captured offer description (kind + shape) — a fresh Item is built on respawn. */
  offerKind: ItemKind;
  offerShape?: Shape;
  /** True if this is the star trade (only one per cluster). */
  isStar: boolean;
}

export interface PiratePOI {
  id: number;
  kind: 'pirate';
  pos: Vec2;
  radius: number;
  /** Direction the pirate is facing (radians). Steers like the player ship. */
  heading: number;
  /** Speed in world units / second when chasing. */
  speed: number;
  /** True once the pirate has stolen something or popped a shield — then flees. */
  fleeing: boolean;
  /** ms timestamp at which the pirate despawns (only set while fleeing). */
  despawnAt: number;
  /**
   * Drains while the ship faces the pirate (scaled by alignment × proximity).
   * Once it hits 0 the pirate flees regardless of whether contact was made.
   * Higher difficulty levels and heavier player cargo start morale higher.
   */
  morale: number;
  /** The morale value the pirate spawned with — used to render a depletion bar. */
  moraleMax: number;
  /** Item the pirate snatched (rendered dragging behind it while it flees). */
  carriedItem?: Item;
  /** ms timestamp the pirate spawned — drives the radar fade-in. */
  spawnTime: number;
}

export type POI = AsteroidPOI | TraderPOI | PiratePOI;

export interface GameMessage {
  id: number;
  text: string;
  /** ms timestamp when the message expires (and stops rendering). */
  expiresAt: number;
}

/**
 * Short-lived visual: a rock chip animating from an asteroid to the ship's orbit.
 * The corresponding `ship.rocks` slot is reserved while the chip is in flight,
 * so the orbit visual only fills in once the chip arrives.
 */
export interface FlyingRock {
  id: number;
  startPos: Vec2;
  /** ms timestamp the rock began flying. */
  startTime: number;
  /** Total flight duration in ms. */
  duration: number;
}

export interface GameState {
  ship: Ship;
  pois: POI[];
  /** Increments to allocate new ids for items, POIs and messages. */
  nextId: number;
  /** Canvas dimensions in CSS pixels — updated on resize. */
  width: number;
  height: number;
  /** Difficulty level; controls win condition and asteroid/trader composition. */
  level: number;
  /** True once the player picks up the star (used to drive the warp transition). */
  won: boolean;
  /** ms timestamp of last pirate-spawn evaluation. */
  lastPirateCheck: number;
  /** ms timestamp of last topup-spawn evaluation (asteroids/traders). */
  lastWorldCheck: number;
  /** Floating user-facing notifications (e.g. "got blue circle"). */
  messages: GameMessage[];
  /** Active rock-chip flight animations. */
  flyingRocks: FlyingRock[];
  /**
   * Camera origin in world space. Tracks the ship during normal play; frozen
   * during a warp transition so the ship can fly off-screen and come back from
   * the other side.
   */
  cameraPos: Vec2;
  /** ms timestamp when a level-end warp transition started, or null. */
  transitionStart: number | null;
  /** Flips true once we've regenerated the world for the next level (one-shot). */
  transitionMidpointReached: boolean;
  /** Active trader clusters in the world. */
  clusters: Cluster[];
}
