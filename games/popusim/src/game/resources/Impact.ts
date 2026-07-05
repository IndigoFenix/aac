import { BWObj } from '../../core/BWObj';
import { arrayVal, numOrSelectorVal, strVal } from '../../core/parse';
import { removeFrom, insertUnique, stringVal } from '../../core/utils';

// Forward references
interface WorldLike extends BWObj {
	getTrait(key: string): TraitLike;
	getVector(key: string): VectorLike;
	getResource(key: string): ResourceLike;
	addToPhase(obj: BWObj, phase: string): { index: number };
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
	seek: SeekLike[];
}

interface SeekLike {
	trait_has: string[];
	trait_not: string[];
}

interface ResourceLike {
	key: string;
}

/**
 * Base class for resource effects (production/consumption).
 * Defines how traits affect resource levels.
 */
export class Impact extends BWObj {
	declare parent: BWObj & { impact: Impact[] };
	declare world: WorldLike;

	// From attrs
	resource: string = '';
	value: number | string = 0;
	sd: number | string = 0;
	apply: string[] = [];
	remove: string[] = [];
	vector: string[] = [];
	phase: string = '';

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
	seek: SeekLike[] = [];
	seek_has: string[] = [];
	seek_not: string[] = [];

	resource_obj: ResourceLike | null = null;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.resource = strVal(d, 'resource', '');
		this.value = numOrSelectorVal(d, 'value', 0);
		this.sd = numOrSelectorVal(d, 'sd', 0);
		this.apply = arrayVal(d, 'apply');
		this.remove = arrayVal(d, 'remove');
		this.vector = arrayVal(d, 'vector');
		this.phase = strVal(d, 'phase', '');
	}

	/**
	 * Initialize runtime references
	 */
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

		this.resource_obj = this.world.getResource(this.resource);
		this.phase_index = this.world.addToPhase(this, this.phase).index;
	}

	getName(): string {
		let n = "";
		if (this.resource !== '') {
			n += this.resource;
		}
		if (typeof this.value === 'number' && this.value < 0) {
			n += String(this.value);
		} else {
			n += '+' + this.value;
		}
		return n;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.impact, this);
	}
}

/**
 * Impact for producing resources
 */
export class ImpactProduce extends Impact {
	true_value: number = 0;

	init(): void {
		super.init();
		this.true_value = typeof this.value === 'number' ? this.value : 0;
	}
}

/**
 * Impact for consuming resources
 */
export class ImpactConsume extends Impact {
	true_value: number = 0;

	init(): void {
		super.init();
		this.true_value = typeof this.value === 'number' ? -this.value : 0;
	}
}

export default Impact;
