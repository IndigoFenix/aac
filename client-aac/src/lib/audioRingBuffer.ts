/**
 * audioRingBuffer.ts
 *
 * PCM audio ring buffer that continuously stores microphone samples
 * and allows extraction of arbitrary time ranges as WAV blobs.
 *
 * - Circular Float32Array (30s at 16kHz = ~1.9MB)
 * - Downsamples from native rate (typically 48kHz) to 16kHz on ingest
 * - Wall-clock to sample mapping via startWallTime + totalSamplesWritten
 * - extractWav(startMs, endMs) -> WAV Blob or null if range expired
 * - extractRecentWav(durationMs) -> last N ms as WAV
 */

const TARGET_SAMPLE_RATE = 16000;
const BUFFER_DURATION_S = 30;
const BUFFER_SIZE = TARGET_SAMPLE_RATE * BUFFER_DURATION_S; // 480,000 samples

/** Callback for streaming raw PCM chunks (base64-encoded Int16 at 16kHz) */
export type PcmChunkCallback = (int16Base64: string) => void;

export class AudioRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private totalSamplesWritten = 0;
  private startWallTime = 0;
  private processorNode: ScriptProcessorNode | null = null;
  private nativeSampleRate: number;
  private destroyed = false;

  /** Optional callback for real-time PCM streaming (e.g., to Gemini Live API) */
  private onPcmChunk: PcmChunkCallback | null = null;

  constructor(nativeSampleRate: number) {
    this.buffer = new Float32Array(BUFFER_SIZE);
    this.nativeSampleRate = nativeSampleRate;
    this.startWallTime = Date.now();
  }

  /**
   * Set a callback to receive real-time PCM chunks as base64-encoded Int16 data.
   * Each chunk is 16kHz mono Int16 PCM — suitable for Gemini Live API's
   * `audio/pcm;rate=16000` format.
   */
  setStreamCallback(callback: PcmChunkCallback | null): void {
    this.onPcmChunk = callback;
  }

  /**
   * Connect to an AudioContext source node to start capturing audio.
   * Uses ScriptProcessorNode to intercept PCM samples.
   */
  connect(audioCtx: AudioContext, sourceNode: MediaStreamAudioSourceNode): void {
    // Resume AudioContext if suspended (Chrome autoplay policy)
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    // ScriptProcessorNode with buffer size 4096, mono input, mono output
    this.processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    this.nativeSampleRate = audioCtx.sampleRate;

    let callbackCount = 0;
    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (this.destroyed) return;
      const inputData = event.inputBuffer.getChannelData(0);
      this.ingestSamples(inputData);

      // Log first few callbacks + periodic updates to confirm data flow
      callbackCount++;
      if (callbackCount === 1) {
        console.log(`[AudioRingBuffer] First onaudioprocess callback! inputLength=${inputData.length}, sampleRate=${this.nativeSampleRate}`);
      } else if (callbackCount === 10) {
        console.log(`[AudioRingBuffer] 10 callbacks received, totalSamples=${this.totalSamplesWritten}`);
      } else if (callbackCount % 100 === 0) {
        console.log(`[AudioRingBuffer] ${callbackCount} callbacks, totalSamples=${this.totalSamplesWritten}, bufferSeconds=${(this.totalSamplesWritten / TARGET_SAMPLE_RATE).toFixed(1)}s`);
      }
    };

    // Connect: source -> processor -> destination (must connect to destination for processing to work)
    sourceNode.connect(this.processorNode);
    this.processorNode.connect(audioCtx.destination);

    console.log(`[AudioRingBuffer] Connected: nativeSampleRate=${this.nativeSampleRate}, bufferSize=${BUFFER_SIZE}, audioCtxState=${audioCtx.state}`);
  }

  /**
   * Downsample and write PCM samples into the ring buffer.
   * Also streams Int16 PCM chunks via the onPcmChunk callback if set.
   */
  private ingestSamples(input: Float32Array): void {
    const ratio = this.nativeSampleRate / TARGET_SAMPLE_RATE;

    if (this.totalSamplesWritten === 0) {
      this.startWallTime = Date.now();
    }

    // Simple linear interpolation downsampling
    const outputLength = Math.floor(input.length / ratio);

    // If streaming callback is set, also produce Int16 PCM for real-time streaming
    let int16Buffer: Int16Array | null = null;
    if (this.onPcmChunk) {
      int16Buffer = new Int16Array(outputLength);
    }

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const frac = srcIndex - srcIndexFloor;
      const sample = input[srcIndexFloor] * (1 - frac) + input[srcIndexCeil] * frac;

      this.buffer[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % BUFFER_SIZE;
      this.totalSamplesWritten++;

      // Convert Float32 [-1,1] to Int16 [-32768, 32767] for streaming
      if (int16Buffer) {
        const clamped = Math.max(-1, Math.min(1, sample));
        int16Buffer[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      }
    }

    // Fire streaming callback with base64-encoded Int16 PCM
    if (int16Buffer && this.onPcmChunk) {
      const bytes = new Uint8Array(int16Buffer.buffer);
      // Convert to base64
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.onPcmChunk(btoa(binary));
    }
  }

  /**
   * Convert wall-clock timestamp (ms) to a sample index in the ring buffer.
   * Returns null if the timestamp is outside the buffered range.
   */
  private wallTimeToSampleIndex(timeMs: number): number | null {
    const elapsedMs = timeMs - this.startWallTime;
    const sampleOffset = Math.floor((elapsedMs / 1000) * TARGET_SAMPLE_RATE);

    // Check if this sample is still in the buffer
    const oldestSample = this.totalSamplesWritten - BUFFER_SIZE;
    if (sampleOffset < oldestSample || sampleOffset > this.totalSamplesWritten) {
      return null;
    }

    // Convert absolute sample offset to ring buffer index
    return sampleOffset % BUFFER_SIZE;
  }

  /**
   * Extract a time range as a WAV Blob.
   * Returns null if the range has been overwritten.
   *
   * @param startMs Wall-clock start time (ms since epoch)
   * @param endMs Wall-clock end time (ms since epoch)
   */
  extractWav(startMs: number, endMs: number): Blob | null {
    if (this.totalSamplesWritten === 0) {
      console.warn(`[AudioRingBuffer] extractWav: no samples written yet`);
      return null;
    }

    const startIdx = this.wallTimeToSampleIndex(startMs);
    const endIdx = this.wallTimeToSampleIndex(endMs);

    if (startIdx === null || endIdx === null) return null;

    // Calculate number of samples to extract
    const elapsedMs = endMs - startMs;
    const numSamples = Math.floor((elapsedMs / 1000) * TARGET_SAMPLE_RATE);

    if (numSamples <= 0 || numSamples > BUFFER_SIZE) return null;

    // Extract samples from ring buffer
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      samples[i] = this.buffer[(startIdx + i) % BUFFER_SIZE];
    }

    return encodeWav(samples, TARGET_SAMPLE_RATE);
  }

  /**
   * Extract the last N milliseconds as a WAV Blob.
   * Useful for heartbeat triggers.
   *
   * @param durationMs How many milliseconds of recent audio to extract
   */
  extractRecentWav(durationMs: number): Blob | null {
    if (this.totalSamplesWritten === 0) {
      console.warn(`[AudioRingBuffer] extractRecentWav: no samples written yet`);
      return null;
    }

    const numSamples = Math.min(
      Math.floor((durationMs / 1000) * TARGET_SAMPLE_RATE),
      this.totalSamplesWritten,
      BUFFER_SIZE
    );

    if (numSamples <= 0) return null;

    // Read backwards from current write position
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const idx = (this.writeIndex - numSamples + i + BUFFER_SIZE) % BUFFER_SIZE;
      samples[i] = this.buffer[idx];
    }

    return encodeWav(samples, TARGET_SAMPLE_RATE);
  }

  /** Number of samples written so far (for diagnostics). */
  get samplesWritten(): number {
    return this.totalSamplesWritten;
  }

  /**
   * Disconnect and clean up.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.processorNode) {
      try { this.processorNode.disconnect(); } catch { /* ignore */ }
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
  }
}

/**
 * Encode Float32Array PCM samples as a WAV Blob (mono, 16-bit PCM).
 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // Write PCM samples (clamp to 16-bit range)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
