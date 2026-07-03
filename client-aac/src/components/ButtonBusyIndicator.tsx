// client-aac/src/components/ButtonBusyIndicator.tsx
//
// Subtle, ambient cue on the button the child just pressed: a small spinner
// while the server is preparing the voice ("processing"), then a gentle
// pulsing dot while the utterance is being voiced ("speaking"). Rendered via
// the shared button's `cornerIndicator` slot, pinned to the TOP-LEFT so it
// never collides with the link-arrow indicator (top-right).
//
// Deliberately small and low-motion — this population uses eye-gaze and is
// easily distracted, so the cue reassures ("it heard me") without pulling
// focus. Reuses the `board-button-spin` keyframe injected by BoardButtonVisual.

import { memo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";

export type ButtonBusyPhase = "processing" | "speaking";

export const ButtonBusyIndicator = memo(function ButtonBusyIndicator({ phase }: { phase: ButtonBusyPhase }) {
  const { t } = useLanguage();
  const label = phase === "processing" ? t("processing.preparingVoice") : t("processing.speaking");
  return (
    <span
      role="status"
      aria-label={label}
      className="absolute top-0.5 left-0.5 pointer-events-none flex items-center justify-center rounded-full"
      style={{ width: 18, height: 18, background: "rgba(255,255,255,0.92)", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)" }}
    >
      {phase === "processing" ? (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: "2px solid rgba(59,130,246,0.85)",
            borderTopColor: "transparent",
            animation: "board-button-spin 0.9s linear infinite",
          }}
        />
      ) : (
        <span
          className="animate-pulse"
          style={{ width: 9, height: 9, borderRadius: "50%", background: "rgba(34,197,94,0.9)" }}
        />
      )}
    </span>
  );
});
