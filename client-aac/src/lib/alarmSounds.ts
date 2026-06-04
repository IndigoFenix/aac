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

/** One short attention chime (~280ms). Fire-and-forget; tears down its
 *  own AudioContext when the note finishes. */
export function playAlertBeep(): void {
  const ctx = createAudioContext();
  if (!ctx) return;
  void ctx.resume?.();

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  // A quick two-step chime (G5 → C6) reads as "look here" without sounding
  // like an emergency.
  osc.frequency.setValueAtTime(784, now);
  osc.frequency.setValueAtTime(1047, now + 0.12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
  osc.onended = () => {
    try { void ctx.close(); } catch { /* already closed */ }
  };
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
        try { void ctx.close(); } catch { /* already closed */ }
      };
      // Safety net in case onended never fires.
      setTimeout(() => {
        try { void ctx.close(); } catch { /* already closed */ }
      }, 300);
    },
  };
}
