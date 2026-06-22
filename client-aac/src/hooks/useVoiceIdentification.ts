// client-aac/src/hooks/useVoiceIdentification.ts
//
// Client-side speaker-embedding extraction for the AAC voice-recognition
// system — the audio analog of usePersonIdentification. It turns a short,
// already-VAD-gated speech clip (a 16 kHz mono WAV produced by the activity
// monitor's AudioRingBuffer) into a fixed-length speaker embedding using a
// browser-run model (transformers.js + Xenova/wavlm-base-plus-sv).
//
// The SERVER is authoritative for matching: this hook only computes the vector
// and a quality score; DualAgentContext ships them up as `voice_descriptors`
// and the server (recognition-service) matches against the student's known
// people. We never match locally.
//
// Limitations (documented, accepted for v1):
//  - A clip is embedded as ONE speaker. If two people talk over each other the
//    embedding is a blend — the server's confidence threshold + the Observer's
//    attribution/correction loop are what keep that from poisoning a gallery.
//  - The model (~weights fetched from the HF CDN on first use, then cached by
//    the browser/Electron) is heavy to load; everything here is lazy and
//    failure-tolerant so a slow/absent model never blocks a session.

import { useState, useRef, useCallback, useEffect } from "react";
import { decodeWavMono, resampleTo16k } from "@/lib/decodeWav";

// =============================================================================
// TYPES
// =============================================================================

export interface VoiceDescriptor {
  /** Speaker embedding (the model's x-vector). Length depends on the model. */
  embedding: number[];
  /** Heuristic 0..1 capture quality (duration + energy + low clipping). Gates
   *  whether the server treats this sample as worth growing a gallery from. */
  quality: number;
}

export interface UseVoiceIdentificationOptions {
  enabled?: boolean;
}

export interface UseVoiceIdentificationReturn {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  /** Compute a speaker embedding from a 16 kHz mono WAV clip. Returns null when
   *  the model isn't ready, the clip is too short/quiet to be useful, or the
   *  model throws. Never rejects — voice ID is best-effort. */
  embedClip: (wav: Blob) => Promise<VoiceDescriptor | null>;
}

// =============================================================================
// MODEL LOADER (singleton — shared across hook instances)
// =============================================================================

const MODEL_ID = "Xenova/wavlm-base-plus-sv";
// We ship and load the INT8-quantized ONNX (~102 MB). Speaker-verification
// embeddings tolerate int8 with no meaningful loss, at a quarter the fp32 size.
const MODEL_DTYPE = "q8";

// transformers.js processor/model handles. `any` because the package is loaded
// via a runtime dynamic import (keeps onnxruntime-web out of the main bundle).
let speakerProcessor: any = null;
let speakerModel: any = null;
let modelLoaded = false;
let modelError: Error | null = null;
let modelPromise: Promise<void> | null = null;

/** Absolute URL of the bundled model dir, honoring the Vite base (so it works
 *  under the Electron `app://` origin, the `/aac/` web mount, and dev `/`). */
function localModelBase(): string {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  return new URL(`${base}models/`, window.location.href).href;
}

/** True when the model is bundled locally (packaged Electron build). False in
 *  dev or any build where fetch-voice-model.mjs didn't run — we then fall back
 *  to the HF CDN. NOTE: a plain `res.ok` HEAD is not enough — SPA hosting serves
 *  index.html with a 200 for unknown paths, which would falsely report "local"
 *  and make transformers.js try to JSON.parse the HTML ("Unexpected token '<'").
 *  So we GET the config and confirm it's actually JSON, not the HTML fallback. */
async function hasLocalModel(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}${MODEL_ID}/config.json`, { cache: "no-store" });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) return false; // SPA fallback served index.html
    const text = await res.text();
    return text.trimStart().startsWith("{"); // real config.json starts with '{'
  } catch {
    return false;
  }
}

async function instantiate(tf: any): Promise<void> {
  const { AutoProcessor, AutoModel, env } = tf;
  const opts = { dtype: MODEL_DTYPE } as any;
  try {
    speakerProcessor = await AutoProcessor.from_pretrained(MODEL_ID, opts);
    speakerModel = await AutoModel.from_pretrained(MODEL_ID, opts);
  } catch (err) {
    // Worker proxy may fail to spawn in some setups — retry on the main thread
    // (embeddings will block briefly, but voice ID still works) rather than fail.
    if (env?.backends?.onnx?.wasm?.proxy) {
      console.warn(`[VoiceID] proxy instantiate failed, retrying on main thread: ${(err as Error)?.message}`);
      env.backends.onnx.wasm.proxy = false;
      speakerProcessor = await AutoProcessor.from_pretrained(MODEL_ID, opts);
      speakerModel = await AutoModel.from_pretrained(MODEL_ID, opts);
    } else {
      throw err;
    }
  }
}

async function loadSpeakerModel(): Promise<void> {
  if (modelLoaded) return;
  if (modelError) throw modelError;
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    try {
      const tf: any = await import("@huggingface/transformers");
      const { env } = tf;
      // Run inference in a Web Worker, NOT the main thread — wavlm embedding is
      // CPU-heavy and was freezing the UI on each speech clip. Must be set before
      // the session is created. (Global, shared with any other transformers.js
      // model; harmless if already set.)
      try {
        if (env?.backends?.onnx?.wasm) env.backends.onnx.wasm.proxy = true;
      } catch { /* non-fatal — falls back to main-thread inference */ }
      const base = localModelBase();
      const useLocal = await hasLocalModel(base);

      // Note: we deliberately DON'T set env.backends.onnx.wasm.wasmPaths —
      // Vite already emits the onnxruntime WASM as a hashed asset and rewires
      // the URL, so the runtime resolves it from the bundle (works offline).
      // Overriding wasmPaths would break that working auto-resolution.
      if (useLocal) {
        // Packaged build: load the bundled weights, no network.
        if (env) {
          env.allowLocalModels = true;
          env.allowRemoteModels = false;
          env.localModelPath = base;
        }
        try {
          await instantiate(tf);
          modelLoaded = true;
          console.log(`[VoiceID] Speaker model loaded from bundle: ${MODEL_ID}`);
          return;
        } catch (localErr) {
          // Partial/corrupt local files — fall through to the CDN.
          console.warn("[VoiceID] Local model load failed, falling back to CDN:", localErr);
        }
      }

      // Dev, or local files absent/broken: fetch from the HF hub (cached after
      // first load).
      if (env) {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
      }
      await instantiate(tf);
      modelLoaded = true;
      console.log(`[VoiceID] Speaker model loaded from CDN: ${MODEL_ID}`);
    } catch (err) {
      modelError = err as Error;
      console.error("[VoiceID] Failed to load speaker model:", err);
      throw err;
    }
  })();

  return modelPromise;
}

// =============================================================================
// QUALITY HEURISTIC
// =============================================================================

const MIN_SPEECH_SECONDS = 0.6; // below this an embedding is unreliable
const GOOD_SPEECH_SECONDS = 2.5; // duration past which we're confident

/** 0..1 capture-quality estimate from duration, RMS energy and clipping. Used
 *  server-side to decide whether the sample is worth growing a gallery from. */
function assessVoiceQuality(samples: Float32Array, sampleRate: number): number {
  const seconds = samples.length / sampleRate;
  if (seconds < MIN_SPEECH_SECONDS) return 0;

  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
    if (Math.abs(s) > 0.98) clipped++;
  }
  const rms = Math.sqrt(sumSq / samples.length);

  // Duration score ramps from MIN→GOOD seconds.
  const durScore = Math.min(1, (seconds - MIN_SPEECH_SECONDS) / (GOOD_SPEECH_SECONDS - MIN_SPEECH_SECONDS) + 0.2);
  // Energy score: too quiet (mostly background) is bad; saturate around rms 0.15.
  const energyScore = Math.min(1, rms / 0.15);
  // Clipping penalty.
  const clipPenalty = Math.min(0.6, (clipped / samples.length) * 6);

  return Math.max(0, Math.min(1, durScore * energyScore * (1 - clipPenalty)));
}

// =============================================================================
// HOOK
// =============================================================================

export function useVoiceIdentification(
  options: UseVoiceIdentificationOptions = {},
): UseVoiceIdentificationReturn {
  const { enabled = true } = options;

  const [isReady, setIsReady] = useState(modelLoaded);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One in-flight embedding at a time — the model is single-threaded and a
  // backlog of clips would just add latency. Newer clips matter more.
  const busyRef = useRef(false);

  useEffect(() => {
    if (!enabled || modelLoaded) {
      if (modelLoaded) setIsReady(true);
      return;
    }
    let mounted = true;
    setIsLoading(true);
    loadSpeakerModel()
      .then(() => { if (mounted) { setIsReady(true); setError(null); } })
      .catch((err) => { if (mounted) setError(err?.message || "Failed to load voice model"); })
      .finally(() => { if (mounted) setIsLoading(false); });
    return () => { mounted = false; };
  }, [enabled]);

  const embedClip = useCallback(async (wav: Blob): Promise<VoiceDescriptor | null> => {
    if (!enabled || !modelLoaded || busyRef.current) return null;
    busyRef.current = true;
    try {
      const decoded = await decodeWavMono(wav);
      if (!decoded) return null;
      const samples = resampleTo16k(decoded.samples, decoded.sampleRate);

      const quality = assessVoiceQuality(samples, 16000);
      if (quality <= 0) return null; // too short/quiet to bother running the model

      const inputs = await speakerProcessor(samples, { sampling_rate: 16000 });
      const output = await speakerModel(inputs);
      // WavLMForXVector exposes the speaker vector as `embeddings`.
      const tensor = output?.embeddings ?? output?.logits ?? null;
      if (!tensor || typeof tensor.tolist !== "function") return null;
      const list = tensor.tolist();
      const embedding: number[] = Array.isArray(list[0]) ? list[0] : list;
      if (!embedding?.length) return null;

      return { embedding, quality };
    } catch (err) {
      console.warn("[VoiceID] embedClip failed:", err);
      return null;
    } finally {
      busyRef.current = false;
    }
  }, [enabled]);

  return { isReady, isLoading, error, embedClip };
}

export default useVoiceIdentification;
