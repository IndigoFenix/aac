// Subscribes to the host's update lifecycle and returns the current status
// plus an `installNow` trigger, so the UI can show a "downloading update… X%"
// indicator and a "restart to apply" prompt.
//
// Host-agnostic by design: which mechanism sits behind this — the Electron
// installer swap (electron/auto-update.ts) or the Capacitor OTA bundle swap —
// is resolved by `getUpdateProvider()`. Where no provider exists (web build,
// and the iPad build until OTA lands) the status stays idle forever and the
// UI renders nothing.

import { useEffect, useState } from "react";
import { getUpdateProvider, type UpdateStatus } from "@/lib/platform";

// Re-exported for existing importers; the union itself now lives in
// lib/platform/update-status.ts, which electron/auto-update.ts mirrors.
export type { UpdateStatus };

export function useAppUpdate(): { status: UpdateStatus; installNow: () => void } {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });

  useEffect(() => {
    const provider = getUpdateProvider();
    if (!provider) return;
    let alive = true;
    // Seed with the last-known status (the updater may already be mid-download
    // by the time this mounts), then subscribe to live transitions.
    provider.getStatus().then(s => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = provider.onStatus(s => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

  const installNow = () => { void getUpdateProvider()?.installNow(); };
  return { status, installNow };
}
