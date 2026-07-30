// server/services/dual-agent/live-session-registry.ts
//
// A tiny registry mapping a studentId → its currently-active live AAC session, so
// a clinician-side action can reach the running session by id (e.g. "reload this
// student's AAC"), and so a NEW session for a student can supersede the old one —
// a student has at most one billing session (see steal semantics below).
//
// Steal semantics (2026-07-30, after the 07-20 double-session runaway): when a
// second connection registers for the same student, the displaced session is
// told to supersede() — it goes inert (agents torn down, STT refused) but its
// WebSocket stays OPEN. Closing the socket instead would make already-deployed
// clients auto-reconnect and steal straight back, ping-ponging forever. A
// deliberate user input on the superseded window steals the registration back
// ("the window you actually touch wins"); ambient audio never does.
//
// Classroom sessions are exempt in both directions: a personal-device connect
// must not kill a running classroom session (and vice versa), so stealing only
// happens between two non-classroom sessions.
//
// Scope: in-memory, so it only guards sessions on the same server process.
// Cross-instance duplicates would need DB-backed coordination — acceptable for
// now because both runaway sessions came from one household hitting one host.

export interface LiveSessionHandle {
  /** Ask the AAC client to reload itself (e.g. to pick up changed settings). */
  requestReload(): void;
  /** Force this session inert — a newer session for the same student took over. */
  supersede(reason: string): void;
  /** Classroom sessions are never stolen from or by (see module comment). */
  isClassroom: boolean;
}

const sessions = new Map<string, LiveSessionHandle>();

/** Register `handle` as the student's active session. Returns the handle it
 *  displaced (null when none, or when re-registering the same handle) so the
 *  caller can decide whether to supersede it — see shouldStealFrom. */
export function registerLiveSession(studentId: string, handle: LiveSessionHandle): LiveSessionHandle | null {
  const prev = sessions.get(studentId) ?? null;
  sessions.set(studentId, handle);
  return prev === handle ? null : prev;
}

/** Whether a just-displaced session should be forced inert by the incoming
 *  one. Pure so the steal policy is unit-testable. */
export function shouldStealFrom(
  displaced: LiveSessionHandle | null,
  incoming: Pick<LiveSessionHandle, "isClassroom">,
): boolean {
  if (!displaced) return false;
  return !displaced.isClassroom && !incoming.isClassroom;
}

/** Remove the handle — but only if it's still the registered one, so an OLD
 *  session tearing down can't evict a newer session for the same student. */
export function unregisterLiveSession(studentId: string, handle: LiveSessionHandle): void {
  if (sessions.get(studentId) === handle) sessions.delete(studentId);
}

export function getLiveSession(studentId: string): LiveSessionHandle | null {
  return sessions.get(studentId) ?? null;
}
