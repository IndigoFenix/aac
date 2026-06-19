// client/src/lib/videoExport.ts
//
// Client-side MP4 export for the Video Caption Studio. WebCodecs encodes and
// decodes frames but does NOT (de)mux, so we pair it with mp4box (demux the
// uploaded MP4) and mp4-muxer (write the result):
//
//   input.mp4 ──mp4box──▶ encoded video chunks + track info
//             ──VideoDecoder──▶ VideoFrame
//             ──canvas──▶ frame + glyph overlay composited
//             ──VideoEncoder──▶ encoded chunks
//             ──mp4-muxer──▶ output.mp4
//
// v1 re-encodes VIDEO only. Audio passthrough is added in the next step (the
// muxer + demuxer already expose the hooks for it).

import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample, type Track } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { rasterizeGlyph } from './glyphRaster';
import type { GlyphCue } from './captionParser';

export interface ExportOptions {
  file: File;
  /** Timed glyph cues to burn in (only cues with a non-empty glyph matter). */
  cues: GlyphCue[];
  /** RTL caption language → mirror glyphs. */
  rtl?: boolean;
  /** 0..1 progress callback. */
  onProgress?: (fraction: number) => void;
  /** Abort the export. */
  signal?: AbortSignal;
}

/** True when the browser can run this export (Chrome/Edge today). */
export function isVideoExportSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'VideoEncoder' in window &&
    'VideoDecoder' in window &&
    'VideoFrame' in window &&
    'EncodedVideoChunk' in window &&
    typeof createImageBitmap === 'function'
  );
}

interface AudioPassthrough {
  track: Track;
  samples: Sample[];
  /** mp4-muxer codec key. */
  muxerCodec: 'aac' | 'opus';
  /** AudioSpecificConfig / codec config bytes, if available. */
  description?: Uint8Array;
}

interface DemuxResult {
  video: { track: Track; samples: Sample[]; description: Uint8Array };
  /** Present only when the source has an audio track we can pass through. */
  audio?: AudioPassthrough;
}

/** Write an mp4box codec box (avcC/esds/…) and return its payload bytes. */
function boxPayload(box: any, skipHeaderBytes: number): Uint8Array {
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, skipHeaderBytes, stream.byteLength - skipHeaderBytes);
}

/** Map an mp4box audio codec string to an mp4-muxer codec key, or null. */
function audioMuxerCodec(codec: string): 'aac' | 'opus' | null {
  if (codec.startsWith('mp4a')) return 'aac';
  if (/opus/i.test(codec)) return 'opus';
  return null;
}

/** Extract the AAC AudioSpecificConfig from an mp4a sample entry's esds box. */
function extractAacAsc(audioEntry: any): Uint8Array | undefined {
  try {
    const esd = audioEntry?.esds?.esd; // ES_Descriptor
    if (!esd) return undefined;
    // DecoderConfigDescriptor (tag 0x04) → DecoderSpecificInfo (tag 0x05).
    const dcd = esd.findDescriptor?.(0x04);
    const dsi = dcd?.findDescriptor?.(0x05) ?? esd.findDescriptor?.(0x05);
    const data = dsi?.data;
    return data instanceof Uint8Array && data.length > 0 ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Demux the file into ordered video + (optional) audio samples. */
function demux(file: File): Promise<DemuxResult> {
  return new Promise(async (resolve, reject) => {
    const mp4 = createFile();
    let videoTrack: Track | undefined;
    let audioTrack: Track | undefined;
    // Samples arrive per-track via onSamples; route them by track id.
    const samplesByTrack = new Map<number, Sample[]>();

    mp4.onError = (_mod, msg) => reject(new Error(`mp4box: ${msg}`));

    mp4.onReady = (info) => {
      videoTrack = info.videoTracks[0];
      audioTrack = info.audioTracks[0];
      if (!videoTrack) {
        reject(new Error('No video track found in file.'));
        return;
      }
      samplesByTrack.set(videoTrack.id, []);
      mp4.setExtractionOptions(videoTrack.id, undefined, { nbSamples: Infinity });
      if (audioTrack) {
        samplesByTrack.set(audioTrack.id, []);
        mp4.setExtractionOptions(audioTrack.id, undefined, { nbSamples: Infinity });
      }
      mp4.start();
    };

    mp4.onSamples = (id, _user, s) => {
      const arr = samplesByTrack.get(id);
      if (arr) arr.push(...s);
    };

    try {
      const buf = await file.arrayBuffer();
      const mp4buf = MP4BoxBuffer.fromArrayBuffer(buf, 0);
      mp4.appendBuffer(mp4buf, true);
      mp4.flush();

      if (!videoTrack) {
        reject(new Error('Could not parse the video file.'));
        return;
      }

      const videoSamples = samplesByTrack.get(videoTrack.id) ?? [];
      // VideoDecoder needs the codec description (avcC/hvcC/…), minus its
      // 8-byte box header.
      const vEntry: any = videoSamples[0]?.description;
      const vBox = vEntry?.avcC || vEntry?.hvcC || vEntry?.av1C || vEntry?.vpcC;
      if (!vBox) {
        reject(new Error('Unsupported video codec (no decoder description).'));
        return;
      }
      const result: DemuxResult = {
        video: { track: videoTrack, samples: videoSamples, description: boxPayload(vBox, 8) },
      };

      // Audio is best-effort: pass it through only if it's a codec the muxer
      // accepts. Anything else → silently export video-only.
      if (audioTrack) {
        const muxerCodec = audioMuxerCodec(audioTrack.codec);
        const audioSamples = samplesByTrack.get(audioTrack.id) ?? [];
        if (muxerCodec && audioSamples.length > 0) {
          const description =
            muxerCodec === 'aac' ? extractAacAsc(audioSamples[0]?.description) : undefined;
          result.audio = { track: audioTrack, samples: audioSamples, muxerCodec, description };
        }
      }

      resolve(result);
    } catch (err) {
      reject(err);
    }
  });
}

/** Pick the first H.264 encoder config the platform supports for these dims. */
async function pickEncoderCodec(width: number, height: number): Promise<string> {
  const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.42E01E'];
  for (const codec of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height });
      if (supported) return codec;
    } catch {
      /* try next */
    }
  }
  return 'avc1.42001f';
}

const ensureNotAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
};

/**
 * Export the captioned video as an MP4 Blob. Re-encodes video with the glyph
 * overlays burned in. Throws AbortError if cancelled, or a descriptive Error if
 * the file can't be processed.
 */
export async function exportCaptionedVideo(opts: ExportOptions): Promise<Blob> {
  if (!isVideoExportSupported()) {
    throw new Error('Video export is not supported in this browser.');
  }
  const { file, cues, rtl = false, onProgress, signal } = opts;

  const { video, audio } = await demux(file);
  ensureNotAborted(signal);

  const { track, samples, description } = video;
  const width = track.video?.width || track.track_width;
  const height = track.video?.height || track.track_height;
  const timescale = track.timescale;
  const totalDurationSec = track.duration / timescale || 1;
  const framerate = Math.max(1, Math.min(60, Math.round(samples.length / totalDurationSec)));

  // Pre-rasterize each distinct glyph once, sized relative to the video. The
  // compositing loop is then a synchronous bitmap blit per frame.
  const overlayHeight = Math.max(40, Math.round(height * 0.2));
  const margin = Math.round(height * 0.04);
  const distinctGlyphs = Array.from(new Set(cues.map((c) => c.glyph).filter(Boolean)));
  const glyphBitmaps = new Map<string, ImageBitmap>();
  for (const g of distinctGlyphs) {
    ensureNotAborted(signal);
    const bmp = await rasterizeGlyph(g, overlayHeight, rtl);
    if (bmp) glyphBitmaps.set(g, bmp);
  }

  // Sort cues by start so an advancing pointer can find the active one per frame.
  const sortedCues = [...cues].filter((c) => c.glyph).sort((a, b) => a.startMs - b.startMs);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // --- Muxer + encoder ---
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    // Only declare an audio track when we actually have passthrough samples —
    // mp4-muxer expects audio chunks for every declared audio track.
    ...(audio
      ? {
          audio: {
            codec: audio.muxerCodec,
            numberOfChannels: audio.track.audio?.channel_count || 2,
            sampleRate: audio.track.audio?.sample_rate || 48000,
          },
        }
      : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      console.error('[videoExport] VideoEncoder error:', e);
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: await pickEncoderCodec(width, height),
    width,
    height,
    framerate,
    bitrate: Math.min(20_000_000, Math.max(1_000_000, Math.round(width * height * framerate * 0.12))),
  });

  let processed = 0;
  let lastKeyframeUs = -Infinity;
  const KEYFRAME_INTERVAL_US = 2_000_000; // a keyframe at least every 2s

  // Errors thrown inside the decoder's output callback are swallowed by
  // WebCodecs, so capture them here and surface after the run.
  let frameError: Error | null = null;

  // Compose one decoded frame and hand it to the encoder.
  const onFrame = (frame: VideoFrame) => {
    try {
      ctx.drawImage(frame, 0, 0, width, height);

      const ms = frame.timestamp / 1000;
      // Advance through cues (frames arrive in presentation order).
      const glyph = activeGlyphAt(sortedCues, ms);
      const bmp = glyph ? glyphBitmaps.get(glyph) : undefined;
      if (bmp) {
        // Scale to overlayHeight, then shrink to fit the frame width so a
        // narrow/portrait video never clips a wide (multi-glyph) sentence.
        let oh = overlayHeight;
        let ow = Math.round((oh * bmp.width) / bmp.height);
        const maxW = width - margin * 2;
        if (ow > maxW) {
          oh = Math.round((oh * maxW) / ow);
          ow = maxW;
        }
        const ox = Math.round((width - ow) / 2);
        const oy = height - oh - margin;
        // Legibility band behind the glyph.
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        const pad = Math.round(oh * 0.12);
        roundRect(ctx, ox - pad, oy - pad, ow + pad * 2, oh + pad * 2, pad);
        ctx.fill();
        ctx.drawImage(bmp, ox, oy, ow, oh);
      }

      const keyFrame = frame.timestamp - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKeyframeUs = frame.timestamp;

      const outFrame = new VideoFrame(canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
      });
      encoder.encode(outFrame, { keyFrame });
      outFrame.close();
    } catch (e) {
      if (!frameError) {
        console.error('[videoExport] frame compositing/encode error:', e);
        frameError = e instanceof Error ? e : new Error(String(e));
      }
    } finally {
      frame.close();
      processed++;
      onProgress?.(Math.min(0.98, (processed / samples.length) * 0.98));
    }
  };

  let decoderError: Error | null = null;
  const decoder = new VideoDecoder({
    output: onFrame,
    error: (e) => {
      console.error('[videoExport] VideoDecoder error:', e, 'codec:', track.codec);
      decoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  decoder.configure({ codec: track.codec, codedWidth: width, codedHeight: height, description });

  // Feed samples with light backpressure so we don't buffer the whole video.
  if (samples.length === 0) throw new Error('No video frames found in the file.');

  for (const s of samples) {
    ensureNotAborted(signal);
    if (encoderError) throw encoderError;
    if (decoderError) throw decoderError;
    if (frameError) throw frameError;
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: (s.cts * 1_000_000) / s.timescale,
        duration: (s.duration * 1_000_000) / s.timescale,
        data: s.data!,
      }),
    );
    while (decoder.decodeQueueSize > 30) {
      await new Promise((r) => setTimeout(r, 0));
      ensureNotAborted(signal);
    }
  }

  await decoder.flush();
  await encoder.flush();
  if (decoderError) throw decoderError;
  if (encoderError) throw encoderError;
  if (frameError) throw frameError;

  decoder.close();
  encoder.close();

  // Audio passthrough — copy the original encoded audio frames straight into
  // the muxer (no decode/re-encode → no quality loss, perfect sync). The ASC
  // is attached to the first chunk so the muxer can write a correct esds.
  if (audio) {
    let first = true;
    for (const s of audio.samples) {
      ensureNotAborted(signal);
      const meta =
        first && audio.description
          ? {
              decoderConfig: {
                codec: audio.track.codec,
                sampleRate: audio.track.audio?.sample_rate || 48000,
                numberOfChannels: audio.track.audio?.channel_count || 2,
                description: audio.description,
              },
            }
          : undefined;
      muxer.addAudioChunkRaw(
        s.data!,
        // AAC/Opus frames are each independently decodable.
        'key',
        (s.cts * 1_000_000) / s.timescale,
        (s.duration * 1_000_000) / s.timescale,
        meta,
      );
      first = false;
    }
  }

  muxer.finalize();

  onProgress?.(1);
  const { buffer } = muxer.target as ArrayBufferTarget;
  return new Blob([buffer], { type: 'video/mp4' });
}

/** Linear scan with no allocation — cues are few; called once per frame. */
function activeGlyphAt(sortedCues: GlyphCue[], ms: number): string | null {
  for (const cue of sortedCues) {
    if (ms < cue.startMs) break; // sorted: nothing later can match earlier
    if (ms < cue.endMs) return cue.glyph;
  }
  return null;
}

function roundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
