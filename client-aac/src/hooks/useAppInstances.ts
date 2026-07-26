// client-aac/src/hooks/useAppInstances.ts
//
// Watches for a SECOND copy of the app running on the same machine.
//
// This matters because of the eye tracker, not tidiness: each instance runs its
// own gaze sidecar, and the vendor DLL admits a single consumer, so the tracker
// ends up belonging to whichever copy grabbed it first while the other shows a
// dead or flickering gaze cursor. Two auto-updaters also race on the same
// download cache. Neither failure names itself, so we surface the cause.
//
// The single-instance lock in electron/instance-guard.ts prevents NEW duplicates,
// but it cannot bind an older build that is already running, or a second INSTALL
// in a different directory — which is what this reports.
//
// Hosts without the bridge (web, iPad) return null forever and render nothing.

import { useEffect, useState } from "react";
import { getInstancesBridge, type AppInstanceReport } from "@/lib/platform";

/** Re-poll cadence. A duplicate can be started at any time, but it is rare
 *  enough that a slow poll is plenty — the scan reads the OS process table. */
const POLL_INTERVAL_MS = 60_000;

export function useAppInstances(): {
  report: AppInstanceReport | null;
  /** True when at least one OTHER copy of the app is running right now. */
  duplicateRunning: boolean;
  refresh: () => void;
} {
  const [report, setReport] = useState<AppInstanceReport | null>(null);

  useEffect(() => {
    const api = getInstancesBridge();
    if (!api) return;

    let cancelled = false;
    const pull = (refresh: boolean) => {
      api.get(refresh).then((r) => { if (!cancelled && r) setReport(r); }).catch(() => {});
    };

    // The main process pushes its launch-time scan; also pull, in case this
    // mounted after that fired.
    const off = api.onReport((r) => { if (!cancelled) setReport(r); });
    pull(false);
    const timer = setInterval(() => pull(true), POLL_INTERVAL_MS);

    return () => { cancelled = true; off(); clearInterval(timer); };
  }, []);

  return {
    report,
    duplicateRunning: !!report && report.peers.length > 0,
    refresh: () => {
      getInstancesBridge()?.get(true).then((r) => { if (r) setReport(r); }).catch(() => {});
    },
  };
}
