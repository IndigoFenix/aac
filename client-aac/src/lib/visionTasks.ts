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

/** One place to load MediaPipe assets from: the wasm fileset base + the .task
 *  model. Tried in order until one loads. */
export interface VisionAssetSource {
  wasmBase: string;
  modelUrl: string;
}

export interface VisionTaskOptions {
  /** numPoses / numHands / numFaces. */
  numEntities: number;
  /** Hand only: optional custom sign-language gesture model. */
  signLanguageModelUrl?: string | null;
  /** Asset sources in preference order (see visionAssetSources). Computed on
   *  the MAIN thread and shipped to the worker inside the load message — the
   *  worker can't resolve them itself (its location is the bundled script URL
   *  under assets/, and in Electron the Vite base is "./"). Defaults to the
   *  CDN when absent. */
  assetSources?: VisionAssetSource[];
}

/** Minimal projected results — plain objects (no class instances / typed arrays),
 *  safe to postMessage and identical to what the hooks already consume. */
export interface VisionLandmarker {
  detect(image: CanvasImageSource | ImageBitmap, timestampMs: number): any;
  close(): void;
}

// CDN FALLBACK ONLY — the primary source is the self-hosted copy staged by
// scripts/prepare-client-models.mjs (same version/URLs; keep in lockstep, and
// don't drift the wasm/model versions without re-testing all three trackers).
const CDN_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const CDN_MODEL_URLS: Record<VisionTaskKind, string> = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  hand: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

// Filenames under public/models/mediapipe/ (staged by prepare-client-models.mjs).
const LOCAL_MODEL_FILES: Record<VisionTaskKind, string> = {
  pose: "pose_landmarker_lite.task",
  hand: "gesture_recognizer.task",
  face: "face_landmarker.task",
};

/**
 * Asset sources in preference order: the self-hosted copy bundled with the
 * app, then the CDN (covers a dev checkout that hasn't staged the assets, or
 * a corrupted install). MAIN THREAD only — resolving Vite's BASE_URL needs
 * the document URL; pass the result to the worker via VisionTaskOptions.
 */
export function visionAssetSources(kind: VisionTaskKind): VisionAssetSource[] {
  const sources: VisionAssetSource[] = [];
  try {
    const base = (import.meta as any).env?.BASE_URL ?? "/";
    const root = new URL(base, window.location.href);
    sources.push({
      wasmBase: new URL("mediapipe/wasm", root).href,
      modelUrl: new URL(`models/mediapipe/${LOCAL_MODEL_FILES[kind]}`, root).href,
    });
  } catch { /* no window (tests) — CDN only */ }
  sources.push({ wasmBase: CDN_WASM_BASE, modelUrl: CDN_MODEL_URLS[kind] });
  return sources;
}

function buildOptions(kind: VisionTaskKind, opts: VisionTaskOptions, delegate: "GPU" | "CPU", modelUrl: string): any {
  const baseOptions = { modelAssetPath: modelUrl, delegate };
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
 * Load a raw MediaPipe task instance, trying each asset source in order
 * (self-hosted first, CDN fallback), with the GPU delegate and a CPU fallback
 * per source. Runs in either the worker or the main thread. Exposed for
 * consumers that want the unprojected instance (useFaceTracking).
 */
export async function createRawVisionTask(kind: VisionTaskKind, opts: VisionTaskOptions): Promise<any> {
  const vision = await import("@mediapipe/tasks-vision");
  const { FilesetResolver, PoseLandmarker, GestureRecognizer, FaceLandmarker } = vision;
  const sources: VisionAssetSource[] = opts.assetSources?.length
    ? opts.assetSources
    : [{ wasmBase: CDN_WASM_BASE, modelUrl: CDN_MODEL_URLS[kind] }];

  let lastErr: unknown;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    try {
      const fileset = await FilesetResolver.forVisionTasks(src.wasmBase);
      const instantiate = async (delegate: "GPU" | "CPU") => {
        const options = buildOptions(kind, opts, delegate, src.modelUrl);
        if (kind === "pose") return PoseLandmarker.createFromOptions(fileset, options);
        if (kind === "face") return FaceLandmarker.createFromOptions(fileset, options);
        return GestureRecognizer.createFromOptions(fileset, options);
      };
      try {
        return await instantiate("GPU");
      } catch (gpuErr) {
        console.warn(`[Vision:${kind}] GPU delegate failed, falling back to CPU:`, gpuErr);
        return await instantiate("CPU");
      }
    } catch (err) {
      lastErr = err;
      if (i < sources.length - 1) {
        console.warn(`[Vision:${kind}] assets from ${src.wasmBase} failed; trying next source:`, err);
      }
    }
  }
  throw lastErr;
}

/**
 * Load a MediaPipe task (see createRawVisionTask for source/delegate
 * fallback). Returns a thin wrapper whose `detect` already projects to the
 * plain result shape.
 */
export async function createVisionLandmarker(kind: VisionTaskKind, opts: VisionTaskOptions): Promise<VisionLandmarker> {
  const inst = await createRawVisionTask(kind, opts);

  // GestureRecognizer exposes recognizeForVideo; the landmarkers use detectForVideo.
  const run = kind === "hand"
    ? (image: any, ts: number) => inst.recognizeForVideo(image, ts)
    : (image: any, ts: number) => inst.detectForVideo(image, ts);

  return {
    detect: (image, ts) => projectRawResult(kind, run(image, ts)),
    close: () => { try { inst.close(); } catch { /* ignore */ } },
  };
}
