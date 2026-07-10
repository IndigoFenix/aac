/**
 * useVoiceEngagementSignal.ts
 *
 * Lightweight, fully-local mic-based voice engagement signal for the sleep system.
 * Uses an AnalyserNode FFT to compute the energy ratio in the speech band (~300-3000 Hz)
 * vs total audio energy. Speech-band-dominant content (voice) gets a high intensity;
 * broadband or low-frequency content (HVAC, fans) gets damped.
 *
 * Also opportunistically pushes a 'noise' signal on sharp non-speech energy
 * spikes (door slams, alarms) when pushNoise is provided — the doc treats noise
 * spikes as a separate, lower-weight engagement signal.
 *
 * When the Silero neural VAD is running (externalVoiceProbRef fresh), its
 * speech probability REPLACES the FFT ratio as the voice intensity — a real
 * "is someone speaking" score instead of a band-energy heuristic, so ambient
 * hum can't accumulate voice engagement and quiet speech isn't missed. The
 * noise-spike signal stays FFT-based (Silero scores non-speech near 0 by
 * design, so it can't see door slams).
 *
 * Both gated on AI playback so TTS echo through the mic doesn't false-fire.
 *
 * No Web Speech API, no third-party services — runs entirely in the browser.
 */

import { useEffect } from "react";

interface UseVoiceEngagementSignalOptions {
  micStream: MediaStream | null;
  enabled: boolean;
  /** Synchronous ref — true while AI TTS is playing through the speakers. */
  isAiPlayingRef: { readonly current: boolean };
  /** Called with intensity in [0, 1] when meaningful voice-band activity is detected. */
  push: (intensity: number) => void;
  /** Called with intensity in [0, 1] on sharp non-speech energy spikes (optional). */
  pushNoise?: (intensity: number) => void;
  /** Latest Silero speech probability (0..1) with its wall-clock timestamp.
   *  Used as the voice intensity while fresh; stale (VAD not loaded / mic
   *  down / frames stopped) falls back to the FFT heuristic. */
  externalVoiceProbRef?: { readonly current: { prob: number; at: number } };
}

const SAMPLE_INTERVAL_MS = 100;
const SPEECH_BAND_LOW_HZ = 300;
const SPEECH_BAND_HIGH_HZ = 3000;
const MIN_TOTAL_ENERGY = 0.01;
const MIN_PUSH_INTENSITY = 0.05;
const NOISE_SPIKE_SCALE = 8;
const NOISE_MIN_INTENSITY = 0.15;
/** Silero probability older than this is ignored (frames stopped flowing). */
const EXTERNAL_PROB_STALE_MS = 500;

export function useVoiceEngagementSignal({
  micStream,
  enabled,
  isAiPlayingRef,
  push,
  pushNoise,
  externalVoiceProbRef,
}: UseVoiceEngagementSignalOptions): void {
  useEffect(() => {
    if (!enabled || !micStream) return;

    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let lastTotalEnergy = 0;

    try {
      audioCtx = new AudioContext();
      source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => { /* ignore */ });
      }

      const bins = new Uint8Array(analyser.frequencyBinCount);
      const binWidthHz = audioCtx.sampleRate / 2 / analyser.frequencyBinCount;
      const lowBin = Math.floor(SPEECH_BAND_LOW_HZ / binWidthHz);
      const highBin = Math.min(analyser.frequencyBinCount - 1, Math.ceil(SPEECH_BAND_HIGH_HZ / binWidthHz));

      intervalId = setInterval(() => {
        if (isAiPlayingRef.current) {
          lastTotalEnergy = 0;
          return;
        }
        if (!analyser) return;

        analyser.getByteFrequencyData(bins);

        let totalSum = 0;
        let speechSum = 0;
        for (let i = 0; i < bins.length; i++) {
          const mag = bins[i] / 255;
          totalSum += mag;
          if (i >= lowBin && i <= highBin) speechSum += mag;
        }

        const avgTotal = totalSum / bins.length;

        // Noise spike: sharp rise in total energy versus the previous sample —
        // captures door slams / alarms / claps regardless of frequency band.
        // Use a low ratio gate so it doesn't double-fire on speech (which voice handles).
        if (pushNoise && avgTotal > MIN_TOTAL_ENERGY) {
          const ratioRaw = speechSum / Math.max(totalSum, 1e-6);
          if (ratioRaw < 0.45) {
            const delta = avgTotal - lastTotalEnergy;
            if (delta > 0) {
              const noiseIntensity = Math.min(1, delta * NOISE_SPIKE_SCALE);
              if (noiseIntensity > NOISE_MIN_INTENSITY) pushNoise(noiseIntensity);
            }
          }
        }
        lastTotalEnergy = avgTotal;

        // Neural voice intensity: while the Silero probability is fresh it IS
        // the voice signal — no energy floor needed (the model scores quiet
        // speech high and loud non-speech near zero).
        const ext = externalVoiceProbRef?.current;
        if (ext && Date.now() - ext.at < EXTERNAL_PROB_STALE_MS) {
          if (ext.prob > MIN_PUSH_INTENSITY) push(Math.min(1, ext.prob));
          return;
        }

        if (avgTotal < MIN_TOTAL_ENERGY) return;

        const ratio = speechSum / Math.max(totalSum, 1e-6);
        // Intensity = speech-band magnitude weighted by speech-band ratio.
        // Sustained HVAC (low ratio) gets damped; voice-band content gets through.
        const intensity = Math.min(1, (speechSum / bins.length) * ratio * 4);

        if (intensity > MIN_PUSH_INTENSITY) push(intensity);
      }, SAMPLE_INTERVAL_MS);
    } catch (err) {
      console.warn("[VoiceEngagement] Failed to set up AudioContext:", err);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
      try { source?.disconnect(); } catch { /* ignore */ }
      try { audioCtx?.close(); } catch { /* ignore */ }
    };
  }, [enabled, micStream, isAiPlayingRef, push, pushNoise]);
}
