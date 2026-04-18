// Bubbles Game — Core type definitions

export interface Difficulty {
  /** Average bubble radius in px */
  avgSize: number;
  /** Average bubble linear speed in px/sec */
  avgSpeed: number;
  /** 0..1 — frequency and magnitude of random velocity changes */
  randomness: number;
  /** 0..1 — probability a spawned bubble is a special sparkle bubble */
  specialChance: number;
  /** ms between spawns */
  spawnInterval: number;
}

export interface Bubble {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Current drawn radius (grows toward targetRadius during grow-in) */
  radius: number;
  targetRadius: number;
  /** true = spawned in-screen growing from tiny to full */
  growing: boolean;
  /** Whether the bubble has reached full size (for off-screen culling) */
  grown: boolean;
  /** Took half-damage from a multi-touch miss */
  damaged: boolean;
  /** Sparkly special bubble — worth more points */
  special: boolean;
  /** Timestamp when bubble spawned */
  spawnTime: number;
  /** Hue used for fill (HSL) */
  hue: number;
  /** Last time a random velocity nudge was applied */
  lastNudgeTime: number;
  /** Timestamp of the touch that started the 200ms pop window (if any) */
  pendingTouchTime?: number;
}

export interface GameStats {
  score: number;
  popped: number;
  /** Bubbles that drifted off-screen without being popped */
  missed: number;
  /** Touches that didn't hit any bubble */
  mistouches: number;
  /** 0..1 — rolling recent success rate */
  successRate: number;
  /** Pops per second over last window */
  popRate: number;
  difficulty: Difficulty;
}

export interface GameState {
  bubbles: Bubble[];
  stats: GameStats;
  /** Timestamps of recent pops (for rate/difficulty) */
  recentPops: number[];
  /** Timestamps of recent misses (off-screen) */
  recentMisses: number[];
  /** Timestamps of recent mistouches */
  recentMistouches: number[];
  lastSpawnTime: number;
  lastDifficultyAdjust: number;
  width: number;
  height: number;
  nextId: number;
  /** Timestamp of most recent pointer-down (any location) */
  lastTouchTime: number;
}

/** Result of a pointer-down hit test */
export interface TouchResult {
  /** A bubble was hit */
  hit: boolean;
  /** A bubble was popped (score awarded) */
  popped: boolean;
  /** Bubble took half-damage from multi-touch */
  damaged: boolean;
  bubble?: Bubble;
}
