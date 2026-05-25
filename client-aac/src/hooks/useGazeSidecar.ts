// client-aac/src/hooks/useGazeSidecar.ts
// Drives the Electron-main gaze sidecar for DLL-based eye trackers (e.g. Tobii).
//
// When the student's settings select such a tracker, this asks the main process
// to detect the vendor DLL and spawn a bitness-matched sidecar that serves gaze
// over ws://localhost:49152 (which the EyeGazeService's WebSocket provider then
// consumes). If no DLL is found, `status.needsDll` becomes true so the UI can
// offer to locate it manually. Until a gaze provider connects, the EyeGazeService
// already falls back to the mouse provider — no extra handling needed here.
//
// In a browser (non-Electron) build there is no sidecar; this hook is a no-op.

import { useCallback, useEffect, useRef, useState } from "react";

export interface GazeSidecarStatus {
  device: string | null;
  dllPath: string | null;
  dllArch: "ia32" | "x64" | "arm64" | "unknown" | null;
  dllFound: boolean;
  running: boolean;
  sidecarCode: string | null;
  sidecarMessage: string | null;
  needsDll: boolean;
  lastError: string | null;
}

interface GazeApi {
  ensure: (device: string) => Promise<GazeSidecarStatus | null>;
  status: () => Promise<GazeSidecarStatus | null>;
  stop: () => Promise<GazeSidecarStatus | null>;
  locateDll: (device: string) => Promise<GazeSidecarStatus | null>;
  setDll: (device: string, dllPath: string) => Promise<GazeSidecarStatus | null>;
  clearDll: (device: string) => Promise<GazeSidecarStatus | null>;
}

function getGazeApi(): GazeApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: { gaze?: GazeApi } }).electronAPI;
  return api?.gaze ?? null;
}

const POLL_INTERVAL_MS = 4000;

export function useGazeSidecar({ enabled, device }: { enabled: boolean; device: string | null }) {
  const [status, setStatus] = useState<GazeSidecarStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const api = getGazeApi();
    if (!api) return; // not Electron — mouse fallback handles everything

    if (!enabled || !device) {
      api.stop().then((s) => setStatus(s)).catch(() => {});
      return;
    }

    let cancelled = false;
    api.ensure(device).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});

    timerRef.current = setInterval(() => {
      api.status().then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [enabled, device]);

  const locateDll = useCallback(async () => {
    const api = getGazeApi();
    if (!api || !device) return;
    const s = await api.locateDll(device);
    setStatus(s);
  }, [device]);

  return { status, locateDll, isElectron: !!getGazeApi() };
}
