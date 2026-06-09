// client-aac/src/lib/alarmSounds.ts
//
// Synthesised alarm sounds for the caretaker-alarm feature. Generated with
// the Web Audio API (no audio assets to ship) and driven entirely from
// <AlarmOverlay>. Two sounds:
//   - playAlertBeep()      — one short attention chime (non-emergency).
//   - startEmergencyTone() — a rising tone that builds over a couple of
//                            seconds and repeats, each cycle climbing in
//                            pitch and swelling in volume, until stopped.
//
// The AAC device has already unlocked audio by the time a session is live
// (the streaming TTS player runs through an AudioContext), but we still
// call resume() defensively in case autoplay policy left a context
// suspended.

function createAudioContext(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** Two short attention pulses (~0.5s total). Fire-and-forget; tears down its
 *  own AudioContext when the last note finishes.
 *
 *  Loudness notes (why the earlier version was too quiet):
 *   - It used a SINE wave, which has the lowest perceived loudness of any
 *     waveform at a given amplitude. A SQUARE wave carries far more energy in
 *     audible harmonics and cuts through speech.
 *   - It RAMPED UP to peak then immediately decayed, so full volume lasted
 *     only ~20ms. We now HOLD near full scale for the body of each pulse.
 */
export function playAlertBeep(): void {
  const ctx = createAudioContext();
  if (!ctx) return;
  void ctx.resume?.();

  // One pulse: a held square-wave note. Sustains at near-full scale so it is
  // audibly loud, not a momentary spike. Pulses never overlap (so the summed
  // signal can't exceed one oscillator), which keeps it loud without the
  // mushy distortion of two square waves clipping together.
  const pulse = (start: number, freq: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.9, start + 0.008);
    gain.gain.setValueAtTime(0.9, start + 0.16);
    gain.gain.linearRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.22);
    return osc;
  };

  const now = ctx.currentTime;
  // A two-step chime (B5 → E6) reads as "look here" without the sustained
  // rising sweep of the emergency tone.
  pulse(now, 988);
  const last = pulse(now + 0.25, 1319);
  last.onended = () => {
    closeContext(ctx);
  };
}

/** Close an AudioContext at most once. Calling close() on an already-closed
 *  (or closing) context throws InvalidStateError, and we have two teardown
 *  paths (onended + a safety-net timer) that can both fire. */
function closeContext(ctx: AudioContext): void {
  if (ctx.state === "closed") return;
  try { void ctx.close(); } catch { /* already closed/closing */ }
}

export interface EmergencyToneHandle {
  /** Silence and tear down the alarm. Idempotent. */
  stop: () => void;
}

/**
 * Start a rising, building emergency alarm that repeats until stopped.
 * Each cycle sweeps the pitch upward from ~440Hz to ~1500Hz over ~2.5s
 * while the volume swells, then resets — a touch louder each pass (capped)
 * so it grows more insistent. Returns a handle whose stop() silences it
 * and releases the AudioContext.
 */
export function startEmergencyTone(): EmergencyToneHandle {
  const ctx = createAudioContext();
  if (!ctx) return { stop: () => {} };
  void ctx.resume?.();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth"; // richer, more piercing than a sine for an alarm
  osc.connect(gain).connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  osc.start();

  const CYCLE = 2.5; // seconds per rising sweep
  let stopped = false;
  let cycleIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleCycle = (t0: number, intensity: number) => {
    // Pitch climbs across the sweep.
    osc.frequency.setValueAtTime(440, t0);
    osc.frequency.linearRampToValueAtTime(1500, t0 + CYCLE);
    // Volume swells over the sweep; successive cycles are a touch louder,
    // capped so it never becomes painful.
    const peak = Math.min(0.18 + intensity * 0.04, 0.4);
    gain.gain.setValueAtTime(0.02, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + CYCLE * 0.9);
    gain.gain.setValueAtTime(0.02, t0 + CYCLE);
  };

  const pump = () => {
    if (stopped) return;
    scheduleCycle(ctx.currentTime, cycleIndex++);
    timer = setTimeout(pump, CYCLE * 1000);
  };
  pump();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        osc.stop(ctx.currentTime + 0.05);
      } catch { /* oscillator may already be stopping */ }
      osc.onended = () => {
        closeContext(ctx);
      };
      // Safety net in case onended never fires.
      setTimeout(() => {
        closeContext(ctx);
      }, 300);
    },
  };
}
