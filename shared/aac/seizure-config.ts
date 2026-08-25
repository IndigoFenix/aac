// shared/aac/seizure-config.ts
//
// Per-student seizure-detection configuration + the sensitivity→threshold
// resolver. This is the TECHNICAL layer (program behavior before the LLM): it
// decides whether/when the client detectors fire a [MOTION SIGNATURE] at all.
// The CLINICAL policy (what this student's seizures look like, what's normal for
// them, what response is authorized) is separate and lives in the prompt
// (alarmConditions) — NOT here.
//
// Each seizure type is a distinct detector, so the controls are per-detector. A
// single "sensitivity" dial (with Off folded in) collapses the raw DSP thresholds
// into one meaningful choice per detector — exposing the raw constants (Hz band,
// autocorrelation, region counts) would be unusable and the per-student baseline
// already self-adapts the energy SCALE. See planning-docs/aac-seizure-recognition.

import type { Region } from "./motion-types";
import { coerceSeizureMarkers, type SeizureMarker } from "./seizure-markers";

/** Off folds detector-enable into the sensitivity dial. Higher = more sensitive
 *  = fires more readily (more warnings to the Observer, fewer misses). */
export type SeizureSensitivity = "off" | "low" | "medium" | "high";

/** Clinician-edited config. Persisted under seizureDetection.config. */
export interface SeizureConfig {
  /** Master switch — gates the whole feature (client detectors + Observer block). */
  enabled: boolean;
  /** Rhythmic/convulsive (tonic-clonic) detector sensitivity. */
  rhythmic: SeizureSensitivity;
  /** Atonic/drop-attack detector sensitivity. */
  atonic: SeizureSensitivity;
  /** Audio corroboration — only ever MODULATES a motion event, so binary. */
  audioCorroboration: boolean;
  /**
   * Per-student motor markers: the specific things THIS student does when they
   * seize ("holds her left arm up"). Still technical config — they decide when
   * the program escalates a frame — but unlike the sensitivity dials they are
   * describing one child rather than tuning a generic detector.
   *
   * They exist because the generic convulsive gate requires bilateral symmetry
   * and axial involvement, so a sustained UNILATERAL presentation can never
   * pass it at any sensitivity. See seizure-markers.ts.
   */
  markers: SeizureMarker[];
}

/** Machine-written long-term baseline (the student's habitual motion), persisted
 *  under seizureDetection.baseline so the detector starts each session already
 *  tuned instead of re-learning from scratch. NOT clinician-edited. Mirrors
 *  MotionBaseline + a stamp. */
export interface PersistedBaseline {
  /** Sparse: a region is present only if it was ever observed. An absent hand
   *  must not be recorded as a still one. */
  regionEnergy: Partial<Record<Region, number>>;
  samples: number;
  /** Per-region observation counts — a region seen for only part of a session
   *  must not be judged against a baseline built while it was missing. */
  regionSamples?: Partial<Record<Region, number>>;
  /** ISO timestamp of the last write (informational). */
  updatedAt: string;
}

/** The full JSONB column shape. config is clinician-edited; baseline is
 *  machine-written — the two write paths merge by key so neither clobbers the
 *  other (see studentService). */
export interface SeizureDetectionSettings {
  config: SeizureConfig;
  baseline?: PersistedBaseline | null;
}

/** Opt-in default: a clinical safety feature should not run unconfigured. */
export const DEFAULT_SEIZURE_CONFIG: SeizureConfig = {
  enabled: false,
  rhythmic: "off",
  atonic: "off",
  audioCorroboration: false,
  markers: [],
};

/** Resolved DSP thresholds the client detectors actually run on. `enabled:false`
 *  on a detector means it never fires. */
export interface SeizureThresholds {
  rhythmic: {
    enabled: boolean;
    /** Energy multiple of baseline for a region to count as "involved" AND the
     *  anomaly gate — the main "how far above their normal" knob. */
    involvementMult: number;
    /** Confidence floor below which a clonic call won't escalate a frame. */
    escalateConfidence: number;
  };
  atonic: {
    enabled: boolean;
    /** Downward drop for a sudden collapse, in SUBJECT-SCALE units (face widths,
     *  or torso span when pose is the source) — NOT frame fractions. The old
     *  frame-fraction units meant the same real movement cleared or missed the
     *  bar depending only on how close the child was sitting. */
    dropFrac: number;
  };
  /** Audio cue may annotate a motion event. */
  audioCorroboration: boolean;
}

// Sensitivity → threshold bundles. Low = least sensitive (fewest false warnings),
// High = most sensitive (catches more, more false warnings). The whole scale is
// tuned toward sensitivity: even "low" is fairly eager, and "medium" reproduces
// the module-constant defaults (DEFAULT_THRESHOLDS). The Observer adjudicates, so
// over-surfacing is preferable to a miss.
const RHYTHMIC_BY_SENSITIVITY: Record<Exclude<SeizureSensitivity, "off">, { involvementMult: number; escalateConfidence: number }> = {
  low: { involvementMult: 2.5, escalateConfidence: 0.45 },
  medium: { involvementMult: 1.8, escalateConfidence: 0.28 },
  high: { involvementMult: 1.3, escalateConfidence: 0.15 },
};
// In SUBJECT-SCALE units (see SeizureThresholds.atonic.dropFrac). A collapse
// moves the head down by roughly one to three face widths; "medium" asks for
// half of one. Only the sensitivity NAME is persisted per student, so retuning
// these numbers needs no migration.
const ATONIC_DROP_BY_SENSITIVITY: Record<Exclude<SeizureSensitivity, "off">, number> = {
  low: 0.75,
  medium: 0.5,
  high: 0.35,
};

/** Resolve a clinician config into the DSP thresholds the detectors run on. */
export function resolveThresholds(config: SeizureConfig): SeizureThresholds {
  const rOn = config.enabled && config.rhythmic !== "off";
  const aOn = config.enabled && config.atonic !== "off";
  const r = rOn ? RHYTHMIC_BY_SENSITIVITY[config.rhythmic as Exclude<SeizureSensitivity, "off">] : RHYTHMIC_BY_SENSITIVITY.medium;
  return {
    rhythmic: { enabled: rOn, involvementMult: r.involvementMult, escalateConfidence: r.escalateConfidence },
    atonic: { enabled: aOn, dropFrac: aOn ? ATONIC_DROP_BY_SENSITIVITY[config.atonic as Exclude<SeizureSensitivity, "off">] : ATONIC_DROP_BY_SENSITIVITY.medium },
    audioCorroboration: config.enabled && config.audioCorroboration,
  };
}

/** Markers the client should actually evaluate — none when the feature is off,
 *  so a disabled student can't be escalated by a stale marker list. */
export function resolveMarkers(config: SeizureConfig): SeizureMarker[] {
  return config.enabled ? config.markers : [];
}

/** What the server ships to the AAC client in clientConfig.seizure: the resolved
 *  DSP thresholds the detectors run on + the seed baseline. Absent/`enabled:false`
 *  → the client skips the detector. Shared so client + server agree on the shape. */
export interface ClientSeizureConfig {
  enabled: boolean;
  thresholds: SeizureThresholds;
  baseline?: PersistedBaseline | null;
  /** Per-student motor markers the client DSP evaluates each window. */
  markers?: SeizureMarker[];
}

/** Normalize a possibly-partial/legacy stored value into a full config. */
export function coerceSeizureConfig(raw: unknown): SeizureConfig {
  const c = (raw && typeof raw === "object") ? raw as Partial<SeizureConfig> : {};
  const sens = (v: unknown, d: SeizureSensitivity): SeizureSensitivity =>
    (v === "off" || v === "low" || v === "medium" || v === "high") ? v : d;
  return {
    enabled: c.enabled === true,
    rhythmic: sens(c.rhythmic, DEFAULT_SEIZURE_CONFIG.rhythmic),
    atonic: sens(c.atonic, DEFAULT_SEIZURE_CONFIG.atonic),
    audioCorroboration: c.audioCorroboration === true,
    markers: coerceSeizureMarkers(c.markers),
  };
}
