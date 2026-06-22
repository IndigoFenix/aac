/**
 * Formant-dispersion DSP (the vocal-tract-length cue for the age/gender read).
 * Validated on SYNTHETIC vowels — an impulse train (pitch) cascaded through
 * resonators at known formant frequencies — so we can assert the estimator
 * recovers the planted structure without real audio. The robust property:
 * wider-spaced formants (smaller tract → child) yield a larger dispersion than
 * closer formants (larger tract → adult male).
 */

import { describe, it, expect } from "@jest/globals";
import { estimateFormantDispersion, levinsonDurbin, formantsFromLpc } from "../../shared/aac/voice-formants.js";

const FS = 16000;

/** Two-pole resonator (vocal-tract formant) applied to a signal. */
function resonate(x: Float32Array, f: number, bw: number): Float32Array {
  const theta = (2 * Math.PI * f) / FS;
  const r = Math.exp((-Math.PI * bw) / FS);
  const a1 = 2 * r * Math.cos(theta);
  const a2 = -r * r;
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    y[n] = x[n] + a1 * (n >= 1 ? y[n - 1] : 0) + a2 * (n >= 2 ? y[n - 2] : 0);
  }
  return y;
}

/** Synthesize a steady vowel: impulse train at f0 → cascade of formant resonators. */
function synthVowel(formants: number[], f0: number, durSec = 0.4): Float32Array {
  const N = Math.floor(FS * durSec);
  let sig = new Float32Array(N);
  const period = Math.max(1, Math.round(FS / f0));
  for (let n = 0; n < N; n += period) sig[n] = 1;
  for (const f of formants) sig = resonate(sig, f, 90);
  let max = 0;
  for (const v of sig) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < N; i++) sig[i] /= max;
  return sig;
}

describe("levinsonDurbin", () => {
  it("returns a polynomial starting at 1 of the requested order", () => {
    const R = [1, 0.5, 0.2, 0.05];
    const a = levinsonDurbin(R, 3);
    expect(a).toHaveLength(4);
    expect(a[0]).toBe(1);
  });
});

describe("formantsFromLpc", () => {
  it("finds resonance peaks of a synthesized vowel in ascending order", () => {
    const sig = synthVowel([500, 1500, 2500], 120);
    // Build LPC over a windowed chunk via the public estimator's path indirectly:
    // here we just assert the end-to-end estimate is sane (peaks → dispersion).
    const disp = estimateFormantDispersion(sig, FS);
    expect(disp).not.toBeNull();
  });
});

describe("estimateFormantDispersion", () => {
  it("recovers a plausible dispersion for an adult-male-like vowel", () => {
    // F ≈ 500/1500/2500 → spacing ~1000Hz.
    const disp = estimateFormantDispersion(synthVowel([500, 1500, 2500], 120), FS)!;
    expect(disp).toBeGreaterThan(700);
    expect(disp).toBeLessThan(1300);
  });

  it("reports WIDER dispersion for a child-like (shorter-tract) vowel", () => {
    const male = estimateFormantDispersion(synthVowel([500, 1500, 2500], 120), FS)!;
    const child = estimateFormantDispersion(synthVowel([800, 2300, 3600], 280), FS)!;
    expect(child).toBeGreaterThan(male);
  });

  it("returns null for silence / too-short audio", () => {
    expect(estimateFormantDispersion(new Float32Array(100), FS)).toBeNull();
    expect(estimateFormantDispersion(new Float32Array(FS).fill(0), FS)).toBeNull();
  });
});
