// shared/aac/voice-formants.ts
//
// Formant-dispersion estimation for the fast-tier voice read. Formants are the
// vocal-TRACT resonances (vs pitch = vocal-FOLD rate), so the average spacing
// between them ("dispersion") tracks vocal-tract length → body size → a better
// adult/child + gender cue than pitch alone, and one that's largely independent
// of pitch (so it resolves the high-man / low-woman overlap). Estimated per
// voiced frame via LPC (autocorrelation → Levinson-Durbin → spectral-envelope
// peak-pick), then median-pooled across the clip to wash out vowel variation.
//
// Pure DSP, no deps — operates on raw mono samples so the client computes it and
// server tests validate the math on synthetic vowels. Connected, atypical, or
// noisy speech makes this NOISY; treat the output as a soft hint only.

/** Standard first-difference pre-emphasis — flattens the spectral tilt so the
 *  upper formants aren't swamped by glottal roll-off. */
function preEmphasis(x: Float32Array, coef = 0.97): Float32Array {
  const out = new Float32Array(x.length);
  out[0] = x[0];
  for (let i = 1; i < x.length; i++) out[i] = x[i] - coef * x[i - 1];
  return out;
}

function hamming(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Autocorrelation of a windowed frame, lags 0..order. */
function autocorr(frame: Float64Array, order: number): number[] {
  const r = new Array(order + 1).fill(0);
  for (let lag = 0; lag <= order; lag++) {
    let acc = 0;
    for (let i = lag; i < frame.length; i++) acc += frame[i] * frame[i - lag];
    r[lag] = acc;
  }
  return r;
}

/** Levinson-Durbin recursion → LPC polynomial A(z) = 1 + a1 z⁻¹ + … + ap z⁻ᵖ. */
export function levinsonDurbin(R: number[], order: number): number[] {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = R[0];
  if (err <= 0) return Array.from(a);
  for (let i = 1; i <= order; i++) {
    let acc = R[i];
    for (let j = 1; j < i; j++) acc += a[j] * R[i - j];
    const k = -acc / err;
    if (!Number.isFinite(k)) break;
    const prev = a.slice(0, i);
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) { err = 1e-9; }
  }
  return Array.from(a);
}

// --- minimal complex arithmetic for root-finding ---
type Cx = { re: number; im: number };
const cmul = (a: Cx, b: Cx): Cx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const csub = (a: Cx, b: Cx): Cx => ({ re: a.re - b.re, im: a.im - b.im });
const cdiv = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im || 1e-12;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

/** Durand-Kerner: all roots of a polynomial given in DESCENDING powers (coeffs[0]
 *  = leading). Iterative, no eigensolver. Good enough for LPC orders (~18). */
function polyRoots(coeffs: number[]): Cx[] {
  const lead = coeffs[0] || 1;
  const c = coeffs.map(v => v / lead);
  const n = c.length - 1;
  if (n < 1) return [];
  const evalAt = (z: Cx): Cx => {
    let acc: Cx = { re: c[0], im: 0 };
    for (let i = 1; i <= n; i++) acc = { re: cmul(acc, z).re + c[i], im: cmul(acc, z).im };
    return acc;
  };
  const roots: Cx[] = [];
  let cur: Cx = { re: 1, im: 0 };
  const seed: Cx = { re: 0.4, im: 0.9 };
  for (let i = 0; i < n; i++) { roots.push({ ...cur }); cur = cmul(cur, seed); }
  for (let iter = 0; iter < 120; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const num = evalAt(roots[i]);
      let den: Cx = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) if (j !== i) den = cmul(den, csub(roots[i], roots[j]));
      const delta = cdiv(num, den);
      roots[i] = csub(roots[i], delta);
      maxDelta = Math.max(maxDelta, Math.hypot(delta.re, delta.im));
    }
    if (maxDelta < 1e-10) break;
  }
  return roots;
}

/**
 * Formant frequencies (Hz, ascending) from the LPC polynomial via ROOT-FINDING.
 * Each pole's angle → frequency, |pole| → bandwidth; we keep only narrow-band
 * poles in the speech range (real resonances), discarding the wide/spurious ones
 * that envelope peak-picking would wrongly count. `bwMax` is the bandwidth ceiling.
 */
export function formantsFromLpc(a: number[], sampleRate: number, bwMax = 500): number[] {
  const nyq = sampleRate / 2;
  const roots = polyRoots(a); // A(z)=Σ a[k] z^(p-k) — a[] is already descending
  const formants: number[] = [];
  for (const z of roots) {
    if (z.im <= 0) continue; // one of each conjugate pair
    const mag = Math.hypot(z.re, z.im);
    if (mag <= 0 || mag >= 1) continue;
    const freq = (Math.atan2(z.im, z.re) * sampleRate) / (2 * Math.PI);
    const bw = (-Math.log(mag) * sampleRate) / Math.PI;
    if (freq > 150 && freq < nyq - 150 && bw < bwMax) formants.push(freq);
  }
  return formants.sort((x, y) => x - y);
}

/**
 * Median formant dispersion (Hz) over the voiced frames of a clip, or null when
 * nothing usable. Dispersion ≈ c/(2L): ~900-1100Hz adult male, ~1100-1300Hz
 * adult female, higher for children (shorter tract). Rough on connected speech.
 */
export function estimateFormantDispersion(samples: Float32Array, sampleRate: number): number | null {
  if (!samples || samples.length < sampleRate * 0.05) return null;
  const pre = preEmphasis(samples);
  const frame = Math.round(sampleRate * 0.025); // 25ms
  const hop = Math.round(sampleRate * 0.0125);  // 12.5ms
  const order = Math.min(2 + Math.round(sampleRate / 1000), 20); // ~18 @16k
  const win = hamming(frame);
  const disps: number[] = [];

  for (let start = 0; start + frame <= pre.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) { const s = pre[start + i]; energy += s * s; }
    if (Math.sqrt(energy / frame) < 0.01) continue; // skip silence

    const w = new Float64Array(frame);
    for (let i = 0; i < frame; i++) w[i] = pre[start + i] * win[i];
    const R = autocorr(w, order);
    if (R[0] <= 0) continue;
    const a = levinsonDurbin(R, order);
    // The low formants (F1..F3, below ~4kHz) carry the reliable vocal-tract cue;
    // higher ones are noisy. Average their spacing.
    const formants = formantsFromLpc(a, sampleRate).filter(f => f < 4000).slice(0, 3);
    if (formants.length < 2) continue;
    let sum = 0;
    for (let i = 1; i < formants.length; i++) sum += formants[i] - formants[i - 1];
    disps.push(sum / (formants.length - 1));
  }

  if (!disps.length) return null;
  disps.sort((x, y) => x - y);
  return Math.round(disps[Math.floor(disps.length / 2)]);
}
