// client-aac/src/components/PhoneCallApp.tsx
// AAC "Phone call" app — grid of callable contacts (name + online indicator).
// Dwelling/tapping an ONLINE contact dials it via startCallToContact; offline
// contacts are greyed/disabled. While a call is ringing-out / connecting /
// active, the app shows the call status with a hang-up control. The grid layout
// mirrors AppsBoard so it feels native to the AAC apps surface.
//
// Contacts carry no photo (the callable-contacts endpoint returns name + online
// only), so each tile shows a large circular avatar with the contact's initial.

import { useEffect, useMemo } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCall } from "@/contexts/CallContext";

interface PhoneCallAppProps {
  onClose: () => void;
  /** "Play with friends" mode: picking a contact starts a call AND attaches the
   *  default social game once connected. Otherwise this is a plain phone call. */
  gameMode?: boolean;
}

const COLS = 3;

export default function PhoneCallApp({ onClose, gameMode = false }: PhoneCallAppProps) {
  const { t } = useLanguage();
  const {
    contacts,
    contactsLoading,
    refreshContacts,
    startCallToContact,
    startGameWithContact,
    startSoloGame,
    startGame,
    callState,
    activeContact,
    cancel,
    hangUp,
  } = useCall();

  const pickContact = (contactId: string) =>
    gameMode ? startGameWithContact(contactId) : startCallToContact(contactId);

  // Refresh online flags when the app opens.
  useEffect(() => {
    refreshContacts();
  }, [refreshContacts]);

  const inCall = callState !== "idle";
  const rows = useMemo(() => {
    const n = contacts.length || 1;
    return n <= COLS ? 1 : n <= COLS * 2 ? 2 : Math.ceil(n / COLS);
  }, [contacts.length]);

  const statusLabel = (() => {
    switch (callState) {
      case "ringing-out":
        return t("call.calling");
      case "connecting":
        return t("call.connecting");
      case "active":
        return t("call.inCall");
      default:
        return "";
    }
  })();

  return (
    <div className="flex flex-col w-full h-full p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {gameMode ? t("socialWorld.title") : t("call.phoneCallApp")}
        </h2>
        <button
          data-dwell="phone-close"
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 text-lg font-medium hover:bg-gray-300 dark:hover:bg-gray-600"
          aria-label={t("common.close")}
        >
          {t("common.close")}
        </button>
      </div>

      {gameMode && (
        // Start options: play alone, or — if already in a call — turn this call
        // into a game. Calling a specific friend uses the contact grid below.
        <div className="mb-4 shrink-0">
          <button
            type="button"
            data-dwell={callState === "active" ? "game-in-call" : "game-solo"}
            onClick={() => (callState === "active" ? startGame() : startSoloGame())}
            className="w-full flex items-center justify-center gap-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-5 text-2xl font-bold shadow-md"
          >
            🎮 {callState === "active" ? t("socialWorld.playInCall") : t("socialWorld.playSolo")}
          </button>
        </div>
      )}

      {inCall ? (
        // Active / ringing call — status + hang-up.
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div
            className="flex items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl"
            style={{ width: "min(36vw, 200px)", height: "min(36vw, 200px)" }}
            aria-hidden="true"
          >
            <span className="font-bold leading-none" style={{ fontSize: "min(18vw, 96px)" }}>
              {(activeContact?.name ?? "?").trim().charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {activeContact?.name ?? t("call.unknownCaller")}
            </div>
            <div className="text-xl text-gray-600 dark:text-gray-300 mt-1">{statusLabel}</div>
          </div>
          <button
            type="button"
            data-dwell="call-hangup"
            onClick={() => (callState === "ringing-out" ? cancel() : hangUp())}
            aria-label={t("call.hangUp")}
            className="flex flex-col items-center justify-center gap-2 rounded-3xl bg-red-500 hover:bg-red-600 text-white shadow-lg select-none"
            style={{ width: "min(30vw, 160px)", height: "min(30vw, 160px)" }}
          >
            <PhoneOff style={{ width: "min(11vw, 64px)", height: "min(11vw, 64px)" }} />
            <span className="text-xl font-bold">{t("call.hangUp")}</span>
          </button>
        </div>
      ) : contactsLoading ? (
        <div className="flex-1 flex items-center justify-center text-xl text-gray-500 dark:text-gray-400">
          {t("common.loading")}
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xl text-gray-500 dark:text-gray-400">
          {t("call.noCallableContacts")}
        </div>
      ) : (
        <div
          className="flex-1 grid gap-4 overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {contacts.map((c) => {
            const initial = (c.name ?? "?").trim().charAt(0).toUpperCase();
            return (
              <button
                key={c.contactId}
                type="button"
                {...(c.online ? { "data-dwell": `call-${c.contactId}` } : {})}
                disabled={!c.online}
                onClick={() => c.online && pickContact(c.contactId)}
                aria-label={
                  c.online
                    ? `${t("call.callContact")} ${c.name}`
                    : `${c.name} — ${t("call.offline")}`
                }
                className={`relative flex flex-col items-center justify-center gap-3 p-4 rounded-2xl border-2 shadow-sm transition ${
                  c.online
                    ? "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-emerald-400 dark:hover:border-emerald-500 cursor-pointer"
                    : "bg-gray-100 dark:bg-gray-900 border-gray-200 dark:border-gray-800 opacity-50 cursor-not-allowed"
                }`}
              >
                <div
                  className="flex items-center justify-center rounded-full bg-emerald-600 text-white"
                  style={{ width: "min(16vw, 110px)", height: "min(16vw, 110px)" }}
                >
                  <span className="font-bold leading-none" style={{ fontSize: "min(8vw, 56px)" }}>
                    {initial}
                  </span>
                </div>
                <div className="text-lg font-medium text-gray-900 dark:text-gray-100 text-center truncate w-full">
                  {c.name}
                </div>
                {/* Online indicator. */}
                <div className="flex items-center gap-1.5 text-sm">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${
                      c.online ? "bg-green-500" : "bg-gray-400"
                    }`}
                  />
                  <span className={c.online ? "text-green-600 dark:text-green-400" : "text-gray-500"}>
                    {c.online ? t("call.online") : t("call.offline")}
                  </span>
                </div>
                {c.online && (
                  <Phone className="absolute top-2 right-2 w-5 h-5 text-emerald-500" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
