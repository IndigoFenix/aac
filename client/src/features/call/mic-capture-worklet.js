// client/src/features/call/mic-capture-worklet.js
//
// Mic capture on the AUDIO RENDERING THREAD, for the clinician's call STT.
//
// WHY A WORKLET AND NOT ScriptProcessorNode. `onaudioprocess` is dispatched on
// the MAIN thread, which Chrome throttles to roughly one task per second while
// its tab is in the background — and a ScriptProcessorNode buffer the main
// thread fails to service in time is DROPPED, not queued. Measured on a real
// call (server/live-session-debug.log, 2026-08-26): delivery collapsed from
// 11.7 chunks/s to 1.16 chunks/s the moment the clinician window lost focus,
// Google STT answered "Audio Timeout Error: Long duration elapsed without
// audio", killed the stream, and the clinician stopped reaching the student's
// board until the window came back — about 30 seconds later.
//
// A worklet's `process()` runs on the real-time audio thread and is never
// throttled by tab visibility. Its messages queue on the port, so a throttled
// main thread delays delivery in bursts instead of losing samples.
//
// Emits Int16 (LINEAR16) at the context's native rate, transferred rather than
// copied. The main thread only base64-encodes and sends.

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Samples per emitted chunk. 4096 @ 48kHz ≈ 85ms — matches what the old
    // ScriptProcessorNode path produced, so the server sees the same cadence.
    this.frameSize = options?.processorOptions?.frameSize ?? 4096;
    this.buf = new Int16Array(this.frameSize);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input yet (or the track ended) — stay alive; the node is torn down
    // explicitly by the host, never by returning false here.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i] || 0;
      // Float32 [-1,1] -> Int16, clamped.
      this.buf[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
      if (this.n === this.frameSize) {
        const chunk = this.buf.slice(0);
        this.port.postMessage(chunk.buffer, [chunk.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
