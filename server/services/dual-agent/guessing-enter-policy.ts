// server/services/dual-agent/guessing-enter-policy.ts
//
// Pure decision logic for handling a client `guessing_enter` message.
// Extracted from AgentCoordinator so the dwell-refire protection is
// unit-testable without the Coordinator's heavy import graph.
//
// Why this exists: eyegaze users toggle the word-finder via a dwell button,
// and a dwell that re-arms while the gaze stays put fires enter/exit/enter
// bursts seconds apart. Before this guard, EVERY enter reset the narrowing
// engine (destroying any progress) and fired a scripted Speaker turn — so the
// AI voiced the identical "What kind of thing are you thinking of?" opener
// over and over (seven times in one 07-28 session) while the user was simply
// dwelling near the toggle.

export type GuessingOrigin = "conversation" | "builder";

export type GuessingEnterDecision =
  /** Fresh entry — build the engine and voice the opener. */
  | "enter"
  /** Fresh entry, but the opener was voiced moments ago — build the engine
   *  and update the board silently rather than repeating the same line. */
  | "enter_silent"
  /** Guessing is already active with the same origin — a dwell/toggle
   *  re-fire. Keep the current engine state and do nothing. */
  | "ignore_duplicate";

/** How long after voicing the word-finder opener a re-entry stays silent.
 *  Within this window the question is still hanging in the air (and on the
 *  board) — repeating it reads as the device being stuck, not helpful. */
export const GUESSING_ENTRY_VOICE_COOLDOWN_MS = 60_000;

export function decideGuessingEnter(opts: {
  /** Origin of the currently-active guessing session, null when not in guessing. */
  activeOrigin: GuessingOrigin | null;
  /** Origin of the incoming guessing_enter message. */
  incomingOrigin: GuessingOrigin;
  /** When the entry opener was last VOICED (epoch ms), 0 = never. */
  lastEntryVoicedAt: number;
  now: number;
  cooldownMs?: number;
}): GuessingEnterDecision {
  const { activeOrigin, incomingOrigin, lastEntryVoicedAt, now } = opts;
  const cooldown = opts.cooldownMs ?? GUESSING_ENTRY_VOICE_COOLDOWN_MS;
  // Same-origin enter while already active: nothing new is being requested.
  // (An origin CHANGE — e.g. conversation-guessing → builder-slot guessing —
  // is a real transition and rebuilds the engine.)
  if (activeOrigin !== null && activeOrigin === incomingOrigin) return "ignore_duplicate";
  if (lastEntryVoicedAt > 0 && now - lastEntryVoicedAt < cooldown) return "enter_silent";
  return "enter";
}
