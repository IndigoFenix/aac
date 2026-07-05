import { BWObj } from '../../core/BWObj';
import type { BColor } from '../../core/BColor';
import { boolVal, intVal, numVal, parseColor, selectVal, strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';
import type { GUIGroup } from '../organization/GUIGroup';

// Forward references
interface SiteLike {
	local_stockpiles_kv: Record<string, StockpileLike>;
}

interface WorldLike extends BWObj {
	global_stockpiles_kv: Record<string, StockpileLike>;
}

interface StockpileLike {
	resource: Resource;
}

interface TrackerLike { }

/**
 * A trackable resource in the game (e.g., money, supplies, population).
 * Resources can be global (world-wide) or local (per-site).
 */
export class Resource extends BWObj {
	declare parent: BWObj & { resources: Resource[] };
	declare world: WorldLike;

	// Properties from attrs
	name: string = '';
	icon: string = '';
	color!: BColor;
	value: number = 0;
	inactive: boolean = false;
	hidden: boolean = false;
	signed: boolean = false;
	display: string = '';
	graph_display: string = '';
	precision: number = 0;
	denominator: string = '';
	global: boolean = false;
	guigroup: string = '';

	// Runtime properties
	base_key: string = '';
	tracker: TrackerLike | null = null;

	/** Player-side custom metrics that reference this resource. Populated by
	 * World.addMetric. When non-empty, deletion of this resource is converted
	 * to hide-and-retain so the metric's history doesn't break. */
	referenced_by_metrics: unknown[] = [];
	/** Player-side correlation traits that reference this resource. Same rules. */
	referenced_by_correlations: unknown[] = [];

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.key = strVal(d, 'key', 'resource');
		this.name = strVal(d, 'name', '');
		this.icon = strVal(d, 'icon', '');
		this.color = parseColor(this, d, 'color', '0,0,0,1');
		this.value = numVal(d, 'value', 0);
		this.inactive = boolVal(d, 'inactive');
		this.hidden = boolVal(d, 'hidden');
		this.signed = boolVal(d, 'signed');
		this.display = selectVal(d, 'display', ['', 'perc', 'none'] as const, '');
		this.graph_display = selectVal(d, 'graph_display', ['', 'perc', 'none'] as const, '');
		this.precision = intVal(d, 'precision', 0);
		this.denominator = strVal(d, 'denominator', '');
		this.global = boolVal(d, 'global');
		this.guigroup = strVal(d, 'guigroup', '');
		this.base_key = this.key;
	}

	/**
	 * Get the stockpile for this resource at a given site (or global)
	 */
	getStockpile(site: SiteLike | null): StockpileLike | null {
		if (this.global) {
			return this.world.global_stockpiles_kv[this.key] || null;
		} else if (site) {
			return site.local_stockpiles_kv[this.key] || null;
		}
		return null;
	}

	destroy(): void {
		super.destroy();
		removeFrom(this.parent.resources, this);
	}
}

export default Resource;
