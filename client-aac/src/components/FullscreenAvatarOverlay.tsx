// client-aac/src/components/FullscreenAvatarOverlay.tsx
// Fullscreen sleeping-avatar overlay. Sits in front of the header so the
// overlay covers the whole screen while the avatar is asleep or waking.
//
// Sprite props (avatar variant, eye/ear/mouth/focus, blink + ear-flap
// frames) come from <AvatarSpriteProvider>. That same source feeds the
// header's <AacAvatar />, so the two render identical frames in sync.
//
// The upstream "phase" mirrors the same signals the header uses to label
// its loading row — specifically isLoading drives "Waking up…". The natural
// sleep-state machine never enters 'waking' on startup (hibernation jumps
// straight to awake via triggerAlwaysWake), so we cannot rely on sleepState
// alone: the loading flag is the actual source of the wake indication.
//
//   sleep  — pre-init with no loading in flight, or sleepState === 'asleep'
//   wake   — session is loading (initializing/reconnecting), or AI explicitly
//            set sleepState === 'waking'
//   awake  — anything else
//
// hibernation is intentionally not treated as 'sleep' once the session is
// initialized; otherwise the overlay would flicker back to "Sleeping…" the
// moment isLoading clears, because the sleep-system defaults to hibernation
// until the user taps the cave.

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AacAvatar } from "@/components/AacAvatar";
import { useAvatarSprite } from "@/contexts/AvatarSpriteContext";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { SleepState } from "@/lib/cameraAttentivenessTypes";

const WAKING_HOLD_MS = 1500;

type Stage = "sleeping" | "waking" | "hidden";
type Phase = "sleep" | "wake" | "awake";

function computePhase(
  isInitialized: boolean,
  isLoading: boolean,
  sleepState: SleepState | undefined,
  errorFrozenOverlayVisible: boolean | null,
): Phase {
  // During a connection error, the upstream signals (isInitialized/isLoading)
  // cycle as retries fire. Lock the overlay to the snapshot captured by the
  // sprite provider so we don't flicker between sleeping / waking / awake.
  if (errorFrozenOverlayVisible === true) return "sleep";
  if (errorFrozenOverlayVisible === false) return "awake";
  if (isLoading) return "wake";
  if (!isInitialized) return "sleep";
  if (sleepState === "asleep") return "sleep";
  if (sleepState === "waking") return "wake";
  return "awake";
}

function initialStageFor(phase: Phase): Stage {
  if (phase === "sleep") return "sleeping";
  if (phase === "wake") return "waking";
  return "hidden";
}

export function FullscreenAvatarOverlay() {
  const { isInitialized, isLoading } = useDualAgentContext();
  const attentiveness = useCameraAttentivenessOptional();
  const sprite = useAvatarSprite();
  const { t } = useLanguage();

  const sleepState = attentiveness?.sleepState;
  const phase = computePhase(
    isInitialized,
    isLoading,
    sleepState,
    sprite.errorFrozenOverlayVisible,
  );

  const [stage, setStage] = useState<Stage>(() => initialStageFor(phase));
  const lastPhaseRef = useRef<Phase>(phase);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (phase === prev) return;

    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    if (phase === "sleep") {
      setStage("sleeping");
    } else if (phase === "wake") {
      setStage("waking");
    } else {
      // Transitioning into awake from sleep/wake — keep "Waking up…" visible
      // for WAKING_HOLD_MS before hiding. Covers both the loading-complete
      // path and any future direct sleep→awake jump.
      setStage("waking");
      hideTimerRef.current = setTimeout(() => {
        setStage("hidden");
        hideTimerRef.current = null;
      }, WAKING_HOLD_MS);
    }
  }, [phase]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    },
    [],
  );

  const visible = stage !== "hidden";
  const label = stage === "waking" ? t("status.wakingUp") : t("status.sleeping");

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="fullscreen-avatar-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/70 backdrop-blur-md pointer-events-none select-none"
        >
          <div className="relative w-[min(60vw,60vh)] aspect-square">
            <AacAvatar
              avatar={sprite.avatar}
              renderedEye={sprite.renderedEye}
              renderedEar={sprite.renderedEar}
              mouthEmote={sprite.mouthEmote}
              mouthOpen={sprite.mouthOpen}
              showMouth={sprite.showMouth}
              focusActive={sprite.focusActive}
            />
          </div>
          <p className="mt-6 text-white text-2xl font-medium tracking-wide">
            {label}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default FullscreenAvatarOverlay;
