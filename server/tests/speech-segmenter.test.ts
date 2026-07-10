/**
 * Tests for the neural-VAD statement segmenter
 * (client-aac/src/lib/speechSegmenter.ts) — pure TypeScript, no DOM.
 *
 * The segmenter turns Silero's per-frame speech probabilities into
 * start/end boundary events, including the valley split that keeps one
 * segment from running into Google STT's 305s stream kill when continuous
 * background speech (TV, adults conversing) never pauses.
 */

import { describe, it, expect } from "@jest/globals";
import { SpeechSegmenter, type SpeechSegmentEvent } from "../../client-aac/src/lib/speechSegmenter";

const FRAME_MS = 32;

/** Feed a probability sequence starting at t0; returns all emitted events. */
function feed(seg: SpeechSegmenter, probs: number[], t0 = 10_000): SpeechSegmentEvent[] {
  const events: SpeechSegmentEvent[] = [];
  probs.forEach((p, i) => {
    events.push(...seg.push(p, t0 + (i + 1) * FRAME_MS));
  });
  return events;
}

describe("SpeechSegmenter", () => {
  it("stays idle through loud non-speech (low probability) frames", () => {
    const seg = new SpeechSegmenter();
    // A dishwasher is loud but Silero scores it near zero.
    const events = feed(seg, Array(100).fill(0.1));
    expect(events).toEqual([]);
    expect(seg.isSpeaking).toBe(false);
  });

  it("starts after sustained high probability, backdating to the first high frame", () => {
    const seg = new SpeechSegmenter({ startFrames: 2 });
    const events = feed(seg, [0.1, 0.9, 0.9]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("start");
    // Frame 2 (end 10_064) and frame 3 (end 10_096) were high; the start is
    // backdated 2 frames from the confirming frame's end: 10_096 - 64.
    expect((events[0] as any).atMs).toBe(10_032);
  });

  it("does not start on a single-frame blip", () => {
    const seg = new SpeechSegmenter({ startFrames: 2 });
    const events = feed(seg, [0.9, 0.1, 0.9, 0.1, 0.9, 0.1]);
    expect(events).toEqual([]);
  });

  it("ends after sustained low probability, backdating to when speech dropped", () => {
    const seg = new SpeechSegmenter({ startFrames: 2, endSilenceMs: 200 });
    // ~1s of speech, then low probability.
    const events = feed(seg, [...Array(30).fill(0.9), ...Array(12).fill(0.05)]);
    const end = events.find((e) => e.type === "end") as Extract<SpeechSegmentEvent, { type: "end" }>;
    expect(end).toBeDefined();
    // Last high frame is #30 (end = 10_000 + 30*32).
    expect(end.endMs).toBe(10_000 + 30 * FRAME_MS);
    expect(end.startMs).toBeLessThan(end.endMs);
    expect(seg.isSpeaking).toBe(false);
  });

  it("mid-word dips between endProb and startProb neither end nor extend confirmation", () => {
    const seg = new SpeechSegmenter({ startProb: 0.55, endProb: 0.35, startFrames: 2, endSilenceMs: 300 });
    // Speech with dips to 0.4 (above endProb) — should stay one segment.
    const pattern = [0.9, 0.9, 0.4, 0.9, 0.4, 0.4, 0.9, 0.9, 0.4, 0.9];
    const events = feed(seg, [...pattern, ...pattern, ...pattern]);
    expect(events.filter((e) => e.type === "end")).toHaveLength(0);
    expect(seg.isSpeaking).toBe(true);
  });

  it("valley-splits a never-ending segment at the least-speech-like recent frame", () => {
    const seg = new SpeechSegmenter({
      startFrames: 2,
      endSilenceMs: 500,
      maxSegmentMs: 2_000,
      valleyWindowMs: 1_000,
    });
    // Continuous "speech" with one clear dip (0.45 — above endProb, so no
    // natural end) placed inside the valley window before the ceiling hits.
    const probs = Array(80).fill(0.9);
    probs[55] = 0.45; // dip at frame 56 → end 10_000 + 56*32 = 11_792
    const events = feed(seg, probs);

    const ends = events.filter((e) => e.type === "end") as Extract<SpeechSegmentEvent, { type: "end" }>[];
    const starts = events.filter((e) => e.type === "start");
    expect(ends).toHaveLength(1);
    expect(starts).toHaveLength(2); // original start + post-split restart
    expect(ends[0].endMs).toBe(10_000 + 56 * FRAME_MS); // cut at the dip
    // The new segment begins exactly at the cut.
    expect((starts[1] as any).atMs).toBe(ends[0].endMs);
    expect(seg.isSpeaking).toBe(true);
  });

  it("keeps splitting on a long continuous segment without reusing old cut points", () => {
    const seg = new SpeechSegmenter({
      startFrames: 2,
      endSilenceMs: 500,
      maxSegmentMs: 1_000,
      valleyWindowMs: 500,
    });
    // ~5s of continuous flat speech — every split must advance.
    const events = feed(seg, Array(160).fill(0.9));
    const ends = events.filter((e) => e.type === "end") as Extract<SpeechSegmentEvent, { type: "end" }>[];
    expect(ends.length).toBeGreaterThanOrEqual(3);
    for (const e of ends) expect(e.endMs).toBeGreaterThan(e.startMs);
    for (let i = 1; i < ends.length; i++) {
      expect(ends[i].startMs).toBe(ends[i - 1].endMs); // segments tile exactly
      expect(ends[i].endMs).toBeGreaterThan(ends[i - 1].endMs);
    }
  });

  it("a statement pause below endProb ends the segment even amid room noise scores", () => {
    const seg = new SpeechSegmenter({ startFrames: 2, endSilenceMs: 400 });
    // Statement (1s) → pause with noise-floor probabilities (~0.1) → next statement.
    const events = feed(seg, [
      ...Array(30).fill(0.9),
      ...Array(20).fill(0.1),
      ...Array(30).fill(0.9),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["start", "end", "start"]);
  });

  it("reset() clears mid-segment state", () => {
    const seg = new SpeechSegmenter({ startFrames: 2 });
    feed(seg, [0.9, 0.9, 0.9]);
    expect(seg.isSpeaking).toBe(true);
    seg.reset();
    expect(seg.isSpeaking).toBe(false);
    // Fresh start required after reset.
    expect(feed(seg, [0.9], 20_000)).toEqual([]);
    expect(feed(seg, [0.9], 20_032)).toHaveLength(1);
  });
});
