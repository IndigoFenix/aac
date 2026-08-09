// client-aac/src/lib/pcmStreamSink.ts
//
// Main-thread half of the streaming PCM player. Owns one AudioWorkletNode per
// utterance, converts incoming s16le bytes to Float32 at the AudioContext's
// sample rate, and feeds the worklet's jitter buffer.
//
// Why PCM and not MP3: raw PCM is trivially concatenable. There are no frame
// boundaries, no decoder priming, and no per-chunk decode — so a network chunk
// that lands mid-word is just more samples, not a new audio file. That is what
// makes seamless streaming possible at all (see pcm-player-worklet.js).
//
// Resampling happens HERE, on the main thread, deliberately: the audio thread's
// process() stays a pure memcpy, so a slow resample can never cause a glitch.

/** Raw s16le mono PCM as ElevenLabs' `pcm_*` output formats deliver it. */
export interface PcmStreamOptions {
  /** Sample rate of the incoming PCM (e.g. 24000 for `pcm_24000`). */
  sourceRate: number;
  /** Milliseconds to buffer before playback starts, and after an underrun. */
  prebufferMs?: number;
}

export interface PcmStreamSink {
  /** Feed raw s16le bytes. Safe to call with arbitrary (even odd) lengths. */
  write(bytes: Uint8Array): void;
  /** Signal end of stream; playback finishes once the buffer drains. */
  end(): void;
  /** Drop everything and stop immediately. */
  abort(): void;
  /** Resolves when playback actually finishes (or is aborted). */
  finished: Promise<{ underruns: number }>;
}

// A short buffer is enough to absorb ordinary network jitter without making the
// press feel laggy. This is the single knob that trades latency for smoothness.
// Exported so the stream-health probe simulates the same gate the worklet uses.
export const DEFAULT_PREBUFFER_MS = 120;

let workletModulePromise: Promise<void> | null = null;

/**
 * Load the worklet module into a context, once per context. Resolves false if
 * AudioWorklet is unavailable or the module fails to load — callers then fall
 * back to buffered playback rather than losing the utterance.
 */
export async function ensurePcmWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (!workletModulePromise) {
    // Vite rewrites this to an emitted asset URL — same-origin, so it survives
    // the Electron (app://aac) and Capacitor CSPs that reject blob: worklets.
    const url = new URL("./pcm-player-worklet.js", import.meta.url).href;
    workletModulePromise = ctx.audioWorklet.addModule(url);
  }
  try {
    await workletModulePromise;
    return true;
  } catch (err) {
    console.error("[PcmStreamSink] Worklet module failed to load:", err);
    workletModulePromise = null; // allow a later retry
    return false;
  }
}

/**
 * Linear-interpolation resampler that carries its state ACROSS chunks.
 *
 * The carry matters: resampling each network chunk independently would restart
 * the interpolation at every boundary and reintroduce exactly the seams this
 * whole path exists to remove. `prev` and the fractional cursor `t` make the
 * chunk sequence behave as one continuous signal.
 *
 * The interpolation window spans [prev, ...src], so output lags input by one
 * source sample (~41µs at 24kHz). That delay is constant across the whole
 * stream — inaudible, and crucially not chunk-dependent.
 */
export class Resampler {
  private readonly ratio: number;
  private t = 0;
  private prev = 0;

  constructor(sourceRate: number, targetRate: number) {
    this.ratio = sourceRate / targetRate;
  }

  process(src: Float32Array): Float32Array {
    const n = src.length;
    if (n === 0) return new Float32Array(0);

    // Virtual source is [prev, ...src]; `t` indexes it in source-sample units.
    const count = Math.max(0, Math.ceil((n - this.t) / this.ratio));
    const out = new Float32Array(count);
    let t = this.t;
    for (let k = 0; k < count; k++) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i === 0 ? this.prev : src[i - 1];
      const b = src[i];
      out[k] = a + (b - a) * frac;
      t += this.ratio;
    }
    // Shift the cursor into the next chunk's index space.
    this.t = t - n;
    this.prev = src[n - 1];
    return out;
  }
}

/**
 * Open a streaming PCM sink on `ctx`, connected to `destination`.
 * Returns null when AudioWorklet isn't usable — caller should fall back.
 */
export async function createPcmStreamSink(
  ctx: AudioContext,
  destination: AudioNode,
  options: PcmStreamOptions,
): Promise<PcmStreamSink | null> {
  const ready = await ensurePcmWorklet(ctx);
  if (!ready) return null;

  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { /* autoplay policy — playback may stay silent */ }
  }

  const prebufferMs = options.prebufferMs ?? DEFAULT_PREBUFFER_MS;
  const prebufferFrames = Math.round((prebufferMs / 1000) * ctx.sampleRate);

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, "pcm-sink", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { prebufferFrames },
    });
  } catch (err) {
    console.error("[PcmStreamSink] Failed to construct node:", err);
    return null;
  }

  node.connect(destination);

  const resampler = new Resampler(options.sourceRate, ctx.sampleRate);
  // s16le samples are 2 bytes; a chunk can split one across the boundary.
  let oddByte: number | null = null;
  let closed = false;

  let resolveFinished!: (v: { underruns: number }) => void;
  const finished = new Promise<{ underruns: number }>((resolve) => {
    resolveFinished = resolve;
  });

  const teardown = (underruns: number) => {
    if (closed) return;
    closed = true;
    try { node.disconnect(); } catch { /* already gone */ }
    node.port.onmessage = null;
    resolveFinished({ underruns });
  };

  node.port.onmessage = (event) => {
    if (event.data?.type === "ended") teardown(event.data.underruns ?? 0);
  };

  return {
    write(bytes: Uint8Array) {
      if (closed || bytes.length === 0) return;

      // Re-join a sample split across the previous chunk boundary.
      let view = bytes;
      if (oddByte !== null) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = oddByte;
        joined.set(bytes, 1);
        view = joined;
        oddByte = null;
      }

      const usable = view.length - (view.length % 2);
      if (usable < view.length) oddByte = view[view.length - 1];
      if (usable === 0) return;

      // Copy into an aligned buffer — `view` may start at an odd byte offset
      // within its underlying ArrayBuffer, which Int16Array rejects.
      const aligned = view.slice(0, usable);
      const pcm = new Int16Array(aligned.buffer, aligned.byteOffset, usable / 2);

      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;

      const resampled = resampler.process(floats);
      if (resampled.length === 0) return;
      node.port.postMessage({ type: "push", samples: resampled }, [resampled.buffer]);
    },

    end() {
      if (closed) return;
      node.port.postMessage({ type: "end" });
    },

    abort() {
      if (closed) return;
      node.port.postMessage({ type: "abort" });
      // Don't wait for the worklet's ack — the caller wants silence now.
      teardown(0);
    },

    finished,
  };
}
