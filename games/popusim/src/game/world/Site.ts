import { HIST_TYPE } from '../../types/constants';
import { BWObj } from '../../core/BWObj';
import { intVal, parseChildren, strVal } from '../../core/parse';
import { removeFrom, stringVal } from '../../core/utils';
import { Transmit } from '../transmission/Transmit';
import { PopInit } from '../actions/PopInit';
import { PhaseDelta } from '../simulation/PhaseDelta';
import type { ShedItem } from '../../sim/gpu/shedAmountBatch';
import { runShedAmountBatch } from '../../sim/gpu/shedAmountBatch';
import type { ShedAmountKernel } from '../../sim/gpu/shedAmountKernel';
import { runSeekModBatch } from '../../sim/gpu/seekModBatch';
import type { SeekModKernel } from '../../sim/gpu/seekModKernel';
import { runApplyShedBatch } from '../../sim/gpu/applyShedBatch';
import type { ApplyShedKernel } from '../../sim/gpu/applyShedKernel';
import { profiler } from '../../core/Profiler';

// Forward references for runtime types
interface WorldLike extends BWObj {
	system: SystemLike;
	age: number;
	/** GPU kernel for batched shed-amount generation. Null when WebGPU is
	 * unavailable; runShedAmountBatch falls back to the CPU implementation. */
	shedAmountKernel: ShedAmountKernel | null;
	seekModKernel: SeekModKernel | null;
	applyShedKernel: ApplyShedKernel | null;
	traits_kv: Record<string, { index: number } | undefined>;
	materializeSubSyndromeByMask(mask: Uint32Array, offset: number): { id: number; trait_mask: Uint32Array };
	resources: ResourceLike[];
	local_actions: PlayerActionLike[];
	trackers: TrackerLike[];
	traits: TraitLike[];
	sites: Site[];
	all_phases: unknown[];
	all_stockpiles: StockpileLike[];
	all_actions: PlayerActionLike[];
	blank_cluster_array: unknown[];
	getSyndrome(traits: string[]): SyndromeLike;
	getVector(key: string): VectorLike;
	getTrait(key: string): TraitLike;
	queueCrossSiteShed(origin: Site, dest: Site, transmit: TransmitSourceLike, amount: number): void;
	syndromes_kv: Record<string, SyndromeLike>;
	registerPopulation(pop: PopulationLike & { id: number }): void;
	registerStockpile(stockpile: StockpileLike & { id: number }): void;
	applyPhaseDelta(delta: PhaseDelta, seed: number, day: number, phase: number): void;
}

interface SystemLike extends BWObj {
	rand: { get(): number; getSeed(): number };
}

interface ResourceLike {
	key: string;
	global: boolean;
	value: number;
}

interface PlayerActionLike {
	key: string;
	data: Record<string, unknown>;
	init(): void;
}

interface TrackerLike {
	key: string;
}

interface TraitLike {
	key: string;
	prob: number;
}

interface VectorLike {
	key: string;
	seek: unknown[];
}

interface SyndromeLike {
	key: string;
	relevant_phases: number[];
	getSeekMod(shed: ShedLike): number;
	/** Bitmask of the syndrome's trait set, used by the seek-weight kernel. */
	trait_mask: Uint32Array;
	trait_keys: string[];
}

interface PopulationLike {
	id: number;
	pop: number;
	syndrome: SyndromeLike;
	primary_subsyndrome: { id: number; trait_mask: Uint32Array };
	hist: HistoryLike[];
	createPrimarySubpop(): void;
	updateTransmission(phase_index: number): Promise<void>;
	applyShedToDelta(vectorCount: number, shed: ShedLike, delta: PhaseDelta): void;
	applyProgressionToDelta(delta: PhaseDelta): void;
	applyDeltaShift(sourceSubId: number, targetSubId: number, amount: number, rngDraw: (popId: number, sourceSubId: number, targetSubId: number) => number): void;
	updatePopulations(): Promise<void>;
	updatePopulationsHistory(): Promise<void>;
}

interface StockpileLike {
	id: number;
	resource: ResourceLike;
}

interface HistoryLike {
	type: number;
	tracker: TrackerLike;
	current: number;
	current_inc: number;
	initDenominators(): void;
}

interface ShedLike {
	amount: number;
	seek: unknown[];
	precise: boolean;
	/** Trait keys the shed applies / cures — read by the rest-detection
	 * latent-conversion check in updateContact. */
	trait_keys: string[];
	cure_keys: string[];
}

/** SynTransmit-shaped source handed to depositTransmitShed by the
 * shed-amount batch. `ranged` is the fraction of the shed exported along
 * this site's routes (0 = fully local). */
interface TransmitSourceLike {
	key: string;
	vectors: unknown[];
	vector_keys: string[];
	traits: unknown[];
	trait_keys: string[];
	cures: unknown[];
	cure_keys: string[];
	seek: unknown[];
	precise: boolean;
	phase_index: number;
	relevant_clusters: unknown;
	ranged?: number;
}

interface RouteLike {
	strength: number;
}

// Factory functions (set via dependency injection)
let createStockpile: ((resource: ResourceLike, site: Site, value: number) => StockpileLike) | null = null;
let createPlayerAction: ((site: Site, data: Record<string, unknown>) => PlayerActionLike) | null = null;
let createHistory: ((site: Site, tracker: TrackerLike) => HistoryLike) | null = null;
let createPopulation: ((site: Site, size: number, syndrome: SyndromeLike) => PopulationLike) | null = null;
let createShed: ((
	origin: Site | null,
	key: string | null,
	amount: number,
	vectors: unknown[],
	vectorKeys: string[],
	traits: unknown[],
	traitKeys: string[],
	cures: unknown[],
	cureKeys: string[],
	seek: unknown[],
	precise: number,
	relevantClusters: unknown[]
) => ShedLike) | null = null;

export function setSiteDependencies(deps: {
	createStockpile?: typeof createStockpile;
	createPlayerAction?: typeof createPlayerAction;
	createHistory?: typeof createHistory;
	createPopulation?: typeof createPopulation;
	createShed?: typeof createShed;
}): void {
	if (deps.createStockpile) createStockpile = deps.createStockpile;
	if (deps.createPlayerAction) createPlayerAction = deps.createPlayerAction;
	if (deps.createHistory) createHistory = deps.createHistory;
	if (deps.createPopulation) createPopulation = deps.createPopulation;
	if (deps.createShed) createShed = deps.createShed;
}

/**
 * A geographic site/location in the game world.
 * Contains populations, local stockpiles, and actions.
 */
export class Site extends BWObj {
	declare parent: BWObj & { sites: Site[] };
	declare world: WorldLike;
	declare system: SystemLike;

	// From attrs
	name: string = '';
	info: string = '';
	pop: number = 0;

	// Child objects
	startpops: PopInit[] = [];
	transmit: Transmit[] = [];

	// Runtime collections
	actions: PlayerActionLike[] = [];
	actions_kv: Record<string, PlayerActionLike> = {};
	local_stockpiles: StockpileLike[] = [];
	local_stockpiles_kv: Record<string, StockpileLike> = {};
	units: unknown[] = [];
	graph_height: number = 0;

	// Population tracking
	pops: PopulationLike[] = [];
	pops_kv: Record<string, PopulationLike> = {};
	pop_phases: PopulationLike[][] = [];
	shed_pending_phases: unknown[][] = [];
	non_zero_pops: PopulationLike[] = [];

	// History tracking
	trait_hist: HistoryLike[] = [];
	trait_hist_kv: Record<string, HistoryLike> = {};
	resource_hist: HistoryLike[] = [];
	resource_hist_kv: Record<string, HistoryLike> = {};
	metric_hist: HistoryLike[] = [];
	metric_hist_kv: Record<string, HistoryLike> = {};

	// Shed tracking
	shed: ShedLike[] = [];
	shed_keys: Record<string, ShedLike> = {};

	/** Routes touching this site, populated by Route.init() after every
	 * site's init(). `other` is the far endpoint. */
	routes: Array<{ route: RouteLike; other: Site }> = [];

	/** Per-phase batch of shed-amount items collected by populations during
	 * updateTransmission. Drained at the end of the phase via
	 * runShedAmountBatch (CPU or GPU). Not phase-indexed because we drain
	 * fully between phases. */
	pendingShedItems: ShedItem[] = [];

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		this.world = world as WorldLike;
		const d = this.data;
		this.key = strVal(d, 'key', 'site');
		this.name = strVal(d, 'name', '');
		this.info = strVal(d, 'info', '');
		this.pop = intVal(d, 'pop', 0);
		this.startpops = parseChildren(this, d, 'startpop', PopInit);
		this.transmit = parseChildren(this, d, 'transmit', Transmit);
	}

	init(): void {
		this.pops = [];
		this.pops_kv = {};
		this.pop_phases = [];
		this.shed_pending_phases = [];
		this.actions = [];
		this.actions_kv = {};
		this.local_stockpiles = [];
		this.local_stockpiles_kv = {};
		this.non_zero_pops = [];

		this.trait_hist = [];
		this.trait_hist_kv = {};
		this.resource_hist = [];
		this.resource_hist_kv = {};
		this.metric_hist = [];
		this.metric_hist_kv = {};

		// Initialize transmissions
		for (const t of this.transmit) {
			t.init();
		}

		this.shed = [];
		this.shed_keys = {};
		this.routes = [];

		// Create phase arrays
		for (let i = 0; i < this.world.all_phases.length; i++) {
			this.pop_phases.push([]);
			this.shed_pending_phases.push([]);
		}
	}

	/**
	 * Initialize local stockpiles for non-global resources
	 */
	initLocalStockpiles(): void {
		if (!createStockpile) {
			console.error('Stockpile factory not set');
			return;
		}

		for (const resource of this.world.resources) {
			if (!resource.global) {
				if (this.local_stockpiles_kv[resource.key]) {
					console.error('Tried to create stockpile that already exists');
				} else {
					const stockpile = createStockpile(resource, this, resource.value);
					this.world.registerStockpile(stockpile as StockpileLike & { id: number });
					this.local_stockpiles.push(stockpile);
					this.local_stockpiles_kv[resource.key] = stockpile;
					this.world.all_stockpiles.push(stockpile);
				}
			}
		}
	}

	/**
	 * Initialize local actions
	 */
	initLocalActions(): void {
		if (!createPlayerAction) {
			console.error('PlayerAction factory not set');
			return;
		}

		for (const localAction of this.world.local_actions) {
			const action = createPlayerAction(this, localAction.data);
			action.init();
			this.actions.push(action);
			this.actions_kv[action.key] = action;
			this.world.all_actions.push(action);
		}
	}

	/**
	 * Initialize history tracking
	 */
	initHistory(): void {
		if (!createHistory) {
			console.error('History factory not set');
			return;
		}

		for (const tracker of this.world.trackers) {
			this.addHist(createHistory(this, tracker));
		}
	}

	/**
	 * Initialize history denominators
	 */
	initHistoryDenominators(): void {
		for (const hist of this.resource_hist) {
			hist.initDenominators();
		}
	}

	/**
	 * Add a population to this site
	 */
	addPop(size: number, syndrome: SyndromeLike): PopulationLike | null {
		if (!createPopulation) {
			console.error('Population factory not set');
			return null;
		}

		const pop = createPopulation(this, size, syndrome);
		this.world.registerPopulation(pop);
		this.pops.push(pop);
		this.pops_kv[pop.syndrome.key] = pop;

		if (size !== 0) {
			this.non_zero_pops.push(pop);
		}

		if (pop.syndrome) {
			for (const phase of pop.syndrome.relevant_phases) {
				this.pop_phases[phase].push(pop);
			}
		}

		// Update history
		for (const hist of pop.hist) {
			hist.current += size;
			hist.current_inc += size;
		}

		return pop;
	}

	/**
	 * Add a history tracker
	 */
	addHist(hist: HistoryLike): HistoryLike {
		switch (hist.type) {
			case HIST_TYPE.TRAIT:
				this.trait_hist.push(hist);
				this.trait_hist_kv[hist.tracker.key] = hist;
				break;
			case HIST_TYPE.RESOURCE:
				this.resource_hist.push(hist);
				this.resource_hist_kv[hist.tracker.key] = hist;
				break;
			case HIST_TYPE.METRIC:
				this.metric_hist.push(hist);
				this.metric_hist_kv[hist.tracker.key] = hist;
				break;
		}
		return hist;
	}

	/**
	 * Add shed (vectors) to this site
	 */
	addShed(
		origin: Site | null,
		key: string | null,
		amount_shed: number,
		vectors: unknown[],
		vector_keys: string[],
		traits: unknown[],
		trait_keys: string[],
		cures: unknown[],
		cure_keys: string[],
		seek: unknown[],
		precise: number,
		relevant_clusters: unknown[]
	): ShedLike | null {
		if (!createShed) {
			console.error('Shed factory not set');
			return null;
		}

		if (key) {
			const existing = this.shed_keys[key];
			if (existing && !origin) {
				existing.amount += amount_shed;
				return existing;
			}
		}

		const shed = createShed(
			origin, key, amount_shed, vectors, vector_keys,
			traits, trait_keys, cures, cure_keys,
			seek, precise, relevant_clusters
		);

		this.shed.push(shed);
		if (key) {
			this.shed_keys[key] = shed;
		}
		return shed;
	}

	/**
	 * Deposit a population-generated Transmit shed, exporting the ranged
	 * share along this site's routes first. Called by the shed-amount batch
	 * (SHED_KIND_TRANSMIT) instead of addShed directly.
	 *
	 * Share model: the pool splits between "stay home" (weight 1) and each
	 * route (weight `strength`), so route r carries
	 * `ranged × strength_r / (1 + Σ strengths)` of the amount. Exported
	 * shares are queued on the World and delivered to the far site at the
	 * next day boundary (one day of travel per hop). Delivered sheds do NOT
	 * re-export — multi-hop spread happens organically, by infecting the
	 * intermediate site's populations, which then shed with their own range.
	 */
	depositTransmitShed(src: TransmitSourceLike, amount: number): void {
		const ranged = src.ranged ?? 0;
		if (ranged > 0 && this.routes.length > 0) {
			let strengthSum = 0;
			for (const r of this.routes) strengthSum += r.route.strength;
			if (strengthSum > 0) {
				const pool = amount * Math.min(ranged, 1);
				const denom = 1 + strengthSum;
				for (const r of this.routes) {
					const share = pool * (r.route.strength / denom);
					if (share > 0) this.world.queueCrossSiteShed(this, r.other, src, share);
				}
				amount -= pool * (strengthSum / denom);
			}
		}
		if (amount <= 0 || isNaN(amount)) return;
		this.addShed(
			null, src.key, amount,
			src.vectors, src.vector_keys,
			src.traits, src.trait_keys,
			src.cures, src.cure_keys,
			src.seek, src.precise as unknown as number,
			src.relevant_clusters as unknown[],
		);
	}

	/** No-op in headless mode; legacy implementation also empty (script.js:7301). */
	updateDisplay(): void { }

	/**
	 * Per-day site history update. Mirrors legacy script.js:7398-7433.
	 * Walks trait/resource/metric histories, syncs stockpile values into
	 * the resource_hist, evaluates metric expressions, and clears the shed
	 * list (which is also drained by updateContact — this is belt and
	 * braces).
	 */
	updateLocalHistory(): void {
		for (const hist of this.trait_hist) {
			(hist as unknown as { addCurrentVal(): void }).addCurrentVal?.();
		}

		for (const stockpile of this.local_stockpiles) {
			const sp = stockpile as unknown as {
				resource: { key: string };
				value: number;
				value_inc: number;
				value_dec: number;
			};
			const hist = this.resource_hist_kv[sp.resource.key];
			if (hist) {
				const h = hist as unknown as {
					started: boolean;
					current: number;
					current_inc: number;
					current_dec: number;
					startRecord(): void;
				};
				if (sp.value !== 0 && !isNaN(sp.value) && !h.started) h.startRecord();
				h.current = sp.value;
				h.current_inc = sp.value_inc;
				h.current_dec = sp.value_dec;
			} else {
				console.error('Could not find local hist for stockpile', sp);
			}
			sp.value_inc = sp.value_dec = 0;
		}

		for (const hist of this.resource_hist) {
			(hist as unknown as { addCurrentVal?(): void }).addCurrentVal?.();
		}

		for (const hist of this.metric_hist) {
			const h = hist as unknown as {
				tracker: { metric?: { expression: { evaluate(site: unknown, age: number): number } } };
				current: number;
				current_inc: number;
				current_dec: number;
				addCurrentVal?(): void;
			};
			const expr = h.tracker.metric?.expression;
			if (!expr) continue;
			const current = expr.evaluate(this, this.world.age);
			if (current > h.current) h.current_inc += current - h.current;
			else h.current_dec += h.current - current;
			h.current = current;
			h.addCurrentVal?.();
		}

		this.shed = [];
		this.shed_keys = {};
	}

	getTitle(): string {
		if (this.name !== '') return this.name;
		if (this.key !== '') return this.key;
		return "Untitled Site";
	}

	/**
	 * Update transmission for a phase
	 */
	async updateTransmission(phase_index: number): Promise<void> {
		const stopAll = profiler.start('Site.updateTransmission');
		// Create primary subpops
		const stopPrimary = profiler.start('Site.updateTransmission/createPrimarySubpop');
		for (let i = this.pops.length - 1; i >= 0; i--) {
			this.pops[i].createPrimarySubpop();
		}
		stopPrimary();

		// Apply pending transmissions
		const pending = this.shed_pending_phases[phase_index] as Array<{
			origin: unknown;
			transmit: {
				key: string;
				vectors: unknown[];
				vector_keys: string[];
				traits: unknown[];
				trait_keys: string[];
				cures: unknown[];
				cure_keys: string[];
				seek: unknown[];
				precise: number;
				relevant_clusters: unknown[];
			};
			amount_shed: number;
		}>;

		for (let i = pending.length - 1; i >= 0; i--) {
			const p = pending[i];
			const t = p.transmit;
			this.addShed(
				p.origin as Site,
				t.key,
				p.amount_shed,
				t.vectors,
				t.vector_keys,
				t.traits,
				t.trait_keys,
				t.cures,
				t.cure_keys,
				t.seek,
				t.precise,
				t.relevant_clusters
			);
		}

		this.shed_pending_phases[phase_index] = [];

		// Phase 1: each Population pushes its shed-amount work for this phase
		// onto `this.pendingShedItems` rather than computing inline. This
		// lets us batch the entire site's shed math for one GPU dispatch.
		this.pendingShedItems = [];
		const stopGather = profiler.start('Site.updateTransmission/gatherPopShed');
		for (let i = this.pop_phases[phase_index].length - 1; i >= 0; i--) {
			await this.pop_phases[phase_index][i].updateTransmission(phase_index);
		}
		stopGather();

		// Phase 2: drain the batch.
		const stopShed = profiler.start('Site.updateTransmission/runShedAmountBatch');
		await runShedAmountBatch({
			items: this.pendingShedItems,
			seed: (this.system.rand as { getSeed(): number }).getSeed(),
			day: this.world.age,
			phase: phase_index,
			gpuKernel: this.world.shedAmountKernel,
			gpuPopState: (this.world as unknown as { gpuPopState: import('../../sim/gpu/GpuPopState').GpuPopState | null }).gpuPopState,
		});
		stopShed();
		this.pendingShedItems = [];
		stopAll();
	}

	/**
	 * Compute progression and shed-borne contact deltas.
	 *
	 * Snapshot semantics: every population's `pop` and primary subpop are
	 * frozen at phase start by `createPrimarySubpop`. Within this method
	 * we only emit entries to `delta` — no mutation of subpops, populations,
	 * or world state happens here. The order in which we walk sheds and
	 * populations does not affect the final result. Mutation occurs once
	 * per phase via `applyPhaseDelta` (typically driven by World).
	 */
	async updateContact(delta: PhaseDelta, seed: number, day: number, phase: number): Promise<void> {
		const stopAll = profiler.start('Site.updateContact');
		const pops = this.pops;
		const sheds = this.shed;

		// Each population's progression sheds: emit deltas, don't mutate.
		const stopProg = profiler.start('Site.updateContact/applyProgression');
		for (let i = pops.length - 1; i >= 0; i--) {
			pops[i].applyProgressionToDelta(delta);
		}
		stopProg();

		if (sheds.length === 0) {
			this.shed = [];
			this.shed_keys = {};
			stopAll();
			return;
		}

		// Rest detection (grand-dream step 3): a shed aimed at anyone it
		// could still change is LATENT activity even if today's day-keyed
		// rounding realizes zero conversions — the WASM contact path
		// pre-rounds sub-unit expectations, so the delta alone can't see
		// them. Conservative: ignores seek/contact modifiers that might
		// zero the actual probability.
		const restWorld = this.world as unknown as { notePotentialConversions?: () => void };
		if (restWorld.notePotentialConversions) {
			outer: for (const shed of sheds) {
				if (!(shed.amount > 0)) continue;
				for (const pop of pops) {
					if (pop.pop <= 0) continue;
					const keys = pop.syndrome.trait_keys;
					for (const t of shed.trait_keys) {
						if (keys.indexOf(t) === -1) { restWorld.notePotentialConversions(); break outer; }
					}
					for (const c of shed.cure_keys) {
						if (keys.indexOf(c) !== -1) { restWorld.notePotentialConversions(); break outer; }
					}
				}
			}
		}

		// Build the seekMod input as parallel typed arrays. Pre-allocate at
		// maxPairs = sheds × pops; the loop below only fills slots for
		// non-empty pops and passes `pairCount` (the populated length)
		// downstream. We now store `popId` per pair (not the syndrome mask) —
		// the kernel reads the mask out of `GpuPopState.popMaskBuffer` and
		// the CPU fallback reads it via `populations_by_id[popId].syndrome`.
		const stopPairs = profiler.start('Site.updateContact/buildPairs');
		const maxPairs = sheds.length * pops.length;
		const seekPairShedIdx = new Uint32Array(maxPairs);
		const seekPairPopIdx = new Uint32Array(maxPairs);
		const seekPairPopId = new Uint32Array(maxPairs);
		let seekPairCount = 0;
		for (let s = 0; s < sheds.length; s++) {
			for (let p = 0; p < pops.length; p++) {
				const popObj = pops[p];
				if (popObj.pop <= 0) continue;
				seekPairShedIdx[seekPairCount] = s;
				seekPairPopIdx[seekPairCount] = p;
				seekPairPopId[seekPairCount] = popObj.id >>> 0;
				seekPairCount++;
			}
		}
		stopPairs();

		if (seekPairCount === 0) {
			this.shed = [];
			this.shed_keys = {};
			stopAll();
			return;
		}

		const worldRef = this.world as unknown as {
			traits_kv: Record<string, { index: number } | undefined>;
			populations_by_id: ReadonlyArray<{ id: number; syndrome: { trait_mask: Uint32Array } } | null | undefined>;
			gpuPopState: import('../../sim/gpu/GpuPopState').GpuPopState | null;
		};

		const stopSeek = profiler.start('Site.updateContact/seekMod');
		const seekMods = await runSeekModBatch({
			world: worldRef,
			populations: worldRef.populations_by_id,
			gpuPopState: worldRef.gpuPopState,
			sheds: sheds as never,
			pairCount: seekPairCount,
			pairShedIdx: seekPairShedIdx,
			pairPopId: seekPairPopId,
			gpuKernel: this.world.seekModKernel,
		});
		stopSeek();

		// Phase A: weighted_total per shed.
		const stopAlloc = profiler.start('Site.updateContact/allocPairs');
		const weightedTotal = new Float64Array(sheds.length);
		for (let i = 0; i < seekPairCount; i++) {
			const wm = seekMods[i];
			if (wm === 0) continue;
			weightedTotal[seekPairShedIdx[i]] += pops[seekPairPopIdx[i]].pop * wm;
		}

		// Phase B: build the applyShed batch as parallel arrays. Skip pairs
		// that allocated zero work (saves the kernel from processing dead
		// entries). Pre-allocate at seekPairCount; the actual count is
		// tracked in applyPairCount.
		//
		// We also pre-flatten the per-pair pop id, source SubSyndrome id, and
		// `shed.precise` flag into typed arrays here, because each property
		// access in this loop runs once but the equivalent access inside
		// applyShedBatch's pre-pass loop runs once per *pair* in a tight
		// JIT-sensitive loop. Hoisting these out of the hot path
		// significantly speeds up the pre-pass.
		const applyPairShedIdx = new Uint32Array(seekPairCount);
		const applyPairSynIdx = new Uint32Array(seekPairCount);
		const applyPairVectorCount = new Float32Array(seekPairCount);
		const applyPairPops: typeof pops = new Array(seekPairCount);
		const applyPairSheds: typeof sheds = new Array(seekPairCount);
		const applyPairPopId = new Uint32Array(seekPairCount);
		const applyPairSourceId = new Uint32Array(seekPairCount);
		const applyPairPrecise = new Uint8Array(seekPairCount);
		let applyPairCount = 0;
		const syndromes: SyndromeLike[] = [];
		const syndromeIndexOf = new Map<SyndromeLike, number>();
		for (let i = 0; i < seekPairCount; i++) {
			const wm = seekMods[i];
			if (wm === 0) continue;
			const shedIdx = seekPairShedIdx[i];
			const total = weightedTotal[shedIdx];
			if (total === 0) continue;
			const popObj = pops[seekPairPopIdx[i]];
			const shed = sheds[shedIdx];
			const amount = shed.amount * (popObj.pop * wm) / total;
			if (amount <= 0) continue;
			let synIdx = syndromeIndexOf.get(popObj.syndrome);
			if (synIdx === undefined) {
				synIdx = syndromes.length;
				syndromes.push(popObj.syndrome);
				syndromeIndexOf.set(popObj.syndrome, synIdx);
			}
			applyPairShedIdx[applyPairCount] = shedIdx;
			applyPairSynIdx[applyPairCount] = synIdx;
			applyPairVectorCount[applyPairCount] = amount;
			applyPairPops[applyPairCount] = popObj;
			applyPairSheds[applyPairCount] = shed;
			applyPairPopId[applyPairCount] = popObj.id >>> 0;
			applyPairSourceId[applyPairCount] = popObj.primary_subsyndrome.id >>> 0;
			applyPairPrecise[applyPairCount] = shed.precise ? 1 : 0;
			applyPairCount++;
		}
		stopAlloc();

		const stopApply = profiler.start('Site.updateContact/applyShed');
		await runApplyShedBatch({
			world: this.world as never,
			site: this as never,
			sheds: sheds as never,
			syndromes: syndromes as never,
			pairCount: applyPairCount,
			pairShedIdx: applyPairShedIdx,
			pairSynIdx: applyPairSynIdx,
			pairVectorCount: applyPairVectorCount,
			pairPops: applyPairPops as never,
			pairSheds: applyPairSheds as never,
			pairPopId: applyPairPopId,
			pairSourceId: applyPairSourceId,
			pairPrecise: applyPairPrecise,
			delta,
			gpuKernel: this.world.applyShedKernel,
			seed,
			day,
			phase,
		});
		stopApply();

		this.shed = [];
		this.shed_keys = {};
		stopAll();
	}

	/**
	 * Reconcile each population's subpops back into site-level populations.
	 * Mirrors legacy script.js:7387-7391.
	 */
	async updatePopulations(): Promise<void> {
		const stop = profiler.start('Site.updatePopulations');
		for (let i = this.pops.length - 1; i >= 0; i--) {
			await this.pops[i].updatePopulations();
		}
		stop();
	}

	/**
	 * Record per-population history values for the day.
	 * Mirrors legacy script.js:7392-7396.
	 */
	async updatePopulationsHistory(): Promise<void> {
		for (let i = this.pops.length - 1; i >= 0; i--) {
			await this.pops[i].updatePopulationsHistory();
		}
	}

	/**
	 * Build the site's starting population and apply scenario-defined initial
	 * contacts. Mirrors legacy script.js:7131-7252, adapted for the
	 * snapshot+delta model (Phase A): instead of mutating subpops directly,
	 * initial sheds are emitted into a PhaseDelta which World.applyPhaseDelta
	 * drains. Called once per site by World.start.
	 */
	async initPopulation(): Promise<void> {
		const rand = this.system.rand;
		if (this.pop > 0) {
			this.graph_height = this.pop;

			if (this.startpops.length > 0) {
				// Distribute the site's total population across declared
				// startpops in proportion to their relative `size` field.
				const synkeys: string[] = [];
				const relsizes: number[] = [];
				const sizes: number[] = [];
				const extra_bits: number[] = [];
				let total_size = 0;
				let total_added = 0;
				let total_extra = 0;

				for (const startpop of this.startpops) {
					const apply = ((startpop as unknown as { apply: string[] }).apply ?? []).slice().sort();
					const syn = this.world.getSyndrome(apply);
					const ind = synkeys.indexOf(syn.key);
					const startSize = (startpop as unknown as { size: number }).size;
					if (ind === -1) {
						synkeys.push(syn.key);
						relsizes.push(startSize);
					} else {
						relsizes[ind] += startSize;
					}
					total_size += startSize;
				}

				for (let i = 0; i < synkeys.length; i++) {
					const relsize = relsizes[i] / total_size;
					const adding = Math.floor(relsize * this.pop);
					const extra = relsize * this.pop - adding;
					sizes.push(adding);
					extra_bits.push(extra);
					total_added += adding;
					total_extra += extra;
				}

				// Distribute the floor()-rounding remainder by weighted RNG.
				const remainder = this.pop - total_added;
				for (let r = 0; r < remainder; r++) {
					const target = rand.get() * total_extra;
					let acc = 0;
					for (let j = 0; j < extra_bits.length; j++) {
						acc += extra_bits[j];
						if (acc >= target) {
							sizes[j] += 1;
							break;
						}
					}
				}

				let pop_added = 0;
				for (let i = 0; i < synkeys.length; i++) {
					const syndrome = (this.world as unknown as { syndromes_kv: Record<string, SyndromeLike> }).syndromes_kv[synkeys[i]];
					this.addPop(sizes[i], syndrome);
					pop_added += sizes[i];
				}
				if (pop_added !== this.pop) {
					console.error(`Site population mismatch: added ${pop_added} into site of ${this.pop}`);
				}
			} else {
				this.addPop(this.pop, this.world.getSyndrome([]));
			}
		}

		for (let i = this.pops.length - 1; i >= 0; i--) {
			this.pops[i].createPrimarySubpop();
		}
		await this.updatePopulations();

		// Initial contact: each trait with prob > 0 produces a Shed against
		// the site's full population. Emit the sheds, run updateContact into
		// a fresh PhaseDelta, then drain via World.applyPhaseDelta.
		for (const trait of this.world.traits) {
			if (trait.prob > 0) {
				const amount_shed = trait.prob * this.pop;
				this.addShed(
					null, null, amount_shed,
					[], [],
					[], [trait.key],
					[], [],
					[], 1,
					this.world.blank_cluster_array as never
				);
			}
		}
		await this.runContactAndApply(0);
		await this.updatePopulations();

		// Run any scenario-declared starting transmissions (Site.transmit) per
		// phase, in the same snapshot+delta loop.
		const allPhases = this.world.all_phases as Array<{ index?: number }>;
		for (let p = 0; p < allPhases.length; p++) {
			for (let i = this.pops.length - 1; i >= 0; i--) {
				this.pops[i].createPrimarySubpop();
			}
			for (const t of this.transmit) {
				const tx = t as unknown as {
					key: string;
					phase_index: number;
					value: number;
					popmult: boolean;
					vector: string[];
					apply: string[];
					remove: string[];
					relevant_clusters: unknown[];
				};
				if (tx.phase_index !== p) continue;
				let amount_shed = tx.value;
				if (tx.popmult) amount_shed *= this.pop;
				const vectors: VectorLike[] = [];
				const seek: unknown[] = [];
				for (const vk of tx.vector ?? []) {
					const vector = this.world.getVector(stringVal(vk, ''));
					vectors.push(vector);
					for (const s of vector.seek ?? []) seek.push(s);
				}
				const traits: TraitLike[] = [];
				for (const tk of tx.apply ?? []) traits.push(this.world.getTrait(stringVal(tk, '')));
				// Pass tx.key through so Syndrome.getContactMod composes contact_mod
				// modifiers from prob-init-applied traits.
				// prob-init below stays keyless on purpose — that path is the
				// scenario-author's "seed this fraction" knob and should not be
				// gated by modifiers.
				this.addShed(
					null, tx.key, amount_shed,
					vectors, tx.vector ?? [],
					traits, tx.apply ?? [],
					[], tx.remove ?? [],
					seek, 1,
					tx.relevant_clusters as never
				);
			}
			await this.runContactAndApply(p + 1);
			await this.updatePopulations();
		}

		await this.updatePopulationsHistory();
	}

	/**
	 * Helper for initPopulation: run updateContact into a fresh delta and
	 * apply it via World.applyPhaseDelta. The synthetic phase index makes
	 * the RNG draws deterministic and disjoint from real-day draws.
	 */
	private async runContactAndApply(syntheticPhase: number): Promise<void> {
		// Phase-1 prerequisite: the GPU kernels we're about to dispatch in
		// `updateContact` read pop_count + pop_mask from GpuPopState. During
		// regular days World.updateAllPhases refreshes that mirror at the top
		// of every phase, but initPopulation runs *before* the first newDay
		// and calls us directly — without this upload the kernels would read
		// uninitialized GPU memory (whatever happened to be at that address),
		// producing wrong seed values that change run-to-run.
		const w = this.world as unknown as { gpuPopState: import('../../sim/gpu/GpuPopState').GpuPopState | null; populations_by_id: ReadonlyArray<unknown> };
		w.gpuPopState?.uploadFromPopulations(w.populations_by_id as never);
		const delta = new PhaseDelta();
		const seed = this.system.rand.getSeed();
		await this.updateContact(delta, seed, -1 >>> 0, syntheticPhase);
		this.world.applyPhaseDelta(delta, seed, -1, syntheticPhase);
	}

	destroy(): void {
		super.destroy();
		removeFrom((this.parent as unknown as { sites: Site[] }).sites, this);
	}
}

export default Site;
