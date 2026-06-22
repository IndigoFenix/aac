/**
 * Pure decision logic for AgentCoordinator's server-side idle watchdog.
 *
 * The Observer AI is supposed to call rest()/sleep() when the user disengages,
 * but it does so unreliably — so the coordinator forces the downward
 * transitions purely on elapsed idle time. This module isolates the "what
 * should happen" decision from the side-effectful "do it" so the thresholds and
 * guards can be unit-tested without standing up a live WebSocket session.
 *
 * Transitions (most-idle first):
 *   - "sleep": tear down ALL Live agents (zero Gemini cost), keep the WS open.
 *   - "rest":  awake → resting (Observer only, tight compression).
 *   - "none":  leave the session where it is.
 */

export interface IdleWatchdogInput {
  /** Milliseconds since the last real engagement (press / board change / AI
   *  speech). Ambient frames/audio do NOT reset this. */
  idleMs: number;
  /** Current live profile. Only "awake" is eligible to drop to resting. */
  sessionProfile: "awake" | "resting";
  /** Coordinator lifecycle is "ready" (not initializing/closing/closed). */
  ready: boolean;
  /** Client asked the session to pause. */
  paused: boolean;
  /** Already fully disconnected from Live — nothing cheaper to do. */
  asleep: boolean;
  /** A social-training session is active (or transitioning). Counts as engaged
   *  even between peer turns, so never auto-rest/sleep through one. */
  inSocialSession: boolean;
  /** Idle threshold to drop awake → resting. */
  restAfterMs: number;
  /** Idle threshold to go fully asleep. */
  sleepAfterMs: number;
}

export type IdleDecision = "sleep" | "rest" | "none";

export function decideIdleTransition(input: IdleWatchdogInput): IdleDecision {
  if (!input.ready || input.paused || input.asleep || input.inSocialSession) {
    return "none";
  }
  if (input.idleMs >= input.sleepAfterMs) {
    return "sleep";
  }
  if (input.idleMs >= input.restAfterMs && input.sessionProfile === "awake") {
    return "rest";
  }
  return "none";
}
