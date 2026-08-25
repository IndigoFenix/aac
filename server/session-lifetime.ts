// Session lifetimes, split by CLIENT.
//
// The clinician client is a browser someone signs in and out of, so its
// session is deliberately short-lived (1 day, or 30 with "remember me").
//
// The AAC client is not a browser — it is an appliance on a student's desk,
// often driven by eye gaze, by a child who cannot type a password. Once a
// device is logged in it must STAY logged in until someone deliberately signs
// it out. That did not hold before: the AAC login left `cookie.maxAge` at the
// store default (1 week) and express-session only re-sends `Set-Cookie` when
// the session is MODIFIED (`rolling` is off, and passport does not touch the
// session on ordinary requests). So the server-side row kept sliding forward
// via `store.touch()` while the cookie held in the client expired exactly one
// week after login — a re-login every 7 days that looked, to anyone updating
// more often than that, like "every update logs the student out".
//
// The fix is two-sided, and BOTH sides are needed:
//   1. `markAacSession()` at login gives the cookie a year-long maxAge.
//   2. `refreshAacSession` re-stamps it at most once a day. Writing to a
//      session FIELD is what makes express-session consider the session
//      modified and re-send the cookie — bumping `cookie.maxAge` alone is
//      invisible to `isModified()`, which hashes the session WITHOUT its
//      cookie. So the expiry slides forward for as long as the app is used.
//
// `rolling: true` on the session middleware would also have worked, but it is
// global: it would silently turn the clinician client's absolute 1-day/30-day
// expiry into a sliding one. Keeping the refresh opt-in per session leaves
// clinician (and support) lifetimes exactly as they were.

import type { RequestHandler } from "express";

/** How long an AAC device stays signed in without being used at all. */
export const AAC_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Minimum gap between cookie re-stamps. Each refresh is a session write (one
 * UPDATE on `sessions` + a `Set-Cookie`), so it is throttled: a device that
 * talks to the server constantly still costs one write a day, and the expiry
 * it slides forward is a year out regardless.
 */
export const AAC_SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

declare module "express-session" {
  interface SessionData {
    /** Set at login by the AAC client; drives the long, sliding lifetime. */
    aacClient?: true;
    /** Epoch ms of the last cookie re-stamp. */
    aacRefreshedAt?: number;
  }
}

/**
 * The parts of a session this module touches. Structural rather than
 * `express-session`'s `Session` so the logic is testable without faking the
 * whole session object.
 */
export interface AacSessionLike {
  aacClient?: true;
  aacRefreshedAt?: number;
  cookie: { maxAge?: number | null };
}

/**
 * Mark a freshly established session as belonging to an AAC device and give it
 * the long lifetime. Call INSIDE the `req.login()` callback — passport
 * regenerates the session on login, so anything set before it is discarded.
 */
export function markAacSession(session: AacSessionLike, now: number = Date.now()): void {
  session.aacClient = true;
  session.aacRefreshedAt = now;
  session.cookie.maxAge = AAC_SESSION_TTL_MS;
}

/**
 * Slide an AAC session's expiry forward, at most once per
 * `AAC_SESSION_REFRESH_INTERVAL_MS`.
 *
 * @returns true if the session was modified (and so will be saved and its
 *          cookie re-sent).
 */
export function refreshAacSessionLifetime(
  session: AacSessionLike | undefined | null,
  now: number = Date.now(),
): boolean {
  if (!session?.aacClient) return false;
  const last = session.aacRefreshedAt ?? 0;
  if (now - last < AAC_SESSION_REFRESH_INTERVAL_MS) return false;
  session.aacRefreshedAt = now;
  session.cookie.maxAge = AAC_SESSION_TTL_MS;
  return true;
}

/** Express wiring for {@link refreshAacSessionLifetime}. */
export const refreshAacSession: RequestHandler = (req, _res, next) => {
  refreshAacSessionLifetime(req.session as AacSessionLike | undefined);
  next();
};
