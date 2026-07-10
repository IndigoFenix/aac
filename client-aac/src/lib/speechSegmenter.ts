// client-aac/src/lib/speechSegmenter.ts
//
// Statement segmentation over a per-frame speech-probability stream (Silero
// VAD). Turns raw probabilities into start/end boundary events for the
// activity monitor's speech state machine — replacing energy thresholds,
// which can't tell speech from loudness and so never detect speech-end in a
// noisy room (the failure that ran one STT stream into Google's 305s kill).
//
// The machine:
//  - START when probability holds above `startProb` for `startFrames`
//    consecutive frames (~100ms) — noise sits near 0 for a neural VAD, so no
//    adaptive floor is needed.
//  - END when probability stays below `endProb` for `endSilenceMs` — the
//    boundary is backdated to when the probability actually dropped.
//  - VALLEY SPLIT: statements to a student essentially never exceed a few
//    seconds; if a segment reaches `maxSegmentMs` (continuous background
//    speech — TV, adults conversing), cut at the LOWEST-probability frame in
//    the recent window: the most pause-like instant, never mid-word blind
//    clipping. The split emits an end+start pair at the cut point.
//
// Pure and DOM-free so it unit-tests without a browser (see
// server/tests/speech-segmenter.test.ts).

export interface SpeechSegmenterConfig {
  /** Probability at/above which a frame counts toward speech START. */
  startProb: number;
  /** Probability below which a frame counts toward speech END (hysteresis —
   *  lower than startProb so mid-word dips don't end the segment). */
  endProb: number;
  /** Consecutive high frames required to confirm a start. */
  startFrames: number;
  /** Sustained low-probability duration that confirms an end, in ms. */
  endSilenceMs: number;
  /** Segment age at which a valley split is forced, in ms. */
  maxSegmentMs: number;
  /** How far back to search for the minimum-probability cut point, in ms. */
  valleyWindowMs: number;
  /** Duration of one probability frame, in ms (Silero: 512 samples @16k = 32). */
  frameMs: number;
}

export const DEFAULT_SEGMENTER_CONFIG: SpeechSegmenterConfig = {
  startProb: 0.55,
  endProb: 0.35,
  startFrames: 2,
  endSilenceMs: 500,
  maxSegmentMs: 10000,
  valleyWindowMs: 3000,
  frameMs: 32,
};

export type SpeechSegmentEvent =
  | { type: "start"; atMs: number }
  | { type: "end"; startMs: number; endMs: number };

export class SpeechSegmenter {
  private cfg: SpeechSegmenterConfig;
  private speaking = false;
  private segmentStartMs = 0;
  private consecutiveHigh = 0;
  /** Wall time of the last frame at/above endProb while speaking. */
  private lastAboveEndMs = 0;
  /** Recent (prob, frameEndMs) history for valley-split cut selection. */
  private recent: { prob: number; endMs: number }[] = [];

  constructor(cfg: Partial<SpeechSegmenterConfig> = {}) {
    this.cfg = { ...DEFAULT_SEGMENTER_CONFIG, ...cfg };
  }

  reset(): void {
    this.speaking = false;
    this.consecutiveHigh = 0;
    this.recent = [];
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feed one frame's speech probability; `frameEndMs` is the wall-clock time
   *  of the END of that frame. Returns zero or more boundary events. */
  push(prob: number, frameEndMs: number): SpeechSegmentEvent[] {
    const cfg = this.cfg;
    const events: SpeechSegmentEvent[] = [];

    if (!this.speaking) {
      if (prob >= cfg.startProb) {
        this.consecutiveHigh++;
        if (this.consecutiveHigh >= cfg.startFrames) {
          // Backdate the start to the beginning of the first high frame.
          this.segmentStartMs = frameEndMs - cfg.startFrames * cfg.frameMs;
          this.speaking = true;
          this.consecutiveHigh = 0;
          this.lastAboveEndMs = frameEndMs;
          this.recent = [{ prob, endMs: frameEndMs }];
          events.push({ type: "start", atMs: this.segmentStartMs });
        }
      } else {
        this.consecutiveHigh = 0;
      }
      return events;
    }

    // Speaking — maintain the valley-search history.
    this.recent.push({ prob, endMs: frameEndMs });
    while (this.recent.length && frameEndMs - this.recent[0].endMs > cfg.valleyWindowMs) {
      this.recent.shift();
    }

    if (prob >= cfg.endProb) this.lastAboveEndMs = frameEndMs;

    // END: probability has stayed below endProb for endSilenceMs. The segment
    // actually ended when the probability dropped, not now.
    if (frameEndMs - this.lastAboveEndMs >= cfg.endSilenceMs) {
      events.push({ type: "end", startMs: this.segmentStartMs, endMs: this.lastAboveEndMs });
      this.speaking = false;
      this.consecutiveHigh = 0;
      this.recent = [];
      return events;
    }

    // VALLEY SPLIT: segment hit the ceiling — cut at the most pause-like
    // recent instant and continue as a fresh segment.
    if (frameEndMs - this.segmentStartMs >= cfg.maxSegmentMs) {
      let cut = this.recent[0];
      for (const r of this.recent) {
        if (r.prob < cut.prob) cut = r;
      }
      const cutMs = Math.max(cut.endMs, this.segmentStartMs + cfg.frameMs);
      events.push({ type: "end", startMs: this.segmentStartMs, endMs: cutMs });
      events.push({ type: "start", atMs: cutMs });
      this.segmentStartMs = cutMs;
      // Drop history at/before the cut so the next split can't reuse it.
      this.recent = this.recent.filter((r) => r.endMs > cutMs);
    }

    return events;
  }
}
