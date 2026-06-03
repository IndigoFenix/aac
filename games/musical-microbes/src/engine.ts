// Musical Microbes — Simulation engine (no rendering, no audio internals).
//
// A driven ecosystem. Pulses are the only energy input; stop them (lights on)
// and every field decays back to its origin — cells never move, are born, or
// die. What fluctuates is each cell's *field of influence*, treated as a
// population:
//
//   PREY  = harmonizer `activation`. Responders recruit nearby harmonizers
//           (fast if adjacent, slow if far); active harmonizers recruit their
//           own neighbours at a reduced rate, so a harmonizer field fills in
//           over successive pulses — population growth without reproduction.
//           Each pulse also fires a fast *excitation wave* that sweeps through
//           the living harmonizers with a small per-hop delay (a row sounds like
//           a travelling wave); a refractory cooldown keeps the wave one-way.
//
//   PRED  = silencer `level`. It starts dormant, senses nearby prey-sound into a
//           leaky `food` reserve; enough food wakes it and grows its field, which
//           eats prey (drains activation, mutes cells — pulsers included). Starved
//           of prey it declines. Prey then regrows and the cycle repeats — a
//           predator–prey oscillation, which (unlike competition) never settles.
//
// Simple by default: with no harmonizers/silencers, pulser + responders is just
// a steady repeating loop. The whole apparatus stays dormant until you add it.

import type { AudioSink, EchoReplay, GameState, HarmonicHit, Organism, PulseWave, SpeciesId } from './types';
import { indexToFreq, vertToFreq, vertToIndex } from './audio';

export const BPM = 96;
export const BEAT_DUR = 60 / BPM; // seconds per beat

/** Pulsers fire every N beats — a calm half-note heartbeat. */
export const PULSE_PERIOD_BEATS = 2;

/** Wave travel speed, in pixels per beat. */
export const WAVE_SPEED_PER_BEAT = 120;

/** Beyond this radius a pulse no longer reaches a responder. */
export const WAVE_MAX_RADIUS = 230;

/** Distant responders stay faintly audible rather than dropping to silence. */
const MIN_NOTE_GAIN = 0.12;

/** Erase / placement spacing radius (px). */
export const ERASE_RADIUS = 44;

// ── Harmonizer (PREY) ─────────────────────────────────────────────────────────
// One unified, responder-seeded excitation wave drives both sound AND activation,
// so a harmonizer is alive only if it's actually being sounded. Each sweep carries
// a seed; a cell fires at most once per seed, so the wave can never re-enter a loop
// (no self-sustaining cycles). Each pulse the wave sweeps the established cluster
// and nudges its frontier; cells climb across two thresholds over several pulses,
// so the sounding front advances a hop at a time — growth, without runaway.

/** Reach of a single excitation hop (responder→harmonizer and harmonizer→harmonizer). */
const EXCITE_RADIUS = 95;
/** Per-hop delay, in beats — this is what makes a row sound like a travelling wave. */
const EXCITE_DELAY_BEATS = 0.18;
/** Gain multiplier per hop, so a long sweep fades gently along its length. */
const EXCITE_DECAY = 0.9;
/** Hops below this gain aren't scheduled — stops inaudible tails (secondary to fire-once). */
const MIN_EXCITE_GAIN = 0.03;
/** Activation gained each time the wave reaches a harmonizer (logistic, × (1−a)).
 *  Tuned so a cell touched once per pulse settles around ~0.75 (above PROPAGATE),
 *  reaching it in ~2 pulses — fast enough that the front actually spreads. */
const ACT_GROW = 0.5;
/** Activation decay at rest (per sec). Survives the gap between pulses (so a fed
 *  cluster is retained), but a cell the wave stops reaching fades within a few seconds. */
const ACT_DECAY = 0.1;
/** Activation above which a harmonizer sounds at all (gain ∝ activation). */
const MIN_SOUND = 0.12;
/** Activation above which a harmonizer can pass the wave to its neighbours. The gap
 *  between this and MIN_SOUND is what spreads the front gradually over pulses. */
const PROPAGATE_THRESHOLD = 0.55;
/** A fifth above the harmonizer's own positional note keeps its "harmony" identity. */
const HARMONY_STEPS = 3;
const HARMONY_VOL = 0.8;
const MAX_PENDING_HARMONICS = 240;

// ── Echoer (note delay line — emits no waves, so it can never cascade) ────────
export const ECHOER_HEAR_RADIUS = 150;
const ECHO_DELAY_BEATS = 1;
const ECHO_REPEATS = 3;
const ECHO_FIRST_GAIN = 0.7;
const ECHO_DECAY = 0.6;
const MAX_REPLAYS = 120;

// ── Silencer (PREDATOR) ───────────────────────────────────────────────────────
export const SILENCE_MAX_RADIUS = 170;
/** Suppression at/above which a cell is treated as fully silent (binary: 0 or 1). */
const SILENCE_CUTOFF = 0.96;
/** A dormant silencer still senses prey-sound out to here (so it can wake). */
const SILENCE_SENSE_RANGE = 210;
/** Leaky-integrator time constant for the silencer's `food` reserve (sec). Long,
 *  so the reserve is retained across many pulses and changes slowly. */
const FOOD_TAU = 4.0;
/** Food above which the predator grows; below, it starves. */
const WAKE_FOOD = 0.25;
/** Field growth rate when well-fed (per sec, × (1−level)). Slow: the predator
 *  swells over several seconds rather than snapping open. */
const SILENCE_GROW = 0.7;
/** Field starvation rate (per sec, × level). Slow: it recedes over several seconds. */
const SILENCE_DECAY = 1.0;

export function createState(width: number, height: number): GameState {
  return {
    organisms: [],
    waves: [],
    pendingHarmonics: [],
    echoReplays: [],
    running: true,
    pulsersAwake: true,
    beatTime: 0,
    nextFireBeat: 0,
    exciteSeed: 0,
    width,
    height,
    nextId: 1,
  };
}

export function resize(state: GameState, width: number, height: number): void {
  state.width = width;
  state.height = height;
}

export function placeOrganism(state: GameState, species: SpeciesId, x: number, y: number): Organism {
  const o: Organism = {
    id: state.nextId++,
    species,
    x,
    y,
    lastFiredBeat: -999,
    bornBeat: state.beatTime,
  };
  if (species === 'harmonizer') {
    o.activation = 0;
    o.activeSeeds = new Set();
  }
  if (species === 'silencer') {
    o.level = 0; // dormant — wakes only once it has sensed enough prey-sound
    o.food = 0;
    o.jitter = (Math.random() - 0.5) * 0.5; // ±25% rate spread → neighbours desync
  }
  state.organisms.push(o);
  return o;
}

/** Remove the nearest organism within `ERASE_RADIUS` of (x, y). Returns true if one was removed. */
export function eraseAt(state: GameState, x: number, y: number): boolean {
  let bestIdx = -1;
  let bestDist = ERASE_RADIUS;
  for (let i = 0; i < state.organisms.length; i++) {
    const o = state.organisms[i];
    const d = Math.hypot(o.x - x, o.y - y);
    if (d <= bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return false;
  const removed = state.organisms[bestIdx];
  state.organisms.splice(bestIdx, 1);
  for (const w of state.waves) w.hit.delete(removed.id);
  return true;
}

export function clearAll(state: GameState): void {
  state.organisms = [];
  state.waves = [];
  state.pendingHarmonics = [];
  state.echoReplays = [];
}

/** Field radius of a silencer (px). */
export function silenceRadius(s: Organism): number {
  return (s.level ?? 0) * SILENCE_MAX_RADIUS;
}

/** The distance within which placing species `a` next to an existing `b` makes
 *  them affect (or be affected by) each other — used to preview an object's
 *  connections as it's placed. Returns 0 if the two never interact. */
export function interactionRadius(a: SpeciesId, b: SpeciesId): number {
  const pair = (s1: SpeciesId, s2: SpeciesId) => (a === s1 && b === s2) || (a === s2 && b === s1);
  if (pair('pulser', 'responder')) return WAVE_MAX_RADIUS; // a pulse triggers a responder
  if (a === 'harmonizer' && b === 'harmonizer') return EXCITE_RADIUS; // wave passes between them
  if (pair('responder', 'harmonizer')) return EXCITE_RADIUS; // responder seeds the harmonizer
  if (pair('responder', 'echoer') || pair('harmonizer', 'echoer')) return ECHOER_HEAR_RADIUS; // echoer hears it
  if (a === 'silencer' || b === 'silencer') {
    const other = a === 'silencer' ? b : a;
    if (other === 'silencer') return 0; // silencers don't interact with each other
    if (other === 'pulser') return SILENCE_MAX_RADIUS; // can only mute a pulser it overlaps
    return SILENCE_SENSE_RANGE; // responder/harmonizer/echoer: it eats them and they feed it
  }
  return 0;
}

/** Hard suppression: 1 if the point is inside ANY silencer's field, else 0. A
 *  silencer shuts down everything it overlaps completely and at once — no gradient,
 *  so the system can't settle on a balanced edge and is forced to oscillate. */
export function suppressionAt(state: GameState, x: number, y: number): number {
  for (const o of state.organisms) {
    if (o.species !== 'silencer') continue;
    const r = silenceRadius(o);
    if (r > 1 && Math.hypot(x - o.x, y - o.y) < r) return 1;
  }
  return 0;
}

/** Schedule the excitation wave's next hop into harmonizers within reach. The
 *  `seed` tags this sweep; the fire handler ignores a cell already lit by it, so
 *  the wave sweeps outward once and can never loop back on itself. */
function excite(state: GameState, x: number, y: number, gain: number, srcId: number, seed: number): void {
  if (gain < MIN_EXCITE_GAIN || state.pendingHarmonics.length >= MAX_PENDING_HARMONICS) return;
  for (const h of state.organisms) {
    if (h.species !== 'harmonizer' || h.id === srcId) continue;
    if (h.activeSeeds?.has(seed)) continue; // already reached by this sweep
    if (Math.hypot(h.x - x, h.y - y) >= EXCITE_RADIUS) continue;
    state.pendingHarmonics.push({ id: h.id, emitAtBeat: state.beatTime + EXCITE_DELAY_BEATS, gain, seed });
  }
}

/** Sense prey-sound into nearby silencers' food reserves (drives the predator). */
function feedPredators(food: Map<number, number>, state: GameState, x: number, y: number, amount: number): void {
  for (const s of state.organisms) {
    if (s.species !== 'silencer') continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if (d >= SILENCE_SENSE_RANGE) continue;
    const prox = 1 - d / SILENCE_SENSE_RANGE;
    food.set(s.id, (food.get(s.id) ?? 0) + amount * prox);
  }
}

/** Queue decaying replays of a note for any echoers within earshot. */
function feedEchoers(state: GameState, x: number, y: number, freq: number, gain: number): void {
  if (state.echoReplays.length >= MAX_REPLAYS) return;
  for (const e of state.organisms) {
    if (e.species !== 'echoer') continue;
    if (Math.hypot(e.x - x, e.y - y) > ECHOER_HEAR_RADIUS) continue;
    const se = suppressionAt(state, e.x, e.y);
    if (se >= SILENCE_CUTOFF) continue;
    state.echoReplays.push({
      x: e.x,
      y: e.y,
      srcId: e.id,
      emitAtBeat: state.beatTime + ECHO_DELAY_BEATS,
      freq,
      gain: gain * ECHO_FIRST_GAIN * (1 - se),
      repeatsLeft: ECHO_REPEATS,
    });
  }
}

/** Emit a pulse wave from (x, y). */
function emitWave(state: GameState, x: number, y: number): void {
  state.waves.push({ id: state.nextId++, x, y, startBeat: state.beatTime, hit: new Set() });
}

/** Current visual radius of a wave, in pixels. */
export function waveRadius(state: GameState, wave: PulseWave): number {
  return (state.beatTime - wave.startBeat) * WAVE_SPEED_PER_BEAT;
}

export function tick(state: GameState, dt: number, audioTime: number, sink: AudioSink): void {
  // A real (platform) pause freezes the whole clock; the light switch does not.
  if (!state.running) return;

  const food = new Map<number, number>(); // prey-sound sensed by each silencer, this frame
  state.beatTime += dt * (BPM / 60);

  // ── Pulsers fire on the beat (while awake and not buried in a silencer field) ──
  while (state.beatTime >= state.nextFireBeat) {
    const beat = state.nextFireBeat;
    if (state.pulsersAwake && beat % PULSE_PERIOD_BEATS === 0) {
      const when = audioTime + (beat - state.beatTime) * BEAT_DUR;
      for (const p of state.organisms) {
        if (p.species !== 'pulser') continue;
        if (suppressionAt(state, p.x, p.y) >= SILENCE_CUTOFF) continue; // silenced pulser
        p.lastFiredBeat = state.beatTime;
        emitWave(state, p.x, p.y);
        sink.playKick(when);
      }
    }
    state.nextFireBeat++;
  }

  // ── Expand waves; trigger responders as each front reaches them ──
  const kept: PulseWave[] = [];
  for (const w of state.waves) {
    const radius = waveRadius(state, w);
    if (radius > WAVE_MAX_RADIUS + 60) continue; // dissipated
    for (const o of state.organisms) {
      if (o.species !== 'responder' || w.hit.has(o.id)) continue;
      const d = Math.hypot(o.x - w.x, o.y - w.y);
      if (d > WAVE_MAX_RADIUS || radius < d) continue;
      w.hit.add(o.id);
      triggerResponder(state, o, d, audioTime, sink, food);
    }
    kept.push(w);
  }
  state.waves = kept;

  // ── Fire harmonizer excitation soundings whose delay has elapsed ──
  if (state.pendingHarmonics.length > 0) {
    // A seed is "alive" while any of its hits is still queued. A cell prunes the
    // dead ones from its own set when it's triggered — local and cheap, no global
    // per-organism sweep — so live seeds persist across pulses (long chains finish)
    // while finished seeds are forgotten (and can never reappear: seeds only grow).
    const aliveSeeds = new Set<number>();
    for (const hit of state.pendingHarmonics) aliveSeeds.add(hit.seed);

    const still: HarmonicHit[] = [];
    for (const hit of state.pendingHarmonics) {
      if (state.beatTime < hit.emitAtBeat) {
        still.push(hit);
        continue;
      }
      const h = state.organisms.find(o => o.id === hit.id);
      if (!h || h.species !== 'harmonizer') continue;
      const seeds = h.activeSeeds ?? (h.activeSeeds = new Set());
      for (const s of seeds) if (!aliveSeeds.has(s)) seeds.delete(s); // forget finished sweeps
      if (seeds.has(hit.seed)) continue; // already handled this live sweep — no reentry
      seeds.add(hit.seed);
      if (suppressionAt(state, h.x, h.y) > 0) {
        h.activation = 0; // overlapped by a predator field — eaten, stays silent
        continue;
      }
      // The wave nourishes whatever it reaches: activation is driven only here, so
      // "alive" always means "currently being sounded".
      const a = Math.min(1, (h.activation ?? 0) + ACT_GROW * (1 - (h.activation ?? 0)));
      h.activation = a;
      if (a < MIN_SOUND) continue; // touched but not yet alive enough to sound
      h.lastFiredBeat = state.beatTime;
      const highness = 1 - clamp01(h.y / Math.max(1, state.height));
      const freq = indexToFreq(vertToIndex(highness) + HARMONY_STEPS);
      const gain = hit.gain * a * HARMONY_VOL;
      sink.playNote(audioTime, freq, gain);
      feedPredators(food, state, h.x, h.y, gain);
      feedEchoers(state, h.x, h.y, freq, gain);
      // Only an established cell carries the wave onward, so the front advances a
      // hop at a time over successive pulses rather than lighting the whole field.
      if (a >= PROPAGATE_THRESHOLD) excite(state, h.x, h.y, hit.gain * EXCITE_DECAY, h.id, hit.seed);
    }
    state.pendingHarmonics = still;
  }

  // ── Replay echoes whose delay has elapsed ──
  if (state.echoReplays.length > 0) {
    const stillPending: EchoReplay[] = [];
    for (const e of state.echoReplays) {
      if (state.beatTime < e.emitAtBeat) {
        stillPending.push(e);
        continue;
      }
      const src = state.organisms.find(o => o.id === e.srcId);
      if (!src) continue;
      const s = suppressionAt(state, e.x, e.y);
      if (s >= SILENCE_CUTOFF) continue;
      src.lastFiredBeat = state.beatTime;
      const g = e.gain * (1 - s);
      sink.playNote(audioTime, e.freq, g);
      // Echoes are prey-sound too. Each echoer fires several decaying repeats per
      // note it hears, so it feeds a nearby silencer more than a lone responder
      // would — clustering echoers by a predator makes it grow particularly well.
      feedPredators(food, state, e.x, e.y, g);
      if (e.repeatsLeft > 1) {
        stillPending.push({
          ...e,
          emitAtBeat: state.beatTime + ECHO_DELAY_BEATS,
          gain: e.gain * ECHO_DECAY,
          repeatsLeft: e.repeatsLeft - 1,
        });
      }
    }
    state.echoReplays = stillPending;
  }

  // ── Decay prey activation; integrate predator populations ──
  updatePopulations(state, dt, food);
}

/** A responder sounds, seeds the harmonizer excitation wave + recruitment, feeds
 *  predators, and feeds echoers. */
function triggerResponder(
  state: GameState,
  r: Organism,
  dist: number,
  audioTime: number,
  sink: AudioSink,
  food: Map<number, number>,
): void {
  const s = suppressionAt(state, r.x, r.y);
  if (s >= SILENCE_CUTOFF) return; // buried in silence — eaten

  r.lastFiredBeat = state.beatTime;
  const highness = 1 - clamp01(r.y / Math.max(1, state.height));
  const atten = 1 - clamp01(dist / WAVE_MAX_RADIUS);
  const gain = (MIN_NOTE_GAIN + (1 - MIN_NOTE_GAIN) * atten * atten) * (1 - s);
  const freq = vertToFreq(highness);

  sink.playNote(audioTime, freq, gain);
  feedPredators(food, state, r.x, r.y, gain);
  feedEchoers(state, r.x, r.y, freq, gain);
  // Responders are the only seed of the prey: each fire starts a fresh sweep that
  // nourishes and sounds the harmonizer field. No responder → no sweep → it dies.
  excite(state, r.x, r.y, gain, r.id, ++state.exciteSeed);
}

/** Per-frame: harmonizer activation decays at rest (zeroed instantly under a
 *  predator); each silencer integrates its food reserve and grows/starves. */
function updatePopulations(state: GameState, dt: number, food: Map<number, number>): void {
  const leak = Math.exp(-dt / FOOD_TAU);
  for (const o of state.organisms) {
    if (o.species === 'harmonizer') {
      if (suppressionAt(state, o.x, o.y) > 0) {
        o.activation = 0; // overlapped by a field → shut down immediately, reset to zero
      } else {
        const next = (o.activation ?? 0) - ACT_DECAY * dt;
        o.activation = next < 0 ? 0 : next;
      }
    } else if (o.species === 'silencer') {
      const f = (o.food ?? 0) * leak + (food.get(o.id) ?? 0);
      o.food = f;
      const level = o.level ?? 0;
      const j = 1 + (o.jitter ?? 0);
      const grow = SILENCE_GROW * j * Math.max(0, f - WAKE_FOOD) * (1 - level);
      const starve = SILENCE_DECAY * level;
      const next = level + (grow - starve) * dt;
      o.level = next < 0 ? 0 : next > 1 ? 1 : next;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
