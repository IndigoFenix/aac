// client-aac/src/components/IntentSpark.tsx
//
// The readout for the gaze INTENT DECODER, in the world engine's spark
// language: a bright ball inside a dim glow, both varying in size.
//
// Both halves are honest readouts of the decoder's actual signals, not
// decoration — a student has to be able to see the decision coming and escape
// it, and a clinician has to be able to believe what it shows:
//
//   GLOW  = attention. Its radius IS the measured fixation dispersion. A gaze
//           roving over the button gets a wide, diffuse halo; as the eye
//           settles the halo contracts. "I can see you looking, and I'm not
//           counting it yet."
//   BALL  = commitment. It exists only once the decoder has decided this is a
//           choice rather than a read, and grows toward the glow as the timer
//           fills. THE BALL MEETING THE GLOW IS THE SELECTION — one legible
//           rule, and the convergence is its own countdown.
//
// MOTION SAFETY (this population is photosensitive — see the seizure-risk
// rules and the 3D spark's tuning notes): no brightness modulation anywhere
// near the 3-20Hz discomfort band, nothing strobes, and brightness rises ONLY
// as the gaze stills, never while it travels. The short linear transitions
// below are deliberately slow enough to read as motion rather than flicker.

import { memo } from "react";
import type { DwellTarget } from "@/contexts/EyeTrackingDwellContext";

// Glow radius bounds, px. The floor is roughly a comfortable fixation target;
// the ceiling is wide enough to read as "unfocused" without covering a button.
const GLOW_MIN_R = 24;
const GLOW_MAX_R = 88;
/** Dispersion at which the glow is fully open, as a multiple of the threshold. */
const GLOW_FULL_AT = 2;

const ACCENT = "96, 165, 250"; // blue-400
const DRAIN_ACCENT = "251, 191, 36"; // amber-400 — losing ground

export const IntentSpark = memo(function IntentSpark({ target }: { target: DwellTarget }) {
  const intent = target.intent;
  if (!intent) return null;

  const { centroid, dispersion, threshold, zone, state } = intent;
  const spread = Math.min(1, dispersion / Math.max(1, threshold * GLOW_FULL_AT));
  const glowR = GLOW_MIN_R + (GLOW_MAX_R - GLOW_MIN_R) * spread;
  const ballR = glowR * target.progress;

  const rgb = target.draining ? DRAIN_ACCENT : ACCENT;
  // Resting is a legitimate place to be, so the glow stays visible there — just
  // faint, because nothing can charge from it.
  const glowAlpha = zone === "rest" ? 0.1 : 0.14 + 0.16 * (1 - spread);
  const showBall = target.progress > 0.001 && state === "charging";

  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: centroid.x - glowR,
          top: centroid.y - glowR,
          width: glowR * 2,
          height: glowR * 2,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(${rgb}, ${glowAlpha}) 0%, rgba(${rgb}, ${glowAlpha * 0.5}) 55%, rgba(${rgb}, 0) 72%)`,
          transition: "left 80ms linear, top 80ms linear, width 80ms linear, height 80ms linear",
        }}
      />
      {showBall && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: centroid.x - ballR,
            top: centroid.y - ballR,
            width: ballR * 2,
            height: ballR * 2,
            borderRadius: "50%",
            background: `rgba(${rgb}, ${0.5 + 0.45 * target.progress})`,
            boxShadow: `0 0 ${Math.round(glowR * 0.35)}px rgba(${rgb}, 0.45)`,
            transition: "left 80ms linear, top 80ms linear, width 80ms linear, height 80ms linear",
          }}
        />
      )}
    </>
  );
});

export default IntentSpark;
