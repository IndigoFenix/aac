// Regression test for the WSOLA pitch shifter's overlap-add normalization.
//
// The shifter windows each frame ONCE (src·w) and must divide by Σw (the sum
// of applied windows) to get unity gain. The earlier code divided by Σw²
// (window *energy*), which leaves a residual gain ripple at the synthesis-hop
// rate whenever the overlap fraction varies — i.e. when pitching UP — heard as
// a buzzy "vibrating undertone". A constant input is the clean discriminator:
// with Σw it stays flat at its original level; with Σw² it comes out ~1.33×
// louder and rippling.
//
// pitchShifter.ts is pure numerical TS (no JSX / React), so it transpiles and
// runs fine under the server jest config via a relative import.

import { pitchShift, formantShift, processVoice, semitonesToFactor } from "../../client-aac/src/lib/pitchShifter";

const SR = 24000;

function stats(a: Float32Array, from: number, to: number) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = from; i < to; i++) {
    const v = a[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / (to - from), ripple: max - min };
}

function sine(freq: number, n: number, sr = SR): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return a;
}

/** Fundamental-frequency estimate via zero-crossing rate over an interior slice.
 *  Pitch shifting changes this; formant shifting must NOT. */
function zeroCrossHz(a: Float32Array, from: number, to: number, sr = SR): number {
  let cross = 0;
  for (let i = from + 1; i < to; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) cross++;
  return cross / 2 / ((to - from) / sr);
}

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

describe("pitchShift overlap-add normalization (unity gain)", () => {
  test("a constant signal stays flat at unity gain after an upward shift", () => {
    const N = 4800;
    const input = new Float32Array(N).fill(0.5);
    const out = pitchShift(input, semitonesToFactor(5), SR);
    expect(out.length).toBe(N);

    // Inspect a steady-state interior slice (skip the Hann ramp at both edges).
    const { mean, ripple } = stats(out, 1000, N - 1000);
    // Unity gain — NOT 0.5·Σw/Σw² (≈0.66 for Hann at 50% overlap).
    expect(mean).toBeCloseTo(0.5, 2);
    // Flat — the audible "vibration" lived in this ripple.
    expect(ripple).toBeLessThan(0.02);
  });

  test("unity gain holds for a downward shift too", () => {
    const N = 4800;
    const input = new Float32Array(N).fill(0.5);
    const out = pitchShift(input, semitonesToFactor(-4), SR);
    const { mean, ripple } = stats(out, 1000, N - 1000);
    expect(mean).toBeCloseTo(0.5, 2);
    expect(ripple).toBeLessThan(0.02);
  });

  test("a steady sine keeps a stable peak envelope after an upward shift", () => {
    const N = 9600;
    const f0 = 220;
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * f0 * i) / SR);
    const out = pitchShift(input, semitonesToFactor(7), SR);

    // Local peak per short window across the interior; a stable shift keeps
    // those peaks near 1.0. Σw² normalization made them pulse.
    const win = 240; // ~10 ms
    const peaks: number[] = [];
    for (let start = 1200; start + win < N - 1200; start += win) {
      let p = 0;
      for (let i = start; i < start + win; i++) p = Math.max(p, Math.abs(out[i]));
      peaks.push(p);
    }
    const minPeak = Math.min(...peaks);
    const maxPeak = Math.max(...peaks);
    // Envelope should be roughly flat — no large periodic dip/swell.
    expect(maxPeak - minPeak).toBeLessThan(0.2);
    expect(minPeak).toBeGreaterThan(0.8);
  });

  test("no-op for a negligible shift returns the input untouched", () => {
    const input = new Float32Array(1024).fill(0.3);
    const out = pitchShift(input, 1.0, SR);
    expect(out).toBe(input);
  });
});

describe("formantShift (cepstral envelope) preserves pitch", () => {
  test("a sine keeps its fundamental after a formant shift", () => {
    const N = 12000;
    const f0 = 300;
    const input = sine(f0, N);
    const before = zeroCrossHz(input, 2000, N - 2000);
    const out = formantShift(input, 1.3, SR); // formants up ~+4.5 st
    expect(out.length).toBe(N);
    expect(allFinite(out)).toBe(true);
    const after = zeroCrossHz(out, 2000, N - 2000);
    // Pitch (zero-crossing rate) is unchanged — only the envelope moved.
    expect(Math.abs(after - before)).toBeLessThan(15);
    expect(after).toBeCloseTo(f0, -1);
  });

  test("a negligible factor is a passthrough", () => {
    const input = sine(220, 4096);
    expect(formantShift(input, 1.0, SR)).toBe(input);
  });

  test("actually modifies a harmonic-rich signal", () => {
    // Sum of harmonics → a real spectral envelope to reshape.
    const N = 12000;
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 150 * i) / SR)
        + 0.3 * Math.sin((2 * Math.PI * 450 * i) / SR)
        + 0.2 * Math.sin((2 * Math.PI * 900 * i) / SR);
    }
    const out = formantShift(input, 1.4, SR);
    let diff = 0;
    for (let i = 2000; i < N - 2000; i++) diff += Math.abs(out[i] - input[i]);
    expect(diff).toBeGreaterThan(0);             // it reshaped the envelope
    expect(allFinite(out)).toBe(true);
    // (Zero-crossing rate isn't a valid F0 proxy for a multi-harmonic wave —
    //  pitch preservation is covered by the pure-sine test above.)
  });
});

describe("processVoice composition", () => {
  test("pitch 0 + no formant is a pure passthrough", () => {
    const input = sine(220, 4096);
    expect(processVoice(input, SR, 0)).toBe(input);
  });

  test("formant-only (pitch 0) preserves pitch but reshapes the voice", () => {
    const N = 12000;
    const f0 = 200;
    const input = sine(f0, N);
    const out = processVoice(input, SR, 0, 6); // +6 st formants, pitch unchanged
    expect(out.length).toBe(N);
    expect(allFinite(out)).toBe(true);
    expect(zeroCrossHz(out, 2000, N - 2000)).toBeCloseTo(f0, -1);
  });

  test("pitch + formant together: pitch rises, output stays finite", () => {
    const N = 12000;
    const f0 = 200;
    const input = sine(f0, N);
    const out = processVoice(input, SR, 4, 7); // pitch +4 st, formants +7 st
    expect(out.length).toBe(N);
    expect(allFinite(out)).toBe(true);
    // Pitch went UP (≈ +4 st ⇒ ×1.26). Allow generous tolerance for the estimator.
    const hz = zeroCrossHz(out, 2000, N - 2000);
    expect(hz).toBeGreaterThan(f0 * 1.1);
  });
});
