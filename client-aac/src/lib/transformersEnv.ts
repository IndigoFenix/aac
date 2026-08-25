// client-aac/src/lib/transformersEnv.ts
//
// transformers.js decides local-vs-remote weight loading from MUTABLE GLOBALS
// (env.allowLocalModels / env.allowRemoteModels / env.localModelPath) read at
// from_pretrained() time. That was safe while exactly one model in the app used
// transformers.js (the wavlm speaker embedding). It stopped being safe when the
// Kokoro TTS voice arrived: both are loaded through transformers.js, and their
// loads overlap — Kokoro preloads at app startup, wavlm loads lazily on the
// first speech clip.
//
// The failure this prevents is nasty and intermittent: model A sets
// allowRemoteModels=false (it found local weights), model B — staged by a
// different opt-in script, so possibly absent — sets allowRemoteModels=true a
// microtask later, and A's fetch resolves against B's flags. Symptom is a load
// error that vanishes on retry, i.e. exactly the class of bug modelLoader.ts
// was written to paper over rather than have.
//
// So: every transformers.js instantiation goes through withTransformersEnv,
// which serializes them on a module-level promise chain and restores the prior
// flags afterwards. Serialization costs nothing here — these are one-shot loads
// at startup, not a hot path — and it means each caller's flags are the ones
// its own from_pretrained() sees.

export interface TransformersEnvConfig {
  allowLocal: boolean;
  allowRemote: boolean;
  /** Base URL for local weights; only meaningful when allowLocal is true. */
  localModelPath?: string;
}

/** Serializes transformers.js loads so no two of them fight over the env
 *  globals. Never leaves the env dirty: the previous values are restored even
 *  if `fn` throws, so a failed load can't poison the next one. */
let chain: Promise<unknown> = Promise.resolve();

export function withTransformersEnv<T>(
  env: any,
  cfg: TransformersEnvConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const run = chain.then(async () => {
    // No env object (older/mocked builds) — just run; the caller's defaults apply.
    if (!env) return fn();

    const prev = {
      allowLocalModels: env.allowLocalModels,
      allowRemoteModels: env.allowRemoteModels,
      localModelPath: env.localModelPath,
    };
    try {
      env.allowLocalModels = cfg.allowLocal;
      env.allowRemoteModels = cfg.allowRemote;
      if (cfg.localModelPath !== undefined) env.localModelPath = cfg.localModelPath;
      return await fn();
    } finally {
      env.allowLocalModels = prev.allowLocalModels;
      env.allowRemoteModels = prev.allowRemoteModels;
      env.localModelPath = prev.localModelPath;
    }
  });
  // Keep the chain alive regardless of this caller's outcome — one rejected
  // load must not wedge every later one.
  chain = run.catch(() => {});
  return run;
}

/** Base URL the staged on-device models live under (`<base>models/`). Matches
 *  the layout produced by scripts/fetch-*-model.mjs. */
export function localModelBase(): string {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  return new URL(`${base}models/`, window.location.href).href;
}

/** True when `modelId`'s weights are staged locally (packaged build, or a dev
 *  box that ran the opt-in fetch script). False → caller should use the CDN.
 *
 *  A plain `res.ok` check is NOT enough: SPA hosting answers unknown paths with
 *  index.html and a 200, which would falsely report "local" and make
 *  transformers.js try to JSON.parse HTML ("Unexpected token '<'"). So we GET
 *  the config and confirm it really is JSON. */
export async function hasLocalModel(base: string, modelId: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}${modelId}/config.json`, { cache: "no-store" });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) return false; // SPA fallback served index.html
    const text = await res.text();
    return text.trimStart().startsWith("{");
  } catch {
    return false;
  }
}
