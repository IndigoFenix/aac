// client-aac/src/lib/modelLoader.ts
//
// Shared loader for on-device ML models (Silero VAD, MediaPipe landmarkers…).
// Every model used to hand-roll the same lazy singleton — and every one of
// them cached the FIRST failure for the lifetime of the page, so one flaky
// network moment (or missing asset) at startup silently disabled that
// capability for the whole session. Field symptoms: speech detection stuck on
// the energy fallback, FaceMirror "randomly" blank.
//
// This loader instead:
//  - retries failed loads on a capped backoff schedule, indefinitely. Models
//    are static assets: failures are either transient (network — a retry
//    fixes it) or permanent (broken build — the once-a-minute retry costs one
//    failed fetch while keeping the error visible in the console).
//  - resolves get() only on success, so "await get(); attach" call sites pick
//    the model up mid-session when a late retry lands.
//  - exposes per-model status + change subscription for UI/debug surfaces.
//
// Loaders are created lazily by their model modules; call preload() (see
// preloadModels.ts, run at app startup) so downloads/compilation overlap with
// session initialization instead of starting at first use.

export type ModelLoadState = "idle" | "loading" | "error" | "ready";

export interface ModelLoaderStatus {
  name: string;
  state: ModelLoadState;
  /** Load attempts so far, including the successful one. */
  attempts: number;
  lastError: string | null;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Backoff before retry number `attempt` (0-based), capped at 60s. Exported
 *  for call sites that manage their own retry loop (visionWorkerClient). */
export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export interface ModelLoader<T> {
  /** Start loading now (idempotent, non-blocking). */
  preload(): void;
  /** Resolves with the model once it (eventually) loads. Never rejects —
   *  failures retry on the backoff schedule until a load lands. */
  get(): Promise<T>;
  /** The model if it is ready right now, else null. */
  tryGet(): T | null;
  status(): ModelLoaderStatus;
  /** Notify on every state change (also fires immediately with the current
   *  status). Returns an unsubscribe function. */
  subscribe(cb: (status: ModelLoaderStatus) => void): () => void;
}

const registry: ModelLoader<unknown>[] = [];

/** Statuses of every model loader created so far, for debug surfaces. */
export function modelLoaderStatuses(): ModelLoaderStatus[] {
  return registry.map((l) => l.status());
}

export function createModelLoader<T>(name: string, load: () => Promise<T>): ModelLoader<T> {
  let state: ModelLoadState = "idle";
  let attempts = 0;
  let lastError: string | null = null;
  let instance: T | null = null;
  let started = false;
  let waiters: Array<(m: T) => void> = [];
  const subscribers = new Set<(status: ModelLoaderStatus) => void>();

  const status = (): ModelLoaderStatus => ({ name, state, attempts, lastError });

  const notify = () => {
    for (const cb of subscribers) {
      try { cb(status()); } catch { /* subscriber's problem */ }
    }
  };

  const attemptOnce = async (): Promise<void> => {
    state = "loading";
    attempts++;
    notify();
    try {
      instance = await load();
      state = "ready";
      lastError = null;
      console.log(`[Model:${name}] ready (attempt ${attempts})`);
      const w = waiters;
      waiters = [];
      for (const resolve of w) resolve(instance);
      notify();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      state = "error";
      const delay = retryDelayMs(attempts - 1);
      console.warn(`[Model:${name}] load attempt ${attempts} failed (retry in ${Math.round(delay / 1000)}s):`, err);
      notify();
      setTimeout(() => { void attemptOnce(); }, delay);
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    void attemptOnce();
  };

  const loader: ModelLoader<T> = {
    preload: start,
    get: () => {
      if (instance) return Promise.resolve(instance);
      start();
      return new Promise<T>((resolve) => waiters.push(resolve));
    },
    tryGet: () => instance,
    status,
    subscribe: (cb) => {
      subscribers.add(cb);
      try { cb(status()); } catch { /* subscriber's problem */ }
      return () => subscribers.delete(cb);
    },
  };
  registry.push(loader as ModelLoader<unknown>);
  return loader;
}
