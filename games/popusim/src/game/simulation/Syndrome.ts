/**
 * Syndrome - A set of traits that defines a population's characteristics
 */

import { inArray, arraysOverlap } from '../../core/utils';
import { SynTransmit, SynImpact, SiteTransmit } from './SynTransmit';
import type { Shed } from './Shed';
import { buildTraitMask, MASK_WORDS } from '../../sim/gpu/traitMask';

// Use minimal interfaces to avoid conflicts
interface TraitLike {
	key: string;
	is_combo?: boolean;
	progress?: unknown[];
	transmit?: unknown[];
	produce?: unknown[];
	consume?: unknown[];
	tracker?: TrackerLike;
	tracked?: boolean;
	tracked_radius?: number;
	tracked_offset?: [number, number];
	color?: { getHex(): string };
	bloc?: boolean;
	progress_mod?: ModLike[];
	transmit_mod?: ModLike[];
	produce_mod?: ModLike[];
	consume_mod?: ModLike[];
	contact_mod?: ModLike[];
}

interface ModLike {
	vector_keys: string[];
	mult: number | string;
	apply_traits?: TraitLike[];
	remove_traits?: TraitLike[];
}

interface TrackerLike {
	key: string;
}

// Forward references
interface WorldLike {
	system: SystemLike;
	all_phases: unknown[];
	getResource(key: string): ResourceLike | null;
	/** Monotonic ID counter: each new SynTransmit / SynImpact takes the
	 * next value. Used as part of the RNG key for shed-amount draws so
	 * the GPU and CPU paths agree on which transmit/progress is firing. */
	next_syn_id?: number;
	traits_kv: Record<string, { index: number } | undefined>;
}

interface SystemLike {
	// System interface
}

interface SiteLike {
	key: string;
}

interface ResourceLike {
	key: string;
	getStockpile(site: SiteLike): StockpileLike | null;
}

interface StockpileLike {
	value: number;
	linked_contact_mods: Map<Record<string, ModifiedShed>, string[]>;
}

interface ModifiedShed {
	multiplier: number;
	trait_keys: string[];
	cure_keys: string[];
	/** Precomputed bitmasks for the apply/remove sets. Built once in
	 * `getContactMod` so the hot apply path can skip per-trait_keys work. */
	apply_mask: Uint32Array;
	remove_mask: Uint32Array;
}

interface ActionLike {
	transmit_list: Shed[];
}

/**
 * Syndrome - A combination of traits that defines a population segment
 * Generated when two or more traits coincide for the first time
 */
export class Syndrome {
	world: WorldLike;
	system: SystemLike;
	key: string;
	traits: TraitLike[];
	trait_keys: string[];
	base_traits: TraitLike[];
	base_trait_keys: string[];

	/** Bitmask form of `trait_keys`, indexed by `Trait.index`. Computed
	 * once at the end of construct() so seek-weight / contact-mod kernels
	 * can do GPU-friendly bitwise tests instead of string-key lookups. */
	trait_mask: Uint32Array = new Uint32Array(MASK_WORDS);

	// Transmission/progression data
	progress: SynTransmit[] = [];
	transmit: SynTransmit[] = [];
	produce: SynImpact[] = [];
	consume: SynImpact[] = [];

	// Phased arrays
	relevant_phases: number[] = [];
	progress_phases: SynTransmit[][] = [];
	transmit_phases: SynTransmit[][] = [];
	produce_phases: SynImpact[][] = [];
	consume_phases: SynImpact[][] = [];

	// Modifier caches
	contact_mod_values: Record<string, ModifiedShed> = {};
	contact_mod_site_values: Record<string, Record<string, ModifiedShed>> = {};
	seek_mod_values: Record<string, number> = {};

	// Tracker references
	trackers: TrackerLike[] = [];

	// Action targeting
	valid_actions: Set<ActionLike> = new Set();
	invalid_actions: Set<ActionLike> = new Set();

	// Visual tracking
	tracked: boolean = false;
	canvas: HTMLCanvasElement | null = null;
	context: CanvasRenderingContext2D | null = null;

	constructor(world: WorldLike, traits: TraitLike[], key: string) {
		this.world = world;
		this.system = world.system;
		this.key = key;
		this.traits = traits;
		this.trait_keys = [];
		this.base_traits = [];
		this.base_trait_keys = [];

		this.construct(traits, key);
	}

	construct(traits: TraitLike[], key: string): void {
		const world = this.world;
		this.key = key;
		this.traits = traits;
		this.trait_keys = [];
		this.base_traits = [];
		this.base_trait_keys = [];

		for (const trait of traits) {
			this.trait_keys.push(trait.key);
			if (trait.is_combo === false) {
				this.base_traits.push(trait);
				this.base_trait_keys.push(trait.key);
			}
		}

		// Initialize phase arrays
		for (let i = 0; i < world.all_phases.length; i++) {
			this.progress_phases.push([]);
			this.transmit_phases.push([]);
			this.produce_phases.push([]);
			this.consume_phases.push([]);
		}

		// Helper: assign a monotonic txKindId to a freshly-built SynTransmit
		// or SynImpact, using a per-World counter. The id stays stable for
		// the lifetime of the World, which matches the determinism contract
		// for HashRand-keyed RNG.
		const nextSynId = (): number => {
			const w = this.world as WorldLike;
			w.next_syn_id = (w.next_syn_id ?? 0) + 1;
			return w.next_syn_id;
		};

		// Process each trait
		for (const trait of traits) {
			// Progress
			for (const progress of (trait.progress || []) as Array<{ require_keys?: string[]; forbid_keys?: string[] }>) {
				// Check requirements
				let requirements_ok = true;

				if (progress.require_keys?.length) {
					for (const reqKey of progress.require_keys) {
						if (!inArray(this.trait_keys, reqKey)) {
							requirements_ok = false;
							break;
						}
					}
				}

				if (requirements_ok && progress.forbid_keys?.length) {
					for (const forbidKey of progress.forbid_keys) {
						if (inArray(this.trait_keys, forbidKey)) {
							requirements_ok = false;
							break;
						}
					}
				}

				if (!requirements_ok) continue;

				const n = new SynTransmit(trait as never, progress as never);
				n.txKindId = nextSynId();
				this.progress.push(n);
				this.progress_phases[n.phase_index].push(n);
				if (!this.relevant_phases.includes(n.phase_index)) {
					this.relevant_phases.push(n.phase_index);
				}
			}

			// Transmit
			for (const transmit of trait.transmit || []) {
				const n = new SynTransmit(trait as never, transmit as never);
				n.txKindId = nextSynId();
				this.transmit.push(n);
				this.transmit_phases[n.phase_index].push(n);
				if (!this.relevant_phases.includes(n.phase_index)) {
					this.relevant_phases.push(n.phase_index);
				}
			}

			// Produce
			for (const produce of trait.produce || []) {
				const n = new SynImpact(trait as never, produce as never);
				n.txKindId = nextSynId();
				if (n.value !== 0) {
					this.produce.push(n);
					this.produce_phases[n.phase_index].push(n);
					if (!this.relevant_phases.includes(n.phase_index)) {
						this.relevant_phases.push(n.phase_index);
					}
				}
			}

			// Consume
			for (const consume of trait.consume || []) {
				const n = new SynImpact(trait as never, consume as never);
				n.txKindId = nextSynId();
				if (n.value !== 0) {
					this.consume.push(n);
					this.consume_phases[n.phase_index].push(n);
					if (!this.relevant_phases.includes(n.phase_index)) {
						this.relevant_phases.push(n.phase_index);
					}
				}
			}

			// Tracker
			if (trait.tracker) {
				this.trackers.push(trait.tracker);
			}

			// Tracked visuals
			if (trait.tracked) {
				this.tracked = true;
			}
		}

		// Create visual canvas for tracked syndromes
		if (this.tracked) {
			this.canvas = document.createElement('canvas');
			const size = 32;
			this.canvas.width = this.canvas.height = size;
			this.context = this.canvas.getContext('2d');

			if (this.context) {
				for (const trait of traits) {
					if (trait.tracked_radius && trait.tracked_radius > 0 && trait.color && trait.tracked_offset) {
						this.context.fillStyle = trait.color.getHex();
						this.context.beginPath();
						this.context.arc(
							size / 2 + trait.tracked_offset[0],
							size / 2 + trait.tracked_offset[1],
							trait.tracked_radius,
							0,
							Math.PI * 2
						);
						this.context.fill();
					}
				}
			}
		}

		// Apply modifiers
		this.applyModifiers(traits);

		// Precompute the bitmask form of trait_keys for GPU seek-weight.
		// Done after applyModifiers so any modifier-injected trait_keys are
		// captured (see applyModToSynTransmit which can extend a SynTransmit's
		// trait_keys, but that doesn't affect the syndrome's own trait_keys
		// — still, doing this last keeps the order obvious).
		this.trait_mask = buildTraitMask(this.world, this.trait_keys);
	}

	private applyModifiers(traits: TraitLike[]): void {
		const applyModToSynTransmit = (mod: {
			apply_traits?: TraitLike[];
			remove_traits?: TraitLike[];
			mult: number | string;
			vector_keys: string[];
		}, transmit: SynTransmit | SynImpact): void => {
			for (const trait of mod.apply_traits || []) {
				if (!inArray(transmit.traits as TraitLike[], trait)) {
					transmit.traits.push(trait);
					transmit.trait_keys.push(trait.key);
				}
			}
			for (const trait of mod.remove_traits || []) {
				if (!inArray(transmit.cures as TraitLike[], trait)) {
					transmit.cures.push(trait);
					transmit.cure_keys.push(trait.key);
				}
			}
		};

		// Apply a list of modifiers from a single trait to a single target (a
		// SynTransmit or SynImpact). For bloc traits the multiplier is folded
		// directly into value/sd. For non-bloc traits it is accumulated per-trait
		// in value_multipliers and folded in once after all traits are processed.
		const applyTraitMods = (
			target: SynTransmit | SynImpact,
			trait: TraitLike,
			mods: ModLike[] | undefined,
			supportsTraitChanges: boolean
		): void => {
			if (!mods) return;
			for (const mod of mods) {
				if (!arraysOverlap(mod.vector_keys, target.vector_keys)) continue;
				if (typeof mod.mult === 'string') {
					const resource = this.world.getResource(mod.mult);
					if (resource) {
						target.value_resource_mult.add(resource as never);
						target.sd_resource_mult.add(resource as never);
					}
				} else if (trait.bloc) {
					target.value *= mod.mult;
					target.sd *= mod.mult;
				} else {
					const trait_key = trait.key;
					const cval = target.value_multipliers.get(trait_key) ?? 1;
					target.value_multipliers.set(trait_key, cval * (mod.mult as number));
				}
				if (supportsTraitChanges) {
					applyModToSynTransmit(mod as never, target);
				}
			}
		};

		// Fold accumulated non-blocking multipliers into the target's value.
		// Intentional divergence from legacy script.js: legacy populates
		// value_multipliers but never reads it, so non-blocking modifiers were
		// silently dropped. Folding here makes them effective. SD is left alone
		// to mirror legacy's bloc=true vs bloc=false asymmetry (only blocs
		// scale sd directly).
		const foldMultipliers = (target: SynTransmit | SynImpact): void => {
			for (const m of target.value_multipliers.values()) {
				target.value *= m;
			}
		};

		const applyForTargets = <T extends SynTransmit | SynImpact>(
			targets: T[],
			modGetter: (trait: TraitLike) => ModLike[] | undefined,
			supportsTraitChanges: boolean,
			label: string
		): void => {
			for (let p = targets.length - 1; p >= 0; p--) {
				const target = targets[p];
				for (const trait of traits) {
					applyTraitMods(target, trait, modGetter(trait), supportsTraitChanges);
				}
				foldMultipliers(target);

				if (isNaN(target.value)) console.error(`Error ${label} value`, target, this);
				if (target.value === 0 && target.sd === 0) targets.splice(p, 1);
				if ('calculateKey' in target) (target as SynTransmit).calculateKey();
			}
		};

		applyForTargets(this.progress, t => t.progress_mod, true, 'progress');
		applyForTargets(this.transmit, t => t.transmit_mod, true, 'transmit');
		applyForTargets(this.produce, t => t.produce_mod, false, 'produce');
		applyForTargets(this.consume, t => t.consume_mod, false, 'consume');
	}

	canBeTargetedBy(action: ActionLike): boolean {
		if (this.valid_actions.has(action)) return true;
		if (this.invalid_actions.has(action)) return false;

		for (const transmit of action.transmit_list) {
			if (this.getSeekMod(transmit) === 0) {
				this.invalid_actions.add(action);
				return false;
			}
		}

		this.valid_actions.add(action);
		return true;
	}

	getSeekMod(shed: Shed): number {
		if (shed.key && this.seek_mod_values[shed.key] !== undefined) {
			return this.seek_mod_values[shed.key];
		}

		let value = 1;
		for (const seek of shed.seek) {
			let apply = false;

			// Check has conditions
			for (const k of seek.trait_has_keys || []) {
				if (this.trait_keys.includes(k)) {
					apply = true;
					break;
				}
			}

			// Check not conditions
			if (!apply) {
				for (const k of seek.trait_not_keys || []) {
					if (!this.trait_keys.includes(k)) {
						apply = true;
						break;
					}
				}
			}

			if (apply) {
				value *= seek.mult;
			}
		}

		if (shed.key) {
			this.seek_mod_values[shed.key] = value;
		}

		return value;
	}

	getContactMod(shed: Shed, site: SiteLike): ModifiedShed {
		if (shed.key) {
			if (this.contact_mod_values[shed.key] !== undefined) {
				return this.contact_mod_values[shed.key];
			}

			let site_values = this.contact_mod_site_values[site.key];
			if (site_values === undefined) {
				site_values = this.contact_mod_site_values[site.key] = {};
			} else if (site_values[shed.key] !== undefined) {
				return site_values[shed.key];
			}

			let value = 1;
			let invariable = true;
			const linked_stockpiles: StockpileLike[] = [];
			const trait_keys = [...shed.trait_keys];
			const cure_keys = [...shed.cure_keys];

			for (const trait of this.traits) {
				for (const mod of trait.contact_mod || []) {
					if (arraysOverlap(mod.vector_keys, shed.vector_keys)) {
						if (typeof mod.mult === 'string') {
							const resource = this.world.getResource(mod.mult);
							const stockpile = resource?.getStockpile(site);
							if (stockpile) {
								value *= stockpile.value;
								linked_stockpiles.push(stockpile);
								invariable = false;
							}
						} else {
							value *= mod.mult;
						}

						for (const t of mod.apply_traits || []) {
							if (!inArray(trait_keys, t.key)) {
								trait_keys.push(t.key);
							}
						}
						for (const t of mod.remove_traits || []) {
							if (!inArray(cure_keys, t.key)) {
								cure_keys.push(t.key);
							}
						}
					}
				}
			}

			const modified_shed: ModifiedShed = {
				multiplier: value,
				trait_keys,
				cure_keys,
				apply_mask: buildTraitMask(this.world, trait_keys),
				remove_mask: buildTraitMask(this.world, cure_keys),
			};

			if (invariable) {
				this.contact_mod_values[shed.key] = modified_shed;
			} else {
				this.contact_mod_site_values[site.key][shed.key] = modified_shed;
				for (const stockpile of linked_stockpiles) {
					if (!stockpile.linked_contact_mods.get(site_values)) {
						stockpile.linked_contact_mods.set(site_values, []);
					}
					stockpile.linked_contact_mods.get(site_values)!.push(shed.key);
				}
			}

			return modified_shed;
		}

		const trait_keys = [...shed.trait_keys];
		const cure_keys = [...shed.cure_keys];
		return {
			multiplier: 1,
			trait_keys,
			cure_keys,
			apply_mask: buildTraitMask(this.world, trait_keys),
			remove_mask: buildTraitMask(this.world, cure_keys),
		};
	}

	getLocalizedPhases<T extends SynTransmit | SynImpact>(
		phases: T[][],
		site: SiteLike
	): SiteTransmit[][] {
		const arr: SiteTransmit[][] = [];
		for (const phase of phases) {
			const parr: SiteTransmit[] = [];
			for (const item of phase) {
				parr.push(new SiteTransmit(item, site));
			}
			arr.push(parr);
		}
		return arr;
	}
}

export default Syndrome;
