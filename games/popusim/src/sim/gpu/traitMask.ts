/**
 * traitMask — fixed-size bitmask encoding of a trait set.
 *
 * Traits are identified by `Trait.index` (assigned in World.start). To
 * compute seek_mod on GPU, both the population's syndrome and the shed's
 * seek constraints need a bitmask form so we can do `(has & syn) != 0`
 * and `(not & ~syn) != 0` in WGSL with cheap u32 ops.
 *
 * The mask width is fixed at 4 u32 words (128 bits). Bumping it again is
 * cheap — adjust the constant, the WGSL struct fields in the three
 * kernels, and the per-word pack/unpack loops in the batch wrappers.
 *
 * If a trait_key isn't found in the world (typo, missing trait), the
 * bit is silently skipped; the syndrome / shed still gets a partial mask.
 */

/** Number of u32 words per mask. */
export const MASK_WORDS = 4;
/** Total bits per mask. */
export const MASK_BITS = MASK_WORDS * 32;

interface TraitWithIndex {
	index: number;
}

interface TraitWorldLookup {
	traits_kv: Record<string, TraitWithIndex | undefined>;
}

/**
 * Build a bitmask from a list of trait keys. Returns a fresh 2-word
 * Uint32Array. Unknown keys are silently skipped — out-of-range trait
 * indices (>= MASK_BITS) are also skipped with a console warning since
 * they indicate a scenario beyond our current bitmask width.
 */
export function buildTraitMask(world: TraitWorldLookup, trait_keys: ReadonlyArray<string>): Uint32Array {
	const mask = new Uint32Array(MASK_WORDS);
	for (const key of trait_keys) {
		const trait = world.traits_kv[key];
		if (!trait) continue;
		const idx = trait.index;
		if (idx < 0 || idx >= MASK_BITS) {
			if (idx >= MASK_BITS) {
				console.warn(`Trait '${key}' has index ${idx} >= MASK_BITS (${MASK_BITS}); cannot encode in trait mask`);
			}
			continue;
		}
		mask[idx >>> 5] |= 1 << (idx & 31);
	}
	return mask;
}

/** True iff `(has & syn) != 0` (any required trait present). */
export function hasAnyOverlap(has: Uint32Array, syn: Uint32Array): boolean {
	for (let i = 0; i < MASK_WORDS; i++) {
		if ((has[i] & syn[i]) !== 0) return true;
	}
	return false;
}

/** True iff `(not & ~syn) != 0` (any forbidden trait absent). */
export function hasAnyMissing(not: Uint32Array, syn: Uint32Array): boolean {
	for (let i = 0; i < MASK_WORDS; i++) {
		if ((not[i] & ~syn[i]) !== 0) return true;
	}
	return false;
}

/**
 * Stable string key for a `MASK_WORDS`-wide bitmask, suitable for use as a
 * Map key. Reads `MASK_WORDS` u32 words starting at `mask[offset *
 * MASK_WORDS]` (so callers can pass slices of a flat batch buffer).
 *
 * The format is decimal-comma — e.g. `"3,0,0,0"`. It's intentionally minimal
 * because this runs once per SubSyndrome materialization and once per
 * applyShed delta entry, so any per-call allocation matters.
 */
export function subSyndromeKey(mask: Uint32Array, offset: number = 0): string {
	const off = offset * MASK_WORDS;
	let s = (mask[off] >>> 0).toString();
	for (let w = 1; w < MASK_WORDS; w++) {
		s += ',' + (mask[off + w] >>> 0).toString();
	}
	return s;
}
