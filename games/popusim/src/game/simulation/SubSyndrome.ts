/**
 * SubSyndrome - Represents a set of trait states for population subdivision
 *
 * Phase 2a — lightweight materialization. `trait_mask` is the eager,
 * canonical identity: it's set once in the constructor and never changes.
 * `trait_keys` and `trait_states` derive from `trait_mask` on first
 * access via getters; the heavy bit-decode + string array + object
 * allocation that they used to do eagerly in `World.materializeSubSyndrome*`
 * is now deferred to whoever actually reads those fields (in practice,
 * `getSyndrome()` during `Population.updatePopulations`).
 *
 * Why it matters: at gpu-test scale the post-pass materializes tens of
 * thousands of new SubSyndromes per phase. Each used to allocate ~5 KB
 * (trait_keys array of N strings + trait_states Record of N entries),
 * driving GC churn that grew super-linearly with simulation age. Lazy
 * getters move that allocation to a less hot path with the same total
 * work but flatter peaks.
 */

import type { Shed } from './Shed';
import { MASK_WORDS, subSyndromeKey } from '../../sim/gpu/traitMask';

interface TraitLike {
	key: string;
}

// Forward references
interface WorldLike {
	getSubSyndrome(key: string): SubSyndrome | null;
	getSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndrome | null;
	subsyndromes_kv: Map<number, Map<number, Map<number, Map<number, SubSyndrome>>>>;
	materializeSubSyndrome(key: string, trait_keys: string[], trait_states: Record<string, number>): SubSyndrome;
	materializeSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndrome;
	getSyndrome(keys: string[]): SyndromeLike;
	traits_kv: Record<string, { index: number } | undefined>;
	traits: ReadonlyArray<TraitLike>;
}

interface SyndromeLike {
	key: string;
}

interface ModifiedShed {
	multiplier: number;
	trait_keys: string[];
	cure_keys: string[];
	apply_mask: Uint32Array;
	remove_mask: Uint32Array;
}

/**
 * Pure-compute result of a contact hitting a SubSyndrome. Carries the mask + the
 * matched-or-soon-to-be-materialized SubSyndrome reference so the caller
 * can either skip the shift (`unchanged`) or feed the result into
 * `addPopShift` after materialising via mask.
 *
 * `trait_keys` / `trait_states` here are convenience handles that come
 * from a SubSyndrome's lazy getters — accessing them is free if nobody
 * reads them. The previous version of this interface returned freshly-
 * allocated arrays on the "new" branch; the new shape doesn't allocate.
 */
export interface ContactResult {
	/** SubSyndrome key (mask join string, e.g. "3,0,0,0"). */
	key: string;
	/** Target trait mask. Length `MASK_WORDS`. */
	target_mask: Uint32Array;
	/** Lazy reference to the trait_keys of the matching SubSyndrome (when
	 * `unchanged` or matched-existing). Empty when `isNew` — caller should
	 * materialize then read trait_keys from the resulting SubSyndrome. */
	trait_keys: string[];
	/** Lazy reference to trait_states (same caveat as trait_keys). */
	trait_states: Record<string, number>;
	/** True when the result equals the input — caller can skip the shift. */
	unchanged: boolean;
	/** True when no SubSyndrome with this mask currently exists in the world. */
	isNew: boolean;
}

/** Empty Object.freeze'd singleton — returned by lazy getters when the
 * trait_states would otherwise allocate a fresh empty record. We never
 * mutate trait_states externally, so sharing this constant is safe. */
const EMPTY_TRAIT_STATES: Record<string, number> = Object.freeze({}) as Record<string, number>;
const EMPTY_TRAIT_KEYS: ReadonlyArray<string> = Object.freeze([]);

/**
 * SubSyndrome - Represents a specific combination of trait states
 * Used to track how populations are subdivided based on trait presence/absence
 */
export class SubSyndrome {
	world: WorldLike;
	/** Identity key — the mask join string (e.g. `"3,0,0,0"`). Used for
	 * `subsyndromes_kv` lookups and as the SubPop registry key. */
	key: string;
	/** Stable integer ID assigned at materialization. Used as the index in
	 * `world.subsyndromes_by_id` and as the key in PhaseDelta TypedArrays. */
	id: number = -1;
	contactresults: Record<string, SubSyndrome>;
	syndrome: SyndromeLike | null = null;
	/** Bitmask form of the trait set (set-only encoding post B3.2a). Eager;
	 * the canonical identity for this SubSyndrome. */
	trait_mask: Uint32Array;

	/** Backing fields for the lazy `trait_keys` / `trait_states` getters.
	 * `null` means "not derived yet"; once set they're cached forever. */
	private _trait_keys: string[] | null = null;
	private _trait_states: Record<string, number> | null = null;

	constructor(world: WorldLike, key: string, mask: Uint32Array, maskOffset: number = 0) {
		this.world = world;
		this.key = key;
		this.contactresults = {};
		// Copy the mask into our own buffer — the caller may reuse its
		// scratch space.
		this.trait_mask = new Uint32Array(MASK_WORDS);
		const off = maskOffset * MASK_WORDS;
		for (let w = 0; w < MASK_WORDS; w++) this.trait_mask[w] = mask[off + w] >>> 0;
	}

	/** Sorted trait keys derived from `trait_mask` on first read. */
	get trait_keys(): string[] {
		if (this._trait_keys !== null) return this._trait_keys;
		const mask = this.trait_mask;
		const traits = this.world.traits;
		const out: string[] = [];
		for (let w = 0; w < MASK_WORDS; w++) {
			const word = mask[w] >>> 0;
			if (word === 0) continue;
			const base = w * 32;
			for (let bit = 0; bit < 32; bit++) {
				if ((word & (1 << bit)) !== 0) {
					const t = traits[base + bit];
					if (t) out.push(t.key);
				}
			}
		}
		// `traits` is index-ordered, which is `Trait.index`-ordered. The
		// previous eager path called `.sort()` on the array; we preserve that
		// contract here so anything that depended on lexicographic order
		// keeps working.
		out.sort();
		this._trait_keys = out;
		return out;
	}

	/** Trait-state record (`{ key: 1, ... }`) derived on first read. With
	 * set-only encoding every present trait has value 1, so this is just a
	 * keyed view of `trait_keys`. */
	get trait_states(): Record<string, number> {
		if (this._trait_states !== null) return this._trait_states;
		const keys = this.trait_keys;
		if (keys.length === 0) {
			// Don't allocate a fresh object literal for every empty mask —
			// share a frozen sentinel. The previous code path allocated one
			// `{}` per empty SubSyndrome.
			this._trait_states = EMPTY_TRAIT_STATES;
			return this._trait_states;
		}
		const states: Record<string, number> = {};
		for (let i = 0; i < keys.length; i++) states[keys[i]] = 1;
		this._trait_states = states;
		return states;
	}

	/**
	 * Pure-compute version of getContactResult. Returns the resulting trait
	 * state without mutating the world.
	 */
	computeContactResult(_shed: Shed, modified_shed: ModifiedShed): ContactResult {
		const src = this.trait_mask;
		const apply = modified_shed.apply_mask;
		const remove = modified_shed.remove_mask;
		const tgt = new Uint32Array(MASK_WORDS);
		let same = true;
		for (let w = 0; w < MASK_WORDS; w++) {
			const v = ((src[w] | apply[w]) & ~remove[w]) >>> 0;
			tgt[w] = v;
			if (v !== src[w]) same = false;
		}

		if (same) {
			return {
				key: this.key,
				target_mask: this.trait_mask,
				trait_keys: this.trait_keys,
				trait_states: this.trait_states,
				unchanged: true,
				isNew: false,
			};
		}

		const existing = this.world.getSubSyndromeByMask(tgt, 0);
		if (existing) {
			return {
				key: existing.key,
				target_mask: existing.trait_mask,
				trait_keys: existing.trait_keys,
				trait_states: existing.trait_states,
				unchanged: false,
				isNew: false,
			};
		}

		// Genuinely new — caller should materialize via
		// `World.materializeSubSyndromeByMask`. We hand back the frozen empty
		// sentinels rather than allocating fresh empty containers.
		return {
			key: subSyndromeKey(tgt, 0),
			target_mask: tgt,
			trait_keys: EMPTY_TRAIT_KEYS as string[],
			trait_states: EMPTY_TRAIT_STATES,
			unchanged: false,
			isNew: true,
		};
	}

	/**
	 * Legacy-shape API: returns the actual SubSyndrome instance, materializing
	 * it if needed. Mutates world state — only call from the apply step or from
	 * code paths that already accept order-dependence (e.g. initial scenario
	 * setup). Inner cache by shed.key keeps per-shed lookups O(1).
	 */
	getContactResult(shed: Shed, modified_shed: ModifiedShed): SubSyndrome {
		if (shed.key) {
			const cached = this.contactresults[shed.key];
			if (cached) return cached;
		}

		const result = this.computeContactResult(shed, modified_shed);

		if (result.unchanged) {
			if (shed.key) this.contactresults[shed.key] = this;
			return this;
		}

		const subsyndrome = this.world.materializeSubSyndromeByMask(result.target_mask, 0);

		if (shed.key) this.contactresults[shed.key] = subsyndrome;
		return subsyndrome;
	}

	/**
	 * Get the syndrome (set of active traits) for this subsyndrome. First call
	 * triggers the lazy `trait_keys` derivation.
	 */
	getSyndrome(): SyndromeLike {
		if (this.syndrome) return this.syndrome;
		// trait_keys is already sorted + filtered to set traits; under
		// set-only encoding the "filter by !== 0" check is unnecessary.
		this.syndrome = this.world.getSyndrome(this.trait_keys.slice());
		return this.syndrome;
	}
}

export default SubSyndrome;
