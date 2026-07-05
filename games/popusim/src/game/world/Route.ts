/**
 * Route — a scenario-defined connection between two Sites.
 *
 * Routes are the cross-site channel: ranged Transmits export a share of
 * their shed along the origin site's routes (delivered next day as
 * PendingTransmissions on the destination — one day of travel per hop),
 * and a route may carry migration (uniform-by-syndrome population
 * diffusion between its endpoints, applied at the day boundary).
 *
 * Share model: a site's outbound export pool splits between "stay home"
 * (weight 1) and each route (weight `strength`), so a route of strength s
 * carries s/(1 + Σ strengths) of the pool. Weak routes leak a little,
 * strong route networks export most of the pool, and the total exported
 * never reaches 100% — the same no-overshoot discipline the cell-systems
 * transports use.
 */

import { BWObj } from '../../core/BWObj';
import { arrayVal, numVal, strVal } from '../../core/parse';

interface RouteSiteLike {
	key: string;
	routes: Array<{ route: Route; other: RouteSiteLike }>;
}

interface RouteWorldLike extends BWObj {
	sites: RouteSiteLike[];
}

export class Route extends BWObj {
	declare world: RouteWorldLike;

	// From attrs
	name: string = '';
	site_keys: string[] = [];
	strength: number = 1;
	migration: number = 0;
	migration_forbid: string[] = [];

	// Resolved at init
	site_a: RouteSiteLike | null = null;
	site_b: RouteSiteLike | null = null;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		this.world = world as RouteWorldLike;
		const d = this.data;
		this.key = strVal(d, 'key', 'route');
		this.name = strVal(d, 'name', '');
		this.site_keys = arrayVal(d, 'sites');
		this.strength = numVal(d, 'strength', 1);
		if (!(this.strength >= 0)) this.strength = 0;
		// Symmetric diffusion is stable for rates up to 0.5/day per side.
		this.migration = numVal(d, 'migration', 0);
		if (!(this.migration >= 0)) this.migration = 0;
		if (this.migration > 0.5) this.migration = 0.5;
		this.migration_forbid = arrayVal(d, 'migration_forbid');
	}

	/**
	 * Resolve endpoint Sites and register this route on both. Must run
	 * after every Site's init() (which resets site.routes).
	 */
	init(): void {
		this.site_a = null;
		this.site_b = null;
		if (this.site_keys.length !== 2) {
			console.error(`Route ${this.key}: expected exactly 2 sites, got ${this.site_keys.length}`);
			return;
		}
		const [ka, kb] = this.site_keys;
		if (ka === kb) {
			console.error(`Route ${this.key}: cannot connect a site to itself (${ka})`);
			return;
		}
		const a = this.world.sites.find(s => s.key === ka);
		const b = this.world.sites.find(s => s.key === kb);
		if (!a || !b) {
			console.error(`Route ${this.key}: unknown site key ${!a ? ka : kb}`);
			return;
		}
		this.site_a = a;
		this.site_b = b;
		a.routes.push({ route: this, other: b });
		b.routes.push({ route: this, other: a });
	}

	/** True if a syndrome (by its trait keys) is barred from migrating. */
	blocksMigration(traitKeys: string[]): boolean {
		if (this.migration_forbid.length === 0) return false;
		for (const k of this.migration_forbid) {
			if (traitKeys.indexOf(k) !== -1) return true;
		}
		return false;
	}
}

export default Route;
