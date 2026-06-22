// client-aac/src/lib/voiceFeatures.ts
//
// FAST-tier voice features. The full speaker embedding (wavlm) is slow, so we
// also extract a cheap acoustic fingerprint — median fundamental frequency (F0)
// — straight from the speech WAV with plain DSP (no model). This is sent
// immediately with the STT clip so the server can give an instant pitch + lip
// read of who's talking while the embedding computes in the background.
// See planning-docs/aac-cost-saving-spec.md (two-tier voice recognition).

import { decodeWavMono, resampleTo16k } from "./decodeWav";
import { estimateFormantDispersion } from "@shared/aac/voice-formants";

export interface VoiceFeatures {
  /** Median fundamental frequency in Hz over voiced frames, or null if none. */
  pitchHz: number | null;
  /** Fraction of frames judged voiced (0..1) — a rough "how much speech". */
  voiced: number;
  /** Median formant dispersion (Hz) — vocal-tract-length proxy for the age/gender
   *  read; null when not measurable. */
  formantDispersion: number | null;
}

const SR = 16000;
const FRAME = 1024;          // ~64ms — low enough F0 resolves
const HOP = 512;             // 50% overlap
const MIN_F0 = 70;           // Hz — below adult male
const MAX_F0 = 400;          // Hz — above child/high female
const RMS_SILENCE = 0.01;    // below this a frame is silence
const VOICING_RATIO = 0.3;   // autocorr peak / zero-lag energy to call it voiced

/**
 * Estimate median pitch from a speech clip via short-time autocorrelation.
 * Cheap enough (a few ms) to run inline before sending the clip. Returns
 * pitchHz=null for unvoiced / whispered / too-quiet audio.
 */
export async function analyzeVoicePitch(wav: Blob): Promise<VoiceFeatures> {
  const decoded = await decodeWavMono(wav);
  if (!decoded || !decoded.samples.length) return { pitchHz: null, voiced: 0, formantDispersion: null };
  const samples = resampleTo16k(decoded.samples, decoded.sampleRate);
  // Formant dispersion (vocal-tract length) from the same samples — complements
  // pitch for the age/gender read. Best-effort: null on noisy/short audio.
  let formantDispersion: number | null = null;
  try { formantDispersion = estimateFormantDispersion(samples, SR); } catch { /* non-critical */ }

  const minLag = Math.floor(SR / MAX_F0);
  const maxLag = Math.floor(SR / MIN_F0);
  const pitches: number[] = [];
  let voicedFrames = 0;
  let totalFrames = 0;

  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    totalFrames++;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[start + i];
      energy += s * s;
    }
    const rms = Math.sqrt(energy / FRAME);
    if (rms < RMS_SILENCE) continue;

    // Autocorrelation peak within the human-F0 lag range.
    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < FRAME - lag; i++) corr += samples[start + i] * samples[start + i + lag];
      corr /= FRAME - lag;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const r0 = energy / FRAME; // zero-lag energy
    if (bestLag > 0 && r0 > 0 && bestCorr / r0 > VOICING_RATIO) {
      pitches.push(SR / bestLag);
      voicedFrames++;
    }
  }

  if (!pitches.length) return { pitchHz: null, voiced: 0, formantDispersion };
  pitches.sort((a, b) => a - b);
  const median = pitches[Math.floor(pitches.length / 2)];
  return { pitchHz: Math.round(median), voiced: totalFrames ? voicedFrames / totalFrames : 0, formantDispersion };
}
