// server/services/photos/photo-caps.ts
//
// Cap arithmetic for the photo library. Pure — no database, no S3 — because the
// interesting failure modes here are off-by-ones and partial batches, and those
// deserve tests that run in milliseconds.
//
// See planning-docs/aac-photos-plan.md §2.

/** Caps count ASSIGNMENT rows, never assets. Content-hash dedup means one image
 *  can back many assignments, and counting assets would let one family's
 *  re-import silently consume another scope's allowance. */
export const PHOTO_CAP_PER_STUDENT = 100;
export const PHOTO_CAP_PER_INSTITUTE = 100;

/** Exactly one of these is set — mirrors the CHECK on `photo_assignments`. */
export type PhotoScope =
  | { kind: "student"; studentId: string }
  | { kind: "institute"; instituteId: string };

export function capForScope(scope: PhotoScope): number {
  return scope.kind === "student" ? PHOTO_CAP_PER_STUDENT : PHOTO_CAP_PER_INSTITUTE;
}

/** Free slots in a scope. Never negative: a cap lowered below an existing
 *  library would otherwise produce nonsense downstream. */
export function remainingCapacity(currentCount: number, cap: number): number {
  return Math.max(0, cap - currentCount);
}

export interface BatchPlan<T> {
  /** Items that fit, in the order given. */
  accepted: T[];
  /** Items dropped because the cap was reached. */
  rejected: T[];
  /** Free slots before this batch. */
  capacityBefore: number;
  /** True when nothing at all fit — the caller should surface an error rather
   *  than reporting a successful import of zero photos. */
  atCap: boolean;
}

/**
 * Split a requested batch into what fits and what does not.
 *
 * Partial acceptance is deliberate: a caretaker who picks 40 photos with 25
 * slots free gets 25 imported and a clear message about 15, which is far better
 * than rejecting the whole selection and making them count by hand. The one
 * case that is an outright error is zero capacity (`atCap`).
 */
export function planIngestBatch<T>(
  items: readonly T[],
  currentCount: number,
  cap: number,
): BatchPlan<T> {
  const capacityBefore = remainingCapacity(currentCount, cap);
  return {
    accepted: items.slice(0, capacityBefore),
    rejected: items.slice(capacityBefore),
    capacityBefore,
    atCap: capacityBefore === 0,
  };
}
