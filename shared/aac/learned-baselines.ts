// shared/aac/learned-baselines.ts
//
// ONE home, and one write-back channel, for every MACHINE-LEARNED per-student
// baseline. Currently three of them:
//   * `seizure`     — habitual motion energy per region, for the seizure DSP
//   * `headNeutral` — habitual head pose relative to the device
//   * `face`        — habitual facial channel distributions (face-baseline.ts)
//
// WHY THIS EXISTS. `PersistedBaseline` (seizure-config.ts) is documented as
// machine-written "so the detector starts each session already tuned instead of
// re-learning from scratch", and the server does seed it to the client — but
// nothing ever wrote it back. There is no client→server baseline message in
// live-relay.ts. So the seizure detector has been re-learning from cold every
// session since it shipped, and its long-term baseline has always been empty.
//
// The head-attention neutral needs exactly the same round trip, so rather than
// build a second bespoke path this module defines the shared envelope and both
// use it. New learned quantities should be added here, not given their own
// column.
//
// ⚠️ MACHINE-WRITTEN, NEVER CLINICIAN- OR AI-EDITED. Stored under
// `aac_settings.learnedBaselines`. It must stay out of the AI-editable
// whitelist in aac-settings-memory-schema.ts, exactly as `seizureDetection`'s
// baseline half already is — an agent that could edit these could silently
// blind the seizure detector.
//
// ⚠️ EVERY MERGE IS COUNT-WEIGHTED AND CAPPED. A baseline is only worth having
// if it cannot be swung by one odd session; see head-attention.ts for the full
// reasoning and the constants.

import type { Region } from "./motion-types";
import type { PersistedBaseline } from "./seizure-config";
import {
  mergeNeutralProfile, neutralReliability,
  type HeadNeutralProfile, type SessionNeutralObservation,
} from "./head-attention";
import {
  coerceFaceBaseline, mergeFaceBaseline, faceBaselineReliability,
  type FaceBaselineProfile, type SessionFaceObservation,
} from "./face-baseline";

/** The whole machine-learned set for one student. Every field optional: an
 *  absent baseline means "never learned", which is NOT the same as zero. */
export interface LearnedBaselines {
  seizure?: PersistedBaseline;
  headNeutral?: HeadNeutralProfile;
  /** Per-channel facial distributions — the thing every expression threshold is
   *  now measured against. Much the largest of the three on the wire (a sparse
   *  histogram per channel), which is why it carries its own caps. */
  face?: FaceBaselineProfile;
}

/** What a client session offers up at the end of a session. */
export interface LearnedBaselineObservation {
  /** Motion baseline as the DSP learned it this session. */
  seizure?: { regionEnergy: Partial<Record<Region, number>>; samples: number; regionSamples?: Partial<Record<Region, number>> };
  /** Head neutral as the attention tracker observed it this session. */
  headNeutral?: SessionNeutralObservation;
  /** Facial channel histograms as the decoder observed them this session.
   *  Quality-gated on intake — see face-read.ts. */
  face?: SessionFaceObservation;
}

/** One session may contribute at most this much weight to the seizure baseline,
 *  mirroring NEUTRAL_SESSION_WEIGHT_CAP. */
export const SEIZURE_SESSION_WEIGHT_CAP = 500;
/** And the stored baseline counts at most this much, so it stays adaptive. */
export const SEIZURE_MEMORY_CAP = 5_000;
/** Below this many samples a session says nothing about habitual motion. */
export const SEIZURE_SESSION_MIN_SAMPLES = 30;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Tolerate anything the column might hold — a legacy shape, a partial write, or
 * garbage — and return something safe to read. Same contract as
 * coerceSeizureConfig: never throw, never invent data.
 */
export function coerceLearnedBaselines(raw: unknown): LearnedBaselines {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, any>;
  const out: LearnedBaselines = {};

  const s = r.seizure;
  if (s && typeof s === "object" && isNum(s.samples) && s.samples >= 0 && s.regionEnergy && typeof s.regionEnergy === "object") {
    const regionEnergy: Partial<Record<Region, number>> = {};
    for (const [k, v] of Object.entries(s.regionEnergy)) if (isNum(v)) regionEnergy[k as Region] = v;
    const regionSamples: Partial<Record<Region, number>> = {};
    if (s.regionSamples && typeof s.regionSamples === "object") {
      for (const [k, v] of Object.entries(s.regionSamples)) if (isNum(v)) regionSamples[k as Region] = v;
    }
    out.seizure = {
      regionEnergy,
      samples: s.samples,
      regionSamples: Object.keys(regionSamples).length ? regionSamples : undefined,
      updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date(0).toISOString(),
    };
  }

  const f = coerceFaceBaseline(r.face);
  if (f) out.face = f;

  const h = r.headNeutral;
  if (h && typeof h === "object" && isNum(h.yaw) && isNum(h.pitch) && isNum(h.n) && isNum(h.sessions)) {
    out.headNeutral = {
      yaw: h.yaw, pitch: h.pitch,
      yawSpread: isNum(h.yawSpread) ? h.yawSpread : 0,
      pitchSpread: isNum(h.pitchSpread) ? h.pitchSpread : 0,
      n: Math.max(0, h.n), sessions: Math.max(0, h.sessions),
      updatedAt: typeof h.updatedAt === "string" ? h.updatedAt : new Date(0).toISOString(),
    };
  }

  return out;
}

/**
 * Merge one session's motion observation into the stored seizure baseline.
 *
 * Per-region and count-weighted, because regions are observed independently: a
 * hand that was out of frame all session must not be recorded as a still one.
 * A region absent from the observation leaves its stored value untouched.
 */
export function mergeSeizureBaseline(
  stored: PersistedBaseline | undefined,
  obs: NonNullable<LearnedBaselineObservation["seizure"]>,
  nowIso: string,
): PersistedBaseline | undefined {
  if (!obs || obs.samples < SEIZURE_SESSION_MIN_SAMPLES) return stored;

  const regionEnergy: Partial<Record<Region, number>> = { ...(stored?.regionEnergy ?? {}) };
  const regionSamples: Partial<Record<Region, number>> = { ...(stored?.regionSamples ?? {}) };

  for (const [k, energy] of Object.entries(obs.regionEnergy)) {
    if (!isNum(energy)) continue;
    const region = k as Region;
    const obsN = Math.min(obs.regionSamples?.[region] ?? obs.samples, SEIZURE_SESSION_WEIGHT_CAP);
    if (obsN <= 0) continue;
    const priorN = Math.min(regionSamples[region] ?? 0, SEIZURE_MEMORY_CAP);
    const prior = regionEnergy[region];
    if (prior === undefined || priorN <= 0) {
      regionEnergy[region] = energy;
    } else {
      const a = obsN / (priorN + obsN);
      regionEnergy[region] = prior + a * (energy - prior);
    }
    regionSamples[region] = (regionSamples[region] ?? 0) + (obs.regionSamples?.[region] ?? obs.samples);
  }

  return {
    regionEnergy,
    samples: (stored?.samples ?? 0) + obs.samples,
    regionSamples: Object.keys(regionSamples).length ? regionSamples : undefined,
    updatedAt: nowIso,
  };
}

/**
 * Fold a session's observations into the stored set. Each kind applies its own
 * rules (and its own quality gates), and anything the session did not observe
 * is left exactly as it was — a session with no face must not erase a head
 * neutral learned over weeks.
 */
export function mergeLearnedBaselines(
  stored: LearnedBaselines | null | undefined,
  obs: LearnedBaselineObservation,
  nowIso: string,
): LearnedBaselines {
  const base = stored ?? {};
  const out: LearnedBaselines = { ...base };

  if (obs.seizure) {
    const merged = mergeSeizureBaseline(base.seizure, obs.seizure, nowIso);
    if (merged) out.seizure = merged;
  }
  if (obs.headNeutral) {
    out.headNeutral = mergeNeutralProfile(base.headNeutral ?? null, obs.headNeutral, nowIso);
  }
  if (obs.face) {
    const merged = mergeFaceBaseline(base.face, obs.face, nowIso);
    if (merged) out.face = merged;
  }
  return out;
}

/** True when a session actually observed something worth a round trip. Callers
 *  use this to avoid a pointless write on a session where nothing was seen. */
export function hasObservation(obs: LearnedBaselineObservation | null | undefined): boolean {
  if (!obs) return false;
  const s = obs.seizure && obs.seizure.samples >= SEIZURE_SESSION_MIN_SAMPLES;
  const h = obs.headNeutral && obs.headNeutral.n > 0;
  const f = obs.face && obs.face.n > 0;
  return Boolean(s || h || f);
}

/**
 * Read the seizure baseline for seeding, preferring the unified home and
 * falling back to the legacy `seizureDetection.baseline`. Keeps older stored
 * settings working without a migration — the column is jsonb, so the new key
 * simply appears when the first write-back lands.
 */
export function readSeizureBaselineForSeed(aacSettings: any): PersistedBaseline | null {
  const unified = coerceLearnedBaselines(aacSettings?.learnedBaselines).seizure;
  if (unified) return unified;
  const legacy = aacSettings?.seizureDetection?.baseline;
  return legacy ?? null;
}

/** Head neutral for seeding, plus how much it deserves to be trusted. */
export function readHeadNeutralForSeed(
  aacSettings: any,
): { profile: HeadNeutralProfile; trust: number } | null {
  const profile = coerceLearnedBaselines(aacSettings?.learnedBaselines).headNeutral;
  if (!profile) return null;
  return { profile, trust: neutralReliability(profile) };
}

/** Facial baseline for seeding, plus how much it deserves to be trusted. There
 *  is no legacy fallback here — this channel has never existed anywhere else. */
export function readFaceBaselineForSeed(
  aacSettings: any,
): { profile: FaceBaselineProfile; trust: number } | null {
  const profile = coerceLearnedBaselines(aacSettings?.learnedBaselines).face;
  if (!profile) return null;
  return { profile, trust: faceBaselineReliability(profile) };
}
