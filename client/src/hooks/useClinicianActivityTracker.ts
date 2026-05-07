import { useEffect, useRef } from 'react';
import { apiRequest, apiUrl } from '@/lib/queryClient';

const HEARTBEAT_INTERVAL_MS = 15_000;
const ACTIVITY_DEBOUNCE_MS = 1_000;

const ACTIVITY_EVENTS = [
  'mousemove',
  'keydown',
  'scroll',
  'pointerdown',
  'input',
  'focus',
] as const;

interface Options {
  /** When false, no listeners or timers are installed. */
  enabled: boolean;
  /** Currently-scoped student id, if any. Re-read each heartbeat from a ref. */
  studentId: string | null;
  /** Currently-scoped institute id. Re-read each heartbeat from a ref. */
  instituteId: string | null;
}

/**
 * Records clinician activity for the Insurance Bridge module's review-time
 * tracker (CPT 98979 / 98980). Listens for low-fidelity activity signals,
 * debounces to roughly 1 sample/sec, and posts a heartbeat to the server
 * every 15s while activity has occurred since the last heartbeat. Sends a
 * `tab_closed` beacon on `pagehide` / `beforeunload` so an interval gets
 * closed promptly when the clinician walks away.
 *
 * Privacy: only timestamps and the in-scope student/institute ids are sent.
 * No event payloads, mouse coordinates, or input contents leave the page.
 */
export function useClinicianActivityTracker(opts: Options): void {
  const studentIdRef = useRef(opts.studentId);
  const instituteIdRef = useRef(opts.instituteId);
  studentIdRef.current = opts.studentId;
  instituteIdRef.current = opts.instituteId;

  useEffect(() => {
    if (!opts.enabled) return;

    let lastActivityAt = 0;
    let lastHeartbeatSentAt = 0;

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt >= ACTIVITY_DEBOUNCE_MS) {
        lastActivityAt = now;
      }
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true, capture: true });
    }

    const heartbeatInterval = window.setInterval(() => {
      if (lastActivityAt <= lastHeartbeatSentAt) return;
      const now = Date.now();
      lastHeartbeatSentAt = now;
      apiRequest('POST', '/api/insurance/activity/heartbeat', {
        studentId: studentIdRef.current,
        instituteId: instituteIdRef.current,
      }).catch(() => {
        // Heartbeats are best-effort; never surface failures to the user.
      });
    }, HEARTBEAT_INTERVAL_MS);

    const onPageHide = () => {
      try {
        const url = apiUrl('/api/insurance/activity/close');
        const body = new Blob([JSON.stringify({ tabClosed: true })], {
          type: 'application/json',
        });
        navigator.sendBeacon(url, body);
      } catch {
        // sendBeacon can throw on some browsers if the page is being unloaded
        // and we're past the safe window. Nothing we can do — server-side
        // idle cap will close the interval within 60s.
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity, { capture: true } as any);
      }
      window.clearInterval(heartbeatInterval);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
    };
  }, [opts.enabled]);
}
