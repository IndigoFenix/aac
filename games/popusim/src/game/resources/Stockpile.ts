import { floatVal } from '../../core/utils';
import type { Resource } from './Resource';
import type { PhaseDelta } from '../simulation/PhaseDelta';

// Forward references for types (local to this module)
interface WorldLike {
	age: number;
	getResource(key: string): Resource;
}

interface SiteLike {
	world: WorldLike;
	local_stockpiles_kv: Record<string, Stockpile>;
}

interface HistoryLike {
	onUpdatedStockpile(stockpile: Stockpile): void;
	onUpdatedDenominatorStockpile(stockpile: Stockpile): void;
	updateDisplayIfNeeded(stockpile: Stockpile): void;
}

interface PopulationLike {
	pop: number;
	syndrome: SyndromeLike;
	applyShedToDelta(vectorCount: number, shed: ShedLike, delta: PhaseDelta): void;
}

interface SyndromeLike {
	getSeekMod(impact: SynImpactLike): number;
}

interface SiteTransmitLike {
	value: number;
	source: SynImpactLike;
}

interface SynImpactLike {
	key: string;
	value: number;
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

interface ShedLike { }

interface TransmitModLike {
	recalculateValues(): void;
}

interface ActionCostLike {
	current_value: number;
}

interface ActionProduceLike {
	current_value: number;
}

interface ConsumptionRequest {
	population: PopulationLike;
	siteTransmit: SiteTransmitLike;
	weighted_amount: number;
	amount_requested: number;
}

// Shed factory (set via dependency injection)
let createShed: ((
	stockpile: Stockpile,
	key: string,
	vectorsCreated: number,
	vectors: unknown[],
	vectorKeys: string[],
	traits: unknown[],
	traitKeys: string[],
	cures: unknown[],
	cureKeys: string[],
	seek: unknown[],
	precise: boolean,
	relevantClusters: unknown[]
) => ShedLike) | null = null;

export function setStockpileDependencies(deps: {
	createShed?: typeof createShed;
}): void {
	if (deps.createShed) createShed = deps.createShed;
}

/**
 * A stockpile tracks a particular site's level of a resource.
 * Handles production, consumption, and resource requests.
 */
export class Stockpile {
	resource: Resource;
	site: SiteLike | null;
	world: WorldLike;
	system: unknown;

	/** Stable integer ID assigned by World registration. Used as the stockId
	 * in PhaseDelta TypedArrays and as the index in `world.stockpiles_by_id`. */
	id: number = -1;

	// Denominator tracking for percentage display
	denominator_resource: Resource | null = null;
	no_denominator_stockpile: boolean = true;
	denominator: number = 1;
	denominator_stockpile: Stockpile | null = null;
	numerator_stockpiles: Stockpile[] = [];

	max_precision: number;
	enabled: boolean;

	// Value tracking
	value: number;
	adjusted_value: number;
	stored_value: number;
	impact_value: number = 0;
	value_inc: number = 0;
	value_dec: number = 0;
	adjust: number = 0;

	// References
	cost: ActionCostLike[] = [];
	produce: ActionProduceLike[] = [];
	linked_transmit_mods: TransmitModLike[] = [];
	linked_contact_mods: Map<object, string[]> = new Map();

	// History
	hist: HistoryLike[] = [];
	denominator_hist: HistoryLike[] = [];

	// Consumption
	consumption_requests: ConsumptionRequest[] = [];
	weighted_total: number = 0;
	total_requested: number = 0;

	constructor(resource: Resource, parent: WorldLike | SiteLike, value?: number) {
		this.resource = resource;

		// Determine if global or local
		if (resource.global) {
			if ((parent as WorldLike).age !== undefined) {
				// Parent is World
				this.site = null;
				this.world = parent as WorldLike;
			} else {
				throw new Error('Attempted to create global resource on a site.');
			}
		} else {
			if ((parent as SiteLike).world !== undefined) {
				// Parent is Site
				this.site = parent as SiteLike;
				this.world = this.site.world;
			} else {
				throw new Error('Attempted to create local resource with no defined site.');
			}
		}

		// Set up denominator
		if (resource.denominator) {
			this.denominator_resource = this.world.getResource(resource.denominator);
			this.no_denominator_stockpile = false;
			this.denominator = this.denominator_resource.value;
		}

		this.max_precision = this.resource.precision;
		this.system = (this.world as unknown as { system: unknown }).system;

		// Initialize values
		this.value = this.adjusted_value = this.stored_value = floatVal(value, 0);
		this.enabled = !this.resource.hidden;

		this.resetConsumptionRequests();
	}

	setHistory(hist: HistoryLike): void {
		this.hist.push(hist);
	}

	setDenominatorHistory(hist: HistoryLike): void {
		this.denominator_hist.push(hist);
	}

	updateStockpileHistory(): void {
		for (const h of this.hist) {
			h.onUpdatedStockpile(this);
		}
		for (const h of this.denominator_hist) {
			h.onUpdatedDenominatorStockpile(this);
		}
	}

	updateStockpileHistoryDisplay(): void {
		for (const h of this.hist) {
			h.updateDisplayIfNeeded(this);
		}
		for (const h of this.denominator_hist) {
			h.updateDisplayIfNeeded(this);
		}
	}

	addImpactValue(value: number): void {
		this.impact_value += value;
	}

	setImpactValue(): void {
		this.setValue(this.impact_value + this.value);
		this.impact_value = 0;
	}

	resetConsumptionRequests(): void {
		this.weighted_total = this.total_requested = this.consumption_requests.length = 0;
	}

	makeConsumptionRequest(population: PopulationLike, siteTransmit: SiteTransmitLike): void {
		const amount_requested = -siteTransmit.value * population.pop;
		this.total_requested += amount_requested;

		const impact = siteTransmit.source;
		let weighted_amount: number;

		if (impact.seek.length > 0) {
			const seek_mod = population.syndrome.getSeekMod(impact);
			if (seek_mod === 0) return; // No request
			weighted_amount = amount_requested * seek_mod;
		} else {
			weighted_amount = amount_requested;
		}

		this.weighted_total += weighted_amount;
		this.consumption_requests.push({ population, siteTransmit, weighted_amount, amount_requested });
	}

	/**
	 * Process all consumption requests.
	 *
	 * Snapshot semantics: requests emit contact deltas to `delta` (instead of
	 * mutating populations) and a stockpile delta (instead of mutating value).
	 * The order in which requests are processed within a single phase, and
	 * the order in which stockpiles are processed, no longer affects the
	 * outcome. The delta is drained by World.applyPhaseDelta at end of phase.
	 */
	async doConsumption(delta: PhaseDelta): Promise<void> {
		if (!createShed) {
			console.error('Shed factory not set - call setStockpileDependencies first');
			return;
		}

		const requests = this.consumption_requests;
		const current_value = this.value;

		if (this.total_requested === 0) return;

		const fullyFunded = this.total_requested <= current_value;

		for (let s = requests.length - 1; s >= 0; s--) {
			const request = requests[s];
			const source = request.siteTransmit.source;

			let amount_given: number;
			if (fullyFunded) {
				amount_given = request.amount_requested;
			} else {
				const perc = request.weighted_amount / this.weighted_total;
				amount_given = current_value * perc * source.value;
			}
			const vectors_created = amount_given / -request.siteTransmit.value;

			const shed = createShed(
				this,
				source.key,
				vectors_created,
				source.vectors,
				source.vector_keys,
				source.traits,
				source.trait_keys,
				source.cures,
				source.cure_keys,
				source.seek,
				source.precise,
				source.relevant_clusters
			);

			request.population.applyShedToDelta(vectors_created, shed as ShedLike, delta);
		}

		// Stockpile value change is a delta; the actual mutation happens at apply.
		delta.addStockpileDelta(this.id, fullyFunded ? -this.total_requested : -current_value);
		this.resetConsumptionRequests();
	}

	/**
	 * Set value (called by events only)
	 */
	setValue(value: number): void {
		if (isNaN(value)) {
			console.error('Stockpile.setValue: NaN value rejected for', (this as unknown as { resource?: { key?: string } }).resource?.key);
			return;
		}
		if (this.value !== value) {
			if (value > this.value) {
				this.value_inc += value - this.value;
			} else {
				this.value_dec += this.value - value;
			}
			this.value = value;
			this.updateStockpileHistory();
			this.onValueChanged();
		}
	}

	/**
	 * Apply adjustments from actions
	 */
	doAdjustment(): void {
		if (this.adjust !== 0) {
			this.value += this.adjust;
			this.adjust = 0;
			this.onValueChanged();
		}
	}

	/**
	 * Consolidate all costs and produces.
	 *
	 * Cost current_values are negative (consumption); produce current_values
	 * are signed (positive produces, negative drains). Both feed into the
	 * "adjusted" preview the GUI shows.
	 */
	setAdjustedValue(): void {
		let adjust = 0;
		for (const c of this.cost) {
			adjust += c.current_value;
		}
		for (const p of this.produce) {
			adjust += p.current_value;
		}
		this.adjust = adjust;
		this.adjusted_value = this.stored_value + adjust;
	}

	private resetLinkedMods(map: Map<object, string[]>): void {
		for (const [key, value] of map) {
			for (const prop of value) {
				delete (key as Record<string, unknown>)[prop];
			}
			map.set(key, []);
		}
	}

	private onValueChanged(): void {
		this.resetLinkedMods(this.linked_contact_mods);
		for (const mod of this.linked_transmit_mods) {
			mod.recalculateValues();
		}
	}

	/**
	 * Update stored value for display
	 */
	updateStoredValue(): void {
		const change = this.value - this.stored_value;
		this.stored_value = this.value;
		this.adjusted_value += change;
		this.updateStockpileHistory();
	}

	getDenominatorStockpile(): Stockpile | null {
		if (this.denominator_stockpile) return this.denominator_stockpile;
		if (this.no_denominator_stockpile) return null;

		if (!this.denominator_resource) return null;

		this.denominator_stockpile = this.denominator_resource.getStockpile(this.site) as Stockpile | null;

		if (this.denominator_stockpile) {
			this.denominator_stockpile.numerator_stockpiles.push(this);
			return this.denominator_stockpile;
		} else {
			console.error('No valid denominator_stockpile found for ' + this.resource.key);
			this.no_denominator_stockpile = true;
			return null;
		}
	}

	/**
	 * Get formatted display text
	 */
	getDisplayText(): string {
		const denominator_stockpile = this.getDenominatorStockpile();
		if (denominator_stockpile) {
			this.denominator = denominator_stockpile.adjusted_value;
		}

		if (this.resource.display === "") {
			if (denominator_stockpile) {
				return `${this.adjusted_value.toFixed(this.max_precision)}/${this.denominator.toFixed(denominator_stockpile.max_precision)}`;
			} else {
				return this.adjusted_value.toFixed(this.max_precision);
			}
		} else if (this.resource.display === "perc") {
			return `${((this.adjusted_value / this.denominator) * 100).toFixed(this.max_precision)}%`;
		}

		return String(this.adjusted_value);
	}
}

export default Stockpile;
