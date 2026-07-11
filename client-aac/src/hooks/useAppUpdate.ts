// Subscribes to the Electron auto-updater status bridged through the preload
// (`electronAPI.update`, see electron/preload.ts + electron/auto-update.ts).
// Returns the current status plus an `installNow` trigger so the UI can show a
// "downloading update… X%" indicator and a "restart to apply" prompt. On the
// web build (no electronAPI) it stays idle forever and renders nothing.

import { useEffect, useState } from "react";

// Mirrors the UpdateStatus union in electron/auto-update.ts. Keep in sync.
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

interface UpdateApi {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<void>;
  installNow: () => Promise<boolean>;
  onStatus: (cb: (status: UpdateStatus) => void) => () => void;
}

function getUpdateApi(): UpdateApi | null {
  return (window as unknown as { electronAPI?: { update?: UpdateApi } })
    .electronAPI?.update ?? null;
}

export function useAppUpdate(): { status: UpdateStatus; installNow: () => void } {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });

  useEffect(() => {
    const api = getUpdateApi();
    if (!api) return;
    let alive = true;
    // Seed with the last-known status (the updater may already be mid-download
    // by the time this mounts), then subscribe to live transitions.
    api.getStatus().then(s => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = api.onStatus(s => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

  const installNow = () => { void getUpdateApi()?.installNow(); };
  return { status, installNow };
}
