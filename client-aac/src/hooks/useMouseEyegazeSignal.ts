/**
 * useMouseEyegazeSignal.ts
 *
 * Pushes the mouseEyegaze engagement signal on pointer activity (mouse, touch,
 * or pen). pointermove + pointerdown are throttled to avoid flooding the
 * engagement combiner — a sustained input stream just refreshes the
 * contribution to its weight, while sparse events decay naturally.
 *
 * Eyegaze cursor movement also dispatches synthesized pointer events on
 * supported tablets, so this single hook covers both.
 */

import { useEffect } from "react";

const THROTTLE_MS = 500;

export function useMouseEyegazeSignal(push: (intensity: number) => void): void {
  useEffect(() => {
    let lastPush = 0;
    const handler = () => {
      const now = Date.now();
      if (now - lastPush < THROTTLE_MS) return;
      lastPush = now;
      push(1);
    };

    document.addEventListener("pointermove", handler, { passive: true });
    document.addEventListener("pointerdown", handler, { passive: true });
    document.addEventListener("keydown", handler);

    return () => {
      document.removeEventListener("pointermove", handler);
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [push]);
}
