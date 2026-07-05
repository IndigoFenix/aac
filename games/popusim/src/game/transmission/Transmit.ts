import { BWObj } from '../../core/BWObj';
import { arrayVal, boolVal, numOrSelectorVal, numVal, strVal } from '../../core/parse';
import { removeFrom, insertUnique, insertKVIfNew, stringVal } from '../../core/utils';
import type { Seek } from './Vector';

// Forward references (local to this module)
interface WorldLike extends BWObj {
	getTrait(key: string): TraitLike;
	getVector(key: string): VectorLike;
	addToPhase(obj: BWObj, phase: string): { index: number };
	all_transmit: Transmit[];
}

interface TraitLike {
	key: string;
	is_combo?: boolean;
	primaries?: {
		require: TraitLike[];
		forbid: TraitLike[];
	};
}

interface VectorLike {
	key: string;
	seek: Seek[];
}

/**
 * Transmit object - represents spreading traits through vectors.
 * Belongs to a trait and defines how that trait spreads to others.
 */
export class Transmit extends BWObj {
	declare parent: BWObj & { transmit: Transmit[] };
	declare world: WorldLike;

	// From attrs
	apply: string[] = [];
	remove: string[] = [];
	vector: string[] = [];
	value: number | string = 0;
	sd: number | string = 0;
	popmult: boolean = false;
	precise: boolean = false;
	phase: string = '';
	/** Fraction (0..1) of this transmit's shed exported along the origin
	 * site's routes. 0 = fully local (the default; identical to pre-route
	 * behavior). See Site.depositTransmitShed for the share model. */
	ranged: number = 0;

	// Computed at init
	traits: TraitLike[] = [];
	trait_keys: string[] = [];
	cures: TraitLike[] = [];
	cure_keys: string[] = [];
	resist_traits: TraitLike[] = [];
	avoids_traits: TraitLike[] = [];
	relevant_clusters: unknown[] = [];
	phase_index: number = 0;

	vectors: VectorLike[] = [];
	vector_keys: string[] = [];
	seek: Seek[] = [];
	seek_has: TraitLike[] = [];
	seek_not: TraitLike[] = [];

	linked_traits: TraitLike[] = [];
	linked_traits_kv: Record<string, TraitLike> = {};

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.apply = arrayVal(d, 'apply');
		this.remove = arrayVal(d, 'remove');
		this.vector = arrayVal(d, 'vector');
		this.value = numOrSelectorVal(d, 'value', 0);
		this.sd = numOrSelectorVal(d, 'sd', 0);
		this.popmult = boolVal(d, 'popmult');
		this.precise = boolVal(d, 'precise');
		this.phase = strVal(d, 'phase', '');
		this.ranged = numVal(d, 'ranged', 0);
		if (!(this.ranged >= 0)) this.ranged = 0;
		if (this.ranged > 1) this.ranged = 1;
	}

	init(): void {
		const traits = this.apply;
		this.traits = [];
		this.trait_keys = [];
		const cures = this.remove;
		this.cures = [];
		this.cure_keys = [];

		this.resist_traits = [];
		this.avoids_traits = [];
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
		this.seek = [];
		this.seek_has = [];
		this.seek_not = [];

		for (let i = 0; i < vectors.length; i++) {
			const vector = this.world.getVector(stringVal(vectors[i], ""));
			this.vectors.push(vector);
			this.vector_keys.push(vector.key);

			for (const s of vector.seek) {
				this.seek.push(s);
				this.seek_has = this.seek_has.concat(s.trait_has);
				this.seek_not = this.seek_not.concat(s.trait_not);
			}
		}

		// Build linked traits
		const linked_trait_arrays = [this.traits, this.cures, this.seek_has, this.seek_not];
		this.linked_traits = [];
		this.linked_traits_kv = {};

		for (const arr of linked_trait_arrays) {
			for (const trait of arr) {
				insertKVIfNew(trait.key, trait, this.linked_traits, this.linked_traits_kv);
			}
		}

		// Generate unique key
		this.key = 'act?' + this.vector_keys.join('.') + '?' +
			this.trait_keys.join('.') + '?' +
			this.cure_keys.join('.') + '?' +
			(this.popmult ? '1' : '0');

		this.world.all_transmit.push(this);
	}

	getName(): string {
		let n = '';
		if (this.apply.length > 0) {
			n += '+' + this.apply.join('+');
		}
		if (this.remove.length > 0) {
			n += '-' + this.remove.join('-');
		}
		if (this.vector.length > 0) {
			n += 'by ' + this.vector.join(',');
		}
		return n;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.transmit, this);
	}
}

export default Transmit;
