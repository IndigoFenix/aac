// shared/gaze-kit.ts
//
// Reusable eyegaze input primitives for games and gaze-driven UI:
//   - GazeSmoother: exponential smoothing over a noisy gaze stream
//   - DwellTracker: dwell-to-activate over arbitrary target keys, with
//     jitter grace, re-arm semantics, and 0..1 progress for drawing rings
//
// Framework-free and DOM-free: callers feed points/targets in whatever
// coordinate space they use (screen px, world units, DOM element keys).
// The platform's dwell threshold arrives via the games-bridge `init`
// message (`dwellMs`) — pass it into DwellTracker.

export interface GazePoint {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

export interface GazeSmootherOptions {
  /** Time constant in ms — smaller follows faster. ~80ms suits eyegaze. */
  timeConstantMs?: number;
  /** Jump distance that bypasses smoothing (saccade snap). */
  snapDistance?: number;
}

/**
 * Exponential moving average with time-aware alpha, so smoothing behaves the
 * same at any sample rate. Large jumps snap immediately (saccades should not
 * be smeared across the screen).
 */
export class GazeSmoother {
  private current: GazePoint | null = null;
  private lastTime = 0;
  private readonly timeConstantMs: number;
  private readonly snapDistance: number;

  constructor(options: GazeSmootherOptions = {}) {
    this.timeConstantMs = options.timeConstantMs ?? 80;
    this.snapDistance = options.snapDistance ?? Number.POSITIVE_INFINITY;
  }

  update(raw: GazePoint, nowMs: number): GazePoint {
    if (!this.current) {
      this.current = { ...raw };
      this.lastTime = nowMs;
      return { ...this.current };
    }
    const jump = Math.hypot(raw.x - this.current.x, raw.y - this.current.y);
    if (jump >= this.snapDistance) {
      this.current = { ...raw };
      this.lastTime = nowMs;
      return { ...this.current };
    }
    const dt = Math.max(0, nowMs - this.lastTime);
    this.lastTime = nowMs;
    const alpha = 1 - Math.exp(-dt / this.timeConstantMs);
    this.current = {
      x: this.current.x + (raw.x - this.current.x) * alpha,
      y: this.current.y + (raw.y - this.current.y) * alpha,
    };
    return { ...this.current };
  }

  reset(): void {
    this.current = null;
  }
}

// ---------------------------------------------------------------------------
// Dwell
// ---------------------------------------------------------------------------

export interface DwellTrackerOptions {
  /** Time on target required to activate. */
  dwellMs: number;
  /** Brief off-target jitter tolerated without resetting progress. */
  graceMs?: number;
  /**
   * After firing, the target stays disarmed until the gaze has been off it
   * for this long. Default 0: leaving the target re-arms it immediately,
   * i.e. one activation per continuous hover.
   */
  rearmMs?: number;
}

export interface DwellSample {
  /** The target under the gaze, or null. */
  targetKey: string | null;
  /** 0..1 progress on the current target (drives the dwell ring). */
  progress: number;
  /** Set to the target key on the activation frame. */
  fired: string | null;
}

export class DwellTracker {
  private options: Required<DwellTrackerOptions>;
  private targetKey: string | null = null;
  private dwellStart = 0;
  private lastOnTarget = 0;
  private firedKey: string | null = null;
  private firedLeftAt: number | null = null;

  constructor(options: DwellTrackerOptions) {
    this.options = {
      dwellMs: options.dwellMs,
      graceMs: options.graceMs ?? 150,
      rearmMs: options.rearmMs ?? 0,
    };
  }

  setDwellMs(dwellMs: number): void {
    this.options.dwellMs = dwellMs;
  }

  /** Feed the current target (or null) every frame. */
  update(targetKey: string | null, nowMs: number): DwellSample {
    // Disarm bookkeeping: a just-fired target cannot refire until the gaze
    // has been off it for rearmMs.
    if (this.firedKey !== null) {
      if (targetKey === this.firedKey) {
        const offFor =
          this.firedLeftAt === null ? 0 : nowMs - this.firedLeftAt;
        if (this.firedLeftAt !== null && offFor >= this.options.rearmMs) {
          this.firedKey = null;
          this.firedLeftAt = null;
        } else {
          // Continuously on (or back too soon on) the fired target.
          this.firedLeftAt = null;
          return { targetKey, progress: 0, fired: null };
        }
      } else {
        if (this.firedLeftAt === null) this.firedLeftAt = nowMs;
        if (nowMs - this.firedLeftAt >= this.options.rearmMs) {
          this.firedKey = null;
          this.firedLeftAt = null;
        }
      }
    }

    if (targetKey === null) {
      if (
        this.targetKey !== null &&
        nowMs - this.lastOnTarget > this.options.graceMs
      ) {
        this.targetKey = null;
      }
      return { targetKey: null, progress: this.progressAt(nowMs), fired: null };
    }

    if (targetKey !== this.targetKey) {
      this.targetKey = targetKey;
      this.dwellStart = nowMs;
    }
    this.lastOnTarget = nowMs;

    const progress = this.progressAt(nowMs);
    if (progress >= 1) {
      this.firedKey = targetKey;
      this.firedLeftAt = null;
      this.targetKey = null;
      return { targetKey, progress: 1, fired: targetKey };
    }
    return { targetKey, progress, fired: null };
  }

  reset(): void {
    this.targetKey = null;
    this.firedKey = null;
    this.firedLeftAt = null;
  }

  private progressAt(nowMs: number): number {
    if (this.targetKey === null || this.options.dwellMs <= 0) return 0;
    return Math.min(1, (nowMs - this.dwellStart) / this.options.dwellMs);
  }
}
