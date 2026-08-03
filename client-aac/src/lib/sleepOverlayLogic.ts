/**
 * sleepOverlayLogic.ts
 *
 * Pure decisions behind <FullscreenAvatarOverlay> — which visual phase the
 * upstream signals add up to, and which stage a phase change lands on.
 * No React, no DOM, no timers, so both are unit-testable. (The component
 * itself can't be imported from a test: its sprite chain uses Vite's
 * `import.meta.glob`, which jest can't parse. Same split as sleepSystemLogic.)
 *
 * SLP MODE is the reason this is worth extracting. There the overlay is a
 * CURTAIN a therapist draws back by hand, and the two rules that make it one —
 * never resolve on a timer, never resolve because a face appeared — both live
 * here.
 */

import type { SleepState } from "./cameraAttentivenessTypes";

/** "ready" is SLP MODE only: awake behind the curtain, waiting to be handed
 *  over. Every other stage behaves identically in both modes. */
export type OverlayStage = "sleeping" | "waking" | "ready" | "hidden";
export type OverlayPhase = "sleep" | "wake" | "awake";

/**
 * Fold the upstream signals into a phase.
 *
 *   sleep  — pre-init with no loading in flight, or the session is asleep
 *   wake   — session is loading (initializing/reconnecting), or sleepState 'waking'
 *   awake  — anything else
 */
export function computePhase(
  isInitialized: boolean,
  isLoading: boolean,
  sleepState: SleepState | undefined,
  errorFrozenOverlayVisible: boolean | null,
  faceLost: boolean,
  slpMode: boolean,
): OverlayPhase {
  // During a connection error the upstream signals cycle as retries fire. Lock
  // to the snapshot the sprite provider captured so the overlay doesn't
  // flicker between sleeping / waking / awake.
  if (errorFrozenOverlayVisible === true) return "sleep";
  if (errorFrozenOverlayVisible === false) return "awake";
  if (isLoading) return "wake";
  if (!isInitialized) return "sleep";
  // Asleep with the student still in frame: DON'T fade the screen — keep the
  // board usable (they can tap to wake / press buttons) with just the header
  // avatar showing sleeping eyes. Only fade to the fullscreen "Sleeping…"
  // overlay once the face is LOST. Default with no camera/face detection →
  // faceLost=true → the original fade, unchanged.
  //
  // SLP MODE ignores the face entirely: asleep is asleep. That exemption
  // assumes a face in frame means a student at the device, which is precisely
  // what SLP MODE rejects — the therapist is carrying the device, the student
  // may be out of frame, and the face in frame may be the therapist's.
  // Honouring it here would also let a face appearing while asleep flip the
  // phase to "awake" and raise a "Ready" curtain over a session that never woke.
  if (sleepState === "asleep") return slpMode || faceLost ? "sleep" : "awake";
  if (sleepState === "waking") return "wake";
  return "awake";
}

export function initialStageFor(phase: OverlayPhase): OverlayStage {
  if (phase === "sleep") return "sleeping";
  if (phase === "wake") return "waking";
  return "hidden";
}

/**
 * Which stage a phase change lands on, and whether the timed auto-hide is
 * armed. `autoHide` true means "show 'Waking up…' briefly, then hide".
 *
 * NON-SLP ONLY. Outside SLP MODE the overlay owns a small timed state machine
 * (waking → hidden), which needs local state to run the timer. SLP MODE has no
 * timer at all — see slpStageFor, which is a pure projection of global state.
 */
export function stageForPhase(phase: OverlayPhase): { stage: OverlayStage; autoHide: boolean } {
  if (phase === "sleep") return { stage: "sleeping", autoHide: false };
  if (phase === "wake") return { stage: "waking", autoHide: false };
  return { stage: "waking", autoHide: true };
}

/**
 * The SLP MODE stage, as a pure function of (phase, wake-ready). No timer and
 * NO LOCAL STATE — that is the point. Both wake controls project from the same
 * global values, so they cannot drift apart; held as component state, the
 * overlay's idea of itself desynced from the header's on the first press.
 *
 *   sleep + not ready → "sleeping". Asleep, nothing asking to wake.
 *   sleep + ready     → "ready". Something WOULD have auto-woken the session
 *                       (presence, usually) and SLP MODE suppressed it. The
 *                       session is STILL ASLEEP — this only says "someone is
 *                       here, press to wake". One press then wakes it.
 *   wake              → "waking", the wake is in flight.
 *   awake             → "hidden". Awake means the board is in front of the
 *                       student; there is no second gate to get past.
 */
export function slpStageFor(phase: OverlayPhase, wakeReady: boolean): OverlayStage {
  if (phase === "sleep") return wakeReady ? "ready" : "sleeping";
  if (phase === "wake") return "waking";
  return "hidden";
}

/** Stages that are WAITING on a person, i.e. where the SLP MODE wake control
 *  belongs. Never mid-wake, so a second press can't land on work in progress. */
export function overlayAwaitsPress(stage: OverlayStage): boolean {
  return stage === "sleeping" || stage === "ready";
}
