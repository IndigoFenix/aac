// client-aac/src/lib/faceTrackAssociation.ts
//
// Frame-to-frame face TRACK continuity for the identification pipeline.
//
// WHY this exists: `usePersonIdentification` used to hand the server one
// isolated descriptor per camera per 2 s tick, with nothing tying this tick's
// face to the last one. The server therefore had no way to say "these forty
// samples are ONE person" — every batch was a fresh coin flip against the
// roster, and a single borderline frame could rename the child. The presence
// ledger (planning-docs/aac-presence-ledger.md §7) needs the opposite: a stable
// handle that holds one identity, plus an AVERAGED descriptor, because single
// frames of this student sit 0.40–0.59 from her own other poses while the mean
// sits comfortably inside the match threshold.
//
// Deliberately DOM-free and dependency-free pure math: it runs in the browser
// off face-api boxes, and in jest with no jsdom. Nothing here knows about
// video elements, face-api, or React.

/** A detection box in SOURCE pixels (face-api's `detection.box` shape). */
export interface TrackedFaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceTrack {
  /** Stable for the life of the track: `${sourceKey}#${n}`. */
  trackId: string;
  /** The most recent box associated with the track. */
  box: TrackedFaceBox;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many frames this track has been seen in (≥ 1). */
  frames: number;
  /**
   * Running mean of the last `meanWindow` ABOVE-QUALITY descriptors on this
   * track, or null while no qualifying descriptor has arrived. This is the
   * vector the server should match on.
   */
  meanDescriptor: number[] | null;
  /** How many descriptors are behind `meanDescriptor` (≤ meanWindow). */
  descriptorCount: number;
}

export interface AssociationOptions {
  /** Boxes overlapping at least this much are the same face. */
  minIou: number;
  /**
   * Fallback for fast motion / small boxes where IoU collapses to 0: centre
   * displacement as a fraction of the mean box size. 0.75 ≈ "moved less than
   * three quarters of a face width".
   */
  maxCenterDist: number;
  /** A track unseen for longer than this is dropped; a return gets a NEW id. */
  lostAfterMs: number;
  /** Ring size for the descriptor mean. */
  meanWindow: number;
  /** Descriptors from frames below this quality never enter the mean. */
  minQualityForMean: number;
}

export const DEFAULT_ASSOCIATION_OPTIONS: AssociationOptions = {
  minIou: 0.3,
  maxCenterDist: 0.75,
  lostAfterMs: 4000,
  meanWindow: 8,
  minQualityForMean: 0.35,
};

export interface FaceDetectionInput {
  box: TrackedFaceBox;
  descriptor?: number[];
  quality?: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function boxIou(a: TrackedFaceBox, b: TrackedFaceBox): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;

  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Centre displacement normalised by the mean box size, so the threshold means
 * the same thing whether the face is near the lens or across the room.
 * Returns Infinity for degenerate (zero-size) boxes rather than NaN — callers
 * compare against a finite threshold, and NaN would silently pass neither.
 */
export function normalizedCenterDistance(a: TrackedFaceBox, b: TrackedFaceBox): number {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dist = Math.hypot(acx - bcx, acy - bcy);

  const scale = (a.w + a.h + b.w + b.h) / 4;
  if (!(scale > 0)) return Number.POSITIVE_INFINITY;
  return dist / scale;
}

// ---------------------------------------------------------------------------
// Internal track state
// ---------------------------------------------------------------------------

interface InternalTrack {
  trackId: string;
  box: TrackedFaceBox;
  firstSeenAt: number;
  lastSeenAt: number;
  frames: number;
  /** Bounded ring of qualifying descriptors — never grows past `meanWindow`. */
  ring: number[][];
  /** Cached mean, invalidated on every ring push. */
  meanCache: number[] | null;
}

interface SourceState {
  tracks: InternalTrack[];
  /**
   * Monotonic per source and NEVER reset, even by `reset()`: an id that comes
   * back after a gap must not collide with the entity the server already bound
   * to the old id.
   */
  counter: number;
}

interface Candidate {
  detIdx: number;
  trackIdx: number;
  iou: number;
  centerDist: number;
  /** True when the pair passed on overlap; overlap always beats proximity. */
  byIou: boolean;
}

export class FaceTrackAssociator {
  private readonly opts: AssociationOptions;
  private readonly sources = new Map<string, SourceState>();

  constructor(opts?: Partial<AssociationOptions>) {
    this.opts = { ...DEFAULT_ASSOCIATION_OPTIONS, ...(opts ?? {}) };
  }

  /**
   * Associate one frame's detections with this source's live tracks and return
   * the track for each detection IN INPUT ORDER, so the caller can zip tracks
   * back onto its own per-face payloads.
   *
   * Matching is greedy over IoU first, then centre proximity — no Hungarian
   * assignment, because the cap is 3 faces and a greedy pass on ≤ 3×3 pairs is
   * both optimal enough and trivially auditable.
   */
  associate(sourceKey: string, detections: FaceDetectionInput[], now: number): FaceTrack[] {
    const state = this.sourceState(sourceKey);

    // Drop tracks that went missing. Done BEFORE matching so a returning face
    // can't attach to a stale box from a minute ago.
    state.tracks = state.tracks.filter(t => now - t.lastSeenAt <= this.opts.lostAfterMs);

    const assignedTrack = new Array<InternalTrack | null>(detections.length).fill(null);
    const trackTaken = new Set<number>();
    const detTaken = new Set<number>();

    const candidates: Candidate[] = [];
    for (let d = 0; d < detections.length; d++) {
      for (let t = 0; t < state.tracks.length; t++) {
        const iou = boxIou(detections[d].box, state.tracks[t].box);
        const centerDist = normalizedCenterDistance(detections[d].box, state.tracks[t].box);
        const byIou = iou >= this.opts.minIou;
        if (!byIou && !(centerDist <= this.opts.maxCenterDist)) continue;
        candidates.push({ detIdx: d, trackIdx: t, iou, centerDist, byIou });
      }
    }

    // Overlap pairs first (best overlap wins), then proximity pairs (nearest
    // wins). A face that genuinely overlaps its own previous box should never
    // lose it to a neighbour that merely drifted close.
    candidates.sort((a, b) => {
      if (a.byIou !== b.byIou) return a.byIou ? -1 : 1;
      if (a.byIou) return b.iou - a.iou;
      return a.centerDist - b.centerDist;
    });

    for (const c of candidates) {
      if (detTaken.has(c.detIdx) || trackTaken.has(c.trackIdx)) continue;
      detTaken.add(c.detIdx);
      trackTaken.add(c.trackIdx);
      assignedTrack[c.detIdx] = state.tracks[c.trackIdx];
    }

    const out: FaceTrack[] = [];
    for (let d = 0; d < detections.length; d++) {
      const det = detections[d];
      let track = assignedTrack[d];

      if (track) {
        track.box = { ...det.box };
        track.lastSeenAt = now;
        track.frames += 1;
      } else {
        track = {
          trackId: `${sourceKey}#${state.counter++}`,
          box: { ...det.box },
          firstSeenAt: now,
          lastSeenAt: now,
          frames: 1,
          ring: [],
          meanCache: null,
        };
        state.tracks.push(track);
      }

      this.pushDescriptor(track, det.descriptor, det.quality);
      out.push(snapshot(track));
    }

    return out;
  }

  /** Live tracks for a source (most recently seen last), as snapshots. */
  tracks(sourceKey: string): FaceTrack[] {
    const state = this.sources.get(sourceKey);
    if (!state) return [];
    return state.tracks.map(snapshot);
  }

  /** Forget tracks for one source, or every source when called bare. */
  reset(sourceKey?: string): void {
    if (sourceKey === undefined) {
      for (const state of this.sources.values()) state.tracks = [];
      return;
    }
    const state = this.sources.get(sourceKey);
    if (state) state.tracks = [];
  }

  private sourceState(sourceKey: string): SourceState {
    let state = this.sources.get(sourceKey);
    if (!state) {
      state = { tracks: [], counter: 0 };
      this.sources.set(sourceKey, state);
    }
    return state;
  }

  /**
   * Add a descriptor to the track's mean, if it qualifies. A frame with no
   * quality score is treated as qualifying: the caller either measures quality
   * for every face or for none, and refusing an unmeasured frame would leave
   * the mean permanently empty.
   */
  private pushDescriptor(track: InternalTrack, descriptor?: number[], quality?: number): void {
    if (!descriptor || descriptor.length === 0) return;
    if (quality !== undefined && !(quality >= this.opts.minQualityForMean)) return;

    // A dimension change means a different embedding model is talking to us;
    // averaging across it would produce a meaningless vector.
    if (track.ring.length > 0 && track.ring[0].length !== descriptor.length) {
      track.ring.length = 0;
    }

    track.ring.push(descriptor.slice());
    while (track.ring.length > this.opts.meanWindow) track.ring.shift();
    track.meanCache = null;
  }
}

function snapshot(track: InternalTrack): FaceTrack {
  return {
    trackId: track.trackId,
    box: { ...track.box },
    firstSeenAt: track.firstSeenAt,
    lastSeenAt: track.lastSeenAt,
    frames: track.frames,
    meanDescriptor: meanOf(track),
    descriptorCount: track.ring.length,
  };
}

/**
 * Mean over the ring, recomputed from scratch on change rather than kept as a
 * running sum: the window is 8×128 floats, and an incremental sum with
 * subtraction accumulates drift over a long session for no measurable gain.
 * The result is copied per snapshot so a caller can't mutate the cache.
 */
function meanOf(track: InternalTrack): number[] | null {
  if (track.ring.length === 0) return null;
  if (!track.meanCache) {
    const dim = track.ring[0].length;
    const acc = new Array<number>(dim).fill(0);
    for (const vec of track.ring) {
      for (let i = 0; i < dim; i++) acc[i] += vec[i];
    }
    for (let i = 0; i < dim; i++) acc[i] /= track.ring.length;
    track.meanCache = acc;
  }
  return track.meanCache.slice();
}
