// client-aac/src/components/DwellOverlay.tsx
// Visual feedback for eye tracking: gaze cursor dot + dwell clock-border + circular ring timer.

import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { IntentSpark } from "@/components/IntentSpark";
import { cornerCutPath, roundedRectPath } from "@shared/button-shape";

const GAZE_DOT_SIZE = 16;
const BORDER_WIDTH = 4;
const BORDER_RADIUS = 12; // matches rounded-xl
const ACCENT = "rgba(59, 130, 246, 0.8)"; // blue-500
// Selection-area mode: the timer is slipping back because the gaze wandered off
// the eye mark (usually to read the label). Amber says "still here, but going".
const DRAIN_ACCENT = "rgba(245, 158, 11, 0.85)"; // amber-500
const RING_STROKE = 6;

export default function DwellOverlay() {
  const { gazePosition, dwellTarget, enabled, mode } = useEyeTrackingDwell();

  if (!enabled) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999 }}
    >
      {/* Gaze cursor dot — only in eyegaze mode (mouse mode uses OS cursor).
          Suppressed while the intent spark is up: the spark already shows where
          the gaze has settled, from a smoothed centroid rather than the raw
          jittery point, and two cursors on one button is just noise. */}
      {mode === "eyegaze" && gazePosition && !dwellTarget?.intent && (
        <div
          style={{
            position: "absolute",
            left: gazePosition.x - GAZE_DOT_SIZE / 2,
            top: gazePosition.y - GAZE_DOT_SIZE / 2,
            width: GAZE_DOT_SIZE,
            height: GAZE_DOT_SIZE,
            borderRadius: "50%",
            backgroundColor: "rgba(59, 130, 246, 0.5)",
            border: "2px solid rgba(59, 130, 246, 0.8)",
            transition: "left 50ms linear, top 50ms linear",
          }}
        />
      )}

      {/* Dwell clock-border + circular ring on target element. In selection-area
          mode the ring moves onto the small eye mark so it never covers the
          label — the whole-button border still tracks the same progress.
          In INTENT mode the spark replaces the ring, and the border only
          appears once something is actually being counted, so that a student
          reading a button sees no selection chrome at all. */}
      {dwellTarget && (
        <>
          {(!dwellTarget.intent || dwellTarget.progress > 0) && (
            <DwellBorder
              rect={dwellTarget.rect}
              progress={dwellTarget.progress}
              accent={dwellTarget.draining ? DRAIN_ACCENT : ACCENT}
              cut={dwellTarget.cornerCut}
            />
          )}
          {dwellTarget.intent ? (
            <IntentSpark target={dwellTarget} />
          ) : (
            <DwellRing
              rect={dwellTarget.areaRect ?? dwellTarget.rect}
              progress={dwellTarget.progress}
              accent={dwellTarget.draining ? DRAIN_ACCENT : ACCENT}
              /* On the eye mark the ring hugs the mark's own box; on a whole
                 button it sits at 60% so it doesn't crowd the icon. */
              fillFraction={dwellTarget.areaRect ? 1 : 0.6}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The clock-border that fills as the dwell timer runs. It traces the target's
 * ACTUAL outline: a button with concave corner cuts gets the same path its
 * surface is drawn from, so the timer runs along the border rather than across
 * the empty space beside it.
 *
 * `pathLength` normalises the path to 1000 units whatever its real perimeter,
 * so the dash maths is the same for both shapes and needs no arc-length
 * arithmetic.
 */
function DwellBorder({
  rect,
  progress,
  accent,
  cut,
}: {
  rect: DOMRect;
  progress: number;
  accent: string;
  cut: { radius: number; offset: number } | null;
}) {
  const w = rect.width;
  const h = rect.height;
  const d = cut
    ? cornerCutPath({ w, h, radius: cut.radius, offset: cut.offset })
    : roundedRectPath(w, h, BORDER_RADIUS);

  const LEN = 1000;
  return (
    <svg
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: w,
        height: h,
        // The stroke is centred on the outline, so half of it sits outside.
        overflow: "visible",
      }}
    >
      <path
        d={d}
        fill="none"
        stroke={accent}
        strokeWidth={BORDER_WIDTH}
        strokeLinecap="round"
        pathLength={LEN}
        strokeDasharray={LEN}
        strokeDashoffset={LEN * (1 - progress)}
      />
    </svg>
  );
}

function DwellRing({
  rect,
  progress,
  accent,
  fillFraction,
}: {
  rect: DOMRect;
  progress: number;
  accent: string;
  fillFraction: number;
}) {
  // Size the ring to fit inside the target — use the smaller dimension.
  const diameter = Math.min(rect.width, rect.height) * fillFraction;
  // The eye mark is small, so a fixed 6px stroke would swallow it whole.
  const stroke = Math.max(2, Math.min(RING_STROKE, diameter * 0.18));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const svgSize = diameter;

  return (
    <svg
      style={{
        position: "absolute",
        left: cx - svgSize / 2,
        top: cy - svgSize / 2,
        width: svgSize,
        height: svgSize,
      }}
    >
      {/* Background track */}
      <circle
        cx={svgSize / 2}
        cy={svgSize / 2}
        r={radius}
        fill="none"
        stroke="rgba(255, 255, 255, 0.2)"
        strokeWidth={stroke}
      />
      {/* Progress arc */}
      <circle
        cx={svgSize / 2}
        cy={svgSize / 2}
        r={radius}
        fill="none"
        stroke={accent}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${svgSize / 2} ${svgSize / 2})`}
      />
    </svg>
  );
}
