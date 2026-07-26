// client-aac/src/lib/pcm-stream.test.ts
//
// Unit tests for the streaming-TTS primitives.
//
// The Resampler tests are the important ones. The previous streaming attempt was
// abandoned because playback was choppy at network-chunk boundaries; the fix
// depends on the resampler treating a chunk SEQUENCE as one continuous signal.
// "Chunked input equals whole input" is therefore the property that has to hold
// — if it ever regresses, the seams come back.

import { Resampler } from "./pcmStreamSink";
import {
  normalizePhrase,
  setCacheablePhrases,
  isCacheablePhrase,
} from "@/services/tts-cache";

/** Split a signal into chunks of the given sizes. */
function chunk(signal: Float32Array, sizes: number[]): Float32Array[] {
  const out: Float32Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    out.push(signal.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < signal.length) out.push(signal.subarray(offset));
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A ramp is the sharpest test of interpolation continuity: any seam shows up
 *  as a step in what should be a perfectly straight line. */
function ramp(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i / n;
  return out;
}

describe("Resampler", () => {
  it("passes samples through at a 1:1 rate, delayed by exactly one sample", () => {
    // The interpolation window spans [previous chunk's last sample, ...chunk],
    // so output lags input by one source sample — a constant ~41µs delay at
    // 24kHz, not a distortion. What matters is that it is CONSTANT: a delay
    // that varied per chunk would be exactly the seam we're avoiding.
    const signal = ramp(64);
    const out = new Resampler(24000, 24000).process(signal);
    expect(out.length).toBe(64);
    expect(out[0]).toBe(0); // seeded from prev=0
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(signal[i - 1], 6);
    }
  });

  it("doubles the sample count when upsampling 24k → 48k", () => {
    const out = new Resampler(24000, 48000).process(ramp(100));
    expect(out.length).toBe(200);
  });

  it("halves the sample count when downsampling 48k → 24k", () => {
    const out = new Resampler(48000, 24000).process(ramp(100));
    expect(out.length).toBe(50);
  });

  it("produces IDENTICAL output whether input arrives whole or in chunks", () => {
    // This is the anti-seam property. Uneven chunk sizes mimic real network
    // reads, including a 1-sample chunk that lands mid-interpolation.
    const signal = ramp(500);

    const whole = new Resampler(24000, 48000).process(signal);

    const chunked = new Resampler(24000, 48000);
    const pieces = chunk(signal, [1, 7, 64, 3, 128, 200]).map((c) => chunked.process(c));
    const joined = concat(pieces);

    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(joined[i]).toBeCloseTo(whole[i], 6);
    }
  });

  it("keeps a ramp monotonic across chunk boundaries (no discontinuity)", () => {
    const signal = ramp(300);
    const r = new Resampler(24000, 48000);
    const joined = concat(chunk(signal, [13, 41, 5, 97]).map((c) => r.process(c)));

    // Skip index 0: it interpolates from the initial prev=0 seed.
    for (let i = 2; i < joined.length; i++) {
      expect(joined[i]).toBeGreaterThanOrEqual(joined[i - 1] - 1e-6);
    }
  });

  it("handles chunks shorter than one output step without losing position", () => {
    // Downsampling 48k → 16k advances 3 source samples per output sample, so
    // single-sample chunks must accumulate rather than each emitting one.
    const signal = ramp(90);
    const whole = new Resampler(48000, 16000).process(signal);

    const r = new Resampler(48000, 16000);
    const joined = concat(Array.from(signal).map((s) => r.process(Float32Array.of(s))));

    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(joined[i]).toBeCloseTo(whole[i], 6);
    }
  });
});

describe("TTS cache eligibility", () => {
  beforeEach(() => setCacheablePhrases([]));

  it("caches nothing until phrases are registered", () => {
    expect(isCacheablePhrase("yes")).toBe(false);
  });

  it("matches registered phrases regardless of case and edge punctuation", () => {
    setCacheablePhrases(["Yes", "No"]);
    expect(isCacheablePhrase("yes")).toBe(true);
    expect(isCacheablePhrase("  YES  ")).toBe(true);
    expect(isCacheablePhrase("Yes.")).toBe(true);
    expect(isCacheablePhrase("no!")).toBe(true);
  });

  it("does NOT match ordinary AI-generated utterances", () => {
    // The whole point of the narrow scope: board sentences are generated fresh
    // per turn and must never accumulate in the cache.
    setCacheablePhrases(["Yes", "No"]);
    expect(isCacheablePhrase("I want to go outside")).toBe(false);
    expect(isCacheablePhrase("yes please")).toBe(false);
    expect(isCacheablePhrase("")).toBe(false);
  });

  it("replaces the eligible set on language change", () => {
    setCacheablePhrases(["Yes", "No"]);
    setCacheablePhrases(["כן", "לא"]);
    expect(isCacheablePhrase("כן")).toBe(true);
    expect(isCacheablePhrase("yes")).toBe(false);
  });

  it("normalizes non-Latin phrases without mangling their interior", () => {
    expect(normalizePhrase(" כן. ")).toBe("כן");
    expect(normalizePhrase("Sí")).toBe("sí");
  });
});
