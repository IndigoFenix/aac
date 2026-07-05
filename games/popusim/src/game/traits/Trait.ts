import { BWObj } from '../../core/BWObj';
import type { BColor } from '../../core/BColor';
import { arrayVal, boolVal, numVal, parseChildren, parseColor, strVal } from '../../core/parse';
import { removeFrom, insertUnique, insertKVIfNew } from '../../core/utils';
import { Transmit } from '../transmission/Transmit';
import { Progress } from '../transmission/Progress';
import { ImpactProduce, ImpactConsume } from '../resources/Impact';
import {
	TransmitModifier,
	ProgressModifier,
	ContactModifier,
	ProduceModifier,
	ConsumeModifier
} from '../transmission/Modifier';

// Forward references
interface WorldLike extends BWObj {
	traits: Trait[];
	getTrait(key: string): Trait;
	all_transmit: Transmit[];
	all_progress: Progress[];
	guigroups_kv: Record<string, GUIGroupLike>;
}

interface GUIGroupLike {
	getName(): string;
}

interface TrackerLike { }

/**
 * Trait class placeholder - for the class attribute system
 */
export class TraitClass extends BWObj {
	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
	}
}

/**
 * A specific trait that a person may or may not have.
 * Central game object that defines behaviors, effects, and modifiers.
 */
export class Trait extends BWObj {
	declare parent: BWObj & { traits: Trait[] };
	declare world: WorldLike;

	// From attrs
	name: string = '';
	icon: string = '';
	color!: BColor;
	inactive: boolean = false;
	hidden: boolean = false;
	prob: number = 0;
	guigroup: string = '';

	// Definition attrs
	def_and: string[] = [];
	def_not: string[] = [];
	def_or: string[] = [];
	require: string[] = [];
	forbid: string[] = [];

	/** What carriers of this trait WANT, per person per day (grand-dream
	 * world-content §3c) — pure data, aggregated by
	 * World.siteResourceDemand for the settlement layer's flow nets.
	 * Distinct from `consume` (the metabolic machinery that drains
	 * composition-side stockpiles): demand is an economy signal with no
	 * side effects of its own. */
	demand: Array<{ resource: string; value: number }> = [];

	/** Children inherit this trait at birth (culture, membership, caste);
	 * acquired states (infected, convinced) are born WITHOUT. Read by
	 * World.applyVitals — the direct replacement for the legacy
	 * "nonexistent pool + living trait" birth model. */
	hereditary: boolean = false;

	// Child objects
	transmit: Transmit[] = [];
	progress: Progress[] = [];
	produce: ImpactProduce[] = [];
	consume: ImpactConsume[] = [];
	transmit_mod: TransmitModifier[] = [];
	progress_mod: ProgressModifier[] = [];
	contact_mod: ContactModifier[] = [];
	produce_mod: ProduceModifier[] = [];
	consume_mod: ConsumeModifier[] = [];

	// Runtime properties
	base_key: string = '';
	index: number = 0;
	tracker: TrackerLike | null = null;
	bloc: boolean = true;
	branch_index: number = 0;
	cluster_level: number = 0;
	is_combo: boolean = false;
	illegal: boolean = false;
	evaluating_tree: boolean = false;

	// Combo system
	combos: { require: Trait[]; forbid: Trait[] } = { require: [], forbid: [] };
	primaries_or_combo_keys: { require: string[]; forbid: string[] } = { require: [], forbid: [] };
	primaries: { require: Trait[]; forbid: Trait[] } = { require: [], forbid: [] };
	primaries_evaluated: { require: boolean; forbid: boolean } = { require: false, forbid: false };

	// Combo state
	and_combo: number = 0;
	not_valid: boolean = false;
	or_valid: boolean = true;

	// Required-by tracking
	req_by_exists: number = 0;
	req_by: Trait[] = [];
	req_by_and: Trait[] = [];
	req_by_not: Trait[] = [];
	req_by_or: Trait[] = [];

	// Linked traits
	linked_traits: Trait[] = [];
	linked_traits_kv: Record<string, Trait> = {};

	/** True for player-created correlation traits (vs scenario-defined traits).
	 * Set by World.addCorrelationTrait. Affects persistence: correlation traits
	 * are rebound on reset rather than re-read from scenario JSON. */
	is_correlation: boolean = false;
	/** Player-side custom metrics referencing this trait. */
	referenced_by_metrics: unknown[] = [];
	/** Player-side correlation traits referencing this trait. */
	referenced_by_correlations: Trait[] = [];

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.key = strVal(d, 'key', 'trait');
		this.name = strVal(d, 'name', '');
		this.icon = strVal(d, 'icon', '');
		this.color = parseColor(this, d, 'color', '0,0,0,1');
		this.inactive = boolVal(d, 'inactive');
		this.hidden = boolVal(d, 'hidden');
		this.prob = numVal(d, 'prob', 0);
		this.guigroup = strVal(d, 'guigroup', '');

		this.def_and = arrayVal(d, 'def_and');
		this.def_not = arrayVal(d, 'def_not');
		this.def_or = arrayVal(d, 'def_or');
		this.require = arrayVal(d, 'require');
		this.demand = (Array.isArray(d.demand) ? d.demand as Record<string, unknown>[] : [])
			.map(x => ({ resource: String(x.resource ?? ''), value: Number(x.value ?? 0) }))
			.filter(x => x.resource !== '' && x.value > 0);
		this.hereditary = boolVal(d, 'hereditary');
		this.forbid = arrayVal(d, 'forbid');

		this.transmit = parseChildren(this, d, 'transmit', Transmit);
		this.progress = parseChildren(this, d, 'progress', Progress);
		this.produce = parseChildren(this, d, 'produce', ImpactProduce);
		this.consume = parseChildren(this, d, 'consume', ImpactConsume);
		this.transmit_mod = parseChildren(this, d, 'transmit_mod', TransmitModifier);
		this.progress_mod = parseChildren(this, d, 'progress_mod', ProgressModifier);
		// `contact_mod` is the current key; `infect_mod` is the legacy name kept
		// for back-compat so pre-rename scenarios still load.
		this.contact_mod = parseChildren(this, d, 'contact_mod', ContactModifier);
		if (this.contact_mod.length === 0 && Array.isArray(d.infect_mod)) {
			this.contact_mod = parseChildren(this, d, 'infect_mod', ContactModifier);
		}
		this.produce_mod = parseChildren(this, d, 'produce_mod', ProduceModifier);
		this.consume_mod = parseChildren(this, d, 'consume_mod', ConsumeModifier);

		this.base_key = this.key;

		if (typeof this.key !== 'string') {
			console.error('Initialized trait with non-string key', this.key);
		}
	}

	init(): void {
		this.base_key = this.key;
		this.tracker = null;
		this.bloc = true;
		this.branch_index = 0;
		this.cluster_level = 0;

		this.is_combo = (this.def_and.length > 0 || this.def_not.length > 0 || this.def_or.length > 0);

		this.combos = { require: [], forbid: [] };
		this.primaries_or_combo_keys = { require: [], forbid: [] };

		// Collect primary trait keys
		for (const key of this.def_and) {
			insertUnique(this.primaries_or_combo_keys.require, key);
			this.world.getTrait(key);
		}
		for (const key of this.def_not) {
			insertUnique(this.primaries_or_combo_keys.forbid, key);
			this.world.getTrait(key);
		}
		for (const key of this.def_or) {
			this.world.getTrait(key);
		}

		this.primaries = { require: [], forbid: [] };
		this.primaries_evaluated = {
			require: !this.is_combo,
			forbid: !this.is_combo
		};

		this.illegal = false;
		this.evaluating_tree = false;
		this.req_by_exists = 0;
		this.req_by = [];
		this.req_by_and = [];
		this.req_by_not = [];
		this.req_by_or = [];
		this.linked_traits = [];
		this.linked_traits_kv = {};

		this.resetCombo();
	}

	resetCombo(): void {
		this.and_combo = 0;
		this.not_valid = false;
		this.or_valid = this.def_or.length === 0;
	}

	evaluatePrimaries(): void {
		if (!this.is_combo) return;

		this.getPrimaries('require');
		this.getPrimaries('forbid');

		if (!this.illegal) {
			for (const req of this.primaries.require) {
				if (this.primaries.forbid.indexOf(req) !== -1) {
					this.illegal = true;
					break;
				}
			}
		}
	}

	getPrimaries(type: 'require' | 'forbid'): Trait[] {
		if (this.primaries_evaluated[type]) return this.primaries[type];

		this.evaluating_tree = true;

		for (const key of this.primaries_or_combo_keys[type]) {
			const trait = this.world.getTrait(key);
			if (trait.is_combo) {
				if (trait.evaluating_tree) {
					this.illegal = true;
				} else {
					const subtraits = trait.getPrimaries(type);
					for (const subtrait of subtraits) {
						insertUnique(this.primaries[type], subtrait);
					}
					if (trait.illegal) this.illegal = true;
				}
			} else {
				insertUnique(this.primaries[type], trait);
			}
		}

		this.evaluating_tree = false;
		this.primaries_evaluated[type] = true;
		return this.primaries[type];
	}

	evaluateCombos(): void {
		if (this.is_combo) return;
		this.getCombos('require');
		this.getCombos('forbid');
	}

	getCombos(type: 'require' | 'forbid'): void {
		for (const trait of this.world.traits) {
			if (!trait.is_combo) continue;
			if (trait.primaries[type].indexOf(this) !== -1) {
				this.combos[type].push(trait);
			}
		}
	}

	addAsCombo(): void {
		const arrs = ['and', 'not', 'or'] as const;
		for (const arrType of arrs) {
			const arr = this[`def_${arrType}`];
			for (const key of arr) {
				const req_trait = this.world.getTrait(key);
				req_trait.req_by.push(this);
				req_trait[`req_by_${arrType}`].push(this);
			}
		}
	}

	initSubObjects(): void {
		for (const t of this.transmit) t.init();
		for (const p of this.progress) p.init();
		for (const p of this.produce) p.init();
		for (const c of this.consume) c.init();
		for (const m of this.transmit_mod) m.init();
		for (const m of this.progress_mod) m.init();
		for (const m of this.contact_mod) m.init();
		for (const m of this.produce_mod) m.init();
		for (const m of this.consume_mod) m.init();
	}

	linkTrait(trait: Trait): boolean {
		if (trait === this) return false;
		return insertKVIfNew(trait.key, trait, this.linked_traits, this.linked_traits_kv);
	}

	initLinkedTraits(): void {
		// Link traits that affect this one
		for (const trait of this.world.traits) {
			if (this.affectedByTrait(trait)) {
				this.linkTrait(trait);
			}
		}

		// Link traits from transmit and progress
		const transmit_and_progress = [...this.world.all_transmit, ...this.world.all_progress];
		for (const v of transmit_and_progress) {
			if (v.linked_traits_kv[this.key] !== undefined) {
				for (const linked of v.linked_traits) {
					this.linkTrait(linked as Trait);
				}
			}
		}
	}

	affectedByTrait(trait: Trait): boolean {
		if (trait === this) return false;

		// Check transmit modifiers
		for (const mod of trait.transmit_mod) {
			if (mod.vector_keys.length === 0) continue;
			for (const t of this.transmit) {
				if (mod.vector_keys.indexOf(t.key) !== -1) return true;
			}
		}

		// Check progress modifiers
		for (const mod of trait.progress_mod) {
			if (mod.vector_keys.length === 0) continue;
			for (const p of this.progress) {
				if (mod.vector_keys.indexOf(p.key) !== -1) return true;
			}
		}

		// Check produce modifiers
		for (const mod of trait.produce_mod) {
			if (mod.vector_keys.length === 0) continue;
			for (const p of this.produce) {
				if (mod.vector_keys.indexOf(p.key) !== -1) return true;
			}
		}

		// Check consume modifiers
		for (const mod of trait.consume_mod) {
			if (mod.vector_keys.length === 0) continue;
			for (const c of this.consume) {
				if (mod.vector_keys.indexOf(c.key) !== -1) return true;
			}
		}

		// Check linked definitions
		const linkedlists = [this.def_and, this.def_not, this.require, this.forbid];
		for (const list of linkedlists) {
			if (list.indexOf(trait.key) !== -1) return true;
		}

		return false;
	}

	getGUIGroupName(): string | null {
		const guigroup = this.world.guigroups_kv[this.guigroup] || null;
		return guigroup ? guigroup.getName() : null;
	}

	getName(): string {
		const name = this.name !== "" ? this.name : this.key;
		const guigroupname = this.getGUIGroupName();
		return guigroupname ? `${guigroupname} - ${name}` : name;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.traits, this);
	}
}

export default Trait;
