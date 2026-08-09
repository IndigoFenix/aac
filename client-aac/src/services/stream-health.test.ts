// Tests for the adaptive streaming-vs-buffered TTS policy.
//
// Two halves: the pure jitter-buffer simulation (would these chunk timings
// have stuttered?) and the per-source mode tracker (buffered until a streak
// of clean probes; demoted on real underruns with a doubling re-promotion
// cost; endpoint-unsupported memory with TTL).

import {
  simulateStreamPlayback,
  createStreamHealthTracker,
  type ChunkTiming,
} from "./stream-health";

// 24 kHz s16 mono, matching the client-direct PCM path.
const BPS = 24000 * 2;
const PREBUFFER = 120;
/** ms of audio → bytes at the test rate. */
const audioBytes = (ms: number) => (ms / 1000) * BPS;

const sim = (chunks: ChunkTiming[]) =>
  simulateStreamPlayback(chunks, { bytesPerSecond: BPS, prebufferMs: PREBUFFER });

describe("simulateStreamPlayback", () => {
  test("fast steady delivery passes", () => {
    // 200ms of audio landing every 100ms — buffer grows monotonically.
    const chunks = [0, 100, 200, 300, 400].map((atMs) => ({
      atMs,
      bytes: audioBytes(200),
    }));
    const r = sim(chunks);
    expect(r.underruns).toBe(0);
    expect(r.pass).toBe(true);
  });

  test("delivery slower than realtime underruns repeatedly", () => {
    // 100ms of audio every 200ms — can't sustain playback.
    const chunks = [0, 200, 400, 600, 800, 1000].map((atMs) => ({
      atMs,
      bytes: audioBytes(100),
    }));
    const r = sim(chunks);
    expect(r.underruns).toBeGreaterThanOrEqual(2);
    expect(r.pass).toBe(false);
  });

  test("a mid-stream stall underruns even when the average rate is fine", () => {
    const chunks = [
      { atMs: 0, bytes: audioBytes(200) }, // gate opens (200 ≥ 120)
      { atMs: 400, bytes: audioBytes(600) }, // 400ms gap > 200ms buffered
    ];
    const r = sim(chunks);
    expect(r.underruns).toBe(1);
    expect(r.pass).toBe(false);
  });

  test("utterance shorter than the prebuffer passes trivially", () => {
    // Playback would never have started before the stream ended — streaming
    // and buffered are indistinguishable here.
    const r = sim([{ atMs: 0, bytes: audioBytes(100) }]);
    expect(r.underruns).toBe(0);
    expect(r.minHeadroomMs).toBe(Infinity);
    expect(r.pass).toBe(true);
  });

  test("razor-thin headroom fails the margin even without an underrun", () => {
    // 100ms of audio every 130ms: no underrun within these four chunks, but
    // headroom decays to 40ms — under the 60ms margin.
    const chunks = [0, 130, 260, 390].map((atMs) => ({
      atMs,
      bytes: audioBytes(100),
    }));
    const r = sim(chunks);
    expect(r.underruns).toBe(0);
    expect(r.minHeadroomMs).toBeLessThan(60);
    expect(r.pass).toBe(false);
  });

  test("no chunks yields a vacuous pass (caller skips reporting)", () => {
    const r = sim([]);
    expect(r.underruns).toBe(0);
    expect(r.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const T0 = 1_000_000; // deterministic clock base
const HOUR = 60 * 60 * 1000;

describe("stream-health tracker", () => {
  test("fresh source starts buffered with the stream endpoint enabled", () => {
    const t = createStreamHealthTracker(fakeStorage());
    expect(t.decide("utterance:m2", T0)).toEqual({
      mode: "buffered",
      useStreamEndpoint: true,
    });
  });

  test("a streak of passing probes promotes to streaming", () => {
    const t = createStreamHealthTracker(fakeStorage());
    t.reportProbe("s", true, T0);
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("a failing probe resets the streak", () => {
    const t = createStreamHealthTracker(fakeStorage());
    t.reportProbe("s", true, T0);
    t.reportProbe("s", true, T0);
    t.reportProbe("s", false, T0);
    t.reportProbe("s", true, T0);
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("real underruns demote and double the re-promotion requirement", () => {
    const t = createStreamHealthTracker(fakeStorage());
    for (let i = 0; i < 3; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");

    t.reportStreamPlayback("s", 2, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");

    // Now needs 6 consecutive passes, not 3.
    for (let i = 0; i < 5; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("repeated demotions cap the requirement at 24", () => {
    const t = createStreamHealthTracker(fakeStorage());
    // Demote many times (each promote-then-underrun doubles the requirement).
    let needed = 3;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < needed; i++) t.reportProbe("s", true, T0);
      expect(t.decide("s", T0).mode).toBe("streaming");
      t.reportStreamPlayback("s", 1, T0);
      needed = Math.min(needed * 2, 24);
    }
    // Requirement is now capped: 24 passes suffice.
    for (let i = 0; i < 23; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("a long clean streaming run forgives past demotions", () => {
    const t = createStreamHealthTracker(fakeStorage());
    // Promote, demote (requirement → 6), re-promote.
    for (let i = 0; i < 3; i++) t.reportProbe("s", true, T0);
    t.reportStreamPlayback("s", 1, T0);
    for (let i = 0; i < 6; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");

    // 12 clean plays reset the requirement to base…
    for (let i = 0; i < 12; i++) t.reportStreamPlayback("s", 0, T0);
    // …so the next demotion doubles from 3, needing 6 (not 12).
    t.reportStreamPlayback("s", 3, T0);
    for (let i = 0; i < 5; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("buffered");
    t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("stale probe reports after promotion are ignored", () => {
    const t = createStreamHealthTracker(fakeStorage());
    for (let i = 0; i < 3; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
    t.reportProbe("s", false, T0); // late buffered-mode report
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("endpoint-unsupported disables the stream endpoint until the TTL lapses", () => {
    const t = createStreamHealthTracker(fakeStorage());
    t.reportEndpointUnsupported("he", T0);
    expect(t.decide("he", T0 + HOUR)).toEqual({
      mode: "buffered",
      useStreamEndpoint: false,
    });
    expect(t.decide("he", T0 + 25 * HOUR).useStreamEndpoint).toBe(true);
  });

  test("sources are tracked independently", () => {
    const t = createStreamHealthTracker(fakeStorage());
    for (let i = 0; i < 3; i++) t.reportProbe("utterance:m2", true, T0);
    expect(t.decide("utterance:m2", T0).mode).toBe("streaming");
    expect(t.decide("avatar:m2", T0).mode).toBe("buffered");
  });

  test("state survives a reload via storage", () => {
    const storage = fakeStorage();
    const t1 = createStreamHealthTracker(storage);
    for (let i = 0; i < 3; i++) t1.reportProbe("s", true, T0);
    expect(t1.decide("s", T0).mode).toBe("streaming");

    const t2 = createStreamHealthTracker(storage);
    expect(t2.decide("s", T0).mode).toBe("streaming");
  });

  test("null storage still tracks in memory", () => {
    const t = createStreamHealthTracker(null);
    for (let i = 0; i < 3; i++) t.reportProbe("s", true, T0);
    expect(t.decide("s", T0).mode).toBe("streaming");
  });

  test("corrupt stored state is discarded, not fatal", () => {
    const storage = fakeStorage();
    storage.setItem("aac.tts.streamHealth.v1", "{not json");
    const t = createStreamHealthTracker(storage);
    expect(t.decide("s", T0).mode).toBe("buffered");
  });
});
