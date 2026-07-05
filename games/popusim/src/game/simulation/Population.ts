/**
 * Population - A group within a location that has a particular syndrome
 * SubPop - A subdivision of population being moved
 * PopStockpileLink - Links population to stockpile values
 */

import { removeFrom } from '../../core/utils';
import { Rect } from '../../core/Rect';
import type { Syndrome } from './Syndrome';
import type { SubSyndrome } from './SubSyndrome';
import { Shed } from './Shed';
import type { SiteTransmit, SynTransmit, SynImpact } from './SynTransmit';
import type { PhaseDelta } from './PhaseDelta';
import type { ShedItem as ShedBatchItem } from '../../sim/gpu/shedAmountBatch';
import { SHED_KIND_TRANSMIT, SHED_KIND_PROGRESS, SHED_KIND_PRODUCE } from '../../sim/gpu/shedAmountBatch';
import { profiler } from '../../core/Profiler';

// Use simplified interfaces to avoid cross-module conflicts
interface HistoryLike {
	started: boolean;
	current: number;
	current_inc: number;
	current_dec: number;
	startRecord(): void;
}

interface WorldLike {
	age: number;
	subsyndromes_kv: Map<string, SubSyndrome>;
	subsyndromes_by_id: SubSyndrome[];
	getSubSyndrome(key: string): SubSyndrome | null;
	materializeSubSyndrome(key: string, trait_keys: string[], trait_states: Record<string, number>): SubSyndrome;
	materializeSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndrome;
	global_stockpiles_kv: Record<string, StockpileLike>;
}

interface SiteLike {
	key: string;
	world: WorldLike;
	pop: number;
	trait_hist_kv: Record<string, HistoryLike>;
	pops_kv: Record<string, Population>;
	local_stockpiles_kv: Record<string, StockpileLike>;
	units: Unit[];
	addHist(hist: HistoryLike): HistoryLike;
	addPop(pop: number, syndrome: Syndrome): Population;
	addShed(
		origin: unknown,
		key: string,
		amount: number,
		vectors: unknown[],
		vector_keys: string[],
		traits: unknown[],
		trait_keys: string[],
		cures: unknown[],
		cure_keys: string[],
		seek: unknown[],
		precise: boolean,
		relevant_clusters: unknown
	): void;
}

interface SystemLike {
	rand: { get(): number };
	renderIfNeeded(world: WorldLike): Promise<void> | void;
}

interface StockpileLike {
	addImpactValue(value: number): void;
	makeConsumptionRequest(pop: Population, transmit: SiteTransmit): void;
}

/**
 * SubPop - A group of people being moved to a new population
 */
export class SubPop {
	pop: number;
	subsyndrome: SubSyndrome;

	constructor(pop: number, subsyndrome: SubSyndrome) {
		this.pop = pop;
		this.subsyndrome = subsyndrome;
	}
}

/**
 * PopStockpileLink - Links a population to a stockpile value
 */
export class PopStockpileLink {
	population: Population;
	stockpile: StockpileLike;
	value: number;

	constructor(population: Population, stockpile: StockpileLike, value: number) {
		this.population = population;
		this.stockpile = stockpile;
		this.value = value;
	}
}

/**
 * Population - A group within a location sharing a syndrome
 */
export class Population {
	site: SiteLike;
	world: WorldLike;
	system: SystemLike;
	syndrome: Syndrome;

	/** Stable integer ID assigned by World on creation. Used as the popId in
	 * PhaseDelta TypedArrays and as the index in `world.populations_by_id`. */
	id: number = -1;

	// Population counts
	pop: number;
	pop_inc: number;
	pop_dec: number = 0;

	// Progression tracking
	progress: Shed[] = [];

	// Subpopulation tracking
	primary_subpop: SubPop | null = null;
	subpops: SubPop[] = [];
	subpops_kv: Record<string, SubPop> = {};
	/** Parallel array indexed by SubSyndrome.id. Sparse; entries may be null
	 * for SubSyndromes that don't currently have a SubPop in this Population. */
	subpops_by_id: (SubPop | null)[] = [];

	// History tracking
	hist: HistoryLike[] = [];
	val: number[] = [];
	val_inc: number[] = [];
	val_dec: number[] = [];
	start: number;

	// Cluster tracking
	subclusters: unknown[] = [];

	// Visual units
	units: Unit[] = [];

	// Phased transmission data
	transmit_phases: SiteTransmit[][] = [];
	progress_phases: SiteTransmit[][] = [];
	produce_phases: SiteTransmit[][] = [];
	consume_phases: SiteTransmit[][] = [];

	// Trait states
	trait_states: Record<string, number> = {};
	primary_subsyndrome: SubSyndrome;

	constructor(site: SiteLike, pop: number, syndrome: Syndrome) {
		this.site = site;
		this.world = site.world;
		this.system = (this.world as unknown as { system: SystemLike }).system;
		this.syndrome = syndrome;
		this.pop = this.pop_inc = pop;
		this.start = this.world.age;

		// Initialize history tracking for each tracker
		for (const tracker of this.syndrome.trackers) {
			let hist = this.site.trait_hist_kv[tracker.key];
			if (!hist) {
				hist = this.site.addHist({ tracker, started: false, current: 0, current_inc: 0, current_dec: 0, startRecord() { this.started = true; } } as HistoryLike);
			}
			if (!hist.started) hist.startRecord();
			this.hist.push(hist);
		}

		// Get localized phases
		this.transmit_phases = this.syndrome.getLocalizedPhases(
			this.syndrome.transmit_phases,
			this.site as never
		);
		this.progress_phases = this.syndrome.getLocalizedPhases(
			this.syndrome.progress_phases,
			this.site as never
		);
		this.produce_phases = this.syndrome.getLocalizedPhases(
			this.syndrome.produce_phases,
			this.site as never
		);
		this.consume_phases = this.syndrome.getLocalizedPhases(
			this.syndrome.consume_phases,
			this.site as never
		);

		// Initialize trait states
		for (const key of this.syndrome.base_trait_keys) {
			this.trait_states[key] = 1;
		}

		// Build subsyndrome key
		const new_trait_keys = Object.keys(this.trait_states).sort();
		let new_key = '';
		for (const k of new_trait_keys) {
			new_key += k + '=' + this.trait_states[k] + '.';
		}

		this.primary_subsyndrome = this.world.materializeSubSyndrome(
			new_key,
			new_trait_keys,
			this.trait_states
		);
	}

	getDateIndex(day: number): number {
		return day - this.start;
	}

	/**
	 * Phase-start reset.
	 *
	 * Pre-Phase-2c this allocated a fresh `SubPop` plus the `subpops`
	 * list + maps that `applyDeltaShift` then populated. With direct
	 * Pop-to-Pop transfer (Phase 2c) those bookkeeping arrays are no
	 * longer touched, so we just clear the per-phase `progress` shed list
	 * and refresh `primary_subpop`'s count (used in a couple of profiler
	 * paths and snapshot helpers). The empty `subpops*` arrays remain
	 * for any straggler reader; they stay length-1 with `primary_subpop`.
	 */
	createPrimarySubpop(): void {
		const stop = profiler.start('Population.createPrimarySubpop');
		this.progress = [];
		if (!this.primary_subpop) {
			this.primary_subpop = new SubPop(this.pop, this.primary_subsyndrome);
		} else {
			this.primary_subpop.pop = this.pop;
		}
		this.subpops = [this.primary_subpop];
		if (this.pop < 0) this.pop = 0;
		stop();
	}

	async updateTransmission(phase_index: number): Promise<void> {
		if (this.pop === 0) {
			// `makeRequestsForConsumption` is declared `async` but its body
			// is fully synchronous, so awaiting it just buys a microtask
			// yield with no actual wait. Skip the await and rely on
			// synchronous execution.
			this.makeRequestsForConsumption(phase_index);
			const yp = this.system.renderIfNeeded(this.world);
			if (yp !== undefined) await yp;
			return;
		}

		const batch = (this.site as unknown as { pendingShedItems: ShedBatchItem[] }).pendingShedItems;
		const popId = this.id;
		const popCount = this.pop;
		const sitePop = this.site.pop;

		// Transmission: push one batch item per (population, transmit) pair.
		// The shed amount is computed in `Site.runShedAmountBatch` (CPU or
		// GPU); shedAmountBatch dispatches to site.addShed for TRANSMIT items.
		for (const transmit of this.transmit_phases[phase_index] || []) {
			const source = transmit.source as SynTransmit;
			batch.push({
				popId,
				txKindId: source.txKindId,
				popCount,
				value: transmit.value,
				sd: transmit.sd,
				kind: SHED_KIND_TRANSMIT,
				popMul: source.popmult ? sitePop : 1,
				source: source as never,
				target: this.site as never,
			});
		}

		// Progression: shedAmountBatch dispatches to pop.progress.push(new Shed(...)).
		for (const progress of this.progress_phases[phase_index] || []) {
			const source = progress.source as SynTransmit;
			batch.push({
				popId,
				txKindId: source.txKindId,
				popCount,
				value: progress.value,
				sd: progress.sd,
				kind: SHED_KIND_PROGRESS,
				popMul: 1,
				source: source as never,
				target: this as never,
			});
		}

		// Production: shedAmountBatch dispatches to stockpile.addImpactValue.
		for (const transmit of this.produce_phases[phase_index] || []) {
			const source = transmit.source as SynImpact;
			const resource = source.resource as { key: string; global?: boolean };
			const stock = resource.global
				? this.world.global_stockpiles_kv[resource.key]
				: this.site.local_stockpiles_kv[resource.key];
			batch.push({
				popId,
				txKindId: (transmit.source as { txKindId: number }).txKindId,
				popCount,
				value: transmit.value,
				sd: transmit.sd,
				kind: SHED_KIND_PRODUCE,
				popMul: 1,
				source: null,
				target: stock as never,
			});
		}

		this.makeRequestsForConsumption(phase_index);
		const yp = this.system.renderIfNeeded(this.world);
		if (yp !== undefined) await yp;
	}

	async makeRequestsForConsumption(phase_index: number): Promise<void> {
		for (const transmit of this.consume_phases[phase_index] || []) {
			const source = transmit.source as SynImpact;
			const resource = source.resource as { key: string; global?: boolean };

			if (resource.global) {
				this.world.global_stockpiles_kv[resource.key].makeConsumptionRequest(this, transmit);
			} else {
				this.site.local_stockpiles_kv[resource.key].makeConsumptionRequest(this, transmit);
			}
		}
	}

	getNumberHit(targetCount: number, vectorCount: number, hitChance: number): number {
		if (targetCount === 0 || vectorCount === 0 || hitChance === 0) return 0;
		const p = (1 / targetCount) * hitChance;
		const prob = 1 - Math.pow(1 - p, vectorCount);
		const mean = targetCount * prob;
		return mean;
	}

	/**
	 * Compute the result of a shed hitting this population and write it to
	 * the phase delta. No mutation of subpops or population state. The
	 * SubSyndrome registry mutation (materializeSubSyndrome) is idempotent
	 * — same key always produces the same id — so calling it from the kernel
	 * does not break order-independence.
	 *
	 * Snapshot semantics: at the start of every phase, every Population has a
	 * single primary_subpop containing all of its units. Within the phase,
	 * subpops are not mutated until the apply step. Therefore each shed
	 * processes against the primary_subsyndrome at its phase-start population
	 * count, and writes a single delta entry.
	 */
	applyShedToDelta(vectorCount: number, shed: Shed, delta: PhaseDelta): void {
		if (this.pop === 0 || vectorCount === 0) return;

		const modified_shed = this.syndrome.getContactMod(shed, this.site as never);
		const multiplier = modified_shed.multiplier;

		const hitCount = shed.precise
			? vectorCount * multiplier
			: this.getNumberHit(this.pop, vectorCount, multiplier);

		if (hitCount <= 0) return;
		if (isNaN(hitCount)) {
			console.error('Error hitCount', shed, this.syndrome);
			return;
		}

		const sourceSub = this.primary_subsyndrome;
		const result = sourceSub.computeContactResult(shed, modified_shed);
		if (result.unchanged) return;

		// Materialize eagerly via mask path (idempotent). For repeat
		// contacts that hit an already-known target syndrome, this is just
		// a Map lookup with no allocation.
		const targetSub = this.world.materializeSubSyndromeByMask(result.target_mask, 0);

		delta.addPopShift(this.id, sourceSub.id, targetSub.id, hitCount);
	}

	/**
	 * Walk the population's queued progression sheds and emit them as deltas.
	 */
	applyProgressionToDelta(delta: PhaseDelta): void {
		if (this.pop === 0) return;
		for (const shed of this.progress) {
			this.applyShedToDelta(shed.amount, shed, delta);
		}
		this.progress = [];
	}

	/**
	 * Apply a single delta shift to this Population's subpops: round the
	 * amount once, then move units from the source SubPop to the target
	 * SubPop (creating the target if needed). Called by World.applyPhaseDelta
	 * during the single-pass apply over PhaseDelta's TypedArrays.
	 *
	 * The rngDraw key includes (popId, sourceSubId, targetSubId) so the
	 * fractional-rounding decision is deterministic and order-independent.
	 */
	/**
	 * Apply one popshift entry from the PhaseDelta.
	 *
	 * Phase 2c — direct Pop-to-Pop transfer. Pre-Phase-2c this routed
	 * units through transient SubPops attached to *this* Population, and
	 * `Site.updatePopulations` later walked the SubPop list to push units
	 * to whichever Population owned that syndrome. Both passes scaled with
	 * the number of delta entries (one of the biggest CPU buckets at
	 * scale). Going direct collapses the two passes into one:
	 *   1. Stochastic-round `amount` to an integer `moved` via HashRand.
	 *   2. Look up (or create) the target Population by its
	 *      SubSyndrome.id's syndrome key.
	 *   3. Transfer `moved` units from `this` to the target via the
	 *      existing `addUnits` / `removeUnits` hist-aware helpers.
	 *
	 * Snapshot semantics still hold: all delta entries are written by the
	 * apply-shed / progression pass *before* `applyPhaseDelta` runs, so
	 * earlier kernels read frozen pop counts. Per-entry caps still apply
	 * — `moved > this.pop` is clamped, matching the legacy behaviour.
	 */
	applyDeltaShift(
		sourceSubId: number,
		targetSubId: number,
		amount: number,
		rngDraw: (popId: number, sourceSubId: number, targetSubId: number) => number
	): void {
		if (amount === 0 || sourceSubId === targetSubId) return;

		let moved = Math.floor(amount);
		const frac = amount - moved;
		if (frac > 0 && rngDraw(this.id, sourceSubId, targetSubId) < frac) moved++;
		if (moved > this.pop) moved = this.pop;
		if (moved <= 0) return;

		const targetSubsyn = this.world.subsyndromes_by_id[targetSubId];
		if (!targetSubsyn) {
			console.error('Missing subsyndrome at apply', targetSubId);
			return;
		}
		const targetSyndrome = targetSubsyn.getSyndrome() as Syndrome;
		let targetPop = this.site.pops_kv[targetSyndrome.key];
		if (!targetPop) {
			targetPop = this.site.addPop(0, targetSyndrome);
		}
		if (targetPop === this) return;

		this.transferTo(targetPop as Population, moved);
	}

	/**
	 * Move `moved` units from this population to `targetPop` on the SAME
	 * site — a syndrome change, not travel. This is the C2b membership
	 * primitive (grand-dream §7 breakaways ride it): exact, no rounding
	 * draw, with the same hist-aware bookkeeping and tracked-unit handling
	 * as the delta-shift path. Progression state is not carried — intended
	 * for stateless membership/ideology flips.
	 */
	transferTo(targetPop: Population, moved: number): void {
		if (moved > this.pop) moved = this.pop;
		if (moved <= 0 || targetPop === this) return;

		this.removeUnits(moved, this, this.primary_subpop);
		targetPop.addUnits(moved, this, this.primary_subpop);

		// Tracked-unit reassignment, copied from the previous
		// `Site.updatePopulations` body.
		if (this.syndrome.tracked) {
			for (let j = 0; j < moved; j++) {
				if (this.units[0]) {
					this.units[0].changePop(targetPop);
				}
			}
		} else if (targetPop.syndrome.tracked) {
			for (let j = 0; j < moved; j++) {
				new Unit(targetPop);
			}
		}
	}

	/**
	 * No-op since Phase 2c — units are transferred directly between
	 * Populations in `applyDeltaShift`, so there are no transient SubPops
	 * left to reconcile. Retained as a method on the class because
	 * `Site.updatePopulations` and a few external callers still invoke it;
	 * inlining `await this.system.renderIfNeeded` keeps the render-tick
	 * cadence unchanged.
	 */
	async updatePopulations(): Promise<void> {
		const stop = profiler.start('Population.updatePopulations');
		const yp = this.system.renderIfNeeded(this.world);
		if (yp !== undefined) await yp;
		stop();
	}

	async updatePopulationsHistory(): Promise<void> {
		this.val.push(this.pop);
		this.val_inc.push(this.pop_inc);
		this.val_dec.push(this.pop_dec);
		this.pop_inc = this.pop_dec = 0;
		const yp = this.system.renderIfNeeded(this.world);
		if (yp !== undefined) await yp;
	}

	addUnits(movedpop: number, _frompop: Population, _fromsubpop: SubPop | null): void {
		this.pop += movedpop;
		this.pop_inc += movedpop;

		for (const hist of this.hist) {
			hist.current += movedpop;
			hist.current_inc += movedpop;
		}
	}

	removeUnits(movedpop: number, _frompop: Population, _fromsubpop: SubPop | null): void {
		if (this.pop > 0) {
			this.pop -= movedpop;
			this.pop_dec += movedpop;
		}

		for (const hist of this.hist) {
			hist.current -= movedpop;
			hist.current_dec += movedpop;
			if (hist.current < 0) {
				console.error('History below 0', hist);
			}
		}
	}

	/**
	 * Move `moved` units of this Population to the same-syndrome Population
	 * on another Site (creating it there if absent). Used by route
	 * migration at the day boundary. Syndromes are world-interned, so the
	 * destination site resolves the identical Syndrome object.
	 *
	 * Uses the same hist-aware addUnits/removeUnits bookkeeping as
	 * applyDeltaShift, keeps both sites' `pop` totals current, and mirrors
	 * applyDeltaShift's tracked-unit handling.
	 */
	migrateTo(destSite: SiteLike, moved: number): void {
		if (moved <= 0 || destSite === this.site) return;
		if (moved > this.pop) moved = this.pop;
		if (moved <= 0) return;

		let destPop = destSite.pops_kv[this.syndrome.key];
		if (!destPop) {
			destPop = destSite.addPop(0, this.syndrome);
		}

		this.removeUnits(moved, this, null);
		destPop.addUnits(moved, this, null);
		this.site.pop -= moved;
		destSite.pop += moved;

		if (this.syndrome.tracked) {
			for (let j = 0; j < moved; j++) {
				if (this.units[0]) {
					this.units[0].changePop(destPop);
				}
			}
		} else if (destPop.syndrome.tracked) {
			for (let j = 0; j < moved; j++) {
				new Unit(destPop);
			}
		}
	}
}

/**
 * Unit - A visual representation of a population member
 */
export class Unit {
	pop: Population;
	site: SiteLike;
	syndrome: Syndrome;
	x: number;
	y: number;
	radius: number = 16;
	bbox: Rect;

	constructor(population: Population) {
		this.pop = population;
		this.site = population.site;
		this.syndrome = population.syndrome;
		this.x = Math.random() * 300;
		this.y = Math.random() * 200;
		this.bbox = new Rect(
			this.x - this.radius,
			this.y - this.radius,
			this.radius * 2,
			this.radius * 2,
			[this.x, this.y]
		);

		population.units.push(this);
		population.site.units.push(this);
	}

	changePop(pop: Population): void {
		if (!pop.syndrome.tracked) {
			this.destroy();
		} else {
			removeFrom(this.pop.units, this);
			pop.units.push(this);
			this.pop = pop;
			this.syndrome = pop.syndrome;

			if (pop.site !== this.site) {
				removeFrom(this.site.units, this);
				pop.site.units.push(this);
				this.site = pop.site;
			}
		}
	}

	applyShed(sheds: Shed[]): void {
		if (sheds.length === 0) return;

		let subsyndrome = this.pop.primary_subsyndrome;

		for (const shed of sheds) {
			const modified_shed = this.syndrome.getContactMod(shed, this.site as never);
			const prob = modified_shed.multiplier;

			if (prob < 1 && (this.site.world as unknown as { system: SystemLike }).system.rand.get() >= prob) {
				continue;
			}

			subsyndrome = subsyndrome.getContactResult(shed, modified_shed);
		}

		const syndrome = subsyndrome.getSyndrome() as Syndrome;
		if (syndrome !== this.syndrome) {
			let pop = this.site.pops_kv[syndrome.key];
			if (!pop) {
				pop = this.site.addPop(1, syndrome);
			}
			this.pop.removeUnits(1, this.pop, null as never);
			this.changePop(pop);
		}
	}

	render(screen: { context: CanvasRenderingContext2D }): void {
		const context = screen.context;
		const src_canvas = this.syndrome.canvas;
		if (src_canvas) {
			context.drawImage(
				src_canvas,
				0, 0,
				src_canvas.width, src_canvas.height,
				this.x - this.radius, this.y - this.radius,
				src_canvas.width, src_canvas.height
			);
		}
	}

	canBeTargetedBy(action: unknown): boolean {
		return this.syndrome.canBeTargetedBy(action as never);
	}

	destroy(): void {
		removeFrom(this.pop.units, this);
		removeFrom(this.site.units, this);
	}
}

export default Population;
