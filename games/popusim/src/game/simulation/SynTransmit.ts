/**
 * SynTransmit - Synthesized transmission for a syndrome
 * SynImpact - Synthesized resource impact for a syndrome
 * SiteTransmit - Site-specific transmission values
 */

// Use minimal interfaces to avoid cross-module conflicts
interface TransmitSourceLike {
	traits?: unknown[];
	trait_keys?: string[];
	cures?: unknown[];
	cure_keys?: string[];
	vectors?: unknown[];
	vector_keys?: string[];
	seek?: unknown[];
	popmult?: boolean;
	precise?: boolean;
	ranged?: number;
	value?: number | string;
	sd?: number | string;
	phase_index?: number;
	relevant_clusters?: unknown[];
}

interface ImpactSourceLike extends TransmitSourceLike {
	true_value?: number | string;
	resource_obj?: unknown;
}

interface CreatorLike {
	bloc?: boolean;
	world?: unknown;
}

interface WorldLike {
	getResource(key: string): unknown;
}

interface SiteLike {
	key: string;
}

interface StockpileLike {
	value: number;
	linked_transmit_mods: SiteTransmit[];
}

interface ResourceLike {
	key: string;
	getStockpile(site: SiteLike): StockpileLike | null;
}

/**
 * SynTransmit - Synthesized transmission data for a syndrome
 */
export class SynTransmit {
	creator: CreatorLike | null;
	bloc: boolean;
	world: WorldLike | null;
	source: TransmitSourceLike;

	// Copied from source
	traits: unknown[];
	trait_keys: string[];
	cures: unknown[];
	cure_keys: string[];
	vectors: unknown[];
	vector_keys: string[];
	seek: unknown[];
	popmult: boolean;
	precise: boolean;
	/** Exported-along-routes fraction, copied from the source Transmit.
	 * Read by Site.depositTransmitShed when the shed lands. */
	ranged: number;
	/** Relevant clusters of the source Transmit/Progress, indexed by
	 * cluster level. Site.updateTransmission's drain loop reads this
	 * field when constructing a Shed from a PendingTransmission, so a
	 * SynTransmit that never copied it would leak `undefined` into the
	 * Shed's relevant_clusters and crash any cluster lookup. */
	relevant_clusters: unknown[];

	// Calculated values
	value: number;
	sd: number;
	value_resource_mult: Set<ResourceLike>;
	sd_resource_mult: Set<ResourceLike>;
	value_multipliers: Map<string, number>;
	value_multipliers_keys: string[];

	phase_index: number;
	key: string = '';
	/** Stable integer ID used as part of the RNG key for shed-amount draws.
	 * Assigned by Syndrome at construction; uniquely identifies this
	 * SynTransmit across the World for determinism. */
	txKindId: number = 0;

	// Site-specific caches
	site_values: Record<string, number> = {};
	site_sd: Record<string, number> = {};

	constructor(creator: CreatorLike | null, source: TransmitSourceLike) {
		this.creator = creator;
		this.bloc = !!(creator?.bloc);
		this.world = creator?.world as WorldLike ?? null;
		this.source = source;

		this.traits = source.traits || [];
		this.trait_keys = source.trait_keys || [];
		this.cures = source.cures || [];
		this.cure_keys = source.cure_keys || [];
		this.vectors = source.vectors || [];
		this.vector_keys = source.vector_keys || [];
		this.seek = source.seek || [];
		this.popmult = source.popmult || false;
		this.precise = source.precise || false;
		this.ranged = source.ranged || 0;
		this.relevant_clusters = source.relevant_clusters || [];

		this.calculateKey();

		// Handle resource-based values
		if (typeof source.value === 'string' && this.world) {
			this.value = 1;
			const resource = this.world.getResource(source.value);
			this.value_resource_mult = new Set(resource ? [resource as ResourceLike] : []);
		} else {
			this.value = source.value as number || 0;
			this.value_resource_mult = new Set();
		}

		if (typeof source.sd === 'string' && this.world) {
			this.sd = 1;
			const resource = this.world.getResource(source.sd);
			this.sd_resource_mult = new Set(resource ? [resource as ResourceLike] : []);
		} else {
			this.sd = source.sd as number || 0;
			this.sd_resource_mult = new Set();
		}

		this.phase_index = source.phase_index || 0;
		this.value_multipliers = new Map();
		this.value_multipliers_keys = [];
	}

	calculateKey(): void {
		this.key = this.vector_keys.join('.') + '?' +
			this.trait_keys.join('.') + '?' +
			this.cure_keys.join('.') + '?' +
			this.popmult + '?' +
			this.precise;
	}
}

/**
 * SynImpact - Synthesized resource impact for a syndrome
 */
export class SynImpact {
	creator: CreatorLike | null;
	bloc: boolean;
	world: WorldLike | null;
	source: ImpactSourceLike;

	// Copied from source
	traits: unknown[];
	trait_keys: string[];
	cures: unknown[];
	cure_keys: string[];
	vectors: unknown[];
	vector_keys: string[];
	seek: unknown[];

	// Impact-specific
	value: number;
	resource: ResourceLike;
	key: string;

	// Resource multipliers
	value_resource_mult: Set<ResourceLike>;
	sd: number = 0;
	sd_resource_mult: Set<ResourceLike>;
	value_multipliers: Map<string, number>;
	value_multipliers_keys: string[];

	phase_index: number;
	/** Stable integer ID for RNG keying (matches SynTransmit.txKindId). */
	txKindId: number = 0;

	constructor(creator: CreatorLike | null, source: ImpactSourceLike) {
		this.creator = creator;
		this.bloc = !!(creator?.bloc);
		this.world = creator?.world as WorldLike ?? null;
		this.source = source;

		this.traits = source.traits || [];
		this.trait_keys = source.trait_keys || [];
		this.cures = source.cures || [];
		this.cure_keys = source.cure_keys || [];
		this.vectors = source.vectors || [];
		this.vector_keys = source.vector_keys || [];
		this.seek = source.seek || [];

		this.resource = source.resource_obj as ResourceLike;
		this.phase_index = source.phase_index || 0;

		// Handle resource-based values
		const trueValue = source.true_value ?? source.value;
		if (typeof trueValue === 'string' && this.world) {
			this.value = 1;
			const resource = this.world.getResource(trueValue);
			this.value_resource_mult = new Set(resource ? [resource as ResourceLike] : []);
		} else {
			this.value = trueValue as number || 0;
			this.value_resource_mult = new Set();
		}

		this.sd_resource_mult = new Set();
		this.value_multipliers = new Map();
		this.value_multipliers_keys = [];

		this.key = this.vector_keys.join('.') + '?' +
			this.trait_keys.join('.') + '?' +
			this.cure_keys.join('.') + '?' +
			(this.resource?.key || '');
	}
}

/**
 * SiteTransmit - Site-specific transmission with localized stockpile values
 */
export class SiteTransmit {
	site: SiteLike;
	source: SynTransmit | SynImpact;
	value_stockpile_links: StockpileLike[];
	sd_stockpile_links: StockpileLike[];
	value: number = 0;
	sd: number = 0;

	constructor(source: SynTransmit | SynImpact, site: SiteLike) {
		this.site = site;
		this.source = source;
		this.value_stockpile_links = this.linkStockpiles(source.value_resource_mult);
		this.sd_stockpile_links = this.linkStockpiles(source.sd_resource_mult);
		this.recalculateValues();
	}

	multiplyAllStockpiles(links: StockpileLike[]): number {
		let v = 1;
		for (const link of links) {
			v *= link.value;
			if (v === 0) break;
		}
		return v;
	}

	recalculateValues(): void {
		this.value = this.source.value * this.multiplyAllStockpiles(this.value_stockpile_links);
		this.sd = this.source.sd * this.multiplyAllStockpiles(this.sd_stockpile_links);
	}

	linkStockpiles(set: Set<ResourceLike>): StockpileLike[] {
		const arr: StockpileLike[] = [];
		for (const resource of set) {
			const stockpile = resource.getStockpile(this.site);
			if (stockpile) {
				stockpile.linked_transmit_mods.push(this);
				arr.push(stockpile);
			}
		}
		return arr;
	}
}

export default SynTransmit;
