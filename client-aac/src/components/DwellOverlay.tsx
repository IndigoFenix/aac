// client-aac/src/components/DwellOverlay.tsx
// Visual feedback for eye tracking: gaze cursor dot + dwell clock-border animation on active target.

import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";

const GAZE_DOT_SIZE = 16;
const BORDER_WIDTH = 4;
const BORDER_RADIUS = 12; // matches rounded-xl
const ACCENT = "rgba(59, 130, 246, 0.8)"; // blue-500

export default function DwellOverlay() {
  const { gazePosition, dwellTarget, enabled, mode } = useEyeTrackingDwell();

  if (!enabled) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999 }}
    >
      {/* Gaze cursor dot — only in eyegaze mode (mouse mode uses OS cursor) */}
      {mode === "eyegaze" && gazePosition && (
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

      {/* Dwell clock-border on target element */}
      {dwellTarget && (
        <DwellBorder
          rect={dwellTarget.rect}
          progress={dwellTarget.progress}
        />
      )}
    </div>
  );
}

function DwellBorder({ rect, progress }: { rect: DOMRect; progress: number }) {
  const pad = BORDER_WIDTH / 2;
  const x = rect.left - pad;
  const y = rect.top - pad;
  const w = rect.width + BORDER_WIDTH;
  const h = rect.height + BORDER_WIDTH;

  // SVG rounded rect path perimeter for dasharray
  const perimeter = 2 * (w + h) - 8 * BORDER_RADIUS + 2 * Math.PI * BORDER_RADIUS;
  const dashOffset = perimeter * (1 - progress);

  return (
    <svg
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "visible",
      }}
    >
      <rect
        x={BORDER_WIDTH / 2}
        y={BORDER_WIDTH / 2}
        width={w - BORDER_WIDTH}
        height={h - BORDER_WIDTH}
        rx={BORDER_RADIUS}
        ry={BORDER_RADIUS}
        fill="none"
        stroke={ACCENT}
        strokeWidth={BORDER_WIDTH}
        strokeDasharray={perimeter}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </svg>
  );
}
