import { BWObj } from '../../core/BWObj';
import { numVal, strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

// Forward references
interface ResourceLike {
	key: string;
	name: string;
	global: boolean;
	signed: boolean;
}

interface StockpileLike {
	cost: ActionCost[];
}

interface WorldLike extends BWObj {
	getResource(key: string): ResourceLike;
	global_stockpiles_kv: Record<string, StockpileLike>;
}

interface PlayerActionLike {
	site: SiteLike | null;
	current_value: number;
}

interface SiteLike {
	local_stockpiles_kv: Record<string, StockpileLike>;
}

/**
 * Cost associated with a player action — a positive amount of a resource
 * consumed each time the action runs.
 *
 * Convention: `value` is always non-negative. Production happens via the
 * sibling `ActionProduce`, not by passing a negative cost. Scenarios that
 * predate this split are migrated by the editor (positive-cost-as-produce,
 * negative-cost-as-positive-cost).
 *
 * `phase` controls when the cost is paid; '' (the default) maps to the
 * world's default phase, matching how Transmit/Progress resolve phase keys.
 */
export class ActionCost extends BWObj {
	declare parent: BWObj & { cost: ActionCost[] };
	declare world: WorldLike;

	// From attrs
	resource: string = '';
	value: number = 0;
	phase: string = '';

	// Runtime refs
	action: PlayerActionLike | null = null;
	resource_obj: ResourceLike | null = null;
	stockpile: StockpileLike | null = null;
	/** Pre-resolved `phase`-key → IndexedPhase index. Set by PlayerAction.init
	 * via World.addToPhase. */
	phase_index: number = 0;
	current_value: number = 0;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.resource = strVal(d, 'resource', '');
		this.value = numVal(d, 'value', 0);
		this.phase = strVal(d, 'phase', '');
	}

	/**
	 * Initialize cost with action reference
	 */
	init(action: PlayerActionLike): void {
		this.action = action;
		this.resource_obj = this.world.getResource(this.resource);

		if (this.resource_obj.global) {
			this.stockpile = this.world.global_stockpiles_kv[this.resource];
		} else {
			if (action.site) {
				this.stockpile = action.site.local_stockpiles_kv[this.resource];
			} else {
				this.stockpile = null;
				console.error('Attempted to create global action with a local cost:',
					this.resource_obj.key);
			}
		}

		if (this.stockpile && this.value !== 0) {
			this.stockpile.cost.push(this);
		}

		// `current_value` feeds Stockpile.adjusted_value for the GUI's "after
		// this action runs" preview. Cost is consumption, so the contribution
		// is negative.
		this.current_value = -(action.current_value * this.value);
	}

	/**
	 * Update current value based on action value
	 */
	updateValue(action_value: number): void {
		this.current_value = -(action_value * this.value);
	}

	getName(): string {
		let n = "";
		if (this.resource !== '') {
			n += this.resource;
		}
		// Costs are positive amounts consumed; prefix '-' so the GUI label
		// reads as a deduction.
		n += '-' + this.value;
		return n;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.cost, this);
	}
}

export default ActionCost;
