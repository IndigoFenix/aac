// A small, unobtrusive auto-update indicator for the AAC startup screens. While
// a new version downloads it shows "Downloading update… X%" plus a keep-open
// hint (the differential download restarts from scratch if the app is closed
// mid-download — see electron/auto-update.ts). Once downloaded it offers a
// "Install and restart" button that applies the update — the installer relaunches
// the app itself, which the hint under the button says out loud. Renders nothing
// on the web build (no Electron updater) or when idle.

import { useAppUpdate } from "@/hooks/useAppUpdate";
import { useLanguage } from "@/contexts/LanguageContext";

export default function UpdateStatusIndicator() {
  const { status, installNow } = useAppUpdate();
  const { t } = useLanguage();

  // "available" is the brief window after a version is found but before the
  // first download-progress event lands — treat it as a 0% download.
  const isDownloading = status.kind === "downloading" || status.kind === "available";
  const isReady = status.kind === "downloaded";

  if (!isDownloading && !isReady) return null;

  const percent =
    status.kind === "downloading" ? Math.min(100, Math.max(0, Math.round(status.percent))) : 0;

  // z-[60], not z-50: the login screen is a Radix dialog, whose overlay is
  // portaled to <body> at z-50 — later in the DOM, so an equal z-index loses
  // and the indicator disappeared behind the scrim on the one screen it is
  // most likely to be seen on. Stays below the toast/device-gate layer (100).
  return (
    <div className="fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <div className="pointer-events-none flex flex-col items-center gap-1.5 rounded-full bg-white/85 px-4 py-2 text-center shadow-sm ring-1 ring-gray-200 backdrop-blur dark:bg-gray-800/85 dark:ring-gray-700">
        {isDownloading ? (
          <>
            <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
              {t("app.updateDownloading")} {percent}%
            </p>
            <div className="h-1 w-48 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-[10px] leading-none text-gray-400 dark:text-gray-500">
              {t("app.updateKeepOpen")}
            </p>
          </>
        ) : (
          <>
            <div className="pointer-events-auto flex items-center gap-3">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                {t("app.updateReady")}
              </span>
              <button
                type="button"
                onClick={installNow}
                className="rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
              >
                {t("app.updateRestart")}
              </button>
            </div>
            {/* The install genuinely does relaunch on its own (quitAndInstall is
                called with isForceRunAfter, and the single-instance lock retries
                so the relaunch can overlap the outgoing process) — but from the
                caretaker's side the app just vanishes for a few seconds, which
                reads as a crash. Say what is about to happen. */}
            <p className="text-[10px] leading-none text-gray-400 dark:text-gray-500">
              {t("app.updateRestartHint")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
