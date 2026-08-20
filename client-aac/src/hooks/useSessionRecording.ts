// client-aac/src/hooks/useSessionRecording.ts
//
// React wiring for session recording: read the student's settings, decide
// whether this host can honour them, and hold one SessionRecorder for as long
// as it can. Everything interesting lives in lib/session-recorder — this is the
// lifecycle around it.
//
// The hook is deliberately incurious about WHY a session is happening. It
// starts when there is a camera to record and settings that ask for it, and it
// stops when either goes away. Nothing about it is on the path of a session
// starting: an acquisition failure sets `status.error` and the session carries
// on without a recording, because a promotional-video feature must never be
// able to stop a child from communicating.

import { useEffect, useRef, useState } from "react";
import {
  normalizeSessionRecordingSettings,
  type SessionRecordingSettings,
} from "@shared/aac/session-recording.js";
import { capabilities, getRecordingBridge } from "@/lib/platform";
import { onSessionActivity } from "@/lib/session-activity";
import { SessionRecorder, type RecorderStatus } from "@/lib/session-recorder/recorder";

export interface UseSessionRecordingOptions {
  /** Raw `aacSettings.sessionRecording` for the active student. */
  raw: unknown;
  /** The SHARED camera stream from MultiCameraProvider — never a fresh capture. */
  cameraStream: MediaStream | null;
  studentId: string | null;
  sessionId: string | null;
}

export interface UseSessionRecordingResult {
  status: RecorderStatus;
  /** The resolved settings, for the on-device caretaker view. */
  settings: SessionRecordingSettings;
  /** False on a host that cannot record at all (iPad, browser tab). */
  supported: boolean;
}

const IDLE_STATUS: RecorderStatus = {
  enabled: false, running: false, clipOpen: false,
  folder: null, totalBytes: 0, clipCount: 0, error: null,
};

export function useSessionRecording(
  opts: UseSessionRecordingOptions,
): UseSessionRecordingResult {
  const { raw, cameraStream, studentId, sessionId } = opts;

  const settings = normalizeSessionRecordingSettings(raw);
  const supported = capabilities().sessionRecording && !!getRecordingBridge();
  const [status, setStatus] = useState<RecorderStatus>(IDLE_STATUS);

  // The session id changes while a recorder is alive (reconnects mint a new
  // one), and a clip must not be torn down for that. A ref lets the manifest
  // pick up the current id at close time without the recorder's own lifecycle
  // depending on it.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const cameraStreamRef = useRef(cameraStream);
  cameraStreamRef.current = cameraStream;

  // Only the fields that change what gets recorded belong in the dependency
  // list; re-mounting the encoders is expensive and drops the pre-roll.
  const settingsKey = JSON.stringify(settings);
  const hasCamera = !!cameraStream?.getVideoTracks().length;

  useEffect(() => {
    if (!supported || !settings.enabled || !hasCamera || !studentId) {
      setStatus((prev) => (prev === IDLE_STATUS ? prev : IDLE_STATUS));
      return;
    }
    const bridge = getRecordingBridge();
    if (!bridge) return;

    let disposed = false;
    const recorder = new SessionRecorder({
      settings,
      bridge,
      getCameraStream: () => cameraStreamRef.current,
      studentId,
      getSessionId: () => sessionIdRef.current,
      onStatus: (next) => {
        if (!disposed) setStatus(next);
      },
    });

    const unsubscribe = onSessionActivity(() => recorder.noteActivity());
    void recorder.start();

    return () => {
      disposed = true;
      unsubscribe();
      // Fire-and-forget: teardown finishes the open clip and closes its files,
      // and nothing that unmounts this component can wait for that.
      void recorder.stop();
    };
    // `settings` is captured by value via settingsKey — a settings change is a
    // deliberate restart of the encoders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, settingsKey, hasCamera, studentId]);

  return { status, settings, supported };
}
