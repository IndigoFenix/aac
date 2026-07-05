import { BWObj } from '../../core/BWObj';
import { arrayVal, numVal, parseChildren, strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

// Forward references
interface WorldLike extends BWObj {
	getTrait(key: string): TraitLike;
}

interface TraitLike {
	key: string;
	is_combo?: boolean;
}

/**
 * Seek behavior for vectors - makes them prefer or avoid certain traits
 */
export class Seek extends BWObj {
	declare parent: BWObj & { seek: Seek[] };
	declare world: WorldLike;

	vector: BWObj;

	// From attrs
	trait: string[] = [];
	not_trait: string[] = [];
	mult: number = 1;

	// Computed at init
	trait_has_keys: string[] = [];
	trait_not_keys: string[] = [];
	trait_has: TraitLike[] = [];
	trait_not: TraitLike[] = [];

	constructor(vector: BWObj, data?: Record<string, unknown>) {
		super(vector, data);
		this.vector = vector;
		const d = this.data;
		this.trait = arrayVal(d, 'trait');
		this.not_trait = arrayVal(d, 'not_trait');
		this.mult = numVal(d, 'mult', 1);
	}

	init(): void {
		this.trait_has_keys = this.trait;
		this.trait_not_keys = this.not_trait;
		this.trait_has = [];
		this.trait_not = [];

		for (const key of this.trait_has_keys) {
			const trait = this.world.getTrait(key);
			this.trait_has.push(trait);
		}

		for (const key of this.trait_not_keys) {
			const trait = this.world.getTrait(key);
			this.trait_not.push(trait);
		}
	}

	getName(): string {
		let n = '';
		if (this.trait.length > 0) {
			n += ' +' + this.trait.join(' +');
		}
		if (this.not_trait.length > 0) {
			n += ' -' + this.not_trait.join(' -');
		}
		n += ' * ' + this.mult;
		return n;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.seek, this);
	}
}

/**
 * A vector type that can carry and transmit traits.
 * Contains seek behaviors that affect targeting.
 */
export class Vector extends BWObj {
	declare parent: BWObj & { vectors: Vector[] };

	/** Stable integer ID assigned by World.start. Used as bit position in
	 * the 64-bit vector_mask carried by Sheds and Modifiers for the GPU
	 * applyShed kernel's vector-match test. */
	index: number = -1;

	// Child objects
	seek: Seek[] = [];

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.key = strVal(d, 'key', 'vector');
		this.seek = parseChildren(this, d, 'seek', Seek);
	}

	init(): void {
		for (const s of this.seek) {
			s.init();
		}
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.vectors, this);
	}
}

/**
 * Vector modifier - modifies vector behavior
 */
export class VectorMod extends BWObj {
	declare parent: BWObj & { vector_mod: VectorMod[] };

	// From attrs
	vector: string[] = [];
	apply: string[] = [];
	remove: string[] = [];

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.vector = arrayVal(d, 'vector');
		this.apply = arrayVal(d, 'apply');
		this.remove = arrayVal(d, 'remove');
	}

	init(): void {
		// No additional initialization needed
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.vector_mod, this);
	}
}

export default Vector;
