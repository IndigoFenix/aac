/**
 * vectorMask — fixed-size bitmask encoding of a vector set.
 *
 * Same shape as `traitMask.ts`: 2 × `u32` (64 vectors max). Bit position =
 * `Vector.index` assigned in `World.start`.
 *
 * Used by the applyShed kernel's per-(shed, syndrome) contact_mod
 * matching: a Modifier matches a shed when
 * `(modifier.vector_mask & shed.vector_mask) != 0`. This replaces the
 * O(N×M) `arraysOverlap(modifier.vector_keys, shed.vector_keys)` loop.
 */

export const VECTOR_MASK_WORDS = 2;
export const VECTOR_MASK_BITS = VECTOR_MASK_WORDS * 32;

interface VectorWithIndex {
	index: number;
}

interface VectorWorldLookup {
	vectors_kv: Record<string, VectorWithIndex | undefined>;
}

/**
 * Build a 2-word vector bitmask from an array of vector keys. Unknown
 * keys are silently skipped; out-of-range indices warn once.
 */
export function buildVectorMask(world: VectorWorldLookup, vector_keys: ReadonlyArray<string>): Uint32Array {
	const mask = new Uint32Array(VECTOR_MASK_WORDS);
	for (const key of vector_keys) {
		const v = world.vectors_kv[key];
		if (!v) continue;
		const idx = v.index;
		if (idx < 0 || idx >= VECTOR_MASK_BITS) {
			if (idx >= VECTOR_MASK_BITS) {
				console.warn(`Vector '${key}' has index ${idx} >= VECTOR_MASK_BITS (${VECTOR_MASK_BITS}); cannot encode`);
			}
			continue;
		}
		mask[idx >>> 5] |= 1 << (idx & 31);
	}
	return mask;
}

/** True iff the masks overlap on any bit. */
export function vectorMaskOverlap(a: Uint32Array, b: Uint32Array): boolean {
	for (let i = 0; i < VECTOR_MASK_WORDS; i++) {
		if ((a[i] & b[i]) !== 0) return true;
	}
	return false;
}
