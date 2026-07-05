import type { HasEventListeners } from '../../types/interfaces';
import { BWObj } from '../../core/BWObj';
import { boolVal, numVal, parseChildren, selectVal, strVal } from '../../core/parse';
import { removeFrom, floatVal } from '../../core/utils';
import { Transmit } from '../transmission/Transmit';
import { ActionCost } from './ActionCost';
import { ActionProduce } from './ActionProduce';

// Forward references for runtime types (local to this module)
interface WorldLike extends BWObj {
	system: SystemLike;
	actions: PlayerAction[];
	all_phases: { length: number };
	validatePlayerActions(): void;
	getGUIBox(key: string): GUIBoxLike | null;
	addToPhase(object: unknown, key: string): { index: number };
}

interface SiteLike extends BWObj {
	world: WorldLike;
	pop: number;
	shed_pending_phases: PendingTransmission[][];
	local_stockpiles_kv: Record<string, StockpileLike>;
}

interface StockpileLike {
	resource: { key: string };
	cost: ActionCost[];
	produce: ActionProduce[];
}

interface SystemLike extends BWObj {
	selectApplyAction(action: PlayerAction | null): void;
	confirmBox(options: unknown): void;
}

interface GUIBoxLike {
	actions: PlayerAction[];
	el_inner_actions: Element | null;
	onElementAddedOrRemoved(): void;
}

interface SynTransmitLike {
	value: number;
	popmult: boolean;
	phase_index: number;
	key: string;
	vectors: unknown[];
	vector_keys: string[];
	traits: unknown[];
	trait_keys: string[];
	cures: unknown[];
	cure_keys: string[];
	seek: unknown[];
	precise: boolean;
	relevant_clusters: unknown[];
}

interface PendingTransmission {
	origin: PlayerAction;
	transmit: SynTransmitLike;
	amount_shed: number;
}

// SynTransmit factory (set via dependency injection)
let createSynTransmit: ((creator: PlayerAction, source: Transmit) => SynTransmitLike) | null = null;

export function setPlayerActionDependencies(deps: {
	createSynTransmit?: typeof createSynTransmit;
}): void {
	if (deps.createSynTransmit) createSynTransmit = deps.createSynTransmit;
}

/**
 * Player-controlled action that can affect the game world.
 * Can be global (applies to whole world) or local (per-site).
 */
export class PlayerAction extends BWObj implements HasEventListeners {
	declare parent: BWObj & { actions: PlayerAction[] };
	declare world: WorldLike;

	// From attrs
	name: string = '';
	icon: string = '';
	info: string = '';
	global: boolean = false;
	value: number = 0;
	max: number = 1;
	control: string = '';
	hidden: boolean = false;
	guigroup: string = '';

	// Child objects
	transmit: Transmit[] = [];
	cost: ActionCost[] = [];
	produce: ActionProduce[] = [];

	// Runtime state
	local: boolean = false;
	site: SiteLike | null = null;
	system: SystemLike | null = null;
	enabled: boolean = true;
	targeted_units: unknown[] = [];

	// Value tracking
	desired_value: number = 0;
	current_value: number = 0;
	actual_value: number = 0;
	purchased_value: number = 0;
	cost_capped_value: number = 0;
	must_purchase: boolean = false;

	// UI state
	el: HTMLElement | null = null;
	selected: boolean = false;
	ev_listeners?: [EventTarget, string, EventListener][];

	// Internal
	transmit_list: SynTransmitLike[] = [];

	constructor(parent: BWObj, data?: Record<string, unknown>) {
		super(parent, data);

		// Determine if local or global based on parent type
		if (parent.constructor.name === 'Site') {
			this.local = true;
			this.site = parent as unknown as SiteLike;
			this.world = this.site.world;
		} else if (parent.constructor.name === 'World') {
			this.local = false;
			this.site = null;
			this.world = parent as unknown as WorldLike;
		}

		const d = this.data;
		this.key = strVal(d, 'key', 'action');
		this.name = strVal(d, 'name', '');
		this.icon = strVal(d, 'icon', '');
		this.info = strVal(d, 'info', '');
		this.global = boolVal(d, 'global');
		this.value = numVal(d, 'value', 0);
		this.max = numVal(d, 'max', 1);
		this.control = selectVal(d, 'control', ['', 'checkbox', 'range', 'number'] as const, '');
		this.hidden = boolVal(d, 'hidden');
		this.guigroup = strVal(d, 'guigroup', '');
		this.transmit = parseChildren(this, d, 'transmit', Transmit);
		this.cost = parseChildren(this, d, 'cost', ActionCost);
		this.produce = parseChildren(this, d, 'produce', ActionProduce);

		if (this.world) {
			this.system = this.world.system;
		}
	}

	init(): void {
		this.desired_value = this.current_value = this.actual_value = this.value;
		this.purchased_value = 0;
		this.must_purchase = this.control === 'number';
		this.transmit_list = [];

		// Initialize transmissions
		for (const t of this.transmit) {
			t.init();
			if (createSynTransmit) {
				this.transmit_list.push(createSynTransmit(this, t));
			}
		}

		// Initialize costs and produces. Resolving the phase string to an
		// index registers the cost/produce against an IndexedPhase so the
		// per-phase loop in World.updateAllPhases can find it cheaply.
		for (const c of this.cost) {
			c.init(this);
			c.phase_index = this.world.addToPhase(c, c.phase).index;
		}
		for (const p of this.produce) {
			p.init(this);
			p.phase_index = this.world.addToPhase(p, p.phase).index;
		}

		this.enabled = !this.hidden;
		this.cost_capped_value = this.max;
		this.selected = false;
	}

	/**
	 * Change action value (user input)
	 */
	change(val: number): void {
		const value = parseFloat(String(val));
		this.desired_value = value;

		if (value < this.cost_capped_value) {
			this.current_value = value;
		} else {
			this.current_value = this.cost_capped_value;
		}

		this.world.validatePlayerActions();
	}

	/**
	 * Buy additional units (for number control)
	 */
	buy(value: number): void {
		if (this.current_value + value > this.cost_capped_value) return;
		this.current_value += value;
		this.change(this.current_value);
	}

	/**
	 * Set value from event
	 */
	setValue(value: number): void {
		if (value > this.max) value = this.max;
		else if (value < 0) value = 0;

		if (this.control === 'checkbox') {
			value = value === 0 ? 0 : this.max;
		}

		this.current_value = value;
		this.change(value);
	}

	/**
	 * Update cost cap based on available resources.
	 *
	 * Cost values are now positive (consumption); resources flagged
	 * `signed` (allowed to go negative) don't bound the cap — the action
	 * can still drain them at the cost phase, just without affordability
	 * gating in the GUI.
	 */
	updateCap(): boolean {
		let highest_value = parseFloat(String(this.max));
		if (this.control === 'number') {
			highest_value = -1;
		}

		const original_cap = this.cost_capped_value;

		for (const cost of this.cost) {
			if (cost.value <= 0) continue;
			if (cost.resource_obj?.signed) continue;

			const stockpile = cost.stockpile as { adjusted_value: number } | null;
			if (!stockpile) {
				highest_value = 0;
				break;
			}

			// `adjusted_value` already deducts our own current contribution
			// (cost.current_value, which is negative for consumption). Adding
			// it back gives "what's left for everyone else plus us" — i.e.
			// the maximum we could buy if we changed our value.
			const max_here = (stockpile.adjusted_value - cost.current_value) / cost.value;
			if (highest_value < 0 || max_here < highest_value) {
				highest_value = max_here < 0 ? 0 : max_here;
			}
		}

		if (highest_value < this.max && this.control === 'checkbox') {
			highest_value = 0;
		}

		this.cost_capped_value = Math.floor(highest_value);
		return this.cost_capped_value !== original_cap;
	}

	/**
	 * Reduce current value if over cap
	 */
	reduceIfOverCap(): boolean {
		if (this.cost_capped_value < this.current_value) {
			this.current_value = this.cost_capped_value;
			return true;
		}
		return false;
	}

	/**
	 * Update costs for current value
	 */
	updateCosts(): void {
		this.actual_value = this.current_value;
		for (const cost of this.cost) {
			cost.updateValue(this.actual_value);
		}
		for (const produce of this.produce) {
			produce.updateValue(this.actual_value);
		}
	}

	/**
	 * Schedule transmissions for this action whose phase matches
	 * `phase_index`. Called at the start of each phase (after the cost stage
	 * sets current_value), so the amount shed reflects what the action was
	 * actually able to afford this phase rather than what the player asked
	 * for at day-start.
	 */
	finalizeActionTransmission(site: SiteLike, phase_index: number): void {
		const current_value = this.current_value;
		// `purchased_value` is reset on the first phase of each day, not on
		// every phase — otherwise multi-phase actions would zero it mid-cycle.
		if (phase_index === 0) this.purchased_value = 0;

		if (current_value > 0) {
			for (const transmit of this.transmit_list) {
				if (transmit.phase_index !== phase_index) continue;
				let amount_shed = transmit.value * current_value;
				if (transmit.popmult) {
					amount_shed *= site.pop;
				}

				site.shed_pending_phases[transmit.phase_index].push({
					origin: this,
					transmit: transmit,
					amount_shed: amount_shed
				});
			}
		}

		// `must_purchase` is the legacy "Buy"-button single-shot flag; clear
		// the desired/current after the LAST phase so the action doesn't
		// retrigger next day. We can detect "last phase" via the parent
		// world's all_phases length.
		const lastPhase = this.world.all_phases.length - 1;
		if (this.must_purchase && phase_index === lastPhase) {
			this.current_value = 0;
			this.desired_value = 0;
			for (const cost of this.cost) {
				cost.updateValue(0);
			}
			for (const produce of this.produce) {
				produce.updateValue(0);
			}
		}
	}

	/** No-op in headless mode; legacy implementation re-renders the
	 * action's slider/checkbox into its DOM container. */
	updateDisplay(): void { }

	/** No-op in headless mode; legacy implementation removes the action's
	 * DOM container. */
	removeDisplay(): void { }

	/** No-op in headless mode; legacy implementation updates the slider's
	 * displayed value and per-cost totals. */
	updateInfoDisplay(_value?: number): void { }

	/**
	 * Recompute this action's resource costs based on the current value, and
	 * return the set of stockpiles whose adjusted_value moved as a result
	 * (along with the set of actions that depend on those stockpiles).
	 * Mirrors legacy script.js:6808-6823.
	 */
	updateCostsAndStockpiles(): [Set<unknown>, Set<unknown>] {
		const stockpiles_changed = new Set<unknown>();
		const actions_changed = new Set<unknown>();
		for (const cost of this.cost) {
			(cost as unknown as { updateValue(v: number): void; stockpile: unknown }).updateValue(this.current_value);
			stockpiles_changed.add((cost as unknown as { stockpile: unknown }).stockpile);
		}
		for (const produce of this.produce) {
			(produce as unknown as { updateValue(v: number): void; stockpile: unknown }).updateValue(this.current_value);
			stockpiles_changed.add((produce as unknown as { stockpile: unknown }).stockpile);
		}
		for (const stockpile of stockpiles_changed) {
			const sp = stockpile as {
				cost?: { action: unknown }[];
				produce?: { action: unknown }[];
				setAdjustedValue?(): void;
			};
			if (sp?.cost) {
				for (const c of sp.cost) actions_changed.add(c.action);
			}
			if (sp?.produce) {
				for (const p of sp.produce) actions_changed.add(p.action);
			}
			sp?.setAdjustedValue?.();
		}
		return [stockpiles_changed, actions_changed];
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.actions, this);
	}
}

export default PlayerAction;
