// Capture mono LINEAR16 PCM from a MediaStream's audio and hand it to a callback
// as base64 chunks at the AudioContext's native sample rate — the server tells
// Google Cloud STT that rate, so we do NOT resample on the client (crude
// client-side downsampling aliases and wrecks speech recognition). Used to
// transcribe the clinician's speech in-region (the browser's Web Speech API
// would route audio through Google's consumer service, out of the platform's
// GCP/BAA region — not acceptable for clinical audio).
//
// ── CAPTURE RUNS ON THE AUDIO THREAD ───────────────────────────────────────
// This used ScriptProcessorNode, whose `onaudioprocess` is dispatched on the
// MAIN thread. Chrome throttles a background tab's main thread to roughly one
// task per second, and a ScriptProcessorNode buffer that is not serviced in
// time is DROPPED rather than queued. On a real call
// (server/live-session-debug.log, 2026-08-26) delivery fell from 11.7 chunks/s
// to 1.16 the moment the clinician window lost focus; Google STT replied
// "Audio Timeout Error: Long duration elapsed without audio", killed the
// stream, and the clinician stopped reaching the student's board for ~30s
// until the window was focused again. The clinician's words appeared only when
// they happened to be looking at their own window.
//
// AudioWorklet runs on the real-time audio rendering thread and is not
// throttled by tab visibility; its messages QUEUE on the port, so a throttled
// main thread delays delivery in bursts instead of losing samples. Google
// tolerates bursts — it is the absence of audio that ends a stream.
//
// ScriptProcessorNode remains as a fallback for anything without AudioWorklet.

/** Samples per emitted chunk (≈85ms at 48kHz). */
const FRAME_SIZE = 4096;

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  // Chunk the String.fromCharCode to avoid arg-count limits on large buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Load the capture worklet into a context, once per context. */
let workletModule: WeakMap<AudioContext, Promise<void>> | null = null;
function ensureWorklet(ctx: AudioContext): Promise<void> | null {
  if (!ctx.audioWorklet) return null;
  workletModule ??= new WeakMap();
  let p = workletModule.get(ctx);
  if (!p) {
    // Vite rewrites this to an emitted same-origin asset URL — the pattern the
    // AAC's pcmStreamSink already uses, which survives the Electron/Capacitor
    // CSPs that reject blob: worklets.
    const url = new URL("./mic-capture-worklet.js", import.meta.url).href;
    p = ctx.audioWorklet.addModule(url);
    workletModule.set(ctx, p);
  }
  return p;
}

/**
 * Start streaming native-rate mono LINEAR16 PCM from `stream`'s audio track.
 * `onChunk(base64, sampleRate)` receives each chunk plus the sample rate to
 * report to the recognizer. Returns a stop function that tears down the audio
 * graph. No-op (returns a noop stopper) if the stream has no audio track or Web
 * Audio is unavailable.
 */
export function streamMicPcm(stream: MediaStream, onChunk: (base64: string, sampleRate: number) => void): () => void {
  const AudioCtx: typeof AudioContext | undefined =
    window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx || stream.getAudioTracks().length === 0) return () => {};

  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const sampleRate = Math.round(ctx.sampleRate);

  // A muted gain sink so the graph runs without playing the mic aloud.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  let stopped = false;
  let teardown: () => void = () => {};

  /** Last resort: main-thread capture. Loses audio in a background tab. */
  const startScriptProcessor = () => {
    if (stopped) return;
    console.warn("[micPcm] AudioWorklet unavailable — falling back to ScriptProcessorNode; capture will thin out while this tab is in the background");
    const processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1);
    source.connect(processor);
    processor.connect(sink);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0); // Float32 @ ctx.sampleRate
      if (input.length === 0) return;
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = input[i] || 0;
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
      }
      onChunk(int16ToBase64(pcm), sampleRate);
    };
    teardown = () => {
      try { processor.onaudioprocess = null; } catch { /* ignore */ }
      try { processor.disconnect(); } catch { /* ignore */ }
    };
  };

  const modulePromise = ensureWorklet(ctx);
  if (!modulePromise) {
    startScriptProcessor();
  } else {
    modulePromise.then(() => {
      if (stopped) return;
      const node = new AudioWorkletNode(ctx, "mic-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { frameSize: FRAME_SIZE },
      });
      node.port.onmessage = (e) => {
        onChunk(int16ToBase64(new Int16Array(e.data as ArrayBuffer)), sampleRate);
      };
      source.connect(node);
      node.connect(sink);
      teardown = () => {
        try { node.port.onmessage = null; } catch { /* ignore */ }
        try { node.disconnect(); } catch { /* ignore */ }
      };
    }).catch((err) => {
      console.error("[micPcm] capture worklet failed to load:", err);
      startScriptProcessor();
    });
  }

  return () => {
    stopped = true;
    teardown();
    try { source.disconnect(); } catch { /* ignore */ }
    try { sink.disconnect(); } catch { /* ignore */ }
    try { void ctx.close(); } catch { /* ignore */ }
  };
}
