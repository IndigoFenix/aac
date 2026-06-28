// shared/aac/audio-cue.ts
//
// A deliberately conservative audio CORROBORATION cue for seizure recognition.
// It answers one narrow question — "was there SUSTAINED elevated vocal/sound
// energy over the recent window?" — from the client's existing 10 Hz mic-energy
// samples (audioActivityMonitor RMS).
//
// CRITICAL: this NEVER fires an alarm or escalates a frame on its own. It only
// MODULATES an already-suspected MOTION event (ictal cry / distress vocalization
// concurrent with a convulsive pattern). Rett's syndrome has baseline breathing
// abnormalities (hyperventilation, breath-holding, air-swallowing) that would
// make a standalone audio detector false-positive constantly — the exact
// specificity trap hand-wringing is for motion. So audio is corroboration only.
// See planning-docs/aac-seizure-recognition/plan.md (Phase 2b).

export interface AudioEnergySample {
  ts: number;
  /** RMS energy 0..1 from audioActivityMonitor. */
  energy: number;
}

export interface VocalCueOptions {
  /** How far back to look (ms). ~the motion event window. */
  windowMs: number;
  /** Energy above this counts as "vocal/loud". Set ABOVE the speech threshold
   *  (~0.015) so quiet conversation doesn't corroborate — bias toward a raised
   *  voice / cry / distress sound. */
  energyThreshold: number;
  /** Fraction of the window that must be active to call it SUSTAINED (rejects a
   *  single blip — a cough, a chair scrape). */
  minActiveFraction: number;
}

export const DEFAULT_VOCAL_CUE: VocalCueOptions = {
  windowMs: 3000,
  energyThreshold: 0.03,
  minActiveFraction: 0.4,
};

/**
 * True when vocal/sound energy was SUSTAINED over the recent window. Pure so the
 * threshold logic is unit-tested; the client feeds it a rolling buffer of
 * mic-energy samples. Returns false on too little data (never guess from noise).
 */
export function sustainedVocalization(
  samples: AudioEnergySample[],
  now: number,
  opts: VocalCueOptions = DEFAULT_VOCAL_CUE,
): boolean {
  const recent = samples.filter(s => now - s.ts <= opts.windowMs);
  if (recent.length < 3) return false;
  const active = recent.filter(s => s.energy >= opts.energyThreshold).length;
  return active / recent.length >= opts.minActiveFraction;
}
