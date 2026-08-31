// Tests for the pure pieces of google-stt-service: silence-aware chunk
// boundary planning and sentence-aware segment grouping. These run without the
// Google STT API (the SpeechClient is only constructed lazily on a real call).

import {
  planSilenceAwareChunks,
  wordsToSegments,
  transcribeSegments,
  normalizeSttConfidence,
  __setSttClientForTests,
} from '../services/voice/google-stt-service';
import { setDisclosureSink } from '../services/processorDisclosure';

// This suite drives the REAL egress code, which now writes an AKIM §18.5
// disclosure row per send. Without a sink the default one lazily imports
// activityLogService -> server/db.ts, dragging a Postgres pool into a DB-free
// suite (and failing late, after the test env has torn down). The rows are not
// this suite's subject, so they go nowhere.
beforeEach(() => setDisclosureSink(() => {}));
afterEach(() => setDisclosureSink(null));

const SAMPLE_RATE = 16000;
const FRAME_BYTES = 2; // mono 16-bit

/**
 * Build a LINEAR16 mono PCM buffer of `seconds`, loud everywhere except the
 * given silent windows (each [startSec, endSec)).
 */
function makePcm(seconds: number, silentWindows: Array<[number, number]>): Buffer {
  const total = Math.floor(seconds * SAMPLE_RATE);
  const buf = Buffer.alloc(total * FRAME_BYTES);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    const silent = silentWindows.some(([a, b]) => t >= a && t < b);
    // Loud = near full-scale; silent = 0.
    buf.writeInt16LE(silent ? 0 : 20000 * (i % 2 ? 1 : -1), i * FRAME_BYTES);
  }
  return buf;
}

describe('planSilenceAwareChunks', () => {
  it('returns a single span when audio is under the max window', () => {
    const pcm = makePcm(40, []); // 40s < 55s max
    const b = planSilenceAwareChunks(pcm, SAMPLE_RATE, FRAME_BYTES);
    expect(b).toEqual([0, pcm.length]);
  });

  it('cuts inside a silent gap that falls within the [25s,55s] window', () => {
    // 80s of audio with a clear silence at 45–46s — the cut should land there.
    const pcm = makePcm(80, [[45, 46]]);
    const b = planSilenceAwareChunks(pcm, SAMPLE_RATE, FRAME_BYTES);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe(pcm.length);
    expect(b.length).toBe(3); // one interior cut
    const cutSec = b[1] / (SAMPLE_RATE * FRAME_BYTES);
    expect(cutSec).toBeGreaterThanOrEqual(45);
    expect(cutSec).toBeLessThanOrEqual(46);
  });

  it('never exceeds the ~55s max window even with no silence', () => {
    const pcm = makePcm(120, []); // loud throughout
    const b = planSilenceAwareChunks(pcm, SAMPLE_RATE, FRAME_BYTES);
    for (let i = 1; i < b.length; i++) {
      const spanSec = (b[i] - b[i - 1]) / (SAMPLE_RATE * FRAME_BYTES);
      expect(spanSec).toBeLessThanOrEqual(55 + 0.001);
    }
    // Boundaries are strictly increasing and frame-aligned.
    for (let i = 1; i < b.length; i++) {
      expect(b[i]).toBeGreaterThan(b[i - 1]);
      expect(b[i] % FRAME_BYTES).toBe(0);
    }
  });
});

describe('wordsToSegments', () => {
  const w = (word: string, startMs: number, endMs: number) => ({ word, startMs, endMs });

  it('breaks a line on sentence-final punctuation', () => {
    const segs = wordsToSegments([
      w('Hello', 0, 300),
      w('there.', 300, 700),
      w('How', 800, 1000),
      w('are', 1000, 1200),
      w('you?', 1200, 1600),
    ]);
    expect(segs.map((s) => s.text)).toEqual(['Hello there.', 'How are you?']);
    expect(segs[0].startMs).toBe(0);
    expect(segs[0].endMs).toBe(700);
    expect(segs[1].startMs).toBe(800);
    expect(segs[1].endMs).toBe(1600);
  });

  it('breaks on the word-count cap when no punctuation appears', () => {
    const words = Array.from({ length: 27 }, (_, i) => w(`w${i}`, i * 100, i * 100 + 90));
    const segs = wordsToSegments(words);
    // 12 + 12 + 3 with the 12-word cap.
    expect(segs.length).toBe(3);
    expect(segs[0].text.split(' ').length).toBe(12);
  });

  it('breaks on the duration cap for long uninterrupted speech', () => {
    // 4 words each spanning 2s → 8s total, no punctuation; 6s cap forces a split.
    const words = [w('a', 0, 2000), w('b', 2000, 4000), w('c', 4000, 6000), w('d', 6000, 8000)];
    const segs = wordsToSegments(words);
    expect(segs.length).toBeGreaterThan(1);
  });
});

// The recogniser's confidence is the only per-clip signal that a transcript may
// be a fluent invention rather than something anyone said. It was being dropped
// on the floor here, so a mis-decode reached the AAC board indistinguishable
// from a clean one. See project_stt_fluent_misrecognition.
describe('transcribeSegments — confidence reporting', () => {
  afterEach(() => __setSttClientForTests(null));

  const fakeClient = (results: any[]) => {
    __setSttClientForTests({ recognize: async () => [{ results }] } as any);
  };

  const alt = (transcript: string, confidence?: number) => ({
    alternatives: [{ transcript, ...(confidence === undefined ? {} : { confidence }) }],
  });

  it('reports the LOWEST confidence across results — one bad stretch taints the clip', async () => {
    fakeClient([alt('I am the mother of', 0.88), alt('media', 0.34)]);
    const r = await transcribeSegments(makePcm(2, []));
    expect(r.confidence).toBeCloseTo(0.34);
  });

  it('is undefined when the model reported no usable score', async () => {
    fakeClient([alt('hello'), alt('again', 0)]);
    const r = await transcribeSegments(makePcm(2, []));
    expect(r.confidence).toBeUndefined();
  });
});

describe('normalizeSttConfidence', () => {
  it('keeps real scores', () => {
    expect(normalizeSttConfidence(0.42)).toBe(0.42);
    expect(normalizeSttConfidence(1)).toBe(1);
  });

  // Google writes 0.0 for "not available"; reading that as "almost certainly
  // wrong" would flag every transcript from a model that omits the field.
  it('treats absent / 0.0 / out-of-range values as unknown, not as low', () => {
    expect(normalizeSttConfidence(0)).toBeUndefined();
    expect(normalizeSttConfidence(undefined)).toBeUndefined();
    expect(normalizeSttConfidence(NaN)).toBeUndefined();
    expect(normalizeSttConfidence(1.5)).toBeUndefined();
    expect(normalizeSttConfidence('0.9')).toBeUndefined();
  });
});
