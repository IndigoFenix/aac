// server/services/dual-agent/live-session-registry.ts
//
// A tiny registry mapping a studentId → its currently-active live AAC session, so
// a clinician-side action can reach the running session by id (e.g. "reload this
// student's AAC"). A student has at most one live session; latest wins.

export interface LiveSessionHandle {
  /** Ask the AAC client to reload itself (e.g. to pick up changed settings). */
  requestReload(): void;
}

const sessions = new Map<string, LiveSessionHandle>();

export function registerLiveSession(studentId: string, handle: LiveSessionHandle): void {
  sessions.set(studentId, handle);
}

/** Remove the handle — but only if it's still the registered one, so an OLD
 *  session tearing down can't evict a newer session for the same student. */
export function unregisterLiveSession(studentId: string, handle: LiveSessionHandle): void {
  if (sessions.get(studentId) === handle) sessions.delete(studentId);
}

export function getLiveSession(studentId: string): LiveSessionHandle | null {
  return sessions.get(studentId) ?? null;
}
