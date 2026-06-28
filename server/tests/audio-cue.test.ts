/**
 * Audio corroboration cue — the conservative "sustained vocalization?" gate.
 * It must require SUSTAINED elevated energy (not a single blip) and stay quiet
 * on too little data. It never escalates anything itself; it only annotates an
 * already-suspected motion event (tested at the useLiveSession seam).
 */

import { describe, it, expect } from "@jest/globals";
import { sustainedVocalization, DEFAULT_VOCAL_CUE, type AudioEnergySample } from "../../shared/aac/audio-cue.js";

const NOW = 100_000;
/** Build samples at 10 Hz over the window, each with the given energy. */
function samples(energies: number[]): AudioEnergySample[] {
  const n = energies.length;
  return energies.map((energy, i) => ({ ts: NOW - (n - 1 - i) * 100, energy }));
}

describe("sustainedVocalization", () => {
  it("is true when most of the window is loud", () => {
    const loud = samples(Array(30).fill(0.08));
    expect(sustainedVocalization(loud, NOW)).toBe(true);
  });

  it("is false for a single loud blip in an otherwise quiet window (cough/scrape)", () => {
    const e = Array(30).fill(0.001);
    e[15] = 0.2; // one spike
    expect(sustainedVocalization(samples(e), NOW)).toBe(false);
  });

  it("is false for quiet/silent audio", () => {
    expect(sustainedVocalization(samples(Array(30).fill(0.002)), NOW)).toBe(false);
  });

  it("is false for quiet conversation below the (raised) threshold", () => {
    // Speech ~0.02 is above the SPEECH threshold but below our 0.03 cue floor,
    // so calm talking does not corroborate.
    expect(sustainedVocalization(samples(Array(30).fill(0.02)), NOW)).toBe(false);
  });

  it("ignores samples outside the window", () => {
    const stale = samples(Array(30).fill(0.08)).map(s => ({ ...s, ts: s.ts - DEFAULT_VOCAL_CUE.windowMs * 2 }));
    expect(sustainedVocalization(stale, NOW)).toBe(false);
  });

  it("returns false on too little data rather than guessing", () => {
    expect(sustainedVocalization(samples([0.09, 0.09]), NOW)).toBe(false);
  });
});
