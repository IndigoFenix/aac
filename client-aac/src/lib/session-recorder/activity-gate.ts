// client-aac/src/lib/session-recorder/activity-gate.ts
//
// When a clip is open, and why it closes. Pure — no timers, no MediaRecorder,
// no clock of its own: the caller ticks it and supplies `nowMs`, which is what
// makes the whole lifecycle testable without encoding a single frame.
//
// The rules are small but every one of them is load-bearing:
//
//   • A clip opens on an INTERACTION, not on a session starting. An AAC device
//     is powered on all day; recording everything is what the disk budget
//     exists to prevent, and it is not what anyone would ever watch.
//   • It closes after `idleTailMs` of nothing — long enough to bridge a child
//     thinking, short enough that a device left running alone stops writing.
//   • It ROTATES at `maxClipMs`, which is a close and an open in one beat, so
//     an hour of continuous play becomes six editable files instead of one
//     unmanageable pair. Rotation also gives the eviction sweep something
//     granular to delete.
//
// Idle beats length: a clip that is both over its length cap and past its idle
// tail closes rather than rotating, so an abandoned device never opens a fresh
// empty clip on its way out.

/** Why a clip ended. Written into the manifest. */
export type ClipEndReason = "idle" | "rotated" | "stopped";

export interface GateConfig {
  /** Quiet time after the last interaction before the clip closes. */
  idleTailMs: number;
  /** Hard cap on one clip's length before it rotates into the next. */
  maxClipMs: number;
}

export interface GateState {
  /** Wall clock when the open clip started, or null when nothing is open. */
  openedAtMs: number | null;
  /** Wall clock of the most recent interaction seen. */
  lastActivityMs: number;
}

export type GateAction =
  | { kind: "none" }
  /** Start a clip. `triggeredAtMs` is the interaction; the clip's own start is
   *  earlier by however much pre-roll the encoders had in hand. */
  | { kind: "open"; triggeredAtMs: number }
  | { kind: "close"; reason: ClipEndReason; atMs: number }
  /** Close the open clip and start another in the same beat. */
  | { kind: "rotate"; atMs: number };

export interface GateStep {
  state: GateState;
  action: GateAction;
}

export function initialGateState(nowMs: number): GateState {
  // `lastActivityMs` starts in the past rather than at `now` so a gate created
  // mid-session doesn't behave as though something just happened.
  return { openedAtMs: null, lastActivityMs: nowMs - Number.MAX_SAFE_INTEGER / 2 };
}

/**
 * Advance the gate one beat.
 *
 * `activity` is "an interaction landed since the last step" — a button press,
 * the student's own voice, the AI speaking, or someone speaking to the student.
 * Call this on a steady tick as well as on activity; the closing and rotating
 * transitions are time-driven and will not fire on their own.
 */
export function stepGate(
  state: GateState,
  config: GateConfig,
  nowMs: number,
  activity: boolean,
): GateStep {
  const lastActivityMs = activity ? nowMs : state.lastActivityMs;

  if (state.openedAtMs === null) {
    if (!activity) return { state: { ...state, lastActivityMs }, action: { kind: "none" } };
    return {
      state: { openedAtMs: nowMs, lastActivityMs },
      action: { kind: "open", triggeredAtMs: nowMs },
    };
  }

  // Idle before length: an abandoned device must not open a fresh empty clip
  // on its way out.
  if (nowMs - lastActivityMs >= config.idleTailMs) {
    return {
      state: { openedAtMs: null, lastActivityMs },
      action: { kind: "close", reason: "idle", atMs: nowMs },
    };
  }

  if (nowMs - state.openedAtMs >= config.maxClipMs) {
    return {
      state: { openedAtMs: nowMs, lastActivityMs },
      action: { kind: "rotate", atMs: nowMs },
    };
  }

  return { state: { ...state, lastActivityMs }, action: { kind: "none" } };
}

/**
 * Tear the gate down — session ending, settings turned off, app quitting.
 * Yields a close only when something is actually open.
 */
export function stopGate(state: GateState, nowMs: number): GateStep {
  if (state.openedAtMs === null) {
    return { state, action: { kind: "none" } };
  }
  return {
    state: { ...state, openedAtMs: null },
    action: { kind: "close", reason: "stopped", atMs: nowMs },
  };
}
