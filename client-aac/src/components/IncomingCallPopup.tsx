// client-aac/src/components/IncomingCallPopup.tsx
// Full-screen incoming-call overlay for the AAC client. Rings whenever the
// CallClient surfaces an incoming call (state "ringing-in"), regardless of the
// current screen. Shows the caller's identity (name + a large circular avatar
// with their initial — the callable-contacts endpoint carries no photo) and a
// big green "Yes" (accept) / red "No" (decline) pair.
//
// Eye-gaze/dwell: the overlay sets `data-dwell-trap` so dwell selection doesn't
// fall through to buttons behind it, and the Yes/No buttons are `[data-dwell]`
// so they're dwell-selectable (matching BinaryChoiceOverlay's wiring).

import { motion, AnimatePresence } from "framer-motion";
import { Phone, PhoneOff } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCallOptional } from "@/contexts/CallContext";

export function IncomingCallPopup() {
  const { t } = useLanguage();
  const call = useCallOptional();

  const ringing = !!call && call.callState === "ringing-in" && !!call.incoming;
  const name = call?.activeContact?.name ?? call?.incoming?.fromName ?? null;
  const initial = name ? name.trim().charAt(0).toUpperCase() : "?";

  return (
    <AnimatePresence>
      {ringing && (
        <motion.div
          data-dwell-trap
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex flex-col items-center gap-8">
            {/* Caller identity — large circular avatar (initial) + name. */}
            <div className="flex flex-col items-center gap-4">
              <motion.div
                className="flex items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl"
                style={{ width: "min(40vw, 220px)", height: "min(40vw, 220px)" }}
                initial={{ scale: 0.85 }}
                animate={{ scale: [0.96, 1.04, 0.96] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                aria-hidden="true"
              >
                <span className="font-bold leading-none" style={{ fontSize: "min(20vw, 110px)" }}>
                  {initial}
                </span>
              </motion.div>
              <div className="text-center text-white">
                <div className="text-sm uppercase tracking-wide opacity-80">
                  {t("call.incoming")}
                </div>
                <div className="text-3xl font-bold">{name ?? t("call.unknownCaller")}</div>
              </div>
            </div>

            {/* Big Yes / No — dwell-selectable. */}
            <div className="flex items-center justify-center gap-8">
              <button
                type="button"
                data-dwell="call-accept"
                onClick={() => call?.accept()}
                aria-label={t("call.accept")}
                className="flex flex-col items-center justify-center gap-2 rounded-3xl bg-green-500 hover:bg-green-600 text-white shadow-lg select-none"
                style={{ width: "min(34vw, 200px)", height: "min(34vw, 200px)" }}
              >
                <Phone style={{ width: "min(12vw, 72px)", height: "min(12vw, 72px)" }} />
                <span className="text-2xl font-bold">{t("call.accept")}</span>
              </button>
              <button
                type="button"
                data-dwell="call-decline"
                onClick={() => call?.decline()}
                aria-label={t("call.decline")}
                className="flex flex-col items-center justify-center gap-2 rounded-3xl bg-red-500 hover:bg-red-600 text-white shadow-lg select-none"
                style={{ width: "min(34vw, 200px)", height: "min(34vw, 200px)" }}
              >
                <PhoneOff style={{ width: "min(12vw, 72px)", height: "min(12vw, 72px)" }} />
                <span className="text-2xl font-bold">{t("call.decline")}</span>
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default IncomingCallPopup;
