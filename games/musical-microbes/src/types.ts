// Musical Microbes — Core type definitions.
//
// A generative-music sandbox. The player places organisms in a tank; the music
// emerges from how they interact. A hidden global scale + beat grid means no
// placement can ever sound "wrong."
//
// Cast:
//   - Pulser:     the heartbeat. The only species that emits unprompted. On each
//                 pulse it sends an expanding wave outward and plays a soft kick.
//                 Pulsers are never silenced — they drive the whole system.
//   - Responder:  silent until a pulse-wave reaches it, then plays a note whose
//                 pitch depends on its vertical position (higher up = higher note).
//                 Clustering responders makes the passing wave arpeggiate a chord.
//   - Harmonizer: the PREY. Has an `activation` that nearby responders recruit —
//                 fast if adjacent, slow (over several pulses) if farther. An
//                 active harmonizer sounds a harmony when a pulse reaches it and
//                 recruits its own neighbours at a reduced rate, so activation
//                 spreads through a harmonizer field like a growing population.
//   - Echoer:     a delay line. When it hears a responder/harmonizer note nearby,
//                 it replays that note a few times, decaying — call-and-response
//                 and cascading rhythm. It emits no waves, so echoers never feed
//                 each other and the tail always dies out after the pulses stop.
//   - Silencer:   the PREDATOR. Starts dormant; senses nearby prey-sound into a
//                 `food` reserve; enough food wakes it and grows its field, which
//                 eats prey (drains activation + mutes cells, pulsers included).
//                 Starved of prey it declines — a predator–prey cycle that makes
//                 the music swell and recede. See engine.ts.

export type SpeciesId = 'pulser' | 'responder' | 'harmonizer' | 'echoer' | 'silencer';

/** What the canvas does when the player activates a point. */
export type Tool = SpeciesId | 'eraser';

export interface Organism {
  id: number;
  species: SpeciesId;
  /** Position in canvas (CSS) pixels. */
  x: number;
  y: number;
  /** Beat-time of the most recent fire — drives the glow/flash visual. */
  lastFiredBeat: number;
  /** Beat-time the organism was placed (for the grow-in animation). */
  bornBeat: number;

  // ── Harmonizer-only state (prey biomass) ──
  /** Activation 0..1: how "alive" this harmonizer is. Rises only when the
   *  excitation wave actually reaches it (so alive ⟺ it sounds); a predator
   *  zeroes it; it decays at rest. Sets its volume and whether it can pass the
   *  wave onward. */
  activation?: number;
  /** Excitation sweeps currently passing through this harmonizer. A cell never
   *  re-fires a seed it's already handled (so a wave can't loop), and a seed is
   *  removed only once its whole sweep is spent — so a chain can outlive the pulse
   *  that started it and keep flowing into harmonizers ahead, yet still never loop. */
  activeSeeds?: Set<number>;

  // ── Silencer-only state (predator population) ──
  /** Field strength 0..1 (the predator's population); influence radius = level × SILENCE_MAX_RADIUS. */
  level?: number;
  /** Leaky reserve of recently-eaten prey-sound; drives growth, starves to nothing without prey. */
  food?: number;
  /** Per-silencer ±jitter on the dynamics so neighbours drift out of phase. */
  jitter?: number;
}

/** An expanding pulse ring emitted by a pulser. Geometry is in beats so it
 *  freezes naturally when the clock is paused. Only pulsers emit waves. */
export interface PulseWave {
  id: number;
  x: number;
  y: number;
  /** Beat-time at which the wave was emitted. */
  startBeat: number;
  /** Cell ids this wave has already reached (so it triggers each once). */
  hit: Set<number>;
}

/** A scheduled harmonizer sounding. The excitation wave propagates by queuing
 *  these with a small per-hop delay; a refractory check at fire time keeps each
 *  harmonizer to one sounding per sweep, so the wave moves outward and dies. */
export interface HarmonicHit {
  id: number;
  emitAtBeat: number;
  /** Carries the diminishing gain across hops. */
  gain: number;
  /** Which excitation sweep this belongs to (for the fire-once-per-sweep guard). */
  seed: number;
}

/** A scheduled echo: an echoer replays a note it heard, after a delay, a few
 *  times with decay. These never re-trigger other cells, so they can't cascade. */
export interface EchoReplay {
  x: number;
  y: number;
  /** The echoer that will sound it, so we can flash it. */
  srcId: number;
  emitAtBeat: number;
  freq: number;
  gain: number;
  /** How many more times this echo will repeat after the current one. */
  repeatsLeft: number;
}

export interface GameState {
  organisms: Organism[];
  waves: PulseWave[];
  /** Harmonizer soundings waiting for their delayed excitation-wave fire time. */
  pendingHarmonics: HarmonicHit[];
  /** Echo notes waiting for their delayed replay time. */
  echoReplays: EchoReplay[];
  /** Whether the beat clock advances at all. Only a real (platform) pause stops
   *  it — the light switch does NOT, so existing waves keep travelling and the
   *  whole tank stays animated while the microbes sleep. */
  running: boolean;
  /** Whether pulsers emit new pulses. This is the light switch: lights off =
   *  awake (emitting), lights on = asleep (no new pulses). */
  pulsersAwake: boolean;
  /** Continuous musical time, in beats. Advances whenever `running`. */
  beatTime: number;
  /** Next integer beat that still needs its pulser fires scheduled. */
  nextFireBeat: number;
  /** Monotonic id stamped on each excitation sweep (one per responder fire). */
  exciteSeed: number;
  width: number;
  height: number;
  nextId: number;
}

/** Audio sink the engine schedules sounds into. Kept as an interface so the
 *  engine has no direct dependency on the Web Audio module (and stays testable). */
export interface AudioSink {
  /** Soft low kick for a pulser fire, scheduled at AudioContext time `when`. */
  playKick(when: number): void;
  /** A responder/harmonizer/echo note (Hz) at `when`, with relative gain 0..1. */
  playNote(when: number, freq: number, gain: number): void;
}
