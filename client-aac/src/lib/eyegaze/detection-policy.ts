// client-aac/src/lib/eyegaze/detection-policy.ts
//
// When should the client (re)try activating a hardware eye tracker?
//
// This module exists because the previous answer was "twice, then never". The
// old useEyeGaze tried switchProvider(preferred), retried once after 2s, and on
// the second failure set failedProvider and stopped — its effect deps never
// changed again, so nothing ever re-probed. A field log (Tobii Dynavox IS5)
// showed the cost: the gaze sidecar connects to the tracker successfully every
// single time, but binding its port takes ~1.5s from a cold spawn (~0.3s warm),
// and the tracker itself once needed 14s of `no_device` retries after a boot.
// Both attempts landed inside that window, the student was stranded on the mouse
// fallback, and the ONLY cure was a full remount — logging out and back in.
// Closing the app with X made it reproducible: window-all-closed stops the
// sidecar and quits, so every reopen is a guaranteed cold spawn.
//
// The rules here are therefore built around one invariant: THERE IS NO
// PERMANENT FAILURE STATE. Attempts back off, they are gated so we don't probe
// a port that provably isn't there, but they never stop.
//
// Pure by design — no React, no timers, no DOM, no clock. The caller supplies
// `now` and holds the attempt counters, so all of this is unit-testable in a
// plain node environment (see detection-policy.test.ts).

import type { EyeGazeProviderType } from "./types";

/**
 * Providers that stand in when no real tracker answered. Sitting on one of
 * these means detection has NOT succeeded, whatever the settings asked for —
 * which is exactly the state the old code could not get out of.
 */
export const FALLBACK_PROVIDERS: readonly EyeGazeProviderType[] = ["mouse"];

export function isFallbackProvider(provider: EyeGazeProviderType | null): boolean {
  return provider === null || FALLBACK_PROVIDERS.includes(provider);
}

/**
 * Has detection reached what the student's settings asked for?
 *
 * On "auto" any real tracker counts; the mouse does not, because "auto" landing
 * on the mouse is precisely the silent failure we are trying to escape.
 */
export function detectionSatisfied(
  preferred: EyeGazeProviderType | "auto",
  active: EyeGazeProviderType | null,
): boolean {
  if (preferred === "auto") return !isFallbackProvider(active);
  return active === preferred;
}

/**
 * Backoff between probe attempts, by consecutive-failure count.
 *
 * Front-loaded (a warm sidecar is up in ~0.3s) then widening, because the slow
 * cases are slow by seconds, not milliseconds. Capped rather than terminated:
 * a tracker plugged in an hour into a session must still be picked up.
 */
const RETRY_SCHEDULE_MS = [0, 2000, 2000, 4000, 8000] as const;
export const RETRY_MAX_MS = 15000;

export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return RETRY_SCHEDULE_MS[attempts] ?? RETRY_MAX_MS;
}

/** Live sidecar status, narrowed to the two fields that gate probing. */
export interface HardwareSignal {
  /** Supervisor's last sidecar status code — "connected" when gaze is flowing. */
  sidecarCode: string | null;
  /** OS-assigned port the sidecar bound, null while stopped or mid-spawn. */
  port: number | null;
}

/**
 * A change in this key means the world changed underneath us — a new sidecar on
 * a new port, or a tracker that just reached "connected". The caller uses it to
 * reset the backoff so a freshly-ready tracker is picked up at once instead of
 * waiting out a 15s gap.
 */
export function hardwareSignalKey(signal: HardwareSignal | null): string {
  if (!signal) return "none";
  return `${signal.sidecarCode ?? "?"}:${signal.port ?? 0}`;
}

/**
 * Is the local bridge reporting a tracker we could actually reach?
 *
 *   true  — probe now, there is something listening
 *   false — do not probe, there provably isn't
 *   null  — no such signal governs this provider; probing is the only way to know
 *
 * Only the sidecar-backed provider (Tobii) has this signal. Fixed-port vendors
 * (EyeTech, LC, Gazepoint) and "auto" return null so they are never blocked by
 * a sidecar that has nothing to do with them.
 */
export function hardwareReadiness(args: {
  preferred: EyeGazeProviderType | "auto";
  /** False on hosts that cannot spawn a sidecar at all (web, iPad). */
  sidecarSupported: boolean;
  signal: HardwareSignal | null;
}): boolean | null {
  if (args.preferred !== "tobii") return null;
  // This host can never run the sidecar — polling a port it will never open is
  // pure waste, and the mouse fallback is the supported path there anyway.
  if (!args.sidecarSupported) return false;
  // No status yet: the supervisor hasn't reported. Probing now is a guaranteed
  // miss (that is the race that stranded the field user), so wait for the
  // signal — its arrival changes hardwareSignalKey and wakes us immediately.
  if (!args.signal) return false;
  return args.signal.sidecarCode === "connected" && args.signal.port !== null;
}

export interface DetectionInputs {
  enabled: boolean;
  preferred: EyeGazeProviderType | "auto";
  activeProvider: EyeGazeProviderType | null;
  hardwareReady: boolean | null;
  /** Consecutive failed attempts since the last signal change. */
  attempts: number;
  /** Timestamp of the last attempt; 0 when none has been made yet. */
  lastAttemptAt: number;
  now: number;
}

/**
 * The whole decision, in one place. Note what is absent: any notion of having
 * tried too many times.
 */
export function shouldAttemptSwitch(input: DetectionInputs): boolean {
  if (!input.enabled) return false;
  if (detectionSatisfied(input.preferred, input.activeProvider)) return false;
  if (input.hardwareReady === false) return false;
  return input.now - input.lastAttemptAt >= retryDelayMs(input.attempts);
}
