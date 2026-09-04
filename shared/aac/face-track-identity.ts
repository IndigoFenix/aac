// shared/aac/face-track-identity.ts
//
// Per-track face identity with hysteresis: ONE track holds ONE person.
//
// Background (planning-docs/aac-presence-ledger.md §7): face matching today is
// rescored from scratch every batch with no continuity, so a single face in a
// single chair flips between family members within a minute — 46 of 553
// measured batches scored one student's own face as "one of her or her
// sister", 19 as the sister outright. Every flip enters the ledger as fresh
// evidence for a different person, which is how one face becomes two people.
//
// The fix is not a better matcher (the matcher stays weak on children — that is
// a non-goal); it is refusing to change a track's identity on a coin flip. A
// challenger must BEAT the incumbent by the ambiguity margin
// (FACE_AMBIGUITY_MARGIN = 0.08, the doppelgänger separation from
// recognition-service.ts) on `switchBatches` CONSECUTIVE batches before the
// track changes hands. One good frame for the sister proves nothing; three in
// a row that are also clearly better than the incumbent is a real handover.
//
// Pure logic: no I/O, no server imports.

export interface TrackMatchInput {
  trackId: string;
  at: number;
  cameraRole?: string;
  /** Best match this batch, if any (already thresholded by the matcher). */
  best?: { entityKey: string; distance: number };
  /** Runner-up PERSON this batch, if any. */
  runnerUp?: { entityKey: string; distance: number };
}

export interface TrackIdentity {
  trackId: string;
  /** The entity this track is currently held by; undefined until first adoption. */
  entityKey?: string;
  /** When the current identity was adopted. */
  since: number;
  /** Batches supporting the current identity since adoption. */
  batches: number;
  lastAt: number;
  /** The contender partway through a handover, if one is in progress. */
  challenger?: { entityKey: string; count: number; distance: number };
}

export interface TrackIdentityOptions {
  /** Consecutive winning batches a challenger needs to take the track. */
  switchBatches: number;
  /** How much closer the challenger must be than the incumbent to count. */
  margin: number;
  /** A track unseen this long is forgotten. */
  trackTtlMs: number;
}

export const TRACK_IDENTITY_DEFAULTS: TrackIdentityOptions = {
  switchBatches: 3,
  margin: 0.08,
  trackTtlMs: 30_000,
};

function copy(t: TrackIdentity): TrackIdentity {
  return {
    ...t,
    ...(t.challenger ? { challenger: { ...t.challenger } } : {}),
  };
}

export class TrackIdentityResolver {
  private readonly opts: TrackIdentityOptions;
  private readonly tracksById = new Map<string, TrackIdentity>();
  /** Last distance seen per entity, per track — the incumbent is often absent
   *  from a batch it did not win, and "no score this batch" must not read as
   *  "infinitely far away". */
  private readonly distances = new Map<string, Map<string, number>>();

  constructor(opts?: Partial<TrackIdentityOptions>) {
    this.opts = { ...TRACK_IDENTITY_DEFAULTS, ...(opts ?? {}) };
  }

  observe(input: TrackMatchInput): TrackIdentity {
    let track = this.tracksById.get(input.trackId);
    if (!track) {
      track = { trackId: input.trackId, since: input.at, batches: 0, lastAt: input.at };
      this.tracksById.set(input.trackId, track);
    }
    track.lastAt = input.at;

    let seen = this.distances.get(input.trackId);
    if (!seen) {
      seen = new Map<string, number>();
      this.distances.set(input.trackId, seen);
    }
    if (input.best) seen.set(input.best.entityKey, input.best.distance);
    if (input.runnerUp) seen.set(input.runnerUp.entityKey, input.runnerUp.distance);

    // A batch with no match keeps the incumbent and counts toward nothing:
    // a face turned away is not evidence about who it is.
    if (!input.best) return copy(track);

    if (!track.entityKey) {
      track.entityKey = input.best.entityKey;
      track.since = input.at;
      track.batches = 1;
      track.challenger = undefined;
      return copy(track);
    }

    if (input.best.entityKey === track.entityKey) {
      track.batches += 1;
      track.challenger = undefined; // an intervening incumbent win resets the handover
      return copy(track);
    }

    const incumbentDistance =
      input.runnerUp?.entityKey === track.entityKey
        ? input.runnerUp.distance
        : seen.get(track.entityKey) ?? Infinity;

    if (!(input.best.distance <= incumbentDistance - this.opts.margin)) {
      // Closer, but not by enough to mean anything. Not a win — and it breaks
      // the run, because the batches must be CONSECUTIVE.
      track.challenger = undefined;
      return copy(track);
    }

    if (track.challenger && track.challenger.entityKey === input.best.entityKey) {
      track.challenger.count += 1;
      track.challenger.distance = input.best.distance;
    } else {
      track.challenger = { entityKey: input.best.entityKey, count: 1, distance: input.best.distance };
    }

    if (track.challenger.count >= this.opts.switchBatches) {
      track.entityKey = track.challenger.entityKey;
      track.since = input.at;
      track.batches = 1;
      track.challenger = undefined;
    }
    return copy(track);
  }

  get(trackId: string): TrackIdentity | undefined {
    const t = this.tracksById.get(trackId);
    return t ? copy(t) : undefined;
  }

  expire(now: number): string[] {
    const dropped: string[] = [];
    for (const [id, track] of Array.from(this.tracksById)) {
      if (now - track.lastAt > this.opts.trackTtlMs) {
        this.tracksById.delete(id);
        this.distances.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  tracks(): TrackIdentity[] {
    return Array.from(this.tracksById.values()).map(copy);
  }
}
