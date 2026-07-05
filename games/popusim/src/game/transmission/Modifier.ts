import { BWObj } from '../../core/BWObj';
import { arrayVal, numOrSelectorVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';
import { buildVectorMask, VECTOR_MASK_WORDS } from '../../sim/gpu/vectorMask';

// Forward references
interface WorldLike extends BWObj {
	getTrait(key: string): TraitLike;
	vectors_kv: Record<string, { index: number } | undefined>;
}

interface TraitLike {
	key: string;
	world: WorldLike;
}

/**
 * Base modifier class - modifies probabilities and effects
 * Belongs to a trait and affects vectors of specified types
 */
export class Modifier extends BWObj {
	trait: TraitLike;
	declare world: WorldLike;

	// From attrs
	vector: string[] = [];
	mult: number | string = 0;
	apply: string[] = [];
	remove: string[] = [];

	// Computed at init
	trait_keys: string[] = [];
	cure_keys: string[] = [];
	vector_keys: string[] = [];
	apply_traits: TraitLike[] = [];
	remove_traits: TraitLike[] = [];
	/** Bitmask form of `vector_keys`. Built at init (after vectors have
	 * their indices). Used in the GPU applyShed kernel's mod-match test. */
	vector_mask: Uint32Array = new Uint32Array(VECTOR_MASK_WORDS);

	constructor(trait: BWObj, data?: Record<string, unknown>) {
		super(trait, data);
		this.trait = trait as unknown as TraitLike;
		this.world = (trait as unknown as TraitLike).world;
		const d = this.data;
		this.vector = arrayVal(d, 'vector');
		this.mult = numOrSelectorVal(d, 'mult', 0);
		this.apply = arrayVal(d, 'apply');
		this.remove = arrayVal(d, 'remove');
	}

	init(): void {
		this.trait_keys = this.apply;
		this.cure_keys = this.remove;
		this.vector_keys = this.vector;

		this.apply_traits = [];
		this.remove_traits = [];

		for (const key of this.trait_keys) {
			const t = this.world.getTrait(key);
			if (t) {
				this.apply_traits.push(t);
			}
		}

		for (const key of this.cure_keys) {
			const t = this.world.getTrait(key);
			if (t) {
				this.remove_traits.push(t);
			}
		}

		// Vector indices are assigned in World.start before traits are
		// initialized, so by the time any modifier's init runs the vector
		// mask is safe to build. This mask is read by the applyShed GPU
		// kernel for the per-(shed, mod) match test.
		this.vector_mask = buildVectorMask(this.world, this.vector_keys);
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
		n += ' * ' + this.mult;
		return n;
	}

}

/**
 * Modifier for transmission vectors
 */
export class TransmitModifier extends Modifier {
	declare parent: BWObj & { transmit_mod: TransmitModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.transmit_mod, this);
	}
}

/**
 * Modifier for progression vectors
 */
export class ProgressModifier extends Modifier {
	declare parent: BWObj & { progress_mod: ProgressModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.progress_mod, this);
	}
}

/**
 * Modifier for contact susceptibility
 */
export class ContactModifier extends Modifier {
	declare parent: BWObj & { contact_mod: ContactModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.contact_mod, this);
	}
}

/**
 * Modifier for resource impact
 */
export class ImpactModifier extends Modifier {
	declare parent: BWObj & { impact_mod: ImpactModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.impact_mod, this);
	}
}

/**
 * Modifier for resource production
 */
export class ProduceModifier extends Modifier {
	declare parent: BWObj & { produce_mod: ProduceModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.produce_mod, this);
	}
}

/**
 * Modifier for resource consumption
 */
export class ConsumeModifier extends Modifier {
	declare parent: BWObj & { consume_mod: ConsumeModifier[] };

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.consume_mod, this);
	}
}

export default Modifier;
