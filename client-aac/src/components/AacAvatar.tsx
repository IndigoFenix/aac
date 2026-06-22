// client-aac/src/components/AacAvatar.tsx
// Layered AAC avatar sprite. The avatar is composed from independent
// base/eyes/ears/mouth/glasses layers so future avatar variants can swap
// individual parts. The companion <AacCave> renders the cave that the
// avatar lives in when the system is in silent mode (or has no session).

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export type EyeState = "open" | "rest" | "closed" | "hurt";
export type EarState = "open" | "neutral" | "closed";
export type MouthEmote = "happy" | "sad" | "neutral";

const BASE = (avatar: string) =>
  `${import.meta.env.BASE_URL}aac-avatars/${avatar}`;

const EYE_FILE: Record<EyeState, string> = {
  open: "eyes-open.png",
  rest: "eyes-rest.png",
  closed: "eyes-closed.png",
  hurt: "eyes-hurt.png",
};
const EAR_FILE: Record<EarState, string> = {
  open: "ears-open.png",
  neutral: "ears-neutral.png",
  closed: "ears-closed.png",
};
const CAVE_EYE_FILE: Record<EyeState, string> = {
  open: "cave-eyes-open.png",
  rest: "cave-eyes-rest.png",
  closed: "cave-eyes-closed.png",
  hurt: "cave-eyes-hurt.png",
};

// Snapshot blink: snap eyes shut briefly each time a camera frame/snapshot is
// taken (snapshotTick changes), rather than on a random timer. Disabled when
// eyes are already closed or showing the hurt sprite.
export function useBlink(eyeState: EyeState, snapshotTick: number): boolean {
  const [blinking, setBlinking] = useState(false);
  const prevTickRef = useRef(snapshotTick);
  useEffect(() => {
    // Only react to an actual snapshot (tick change) — not eyeState changes.
    if (prevTickRef.current === snapshotTick) return;
    prevTickRef.current = snapshotTick;
    if (eyeState === "closed" || eyeState === "hurt") return;
    setBlinking(true);
    const closeTimer = setTimeout(() => setBlinking(false), 150);
    return () => clearTimeout(closeTimer);
  }, [snapshotTick, eyeState]);
  return blinking;
}

// Ear flap cycle: `earFlapSpeed` ms open, 250 ms neutral, repeat. Caller
// passes earFlapSpeed === 0 to disable flapping entirely (e.g. standby/
// assist). Flap runs regardless of eyeState so sleeping avatars can still
// twitch their ears slowly.
export function useEarFlap(earState: EarState, earFlapSpeed: number): EarState {
  const [phaseOpen, setPhaseOpen] = useState(true);
  useEffect(() => {
    if (earState !== "open") return;
    if (earFlapSpeed === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let current = true;
    const tick = () => {
      current = !current;
      setPhaseOpen(current);
      timer = setTimeout(tick, current ? earFlapSpeed - 250 : 250);
    };
    setPhaseOpen(true);
    timer = setTimeout(tick, earFlapSpeed - 250);
    return () => clearTimeout(timer);
  }, [earState, earFlapSpeed]);
  if (earState !== "open") return earState;
  return phaseOpen ? "open" : "neutral";
}

// Resolve the displayed eye/ear frames from logical state. Call this once at
// the "source" level (e.g. AvatarSpriteProvider) so multiple <AacAvatar />
// instances can share the same blink/ear-flap frame instead of running
// independent random timers.
export function useAvatarFrames(
  eyeState: EyeState,
  earState: EarState,
  earFlapSpeed: number,
  snapshotTick: number
): { renderedEye: EyeState; renderedEar: EarState } {
  const blinking = useBlink(eyeState, snapshotTick);
  const renderedEar = useEarFlap(earState, earFlapSpeed);
  return {
    renderedEye: blinking ? "closed" : eyeState,
    renderedEar,
  };
}

interface AacAvatarProps {
  avatar: string;
  renderedEye: EyeState;
  renderedEar: EarState;
  mouthEmote: MouthEmote;
  mouthOpen: boolean;
  showMouth: boolean;
  focusActive: boolean;
}

export function AacAvatar({
  avatar,
  renderedEye,
  renderedEar,
  mouthEmote,
  mouthOpen,
  showMouth,
  focusActive,
}: AacAvatarProps) {
  const base = BASE(avatar);
  const mouthFile = `mouth-${mouthEmote}${mouthOpen ? "-open" : ""}.png`;

  return (
    <>
      <img
        src={`${base}/base.png`}
        alt=""
        className="w-full h-full object-contain"
      />
      <img
        src={`${base}/${EAR_FILE[renderedEar]}`}
        alt=""
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
      <img
        src={`${base}/${EYE_FILE[renderedEye]}`}
        alt=""
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
      {showMouth && (
        <img
          src={`${base}/${mouthFile}`}
          alt=""
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
      )}
      <AnimatePresence>
        {focusActive && (
          <motion.img
            key="focus-glasses"
            src={`${base}/glasses.png`}
            alt=""
            initial={{ opacity: 0, scale: 1.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
        )}
      </AnimatePresence>
    </>
  );
}

interface AacCaveProps {
  avatar: string;
  // true when the avatar is out of the cave (visible separately).
  empty: boolean;
  // Only consulted when empty === false.
  eyeState: EyeState;
  // Snapshot counter — blinks the cave eyes on each new snapshot.
  blinkTick: number;
}

export function AacCave({ avatar, empty, eyeState, blinkTick }: AacCaveProps) {
  const base = BASE(avatar);
  const blinking = useBlink(eyeState, blinkTick);
  const renderedEye: EyeState = blinking ? "closed" : eyeState;
  const src = empty
    ? `${base}/cave-empty.png`
    : `${base}/${CAVE_EYE_FILE[renderedEye]}`;
  return (
    <img
      src={src}
      alt={empty ? "Cave (empty)" : "Cave"}
      className="w-full h-full object-contain"
    />
  );
}
