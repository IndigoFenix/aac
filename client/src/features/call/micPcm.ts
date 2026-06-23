// Capture mono LINEAR16 PCM from a MediaStream's audio and hand it to a callback
// as base64 chunks at the AudioContext's native sample rate — the server tells
// Google Cloud STT that rate, so we do NOT resample on the client (crude
// client-side downsampling aliases and wrecks speech recognition). Used to
// transcribe the clinician's speech in-region (the browser's Web Speech API
// would route audio through Google's consumer service, out of the platform's
// GCP/BAA region — not acceptable for clinical audio).
//
// Uses ScriptProcessorNode: deprecated but universally available and adequate
// for one-direction speech capture; a muted sink keeps it running without
// echoing the mic to the speakers.

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
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sampleRate = Math.round(ctx.sampleRate);

  // A muted gain sink so the processor runs without playing the mic aloud.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

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

  return () => {
    try { processor.onaudioprocess = null; } catch { /* ignore */ }
    try { processor.disconnect(); } catch { /* ignore */ }
    try { source.disconnect(); } catch { /* ignore */ }
    try { sink.disconnect(); } catch { /* ignore */ }
    try { void ctx.close(); } catch { /* ignore */ }
  };
}
