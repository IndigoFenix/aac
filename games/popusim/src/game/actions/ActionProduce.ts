import { BWObj } from '../../core/BWObj';
import { numVal, strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';

interface ResourceLike {
	key: string;
	name: string;
	global: boolean;
	signed: boolean;
}

interface StockpileLike {
	produce: ActionProduce[];
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
 * Resource produced (or drained) by a player action — a signed amount per
 * action unit, applied at the configured phase, with optional gaussian noise.
 *
 * Behaviour at the produce phase:
 *   stockpile += action.current_value × value + N(0, sd)
 *
 * `value` may be negative — that drains the stockpile, equivalent to a
 * resource side-effect that doesn't gate the action's affordability the way
 * `ActionCost` does.
 *
 * `phase` follows the same string-key/default-phase convention as Transmit
 * and ActionCost; resolved to an `IndexedPhase` index in PlayerAction.init.
 */
export class ActionProduce extends BWObj {
	declare parent: BWObj & { produce: ActionProduce[] };
	declare world: WorldLike;

	// From attrs
	resource: string = '';
	value: number = 0;
	sd: number = 0;
	phase: string = '';

	// Runtime refs
	action: PlayerActionLike | null = null;
	resource_obj: ResourceLike | null = null;
	stockpile: StockpileLike | null = null;
	phase_index: number = 0;
	/** Mirrors ActionCost.current_value so Stockpile.adjusted_value can show
	 * the player a preview that includes both costs and produces. */
	current_value: number = 0;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.resource = strVal(d, 'resource', '');
		this.value = numVal(d, 'value', 0);
		this.sd = numVal(d, 'sd', 0);
		this.phase = strVal(d, 'phase', '');
	}

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
				console.error('Attempted to attach a local produce to a global action:',
					this.resource_obj.key);
			}
		}

		if (this.stockpile && this.value !== 0) {
			this.stockpile.produce.push(this);
		}

		this.current_value = action.current_value * this.value;
	}

	updateValue(action_value: number): void {
		this.current_value = action_value * this.value;
	}

	getName(): string {
		const sign = this.value >= 0 ? '+' : '';
		return `${this.resource}${sign}${this.value}`;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.produce, this);
	}
}

export default ActionProduce;
