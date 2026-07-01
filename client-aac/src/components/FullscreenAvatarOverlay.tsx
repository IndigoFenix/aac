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
import { LogOut } from "lucide-react";
import { AacAvatar } from "@/components/AacAvatar";
import { useAvatarSprite } from "@/contexts/AvatarSpriteContext";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { SleepState } from "@/lib/cameraAttentivenessTypes";

const WAKING_HOLD_MS = 1500;
const LOGOUT_HOLD_MS = 2000;

type Stage = "sleeping" | "waking" | "hidden";
type Phase = "sleep" | "wake" | "awake";

function computePhase(
  isInitialized: boolean,
  isLoading: boolean,
  sleepState: SleepState | undefined,
  errorFrozenOverlayVisible: boolean | null,
  faceLost: boolean,
): Phase {
  // During a connection error, the upstream signals (isInitialized/isLoading)
  // cycle as retries fire. Lock the overlay to the snapshot captured by the
  // sprite provider so we don't flicker between sleeping / waking / awake.
  if (errorFrozenOverlayVisible === true) return "sleep";
  if (errorFrozenOverlayVisible === false) return "awake";
  if (isLoading) return "wake";
  if (!isInitialized) return "sleep";
  // Asleep with the student still in frame: DON'T fade the screen — keep the
  // board usable (they can tap to wake / press buttons) with just the header
  // avatar showing sleeping eyes. Only fade to the fullscreen "Sleeping…"
  // overlay once the face is LOST (nobody there to use the board). Default with
  // no camera/face detection → faceLost=true → the original fade, unchanged.
  if (sleepState === "asleep") return faceLost ? "sleep" : "awake";
  if (sleepState === "waking") return "wake";
  return "awake";
}

/** A face is "present" while its engagement contribution hasn't decayed away
 *  (~8s half-life). Below this it's treated as lost. */
const FACE_PRESENT_MIN_CONTRIBUTION = 0.05;

function initialStageFor(phase: Phase): Stage {
  if (phase === "sleep") return "sleeping";
  if (phase === "wake") return "waking";
  return "hidden";
}

export function FullscreenAvatarOverlay() {
  const { isInitialized, isLoading, startupStage } = useDualAgentContext();
  const attentiveness = useCameraAttentivenessOptional();
  const sprite = useAvatarSprite();
  const { t } = useLanguage();

  const sleepState = attentiveness?.sleepState;
  // "Face lost" = the face engagement contribution has decayed to ~nothing (no
  // camera, no detection, or the student left frame). Keeps the board visible
  // while asleep as long as they're still there.
  const faceLost = (attentiveness?.engagementScore?.contributions?.face ?? 0) < FACE_PRESENT_MIN_CONTRIBUTION;
  const phase = computePhase(
    isInitialized,
    isLoading,
    sleepState,
    sprite.errorFrozenOverlayVisible,
    faceLost,
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
  // While actually starting up (isLoading), surface the server-reported startup
  // phase ("Connecting…" → "Checking notes…" → …). The "waking" stage is also
  // used for the post-load hold and sleep→wake transitions, which aren't
  // startup — those fall back to the plain "Waking up…" string.
  const label =
    stage === "sleeping"
      ? t("status.sleeping")
      : isLoading
        ? t(`status.startup.${startupStage}`)
        : t("status.wakingUp");

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="fullscreen-avatar-overlay"
          data-dwell-trap
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/70 backdrop-blur-md select-none"
        >
          <HoldToLogoutButton />
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

// Corner logout button. Requires a sustained pointer-hold to fire, so an
// accidental tap can't log the student out. Intentionally omits data-dwell so
// eye-gaze can't reach it — only a deliberate physical press works.
function HoldToLogoutButton() {
  const { t, isRTL } = useLanguage();
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doLogout = () => {
    localStorage.removeItem("synapse_user_profile");
    localStorage.removeItem("synapse_user_id");
    localStorage.removeItem("synapse_student_id");
    localStorage.setItem("aac_signed_out", "true");
    window.location.reload();
  };

  const cancel = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
  };

  const start = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHolding(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHolding(false);
      doLogout();
    }, LOGOUT_HOLD_MS);
  };

  useEffect(() => () => cancel(), []);

  return (
    <button
      type="button"
      aria-label={t("common.logout")}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      className={`absolute top-4 ${isRTL ? "left-4" : "right-4"} pointer-events-auto h-14 w-14 rounded-full bg-white/10 hover:bg-white/20 border border-white/30 text-white flex items-center justify-center overflow-hidden`}
    >
      <span
        className="absolute inset-0 bg-red-500/60 origin-bottom"
        style={{
          transform: `scaleY(${holding ? 1 : 0})`,
          transition: holding
            ? `transform ${LOGOUT_HOLD_MS}ms linear`
            : "transform 150ms ease-out",
        }}
        aria-hidden
      />
      <LogOut className="w-6 h-6 relative" />
      <span className="sr-only">{t("common.holdToLogout")}</span>
    </button>
  );
}

export default FullscreenAvatarOverlay;
