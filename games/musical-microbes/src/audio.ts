// Musical Microbes — Procedural audio.
//
// Two hidden systems make "wrong" notes impossible:
//   1. A global scale: every responder note quantizes to the major pentatonic,
//      whose intervals never clash, so any chord of simultaneous notes harmonizes.
//   2. A global beat grid (owned by the engine): pulsers fire on the beat, and
//      responder notes are scheduled at sample-accurate offsets via the Web Audio
//      `when` parameter, so timing stays tight no matter the frame rate.
//
// All scheduling uses AudioContext.currentTime — see the engine's `tick`, which
// converts beat-time into `when` values and hands them here.

const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9]; // major pentatonic
const BASE_MIDI = 57;                          // A3 — bottom of the responder range
const OCTAVE_SPAN = 2;                         // vertical position maps across 2 octaves

const NOTE_PEAK_GAIN = 0.16;
const NOTE_DURATION_S = 1.1;

const KICK_PEAK_GAIN = 0.5;
const KICK_DURATION_S = 0.32;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Loudness compensation (Fletcher-Munson): a pure tone at 100 Hz sounds much
 * quieter than the same amplitude at 1 kHz, so boost low voices to keep the
 * low responders from feeling hushed next to high ones.
 */
function loudnessGain(freq: number): number {
  if (freq < 1000) return Math.min(2.2, Math.pow(1000 / freq, 0.4));
  if (freq > 4000) return Math.min(1.4, Math.pow(freq / 4000, 0.3));
  return 1.0;
}

/** Number of scale degrees spanned by the tank, bottom to top. */
export const SCALE_STEPS = PENTATONIC_SEMITONES.length * OCTAVE_SPAN; // e.g. 10

/** A responder's "highness" (0 = bottom of tank, 1 = top) → integer scale index. */
export function vertToIndex(highness: number): number {
  const h = Math.max(0, Math.min(1, highness));
  return Math.round(h * (SCALE_STEPS - 1));
}

/** A scale index → frequency. Indices are clamped into range. Harmonizers reach
 *  consonant intervals just by adding scale steps to a responder's index. */
export function indexToFreq(index: number): number {
  const i = Math.max(0, Math.min(SCALE_STEPS - 1, Math.round(index)));
  const octave = Math.floor(i / PENTATONIC_SEMITONES.length);
  const degree = i % PENTATONIC_SEMITONES.length;
  const semitone = PENTATONIC_SEMITONES[degree] + octave * 12;
  return midiToHz(BASE_MIDI + semitone);
}

/**
 * Map a responder's vertical position to a pentatonic frequency. Quantizing to
 * the scale means a vertical column of responders spells an arpeggio that always
 * harmonizes.
 */
export function vertToFreq(highness: number): number {
  return indexToFreq(vertToIndex(highness));
}

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    ctx = new AudioCtor();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    // A gentle low-pass keeps the whole tank warm and "underwater" rather than brittle.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    masterGain.connect(lp).connect(ctx.destination);
  } catch {
    return null;
  }
  return ctx;
}

/** Current AudioContext time in seconds, or 0 before audio is initialised. */
export function getAudioTime(): number {
  return ctx ? ctx.currentTime : 0;
}

/** Soft, round kick — a quick downward pitch sweep with a fast decay. */
function playKick(when: number): void {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t = Math.max(when, c.currentTime);

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + KICK_DURATION_S);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(KICK_PEAK_GAIN, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + KICK_DURATION_S);

  osc.connect(g).connect(masterGain);
  osc.start(t);
  osc.stop(t + KICK_DURATION_S + 0.05);
}

/** A bell-like responder note: stacked sine harmonics with a soft attack. */
function playNote(when: number, freq: number, gain: number): void {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t = Math.max(when, c.currentTime);
  const loud = loudnessGain(freq);
  const harmonics = [1, 2, 3];
  const harmGains = [1, 0.45, 0.2];

  for (let i = 0; i < harmonics.length; i++) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * harmonics[i];
    const g = c.createGain();
    const peak = NOTE_PEAK_GAIN * harmGains[i] * loud * Math.max(0, Math.min(1, gain));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + NOTE_DURATION_S);
    osc.connect(g).connect(masterGain);
    osc.start(t);
    osc.stop(t + NOTE_DURATION_S + 0.05);
  }
}

/** The engine schedules through this sink (see `types.ts`). */
export const audioSink = { playKick, playNote };

/** Browsers require AudioContext.resume() after a user gesture. */
export function unlockAudio(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {
      /* gesture not yet delivered */
    });
  }
}
