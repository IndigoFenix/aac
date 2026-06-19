// server/services/voice/google-stt-service.ts
// Google Cloud Speech-to-Text — used by the Video Caption Studio to transcribe
// a video's audio into timestamped caption segments when no caption file is
// supplied. Chosen over OpenAI Whisper to keep student/clinician audio inside
// the GCP relationship the platform already uses for Google Cloud TTS (same
// service-account auth), rather than expanding OpenAI's PHI footprint.
//
// Data residency: the client is pinned to a regional endpoint (EU by default,
// override with GOOGLE_STT_ENDPOINT) so audio is processed in-region.

import { SpeechClient } from "@google-cloud/speech";

export interface SttSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SttResult {
  segments: SttSegment[];
  language: string;
}

export interface SttOptions {
  /** ISO-639-1 (e.g. "en", "he") or full BCP-47 (e.g. "en-US"). */
  languageHint?: string;
  /** Sample rate of the supplied LINEAR16 audio. Defaults to 16000. */
  sampleRateHertz?: number;
}

// Map our short language codes to the BCP-47 codes Google STT expects. A hint
// already containing a region ("en-US") is passed through untouched.
const STT_LANGUAGE_MAP: Record<string, string> = {
  en: "en-US",
  he: "he-IL",
  ar: "ar-SA",
  es: "es-ES",
  ru: "ru-RU",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  zh: "cmn-Hans-CN",
  yue: "yue-Hant-HK",
  ko: "ko-KR",
};

function toBcp47(hint?: string): string {
  if (!hint) return "en-US";
  if (hint.includes("-")) return hint;
  return STT_LANGUAGE_MAP[hint] || "en-US";
}

/** Map a detected BCP-47 code back to our short app code (handles Google's
 * legacy/region forms: iw→he, cmn→zh, yue, etc.). */
function bcp47ToShort(code: string | null | undefined): string {
  const c = (code || "").toLowerCase();
  if (c.startsWith("iw") || c.startsWith("he")) return "he";
  if (c.startsWith("yue")) return "yue";
  if (c.startsWith("cmn") || c.startsWith("zh")) return "zh";
  const two = c.slice(0, 2);
  const known = ["en", "ar", "es", "ru", "fr", "de", "pt", "ko"];
  return known.includes(two) ? two : "en";
}

// Start a new caption line after this much speech or this many words, so we get
// readable subtitle-sized chunks rather than one giant block per pause group.
const MAX_SEGMENT_MS = 6000;
const MAX_SEGMENT_WORDS = 12;

// Google STT rejects inline audio longer than ~60s ("use a GCS URI"). Rather
// than provision a bucket, we split the PCM into windows under that and
// transcribe each synchronously, offsetting word timings back onto the full
// timeline. We don't cut at a fixed offset — we look for a quiet point in a
// window so the seam lands in a pause rather than mid-word.
const CHUNK_MIN_SECONDS = 25; // don't cut before this into a chunk
const CHUNK_MAX_SECONDS = 55; // must cut by here (stay under the 60s cap)
const ANALYSIS_FRAME_MS = 20; // amplitude window granularity for silence search
// Words ending in these break a caption line (sentence-aware segmentation).
const SENTENCE_END = /[.!?…]["')\]]?$/;

// Lazy client init, mirroring google-tts-service.ts (JSON creds or ADC), with a
// regional endpoint for data residency.
let client: SpeechClient | null = null;

function getClient(): SpeechClient {
  if (!client) {
    const apiEndpoint = process.env.GOOGLE_STT_ENDPOINT || "eu-speech.googleapis.com";
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credentialsJson) {
      try {
        const credentials = JSON.parse(credentialsJson);
        client = new SpeechClient({ credentials, apiEndpoint });
      } catch (error) {
        console.error("[GoogleSTTService] Failed to parse credentials JSON:", error);
        throw new Error("Failed to initialize Google STT client: invalid credentials JSON");
      }
    } else {
      // Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / gcloud).
      client = new SpeechClient({ apiEndpoint });
    }
  }
  return client;
}

/** Protobuf Duration ({ seconds, nanos }) → milliseconds. `seconds` may be a
 * number, a numeric string, or a protobuf Long ({ toNumber() }). */
function durationToMs(d: { seconds?: any; nanos?: number | null } | null | undefined): number {
  if (!d) return 0;
  const rawSeconds = d.seconds;
  let seconds = 0;
  if (typeof rawSeconds === "number") seconds = rawSeconds;
  else if (typeof rawSeconds === "string") seconds = parseInt(rawSeconds, 10);
  else if (rawSeconds && typeof rawSeconds.toNumber === "function") seconds = rawSeconds.toNumber();
  const nanos = d.nanos || 0;
  return Math.round(seconds * 1000 + nanos / 1e6);
}

/** A word with absolute (full-timeline) timing in ms. */
interface TimedWord {
  word: string;
  startMs: number;
  endMs: number;
}

/**
 * Group word-timings into subtitle-sized segments. Breaks a line on a
 * sentence-final word (./!/?) or when it hits the duration/word-count caps, so
 * lines fall on natural sentence boundaries where possible.
 */
export function wordsToSegments(words: TimedWord[]): SttSegment[] {
  const segments: SttSegment[] = [];
  let bucket: TimedWord[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    const startMs = bucket[0].startMs;
    const endMs = bucket[bucket.length - 1].endMs;
    const text = bucket.map((w) => w.word).join(" ").trim();
    if (text) segments.push({ startMs, endMs, text });
    bucket = [];
  };

  for (const w of words) {
    bucket.push(w);
    const spanMs = w.endMs - bucket[0].startMs;
    const sentenceEnd = SENTENCE_END.test(w.word.trim());
    if (sentenceEnd || bucket.length >= MAX_SEGMENT_WORDS || spanMs >= MAX_SEGMENT_MS) flush();
  }
  flush();
  return segments;
}

/** Max |sample| of channel 0 across [byteStart, byteEnd) of LINEAR16 PCM. */
function frameAmplitude(pcm: Buffer, byteStart: number, byteEnd: number, frameBytes: number): number {
  let peak = 0;
  for (let i = byteStart; i + 2 <= byteEnd && i + 2 <= pcm.length; i += frameBytes) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Choose API-chunk boundaries (byte offsets into the PCM) that fall in quiet
 * spots. For each chunk we scan the [MIN, MAX] window for the longest run of
 * low-amplitude analysis-frames and cut at its centre; if there's no clear
 * pause we fall back to the quietest frame, then to the hard MAX boundary.
 *
 * Pure (Buffer → number[]) so it can be unit-tested without the STT API.
 * Returns boundaries including 0 and pcm.length.
 */
export function planSilenceAwareChunks(
  pcm: Buffer,
  sampleRate: number,
  frameBytes: number,
): number[] {
  const align = (b: number) => Math.max(0, Math.floor(b / frameBytes) * frameBytes);
  const bytesPerSec = sampleRate * frameBytes;
  const minBytes = align(CHUNK_MIN_SECONDS * bytesPerSec);
  const maxBytes = align(CHUNK_MAX_SECONDS * bytesPerSec);
  const frameStep = align(Math.max(frameBytes, (ANALYSIS_FRAME_MS / 1000) * bytesPerSec));

  const boundaries = [0];
  let start = 0;
  while (pcm.length - start > maxBytes) {
    const lo = start + minBytes;
    const hi = Math.min(start + maxBytes, pcm.length);

    // Amplitude per analysis frame across the window.
    const amps: { at: number; amp: number }[] = [];
    for (let at = align(lo); at < hi; at += frameStep) {
      amps.push({ at, amp: frameAmplitude(pcm, at, Math.min(at + frameStep, hi), frameBytes) });
    }

    let cut = hi; // fallback: hard boundary
    if (amps.length > 0) {
      const peak = amps.reduce((m, f) => Math.max(m, f.amp), 0);
      const threshold = Math.max(600, peak * 0.08); // ~silence
      // Longest run of sub-threshold frames → cut at its centre.
      let bestRunLen = 0;
      let bestRunCut = -1;
      let runStart = -1;
      for (let i = 0; i <= amps.length; i++) {
        const quiet = i < amps.length && amps[i].amp <= threshold;
        if (quiet && runStart === -1) runStart = i;
        if (!quiet && runStart !== -1) {
          const len = i - runStart;
          if (len > bestRunLen) {
            bestRunLen = len;
            bestRunCut = amps[runStart + Math.floor(len / 2)].at;
          }
          runStart = -1;
        }
      }
      if (bestRunCut >= 0) {
        cut = bestRunCut;
      } else {
        // No run — cut at the single quietest frame.
        cut = amps.reduce((min, f) => (f.amp < min.amp ? f : min), amps[0]).at;
      }
    }
    cut = align(cut);
    if (cut <= start) cut = Math.min(start + maxBytes, pcm.length); // safety
    boundaries.push(cut);
    start = cut;
  }
  boundaries.push(pcm.length);
  return boundaries;
}

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataStart: number;
  dataLength: number;
}

/**
 * Parse a WAV header to locate the PCM data and its format. Falls back to the
 * canonical layout our client emits (44-byte header, mono 16-bit) if the chunk
 * walk fails.
 */
function parseWav(buf: Buffer, fallbackRate: number): WavInfo {
  try {
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
      let off = 12;
      let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
      let dataStart = -1;
      let dataLength = 0;
      while (off + 8 <= buf.length) {
        const id = buf.toString("ascii", off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = off + 8;
        if (id === "fmt ") {
          fmt = {
            channels: buf.readUInt16LE(body + 2),
            sampleRate: buf.readUInt32LE(body + 4),
            bitsPerSample: buf.readUInt16LE(body + 14),
          };
        } else if (id === "data") {
          dataStart = body;
          dataLength = Math.min(size, buf.length - body);
        }
        off = body + size + (size % 2); // chunks are word-aligned
      }
      if (fmt && dataStart >= 0) {
        return { ...fmt, dataStart, dataLength };
      }
    }
  } catch {
    /* fall through */
  }
  return { sampleRate: fallbackRate, channels: 1, bitsPerSample: 16, dataStart: 44, dataLength: Math.max(0, buf.length - 44) };
}

/**
 * Transcribe LINEAR16 (16-bit PCM WAV) audio into timestamped caption segments.
 * The audio is expected to be mono at `sampleRateHertz` (the client extracts it
 * that way). Clips beyond 60s are split into silence-aligned windows and each
 * window transcribed synchronously, since inline STT rejects >60s audio.
 */
export async function transcribeSegments(
  audioBuffer: Buffer,
  opts: SttOptions = {},
): Promise<SttResult> {
  const languageCode = toBcp47(opts.languageHint);
  const client = getClient();
  const wav = parseWav(audioBuffer, opts.sampleRateHertz ?? 16000);
  const sampleRateHertz = opts.sampleRateHertz ?? wav.sampleRate;

  // Raw PCM region of the WAV; we slice it into sub-60s windows and send each
  // as headerless LINEAR16 (the encoding STT expects for raw PCM). Boundaries
  // are placed in quiet spots so a chunk seam never bisects a word.
  const pcm = audioBuffer.subarray(wav.dataStart, wav.dataStart + wav.dataLength);
  const frameBytes = (wav.bitsPerSample / 8) * wav.channels;
  const boundaries = planSilenceAwareChunks(pcm, wav.sampleRate, frameBytes);

  const baseConfig = {
    encoding: "LINEAR16" as const,
    sampleRateHertz,
    audioChannelCount: wav.channels,
    languageCode,
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
  };

  // `latest_long` is the best long-form model but only covers a subset of
  // languages (e.g. NOT Hebrew → "model is currently not supported for
  // language"). Try it; on a model-support error, drop the model (default
  // model covers far more languages) and remember the choice for later chunks.
  let useEnhancedModel = true;
  const recognizeSlice = async (content: string) => {
    if (useEnhancedModel) {
      try {
        const [r] = await client.recognize({ audio: { content }, config: { ...baseConfig, model: "latest_long" } });
        return r;
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (!/not supported for language|model/i.test(msg)) throw err;
        useEnhancedModel = false; // fall through to default model
      }
    }
    const [r] = await client.recognize({ audio: { content }, config: baseConfig });
    return r;
  };

  const allWords: TimedWord[] = [];
  for (let c = 0; c < boundaries.length - 1; c++) {
    const start = boundaries[c];
    const slice = pcm.subarray(start, boundaries[c + 1]);
    if (slice.length === 0) continue;
    const offsetMs = Math.round((start / (wav.sampleRate * frameBytes)) * 1000);

    const response = await recognizeSlice(slice.toString("base64"));

    for (const result of response.results || []) {
      const alt = result.alternatives?.[0];
      if (!alt) continue;
      const words = alt.words || [];
      if (words.length > 0) {
        for (const w of words) {
          allWords.push({
            word: w.word || "",
            startMs: durationToMs(w.startTime) + offsetMs,
            endMs: durationToMs(w.endTime) + offsetMs,
          });
        }
      } else if (alt.transcript) {
        // No word offsets (rare) — anchor the whole alternative at the chunk.
        allWords.push({ word: alt.transcript.trim(), startMs: offsetMs, endMs: offsetMs });
      }
    }
  }

  allWords.sort((a, b) => a.startMs - b.startMs);
  return { segments: wordsToSegments(allWords), language: languageCode };
}

export interface DetectLanguageResult {
  /** Our short app language code (e.g. "en", "he"). */
  language: string;
  /** The raw BCP-47 code STT detected. */
  languageCode: string;
  /** A short transcript snippet so the user can eyeball the result. */
  sampleText: string;
}

/**
 * Detect the spoken language of a SHORT audio sample (LINEAR16 WAV) by running
 * STT with `alternativeLanguageCodes` seeded from the caller's candidate codes,
 * then reading back the detected `languageCode`. Cheap pre-flight check before
 * committing to the full transcribe→ideas→glyphs pipeline.
 *
 * `candidates` are our short codes (e.g. ["en","he","es"]) — the first is the
 * primary guess; up to 3 more become alternatives (Google's cap).
 */
export async function detectLanguage(
  audioBuffer: Buffer,
  opts: { candidates?: string[]; sampleRateHertz?: number } = {},
): Promise<DetectLanguageResult> {
  const client = getClient();
  const wav = parseWav(audioBuffer, opts.sampleRateHertz ?? 16000);
  const sampleRateHertz = opts.sampleRateHertz ?? wav.sampleRate;

  // Cap the sample to ~30s of speech (defensive — the client clips already).
  const frameBytes = (wav.bitsPerSample / 8) * wav.channels;
  const pcm = audioBuffer.subarray(wav.dataStart, wav.dataStart + wav.dataLength);
  const sample = pcm.subarray(0, Math.min(pcm.length, wav.sampleRate * frameBytes * 30));

  const candidates = (opts.candidates && opts.candidates.length ? opts.candidates : ["en"]).map(toBcp47);
  const primary = candidates[0];
  const alternatives = Array.from(new Set(candidates.slice(1))).filter((c) => c !== primary).slice(0, 3);

  const [response] = await client.recognize({
    audio: { content: sample.toString("base64") },
    config: {
      encoding: "LINEAR16",
      sampleRateHertz,
      audioChannelCount: wav.channels,
      languageCode: primary,
      ...(alternatives.length ? { alternativeLanguageCodes: alternatives } : {}),
      enableAutomaticPunctuation: true,
    },
  });

  // Pick the most frequent detected languageCode across results; collect a snippet.
  const counts = new Map<string, number>();
  const parts: string[] = [];
  for (const r of response.results || []) {
    const lc = (r.languageCode || "").toString();
    if (lc) counts.set(lc, (counts.get(lc) || 0) + 1);
    const transcript = r.alternatives?.[0]?.transcript;
    if (transcript) parts.push(transcript.trim());
  }
  let best = primary;
  let bestN = -1;
  for (const [lc, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = lc;
    }
  }

  return {
    language: bcp47ToShort(best),
    languageCode: best,
    sampleText: parts.join(" ").trim().slice(0, 300),
  };
}

export const googleSttService = { transcribeSegments, detectLanguage };
