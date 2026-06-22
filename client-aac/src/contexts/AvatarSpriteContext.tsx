// client-aac/src/contexts/AvatarSpriteContext.tsx
// Single source of truth for the AAC avatar's presentation state.
//
// Two surfaces render the avatar: the header (DualAgentConversationBox) and
// the fullscreen sleeping overlay (FullscreenAvatarOverlay). Without a shared
// source each would run its own blink/ear-flap timers and the two avatars
// would visually desync. This provider:
//
//   1. Computes the logical sprite state (eye/ear/mouth/focus) from the
//      DualAgent + camera-attentiveness contexts.
//   2. Runs the blink + ear-flap animations exactly once.
//   3. Exposes both via useAvatarSprite().
//
// Connection-error freeze:
//   When DualAgent reports an `error`, the underlying session signals
//   (isInitialized, isLoading, etc.) can flip rapidly as retries happen in
//   the background, which made the overlay and cave/avatar swap cycle
//   between sleeping / error / awake. The provider snapshots the relevant
//   visual flags at the moment the error appears and exposes the frozen
//   values until `error` clears. The "error face" (eyes-hurt) is preserved
//   throughout; only the sleeping-vs-awake framing is locked.
//
// Consumers spread the result into <AacAvatar /> rather than recomputing.
//
// Must be mounted inside <DualAgentProvider> (and CameraAttentivenessProvider
// when available).

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import {
  useAvatarFrames,
  type EyeState,
  type EarState,
  type MouthEmote,
} from "@/components/AacAvatar";

// Avatar variant — assets live in client-aac/public/aac-avatars/<variant>/.
const AVATAR_VARIANT = "axolotl";
const MOUTH_OPEN_THRESHOLD = 0.08;

export interface AvatarSpriteState {
  avatar: string;
  // Logical state (drives downstream derivations like cave eye variant).
  eyeState: EyeState;
  earState: EarState;
  // Resolved frames to actually render — already includes blink + ear-flap.
  renderedEye: EyeState;
  renderedEar: EarState;
  mouthEmote: MouthEmote;
  mouthOpen: boolean;
  showMouth: boolean;
  focusActive: boolean;
  // Convenience flags shared by both consumers.
  isAsleep: boolean;
  isSleepingState: boolean;
  isRestingState: boolean;
  isStandbyMode: boolean;
  isAssistMode: boolean;
  // Error-freeze: when non-null, an error is active and the overlay should
  // hold this visibility (true = "Sleeping…", false = hidden) instead of
  // recomputing from the live session signals.
  errorFrozenOverlayVisible: boolean | null;
}

const AvatarSpriteContext = createContext<AvatarSpriteState | null>(null);

export function AvatarSpriteProvider({ children }: { children: ReactNode }) {
  const {
    muteState,
    isInitialized,
    isLoading,
    error,
    reconnecting,
    emote,
    isPlaying,
    speakingVolume,
    focusActive,
    lastModeChange,
  } = useDualAgentContext();
  // Freeze trigger: any signal that the session is in trouble. Both `error`
  // and `reconnecting` are intermittent within a disconnect cycle — the
  // useLiveSession retry path explicitly setError(null) before reopening
  // the WebSocket — so we cannot release the lock the instant they clear.
  // We treat this as "entered an unhealthy episode" and only release once
  // we observe a truly healthy state (initialized AND not loading AND no
  // error AND not reconnecting), which can only be reached via a successful
  // `initialized` server message.
  const sessionUnhealthy = !!error || reconnecting;
  const fullyHealthy = isInitialized && !isLoading && !error && !reconnecting;
  const attentiveness = useCameraAttentivenessOptional();

  const noSession = !isInitialized;
  const isAsleepRaw = muteState === "muted" || noSession;
  const isStandbyMode =
    lastModeChange?.mode === "standby" && lastModeChange.source === "ai";
  const isAssistMode =
    lastModeChange?.mode === "facilitator" && lastModeChange.source === "ai";
  const isMouthOpen = isPlaying && speakingVolume > MOUTH_OPEN_THRESHOLD;

  const sleepState = attentiveness?.sleepState;
  const isSleepingStateRaw =
    noSession || sleepState === "hibernation" || sleepState === "asleep";
  // "rest" eyes mean "the AI isn't taking in live frames right now". Two cases
  // drive this: (1) the RESTING sleep-state, and (2) text-first perception
  // fidelity while awake (cost-saving, full-attention OFF) — the AI is awake
  // but running on cheap signals, not streaming frames. NOT tied to the AI's
  // standby behavioral mode (that stays visually distinct via the ear state
  // below; its eyes read as awake/open).
  const isRestingStateRaw =
    !noSession &&
    (sleepState === "resting" ||
      sleepState === "waking" ||
      attentiveness?.fidelity === "text");

  // Was the fullscreen overlay visible (sleep- or wake-phase) at the live
  // moment? Used as the snapshot value if an error appears next.
  const overlayVisibleRaw =
    isLoading ||
    !isInitialized ||
    sleepState === "asleep" ||
    sleepState === "waking";

  // Snapshots refreshed on every non-error tick.
  const lastOverlayVisibleRef = useRef(overlayVisibleRaw);
  const lastIsSleepingRef = useRef(isSleepingStateRaw);

  type ErrorLock = { overlayVisible: boolean; isSleeping: boolean };
  const [errorLock, setErrorLock] = useState<ErrorLock | null>(null);

  useEffect(() => {
    if (sessionUnhealthy && errorLock === null) {
      // Entered an unhealthy episode — snapshot the most recent fully-healthy
      // visual state and freeze.
      setErrorLock({
        overlayVisible: lastOverlayVisibleRef.current,
        isSleeping: lastIsSleepingRef.current,
      });
    } else if (fullyHealthy) {
      // Truly healthy — refresh the snapshot and release any active lock.
      lastOverlayVisibleRef.current = overlayVisibleRaw;
      lastIsSleepingRef.current = isSleepingStateRaw;
      if (errorLock !== null) {
        setErrorLock(null);
      }
    }
    // Otherwise: in transition (e.g. isLoading=true mid-retry with error
    // cleared) — leave the lock as-is so we don't flicker back to "Waking
    // up…" between failing retry attempts.
  }, [sessionUnhealthy, fullyHealthy, overlayVisibleRaw, isSleepingStateRaw, errorLock]);

  // Effective sprite flags — frozen during error, live otherwise.
  const isSleepingState = errorLock ? errorLock.isSleeping : isSleepingStateRaw;
  const isRestingState = errorLock ? false : isRestingStateRaw;
  // During error, force the header to show the avatar (not the cave) so the
  // "error face" eyes-hurt sprite is actually visible. Mute can still be
  // toggled by the user; it resumes affecting isAsleep once error clears.
  const isAsleep = errorLock ? false : isAsleepRaw;

  const eyeState: EyeState = errorLock || sessionUnhealthy
    ? "hurt"
    : isSleepingState
    ? "closed"
    : isRestingState
    ? "rest"
    : "open";
  const earState: EarState = isSleepingState
    ? "open"
    : isStandbyMode
    ? "closed"
    : isAssistMode
    ? "neutral"
    : "open";

  const earFlapSpeed: number = isSleepingState ? 5000 : isStandbyMode ? 0 : isAssistMode ? 0 : 2000;

  const { renderedEye, renderedEar } = useAvatarFrames(eyeState, earState, earFlapSpeed);

  const value: AvatarSpriteState = {
    avatar: AVATAR_VARIANT,
    eyeState,
    earState,
    renderedEye,
    renderedEar,
    mouthEmote: emote,
    mouthOpen: isMouthOpen,
    showMouth: true,
    focusActive: !!focusActive,
    isAsleep,
    isSleepingState,
    isRestingState,
    isStandbyMode,
    isAssistMode,
    errorFrozenOverlayVisible: errorLock ? errorLock.overlayVisible : null,
  };

  return (
    <AvatarSpriteContext.Provider value={value}>
      {children}
    </AvatarSpriteContext.Provider>
  );
}

export function useAvatarSprite(): AvatarSpriteState {
  const ctx = useContext(AvatarSpriteContext);
  if (!ctx) {
    throw new Error(
      "useAvatarSprite must be used inside <AvatarSpriteProvider>",
    );
  }
  return ctx;
}
