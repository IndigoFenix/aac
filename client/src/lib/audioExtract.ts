// client/src/lib/audioExtract.ts
//
// Extract a compact, transcription-ready audio file from a video on the client.
// Google Cloud STT wants LINEAR16 (16-bit PCM) and bills/uploads by size, so we
// decode the media's audio, downmix to mono, and resample to 16 kHz — the
// canonical STT input — then wrap it as a WAV blob. Doing this client-side keeps
// the upload tiny (~1.9 MB/min) instead of shipping the whole video.
//
// Uses WebAudio (decodeAudioData + OfflineAudioContext), which is broadly
// supported (unlike the WebCodecs export path), so transcription works even
// where MP4 export doesn't.

/** Target sample rate for STT (Google STT works well at 16 kHz). */
export const STT_SAMPLE_RATE = 16000;

export class AudioExtractError extends Error {}

/** Encode a mono Float32 PCM channel as a 16-bit LINEAR16 WAV blob. */
function encodeWavMono16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2; // 16-bit
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true); // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  // PCM samples, clamped to [-1, 1] then scaled to int16.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export interface ExtractWavOptions {
  /** Reject media longer than this (full-transcription guard). Default 540s. */
  maxSeconds?: number;
  /**
   * Only render the first N seconds (e.g. a language-detection sample). When
   * set, the `maxSeconds` length guard is skipped — we just take the prefix,
   * so long videos can still be sampled cheaply.
   */
  clipSeconds?: number;
}

/**
 * Decode a video/audio File and return its audio as a mono 16 kHz WAV Blob.
 * Throws AudioExtractError if the media has no decodable audio or (without
 * `clipSeconds`) exceeds `maxSeconds`.
 */
export async function extractWavMono16k(
  file: File,
  opts: ExtractWavOptions = {},
): Promise<{ blob: Blob; durationSec: number }> {
  // ~1.92 MB/min at 16 kHz mono 16-bit; 9 min ≈ 17 MB, under the 20 MB upload
  // limit. The server chunks internally, so length isn't bound by STT's 60s cap.
  const maxSeconds = opts.maxSeconds ?? 540;
  const AudioCtx: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx || typeof OfflineAudioContext === "undefined") {
    throw new AudioExtractError("This browser can't extract audio for transcription.");
  }

  const arrayBuffer = await file.arrayBuffer();

  // Decode the media's audio track at its native rate.
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new AudioExtractError("Couldn't find decodable audio in this video.");
  } finally {
    void decodeCtx.close();
  }

  // How much to render: a short prefix for sampling, else the whole thing
  // (guarded by maxSeconds).
  const targetSec = opts.clipSeconds
    ? Math.min(decoded.duration, opts.clipSeconds)
    : decoded.duration;

  if (!opts.clipSeconds && decoded.duration > maxSeconds) {
    throw new AudioExtractError(
      `Video is too long to transcribe (${Math.round(decoded.duration)}s; limit ${maxSeconds}s).`,
    );
  }

  // Downmix to mono + resample to 16 kHz via an offline render of the target span.
  const frameCount = Math.max(1, Math.ceil(targetSec * STT_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frameCount, STT_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0, 0, targetSec); // render only [0, targetSec)
  const rendered = await offline.startRendering();

  const blob = encodeWavMono16(rendered.getChannelData(0), STT_SAMPLE_RATE);
  return { blob, durationSec: targetSec };
}
