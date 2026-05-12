// client-aac/src/components/YesNoSprite.tsx
// Animated yes/no sprite drawn from a 3x2 spritesheet (574px frames).
// Sits at frame 0 by default; cycles through its frame sequence whenever the
// surrounding [data-dwell] button is hovered by mouse OR the eyegaze dwell target.

import { useEffect, useRef, useState } from "react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import yesNoSpritesUrl from "@assets/aac-icons/basic/yes-no-sprites.png";

interface YesNoSpriteProps {
  variant: "yes" | "no";
  size: number | string;
  className?: string;
}

const YES_FRAMES = [0, 1, 2, 1];
const NO_FRAMES = [0, 1, 0, 2];
const FRAME_DURATION_MS = 130;

export function YesNoSprite({ variant, size, className = "" }: YesNoSpriteProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mouseHover, setMouseHover] = useState(false);
  const [frame, setFrame] = useState(0);
  const [dwellHost, setDwellHost] = useState<Element | null>(null);
  const { dwellTarget } = useEyeTrackingDwell();

  // Latch the enclosing dwell target once mounted so we can match against dwellTarget.
  useEffect(() => {
    if (ref.current) {
      setDwellHost(ref.current.closest("[data-dwell]"));
    }
  }, []);

  // Mouse hover on the host button.
  useEffect(() => {
    if (!dwellHost) return;
    const enter = () => setMouseHover(true);
    const leave = () => setMouseHover(false);
    dwellHost.addEventListener("pointerenter", enter);
    dwellHost.addEventListener("pointerleave", leave);
    return () => {
      dwellHost.removeEventListener("pointerenter", enter);
      dwellHost.removeEventListener("pointerleave", leave);
    };
  }, [dwellHost]);

  const dwellHover = !!dwellHost && dwellTarget?.element === dwellHost;
  const animating = mouseHover || dwellHover;

  useEffect(() => {
    if (!animating) {
      setFrame(0);
      return;
    }
    const sequence = variant === "yes" ? YES_FRAMES : NO_FRAMES;
    let i = 0;
    setFrame(sequence[0]);
    const interval = setInterval(() => {
      i = (i + 1) % sequence.length;
      setFrame(sequence[i]);
    }, FRAME_DURATION_MS);
    return () => clearInterval(interval);
  }, [animating, variant]);

  // 3 columns × 2 rows; with background-size 300% 200%, each frame step is 50% horizontally
  // (the scrollable range is 200% of the container, divided across the 2 gaps between 3 frames).
  const bgX = `${(frame / 2) * 100}%`;
  const bgY = variant === "yes" ? "0%" : "100%";
  const sizeStyle = typeof size === "number" ? `${size}px` : size;

  return (
    <div
      ref={ref}
      className={className}
      style={{
        width: sizeStyle,
        height: sizeStyle,
        backgroundImage: `url(${yesNoSpritesUrl})`,
        backgroundSize: "300% 200%",
        backgroundPosition: `${bgX} ${bgY}`,
        backgroundRepeat: "no-repeat",
      }}
      aria-hidden="true"
    />
  );
}
