// client-aac/src/lib/session-activity.ts
//
// "Something is happening with this student right now."
//
// One module-level signal rather than a context, because the places that KNOW
// an interaction happened are deep in the session plumbing — the caption
// writer in useLiveSession, the press path in DualAgentContext — and the place
// that needs to hear about it (the session recorder) is mounted somewhere else
// entirely. Threading a callback between them would put a recording concern
// into every layer in between.
//
// Deliberately NOT the sleep system's engagement score. That score answers "is
// someone there", which stays true through long stretches where nothing
// happens; this answers "did something happen", which is what decides whether
// there is anything worth recording. They are different questions and one
// cannot be derived from the other.
//
// Publishing is synchronous, allocation-free in the common case, and safe from
// a render path: it walks a small subscriber set and swallows their errors.

/** What kind of interaction was seen. Carried for diagnostics only — every
 *  kind counts the same toward "active". */
export type SessionActivityKind =
  /** The student selected a board button. */
  | "press"
  /** The student's own words — signed, built from symbols, or spoken. */
  | "student-speech"
  /** The AI said something to the student. */
  | "ai-speech"
  /** Someone in the room spoke to the student. */
  | "heard-speech";

export interface SessionActivityEvent {
  kind: SessionActivityKind;
  atMs: number;
}

type Listener = (event: SessionActivityEvent) => void;

const listeners = new Set<Listener>();

/**
 * Report an interaction. Cheap enough to call from an event handler or an
 * effect on every press and every utterance.
 */
export function noteSessionActivity(kind: SessionActivityKind): void {
  if (!listeners.size) return;
  const event: SessionActivityEvent = { kind, atMs: Date.now() };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A subscriber's failure must never break the interaction that reported it.
    }
  }
}

/** Subscribe. Returns the unsubscribe function. */
export function onSessionActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — drop every subscriber. */
export function __resetSessionActivity(): void {
  listeners.clear();
}
