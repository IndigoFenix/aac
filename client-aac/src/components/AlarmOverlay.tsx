// client-aac/src/components/AlarmOverlay.tsx
//
// Caretaker alarm surface, driven by the Observer agent (see the `alarm`
// server message). Two levels:
//   - "alert"     — a single short attention chime, no overlay. Clears
//                   itself once the chime has played.
//   - "emergency" — a rising, building alarm tone PLUS a full red overlay
//                   with a large cancel button so a caretaker can silence
//                   it. The overlay is a dwell-trap so eye-gaze dwell stays
//                   on the cancel button and doesn't fall through to the
//                   board behind it.
//
// The component owns the audio side-effect; the active alarm + a clear
// function are threaded in from useLiveSession via DualAgentContext.

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { playAlertBeep, startEmergencyTone, type EmergencyToneHandle } from "@/lib/alarmSounds";

interface AlarmOverlayProps {
  alarm: { level: "alert" | "emergency"; reason: string } | null;
  /** Clear the active alarm (emergency cancel button + alert auto-dismiss). */
  onCancel: () => void;
}

// How long to keep the (invisible) alert mounted so its chime plays out
// before we auto-clear it.
const ALERT_DISMISS_MS = 500;

export default function AlarmOverlay({ alarm, onCancel }: AlarmOverlayProps) {
  const { t } = useLanguage();
  const toneRef = useRef<EmergencyToneHandle | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Drive the sound off the current alarm level. Re-runs when the level or
  // reason changes (an alert escalating to an emergency swaps the sound).
  useEffect(() => {
    if (!alarm) return;

    if (alarm.level === "alert") {
      // Non-emergency: one chime, then clear. No overlay, no cancel button.
      playAlertBeep();
      const tid = setTimeout(() => onCancelRef.current(), ALERT_DISMISS_MS);
      return () => clearTimeout(tid);
    }

    // Emergency: a building tone that runs until the caretaker cancels.
    toneRef.current = startEmergencyTone();
    return () => {
      toneRef.current?.stop();
      toneRef.current = null;
    };
  }, [alarm?.level, alarm?.reason]);

  const showOverlay = alarm?.level === "emergency";

  return (
    <AnimatePresence>
      {showOverlay && alarm && (
        <motion.div
          data-dwell-trap
          role="alertdialog"
          aria-live="assertive"
          className="absolute inset-0 z-50 flex items-center justify-center bg-red-700/90 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="flex flex-col items-center gap-6 px-8 text-center">
            <h2 className="font-bold text-white" style={{ fontSize: "clamp(1.8rem, 6vw, 3.5rem)" }}>
              {t("alarm.emergency")}
            </h2>
            {alarm.reason && (
              <p className="text-white/90 max-w-2xl" style={{ fontSize: "clamp(1rem, 3vw, 1.6rem)" }}>
                {alarm.reason}
              </p>
            )}
            {/* Big central cancel target: a bell with an X over it, so a
                caretaker can silence a mistaken alarm. data-dwell makes it
                eye-gaze selectable (the overlay is a dwell-trap, so gaze
                resolves to this button). */}
            <motion.button
              data-dwell="cancel-alarm"
              aria-label={t("alarm.cancel")}
              className="relative flex items-center justify-center rounded-full bg-white shadow-2xl select-none active:scale-95 transition-transform"
              style={{ width: "clamp(10rem, 38vw, 18rem)", height: "clamp(10rem, 38vw, 18rem)" }}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: [1, 1.06, 1] }}
              transition={{ scale: { repeat: Infinity, duration: 1 }, opacity: { duration: 0.2 } }}
              onClick={() => onCancelRef.current()}
            >
              <Bell
                aria-hidden
                className="text-red-700"
                strokeWidth={2.25}
                style={{ width: "52%", height: "52%" }}
              />
              <X
                aria-hidden
                className="absolute text-red-600"
                strokeWidth={1.5}
                style={{ width: "82%", height: "82%" }}
              />
            </motion.button>
            <span className="text-white font-bold" style={{ fontSize: "clamp(1.1rem, 3.5vw, 1.8rem)" }}>
              {t("alarm.cancel")}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
