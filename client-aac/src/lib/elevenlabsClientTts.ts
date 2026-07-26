// client-aac/src/lib/elevenlabsClientTts.ts
//
// Client-direct ElevenLabs synthesis for the AAC voice.
//
// Three tiers, fastest first — each falls through to the next so a press is
// NEVER silent:
//
//   1. Device cache — quick-button "yes"/"no" only. Zero network.
//   2. Streaming PCM — plays at time-to-first-byte via the worklet sink.
//   3. Buffered MP3 — the original whole-file path, used when the worklet is
//      unavailable, the stream endpoint rejects the model, or anything throws.
//
// Only reachable when the student has their OWN ElevenLabs key (the server's
// `isClientTts` gate). The shared/admin key stays server-side and must never
// be sent to a client.

import type { UseStreamingAudioPlayerReturn } from "@/hooks/useStreamingAudioPlayer";
import { getCachedClip, putCachedClip, isCacheablePhrase } from "@/services/tts-cache";

const API_BASE = "https://api.elevenlabs.io/v1";

/** Mirrors the server's resolveModel (elevenlabs-tts-service.ts) — these
 *  languages are not served well by multilingual_v2. */
const V3_LANGUAGES = new Set(["he", "ar"]);

/** PCM rate we request. 24 kHz is a near-integer ratio to the usual 48 kHz
 *  AudioContext, so the resample is clean, and it's well within speech
 *  bandwidth — a higher rate would only cost latency. */
const PCM_SAMPLE_RATE = 24000;

const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };

export interface ClientTtsRequest {
  text: string;
  voiceId: string;
  apiKey: string;
  language: string;
  /** Player tag: "avatar" (AI voice) or "utterance" (student voice). */
  tag: string;
}

function resolveModel(language: string): string {
  return V3_LANGUAGES.has(language) ? "eleven_v3" : "eleven_multilingual_v2";
}

/**
 * Speak `text` through the player, using the fastest path available.
 * Resolves when playback finishes (or when the utterance has been handed to
 * the player's queue, on the buffered fallback).
 */
export async function speakViaElevenLabs(
  req: ClientTtsRequest,
  player: UseStreamingAudioPlayerReturn,
): Promise<void> {
  if (!req.text.trim()) return;

  // ── 1. Cache ────────────────────────────────────────────────────────────
  if (isCacheablePhrase(req.text)) {
    try {
      const hit = await getCachedClip(req.text, req.voiceId, req.language);
      if (hit) {
        const played = await playCachedClip(hit.pcm, hit.sourceRate, req.tag, player);
        if (played) return;
      }
    } catch (err) {
      console.warn("[ClientTTS] Cache path failed, synthesizing:", err);
    }
  }

  // ── 2. Streaming PCM ────────────────────────────────────────────────────
  try {
    const streamed = await streamPcm(req, player);
    if (streamed) return;
  } catch (err) {
    console.warn("[ClientTTS] Streaming path failed, falling back to buffered:", err);
  }

  // ── 3. Buffered MP3 ─────────────────────────────────────────────────────
  await bufferedMp3(req, player);
}

/** Replay cached PCM through the streaming sink. Returns false if the sink
 *  couldn't be opened (caller then synthesizes normally). */
async function playCachedClip(
  pcm: ArrayBuffer,
  sourceRate: number,
  tag: string,
  player: UseStreamingAudioPlayerReturn,
): Promise<boolean> {
  const sink = await player.openPcmStream({ tag, sourceRate, prebufferMs: 0 });
  if (!sink) return false;
  sink.write(new Uint8Array(pcm));
  sink.end();
  await sink.finished;
  return true;
}

/**
 * Stream PCM straight from ElevenLabs into the worklet sink.
 * Returns false (without consuming the request) when the sink can't be opened
 * or the endpoint refuses — the caller then uses the buffered path.
 */
async function streamPcm(
  req: ClientTtsRequest,
  player: UseStreamingAudioPlayerReturn,
): Promise<boolean> {
  const sink = await player.openPcmStream({ tag: req.tag, sourceRate: PCM_SAMPLE_RATE });
  if (!sink) return false;

  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/text-to-speech/${req.voiceId}/stream?output_format=pcm_${PCM_SAMPLE_RATE}`,
      {
        method: "POST",
        headers: { "xi-api-key": req.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          model_id: resolveModel(req.language),
          voice_settings: VOICE_SETTINGS,
        }),
      },
    );
  } catch (err) {
    sink.abort();
    throw err;
  }

  // A model or tier that can't serve streaming PCM (eleven_v3 in particular)
  // rejects here — abort cleanly so the buffered path can still speak.
  if (!response.ok || !response.body) {
    sink.abort();
    console.warn(
      `[ClientTTS] Stream endpoint unavailable (${response.status}) for model ` +
        `${resolveModel(req.language)} — using buffered MP3.`,
    );
    return false;
  }

  const collect = isCacheablePhrase(req.text);
  const collected: Uint8Array[] = [];
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      sink.write(value);
      if (collect) collected.push(value.slice());
    }
    sink.end();
  } catch (err) {
    sink.abort();
    throw err;
  }

  await sink.finished;

  if (collect && collected.length > 0) {
    void putCachedClip({
      text: req.text,
      voiceId: req.voiceId,
      language: req.language,
      sourceRate: PCM_SAMPLE_RATE,
      pcm: concatBytes(collected).buffer,
    });
  }

  return true;
}

/** Original whole-file path: synthesize MP3, hand the blob to the player. */
async function bufferedMp3(
  req: ClientTtsRequest,
  player: UseStreamingAudioPlayerReturn,
): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/text-to-speech/${req.voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": req.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: req.text,
        model_id: resolveModel(req.language),
        voice_settings: VOICE_SETTINGS,
      }),
    });
    if (!response.ok) {
      console.error("[ClientTTS] Buffered synthesis failed:", response.status);
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    player.queueChunk({ chunk: toBase64(bytes), format: "mp3", tag: req.tag });
  } catch (err) {
    console.error("[ClientTTS] Buffered synthesis threw:", err);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the argument limit on long utterances.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}
