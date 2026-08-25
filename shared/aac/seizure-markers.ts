// shared/aac/seizure-markers.ts
//
// PER-STUDENT motor markers: the specific thing THIS student does when they
// seize ("she holds her left arm up", "his head turns to the right first").
//
// Why this is a detector feature and not just prompt text. The generic
// convulsive gate in seizure-signature.ts requires bilateral symmetry and axial
// involvement, because those are what separate a tonic-clonic from the rhythmic
// hand-wringing this population does all day. A student whose seizure presents
// as a SUSTAINED UNILATERAL ARM ELEVATION fails both tests — it is one-sided by
// definition, and a tonic posture barely moves, so the energy anomaly is small
// too. The generic detector is not merely insensitive to her; it is structurally
// incapable of calling her seizure. No amount of threshold-lowering fixes that,
// and lowering thresholds globally is how you drown the Observer in stereotypy.
//
// So a marker opens its own escalation path. A `strong` marker that a clinician
// has recorded for this student, sustained across the window, is sufficient
// evidence to show the Observer a frame — WITHOUT the symmetry/axial/energy
// gates. The Observer still adjudicates, and the summary line names the marker
// in the clinician's own words, which is far stronger evidence for the model
// than any Hz reading ("the specific thing her clinician described is present").
//
// These are TECHNICAL detector inputs (when the program escalates a frame), and
// live in aacSettings.seizureDetection.config alongside the sensitivity dials.
// The CLINICAL policy — what to actually do about it — stays in alarmConditions.
// See [[project_seizure_recognition]] and the per-student-settings principle.

import type { FacialSample, MotionFrame, Region } from "./motion-types";

/** Side, from the STUDENT's own perspective — a clinician saying "left arm"
 *  means the student's left arm, never the left of the image. Sources are
 *  responsible for un-mirroring before they populate a MotionFrame. */
export type MarkerSide = "left" | "right" | "either";

/**
 * The machine-checkable cue vocabulary. Deliberately small: every entry has to
 * be (a) reliably detectable from a close front camera with face + hand
 * tracking and (b) something caregivers actually report. Adding a cue means
 * adding a predicate below AND a translated label — don't grow this casually.
 */
export type SeizureMarkerCue =
  /** A hand/arm held above head height — the tonic arm elevation case. */
  | { kind: "limb_elevation"; side: MarkerSide }
  /** Sustained head turn to one side (version). */
  | { kind: "head_turn"; side: MarkerSide }
  /** Sustained forced eye deviation to one side. */
  | { kind: "eye_deviation"; side: MarkerSide }
  /** Forced jaw opening held open. */
  | { kind: "jaw_open" }
  /** Rapid rhythmic eyelid movement (eyelid myoclonia). */
  | { kind: "eye_flutter" }
  /** Sustained left/right facial disagreement (unilateral facial involvement). */
  | { kind: "facial_asymmetry" }
  /** Motion strongly lateralized to one side of the body. */
  | { kind: "unilateral_motion"; side: MarkerSide }
  /** Sudden sustained downward head displacement (head drop). */
  | { kind: "head_drop" };

export type MarkerKind = SeizureMarkerCue["kind"];

/** Every cue kind, for UI pickers, config coercion and the memory-schema enum. */
export const MARKER_KINDS: MarkerKind[] = [
  "limb_elevation", "head_turn", "eye_deviation", "jaw_open",
  "eye_flutter", "facial_asymmetry", "unilateral_motion", "head_drop",
];

/** Which cue kinds take a side. */
export const SIDED_KINDS: MarkerKind[] = ["limb_elevation", "head_turn", "eye_deviation", "unilateral_motion"];

export const kindTakesSide = (k: MarkerKind): boolean => SIDED_KINDS.includes(k);

/**
 * `strong` = "this alone means look now" — it opens the standalone escalation
 * path. `supportive` = "this raises my confidence in something else" — it only
 * boosts an event another detector already found. Clinicians pick; the default
 * is supportive, because a standalone path is a licence to interrupt.
 */
export type MarkerWeight = "supportive" | "strong";

export interface SeizureMarker {
  /** Stable id so edits/telemetry survive relabelling. */
  id: string;
  /** The clinician's own words. Rendered verbatim to the Observer, so it is
   *  the description the model reasons about — keep it concrete. */
  label: string;
  cue: SeizureMarkerCue;
  weight: MarkerWeight;
}

export interface MatchedMarker {
  id: string;
  label: string;
  kind: MarkerKind;
  weight: MarkerWeight;
  /** Fraction of the window the cue held, 0..1. */
  strength: number;
}

// ── Thresholds ───────────────────────────────────────────────────────────────
// Tuned toward sensitivity like the rest of the module: a marker is something a
// clinician explicitly said is abnormal FOR THIS STUDENT, so the bar for
// believing it is lower than for a generic pattern. The guard against a benign
// match (she reached up for a toy) is SUSTAIN, not a high per-frame threshold —
// voluntary movements pass through a posture, seizures hold it.

/** A cue must hold for this fraction of the evaluable frames to count. */
export const MARKER_SUSTAIN_FRAC = 0.6;
/** Below this many evaluable frames we decline to judge rather than guess. */
export const MARKER_MIN_FRAMES = 4;
/**
 * Hand/wrist this far above the face centre (in face widths) reads as elevated.
 * Set CLEARLY above the top of the head (the face box's half-height is roughly
 * 0.65 face widths) rather than just above centre, because hand-to-face and
 * hand-to-mouth movements are constant in this population and would otherwise
 * match "arm raised" all day long.
 */
export const ELEVATION_MARGIN = 0.8;
/** |yaw| past this reads as a sustained head turn. Normalized ~-1..1. */
export const HEAD_TURN_MIN = 0.28;
/** |gazeX| past this reads as forced eye deviation. Blendshape units 0..1. */
export const EYE_DEVIATION_MIN = 0.4;
/** jawOpen past this reads as forced jaw opening. */
export const JAW_OPEN_MIN = 0.45;
/** Facial left/right disagreement past this reads as asymmetric involvement. */
export const ASYMMETRY_MIN = 0.25;
/** One side must carry this multiple of the other's energy to read as lateralized. */
export const LATERALIZATION_MULT = 2.5;
/** Eyelid myoclonia band (Hz) — faster than voluntary blinking, and rhythmic. */
export const FLUTTER_HZ_MIN = 3;
export const FLUTTER_HZ_MAX = 10;
/** Blink-series rhythmicity floor for a flutter call. */
export const FLUTTER_RHYTHMICITY_MIN = 0.3;
/** Downward head displacement (scale units) that reads as a head drop. */
export const HEAD_DROP_MIN = 0.5;
export const HEAD_DROP_WINDOW_MS = 1200;

/**
 * Everything the cue predicates need, derived once per window by the DSP so
 * each marker isn't recomputing series. Supplied by seizure-signature.
 */
export interface MarkerContext {
  frames: MotionFrame[];
  /** Scale-normalized, anchor-relative position series per region. */
  relPos: Partial<Record<Region, { x: number[]; y: number[] }>>;
  /** Mean per-second energy per region over the window. */
  regionEnergy: Partial<Record<Region, number>>;
  /** Facial samples present in the window, in order (may be shorter than frames). */
  facial: FacialSample[];
  /** Autocorrelation helper the DSP already owns, reused for the flutter cue. */
  dominantFrequency: (series: number[], meanDtMs: number) => { hz: number; rhythmicity: number };
  meanDtMs: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Fraction of `n` evaluable samples for which `pred` held, or null when there
 *  weren't enough samples to judge. */
function sustained(n: number, pred: (i: number) => boolean): number | null {
  if (n < MARKER_MIN_FRAMES) return null;
  let hits = 0;
  for (let i = 0; i < n; i++) if (pred(i)) hits++;
  return hits / n;
}

/** Signed side test: does `v` point to `side`? `+` is the student's RIGHT for
 *  both yaw and gazeX (see FacialSample). "either" accepts either direction. */
function towardSide(v: number, side: MarkerSide, min: number): boolean {
  if (side === "either") return Math.abs(v) >= min;
  return side === "right" ? v >= min : v <= -min;
}

/** The hand-then-arm region for a side, whichever the window actually has. */
function limbRegions(side: MarkerSide): Region[] {
  if (side === "left") return ["leftHand", "leftArm"];
  if (side === "right") return ["rightHand", "rightArm"];
  return ["leftHand", "leftArm", "rightHand", "rightArm"];
}

/**
 * Evaluate one cue against the window. Returns the sustained fraction (0..1),
 * or null when the window could not evaluate it (sensor absent, too few
 * samples) — null is NOT a miss, and callers must not treat it as evidence of
 * absence. A hand out of frame means we don't know, and saying "no marker" for
 * a student whose marker is an arm the camera can't see would be the worst
 * possible failure.
 */
export function evaluateCue(cue: SeizureMarkerCue, ctx: MarkerContext): number | null {
  const { relPos, regionEnergy, facial } = ctx;

  switch (cue.kind) {
    case "limb_elevation": {
      // Anchor-relative y is already scale-normalized and y grows DOWNWARD, so
      // "above the anchor" is a sufficiently negative y.
      const candidates = limbRegions(cue.side).filter(r => relPos[r]?.y.length);
      if (!candidates.length) return null;
      let best: number | null = null;
      for (const r of candidates) {
        const ys = relPos[r]!.y;
        const frac = sustained(ys.length, i => ys[i] <= -ELEVATION_MARGIN);
        if (frac !== null && (best === null || frac > best)) best = frac;
      }
      return best;
    }

    case "head_turn":
      return sustained(facial.length, i => towardSide(facial[i].yaw, cue.side, HEAD_TURN_MIN));

    case "eye_deviation":
      return sustained(facial.length, i => towardSide(facial[i].gazeX, cue.side, EYE_DEVIATION_MIN));

    case "jaw_open":
      return sustained(facial.length, i => facial[i].jawOpen >= JAW_OPEN_MIN);

    case "facial_asymmetry":
      return sustained(facial.length, i => facial[i].asymmetry >= ASYMMETRY_MIN);

    case "eye_flutter": {
      // Rhythmic co-oscillation of both lids. Mean of the two so a one-eyed
      // tracking artefact doesn't read as flutter.
      if (facial.length < MARKER_MIN_FRAMES + 2) return null;
      const lid = facial.map(f => (f.eyeBlinkLeft + f.eyeBlinkRight) / 2);
      const { hz, rhythmicity } = ctx.dominantFrequency(lid, ctx.meanDtMs);
      if (hz < FLUTTER_HZ_MIN || hz > FLUTTER_HZ_MAX) return 0;
      if (rhythmicity < FLUTTER_RHYTHMICITY_MIN) return 0;
      return clamp01(rhythmicity);
    }

    case "unilateral_motion": {
      const l = (regionEnergy.leftHand ?? 0) + (regionEnergy.leftArm ?? 0);
      const r = (regionEnergy.rightHand ?? 0) + (regionEnergy.rightArm ?? 0);
      const sawLeft = regionEnergy.leftHand !== undefined || regionEnergy.leftArm !== undefined;
      const sawRight = regionEnergy.rightHand !== undefined || regionEnergy.rightArm !== undefined;
      // Both sides must be OBSERVED — one hand simply being out of frame is not
      // lateralized motion, it's a missing sensor.
      if (!sawLeft || !sawRight) return null;
      const hi = Math.max(l, r), lo = Math.min(l, r);
      if (hi <= 0) return 0;
      const ratio = lo > 0 ? hi / lo : LATERALIZATION_MULT;
      if (ratio < LATERALIZATION_MULT) return 0;
      const hotSide: MarkerSide = l > r ? "left" : "right";
      if (cue.side !== "either" && cue.side !== hotSide) return 0;
      return clamp01(ratio / (LATERALIZATION_MULT * 2));
    }

    case "head_drop": {
      const ys = relPos.head?.y;
      if (!ys || ys.length < 3) return null;
      const frames = ctx.frames;
      let maxDrop = 0;
      for (let i = 0; i < ys.length; i++) {
        for (let j = i + 1; j < ys.length && frames[j] && frames[i]
             && frames[j].ts - frames[i].ts <= HEAD_DROP_WINDOW_MS; j++) {
          const d = ys[j] - ys[i]; // + = moved DOWN
          if (d > maxDrop) maxDrop = d;
        }
      }
      // Persistence check: a nod nets ~0, a drop stays down.
      const net = ys[ys.length - 1] - ys[0];
      if (maxDrop < HEAD_DROP_MIN || net < HEAD_DROP_MIN * 0.5) return 0;
      return clamp01(maxDrop / (HEAD_DROP_MIN * 2));
    }

    default:
      return null;
  }
}

/**
 * Evaluate every configured marker against the window. Only markers that both
 * evaluated AND cleared the sustain bar are returned, strongest first.
 */
export function evaluateMarkers(markers: SeizureMarker[], ctx: MarkerContext): MatchedMarker[] {
  const out: MatchedMarker[] = [];
  for (const m of markers) {
    const strength = evaluateCue(m.cue, ctx);
    if (strength === null || strength < MARKER_SUSTAIN_FRAC) continue;
    out.push({ id: m.id, label: m.label, kind: m.cue.kind, weight: m.weight, strength });
  }
  return out.sort((a, b) => b.strength - a.strength);
}

/** Any matched marker the clinician marked as sufficient on its own. */
export const hasStrongMarker = (matched: MatchedMarker[]): boolean =>
  matched.some(m => m.weight === "strong");

/** Normalize a possibly-partial/legacy stored array into valid markers. Unknown
 *  kinds and unlabelled entries are DROPPED — a marker we can't evaluate must
 *  not sit in the UI looking as though it is protecting someone. */
export function coerceSeizureMarkers(raw: unknown): SeizureMarker[] {
  if (!Array.isArray(raw)) return [];
  const out: SeizureMarker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const cueRaw = (r.cue && typeof r.cue === "object") ? r.cue as Record<string, unknown> : null;
    const kind = cueRaw?.kind;
    if (typeof kind !== "string" || !MARKER_KINDS.includes(kind as MarkerKind)) continue;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) continue;
    const sideRaw = cueRaw?.side;
    const side: MarkerSide =
      sideRaw === "left" || sideRaw === "right" || sideRaw === "either" ? sideRaw : "either";
    const cue = (kindTakesSide(kind as MarkerKind)
      ? { kind, side }
      : { kind }) as SeizureMarkerCue;
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : `mk_${out.length}_${kind}`,
      label: label.slice(0, 120),
      cue,
      weight: r.weight === "strong" ? "strong" : "supportive",
    });
  }
  return out;
}
