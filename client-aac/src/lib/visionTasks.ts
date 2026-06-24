// client-aac/src/lib/visionTasks.ts
//
// Single source of truth for creating a MediaPipe Tasks-Vision landmarker and
// turning its result into a PLAIN, structured-cloneable object. Shared by BOTH
// the off-thread worker (workers/vision.worker.ts) and the main-thread FALLBACK
// (lib/visionWorkerClient.ts), so the loader config + result shape are identical
// no matter where inference runs — that's what lets the worker path degrade to
// the main thread with no behavioural change.
//
// `detect()` returns the SAME projected shape on both paths, so the hooks' result
// mapping is untouched (it just reads `.landmarks` / `.gestures` / `.blendshapes`).

export type VisionTaskKind = "pose" | "hand" | "face";

export interface VisionTaskOptions {
  /** numPoses / numHands / numFaces. */
  numEntities: number;
  /** Hand only: optional custom sign-language gesture model. */
  signLanguageModelUrl?: string | null;
}

/** Minimal projected results — plain objects (no class instances / typed arrays),
 *  safe to postMessage and identical to what the hooks already consume. */
export interface VisionLandmarker {
  detect(image: CanvasImageSource | ImageBitmap, timestampMs: number): any;
  close(): void;
}

// Pinned to match the previous per-hook loaders exactly (don't drift the wasm /
// model versions without re-testing all three trackers).
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const MODEL_URLS: Record<VisionTaskKind, string> = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  hand: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

function buildOptions(kind: VisionTaskKind, opts: VisionTaskOptions, delegate: "GPU" | "CPU"): any {
  const baseOptions = { modelAssetPath: MODEL_URLS[kind], delegate };
  if (kind === "pose") {
    return { baseOptions, runningMode: "VIDEO", numPoses: opts.numEntities, outputSegmentationMasks: false };
  }
  if (kind === "face") {
    return {
      baseOptions,
      runningMode: "VIDEO",
      numFaces: opts.numEntities,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    };
  }
  // hand
  const handOpts: any = { baseOptions, runningMode: "VIDEO", numHands: opts.numEntities };
  if (opts.signLanguageModelUrl) {
    handOpts.customGesturesClassifierOptions = { modelAssetPath: opts.signLanguageModelUrl };
  }
  return handOpts;
}

/** Reduce a raw MediaPipe result to the plain fields the hooks read. */
function projectRawResult(kind: VisionTaskKind, results: any): any {
  if (!results) return null;
  if (kind === "pose") {
    return {
      landmarks: (results.landmarks ?? []).map((set: any[]) =>
        set.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))),
    };
  }
  if (kind === "hand") {
    const cats = (sets: any[]) => (sets ?? []).map((set: any[]) => set.map((c) => ({ categoryName: c.categoryName, score: c.score })));
    return {
      landmarks: (results.landmarks ?? []).map((set: any[]) => set.map((p) => ({ x: p.x, y: p.y, z: p.z }))),
      handedness: cats(results.handedness),
      gestures: cats(results.gestures),
    };
  }
  // face
  return {
    faceLandmarks: (results.faceLandmarks ?? []).map((set: any[]) => set.map((p) => ({ x: p.x, y: p.y, z: p.z }))),
    faceBlendshapes: (results.faceBlendshapes ?? []).map((cl: any) => ({
      categories: (cl.categories ?? []).map((c: any) => ({ categoryName: c.categoryName, score: c.score })),
    })),
  };
}

/**
 * Load a MediaPipe task (GPU delegate, CPU fallback — same as the old per-hook
 * loaders). Returns a thin wrapper whose `detect` already projects to the plain
 * result shape. Runs in either the worker or the main thread.
 */
export async function createVisionLandmarker(kind: VisionTaskKind, opts: VisionTaskOptions): Promise<VisionLandmarker> {
  const vision = await import("@mediapipe/tasks-vision");
  const { FilesetResolver, PoseLandmarker, GestureRecognizer, FaceLandmarker } = vision;
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

  const instantiate = async (delegate: "GPU" | "CPU") => {
    const options = buildOptions(kind, opts, delegate);
    if (kind === "pose") return PoseLandmarker.createFromOptions(fileset, options);
    if (kind === "face") return FaceLandmarker.createFromOptions(fileset, options);
    return GestureRecognizer.createFromOptions(fileset, options);
  };

  let inst: any;
  try {
    inst = await instantiate("GPU");
  } catch (gpuErr) {
    console.warn(`[Vision:${kind}] GPU delegate failed, falling back to CPU:`, gpuErr);
    inst = await instantiate("CPU");
  }

  // GestureRecognizer exposes recognizeForVideo; the landmarkers use detectForVideo.
  const run = kind === "hand"
    ? (image: any, ts: number) => inst.recognizeForVideo(image, ts)
    : (image: any, ts: number) => inst.detectForVideo(image, ts);

  return {
    detect: (image, ts) => projectRawResult(kind, run(image, ts)),
    close: () => { try { inst.close(); } catch { /* ignore */ } },
  };
}
