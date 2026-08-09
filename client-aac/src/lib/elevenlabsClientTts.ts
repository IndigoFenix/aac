// client-aac/src/lib/elevenlabsClientTts.ts
//
// Client-direct ElevenLabs synthesis for the AAC voice.
//
// Three tiers, fastest first — each falls through to the next so a press is
// NEVER silent:
//
//   1. Device cache — quick-button "yes"/"no" only. Zero network.
//   2. PCM via the stream endpoint — played in one of two MODES, chosen per
//      audio source by the stream-health tracker (see stream-health.ts):
//        - "buffered" (the safe default): the whole utterance is collected
//          before playback, and the chunk arrival timings double as a shadow
//          probe of whether streaming would have stuttered.
//        - "streaming": plays at time-to-first-byte via the worklet sink.
//          Earned by a streak of clean probes; revoked on real underruns.
//   3. Buffered MP3 — the original whole-file path, used when the worklet is
//      unavailable, the stream endpoint rejects the model, or anything throws.
//
// Only reachable when the student has their OWN ElevenLabs key (the server's
// `isClientTts` gate). The shared/admin key stays server-side and must never
// be sent to a client.

import type { UseStreamingAudioPlayerReturn } from "@/hooks/useStreamingAudioPlayer";
import { getCachedClip, putCachedClip, isCacheablePhrase } from "@/services/tts-cache";
import { streamHealth, simulateStreamPlayback, type ChunkTiming, type PlaybackMode } from "@/services/stream-health";
import { DEFAULT_PREBUFFER_MS } from "@/lib/pcmStreamSink";

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

/** Stream-health tracker key. Per TAG because the student voice and AI voice
 *  are separate audio sources with separate stakes, and per MODEL because
 *  render pacing (and stream-endpoint support at all) differs by model. */
function sourceKeyFor(req: ClientTtsRequest): string {
  return `${req.tag}:${resolveModel(req.language)}`;
}

/**
 * Speak `text` through the player, using the fastest path available.
 * Resolves when playback finishes (or when the utterance has been handed to
 * the player's queue, on the buffered fallback).
 *
 * REJECTS when no path produced audio (dead API key, quota exhausted, network
 * to ElevenLabs blocked). The caller acks the server with `ok: false`, which
 * is what triggers the server-side fallback synthesis — swallowing the
 * failure here means a silent press and a server that believes it played.
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

  // ── 2. PCM via the stream endpoint (buffered-probe or streaming mode) ───
  const sourceKey = sourceKeyFor(req);
  const decision = streamHealth.decide(sourceKey);
  if (decision.useStreamEndpoint) {
    try {
      const played = await streamPcm(req, player, decision.mode, sourceKey);
      if (played) return;
    } catch (err) {
      console.warn("[ClientTTS] Stream-endpoint path failed, falling back to buffered MP3:", err);
    }
  }

  // ── 3. Buffered MP3 ─────────────────────────────────────────────────────
  const buffered = await bufferedMp3(req, player);
  if (!buffered) {
    throw new Error("ElevenLabs synthesis failed on every path (stream + buffered)");
  }
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

/** Statuses that mean "this model/tier cannot serve the PCM stream endpoint"
 *  (eleven_v3 in particular) — a capability fact worth remembering, unlike
 *  auth failures (401/403), rate limits (429), or server blips (5xx). */
const UNSUPPORTED_STATUSES = new Set([400, 404, 405, 422]);

/**
 * Fetch PCM from the ElevenLabs stream endpoint and play it in `mode`:
 *
 *   "streaming"  — write chunks into the worklet sink as they land; playback
 *                  starts at the prebuffer gate. Real underruns from
 *                  `sink.finished` feed the stream-health tracker.
 *   "buffered"   — collect the whole utterance first, then play it as one
 *                  block (prebuffer 0, like a cache hit). The recorded chunk
 *                  timings are replayed through `simulateStreamPlayback` as a
 *                  shadow probe: "would streaming have stuttered?" — so every
 *                  buffered press teaches the tracker at zero audible risk.
 *
 * Returns false (without consuming the request) when the sink can't be opened
 * or the endpoint refuses — the caller then uses the buffered MP3 path.
 */
async function streamPcm(
  req: ClientTtsRequest,
  player: UseStreamingAudioPlayerReturn,
  mode: PlaybackMode,
  sourceKey: string,
): Promise<boolean> {
  // Buffered mode writes the whole utterance in one go, so the prebuffer gate
  // would only delay the start — 0, same as the cache-replay path.
  const sink = await player.openPcmStream({
    tag: req.tag,
    sourceRate: PCM_SAMPLE_RATE,
    ...(mode === "buffered" ? { prebufferMs: 0 } : {}),
  });
  if (!sink) return false;

  // In buffered mode the sink sits idle while we collect; a supersede
  // (second press, audio_clear) can close it under us. Writes to a closed
  // sink are no-ops, but track it so a superseded utterance is dropped
  // rather than "recovered" through the MP3 fallback (double speech).
  let sinkClosed = false;
  void sink.finished.then(() => { sinkClosed = true; });

  const fetchStart = performance.now();
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
  // rejects here — abort cleanly so the buffered path can still speak, and
  // remember the rejection so future presses skip this doomed round trip.
  if (!response.ok || !response.body) {
    sink.abort();
    if (UNSUPPORTED_STATUSES.has(response.status)) {
      streamHealth.reportEndpointUnsupported(sourceKey);
    }
    console.warn(
      `[ClientTTS] Stream endpoint unavailable (${response.status}) for model ` +
        `${resolveModel(req.language)} — using buffered MP3.`,
    );
    return false;
  }

  const streaming = mode === "streaming";
  const cache = isCacheablePhrase(req.text);
  // Buffered mode needs every chunk (that IS the playback); streaming keeps
  // them only for the yes/no cache.
  const collect = !streaming || cache;
  const collected: Uint8Array[] = [];
  const timings: ChunkTiming[] = [];
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      timings.push({ atMs: performance.now() - fetchStart, bytes: value.length });
      if (streaming) sink.write(value);
      if (collect) collected.push(value.slice());
    }
  } catch (err) {
    sink.abort();
    // A stream that died mid-transfer is a strong "connection bad" signal.
    if (streaming) {
      streamHealth.reportStreamPlayback(sourceKey, 1); // demotes
    } else if (timings.length > 0) {
      streamHealth.reportProbe(sourceKey, false);
    }
    throw err;
  }

  if (streaming) {
    sink.end();
    const { underruns } = await sink.finished;
    streamHealth.reportStreamPlayback(sourceKey, underruns);
  } else {
    // Shadow probe first — the timing data is valid even if playback below
    // gets skipped because the utterance was superseded mid-collection.
    if (timings.length > 0) {
      streamHealth.reportProbe(
        sourceKey,
        simulateStreamPlayback(timings, {
          bytesPerSecond: PCM_SAMPLE_RATE * 2, // s16 mono
          prebufferMs: DEFAULT_PREBUFFER_MS,
        }).pass,
      );
    }
    if (!sinkClosed) {
      for (const chunk of collected) sink.write(chunk);
      sink.end();
      await sink.finished;
    }
  }

  if (cache && collected.length > 0) {
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

/** Original whole-file path: synthesize MP3, hand the blob to the player.
 *  Returns false when no audio was produced, so the caller can report the
 *  failure upstream instead of pretending the utterance played. */
async function bufferedMp3(
  req: ClientTtsRequest,
  player: UseStreamingAudioPlayerReturn,
): Promise<boolean> {
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
      return false;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      console.error("[ClientTTS] Buffered synthesis returned empty audio");
      return false;
    }
    player.queueChunk({ chunk: toBase64(bytes), format: "mp3", tag: req.tag });
    return true;
  } catch (err) {
    console.error("[ClientTTS] Buffered synthesis threw:", err);
    return false;
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
