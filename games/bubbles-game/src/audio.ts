// Bubbles Game — Procedural audio.
//
// Design goals:
// - Every bubble has a deterministic pitch derived from its hue, quantized to
//   the major pentatonic scale. Pentatonic notes never form dissonant
//   intervals, so any combination of simultaneous bubble sounds harmonizes.
// - Painting a bubble produces a sustained sine "hum" that auto-fades when
//   painting stops; the hum slowly detunes upward as the bubble approaches
//   the pop threshold, creating an anticipatory build-up.
// - Popping a bubble plays a bell-like ping (stacked harmonics with quick
//   attack + exponential decay). Special bubbles play a triad for sparkle.

const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9]; // C major pentatonic
const BASE_MIDI = 55;                          // G3 — center of the hue-mapped range
const OCTAVE_SPAN = 2;                         // hue maps across 2 octaves of the scale
// Size → pitch: bigger bubble = lower pitch (like a bigger bell or drum).
// log2 makes the mapping perceptually linear; clamped so the extremes stay musical.
const SIZE_REFERENCE_RADIUS = 80;              // radius that yields no octave shift
const SIZE_MAX_OCTAVE_SHIFT = 1.5;

const HUM_TARGET_GAIN = 0.18;
const HUM_ATTACK_S = 0.012;        // near-instant so even brief touches are audible
const HUM_FADE_TIMEOUT_S = 0.15;   // un-fed for this long → start fading
const HUM_FADE_DURATION_S = 0.7;
const HUM_MAX_DETUNE_CENTS = 120;  // pitch rise as paint builds toward pop

const POP_PEAK_GAIN = 0.22;
const POP_DURATION_S = 0.9;
const POP_DURATION_SPECIAL_S = 1.4;

const CLICK_PEAK_GAIN = 0.14;
const CLICK_DURATION_S = 0.18;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function sizeOctaveShift(radius: number): number {
  const shift = Math.log2(SIZE_REFERENCE_RADIUS / Math.max(1, radius));
  return Math.max(-SIZE_MAX_OCTAVE_SHIFT, Math.min(SIZE_MAX_OCTAVE_SHIFT, shift));
}

/**
 * Loudness compensation: the ear is less sensitive to low and very-high
 * frequencies (Fletcher-Munson), so a pure sine at 100Hz sounds much quieter
 * than the same amplitude at 1kHz. This boosts the gain of low-pitched
 * voices so big bubbles don't feel hushed compared to small ones.
 */
function loudnessGain(freq: number): number {
  if (freq < 1000) return Math.min(2.2, Math.pow(1000 / freq, 0.4));
  if (freq > 4000) return Math.min(1.4, Math.pow(freq / 4000, 0.3));
  return 1.0;
}

/**
 * Map a bubble to a frequency. Hue picks the pentatonic note (so different
 * colors play different notes that always harmonize), size shifts the octave
 * (so bigger bubbles sound lower, like bigger bells).
 */
export function bubbleFrequency(hue: number, radius: number): number {
  const steps = PENTATONIC_SEMITONES.length * OCTAVE_SPAN;
  const wrapped = ((hue % 360) + 360) % 360;
  const idx = Math.floor((wrapped / 360) * steps);
  const octave = Math.floor(idx / PENTATONIC_SEMITONES.length);
  const degree = idx % PENTATONIC_SEMITONES.length;
  const semitone = PENTATONIC_SEMITONES[degree] + octave * 12;
  const baseHz = midiToHz(BASE_MIDI + semitone);
  return baseHz * Math.pow(2, sizeOctaveShift(radius));
}

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let humWave: PeriodicWave | null = null;

/**
 * Cached waveform for the hum. A pure sine fundamental disappears on small
 * speakers whose response dips between bass driver and tweeter (commonly
 * 200–400 Hz), so we add an octave and twelfth — these higher partials are
 * always reproducible, and the ear reconstructs the missing fundamental.
 */
function ensureHumWave(c: AudioContext): PeriodicWave {
  if (!humWave) {
    const real = new Float32Array([0, 1, 0.5, 0.18]);
    const imag = new Float32Array([0, 0, 0, 0]);
    humWave = c.createPeriodicWave(real, imag);
  }
  return humWave;
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    ctx = new AudioCtor();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
  } catch {
    return null;
  }
  return ctx;
}

interface HumVoice {
  osc: OscillatorNode;
  gain: GainNode;
  freq: number;
  lastFedTime: number;
  fading: boolean;
}
const hums = new Map<number, HumVoice>();

/**
 * Sustain a hum tone for `bubbleId`. Call every frame while painting; the
 * hum auto-fades when calls stop. `progress` (0..1) drives a subtle upward
 * detune as paint coverage builds.
 */
export function feedHum(bubbleId: number, hue: number, radius: number, progress: number): void {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const now = c.currentTime;
  const freq = bubbleFrequency(hue, radius);
  const detune = Math.max(0, Math.min(1, progress)) * HUM_MAX_DETUNE_CENTS;
  const targetGain = HUM_TARGET_GAIN * loudnessGain(freq);

  let voice = hums.get(bubbleId);
  if (!voice || voice.fading) {
    if (voice?.fading) {
      // The previous voice is already fading out — let it finish naturally
      // and start a fresh one. Two concurrent oscillators briefly is fine.
      hums.delete(bubbleId);
    }
    const osc = c.createOscillator();
    osc.setPeriodicWave(ensureHumWave(c));
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const gain = c.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(masterGain);
    osc.start();
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(targetGain, now + HUM_ATTACK_S);
    voice = { osc, gain, freq, lastFedTime: now, fading: false };
    hums.set(bubbleId, voice);
  } else {
    voice.osc.detune.setTargetAtTime(detune, now, 0.08);
    voice.lastFedTime = now;
  }
}

/** Drive auto-fade of hums that haven't been fed recently. Call once per frame. */
export function updateHums(): void {
  const c = ctx;
  if (!c) return;
  const now = c.currentTime;
  for (const [id, voice] of hums) {
    if (voice.fading) continue;
    if (now - voice.lastFedTime > HUM_FADE_TIMEOUT_S) {
      const cur = voice.gain.gain.value;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(cur, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + HUM_FADE_DURATION_S);
      try { voice.osc.stop(now + HUM_FADE_DURATION_S + 0.05); } catch { /* already stopped */ }
      voice.fading = true;
      const removeAt = (HUM_FADE_DURATION_S + 0.1) * 1000;
      setTimeout(() => {
        const v = hums.get(id);
        if (v && v.fading) hums.delete(id);
      }, removeAt);
    }
  }
}

/** Immediately silence a bubble's hum (used right before a pop sound). */
export function stopHum(bubbleId: number): void {
  const c = ctx;
  if (!c) return;
  const voice = hums.get(bubbleId);
  if (!voice) return;
  const now = c.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.linearRampToValueAtTime(0, now + 0.04);
  try { voice.osc.stop(now + 0.07); } catch { /* already stopped */ }
  hums.delete(bubbleId);
}

/** Play a musical ping when a bubble pops. */
export function playPop(hue: number, special: boolean, radius: number): void {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const now = c.currentTime;
  const baseFreq = bubbleFrequency(hue, radius);
  // Specials get a brighter triadic stack (root + fifth + octave + twelfth);
  // regular pops are a gentle bell (root + octave + twelfth).
  const harmonics = special ? [1, 1.5, 2, 3] : [1, 2, 3];
  const harmGains = special ? [1, 0.55, 0.5, 0.3] : [1, 0.5, 0.25];
  const duration = special ? POP_DURATION_SPECIAL_S : POP_DURATION_S;
  const loudness = loudnessGain(baseFreq);

  for (let i = 0; i < harmonics.length; i++) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = baseFreq * harmonics[i];
    const g = c.createGain();
    const peak = POP_PEAK_GAIN * harmGains[i] * loudness;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g).connect(masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }
}

/**
 * Play a short tap when a bubble is first clicked (before the pop window
 * resolves). Same pitch as the eventual pop so the two sounds feel related,
 * but briefer and softer with a triangle-wave timbre to read as a "tap"
 * rather than a "ping."
 */
export function playClick(hue: number, special: boolean, radius: number): void {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const now = c.currentTime;
  const baseFreq = bubbleFrequency(hue, radius);
  const loudness = loudnessGain(baseFreq);

  // Fundamental: triangle wave for a softer, percussive timbre.
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = baseFreq;
  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(CLICK_PEAK_GAIN * loudness, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + CLICK_DURATION_S);
  osc.connect(g).connect(masterGain);
  osc.start(now);
  osc.stop(now + CLICK_DURATION_S + 0.04);

  // Brightness: octave overtone, much quieter. Specials get a fifth on top.
  const brightFreqs = special ? [baseFreq * 2, baseFreq * 3] : [baseFreq * 2];
  for (const f of brightFreqs) {
    const o2 = c.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(CLICK_PEAK_GAIN * 0.35 * loudness, now + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + CLICK_DURATION_S * 0.8);
    o2.connect(g2).connect(masterGain);
    o2.start(now);
    o2.stop(now + CLICK_DURATION_S + 0.04);
  }
}

/** Browsers require AudioContext.resume() after a user gesture. */
export function unlockAudio(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => { /* user gesture not yet delivered */ });
  }
}
