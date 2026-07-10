// client-aac/src/lib/sileroVad.ts
//
// Silero VAD — a ~2MB neural voice-activity model run on-device via
// onnxruntime-web. Consumes 512-sample frames of 16kHz mono Float32 PCM
// (32ms) and returns a per-frame SPEECH probability 0..1. Unlike the RMS
// energy detector it replaces, it scores "human speech present" rather than
// "loud", so continuous room noise (dishes, fans, music) sits near 0 and
// statement boundaries stay detectable in a noisy room.
//
// Model file: client-aac/public/models/silero/silero_vad.onnx (v5, MIT —
// github.com/snakers4/silero-vad). Loading follows the same posture as the
// wavlm speaker model (useVoiceIdentification): lazy, singleton, and
// failure-tolerant — if the model or runtime can't load, callers get null and
// the activity monitor keeps its energy/WebSpeech fallback.
//
// Runtime notes:
//  - onnxruntime-web is already a dependency (via @huggingface/transformers).
//    Unlike the transformers.js path, its `/wasm` bundle builds the WASM
//    filename dynamically, so Vite never emits the asset — env.wasm.wasmPaths
//    is pinned to the self-hosted copy under `<base>/ort/`, staged from
//    node_modules by scripts/copy-ort-wasm.mjs (wired into the build/dev
//    scripts).
//  - numThreads=1: multithreaded WASM needs SharedArrayBuffer, i.e.
//    cross-origin isolation, which the Electron webview/web mounts don't
//    guarantee. One LSTM step per 32ms frame is ~0.2ms single-threaded.
//  - Inference calls are serialized (the model is stateful across frames) and
//    frames are dropped, not queued, when the runtime falls behind.

/** Samples per VAD frame at 16kHz (Silero's required chunk size). */
export const SILERO_FRAME_SAMPLES = 512;
/** Milliseconds of audio per VAD frame. */
export const SILERO_FRAME_MS = 32;

// Silero v5 prepends 64 samples of context from the previous frame; the ONNX
// graph input is therefore 512 + 64 wide. v4 takes the bare 512 and carries
// h/c LSTM tensors instead of the fused "state". Both are supported —
// detected from the graph's input names at load time.
const V5_CONTEXT_SAMPLES = 64;

type OrtModule = any;
type OrtSession = any;
type OrtTensor = any;

export class SileroVad {
  private ort: OrtModule;
  private session: OrtSession;
  private readonly isV5: boolean;
  // Recurrent state tensors (v5: state[2,1,128]; v4: h/c[2,1,64]).
  private state: OrtTensor | null = null;
  private h: OrtTensor | null = null;
  private c: OrtTensor | null = null;
  private context = new Float32Array(V5_CONTEXT_SAMPLES);
  private readonly srTensor: OrtTensor;
  // Serialization + backpressure: frames are 32ms apart; if inference ever
  // stalls past a few frames, drop instead of queueing into a death spiral.
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private static readonly MAX_PENDING = 8;

  /** Used by loadSileroVad — construct via the singleton loader, not directly. */
  static fromSession(ort: OrtModule, session: OrtSession): SileroVad {
    return new SileroVad(ort, session);
  }

  private constructor(ort: OrtModule, session: OrtSession) {
    this.ort = ort;
    this.session = session;
    this.isV5 = session.inputNames.includes("state");
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
    this.reset();
  }

  /** Zero the recurrent state — call at (re)attach so a previous session's
   *  audio can't bias the first frames. */
  reset(): void {
    if (this.isV5) {
      this.state = new this.ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    } else {
      this.h = new this.ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);
      this.c = new this.ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);
    }
    this.context.fill(0);
  }

  /**
   * Speech probability for one 512-sample 16kHz Float32 frame. Serialized
   * against other calls (stateful model). Resolves null when the frame was
   * dropped for backpressure — callers should simply skip that frame.
   */
  process(frame: Float32Array): Promise<number | null> {
    if (frame.length !== SILERO_FRAME_SAMPLES) {
      return Promise.reject(new Error(`SileroVad: frame must be ${SILERO_FRAME_SAMPLES} samples, got ${frame.length}`));
    }
    if (this.pending >= SileroVad.MAX_PENDING) return Promise.resolve(null);
    this.pending++;
    const run = this.chain.then(() => this.runFrame(frame)).finally(() => { this.pending--; });
    // Keep the chain alive through failures so one bad frame doesn't wedge it.
    this.chain = run.catch(() => {});
    return run;
  }

  private async runFrame(frame: Float32Array): Promise<number> {
    let output: OrtTensor;
    if (this.isV5) {
      const input = new Float32Array(V5_CONTEXT_SAMPLES + SILERO_FRAME_SAMPLES);
      input.set(this.context, 0);
      input.set(frame, V5_CONTEXT_SAMPLES);
      const feeds = {
        input: new this.ort.Tensor("float32", input, [1, input.length]),
        state: this.state,
        sr: this.srTensor,
      };
      const out = await this.session.run(feeds);
      this.state = out.stateN ?? out.state ?? this.state;
      this.context.set(frame.subarray(SILERO_FRAME_SAMPLES - V5_CONTEXT_SAMPLES));
      output = out.output;
    } else {
      const feeds = {
        input: new this.ort.Tensor("float32", frame, [1, frame.length]),
        h: this.h,
        c: this.c,
        sr: this.srTensor,
      };
      const out = await this.session.run(feeds);
      this.h = out.hn ?? this.h;
      this.c = out.cn ?? this.c;
      output = out.output;
    }
    return output.data[0] as number;
  }
}

// =============================================================================
// Singleton loader
// =============================================================================

let vadPromise: Promise<SileroVad | null> | null = null;

function modelUrl(): string {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  return new URL(`${base}models/silero/silero_vad.onnx`, window.location.href).href;
}

/**
 * Load the shared SileroVad instance (one session per app lifetime). Resolves
 * null — and remembers the failure — when the model or runtime is
 * unavailable, so callers can fall back without re-attempting every session.
 */
export function loadSileroVad(): Promise<SileroVad | null> {
  if (vadPromise) return vadPromise;
  vadPromise = (async () => {
    try {
      // Fetch the model ourselves so an SPA index.html fallback (unknown path
      // → 200 text/html) is detected instead of confusing the ONNX parser.
      const res = await fetch(modelUrl(), { cache: "force-cache" });
      if (!res.ok) throw new Error(`model fetch: HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) throw new Error("model fetch returned HTML (SPA fallback)");
      const bytes = new Uint8Array(await res.arrayBuffer());

      // WASM-only build — no webgpu/jsep graph needed for a 2MB LSTM.
      const ort: OrtModule = await import("onnxruntime-web/wasm");
      ort.env.wasm.numThreads = 1;
      const base = (import.meta as any).env?.BASE_URL ?? "/";
      ort.env.wasm.wasmPaths = new URL(`${base}ort/`, window.location.href).href;
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
      });
      const vad = SileroVad.fromSession(ort, session);
      console.log(`[SileroVad] loaded (${session.inputNames.includes("state") ? "v5" : "v4"} graph, ${(bytes.length / 1024).toFixed(0)}KB)`);
      return vad;
    } catch (err) {
      console.warn("[SileroVad] unavailable — speech detection falls back to energy/WebSpeech:", err);
      return null;
    }
  })();
  return vadPromise;
}
