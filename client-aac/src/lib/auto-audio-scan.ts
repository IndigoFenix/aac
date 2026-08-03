// When the board should start reading itself out loud on its own.
//
// The manual audio scan (the ear button) exists because a student who cannot
// find a word can be rescued by hearing the options. The automated version
// offers that rescue WITHOUT the student having to find the ear button first —
// which is the exact thing they are, by hypothesis, currently failing at.
//
// The whole difficulty is deciding when someone is stuck. This module is that
// decision and nothing else: no React, no DOM, no timers. The provider feeds it
// hover events and asks; it answers.
//
// WHAT COUNTS AS STUCK
//
// Not idleness. A gaze parked on one button is a student reading it, or resting
// (the rest lattice exists precisely so a gaze has somewhere safe to sit), or
// away from the screen entirely. Reading a board aloud at someone who is
// resting is an interruption, not help.
//
// HUNTING is the signal: the gaze crossing several DIFFERENT buttons, over and
// over, while nothing gets selected. That is what "I can't find it" looks like
// from the outside. So we require three things at once:
//
//   1. The hunt has been running for at least the configured delay — the
//      student has genuinely been at this a while, not for two seconds.
//   2. Inside the TRAILING delay-length window, the gaze touched at least
//      MIN_DISTINCT_TARGETS different buttons. Measuring breadth over the
//      trailing window rather than the whole hunt is what separates hunting
//      from having stopped: a student who swept the board and then settled on
//      one button (reading it, about to select it) has an empty trailing
//      window, and so does a student who walked away. Both are left alone.
//   3. Nothing has been selected in that time — any press ends the hunt.
//
// AND A COOLDOWN, because being offered help you didn't want, on a loop, is
// worse than not being offered it. A scan that ran to the end buys quiet for
// COOLDOWN_AFTER_SCAN_MS. A scan the student STOPPED buys much longer: reaching
// for the ear button to shut it up is an answer, and re-asking a few seconds
// later would turn a helpful feature into a thing that talks over them.

/** One "the gaze arrived at a different button" event. */
export interface HoverSample {
  /** Stable identity of the button — in practice the sentence it would speak. */
  id: string;
  /** Timestamp in ms, from whatever clock the caller uses consistently. */
  at: number;
}

/**
 * Different buttons the gaze must touch inside the trailing window before we
 * call it hunting. Two is deliberating between two candidates — a readout of
 * the whole board doesn't help with that. Three is looking for something.
 */
export const MIN_DISTINCT_TARGETS = 3;

/** Quiet period after a scan that read the board to the end. */
export const COOLDOWN_AFTER_SCAN_MS = 30_000;

/** Quiet period after the student STOPPED a scan. Stopping it is a "no". */
export const COOLDOWN_AFTER_REJECT_MS = 120_000;

/** Cap on retained hover events. Only ever pruned for memory — the decision
 *  filters by time, so the cap is generous enough never to bind in practice. */
const MAX_HOVERS = 256;

export interface HuntState {
  /** Hovers since the hunt began, oldest first. Consecutive repeats of the same
   *  button are collapsed: a gaze that never left it produced no new event. */
  hovers: HoverSample[];
  /** When the current hunt began — the first hover after a reset. Null = idle. */
  huntStartedAt: number | null;
  /** When the last scan ended. Null = none has run yet. */
  scanEndedAt: number | null;
  /** Whether that scan was stopped by the student rather than finishing. */
  scanRejected: boolean;
}

export function initialHuntState(): HuntState {
  return { hovers: [], huntStartedAt: null, scanEndedAt: null, scanRejected: false };
}

/**
 * The gaze moved onto `id`. Pass null when it is on no button at all — that
 * neither extends nor ends a hunt, it simply contributes nothing, and the
 * trailing-window test below is what eventually notices the silence.
 */
export function noteHover(state: HuntState, id: string | null, now: number): HuntState {
  if (!id) return state;
  const last = state.hovers[state.hovers.length - 1];
  if (last && last.id === id) return state; // still on the same button
  const hovers = state.hovers.concat({ id, at: now });
  return {
    ...state,
    hovers: hovers.length > MAX_HOVERS ? hovers.slice(-MAX_HOVERS) : hovers,
    huntStartedAt: state.huntStartedAt ?? now,
  };
}

/**
 * The hunt is over without a scan: something was selected, the board was
 * rebuilt underneath it, or a scan was started by hand. The cooldown carries.
 */
export function resetHunt(state: HuntState): HuntState {
  return { ...state, hovers: [], huntStartedAt: null };
}

/**
 * A scan ended. `rejected` means the student stopped it (the ear button) rather
 * than it reading the board to the end — that earns the longer quiet period.
 */
export function noteScanEnded(state: HuntState, now: number, rejected: boolean): HuntState {
  return { hovers: [], huntStartedAt: null, scanEndedAt: now, scanRejected: rejected };
}

export interface HuntContext {
  now: number;
  /** Hunt time before the scan fires — `clientConfig.autoAudioScanDelayMs`. */
  delayMs: number;
  /** A scan (manual or automatic) is already running. */
  scanning: boolean;
  /** There is a board on screen with something to read. */
  boardPresent: boolean;
  /** The AI is mid-turn — composing, voicing, or rebuilding the board. */
  aiBusy: boolean;
}

/** Why the scan did or didn't fire. Every "no" is nameable, so a session log
 *  can say which guard held rather than just that nothing happened. */
export type HuntVerdict =
  | "fire"
  | "scanning"
  | "no-board"
  | "ai-busy"
  | "cooling-down"
  | "not-started"
  | "too-soon"
  | "not-hunting";

export function autoScanVerdict(state: HuntState, ctx: HuntContext): HuntVerdict {
  if (ctx.scanning) return "scanning";
  if (!ctx.boardPresent) return "no-board";
  if (ctx.aiBusy) return "ai-busy";

  if (state.scanEndedAt !== null) {
    const quiet = state.scanRejected ? COOLDOWN_AFTER_REJECT_MS : COOLDOWN_AFTER_SCAN_MS;
    if (ctx.now - state.scanEndedAt < quiet) return "cooling-down";
  }

  if (state.huntStartedAt === null) return "not-started";
  if (ctx.now - state.huntStartedAt < ctx.delayMs) return "too-soon";

  // Breadth over the TRAILING window, not the whole hunt — see the header.
  const since = ctx.now - ctx.delayMs;
  const distinct = new Set(state.hovers.filter((h) => h.at >= since).map((h) => h.id)).size;
  return distinct >= MIN_DISTINCT_TARGETS ? "fire" : "not-hunting";
}

export function shouldAutoScan(state: HuntState, ctx: HuntContext): boolean {
  return autoScanVerdict(state, ctx) === "fire";
}
