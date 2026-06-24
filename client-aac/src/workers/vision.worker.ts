// client-aac/src/workers/vision.worker.ts
//
// Off-main-thread MediaPipe inference. The main thread grabs a camera frame as an
// ImageBitmap and transfers it here; we run the requested landmarker on it and
// post back a plain result. This moves the heavy detect + GPU readback OFF the
// main thread, so it no longer stalls requestAnimationFrame (the cause of the
// choppy 3D render on the AAC). Loaded only for the trackers that opt in (pose,
// hand); face stays main-thread because it feeds the latency-sensitive gaze path.
//
// All failures are reported to the client, which then falls back to running the
// same task on the main thread — so a worker that can't spawn/load on a given
// device degrades to the old behaviour rather than breaking the tracker.
//
/// <reference lib="webworker" />

import { createVisionLandmarker, type VisionLandmarker, type VisionTaskKind, type VisionTaskOptions } from "../lib/visionTasks";

type InMessage =
  | { type: "load"; id: number; kind: VisionTaskKind; options: VisionTaskOptions }
  | { type: "detect"; id: number; kind: VisionTaskKind; frame: ImageBitmap; timestamp: number }
  | { type: "close"; kind: VisionTaskKind };

const post = (msg: unknown) => (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);

const tasks = new Map<VisionTaskKind, VisionLandmarker>();

globalThis.addEventListener("message", async (event: MessageEvent<InMessage>) => {
  const msg = event.data;

  if (msg.type === "load") {
    try {
      // Re-loading (e.g. a sign-language model change) replaces the old instance.
      const existing = tasks.get(msg.kind);
      if (existing) existing.close();
      const lm = await createVisionLandmarker(msg.kind, msg.options);
      tasks.set(msg.kind, lm);
      post({ type: "load-result", id: msg.id, ok: true });
    } catch (err) {
      post({ type: "load-result", id: msg.id, ok: false, error: String(err) });
    }
    return;
  }

  if (msg.type === "detect") {
    const lm = tasks.get(msg.kind);
    try {
      if (!lm) throw new Error(`vision task '${msg.kind}' not loaded`);
      const result = lm.detect(msg.frame, msg.timestamp);
      post({ type: "detect-result", id: msg.id, ok: true, result });
    } catch (err) {
      post({ type: "detect-result", id: msg.id, ok: false, error: String(err) });
    } finally {
      // Always release the transferred frame, success or not.
      try { msg.frame.close(); } catch { /* ignore */ }
    }
    return;
  }

  if (msg.type === "close") {
    const lm = tasks.get(msg.kind);
    if (lm) { lm.close(); tasks.delete(msg.kind); }
  }
});
