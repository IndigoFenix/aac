// client-aac/src/hooks/useGazeSidecar.ts
// Drives the gaze sidecar for DLL-based eye trackers (e.g. Tobii).
//
// When the student's settings select such a tracker, this asks the native
// shell to detect the vendor DLL and spawn a bitness-matched sidecar that
// serves gaze over a localhost WebSocket on an OS-assigned port (reported back
// as status.port; the EyeGazeService's Tobii provider discovers it from there).
// If no DLL is found, `status.needsDll` becomes true
// so the UI can offer to locate it manually. Until a gaze provider connects,
// the EyeGazeService already falls back to the mouse provider — no extra
// handling needed here.
//
// Only hosts with `capabilities().gazeSidecar` can do this: spawning a native
// child process is Electron/Windows-only. On the iPad build and the web build
// this hook is a no-op and `supported` is false, so the settings UI can hide
// the DLL controls rather than offer a button that cannot work.

import { useCallback, useEffect, useRef, useState } from "react";
import { capabilities, getGazeBridge, type GazeSidecarStatus } from "@/lib/platform";

export type { GazeSidecarStatus };

const POLL_INTERVAL_MS = 4000;

export function useGazeSidecar({ enabled, device }: { enabled: boolean | null; device: string | null }) {
  const [status, setStatus] = useState<GazeSidecarStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported = capabilities().gazeSidecar;

  useEffect(() => {
    const api = getGazeBridge();
    if (!api) return; // no sidecar host — mouse/touch fallback handles everything

    // `null` means the student's settings have not arrived yet — NOT that eye
    // tracking is off. Those were indistinguishable before, and since the
    // settings state defaults to disabled before it loads, every mount and
    // every profile reload issued a stop() that killed a healthy, connected
    // sidecar. The restart then came back on a fresh OS-assigned port, and the
    // detection loop had to win that race all over again. Do nothing until we
    // actually know.
    if (enabled === null) return;

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
    const api = getGazeBridge();
    if (!api || !device) return;
    const s = await api.locateDll(device);
    setStatus(s);
  }, [device]);

  const openLog = useCallback(async () => {
    await getGazeBridge()?.openLog();
  }, []);

  return { status, locateDll, openLog, supported };
}
