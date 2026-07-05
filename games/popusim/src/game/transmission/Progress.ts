import { BWObj } from '../../core/BWObj';
import { arrayVal as parseArray, numOrSelectorVal, strVal } from '../../core/parse';
import { removeFrom, insertUnique, insertKVIfNew, stringVal, arrayVal } from '../../core/utils';

// Forward references
interface WorldLike extends BWObj {
	getTrait(key: string): TraitLike;
	getVector(key: string): VectorLike;
	addToPhase(obj: BWObj, phase: string): { index: number };
	all_progress: Progress[];
}

interface TraitLike {
	key: string;
	is_combo: boolean;
	primaries?: {
		require: TraitLike[];
		forbid: TraitLike[];
	};
}

interface VectorLike {
	key: string;
}

/**
 * Progress object - represents trait development over time.
 * Belongs to a trait and defines how people with that trait can develop new traits.
 */
export class Progress extends BWObj {
	declare parent: BWObj & { progress: Progress[] };
	declare world: WorldLike;

	// From attrs
	apply: string[] = [];
	remove: string[] = [];
	vector: string[] = [];
	require: string[] = [];
	forbid: string[] = [];
	value: number | string = 0;
	sd: number | string = 0;
	phase: string = '';

	// Computed at init
	traits: TraitLike[] = [];
	trait_keys: string[] = [];
	cures: TraitLike[] = [];
	cure_keys: string[] = [];
	relevant_clusters: unknown[] = [];
	phase_index: number = 0;
	precise: number = 1; // Progress events are always precise

	vectors: VectorLike[] = [];
	vector_keys: string[] = [];

	require_traits: TraitLike[] = [];
	require_keys: string[] = [];
	forbid_traits: TraitLike[] = [];
	forbid_keys: string[] = [];

	linked_traits: TraitLike[] = [];
	linked_traits_kv: Record<string, TraitLike> = {};

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.apply = parseArray(d, 'apply');
		this.remove = parseArray(d, 'remove');
		this.vector = parseArray(d, 'vector');
		this.require = parseArray(d, 'require');
		this.forbid = parseArray(d, 'forbid');
		this.value = numOrSelectorVal(d, 'value', 0);
		this.sd = numOrSelectorVal(d, 'sd', 0);
		this.phase = strVal(d, 'phase', '');
	}

	init(): void {
		const traits = arrayVal(this.apply);
		this.traits = [];
		this.trait_keys = [];
		const cures = arrayVal(this.remove);
		this.cures = [];
		this.cure_keys = [];

		this.precise = 1;
		this.relevant_clusters = [];
		this.phase_index = this.world.addToPhase(this, this.phase).index;

		// Process traits to apply
		for (let i = 0; i < traits.length; i++) {
			const trait = this.world.getTrait(stringVal(traits[i], ""));
			if (trait.is_combo && trait.primaries) {
				for (const req of trait.primaries.require) {
					insertUnique(this.traits, req);
					insertUnique(this.trait_keys, req.key);
				}
				for (const forbid of trait.primaries.forbid) {
					insertUnique(this.cures, forbid);
					insertUnique(this.cure_keys, forbid.key);
				}
			} else {
				insertUnique(this.traits, trait);
				insertUnique(this.trait_keys, trait.key);
			}
		}

		// Process traits to remove
		for (let i = 0; i < cures.length; i++) {
			const trait = this.world.getTrait(stringVal(cures[i], ""));
			if (!trait.is_combo) {
				insertUnique(this.cures, trait);
				insertUnique(this.cure_keys, trait.key);
			}
		}

		// Process vectors
		const vectors = this.vector;
		this.vectors = [];
		this.vector_keys = [];

		for (let i = 0; i < vectors.length; i++) {
			const vector = this.world.getVector(stringVal(vectors[i], ""));
			this.vectors.push(vector);
			this.vector_keys.push(vector.key);
		}

		// Process required traits
		this.require_traits = [];
		this.require_keys = [];
		for (let i = 0; i < this.require.length; i++) {
			const trait = this.world.getTrait(stringVal(this.require[i], ""));
			insertUnique(this.require_traits, trait);
			insertUnique(this.require_keys, trait.key);
		}

		// Process forbidden traits
		this.forbid_traits = [];
		this.forbid_keys = [];
		for (let i = 0; i < this.forbid.length; i++) {
			const trait = this.world.getTrait(stringVal(this.forbid[i], ""));
			insertUnique(this.forbid_traits, trait);
			insertUnique(this.forbid_keys, trait.key);
		}

		// Build linked traits
		const linked_trait_arrays = [this.traits, this.cures, this.require_traits, this.forbid_traits];
		this.linked_traits = [];
		this.linked_traits_kv = {};

		for (const arr of linked_trait_arrays) {
			for (const trait of arr) {
				insertKVIfNew(trait.key, trait, this.linked_traits, this.linked_traits_kv);
			}
		}

		this.world.all_progress.push(this);
	}

	getName(): string {
		let n = '';
		if (this.apply.length > 0) {
			n += '+' + this.apply.join('+') + ' ';
		}
		if (this.remove.length > 0) {
			n += '-' + this.remove.join('-') + ' ';
		}
		if (this.vector.length > 0) {
			n += 'by ' + this.vector.join(',');
		}
		return n;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.progress, this);
	}
}

export default Progress;
