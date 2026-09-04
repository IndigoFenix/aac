// shared/aac/face-aus.ts
//
// L3 of the face decoder: aggregate the 52 ARKit blendshapes into FACS ACTION
// UNITS, and expose the flat channel list that everything downstream baselines
// and thresholds against.
//
// WHY NOT USE THE BLENDSHAPES DIRECTLY. Google's own hedge is that the 52
// outputs "loosely correspond" to FACS. A single blendshape is a weak, noisy,
// model-specific quantity; an AU is a muscle action with a literature behind
// it, and — the part that matters — FACS/EMFACS inference is over COMBINATIONS
// (AU6+AU12 → felt happiness, AU4+AU5/AU7 → anger, AU4+AU15 → sadness), not
// over single channels. The decoder this replaces tested `mouthSmileL/R > 0.5`,
// which is AU12 alone: exactly the polite/social smile that AU6 (cheek raiser,
// the Duchenne marker) exists to separate from felt positive affect.
//
// The mapping below follows the published expert-consensus blendshape→AU table
// (ten licensed clinical psychologists annotating independently; 88% of
// mappings unanimous, 98% majority-supported) rather than the one-blendshape-
// per-emotion heuristics it replaces. See the sources in
// planning-docs/aac-face-expression-decoder.md.
//
// ⚠️ D2 — MEASURE BEFORE COMPOSING. Several blendshapes in this model sit near
// zero regardless of the face in front of it (`eyeWide*` is the documented
// case). A composite that REQUIRES such a channel is structurally incapable of
// firing, which is a live bug in the decoder this replaces, not a hypothesis.
// Two rules follow, and both are enforced downstream rather than here:
//   1. no composite may GATE on a channel — a channel that never moves must
//      cost confidence, never veto the read (see face-read.ts);
//   2. a channel with no observed spread over a large sample is marked dead by
//      the baseline and excluded from composites (see face-baseline.ts).
// Per-student z-scoring does most of this work on its own: once a channel is
// scored against ITS OWN distribution for THIS child, an attenuated channel is
// still usable — it is only a dead one that is lost.
//
// ⚠️ SIDES ARE THE SUBJECT'S, matching MediaPipe's blendshape naming.

import type { FaceGeometry } from "./face-features";

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

export type ActionUnitId =
  | "AU01" | "AU02" | "AU04" | "AU05" | "AU06" | "AU07" | "AU09" | "AU10"
  | "AU12" | "AU14" | "AU15" | "AU17" | "AU18" | "AU20" | "AU23" | "AU25"
  | "AU26" | "AU43";

export interface ActionUnitDef {
  id: ActionUnitId;
  /** FACS name. */
  name: string;
  /** Plain-language phrase for the scene line — no jargon reaches the AI. */
  label: string;
  /** Blendshapes contributing on the subject's left / right / midline. */
  left?: string[];
  right?: string[];
  mid?: string[];
  /** Subtracted before clamping at zero. Only AU25 uses one: ARKit's
   *  `mouthClose` is "lips together despite an open jaw", so lips-parted is
   *  jaw drop MINUS it. */
  inhibitor?: string;
  /** Set where this model is known or suspected to attenuate the channel. Not
   *  a threshold — it is carried through to the read so a consumer can weigh
   *  it, and it is why nothing gates on these. */
  attenuated?: boolean;
}

/**
 * Ordered upper-face first, then lower face, then eye closure — the FACS
 * convention, and it keeps the scene line reading top-to-bottom.
 */
export const ACTION_UNITS: ActionUnitDef[] = [
  { id: "AU01", name: "inner brow raiser", label: "inner brows up", mid: ["browInnerUp"] },
  { id: "AU02", name: "outer brow raiser", label: "brows raised", left: ["browOuterUpLeft"], right: ["browOuterUpRight"] },
  { id: "AU04", name: "brow lowerer", label: "brow furrowed", left: ["browDownLeft"], right: ["browDownRight"] },
  // eyeWide* is the documented near-zero channel (MediaPipe #5329). Measured on
  // prod it is attenuated rather than dead — `surprised` did fire, 20 times in
  // 789 rows — so it is kept and flagged, not dropped.
  { id: "AU05", name: "upper lid raiser", label: "eyes wide", left: ["eyeWideLeft"], right: ["eyeWideRight"], attenuated: true },
  // The Duchenne marker. Never measured on this population; flagged until it is.
  { id: "AU06", name: "cheek raiser", label: "cheeks raised", left: ["cheekSquintLeft"], right: ["cheekSquintRight"], attenuated: true },
  { id: "AU07", name: "lid tightener", label: "eyes narrowed", left: ["eyeSquintLeft"], right: ["eyeSquintRight"] },
  { id: "AU09", name: "nose wrinkler", label: "nose wrinkled", left: ["noseSneerLeft"], right: ["noseSneerRight"], attenuated: true },
  { id: "AU10", name: "upper lip raiser", label: "upper lip raised", left: ["mouthUpperUpLeft"], right: ["mouthUpperUpRight"] },
  { id: "AU12", name: "lip corner puller", label: "smiling", left: ["mouthSmileLeft"], right: ["mouthSmileRight"] },
  { id: "AU14", name: "dimpler", label: "dimpling", left: ["mouthDimpleLeft"], right: ["mouthDimpleRight"] },
  { id: "AU15", name: "lip corner depressor", label: "mouth corners down", left: ["mouthFrownLeft"], right: ["mouthFrownRight"] },
  { id: "AU17", name: "chin raiser", label: "chin raised", mid: ["mouthShrugLower"] },
  { id: "AU18", name: "lip pucker", label: "lips pursed", mid: ["mouthPucker"] },
  { id: "AU20", name: "lip stretcher", label: "lips stretched", left: ["mouthStretchLeft"], right: ["mouthStretchRight"] },
  { id: "AU23", name: "lip tightener", label: "lips pressed", left: ["mouthPressLeft"], right: ["mouthPressRight"] },
  { id: "AU25", name: "lips part", label: "lips parted", mid: ["jawOpen"], inhibitor: "mouthClose" },
  { id: "AU26", name: "jaw drop", label: "mouth open", mid: ["jawOpen"] },
  { id: "AU43", name: "eyes closed", label: "eyes closed", left: ["eyeBlinkLeft"], right: ["eyeBlinkRight"] },
];

export const ACTION_UNIT_BY_ID: Record<ActionUnitId, ActionUnitDef> =
  Object.fromEntries(ACTION_UNITS.map((d) => [d.id, d])) as Record<ActionUnitId, ActionUnitDef>;

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export interface ActionUnitValue {
  id: ActionUnitId;
  /** 0..1 aggregate intensity. */
  value: number;
  /** Per-side intensities where the AU is sided; undefined on midline AUs. */
  left?: number;
  right?: number;
  /** Signed left − right. Unilateral facial movement is clinically meaningful,
   *  so it is reported, not averaged away. */
  asymmetry?: number;
}

export type ActionUnitMap = Partial<Record<ActionUnitId, ActionUnitValue>>;

const mean = (m: Map<string, number>, keys: string[] | undefined): number | undefined => {
  if (!keys || keys.length === 0) return undefined;
  let sum = 0, n = 0;
  for (const k of keys) {
    const v = m.get(k);
    if (typeof v === "number" && Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : undefined;
};

/**
 * Aggregate one blendshape map into action units.
 *
 * A missing blendshape is OMITTED, never treated as zero: an absent channel
 * means the model did not report it, and averaging a zero in would quietly
 * halve the AU. An AU with no contributing blendshape present at all is left
 * out of the map entirely.
 */
export function computeActionUnits(blendshapes: Map<string, number> | undefined): ActionUnitMap {
  const out: ActionUnitMap = {};
  if (!blendshapes || blendshapes.size === 0) return out;

  for (const def of ACTION_UNITS) {
    const l = mean(blendshapes, def.left);
    const r = mean(blendshapes, def.right);
    const m = mean(blendshapes, def.mid);

    const parts: number[] = [];
    if (l !== undefined) parts.push(l);
    if (r !== undefined) parts.push(r);
    if (m !== undefined) parts.push(m);
    if (parts.length === 0) continue;

    let value = parts.reduce((a, b) => a + b, 0) / parts.length;
    if (def.inhibitor) {
      const inh = blendshapes.get(def.inhibitor);
      if (typeof inh === "number" && Number.isFinite(inh)) value = Math.max(0, value - inh);
    }

    const av: ActionUnitValue = { id: def.id, value: Math.max(0, Math.min(1, value)) };
    if (l !== undefined) av.left = l;
    if (r !== undefined) av.right = r;
    if (l !== undefined && r !== undefined) av.asymmetry = l - r;
    out[def.id] = av;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The flat channel namespace
// ---------------------------------------------------------------------------
//
// One namespace for everything the baseline stores and the decoder thresholds,
// so a channel can be named in one place and found in every other. `au:` for
// action units, `geom:` for the landmark geometry.

/** Geometry features that are worth baselining per student. Not every field of
 *  FaceGeometry: `interocular` is a distance-to-camera proxy, not a facial
 *  action, and baselining it would just track where the tablet sits. */
export const GEOMETRY_CHANNELS = [
  "eyeAspectLeft", "eyeAspectRight",
  "mouthAspect", "mouthWidth",
  "lipCornerElevLeft", "lipCornerElevRight",
  "browLidGapLeft", "browLidGapRight",
] as const;

export type GeometryChannel = (typeof GEOMETRY_CHANNELS)[number];

/** Fully-qualified channel name, e.g. "au:AU12" or "geom:mouthAspect". */
export type FaceChannel = string;

export const auChannel = (id: ActionUnitId): FaceChannel => `au:${id}`;
export const geomChannel = (g: GeometryChannel): FaceChannel => `geom:${g}`;

/** Every channel the decoder can observe, in a stable order. */
export const FACE_CHANNELS: FaceChannel[] = [
  ...ACTION_UNITS.map((d) => auChannel(d.id)),
  ...GEOMETRY_CHANNELS.map((g) => geomChannel(g)),
];

/**
 * Geometry channels are unbounded ratios while AU channels are 0..1, and the
 * baseline stores a fixed-range histogram — so each geometry channel declares
 * the range its histogram covers. Values outside are clamped into the end bins,
 * which is correct for a baseline (an extreme is still evidence of an extreme)
 * even though it costs resolution there.
 *
 * Ranges are generous rather than tight: a range that clips normal variation
 * would flatten the very distribution we are trying to learn.
 */
export const GEOMETRY_RANGES: Record<GeometryChannel, { min: number; max: number }> = {
  eyeAspectLeft: { min: 0, max: 0.6 },
  eyeAspectRight: { min: 0, max: 0.6 },
  mouthAspect: { min: 0, max: 0.8 },
  mouthWidth: { min: 0.4, max: 2.0 },
  lipCornerElevLeft: { min: -0.5, max: 0.5 },
  lipCornerElevRight: { min: -0.5, max: 0.5 },
  browLidGapLeft: { min: 0, max: 1.0 },
  browLidGapRight: { min: 0, max: 1.0 },
};

/** The histogram range for any channel. AUs are intensities in 0..1. */
export function channelRange(channel: FaceChannel): { min: number; max: number } {
  if (channel.startsWith("geom:")) {
    const key = channel.slice(5) as GeometryChannel;
    return GEOMETRY_RANGES[key] ?? { min: 0, max: 1 };
  }
  return { min: 0, max: 1 };
}

/**
 * Flatten one frame's AUs and geometry into the channel namespace. A channel
 * whose source was undefined is ABSENT from the result — the caller must not
 * substitute zero (that is the same mistake as recording an out-of-frame limb
 * as a still one, which the seizure baseline already goes out of its way to
 * avoid).
 */
export function toChannelValues(
  aus: ActionUnitMap,
  geometry: FaceGeometry | undefined,
): Map<FaceChannel, number> {
  const out = new Map<FaceChannel, number>();
  for (const def of ACTION_UNITS) {
    const v = aus[def.id];
    if (v && Number.isFinite(v.value)) out.set(auChannel(def.id), v.value);
  }
  if (geometry) {
    for (const g of GEOMETRY_CHANNELS) {
      const v = geometry[g];
      if (typeof v === "number" && Number.isFinite(v)) out.set(geomChannel(g), v);
    }
  }
  return out;
}

/** Plain-language label for a channel, for the scene line. */
export function channelLabel(channel: FaceChannel): string {
  if (channel.startsWith("au:")) {
    const def = ACTION_UNIT_BY_ID[channel.slice(3) as ActionUnitId];
    if (def) return def.label;
  }
  if (channel.startsWith("geom:")) {
    switch (channel.slice(5) as GeometryChannel) {
      case "eyeAspectLeft": return "left eye open";
      case "eyeAspectRight": return "right eye open";
      case "mouthAspect": return "mouth open";
      case "mouthWidth": return "mouth wide";
      case "lipCornerElevLeft": return "left corner up";
      case "lipCornerElevRight": return "right corner up";
      case "browLidGapLeft": return "left brow up";
      case "browLidGapRight": return "right brow up";
    }
  }
  return channel;
}

/** True where this model is known or suspected to attenuate the channel. */
export function channelAttenuated(channel: FaceChannel): boolean {
  if (!channel.startsWith("au:")) return false;
  return ACTION_UNIT_BY_ID[channel.slice(3) as ActionUnitId]?.attenuated === true;
}
