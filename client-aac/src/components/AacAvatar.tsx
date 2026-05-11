// client-aac/src/components/AacAvatar.tsx
// Layered AAC avatar sprite. The avatar is composed from independent
// base/eyes/ears/mouth/glasses layers so future avatar variants can swap
// individual parts. The companion <AacCave> renders the cave that the
// avatar lives in when the system is in silent mode (or has no session).

import { useEffect, useState } from "react";
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

// Idle blink: every ~8s (+0–4s jitter) snap eyes shut briefly. Disabled when
// eyes are already closed or showing the hurt sprite.
function useBlink(eyeState: EyeState): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (eyeState === "closed" || eyeState === "hurt") {
      setBlinking(false);
      return;
    }
    let openTimer: ReturnType<typeof setTimeout>;
    let closeTimer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const wait = (8 + Math.random() * 4) * 1000;
      openTimer = setTimeout(() => {
        setBlinking(true);
        closeTimer = setTimeout(() => {
          setBlinking(false);
          scheduleNext();
        }, 150);
      }, wait);
    };
    scheduleNext();
    return () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
    };
  }, [eyeState]);
  return blinking;
}

// Ear flap cycle for interact mode: 1.75s open, 0.25s neutral, repeat.
function useEarFlap(earState: EarState, eyeState: EyeState): EarState {
  const [phaseOpen, setPhaseOpen] = useState(true);
  useEffect(() => {
    if (earState !== "open") return;
    if (eyeState !== "open") return;
    let timer: ReturnType<typeof setTimeout>;
    let current = true;
    const tick = () => {
      current = !current;
      setPhaseOpen(current);
      timer = setTimeout(tick, current ? 1750 : 250);
    };
    setPhaseOpen(true);
    timer = setTimeout(tick, 1750);
    return () => clearTimeout(timer);
  }, [earState, eyeState]);
  if (earState !== "open") return earState;
  return phaseOpen ? "open" : "neutral";
}

interface AacAvatarProps {
  avatar: string;
  eyeState: EyeState;
  earState: EarState;
  mouthEmote: MouthEmote;
  mouthOpen: boolean;
  showMouth: boolean;
  focusActive: boolean;
}

export function AacAvatar({
  avatar,
  eyeState,
  earState,
  mouthEmote,
  mouthOpen,
  showMouth,
  focusActive,
}: AacAvatarProps) {
  const base = BASE(avatar);
  const blinking = useBlink(eyeState);
  const renderedEye: EyeState = blinking ? "closed" : eyeState;
  const renderedEar = useEarFlap(earState, eyeState);
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
}

export function AacCave({ avatar, empty, eyeState }: AacCaveProps) {
  const base = BASE(avatar);
  const blinking = useBlink(eyeState);
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
