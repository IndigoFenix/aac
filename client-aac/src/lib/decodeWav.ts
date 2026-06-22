// client-aac/src/lib/decodeWav.ts
//
// Shared WAV → Float32 (16 kHz mono) decoding for the browser-run audio models
// (voice-identification embeddings and speech-to-text). Both consume the AAC
// activity monitor's own output (16 kHz mono 16-bit WAV) but parse the header
// generically so they're robust to format drift.

/**
 * Decode a WAV blob into mono Float32 PCM plus its sample rate. Parses the
 * `fmt `/`data` chunks, handles 8/16/32-bit, and downmixes stereo. Returns null
 * on anything unparseable. Never throws.
 */
export async function decodeWavMono(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  try {
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    if (buf.byteLength < 44) return null;
    // "RIFF" .... "WAVE"
    if (view.getUint32(0, false) !== 0x52494646 /*RIFF*/) return null;
    if (view.getUint32(8, false) !== 0x57415645 /*WAVE*/) return null;

    let offset = 12;
    let fmtFound = false;
    let numChannels = 1;
    let sampleRate = 16000;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataLength = 0;

    while (offset + 8 <= buf.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (chunkId === 0x666d7420 /*"fmt "*/) {
        numChannels = view.getUint16(body + 2, true);
        sampleRate = view.getUint32(body + 4, true);
        bitsPerSample = view.getUint16(body + 14, true);
        fmtFound = true;
      } else if (chunkId === 0x64617461 /*"data"*/) {
        dataOffset = body;
        dataLength = chunkSize;
        break; // data is last in our encoder
      }
      // Chunks are word-aligned.
      offset = body + chunkSize + (chunkSize & 1);
    }

    if (!fmtFound || dataOffset < 0) return null;
    const bytesPerSample = bitsPerSample / 8;
    if (bytesPerSample < 1) return null;
    const usableBytes = Math.min(dataLength, buf.byteLength - dataOffset);
    const frameCount = Math.floor(usableBytes / (bytesPerSample * numChannels));
    if (frameCount <= 0) return null;

    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < numChannels; c++) {
        const pos = dataOffset + (i * numChannels + c) * bytesPerSample;
        if (bitsPerSample === 16) {
          acc += view.getInt16(pos, true) / 0x8000;
        } else if (bitsPerSample === 32) {
          acc += view.getInt32(pos, true) / 0x80000000;
        } else if (bitsPerSample === 8) {
          acc += (view.getUint8(pos) - 128) / 128;
        }
      }
      out[i] = acc / numChannels; // downmix to mono
    }
    return { samples: out, sampleRate };
  } catch {
    return null;
  }
}

/** Nearest-neighbour resample to 16 kHz (clips are short; quality is fine for
 *  speaker embedding / ASR, and our own WAVs are already 16 kHz so this is a
 *  no-op). */
export function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  const TARGET = 16000;
  if (sampleRate === TARGET) return samples;
  const ratio = sampleRate / TARGET;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
}
