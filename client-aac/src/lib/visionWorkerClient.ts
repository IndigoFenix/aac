// client-aac/src/lib/visionWorkerClient.ts
//
// Main-thread coordinator for off-thread MediaPipe inference. Owns ONE shared
// worker (workers/vision.worker.ts) and a landmarker per task kind. A hook
// `acquireVisionTask(kind, opts)` and then calls `handle.detect(video, ts)` each
// frame; the coordinator grabs the frame as an ImageBitmap, ships it to the
// worker, and resolves with a plain result.
//
// ZERO-REGRESSION CONTRACT: if the worker can't spawn or load on a given device
// (Electron/CSP/bundling quirks), or dies mid-session, the task transparently
// falls back to running on the MAIN THREAD via the same createVisionLandmarker —
// identical results, just back to the old (blocking) behaviour. So the worst case
// is "no speedup", never "tracker broken". Frames are dropped (not queued) while a
// detection is in flight, so a slow device can't build a backlog.

import {
  createVisionLandmarker,
  visionAssetSources,
  type VisionLandmarker,
  type VisionTaskKind,
  type VisionTaskOptions,
} from "./visionTasks";
import { retryDelayMs } from "./modelLoader";

export interface VisionTaskHandle {
  /** True once the task has loaded (on either path). */
  isReady(): boolean;
  /** Resolves true when loaded, false if loading failed on both paths. */
  whenReady(): Promise<boolean>;
  /** Run detection on the current video frame. Resolves the plain result, or null
   *  when not ready / busy / the frame couldn't be grabbed. Never rejects. */
  detect(video: HTMLVideoElement, timestampMs: number): Promise<any | null>;
  /** Drop this consumer's reference; tears the task down at zero refs. */
  release(): void;
}

interface TaskState {
  kind: VisionTaskKind;
  options: VisionTaskOptions;
  refs: number;
  path: "worker" | "main" | null;
  ready: boolean;
  loadPromise: Promise<void> | null;
  mainLm: VisionLandmarker | null;
  inFlight: boolean;
  lastTs: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

class VisionEngine {
  private worker: Worker | null = null;
  private workerDead = false;
  private nextReqId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly tasks = new Map<VisionTaskKind, TaskState>();

  // --- Worker lifecycle -----------------------------------------------------

  private getWorker(): Worker | null {
    if (this.workerDead) return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL("../workers/vision.worker.ts", import.meta.url), { type: "module" });
      w.addEventListener("message", (e) => this.onMessage(e.data));
      w.addEventListener("error", (e) => this.killWorker(e?.message ?? "error"));
      w.addEventListener("messageerror", () => this.killWorker("messageerror"));
      this.worker = w;
      return w;
    } catch (err) {
      console.warn("[Vision] worker spawn failed; using main thread:", err);
      this.workerDead = true;
      return null;
    }
  }

  private onMessage(data: any): void {
    if (data?.type !== "load-result" && data?.type !== "detect-result") return;
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.ok) p.resolve(data.type === "detect-result" ? data.result : true);
    else p.reject(new Error(data.error || "vision worker error"));
  }

  /** Worker is unusable — reject in-flight requests and migrate every task to the
   *  main thread so tracking continues. */
  private killWorker(reason: string): void {
    if (this.workerDead) return;
    console.warn(`[Vision] worker failed (${reason}); falling back to main thread`);
    this.workerDead = true;
    for (const p of this.pending.values()) p.reject(new Error("vision worker died"));
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    for (const st of this.tasks.values()) {
      if (st.path === "worker") {
        st.path = null;
        st.ready = false;
        st.loadPromise = null;
        st.mainLm = null;
        void this.switchToMain(st);
      }
    }
  }

  private request(msg: any, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      try {
        this.worker!.postMessage(msg, transfer);
      } catch (err) {
        this.pending.delete(msg.id);
        reject(err);
      }
    });
  }

  // --- Loading --------------------------------------------------------------

  private ensureLoaded(st: TaskState): Promise<void> {
    if (!st.loadPromise) st.loadPromise = this.load(st);
    return st.loadPromise;
  }

  private async load(st: TaskState): Promise<void> {
    // The wasm fileset + model are runtime CDN fetches; retry on a capped
    // backoff instead of letting one flaky moment poison loadPromise (and
    // thus the tracker) for the rest of the session. Stops when the task is
    // released mid-backoff.
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt - 1)));
        if (st.refs === 0) return;
      }
      const worker = this.getWorker();
      if (worker) {
        try {
          const id = this.nextReqId++;
          await this.request({ type: "load", id, kind: st.kind, options: st.options });
          st.path = "worker";
          st.ready = true;
          return;
        } catch (err) {
          console.warn(`[Vision:${st.kind}] worker load failed; main thread:`, err);
          // fall through to the main-thread path
        }
      }
      try {
        await this.loadMain(st);
        return;
      } catch (err) {
        console.warn(`[Vision:${st.kind}] load attempt ${attempt + 1} failed:`, err);
      }
    }
  }

  private async loadMain(st: TaskState): Promise<void> {
    st.mainLm = await createVisionLandmarker(st.kind, st.options);
    st.path = "main";
    st.ready = true;
  }

  private async switchToMain(st: TaskState): Promise<void> {
    if (st.path === "main" && st.mainLm) return;
    for (let attempt = 0; st.refs > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs(attempt - 1)));
      try {
        await this.loadMain(st);
        return;
      } catch (err) {
        console.error(`[Vision:${st.kind}] main-thread fallback load failed (attempt ${attempt + 1}):`, err);
        st.ready = false;
      }
    }
  }

  // --- Detection ------------------------------------------------------------

  private async detect(st: TaskState, video: HTMLVideoElement, ts: number): Promise<any | null> {
    if (!st.ready || st.inFlight) return null;
    if (ts <= st.lastTs) return null; // MediaPipe requires monotonic timestamps
    st.lastTs = ts;
    st.inFlight = true;
    try {
      if (st.path === "worker" && this.worker && !this.workerDead) {
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(video);
        } catch {
          return null; // video momentarily unreadable — skip this frame
        }
        const id = this.nextReqId++;
        try {
          return await this.request({ type: "detect", id, kind: st.kind, frame: bitmap, timestamp: ts }, [bitmap]);
        } catch {
          try { bitmap.close(); } catch { /* already transferred/closed */ }
          await this.switchToMain(st); // worker died mid-flight
          return null;
        }
      }
      if (st.path === "main" && st.mainLm) {
        return st.mainLm.detect(video, ts);
      }
      return null; // path being (re)established
    } finally {
      st.inFlight = false;
    }
  }

  // --- Public handle --------------------------------------------------------

  acquire(kind: VisionTaskKind, options: VisionTaskOptions): VisionTaskHandle {
    let st = this.tasks.get(kind);
    if (!st) {
      // Resolve asset URLs here (main thread) — the worker receives them in
      // the load message and can't compute them itself.
      st = {
        kind, options: { ...options, assetSources: options.assetSources ?? visionAssetSources(kind) },
        refs: 0, path: null, ready: false,
        loadPromise: null, mainLm: null, inFlight: false, lastTs: 0,
      };
      this.tasks.set(kind, st);
    }
    st.refs++;
    void this.ensureLoaded(st).catch(() => { /* surfaced via whenReady */ });
    const state = st;
    return {
      isReady: () => state.ready,
      whenReady: () => this.ensureLoaded(state).then(() => state.ready).catch(() => false),
      detect: (video, ts) => this.detect(state, video, ts),
      release: () => this.release(state),
    };
  }

  private release(st: TaskState): void {
    st.refs = Math.max(0, st.refs - 1);
    if (st.refs > 0) return;
    if (st.path === "worker" && this.worker) {
      try { this.worker.postMessage({ type: "close", kind: st.kind }); } catch { /* ignore */ }
    }
    if (st.mainLm) { st.mainLm.close(); st.mainLm = null; }
    st.ready = false;
    st.path = null;
    st.loadPromise = null;
    this.tasks.delete(st.kind);
  }
}

const engine = new VisionEngine();

/** Acquire a shared MediaPipe task (off-thread when possible, main-thread fallback
 *  otherwise). Release the handle when the consumer unmounts. */
export function acquireVisionTask(kind: VisionTaskKind, options: VisionTaskOptions): VisionTaskHandle {
  return engine.acquire(kind, options);
}
