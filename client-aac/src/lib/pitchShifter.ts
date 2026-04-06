// client-aac/src/lib/pitchShifter.ts
// WSOLA-based pitch shifter for speech audio.
// Shifts pitch while preserving duration (no chipmunk/slow-motion effect).
//
// Pipeline: WSOLA time-stretch → linear resample
// - WSOLA stretches/compresses audio in time without changing pitch
// - Resampling then adjusts the sample count to restore original duration,
//   which shifts the pitch by the inverse of the stretch factor.

/** Convert semitones to linear pitch factor. +2 → ~1.122, -3 → ~0.841 */
export function semitonesToFactor(semitones: number): number {
  return Math.pow(2, semitones / 12);
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
  const norm = new Float32Array(outLen); // overlap-add window energy for normalisation

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

  // Normalise by overlap-add window energy
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
    norm[dstOff + i] += w * w;
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
