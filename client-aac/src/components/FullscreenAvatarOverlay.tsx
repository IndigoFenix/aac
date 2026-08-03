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
//
// SLP MODE turns this overlay into a CURTAIN the therapist draws back by hand.
// A speech-language pathologist carries the device around a room, so the
// student is often out of frame and the screen must not become live on its own.
// Two differences, both only while slpMode is on:
//
//   1. The "sleeping" stage carries a WAKE button. Nothing else can wake the
//      session in SLP MODE (presence is deliberately inert — see
//      triggerAlwaysWake in CameraAttentivenessContext), so without a control
//      ON the overlay there would be no way back: the overlay covers the header
//      where the normal wake/sleep control lives.
//   2. Waking does NOT hand the device over. When the wake finishes, the stage
//      becomes "ready" — label "Ready", button still there — and the overlay
//      stays until the therapist presses it again. The session behind it is
//      already live, so handing over is instant; the curtain is what waits.
//      Outside SLP MODE this stage never occurs and the timed auto-hide is
//      unchanged.

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LogOut, Sun } from "lucide-react";
import { AacAvatar } from "@/components/AacAvatar";
import { useAvatarSprite } from "@/contexts/AvatarSpriteContext";
import { useCameraAttentivenessOptional } from "@/contexts/CameraAttentivenessContext";
import { useDualAgentContext } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  computePhase,
  initialStageFor,
  stageForPhase,
  slpStageFor,
  overlayAwaitsPress,
  type OverlayPhase as Phase,
  type OverlayStage as Stage,
} from "@/lib/sleepOverlayLogic";

const WAKING_HOLD_MS = 1500;
const LOGOUT_HOLD_MS = 2000;

/** A face is "present" while its engagement contribution hasn't decayed away
 *  (~8s half-life). Below this it's treated as lost. */
const FACE_PRESENT_MIN_CONTRIBUTION = 0.05;

export function FullscreenAvatarOverlay() {
  const {
    isInitialized,
    isLoading,
    startupStage,
    slpMode,
    sessionAsleep,
    toggleSessionSleep,
    slpWakeReady,
  } = useDualAgentContext();
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
    slpMode,
  );

  // NON-SLP stage: a small timed machine (waking → hidden after a hold), so it
  // needs local state to run the timer.
  const [timedStage, setTimedStage] = useState<Stage>(() => initialStageFor(phase));
  const lastPhaseRef = useRef<Phase>(phase);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (slpMode) return; // SLP MODE runs no timer — see the derived stage below
    const prev = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (phase === prev) return;

    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    // Transitioning into awake from sleep/wake keeps "Waking up…" visible for
    // WAKING_HOLD_MS before hiding.
    const { stage: next, autoHide } = stageForPhase(phase);
    setTimedStage(next);
    if (autoHide) {
      hideTimerRef.current = setTimeout(() => {
        setTimedStage("hidden");
        hideTimerRef.current = null;
      }, WAKING_HOLD_MS);
    }
  }, [phase, slpMode]);

  // In SLP MODE the stage is a pure projection of GLOBAL state — the phase plus
  // the shared hand-over flag the header control also reads. No local state, so
  // the two wake controls cannot drift out of sync (they did when the overlay
  // owned "dismissed" itself).
  const stage: Stage = slpMode ? slpStageFor(phase, slpWakeReady) : timedStage;

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
      : stage === "ready"
        ? t("slpMode.ready")
        : isLoading
          ? t(`status.startup.${startupStage}`)
          : t("status.wakingUp");

  // The therapist's control. Only in SLP MODE, and only at the two stages that
  // are WAITING on a person: "sleeping" (wake the session) and "ready" (hand
  // the screen over). The "waking" stage is work in progress — no button, so a
  // second press can't land mid-wake.
  const showWakeButton = slpMode && overlayAwaitsPress(stage);

  // ONE press wakes and returns to the board. "sleeping" and "ready" are both
  // asleep — "ready" only says the device noticed someone — so they take the
  // same action. Guarded on sessionAsleep so a press while the session is
  // merely pre-initialized can never toggle a LIVE session into sleep.
  const handleWakePress = () => {
    if (sessionAsleep) toggleSessionSleep();
  };

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
          {showWakeButton && (
            <button
              type="button"
              // data-dwell (unlike the logout button, which deliberately omits
              // it): the overlay is a dwell-trap, so this is the only thing an
              // eye-gaze user could reach while the curtain is up.
              data-dwell
              data-testid="overlay-wake"
              onClick={handleWakePress}
              className="mt-8 flex items-center gap-3 rounded-2xl bg-white/15 hover:bg-white/25 border border-white/40 px-8 py-5 text-white text-xl font-semibold"
            >
              <Sun className="w-7 h-7" />
              {t("slpMode.wake")}
            </button>
          )}
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
