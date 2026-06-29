// shared/call/active-speaker.ts
//
// Per-peer audio-activity detection over a set of remote call streams. Used for:
//   - the "auto" video layout (promote whoever is currently speaking), and
//   - the Web-Speech echo guard (the clinician already needed "is any remote
//     audio playing right now" to drop self-transcripts that are really the mic
//     hearing the speakers) — derived from the same RMS data, no second graph.
//
// Framework-agnostic: it owns one AudioContext + one AnalyserNode per stream and
// polls their RMS. `setStreams` (re)builds the graph as peers join/leave; the
// caller drives it from a React effect. Loudest-above-threshold peer wins, with
// a short hold so the spotlight doesn't flicker between turns.

export interface ActiveSpeakerOptions {
  /** RMS above which a stream counts as "speaking". Default 0.02. */
  threshold?: number;
  /** ms a new peer must stay loudest before it takes the spotlight. Default 600. */
  holdMs?: number;
  /** Poll interval (ms). Default 120. */
  pollMs?: number;
  /** Fired (only on change) with the current active speaker's personId, or null. */
  onActiveSpeaker?: (personId: string | null) => void;
  /** Fired every poll with whether ANY remote stream is currently making sound —
   *  the echo-guard signal. */
  onAnyActive?: (anyActive: boolean) => void;
}

interface Tracked {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  data: Uint8Array;
}

export interface ActiveSpeakerDetector {
  /** Replace the tracked streams (keyed by personId). Safe to call repeatedly. */
  setStreams: (streams: Map<string, MediaStream>) => void;
  /** Tear down the AudioContext and stop polling. */
  stop: () => void;
}

/** Create a detector. Returns null if Web Audio is unavailable (no-op for caller). */
export function createActiveSpeakerDetector(opts: ActiveSpeakerOptions): ActiveSpeakerDetector | null {
  const AudioCtx: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioCtx) return null;

  const threshold = opts.threshold ?? 0.02;
  const holdMs = opts.holdMs ?? 600;
  const pollMs = opts.pollMs ?? 120;

  const ctx: AudioContext = new AudioCtx();
  const tracked = new Map<string, Tracked>();
  let current: string | null = null;
  // The candidate that has been loudest since `candidateSince`.
  let candidate: string | null = null;
  let candidateSince = 0;

  const rmsOf = (t: Tracked): number => {
    t.analyser.getByteTimeDomainData(t.data);
    let sum = 0;
    for (let i = 0; i < t.data.length; i++) { const v = (t.data[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / t.data.length);
  };

  const now = () => Date.now();

  const interval = setInterval(() => {
    let loudest: string | null = null;
    let loudestRms = threshold;
    let anyActive = false;
    for (const [pid, t] of tracked) {
      const rms = rmsOf(t);
      if (rms > threshold) anyActive = true;
      if (rms > loudestRms) { loudestRms = rms; loudest = pid; }
    }
    opts.onAnyActive?.(anyActive);

    // Debounce the spotlight: a peer must hold "loudest" for holdMs to take over.
    if (loudest !== candidate) { candidate = loudest; candidateSince = now(); }
    if (candidate !== current && now() - candidateSince >= holdMs) {
      current = candidate;
      opts.onActiveSpeaker?.(current);
    }
    // If the current speaker disappeared entirely, clear immediately.
    if (current && !tracked.has(current)) {
      current = candidate;
      opts.onActiveSpeaker?.(current);
    }
  }, pollMs);

  const setStreams = (streams: Map<string, MediaStream>) => {
    // Drop tracked entries whose stream left.
    for (const [pid, t] of Array.from(tracked)) {
      if (!streams.has(pid)) {
        try { t.source.disconnect(); } catch { /* ignore */ }
        tracked.delete(pid);
      }
    }
    // Add new streams that carry audio.
    for (const [pid, stream] of streams) {
      if (tracked.has(pid)) continue;
      if (stream.getAudioTracks().length === 0) continue;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        tracked.set(pid, { analyser, source, data: new Uint8Array(analyser.fftSize) });
      } catch { /* ignore — stream may be video-only or detached */ }
    }
  };

  const stop = () => {
    clearInterval(interval);
    for (const t of tracked.values()) { try { t.source.disconnect(); } catch { /* ignore */ } }
    tracked.clear();
    try { void ctx.close(); } catch { /* ignore */ }
  };

  return { setStreams, stop };
}
