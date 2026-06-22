// shared/aac/speaker-fusion.ts
//
// Audio-visual speaker attribution: fuse VOICE-embedding matches with LIP-SYNC
// (was a visible face's mouth moving during the speech?) into a per-person
// likelihood for the Observer.
//
// The cross-modal check is what makes voice ID trustworthy:
//  - a visible face whose mouth was MOVING during the speech → likely the speaker
//  - a visible face whose mouth was STILL → ruled OUT (even if the voice matched —
//    catches mis-matches, recordings, and a TV in the background)
//  - a face that wasn't visible → fall back to the voice match alone (uncertain)
//
// Lip data (MediaPipe) and identity (face-api descriptors) come from DIFFERENT
// detectors, so faces are correlated by bounding-box IoU, not index. Pure / no
// deps so the coordinator uses it and server tests cover the fusion.
// See planning-docs/aac-cost-saving-spec.md (lip-sync attribution).

export interface BBox { x: number; y: number; w: number; h: number }

/** One face the client tracked (MediaPipe) during the speech window. */
export interface LipFace {
  bbox: BBox;
  /** Mouth-open events per second over the window (talking → high). */
  mouthActivity: number;
  /** Whether the face was actually visible/tracked during the window. */
  visible: boolean;
}

/** A face the SERVER identified (face-api descriptor match), with its bbox. */
export interface IdentifiedFaceLite {
  entityId?: string;
  name: string;
  bbox?: BBox;
}

/** A voice match candidate. `source` distinguishes the slow embedding match
 *  ("voice") from the fast pre-embedding pitch read ("pitch"), which is weaker
 *  and provisional. */
export interface VoiceCandidate {
  entityId?: string;
  name: string;
  /** 0..1 voice similarity / confidence. */
  similarity: number;
  source?: "voice" | "pitch";
}

export type MouthVerdict = "moving" | "still" | "hidden";

export interface SpeakerLikelihood {
  name: string;
  entityId?: string;
  /** Voice similarity for this person, or null if the voice didn't match them. */
  voiceSim: number | null;
  /** Where voiceSim came from — embedding ("voice") or the fast pitch read. */
  voiceSource?: "voice" | "pitch";
  mouth: MouthVerdict;
  /** Fused 0..1 likelihood this person is the speaker. */
  likelihood: number;
  /** True when ruled out by lip-sync (visible face, mouth still). */
  ruledOut: boolean;
}

/** Mouth-open events/sec above which we call a visible mouth "moving" (talking).
 *  Tunable — a held-open mouth or a single yawn shouldn't qualify. */
export const MOUTH_MOVING_MIN = 1.5;
/** Min IoU to consider a lip face and an identified face the same person. */
export const FACE_MATCH_IOU = 0.3;

export function bboxIoU(a: BBox, b: BBox): number {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function mouthVerdict(lip: LipFace | null | undefined): MouthVerdict {
  if (!lip || !lip.visible) return "hidden";
  return lip.mouthActivity >= MOUTH_MOVING_MIN ? "moving" : "still";
}

/** Best-IoU lip face for an identified face's bbox, or null. */
function matchLip(faceBbox: BBox | undefined, lipFaces: LipFace[], iouMin: number): LipFace | null {
  if (!faceBbox) return null;
  let best: LipFace | null = null;
  let bestIoU = iouMin;
  for (const lf of lipFaces) {
    const iou = bboxIoU(faceBbox, lf.bbox);
    if (iou >= bestIoU) { bestIoU = iou; best = lf; }
  }
  return best;
}

/**
 * Fuse voice candidates + identified faces + lip activity into a ranked
 * per-person likelihood. Also surfaces a moving-mouthed UNIDENTIFIED face as an
 * "unknown visible speaker" candidate (someone is clearly talking on camera).
 */
export function fuseSpeakerLikelihood(input: {
  voiceCandidates: VoiceCandidate[];
  identifiedFaces: IdentifiedFaceLite[];
  lipFaces: LipFace[];
  iouThreshold?: number;
}): SpeakerLikelihood[] {
  const iouMin = input.iouThreshold ?? FACE_MATCH_IOU;
  const voiceByKey = new Map<string, VoiceCandidate>();
  for (const v of input.voiceCandidates) voiceByKey.set(v.entityId || v.name, v);

  const out: SpeakerLikelihood[] = [];
  const usedLip = new Set<LipFace>();

  // One row per identified face (these are who we can both see and might match).
  for (const f of input.identifiedFaces) {
    const lip = matchLip(f.bbox, input.lipFaces, iouMin);
    if (lip) usedLip.add(lip);
    const verdict = mouthVerdict(lip);
    const voice = voiceByKey.get(f.entityId || f.name);
    const voiceSim = voice ? voice.similarity : null;
    const voiceSource = voice?.source;
    if (voice) voiceByKey.delete(f.entityId || f.name); // consumed

    let likelihood: number;
    let ruledOut = false;
    if (verdict === "still") {
      // Visible and NOT moving → not the speaker, regardless of voice match.
      ruledOut = true;
      likelihood = Math.min(voiceSim ?? 0, 0.1);
    } else if (verdict === "moving") {
      // Mouth moving → talking. Voice agreement pushes it higher.
      likelihood = voiceSim != null ? 0.5 + 0.5 * voiceSim : 0.6;
    } else {
      // Hidden — rely on the voice match alone (uncertain).
      likelihood = voiceSim ?? 0;
    }
    out.push({ name: f.name, entityId: f.entityId, voiceSim, voiceSource, mouth: verdict, likelihood, ruledOut });
  }

  // Voice matched someone we DON'T see (not in identifiedFaces) — voice-only.
  for (const v of voiceByKey.values()) {
    out.push({ name: v.name, entityId: v.entityId, voiceSim: v.similarity, voiceSource: v.source, mouth: "hidden", likelihood: v.similarity, ruledOut: false });
  }

  // A clearly-talking face we couldn't identify — surface it so the Observer
  // knows *someone* on camera is speaking even if unmatched.
  for (const lf of input.lipFaces) {
    if (usedLip.has(lf)) continue;
    if (lf.visible && mouthVerdict(lf) === "moving") {
      out.push({ name: "unidentified visible speaker", voiceSim: null, mouth: "moving", likelihood: 0.5, ruledOut: false });
    }
  }

  return out.sort((a, b) => b.likelihood - a.likelihood);
}

/** Compact, Observer-readable summary line. Returns "" when there's nothing
 *  worth saying (no faces, no voice). `provisional` marks the FAST read (pitch +
 *  lip, before the embedding) so the Observer treats it as a quick hint that may
 *  firm up shortly. */
export function renderSpeakerLikelihood(list: SpeakerLikelihood[], provisional = false): string {
  if (!list.length) return "";
  const parts = list.map(s => {
    const pct = Math.round(s.likelihood * 100);
    const bits: string[] = [];
    if (s.voiceSim != null) {
      const label = s.voiceSource === "pitch" ? "pitch~" : "voice ";
      bits.push(`${label}${Math.round(s.voiceSim * 100)}%`);
    }
    bits.push(`mouth ${s.mouth}`);
    if (s.ruledOut) return `${s.name} — RULED OUT (${bits.join(", ")})`;
    return `${s.name} — ${pct}% (${bits.join(", ")})`;
  });
  const tag = provisional ? "[SPEAKER LIKELIHOOD: provisional]" : "[SPEAKER LIKELIHOOD]";
  return `${tag} ${parts.join(" | ")}`;
}
