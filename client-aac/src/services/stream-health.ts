// client-aac/src/services/stream-health.ts
//
// Adaptive streaming-vs-buffered policy for client-direct TTS.
//
// Streaming PCM plays at time-to-first-byte, but on a connection that can't
// sustain realtime delivery the jitter buffer underruns and the student HEARS
// the stutter. Rather than streaming optimistically, each audio source starts
// BUFFERED and earns streaming:
//
//   - In buffered mode the client still fetches the STREAM endpoint, but holds
//     playback until the whole utterance has arrived. The chunk arrival times
//     are a free, zero-risk probe: `simulateStreamPlayback` replays them
//     through a model of the worklet's jitter buffer (same prebuffer gate,
//     see pcm-player-worklet.js) and asks "would this have underrun?". A
//     streak of passing probes promotes the source to streaming.
//   - In streaming mode, REAL underruns (reported by the worklet via
//     `sink.finished`) demote the source back to buffered, and each demotion
//     doubles the streak required to re-promote — a connection that keeps
//     disappointing gets trusted more slowly each time. A long run of clean
//     streamed plays forgives past demotions.
//
// Trackers are kept per SOURCE (the caller supplies the key — tag + model),
// because the student voice and the AI voice can use different models with
// different render pacing. A model that REJECTS the stream endpoint outright
// (eleven_v3) is remembered as `unsupportedUntil`, so those sources skip the
// doomed stream request instead of paying a rejected round trip every press.
//
// State persists in localStorage: connection quality is a property of the
// device's network and should survive a reload. Losing it is harmless — the
// source just re-learns from buffered mode.

export type PlaybackMode = "streaming" | "buffered";

// ---------------------------------------------------------------------------
// Probe simulation
// ---------------------------------------------------------------------------

/** One network chunk of a stream fetch: when it landed and how big it was. */
export interface ChunkTiming {
  /** Milliseconds since the fetch started (any consistent origin works —
   *  the simulation only uses spacing, never absolute time). */
  atMs: number;
  bytes: number;
}

export interface StreamSimOptions {
  /** Realtime consumption rate of the payload (s16 mono: sampleRate * 2). */
  bytesPerSecond: number;
  /** The worklet's prebuffer gate — audio buffered before playback starts,
   *  and re-armed after an underrun. */
  prebufferMs: number;
  /** Minimum jitter-buffer headroom (ms of audio) the stream must keep while
   *  chunks are still arriving. 0 underruns with razor-thin headroom would
   *  pass today and stutter tomorrow; the margin buys stability. */
  marginMs?: number;
}

export interface StreamSimResult {
  /** Times the jitter buffer would have run dry mid-utterance. */
  underruns: number;
  /** Lowest buffered-audio level (ms) observed while chunks were still
   *  arriving. Infinity when playback never started before the last chunk
   *  (utterance shorter than the prebuffer — streaming ≡ buffered there). */
  minHeadroomMs: number;
  pass: boolean;
}

const DEFAULT_MARGIN_MS = 60;

/**
 * Replay recorded chunk timings through the worklet's playback model:
 * playback starts once `prebufferMs` of audio is buffered, consumes at
 * realtime, and an underrun re-arms the prebuffer gate. After the last chunk
 * the stream is complete, so the tail drain can never underrun — headroom is
 * only meaningful while more chunks are pending.
 */
export function simulateStreamPlayback(
  chunks: ChunkTiming[],
  opts: StreamSimOptions,
): StreamSimResult {
  const marginMs = opts.marginMs ?? DEFAULT_MARGIN_MS;
  let receivedMs = 0; // audio received, in playback-ms
  let consumedMs = 0; // audio played out
  let playing = false;
  let lastT = 0;
  let underruns = 0;
  let minHeadroomMs = Infinity;

  for (const chunk of chunks) {
    if (playing) {
      const elapsed = chunk.atMs - lastT;
      const buffered = receivedMs - consumedMs;
      if (elapsed >= buffered) {
        // Ran dry before this chunk arrived — the worklet would have gone
        // silent and re-armed its prebuffer gate.
        underruns++;
        consumedMs = receivedMs;
        playing = false;
        minHeadroomMs = 0;
      } else {
        consumedMs += elapsed;
        minHeadroomMs = Math.min(minHeadroomMs, receivedMs - consumedMs);
      }
    }
    receivedMs += (chunk.bytes / opts.bytesPerSecond) * 1000;
    if (!playing && receivedMs - consumedMs >= opts.prebufferMs) {
      playing = true;
    }
    lastT = chunk.atMs;
  }

  return {
    underruns,
    minHeadroomMs,
    pass: underruns === 0 && minHeadroomMs >= marginMs,
  };
}

// ---------------------------------------------------------------------------
// Per-source mode tracker
// ---------------------------------------------------------------------------

/** Consecutive clean probes required to promote a fresh source. */
const PROMOTE_STREAK_BASE = 3;
/** Cap on the (doubling) promote requirement after repeated demotions. */
const PROMOTE_STREAK_CAP = 24;
/** Clean STREAMED plays after which past demotions are forgiven (the promote
 *  requirement resets to base). */
const FORGIVE_CLEAN_STREAK = 12;
/** How long to remember that the stream endpoint rejected this source's
 *  model before probing it again (tiers/models change rarely). */
const UNSUPPORTED_RETRY_MS = 24 * 60 * 60 * 1000;
/** Cap on stored source records; oldest-updated evicted first. */
const MAX_SOURCES = 32;

const STORAGE_KEY = "aac.tts.streamHealth.v1";

interface SourceRecord {
  mode: PlaybackMode;
  /** Buffered mode: consecutive passing probes so far. */
  passStreak: number;
  /** Passing probes required to promote (doubles on each demotion). */
  promoteStreak: number;
  /** Streaming mode: consecutive underrun-free plays (drives forgiveness). */
  cleanStreak: number;
  /** Epoch ms until which the stream endpoint is considered unusable. */
  unsupportedUntil?: number;
  updatedAt: number;
}

export interface StreamDecision {
  mode: PlaybackMode;
  /** False when the stream endpoint is known-rejected for this source —
   *  callers should go straight to the buffered MP3 endpoint. */
  useStreamEndpoint: boolean;
}

export interface StreamHealthTracker {
  decide(sourceKey: string, now?: number): StreamDecision;
  /** Buffered-mode shadow probe outcome (from `simulateStreamPlayback`). */
  reportProbe(sourceKey: string, pass: boolean, now?: number): void;
  /** Streaming-mode real playback outcome (underruns from `sink.finished`). */
  reportStreamPlayback(sourceKey: string, underruns: number, now?: number): void;
  /** The stream endpoint rejected this source's model outright. */
  reportEndpointUnsupported(sourceKey: string, now?: number): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    // Absent in workers / some webviews; throws in some private modes.
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function createStreamHealthTracker(
  storage: StorageLike | null = defaultStorage(),
): StreamHealthTracker {
  let records: Record<string, SourceRecord> = {};
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) records = JSON.parse(raw) as Record<string, SourceRecord>;
  } catch {
    records = {}; // corrupt state — re-learn
  }

  const save = () => {
    const keys = Object.keys(records);
    if (keys.length > MAX_SOURCES) {
      keys
        .sort((a, b) => records[a].updatedAt - records[b].updatedAt)
        .slice(0, keys.length - MAX_SOURCES)
        .forEach((k) => delete records[k]);
    }
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      /* quota / private mode — in-memory state still applies this session */
    }
  };

  const get = (key: string, now: number): SourceRecord => {
    let rec = records[key];
    if (!rec) {
      rec = {
        mode: "buffered",
        passStreak: 0,
        promoteStreak: PROMOTE_STREAK_BASE,
        cleanStreak: 0,
        updatedAt: now,
      };
      records[key] = rec;
    }
    return rec;
  };

  return {
    decide(sourceKey, now = Date.now()) {
      const rec = get(sourceKey, now);
      const unsupported =
        rec.unsupportedUntil !== undefined && rec.unsupportedUntil > now;
      if (!unsupported && rec.unsupportedUntil !== undefined) {
        delete rec.unsupportedUntil; // TTL expired — probe again
        save();
      }
      return {
        mode: unsupported ? "buffered" : rec.mode,
        useStreamEndpoint: !unsupported,
      };
    },

    reportProbe(sourceKey, pass, now = Date.now()) {
      const rec = get(sourceKey, now);
      rec.updatedAt = now;
      if (rec.mode !== "buffered") {
        // A probe can only come from buffered playback; a stale report after
        // promotion carries no new information.
        save();
        return;
      }
      if (pass) {
        rec.passStreak++;
        if (rec.passStreak >= rec.promoteStreak) {
          rec.mode = "streaming";
          rec.passStreak = 0;
          rec.cleanStreak = 0;
        }
      } else {
        rec.passStreak = 0;
      }
      save();
    },

    reportStreamPlayback(sourceKey, underruns, now = Date.now()) {
      const rec = get(sourceKey, now);
      rec.updatedAt = now;
      if (underruns > 0) {
        // The student heard this one — demote, and make re-promotion harder
        // than last time.
        rec.mode = "buffered";
        rec.passStreak = 0;
        rec.cleanStreak = 0;
        rec.promoteStreak = Math.min(rec.promoteStreak * 2, PROMOTE_STREAK_CAP);
      } else {
        rec.cleanStreak++;
        if (rec.cleanStreak >= FORGIVE_CLEAN_STREAK) {
          rec.promoteStreak = PROMOTE_STREAK_BASE;
          rec.cleanStreak = 0;
        }
      }
      save();
    },

    reportEndpointUnsupported(sourceKey, now = Date.now()) {
      const rec = get(sourceKey, now);
      rec.updatedAt = now;
      rec.unsupportedUntil = now + UNSUPPORTED_RETRY_MS;
      save();
    },
  };
}

/** Shared tracker for the app (localStorage-backed where available). */
export const streamHealth = createStreamHealthTracker();
