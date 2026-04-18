// Bubbles Game — Pure game logic: spawning, physics, hit-testing, difficulty.

import type { Bubble, Difficulty, GameState, TouchResult } from './types';

export const POP_WINDOW_MS = 200;     // expansion window after initial touch
export const GROWTH_RATE_PX_PER_S = 80; // grow-in speed for in-place spawns
export const RATE_WINDOW_MS = 10_000;  // rolling window for rate stats
export const DIFFICULTY_ADJUST_MS = 4000; // how often difficulty retunes
export const MAX_BUBBLES = 20;
export const NUDGE_INTERVAL_MS = 500;

export const INITIAL_DIFFICULTY: Difficulty = {
  avgSize: 80,
  avgSpeed: 60,
  randomness: 0.2,
  specialChance: 0.05,
  spawnInterval: 1600,
};

const DIFF_MIN: Difficulty = {
  avgSize: 50,
  avgSpeed: 25,
  randomness: 0.1,
  specialChance: 0.03,
  spawnInterval: 900,
};

const DIFF_MAX: Difficulty = {
  avgSize: 140,
  avgSpeed: 40,
  randomness: 0.05,
  specialChance: 0.02,
  spawnInterval: 2400,
};

const HARD_DIFF: Difficulty = {
  avgSize: 40,
  avgSpeed: 160,
  randomness: 0.6,
  specialChance: 0.12,
  spawnInterval: 700,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomHue(): number {
  return Math.floor(Math.random() * 360);
}

export function createGameState(width: number, height: number): GameState {
  return {
    bubbles: [],
    stats: {
      score: 0,
      popped: 0,
      missed: 0,
      mistouches: 0,
      successRate: 1,
      popRate: 0,
      difficulty: { ...INITIAL_DIFFICULTY },
    },
    recentPops: [],
    recentMisses: [],
    recentMistouches: [],
    lastSpawnTime: 0,
    lastDifficultyAdjust: 0,
    width,
    height,
    nextId: 1,
    lastTouchTime: 0,
  };
}

export function resizeGame(state: GameState, width: number, height: number): void {
  state.width = width;
  state.height = height;
}

function spawnBubble(state: GameState, now: number): void {
  const { difficulty, score } = state.stats;
  const size = difficulty.avgSize * rand(0.7, 1.3);
  const speed = difficulty.avgSpeed * rand(0.6, 1.4);
  const special = Math.random() < difficulty.specialChance;
  const targetRadius = special ? size * 1.1 : size;

  // Decide: spawn from edge (moving inward) or spawn in-place (growing)
  const fromEdge = Math.random() < 0.5;
  let x: number, y: number, vx: number, vy: number;
  let growing = false;
  let initialRadius = targetRadius;

  if (fromEdge) {
    const edge = Math.floor(Math.random() * 4);
    const margin = targetRadius;
    if (edge === 0) { // top
      x = rand(margin, state.width - margin);
      y = -margin;
      vx = rand(-speed, speed) * 0.5;
      vy = speed;
    } else if (edge === 1) { // right
      x = state.width + margin;
      y = rand(margin, state.height - margin);
      vx = -speed;
      vy = rand(-speed, speed) * 0.5;
    } else if (edge === 2) { // bottom
      x = rand(margin, state.width - margin);
      y = state.height + margin;
      vx = rand(-speed, speed) * 0.5;
      vy = -speed;
    } else { // left
      x = -margin;
      y = rand(margin, state.height - margin);
      vx = speed;
      vy = rand(-speed, speed) * 0.5;
    }
  } else {
    x = rand(targetRadius, state.width - targetRadius);
    y = rand(targetRadius, state.height - targetRadius);
    const angle = Math.random() * Math.PI * 2;
    vx = Math.cos(angle) * speed * 0.4;
    vy = Math.sin(angle) * speed * 0.4;
    growing = true;
    initialRadius = 4;
  }

  state.bubbles.push({
    id: state.nextId++,
    x, y, vx, vy,
    radius: initialRadius,
    targetRadius,
    growing,
    grown: !growing,
    damaged: false,
    special,
    spawnTime: now,
    hue: special ? 50 : randomHue(),
    lastNudgeTime: now,
  });

  state.lastSpawnTime = now;
  // keep score referenced so linter doesn't complain on destructure
  void score;
}

function pruneWindow(times: number[], now: number): number {
  let keepFrom = 0;
  for (let i = 0; i < times.length; i++) {
    if (now - times[i] <= RATE_WINDOW_MS) { keepFrom = i; break; }
    keepFrom = i + 1;
  }
  if (keepFrom > 0) times.splice(0, keepFrom);
  return times.length;
}

function updateStats(state: GameState, now: number): void {
  const pops = pruneWindow(state.recentPops, now);
  const misses = pruneWindow(state.recentMisses, now);
  pruneWindow(state.recentMistouches, now);
  const attempts = pops + misses;
  state.stats.successRate = attempts > 0 ? pops / attempts : 1;
  state.stats.popRate = pops / (RATE_WINDOW_MS / 1000);
}

function lerpDifficulty(t: number): Difficulty {
  // t in [-1, +1]. -1 = easy (DIFF_MAX), 0 = INITIAL, +1 = hard (HARD_DIFF)
  const clamp = Math.max(-1, Math.min(1, t));
  const base = INITIAL_DIFFICULTY;
  const target = clamp >= 0 ? HARD_DIFF : DIFF_MAX;
  const k = Math.abs(clamp);
  const blend = (a: number, b: number) => a + (b - a) * k;
  const result: Difficulty = {
    avgSize: blend(base.avgSize, target.avgSize),
    avgSpeed: blend(base.avgSpeed, target.avgSpeed),
    randomness: blend(base.randomness, target.randomness),
    specialChance: blend(base.specialChance, target.specialChance),
    spawnInterval: blend(base.spawnInterval, target.spawnInterval),
  };
  // Enforce hard bounds
  result.avgSize = Math.max(DIFF_MIN.avgSize, Math.min(DIFF_MAX.avgSize, result.avgSize));
  result.avgSpeed = Math.max(DIFF_MIN.avgSpeed, Math.min(HARD_DIFF.avgSpeed, result.avgSpeed));
  return result;
}

/** Adjust difficulty based on recent pop rate and success rate. */
function adjustDifficulty(state: GameState, now: number): void {
  if (now - state.lastDifficultyAdjust < DIFFICULTY_ADJUST_MS) return;
  state.lastDifficultyAdjust = now;

  const { popRate, successRate } = state.stats;
  // Target: pop rate around 0.3-1.0/sec with high success rate.
  // Over 1.0/sec and >70% success → harder. Under 0.2/sec or <40% success → easier.
  let t = 0;
  if (popRate > 1.0 && successRate > 0.7) t = 0.6;
  else if (popRate > 0.5 && successRate > 0.6) t = 0.3;
  else if (popRate < 0.2 || successRate < 0.4) t = -0.6;
  else if (popRate < 0.4 && successRate < 0.6) t = -0.3;

  // Blend toward new difficulty slowly from current
  const target = lerpDifficulty(t);
  const cur = state.stats.difficulty;
  const blend = 0.3;
  cur.avgSize += (target.avgSize - cur.avgSize) * blend;
  cur.avgSpeed += (target.avgSpeed - cur.avgSpeed) * blend;
  cur.randomness += (target.randomness - cur.randomness) * blend;
  cur.specialChance += (target.specialChance - cur.specialChance) * blend;
  cur.spawnInterval += (target.spawnInterval - cur.spawnInterval) * blend;
}

/** Advance the game one tick. dt is seconds since last tick. */
export function tick(state: GameState, dt: number, now: number): void {
  const { difficulty } = state.stats;

  // Spawn
  if (
    now - state.lastSpawnTime >= difficulty.spawnInterval &&
    state.bubbles.length < MAX_BUBBLES
  ) {
    spawnBubble(state, now);
  }

  // Advance bubbles
  const kept: Bubble[] = [];
  for (const b of state.bubbles) {
    // Grow-in animation
    if (b.growing && b.radius < b.targetRadius) {
      b.radius = Math.min(b.targetRadius, b.radius + GROWTH_RATE_PX_PER_S * dt);
      if (b.radius >= b.targetRadius) { b.growing = false; b.grown = true; }
    } else {
      b.grown = true;
    }

    // Expire pending touch window → pop
    if (b.pendingTouchTime !== undefined && now - b.pendingTouchTime >= POP_WINDOW_MS) {
      // Pop this bubble now
      state.stats.score += b.special ? 3 : 1;
      state.stats.popped += 1;
      state.recentPops.push(now);
      continue; // drop bubble
    }

    // Random velocity nudge
    if (difficulty.randomness > 0 && now - b.lastNudgeTime >= NUDGE_INTERVAL_MS) {
      b.lastNudgeTime = now;
      const maxNudge = difficulty.avgSpeed * difficulty.randomness;
      b.vx += rand(-maxNudge, maxNudge);
      b.vy += rand(-maxNudge, maxNudge);
      // clamp velocity magnitude
      const mag = Math.hypot(b.vx, b.vy);
      const maxMag = difficulty.avgSpeed * 2.5;
      if (mag > maxMag) {
        b.vx = (b.vx / mag) * maxMag;
        b.vy = (b.vy / mag) * maxMag;
      }
    }

    // Integrate position
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Cull if fully off-screen (only after fully grown to prevent spawn-insta-cull)
    const pad = b.targetRadius + 30;
    if (
      b.grown &&
      (b.x < -pad || b.x > state.width + pad || b.y < -pad || b.y > state.height + pad)
    ) {
      state.stats.missed += 1;
      state.recentMisses.push(now);
      continue;
    }

    kept.push(b);
  }
  state.bubbles = kept;

  // Stats + difficulty
  updateStats(state, now);
  adjustDifficulty(state, now);
}

/**
 * Attempt to pop/hit a bubble at the given point.
 * Behavior:
 *  - Hits the topmost (most recently spawned) bubble containing the point.
 *  - Damaged bubble: pops immediately.
 *  - Undamaged bubble: start 200ms pending pop window (visual expansion).
 *  - No bubble under point: counts as mistouch; also checks for multi-touch
 *    damage on any bubble currently in its pending window.
 */
export function handleTouch(state: GameState, x: number, y: number, now: number): TouchResult {
  state.lastTouchTime = now;

  // Find topmost bubble containing the point (iterate from newest to oldest)
  let hitBubble: Bubble | null = null;
  for (let i = state.bubbles.length - 1; i >= 0; i--) {
    const b = state.bubbles[i];
    const dx = x - b.x;
    const dy = y - b.y;
    // use current visual radius so tiny growing bubbles are harder
    if (dx * dx + dy * dy <= b.radius * b.radius) {
      hitBubble = b;
      break;
    }
  }

  if (!hitBubble) {
    // Mistouch — but if any bubble has a pending-touch window open, this
    // counts as a multi-touch miss: damage those bubbles and bounce them.
    let damagedAny = false;
    for (const b of state.bubbles) {
      if (b.pendingTouchTime !== undefined && now - b.pendingTouchTime < POP_WINDOW_MS) {
        b.damaged = true;
        b.pendingTouchTime = undefined;
        // Bounce away from the mistouch point
        const dx = b.x - x;
        const dy = b.y - y;
        const mag = Math.hypot(dx, dy) || 1;
        const bounceSpeed = Math.max(120, Math.hypot(b.vx, b.vy) * 1.3);
        b.vx = (dx / mag) * bounceSpeed;
        b.vy = (dy / mag) * bounceSpeed;
        damagedAny = true;
      }
    }
    if (!damagedAny) {
      state.stats.mistouches += 1;
      state.recentMistouches.push(now);
    }
    return { hit: false, popped: false, damaged: damagedAny };
  }

  // Touched a bubble
  if (hitBubble.damaged) {
    // Pop immediately
    state.bubbles = state.bubbles.filter(b => b.id !== hitBubble!.id);
    state.stats.score += hitBubble.special ? 3 : 1;
    state.stats.popped += 1;
    state.recentPops.push(now);
    return { hit: true, popped: true, damaged: false, bubble: hitBubble };
  }

  // Start pop window
  hitBubble.pendingTouchTime = now;
  return { hit: true, popped: false, damaged: false, bubble: hitBubble };
}

export function resetGame(state: GameState): void {
  state.bubbles = [];
  state.stats.score = 0;
  state.stats.popped = 0;
  state.stats.missed = 0;
  state.stats.mistouches = 0;
  state.stats.successRate = 1;
  state.stats.popRate = 0;
  state.stats.difficulty = { ...INITIAL_DIFFICULTY };
  state.recentPops = [];
  state.recentMisses = [];
  state.recentMistouches = [];
  state.lastSpawnTime = 0;
  state.lastDifficultyAdjust = 0;
  state.nextId = 1;
  state.lastTouchTime = 0;
}

/** Find the bubble nearest to a gaze point, within `maxDist` px. */
export function bubbleNearPoint(state: GameState, x: number, y: number, maxDist: number): Bubble | null {
  let best: Bubble | null = null;
  let bestD2 = maxDist * maxDist;
  for (const b of state.bubbles) {
    const dx = x - b.x;
    const dy = y - b.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = b; }
  }
  return best;
}
