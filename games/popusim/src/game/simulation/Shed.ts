/**
 * Shed - Represents transmission data being released
 */

import type { Trait } from '../traits/Trait';
import type { Vector, Seek } from '../transmission/Vector';
import { buildTraitMask, MASK_WORDS } from '../../sim/gpu/traitMask';
import { buildVectorMask, VECTOR_MASK_WORDS } from '../../sim/gpu/vectorMask';

interface TraitWorldLookup {
	traits_kv: Record<string, { index: number } | undefined>;
	vectors_kv: Record<string, { index: number } | undefined>;
}

// Forward references
interface ClusterLike {
	key: string;
	trait: Trait;
}

interface OriginLike {
	key?: string;
}

/**
 * Shed - A bundle of transmission vectors being released
 */
export class Shed {
	origin: OriginLike | null;
	key: string;
	amount: number;
	vectors: Vector[];
	vector_keys: string[];
	traits: Trait[];
	trait_keys: string[];
	cures: Trait[];
	cure_keys: string[];
	seek: Seek[];
	precise: boolean;
	relevant_clusters: Record<number, ClusterLike>;

	/**
	 * Precomputed bitmask form of `seek` for the seek-weight kernel.
	 *
	 * For each Seek entry we store:
	 *   - a "has" mask: trait set required (any-of); when (has & syn) != 0 the
	 *     seek applies.
	 *   - a "not" mask: trait set forbidden (any-of); when (not & ~syn) != 0
	 *     the seek applies (i.e. the syndrome lacks any forbidden trait).
	 *   - a multiplier.
	 *
	 * The masks are flattened into one Uint32Array per role (length = seek
	 * count × MASK_WORDS) so they can be passed straight to a GPU buffer.
	 * `seek_mults` parallels by index. Empty when seek list is empty.
	 *
	 * Lazily populated by `ensureSeekMasks(world)` because the constructor
	 * doesn't have a typed handle to the world; both the GPU and CPU seek
	 * paths call ensureSeekMasks before reading.
	 */
	seek_has_masks: Uint32Array = new Uint32Array(0);
	seek_not_masks: Uint32Array = new Uint32Array(0);
	seek_mults: Float32Array = new Float32Array(0);
	private seekMasksWorld: TraitWorldLookup | null = null;

	/** Bitmask form of `vector_keys`. Lazily computed alongside seek
	 * masks. Used by contact_mod matching in the applyShed kernel. */
	vector_mask: Uint32Array = new Uint32Array(VECTOR_MASK_WORDS);

	constructor(
		origin: OriginLike | null,
		key: string,
		amount: number,
		vectors: Vector[],
		vector_keys: string[],
		traits: Trait[],
		trait_keys: string[],
		cures: Trait[],
		cure_keys: string[],
		seek: Seek[],
		precise: boolean,
		relevant_clusters: Record<number, ClusterLike>
	) {
		if (isNaN(amount)) console.error('Error shed amount', key);
		this.origin = origin;
		this.key = key;
		this.amount = amount;
		this.vectors = vectors;
		this.vector_keys = vector_keys;
		this.traits = traits;
		this.trait_keys = trait_keys;
		this.cures = cures;
		this.cure_keys = cure_keys;
		this.seek = seek;
		this.precise = precise;
		this.relevant_clusters = relevant_clusters;
	}

	/**
	 * Build the seek bitmasks. Idempotent: only re-runs if the world
	 * reference changes (it shouldn't during a normal run, but the
	 * guard keeps the cost a single Uint32Array allocation).
	 */
	ensureSeekMasks(world: TraitWorldLookup): void {
		if (this.seekMasksWorld === world && this.seek_mults.length === this.seek.length) return;
		this.seekMasksWorld = world;
		const n = this.seek.length;
		this.seek_has_masks = new Uint32Array(n * MASK_WORDS);
		this.seek_not_masks = new Uint32Array(n * MASK_WORDS);
		this.seek_mults = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const s = this.seek[i];
			const has = buildTraitMask(world, s.trait_has_keys ?? []);
			const not = buildTraitMask(world, s.trait_not_keys ?? []);
			for (let w = 0; w < MASK_WORDS; w++) {
				this.seek_has_masks[i * MASK_WORDS + w] = has[w];
				this.seek_not_masks[i * MASK_WORDS + w] = not[w];
			}
			this.seek_mults[i] = s.mult ?? 0;
		}
		// Build the shed-level vector mask too; the applyShed kernel uses
		// it to test which contact_mod entries are in scope.
		this.vector_mask = buildVectorMask(world, this.vector_keys);
	}
}

export default Shed;
