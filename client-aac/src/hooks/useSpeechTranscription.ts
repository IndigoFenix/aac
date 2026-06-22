// client-aac/src/hooks/useSpeechTranscription.ts
//
// Client-side speech-to-text for the AAC cost-saving system (Phase 1). It turns
// an already-VAD-gated speech clip (16 kHz mono WAV from the activity monitor's
// AudioRingBuffer) into text using a browser-run Whisper model (transformers.js
// + Xenova/whisper-base), so the server can be fed the TRANSCRIPT instead of raw
// audio. The Gemini Live context re-bills audio every turn at the audio rate;
// replacing it with text is the single biggest live-cost lever.
// See planning-docs/aac-cost-saving-spec.md §1.
//
// Mirrors useVoiceIdentification's lazy, failure-tolerant loader. The SERVER
// decides whether to USE the transcript (clientConfig.sttActive); this hook only
// produces it. Activated whenever full-attention is off (and the client
// advertised the capability).
//
// Limitations (documented, accepted for v1):
//  - Whisper can hallucinate text on silence/noise; we gate on a minimum
//    duration + RMS energy and surface a coarse confidence, and the server tells
//    the Observer to treat low-confidence text as uncertain. The Observer-pull
//    backlog (Phase 1b) is the real recovery path for genuinely ambiguous clips.
//  - No true token-level confidence is exposed by the pipeline; `confidence`
//    here is an audio-quality proxy, not a model logprob.

import { useState, useRef, useCallback, useEffect } from "react";
import { decodeWavMono, resampleTo16k } from "@/lib/decodeWav";

// =============================================================================
// TYPES
// =============================================================================

export interface TranscriptionResult {
  /** Recognized text (trimmed). Empty string is filtered out (returns null). */
  text: string;
  /** Coarse 0..1 confidence proxy (audio quality based — see file header). */
  confidence: number;
}

export interface UseSpeechTranscriptionOptions {
  enabled?: boolean;
  /** BCP-47-ish language hint for the multilingual model (e.g. "en", "he"). */
  language?: string;
}

export interface UseSpeechTranscriptionReturn {
  isReady: boolean;
  isLoading: boolean;
  /** True while a clip is being transcribed (drives a "processing" indicator). */
  isTranscribing: boolean;
  error: string | null;
  /** Transcribe a 16 kHz mono WAV clip. Returns null when the model isn't
   *  ready, the clip is too short/quiet, the text is empty, or the model
   *  throws. Never rejects — STT is best-effort. */
  transcribeClip: (wav: Blob) => Promise<TranscriptionResult | null>;
}

// =============================================================================
// MODEL LOADER (singleton — shared across hook instances)
// =============================================================================

// Multilingual model (NOT *.en) so Hebrew + other locales transcribe. We use
// `small` over `base`: base q8 accuracy was poor in testing; small is a large
// jump and works fully offline in Electron (Web Speech can't — no Google
// backend). q8 keeps it WASM-friendly (~250MB) vs fp16 (~480MB + slower on
// WASM). If accuracy still falls short, bump to fp16 here AND in the bundler.
const MODEL_ID = "Xenova/whisper-small";
const MODEL_DTYPE = "q8";

let transcriber: any = null;
let modelLoaded = false;
let modelError: Error | null = null;
let modelPromise: Promise<void> | null = null;

/** Absolute URL of the bundled model dir, honoring the Vite base (so it works
 *  under the Electron `app://` origin, the `/aac/` web mount, and dev `/`). */
function localModelBase(): string {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  return new URL(`${base}models/`, window.location.href).href;
}

/** True when the model is bundled locally (packaged build). False in dev or any
 *  build where the model wasn't fetched — we then fall back to the HF CDN.
 *  NOTE: a plain `res.ok` HEAD is not enough — SPA hosting serves index.html
 *  with a 200 for unknown paths, which would falsely report "local" and then
 *  make transformers.js try to JSON.parse the HTML ("Unexpected token '<'").
 *  So we GET the config and confirm it's actually JSON, not the HTML fallback. */
async function hasLocalModel(base: string): Promise<boolean> {
  const url = `${base}${MODEL_ID}/config.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    return res.ok && !ct.includes("text/html") && text.trimStart().startsWith("{");
  } catch {
    return false;
  }
}

async function instantiate(tf: any): Promise<void> {
  const { pipeline, env } = tf;
  try {
    transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, { dtype: MODEL_DTYPE });
  } catch (err) {
    // The worker proxy may fail to spawn / load WASM in some setups. Rather than
    // leave STT broken, retry on the main thread (UI freezes during inference,
    // but transcription still works).
    if (env?.backends?.onnx?.wasm?.proxy) {
      env.backends.onnx.wasm.proxy = false;
      transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, { dtype: MODEL_DTYPE });
    } else {
      throw err;
    }
  }
}

async function loadTranscriber(): Promise<void> {
  if (modelLoaded) return;
  if (modelError) throw modelError;
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    try {
      const tf: any = await import("@huggingface/transformers");
      const { env } = tf;
      // Run onnxruntime inference in a Web Worker, NOT on the main thread —
      // whisper-small's autoregressive decode is CPU-heavy and would otherwise
      // freeze the UI for the duration of each utterance. Must be set BEFORE the
      // session is created. (Global, shared with the voice model — both benefit.)
      try {
        if (env?.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.proxy = true;
        }
      } catch { /* non-fatal — falls back to main-thread inference */ }
      // transformers.js caches model files in the Cache API ('transformers-cache').
      // A PRIOR failed load (before the model was bundled) can poison it with the
      // SPA index.html under a file's key, after which it serves that HTML from
      // cache forever — even on the CDN path — and JSON.parse blows up on '<'.
      // Disable the browser cache (we rely on HTTP caching of the local/CDN files)
      // and clear any existing poison.
      if (env) env.useBrowserCache = false;
      try {
        if (typeof caches !== "undefined") {
          await caches.delete("transformers-cache");
        }
      } catch { /* non-fatal */ }
      const base = localModelBase();
      const useLocal = await hasLocalModel(base);

      if (useLocal) {
        if (env) {
          env.allowLocalModels = true;
          env.allowRemoteModels = false;
          env.localModelPath = base;
        }
        try {
          await instantiate(tf);
          modelLoaded = true;
          console.log(`[STT] Whisper model loaded from bundle: ${MODEL_ID}`);
          return;
        } catch {
          // Local load failed — fall back to the CDN below.
        }
      }

      if (env) {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
      }
      await instantiate(tf);
      modelLoaded = true;
      console.log(`[STT] Whisper model loaded from CDN: ${MODEL_ID}`);
    } catch (err) {
      modelError = err as Error;
      throw err;
    }
  })();

  return modelPromise;
}

// =============================================================================
// AUDIO QUALITY GATE
// =============================================================================

const MIN_SPEECH_SECONDS = 0.4; // below this, ASR is unreliable
const GOOD_SPEECH_SECONDS = 2.0;
const MIN_RMS = 0.012; // below this it's mostly background — skip (avoids whisper hallucinating on silence)

/** Returns a coarse 0..1 quality proxy, or 0 to mean "don't bother running ASR"
 *  (too short or too quiet). */
function audioQuality(samples: Float32Array, sampleRate: number): number {
  const seconds = samples.length / sampleRate;
  if (seconds < MIN_SPEECH_SECONDS) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms < MIN_RMS) return 0;
  const durScore = Math.min(1, (seconds - MIN_SPEECH_SECONDS) / (GOOD_SPEECH_SECONDS - MIN_SPEECH_SECONDS) + 0.3);
  const energyScore = Math.min(1, rms / 0.15);
  return Math.max(0, Math.min(1, durScore * energyScore));
}

// =============================================================================
// HOOK
// =============================================================================

export function useSpeechTranscription(
  options: UseSpeechTranscriptionOptions = {},
): UseSpeechTranscriptionReturn {
  const { enabled = true, language } = options;

  const [isReady, setIsReady] = useState(modelLoaded);
  const [isLoading, setIsLoading] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One transcription at a time — the model is single-threaded; a backlog just
  // adds latency, and newer clips matter more.
  const busyRef = useRef(false);
  const languageRef = useRef(language);
  languageRef.current = language;

  useEffect(() => {
    if (!enabled || modelLoaded) {
      if (modelLoaded) setIsReady(true);
      return;
    }
    let mounted = true;
    setIsLoading(true);
    loadTranscriber()
      .then(() => { if (mounted) { setIsReady(true); setError(null); } })
      .catch((err) => { if (mounted) setError(err?.message || "Failed to load speech model"); })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, [enabled]);

  const transcribeClip = useCallback(async (wav: Blob): Promise<TranscriptionResult | null> => {
    if (!enabled || !modelLoaded || busyRef.current) return null;
    busyRef.current = true;
    setIsTranscribing(true);
    try {
      const decoded = await decodeWavMono(wav);
      if (!decoded) return null;
      const samples = resampleTo16k(decoded.samples, decoded.sampleRate);
      const quality = audioQuality(samples, 16000);
      if (quality <= 0) return null;

      // Whisper multilingual: pass the language hint when we have one; omit to
      // let the model auto-detect. task=transcribe (never translate). Whisper
      // wants the ISO-639-1 code (e.g. "en", "he") — strip any region tag and
      // lowercase so "en-US" / "EN" still resolve. Setting it right is critical:
      // auto-detect on short clips is the main accuracy killer.
      const genOpts: any = { task: "transcribe" };
      const langCode = languageRef.current?.split(/[-_]/)[0]?.toLowerCase();
      if (langCode) genOpts.language = langCode;
      const result = await transcriber(samples, genOpts);
      const text = (result?.text ?? "").trim();
      if (!text) return null;

      return { text, confidence: quality };
    } catch {
      return null;
    } finally {
      busyRef.current = false;
      setIsTranscribing(false);
    }
  }, [enabled]);

  return { isReady, isLoading, isTranscribing, error, transcribeClip };
}

export default useSpeechTranscription;
