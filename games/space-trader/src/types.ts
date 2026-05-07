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
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A trail-position sample with the wall-clock time it was recorded. */
export type TrailSample = Vec2 & { t: number };

/**
 * Trader's stated demand. If `kind === 'rock'` they want `rockCount` rocks.
 * For blue/purple/star/shield they want one matching item with `shape` (when applicable).
 */
export interface TradeWant {
  kind: ItemKind;
  shape?: Shape;
  rockCount?: number;
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
}

export interface AsteroidPOI {
  id: number;
  kind: 'asteroid';
  pos: Vec2;
  /** Visual radius in world units. */
  radius: number;
  /** Total rocks the asteroid will yield as it breaks down. */
  rocksRemaining: number;
  /** Optional hidden item revealed when the asteroid is destroyed. */
  containedItem?: Item;
  /** ms accumulator while the ship is within range; resets after each rock pop. */
  breakProgress: number;
  /** ms required to break off one rock. */
  breakInterval: number;
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
  /** True for traders that ask for a higher-value item than they offer. */
  badDeal: boolean;
}

export interface PiratePOI {
  id: number;
  kind: 'pirate';
  pos: Vec2;
  radius: number;
  /** Speed in world units / second when chasing. */
  speed: number;
  /** True once the pirate has stolen something or popped a shield — then flees. */
  fleeing: boolean;
  /** ms timestamp at which the pirate despawns (only set while fleeing). */
  despawnAt: number;
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
  /** True once the player picks up the star. */
  won: boolean;
  /** ms timestamp of last pirate-spawn evaluation. */
  lastPirateCheck: number;
  /** ms timestamp of last topup-spawn evaluation (asteroids/traders). */
  lastWorldCheck: number;
  /** Floating user-facing notifications (e.g. "got blue circle"). */
  messages: GameMessage[];
  /** Active rock-chip flight animations. */
  flyingRocks: FlyingRock[];
}
