// shared/aac/pitch-shifter.ts
// Voice transposition for speech audio: pitch shift + (optional) formant shift.
// Shared between the AAC client (live playback pitch, via pitchByTag) and the
// clinician client (voice-preview pitch in AAC Settings) — one implementation,
// so the preview sounds exactly like the session.
//
// PITCH (WSOLA time-stretch → linear resample): shifts pitch while preserving
// duration. Note this stage is a duration-preserving *varispeed* — it moves the
// formants (spectral envelope) up with the pitch, locked at the original ratio.
// That's why pitch alone sounds like "the same speaker, higher", not younger.
//
// FORMANT (cepstral spectral-envelope warp): independently moves the formants
// to simulate a different vocal-tract length. A *shorter* tract (factor > 1)
// pushes formants up → a smaller/younger-sounding speaker. Combining a modest
// pitch shift with a larger formant shift is what reads as "child", because a
// child's formant-to-pitch ratio differs from an adult's.
//
// `processVoice` composes the two: it runs the pitch stage, then applies a
// formant correction so the final pitch and formant land on independent
// targets.

/** Convert semitones to linear pitch factor. +2 → ~1.122, -3 → ~0.841 */
export function semitonesToFactor(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/**
 * Transpose a voice with independent pitch and formant targets.
 *
 * @param samples           PCM samples (-1..1)
 * @param sampleRate        e.g. 24000
 * @param pitchSemitones    pitch (F0) shift in semitones
 * @param formantSemitones  TOTAL formant shift in semitones, relative to the
 *                          original voice. `undefined` → skip the formant stage
 *                          entirely (legacy varispeed: formants follow pitch).
 */
export function processVoice(
  samples: Float32Array,
  sampleRate: number,
  pitchSemitones: number,
  formantSemitones?: number,
): Float32Array {
  const pf = semitonesToFactor(pitchSemitones || 0);
  const pitched = Math.abs(pf - 1) > 0.005 ? pitchShift(samples, pf, sampleRate) : samples;

  // No formant control requested → keep the pitch stage's coupled (varispeed)
  // formants, matching the original behaviour for the companion/student voices.
  if (formantSemitones == null) return pitched;

  // The pitch stage already moved formants by `pf`; correct by `ff / pf` so the
  // final formant lands on the requested `ff` while pitch stays at `pf`.
  const ff = semitonesToFactor(formantSemitones);
  const correction = ff / pf;
  if (Math.abs(correction - 1) < 0.01) return pitched;
  return formantShift(pitched, correction, sampleRate);
}

/**
 * Pitch-shift a Float32Array of audio samples.
 * @param samples  PCM samples in -1..1 range
 * @param pitchFactor  >1 = higher pitch, <1 = lower pitch
 * @param sampleRate  Sample rate of the audio (e.g. 24000)
 * @returns New Float32Array with same length, pitch-shifted
 */
export function pitchShift(
  samples: Float32Array,
  pitchFactor: number,
  sampleRate: number,
): Float32Array {
  if (samples.length < 256 || Math.abs(pitchFactor - 1.0) < 0.005) {
    return samples;
  }

  // Clamp to reasonable range (±1 octave)
  const clamped = Math.max(0.5, Math.min(2.0, pitchFactor));

  // Step 1: WSOLA time-stretch by the pitch factor
  //   - pitchFactor > 1 → stretch (longer output) → resample shrinks it back → higher pitch
  //   - pitchFactor < 1 → compress (shorter output) → resample expands it back → lower pitch
  const stretched = wsolaStretch(samples, clamped, sampleRate);

  // Step 2: Linear-resample back to original length
  return linearResample(stretched, samples.length);
}

// ---------------------------------------------------------------------------
// WSOLA time-stretcher
// ---------------------------------------------------------------------------

// Tuning constants (optimised for speech at 24 kHz)
const WINDOW_MS = 30;     // analysis/synthesis window length in ms
const SEARCH_MS = 12;     // ± cross-correlation search range in ms

function wsolaStretch(
  input: Float32Array,
  factor: number,
  sampleRate: number,
): Float32Array {
  const windowSize = Math.round(sampleRate * WINDOW_MS / 1000) | 0;
  const Ha = (windowSize >>> 1); // analysis hop = 50 % overlap
  const Hs = Math.round(Ha * factor); // synthesis hop
  const maxSearch = Math.round(sampleRate * SEARCH_MS / 1000) | 0;

  // Pre-compute Hann window
  const win = buildHann(windowSize);

  const numFrames = Math.max(1, Math.floor((input.length - windowSize) / Ha) + 1);
  const outLen = (numFrames - 1) * Hs + windowSize;
  const output = new Float32Array(outLen);
  const norm = new Float32Array(outLen); // Σ of applied windows, for unity-gain overlap-add

  let drift = 0; // accumulated offset from cross-correlation search

  for (let f = 0; f < numFrames; f++) {
    const synthPos = f * Hs;

    if (f === 0) {
      // First frame — copy directly
      addWindowed(input, 0, output, synthPos, win, norm, windowSize, input.length, outLen);
      continue;
    }

    // Expected read position in input (with drift correction)
    const expected = f * Ha + drift;
    const lo = Math.max(0, Math.round(expected) - maxSearch);
    const hi = Math.min(input.length - windowSize, Math.round(expected) + maxSearch);

    let bestPos = Math.min(Math.max(0, Math.round(expected)), input.length - windowSize);

    if (lo < hi && synthPos > 0) {
      // Find best overlap via normalised cross-correlation with existing output
      const overlapLen = Math.min(windowSize, Hs < windowSize ? windowSize - Hs : 0);
      if (overlapLen > 64) {
        bestPos = searchBestPos(input, output, synthPos, lo, hi, overlapLen, win);
      }
    }

    // Track how far we drifted from the ideal read position
    drift += bestPos - expected;

    addWindowed(input, bestPos, output, synthPos, win, norm, windowSize, input.length, outLen);
  }

  // Normalise by the sum of applied windows. Each frame's signal is windowed
  // ONCE (src·w), so dividing by Σw gives a true crossfade (weighted average,
  // weights w) and exact unity gain at every sample regardless of how the
  // frames overlap. Dividing by Σw² instead — the classic mistake — leaves a
  // residual gain ripple at the synthesis-hop rate whenever the overlap
  // fraction varies (i.e. when pitching up), heard as a buzzy undertone.
  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 1e-6) output[i] /= norm[i];
  }

  return output;
}

/** Overlap-add a windowed frame into the output buffer and accumulate normalisation. */
function addWindowed(
  src: Float32Array, srcOff: number,
  dst: Float32Array, dstOff: number,
  win: Float32Array, norm: Float32Array,
  winLen: number, srcLen: number, dstLen: number,
) {
  const end = Math.min(winLen, srcLen - srcOff, dstLen - dstOff);
  for (let i = 0; i < end; i++) {
    const w = win[i];
    dst[dstOff + i] += src[srcOff + i] * w;
    norm[dstOff + i] += w; // Σw (not Σw²): signal is windowed once → divide by Σw
  }
}

/** Search for the candidate position with best normalised cross-correlation. */
function searchBestPos(
  input: Float32Array, output: Float32Array,
  synthPos: number,
  lo: number, hi: number,
  overlapLen: number, win: Float32Array,
): number {
  let bestPos = lo;
  let bestCorr = -Infinity;

  // Down-sample the search to every 2nd position for speed when range is large
  const step = (hi - lo > 200) ? 2 : 1;

  for (let pos = lo; pos <= hi; pos += step) {
    let corr = 0;
    let eA = 0;
    let eB = 0;
    for (let i = 0; i < overlapLen; i++) {
      const a = output[synthPos + i];
      const b = input[pos + i] * win[i];
      corr += a * b;
      eA += a * a;
      eB += b * b;
    }
    const denom = Math.sqrt(eA * eB);
    const ncc = denom > 1e-10 ? corr / denom : 0;
    if (ncc > bestCorr) {
      bestCorr = ncc;
      bestPos = pos;
    }
  }
  return bestPos;
}

// ---------------------------------------------------------------------------
// Linear resampler
// ---------------------------------------------------------------------------

function linearResample(input: Float32Array, targetLen: number): Float32Array {
  const len = input.length;
  if (len === targetLen || len < 2) return input;

  const output = new Float32Array(targetLen);
  const ratio = (len - 1) / (targetLen - 1);

  for (let i = 0; i < targetLen; i++) {
    const srcPos = i * ratio;
    const idx = srcPos | 0; // fast floor
    const frac = srcPos - idx;
    output[i] = idx + 1 < len
      ? input[idx] * (1 - frac) + input[idx + 1] * frac
      : input[idx] ?? 0;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Hann window cache (avoid rebuilding every call)
// ---------------------------------------------------------------------------

const hannCache = new Map<number, Float32Array>();

function buildHann(size: number): Float32Array {
  let w = hannCache.get(size);
  if (w) return w;
  w = new Float32Array(size);
  const k = 2 * Math.PI / (size - 1);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(k * i));
  hannCache.set(size, w);
  return w;
}

// ---------------------------------------------------------------------------
// Cepstral formant (spectral-envelope) shifter
// ---------------------------------------------------------------------------
//
// For each STFT frame: estimate the smooth spectral envelope (formants) by
// cepstral liftering, warp that envelope along frequency by `factor`, and
// re-apply it while keeping the original fine structure (harmonics) and phase.
// Pitch is therefore unchanged; only the vocal-tract resonances move.

const FFT_SIZE = 1024;
const FFT_HOP = 256; // 75% overlap → Hann analysis+synthesis is COLA-constant

/** In-place iterative radix-2 FFT (DIT). Length must be a power of two. */
function fftInPlace(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Shift the spectral envelope (formants) by `factor` without changing pitch.
 * factor > 1 → formants up (shorter vocal tract / younger). Duration preserved.
 */
export function formantShift(
  samples: Float32Array,
  factor: number,
  sampleRate: number,
): Float32Array {
  if (samples.length < FFT_SIZE || Math.abs(factor - 1) < 0.01) return samples;

  const N = FFT_SIZE;
  const half = N >> 1;
  const hop = FFT_HOP;
  const win = buildHann(N);
  // Liftering cutoff (quefrency): keep coefficients below the pitch period so
  // the envelope tracks formants, not individual harmonics. ~34 bins at 24 kHz.
  const lifter = Math.max(8, Math.round(sampleRate / 700));
  const EPS = 1e-6;

  const out = new Float32Array(samples.length);
  const norm = new Float32Array(samples.length);

  // Reused per-frame scratch buffers.
  const re = new Float32Array(N), im = new Float32Array(N);
  const cre = new Float32Array(N), cim = new Float32Array(N);
  const logEnv = new Float32Array(N);

  for (let start = 0; start + N <= samples.length; start += hop) {
    // Analysis window → spectrum.
    for (let i = 0; i < N; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im, false);

    // Log-magnitude → cepstrum (IFFT of log|X|).
    for (let k = 0; k < N; k++) {
      cre[k] = Math.log(Math.hypot(re[k], im[k]) + EPS);
      cim[k] = 0;
    }
    fftInPlace(cre, cim, true);

    // Lifter: keep low quefrency (and its mirror) → smooth log-envelope.
    for (let q = lifter + 1; q < N - lifter; q++) { cre[q] = 0; cim[q] = 0; }
    fftInPlace(cre, cim, false);
    for (let k = 0; k < N; k++) logEnv[k] = cre[k];

    // Warp: new envelope at bin k is the old envelope at k/factor, so a peak at
    // bin k0 moves up to k0*factor. Apply as a per-bin gain that swaps the old
    // envelope for the shifted one (fine structure + phase untouched).
    for (let k = 0; k <= half; k++) {
      const srcIdx = k / factor;
      const i0 = Math.floor(srcIdx);
      let shifted: number;
      if (i0 >= half) shifted = logEnv[half];
      else {
        const frac = srcIdx - i0;
        shifted = logEnv[i0] * (1 - frac) + logEnv[Math.min(i0 + 1, half)] * frac;
      }
      const gain = Math.exp(shifted - logEnv[k]);
      re[k] *= gain; im[k] *= gain;
      if (k > 0 && k < half) { re[N - k] *= gain; im[N - k] *= gain; }
    }

    // Resynthesis: IFFT → synthesis window → overlap-add (÷ Σw², COLA-constant).
    fftInPlace(re, im, true);
    for (let i = 0; i < N; i++) {
      const w = win[i];
      out[start + i] += re[i] * w;
      norm[start + i] += w * w;
    }
  }

  for (let i = 0; i < out.length; i++) {
    // Uncovered head/tail (shorter than one frame) → pass the original through.
    out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : samples[i];
  }
  return out;
}
