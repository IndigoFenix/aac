// shared/aac/voice-pitch.ts
//
// Fast-tier voice attribution by PITCH. The full speaker embedding (wavlm) is
// slow, so the client also sends a cheap median fundamental-frequency (F0) with
// each speech clip. Here we match that pitch against each known person's learned
// pitch profile to produce coarse candidates — enough, fused with the lip-sync
// evidence, for an immediate "who might be talking" read while the embedding is
// still computing in the background. Pure / no deps so the coordinator uses it
// and tests cover the matching. See planning-docs/aac-cost-saving-spec.md.

import type { VoiceCandidate } from "./speaker-fusion";

/** A known person's pitch summary (mean/std Hz over their learned samples). */
export interface PitchProfile {
  entityId?: string;
  name: string;
  meanHz: number;
  stdHz: number;
  n: number;
  /** Formant-dispersion stats (Hz), when learned for this person. */
  meanDispersion?: number;
  stdDispersion?: number;
}

/** Floor on a profile's spread (Hz). A 1-sample profile has std 0, which would
 *  make the gaussian razor-thin; real speech pitch wobbles, so allow ±this. */
export const PITCH_SPREAD_FLOOR_HZ = 22;
/** Spread floor for formant dispersion (Hz) — wider, since it's noisier. */
export const DISPERSION_SPREAD_FLOOR_HZ = 90;
/** Drop candidates below this similarity — too far in pitch to be worth showing. */
export const PITCH_MATCH_MIN = 0.3;
/** Pitch is WEAKER evidence than the embedding, so scale its similarity down a
 *  notch before it competes in fusion — the lip-sync should dominate the fast read. */
export const PITCH_CONFIDENCE_SCALE = 0.8;

// Formant-dispersion bands (Hz) — vocal-tract-length proxy. Below = larger
// tract (adult male), above = smaller (child); the middle is adult-female-ish.
export const DISPERSION_MALE_MAX = 1100;
export const DISPERSION_CHILD_MIN = 1350;

/**
 * Coarse age/gender hint — a weak clue for guessing WHO an UNIDENTIFIED voice
 * might be, never a fact. Honest about its limits:
 *  - adult-vs-child is the reliable split (kids sit high / short vocal tract),
 *  - adult gender is only moderately reliable,
 *  - we DON'T claim gender in the child range — pre-puberty voices don't
 *    distinguish boys from girls.
 * Uses FORMANT DISPERSION when available (vocal-tract length — pitch-independent,
 * so it resolves the high-man / low-woman overlap pitch can't), cross-checked
 * with pitch; falls back to pitch-only when no formant data. Returns null when
 * neither cue is measured.
 */
export function describeVoiceCharacter(
  pitchHz: number | null | undefined,
  dispersionHz?: number | null,
): string | null {
  const p = pitchHz && pitchHz > 0 ? pitchHz : null;
  const d = dispersionHz && dispersionHz > 0 ? dispersionHz : null;
  if (p == null && d == null) return null;

  // Child: short vocal tract (wide dispersion) and/or distinctly high pitch.
  const looksChild = (d != null && d > DISPERSION_CHILD_MIN) || (d == null && p != null && p > 255) || (p != null && p > 290);
  if (looksChild) return "a child (small vocal tract / high-pitched)";

  if (d != null) {
    // Formants present — lead with tract length (independent of pitch).
    if (d < DISPERSION_MALE_MAX) {
      return p != null && p > 200
        ? "an adult, mixed cues (man-sized vocal tract but high pitch)"
        : "an adult man (large vocal tract)";
    }
    if (d > DISPERSION_CHILD_MIN - 50) return "an adult woman or an older child";
    // Middle dispersion — let pitch break the tie.
    if (p != null && p < 150) return "an adult man";
    if (p != null && p >= 180) return "an adult woman";
    return "an adult (gender unclear)";
  }

  // Pitch only (coarser).
  if (p == null) return null;
  if (p >= 185) return "an adult woman or an older child";
  if (p >= 165) return "an adult, probably a woman";
  if (p >= 150) return "an adult (pitch ambiguous between man and woman)";
  return "an adult man (low-pitched)";
}

const gaussianSim = (value: number, mean: number, spread: number): number => {
  const z = (value - mean) / spread;
  return Math.exp(-0.5 * z * z);
};

/**
 * Rank known people by how well their acoustic profile explains the heard pitch
 * AND formant dispersion. Each available cue is a gaussian on its z-distance
 * (floored spread); when both pitch and a learned dispersion are present they're
 * AVERAGED (two agreeing cues discriminate better than one), then scaled to keep
 * this humble vs the full embedding match. Empty when no cue is measurable or
 * nobody is close. Marked `source: "pitch"` (the fast read).
 */
export function matchPitch(
  pitchHz: number | null | undefined,
  profiles: PitchProfile[],
  dispersionHz?: number | null,
): VoiceCandidate[] {
  const haveP = !!pitchHz && pitchHz > 0;
  const haveD = !!dispersionHz && dispersionHz > 0;
  if (!haveP && !haveD) return [];
  const out: VoiceCandidate[] = [];
  for (const p of profiles) {
    const sims: number[] = [];
    if (haveP) sims.push(gaussianSim(pitchHz!, p.meanHz, Math.max(p.stdHz, PITCH_SPREAD_FLOOR_HZ)));
    if (haveD && typeof p.meanDispersion === "number") {
      sims.push(gaussianSim(dispersionHz!, p.meanDispersion, Math.max(p.stdDispersion ?? 0, DISPERSION_SPREAD_FLOOR_HZ)));
    }
    if (!sims.length) continue;
    const similarity = (sims.reduce((a, b) => a + b, 0) / sims.length) * PITCH_CONFIDENCE_SCALE;
    if (similarity >= PITCH_MATCH_MIN) {
      out.push({ entityId: p.entityId, name: p.name, similarity, source: "pitch" });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}
