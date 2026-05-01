/**
 * rateLimiter.ts
 *
 * In-memory rate limiters for the CRM landing-page chat. These are circuit
 * breakers / polite throttles, NOT security controls — an attacker rotating
 * IPs can bypass them, and the limiters reset on process restart. Real
 * defences are the `is_blocked` flag, the per-customer daily $ cap, and the
 * per-customer notes/session caps in the service layer.
 *
 * Why these matter anyway:
 *  - Stop a single misbehaving widget from looping LLM calls in a tab the
 *    user forgot about.
 *  - Bound the cost of a basic flood from one IP without paging anyone.
 *  - Provide a global ceiling so an unexpected spike on the landing page
 *    doesn't drain the OpenAI budget before someone notices.
 */

export interface RateLimitDecision {
  ok: boolean;
  /** Milliseconds until the limiter resets (only set when ok === false). */
  retryAfterMs?: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Per-key fixed-window limiter. Sweeps stale entries every check so the map
 * can't grow without bound — even an attacker spraying random IPs only sees
 * `limit + 1` distinct keys per window between sweeps.
 */
export class FixedWindowLimiter {
  private hits = new Map<string, Entry>();
  /** Track of when we last swept — sweep at most once per windowMs. */
  private lastSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (limit < 1 || windowMs < 1) {
      throw new Error("FixedWindowLimiter: limit and windowMs must both be ≥ 1");
    }
  }

  /**
   * Charge one event against `key`. Returns ok:true if accepted, ok:false
   * with retryAfterMs if the limit is exceeded.
   */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    this.maybeSweep(now);

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    if (entry.count >= this.limit) {
      return { ok: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
    }
    entry.count += 1;
    return { ok: true };
  }

  /** Test-only: how many keys are currently tracked. */
  size(): number {
    return this.hits.size;
  }

  /** Test-only: drop everything (used between tests). */
  reset(): void {
    this.hits.clear();
    this.lastSweepAt = 0;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    this.lastSweepAt = now;
  }
}

/**
 * Single global counter — events across all keys, in a sliding fixed window.
 * Used as a last-resort flood cap so a coordinated attack from many IPs
 * still trips a circuit breaker before the OpenAI bill ramps.
 */
export class GlobalLimiter {
  private count = 0;
  private resetAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (limit < 1 || windowMs < 1) {
      throw new Error("GlobalLimiter: limit and windowMs must both be ≥ 1");
    }
  }

  check(now: number = Date.now()): RateLimitDecision {
    if (now >= this.resetAt) {
      this.count = 1;
      this.resetAt = now + this.windowMs;
      return { ok: true };
    }
    if (this.count >= this.limit) {
      return { ok: false, retryAfterMs: Math.max(1, this.resetAt - now) };
    }
    this.count += 1;
    return { ok: true };
  }

  reset(): void {
    this.count = 0;
    this.resetAt = 0;
  }
}

// ──────────────────────────────────────────────────────────────────
// Configured limiters
// ──────────────────────────────────────────────────────────────────
//
// Why the asymmetry between message and identify caps:
//  - /identify is a one-shot per session — repeat calls from the same IP are
//    idempotent (they hit the same customer row). The limit just stops a
//    runaway widget loop, not abuse.
//  - /message actually spends LLM tokens, so its cap is tighter and tied to
//    the inflight cost cap one layer deeper (CRM_DAILY_USD_CAP).
//  - /config is essentially free (one DB read of a setting) but also the
//    widget polls it on every page load — keep it cheap and reasonably
//    permissive.
//
// The global cap is a per-process limit. With multiple instances behind a
// load balancer it scales linearly with the number of warm workers, which
// is acceptable for a defence-in-depth control.

export const messageLimiter = new FixedWindowLimiter(10, 60_000);
export const identifyLimiter = new FixedWindowLimiter(30, 60_000);
export const configLimiter = new FixedWindowLimiter(60, 60_000);

/**
 * Hard ceiling on outbound CRM LLM calls per minute (per server instance).
 * 120 / min / instance is ~$0.12/min worst-case at gpt-4o-mini's small-reply
 * cost — well below the daily budget cap before manual intervention.
 */
export const globalMessageLimiter = new GlobalLimiter(120, 60_000);

// Test-only export: reset every limiter at once.
export function __resetAllForTests(): void {
  messageLimiter.reset();
  identifyLimiter.reset();
  configLimiter.reset();
  globalMessageLimiter.reset();
}
