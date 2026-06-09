// server/services/dual-agent/press-repeat-guard.ts
//
// Pure decision logic for the repeated-button-press guard used by LiveRelay.
// Some students perseverate on a button — tapping the same one many times in a
// row. Each tap would otherwise fire a fresh model turn flagged as an interrupt,
// cutting off the in-progress response and thrashing live scheduling. The relay
// coalesces identical presses (re-voicing the student's utterance for feedback
// but leaving the model untouched) and persists a single consolidated note so
// the Monitor still sees the behavior.
//
// This module holds only the pure pieces so they can be unit-tested without
// constructing a full LiveRelay (which pulls in providers, sockets, and TTS).

export interface RepeatPressParams {
  /** Signature of the incoming press (button labels joined). */
  signature: string;
  /** Signature of the currently-open burst, or null when none is open. */
  lastSignature: string | null;
  /** True when the model is mid-response (relay state !== "idle"). */
  modelResponding: boolean;
  /** Epoch ms of the incoming press. */
  now: number;
  /** Epoch ms of the previous press in the burst. */
  lastPressAt: number;
  /** Coalescing window in ms. */
  windowMs: number;
}

/**
 * A press is a "repeat" (to be coalesced, not dispatched) when it targets the
 * identical button(s) as the open burst AND either the model is still
 * responding or the press arrived within `windowMs` of the previous one. A
 * genuinely different button, or an identical press after the window has
 * elapsed while idle, is a fresh request and should dispatch normally.
 */
export function isRepeatPress(p: RepeatPressParams): boolean {
  return (
    p.lastSignature !== null &&
    p.signature === p.lastSignature &&
    (p.modelResponding || p.now - p.lastPressAt < p.windowMs)
  );
}

/** Format the consolidated perseveration note persisted once a burst settles. */
export function formatRepeatNote(label: string, total: number): string {
  return `[BUTTON PRESS REPEATED] ${label} (pressed ${total} times in a row)`;
}
