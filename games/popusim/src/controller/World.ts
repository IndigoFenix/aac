/**
 * World - Game world orchestrator
 * Manages all game objects, phases, and simulation logic
 */

import { HIST_TYPE, VALUE_TYPE, VALUE_SUBTYPE } from '../types/constants';
import { BWObj } from '../core/BWObj';
import { BColor } from '../core/BColor';
import { boolVal, intVal, parseChildren, parseColor, strVal } from '../core/parse';
import { removeFrom, removeFromWhere, appendElement, setRootStyle, removeListeners } from '../core/utils';
import { SubSyndrome } from '../game/simulation/SubSyndrome';
import { PhaseDelta } from '../game/simulation/PhaseDelta';
import { hashUniform, rngStream } from '../core/HashRand';
import { MASK_WORDS, buildTraitMask, subSyndromeKey } from '../sim/gpu/traitMask';
import { SubSyndromeRegistry } from '../sim/gpu/SubSyndromeRegistry';
import { profiler } from '../core/Profiler';
// Concrete child types — required as objType in the BWObj loader so child
// arrays (traits, vectors, sites, etc.) are instantiated as their proper
// classes when a scenario is loaded. None of these import from controller,
// so there's no cycle.
import { Trait } from '../game/traits/Trait';
import { Vector } from '../game/transmission/Vector';
import { Site } from '../game/world/Site';
import { Route } from '../game/world/Route';
import { Resource } from '../game/resources/Resource';
import { PlayerAction } from '../game/actions/PlayerAction';
import { GUIGroup } from '../game/organization/GUIGroup';
import { Phase } from '../game/organization/Phase';
import { Event as GameEvent } from '../game/events/Event';
import { TrackerCalc } from '../game/tracking/Tracker';
import { Expression, ExpressionValue } from '../game/tracking/Expression';
import { CustomMetric, type SerializedExprValue, type TrackerCalcSpec } from '../game/tracking/CustomMetric';
import type {
	WorldLike, SystemLike, SiteLike, TraitLike, VectorLike, ResourceLike,
	PlayerActionLike, ActionCostLike, StockpileLike, SyndromeLike, TrackerLike, HistoryLike,
	IndexedPhaseLike, GUIGroupLike, EventLike, FilterLike, TransmitLike,
	ProgressLike, ImpactLike, ClusterLike, MetricLike, ExpressionLike,
	ExpressionValueLike, GUIBoxLike, PopulationLike
} from './interfaces';

// Forward references and factories
interface EventHandlerLike {
	// Event handler placeholder
}

// Factory functions
let createVector: ((world: World, data: Record<string, unknown>) => VectorLike) | null = null;
let createTrait: ((world: World, data: Record<string, unknown>) => TraitLike) | null = null;
let createSite: ((world: World, data: Record<string, unknown>) => SiteLike) | null = null;
let createResource: ((world: World, data: Record<string, unknown>) => ResourceLike) | null = null;
let createPlayerAction: ((world: World, data: Record<string, unknown>) => PlayerActionLike) | null = null;
let createStockpile: ((resource: ResourceLike, parent: World | SiteLike, value: number) => StockpileLike) | null = null;
let createSyndrome: ((world: World, traits: TraitLike[], key: string) => SyndromeLike) | null = null;
let createTracker: ((world: World, obj: TraitLike | ResourceLike | MetricLike) => TrackerLike) | null = null;
let createHistory: ((parent: World | SiteLike, tracker: TrackerLike) => HistoryLike) | null = null;
let createIndexedPhase: ((world: World, key: string, index: number) => IndexedPhaseLike) | null = null;
let createGUIGroup: ((world: World, data: Record<string, unknown>) => GUIGroupLike) | null = null;
let createFilter: ((key: string, required: TraitLike[], forbidden: TraitLike[]) => FilterLike) | null = null;
let createCluster: ((trait: TraitLike, level: number) => ClusterLike) | null = null;
let createExpression: ((world: World, values: ExpressionValueLike[]) => ExpressionLike) | null = null;
let createExpressionValue: ((world: World, type: string, subtype: string | null, value: unknown) => ExpressionValueLike) | null = null;
let createCustomMetric: ((world: World, data: Record<string, unknown>) => CustomMetric) | null = null;

export function setWorldDependencies(deps: {
	createVector?: typeof createVector;
	createTrait?: typeof createTrait;
	createSite?: typeof createSite;
	createResource?: typeof createResource;
	createPlayerAction?: typeof createPlayerAction;
	createStockpile?: typeof createStockpile;
	createSyndrome?: typeof createSyndrome;
	createTracker?: typeof createTracker;
	createHistory?: typeof createHistory;
	createIndexedPhase?: typeof createIndexedPhase;
	createGUIGroup?: typeof createGUIGroup;
	createFilter?: typeof createFilter;
	createCluster?: typeof createCluster;
	createExpression?: typeof createExpression;
	createExpressionValue?: typeof createExpressionValue;
	createCustomMetric?: typeof createCustomMetric;
}): void {
	if (deps.createVector) createVector = deps.createVector;
	if (deps.createTrait) createTrait = deps.createTrait;
	if (deps.createSite) createSite = deps.createSite;
	if (deps.createResource) createResource = deps.createResource;
	if (deps.createPlayerAction) createPlayerAction = deps.createPlayerAction;
	if (deps.createStockpile) createStockpile = deps.createStockpile;
	if (deps.createSyndrome) createSyndrome = deps.createSyndrome;
	if (deps.createTracker) createTracker = deps.createTracker;
	if (deps.createHistory) createHistory = deps.createHistory;
	if (deps.createIndexedPhase) createIndexedPhase = deps.createIndexedPhase;
	if (deps.createGUIGroup) createGUIGroup = deps.createGUIGroup;
	if (deps.createFilter) createFilter = deps.createFilter;
	if (deps.createCluster) createCluster = deps.createCluster;
	if (deps.createExpression) createExpression = deps.createExpression;
	if (deps.createExpressionValue) createExpressionValue = deps.createExpressionValue;
	if (deps.createCustomMetric) createCustomMetric = deps.createCustomMetric;
}

/** A deterministically sampled individual (grand-dream §6): drawn from a
 * site's syndrome distribution, with SCALAR traits bridged from local
 * prevalences. Same (world seed, site, index) ⇒ the same villager, with no
 * storage — until pinned. */
export interface HistfigSample {
	siteKey: string;
	index: number;
	/** Deterministic syllable name — flavor, stable per (site, index). */
	name: string;
	/** The binary syndrome this person was drawn from. */
	syndromeKey: string;
	traitKeys: string[];
	/** Scalar in [0,1) per non-combo trait. Carriers ≥ 0.5, non-carriers
	 * < 0.5 (so an untouched release re-bins to the origin syndrome), both
	 * pulled toward the local prevalence with individual variance. */
	scalars: Record<string, number>;
}

/** A pinned individual — persistent, outside the aggregate accounting. */
export interface Histfig extends HistfigSample {
	id: number;
	role: string;
}

/**
 * World class - Game world orchestrator
 */
export class World extends BWObj implements WorldLike {
	system: SystemLike;
	declare data: Record<string, unknown>;
	el: HTMLElement;

	// State flags
	closing: boolean = false;
	initialized: boolean = false;
	loaded: boolean = false;
	setting_up: boolean = false;
	scenario_complete: boolean = false;
	scenario_victory: boolean = false;
	has_tracked_trait: boolean = false;

	// Timing
	age: number = 0;
	render_age: number = 0;
	start_timestamp: number = 0;
	graph_height: number = 0;

	// Configuration (from attrs)
	name: string = 'My Scenario';
	start_age: number = 0;
	use_date: boolean = true;
	start_date: string = '';
	day_string: string = 'Day';
	news_string: string = 'NEWS';
	color_primary: BColor = new BColor(null, { value: '0,128,255,1' });
	color_secondary: BColor = new BColor(null, { value: '255,0,0,1' });
	color_light: BColor = new BColor(null, { value: '255,255,255,1' });
	color_dark: BColor = new BColor(null, { value: '0,0,0,1' });

	// GPU acceleration. Wired by WorkerSim.boot when WebGPU is available;
	// null otherwise. Site.updateTransmission and Site.updateContact read
	// these to decide whether to dispatch on GPU or run the CPU fallback.
	shedAmountKernel: import('../sim/gpu/shedAmountKernel').ShedAmountKernel | null = null;
	seekModKernel: import('../sim/gpu/seekModKernel').SeekModKernel | null = null;
	applyShedKernel: import('../sim/gpu/applyShedKernel').ApplyShedKernel | null = null;
	/** GPU-resident population state (pop_count / pop_mask) — non-null when
	 * WebGPU is available, plus a CPU staging mirror always populated. The
	 * batch wrappers consult this when running kernels instead of uploading
	 * per-pair pop state. Refreshed at the top of each phase. */
	gpuPopState: import('../sim/gpu/GpuPopState').GpuPopState | null = null;

	/** Monotonic counter used by Syndrome to assign txKindId to each new
	 * SynTransmit / SynImpact. Read/written via the WorldLike interface in
	 * Syndrome.ts so the typing stays loose. */
	next_syn_id: number = 0;

	// Child objects (from attrs)
	traits: TraitLike[] = [];
	vectors: VectorLike[] = [];
	sites: SiteLike[] = [];
	routes: Route[] = [];
	actions: PlayerActionLike[] = [];
	resources: ResourceLike[] = [];
	events: EventLike[] = [];
	phases: Array<{ key: string }> = [];
	guigroups: GUIGroupLike[] = [];

	// Lookup maps
	traits_kv: Record<string, TraitLike> = {};
	vectors_kv: Record<string, VectorLike> = {};
	resources_kv: Record<string, ResourceLike> = {};
	actions_kv: Record<string, PlayerActionLike> = {};
	syndromes_kv: Record<string, SyndromeLike> = {};
	/** SubSyndrome registry indexed by trait bitmask via a 4-level nested Map
	 * (one Map per `MASK_WORDS` u32 word). Replaced an earlier
	 * `Map<string, SubSyndrome>` keyed by `subSyndromeKey(mask)` — at scale
	 * (175k+ lookups per phase) the per-call string allocation in
	 * `subSyndromeKey` plus the string-hash Map.get dominated the post-pass.
	 * Walking 4 number-keyed Maps is ~2-3× faster and allocates nothing on
	 * the lookup path.
	 *
	 * Inner Maps are allocated lazily on first miss for that mask-prefix
	 * Now backed by `SubSyndromeRegistry`, a flat open-addressing hash table
	 * on TypedArrays — avoids per-insert intermediate-Map allocations and
	 * collapses the 4-deep walk into a single typed-array probe. The
	 * `subsyndromes_kv` name is kept for backwards compat with reads. */
	subsyndromes_kv: SubSyndromeRegistry = new SubSyndromeRegistry();
	/** Stable integer-id index parallel to subsyndromes_kv. Index in this array equals SubSyndrome.id. */
	subsyndromes_by_id: SubSyndrome[] = [];
	/** Stable integer-id index for Population. Index equals Population.id. */
	populations_by_id: PopulationLike[] = [];
	/** Stable integer-id index for Stockpile. Index equals Stockpile.id. */
	stockpiles_by_id: StockpileLike[] = [];
	guigroups_kv: Record<string, GUIGroupLike> = {};
	filters_kv: Record<string, FilterLike> = {};
	all_phases_kv: Record<string, IndexedPhaseLike> = {};

	// Collections
	syndromes: SyndromeLike[] = [];
	trackers: TrackerLike[] = [];
	global_actions: PlayerActionLike[] = [];
	global_actions_kv: Record<string, PlayerActionLike> = {};
	local_actions: PlayerActionLike[] = [];
	all_actions: PlayerActionLike[] = [];
	global_stockpiles: StockpileLike[] = [];
	global_stockpiles_kv: Record<string, StockpileLike> = {};
	all_stockpiles: StockpileLike[] = [];
	all_transmit: TransmitLike[] = [];
	all_progress: ProgressLike[] = [];
	all_phases: IndexedPhaseLike[] = [];
	filters: FilterLike[] = [];
	clusters: ClusterLike[][] = [];
	blank_cluster_array: unknown[] = [];

	// Tracker lookups
	trait_trackers_kv: Record<string, TrackerLike> = {};
	resource_trackers_kv: Record<string, TrackerLike> = {};
	metric_trackers_kv: Record<string, TrackerLike> = {};

	// History
	trait_hist: HistoryLike[] = [];
	trait_hist_kv: Record<string, HistoryLike> = {};
	resource_hist: HistoryLike[] = [];
	resource_hist_kv: Record<string, HistoryLike> = {};
	metric_hist: HistoryLike[] = [];
	metric_hist_kv: Record<string, HistoryLike> = {};

	// Trait organization
	base_traits: TraitLike[] = [];
	combo_traits: TraitLike[] = [];
	ordered_traits: TraitLike[] = [];
	auto_combos: TraitLike[] = [];
	gui_elements: unknown[] = [];

	// Custom metrics/traits
	custom_metrics: MetricLike[] = [];
	custom_traits: unknown[] = [];
	custom_metrics_index: number = 0;
	custom_traits_index: number = 0;
	custom_metrics_prev?: MetricLike[];
	custom_traits_prev?: unknown[];

	// Runtime
	default_phase!: IndexedPhaseLike;
	news_pending: unknown[] = [];
	eventhandler: EventHandlerLike = {};
	allSitesButton: HTMLElement | null = null;

	/** Cross-site shed packets accumulated during the day by
	 * Site.depositTransmitShed, aggregated by (dest, transmit, origin) so
	 * the result is independent of within-day write order. Delivered as
	 * PendingTransmissions at the next day boundary (one day per hop). */
	cross_site_pending: Map<string, {
		origin: SiteLike;
		dest: SiteLike;
		transmit: { key: string; phase_index: number };
		amount_shed: number;
	}> = new Map();

	// --- Composition rest detection (grand-dream step 3) -------------------
	// A completed day is a FIXED POINT when nothing changed (expected OR
	// realized), the cross-site queue is identical to the previous day's,
	// no events remain armed, and no day-keyed fractional draws exist that
	// could realize differently on a future day. From a fixed point, every
	// subsequent quiet day is bit-identical, so skipDays(n) === stepping n
	// days (minus history rows). See isCompositionAtRest().

	/** ε for the activity/state measures. 0 = exact rest (default). Raising
	 * it trades accuracy for earlier rest (the civilization.md-sanctioned
	 * "sd frozen while away" trade). */
	rest_eps: number = 0;
	/** Σ|expected deltas| routed through applyPhaseDelta today. */
	private day_delta_activity: number = 0;
	/** True if today's rate-migration wanted a fractional amount (its
	 * day-keyed rounding could realize differently tomorrow). */
	private day_migration_fractional: boolean = false;
	/** True if any shed today targeted a population it could still change
	 * (latent conversions — set by Site.updateContact). */
	private day_potential_conversions: boolean = false;
	/** External mutation (driven migration, injections) since the last
	 * completed-day observation. */
	private composition_dirty: boolean = false;
	/** Last completed day was observed to be a fixed point. */
	private rest_observed: boolean = false;
	private prev_queue_fp: string | null = null;
	private rest_snap_pops: Float64Array = new Float64Array(0);
	private rest_snap_pop_count: number = 0;
	private rest_snap_stocks: Float64Array = new Float64Array(0);
	private rest_snap_stock_count: number = 0;

	// --- Breakaways (grand-dream step 5, §7) --------------------------------
	// A civilization is a membership trait; secession is a day-boundary
	// event: when the dissenting bloc is big enough (threshold on the
	// fraction of `from`-carriers with `dissent`) AND territorially
	// coherent (cross-site dissimilarity index — a statistically real
	// faction, not diffuse grumbling), every dissent∧from population flips
	// wholesale to `to`. Conditions read ONLY composition state, so an
	// armed breakaway cannot newly fire at a fixed point — unlike events,
	// it needs NO rest-detection guard and skips stay exact.
	breakaways: Array<{
		key: string;
		dissent: string;
		from: string;
		to: string;
		/** Fire when faction / from-carriers ≥ threshold. */
		threshold: number;
		/** ...AND territorial coherence ≥ this (0 = any distribution). */
		coherence: number;
		fired: boolean;
		day_fired: number;
	}> = [];
	/** Log of fired breakaways — the layer above reads this to update its
	 * civ ledger and raise settlement hostility. */
	breakaways_fired: Array<{ key: string; day: number; moved: number }> = [];

	// --- Histfigs (grand-dream step 6, §6) -----------------------------------
	// Persistent named individuals living OUTSIDE the aggregate accounting:
	// pinning subtracts one person from their home Population, so the world
	// invariant becomes  Σ pops + histfigs.length = constant.  Unlike
	// Populations they carry SCALAR traits bridged from local prevalences;
	// releasing bins scalars back to a binary syndrome (threshold 0.5).
	histfigs: Histfig[] = [];
	private next_histfig_id: number = 1;

	constructor(system: SystemLike, data: Record<string, unknown>) {
		super(system as unknown as BWObj, data);
		this.system = system;
		this.data = data;
		this.el = (system as unknown as { el: HTMLElement }).el;
		this.resetValues();
	}

	private parseFromData(): void {
		const d = this.data;
		this.name = strVal(d, 'name', 'My Scenario');
		this.start_age = intVal(d, 'start_age', 0);
		this.use_date = boolVal(d, 'use_date', true);
		this.start_date = strVal(d, 'start_date', '');
		this.day_string = strVal(d, 'day_string', 'Day');
		this.news_string = strVal(d, 'news_string', 'NEWS');
		this.color_primary = parseColor(this, d, 'color_primary', '0,128,255,1');
		this.color_secondary = parseColor(this, d, 'color_secondary', '255,0,0,1');
		this.color_light = parseColor(this, d, 'color_light', '255,255,255,1');
		this.color_dark = parseColor(this, d, 'color_dark', '0,0,0,1');

		this.traits = parseChildren(this, d, 'trait', Trait) as unknown as TraitLike[];
		this.vectors = parseChildren(this, d, 'vector', Vector) as unknown as VectorLike[];
		this.actions = parseChildren(this, d, 'action', PlayerAction) as unknown as PlayerActionLike[];
		this.resources = parseChildren(this, d, 'resource', Resource) as unknown as ResourceLike[];
		this.guigroups = parseChildren(this, d, 'guigroup', GUIGroup) as unknown as GUIGroupLike[];
		this.phases = parseChildren(this, d, 'phase', Phase) as unknown as Array<{ key: string }>;
		this.sites = parseChildren(this, d, 'site', Site) as unknown as SiteLike[];
		this.routes = parseChildren(this, d, 'route', Route);
		this.events = parseChildren(this, d, 'event', GameEvent) as unknown as EventLike[];

		// Breakaways are plain data — no BWObj lifecycle needed.
		this.breakaways = (Array.isArray(d.breakaway) ? d.breakaway as Record<string, unknown>[] : []).map((b, i) => ({
			key: String(b.key ?? `breakaway${i}`),
			dissent: String(b.dissent ?? ''),
			from: String(b.from ?? ''),
			to: String(b.to ?? ''),
			threshold: Number(b.threshold ?? 0.5),
			coherence: Number(b.coherence ?? 0),
			fired: false,
			day_fired: -1,
		}));
	}

	// ========================================
	// Initialization
	// ========================================

	resetValues(): void {
		if (this.loaded) {
			this.destroy();
		}
		if (this.eventhandler) removeListeners(this.eventhandler);
		else this.eventhandler = {};

		// Rest detection restarts from scratch on reset.
		this.rest_observed = false;
		this.composition_dirty = false;
		this.prev_queue_fp = null;
		this.day_delta_activity = 0;
		this.day_migration_fractional = false;
		this.day_potential_conversions = false;

		this.breakaways = [];
		this.breakaways_fired = [];
		this.histfigs = [];
		this.next_histfig_id = 1;
		this.births_total = 0;
		this.deaths_total = 0;

		// Reset all collections
		this.vectors = [];
		this.vectors_kv = {};
		this.traits = [];
		this.traits_kv = {};
		this.sites = [];
		this.routes = [];
		this.cross_site_pending.clear();
		this.syndromes = [];
		this.syndromes_kv = {};
		this.subsyndromes_kv = new SubSyndromeRegistry();
		this.trackers = [];
		this.trait_trackers_kv = {};
		this.resource_trackers_kv = {};
		this.metric_trackers_kv = {};
		this.actions = [];
		this.global_actions = [];
		this.local_actions = [];
		this.all_actions = [];
		this.actions_kv = {};
		this.resources = [];
		this.resources_kv = {};
		this.global_stockpiles = [];
		this.global_stockpiles_kv = {};
		this.all_stockpiles = [];
		this.all_transmit = [];
		this.all_progress = [];
		this.trait_hist = [];
		this.trait_hist_kv = {};
		this.base_traits = [];
		this.gui_elements = [];
		this.combo_traits = [];
		this.ordered_traits = [];
		this.resource_hist = [];
		this.resource_hist_kv = {};
		this.metric_hist = [];
		this.metric_hist_kv = {};
		this.all_phases = [];
		this.all_phases_kv = {};
		this.guigroups = [];
		this.guigroups_kv = {};
		this.filters = [];
		this.filters_kv = {};
		this.auto_combos = [];
		this.age = this.render_age = 0;
		this.start_timestamp = 0;
		this.graph_height = 0;
		this.news_pending = [];
		this.clusters = [];
		this.custom_metrics = [];
		this.custom_traits = [];
		this.custom_metrics_index = this.custom_metrics_index || 0;
		this.custom_traits_index = this.custom_traits_index || 0;
		this.scenario_complete = false;
		this.scenario_victory = false;
		this.allSitesButton = null;
		this.initialized = false;
		this.has_tracked_trait = false;

		this.parseFromData();
		this.loaded = true;
		this.setting_up = false;

		// Update UI colors
		if (this.system.news_box) {
			this.system.news_box.expander.innerHTML = this.news_string;
		}
		setRootStyle('--color-light', this.color_light.getColor());
		setRootStyle('--color-dark', this.color_dark.getColor());
		setRootStyle('--color-primary', this.color_primary.getColor());
		setRootStyle('--color-secondary', this.color_secondary.getColor());
	}

	async start(): Promise<void> {
		this.resetValues();

		// Setup date
		if (this.use_date) {
			if (!this.start_date || this.start_date === "") {
				this.start_timestamp = new Date().getTime();
			} else {
				const parts = this.start_date.split('-');
				const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
				this.start_timestamp = d.getTime();
			}
		} else {
			this.start_timestamp = 0;
		}

		// Initialize default vector and phase
		if (createVector) {
			this.addVector(createVector(this, { key: "" }));
		}

		if (createIndexedPhase) {
			this.default_phase = createIndexedPhase(this, "", 0);
			this.all_phases.push(this.default_phase);
			this.all_phases_kv[""] = this.default_phase;

			for (let i = 0; i < this.phases.length; i++) {
				const phase = createIndexedPhase(this, this.phases[i].key, i + 1);
				this.all_phases.push(phase);
				this.all_phases_kv[this.phases[i].key] = phase;
			}
		}

		// Initialize GUI groups
		for (const guigroup of this.guigroups) {
			this.guigroups_kv[guigroup.key] = guigroup;
		}

		// Initialize traits
		for (let i = 0; i < this.traits.length; i++) {
			const trait = this.traits[i];
			trait.index = i;
			if (trait.tracked) this.has_tracked_trait = true;
			this.traits_kv[trait.key] = trait;
		}

		for (const trait of this.traits) {
			trait.init();
		}

		for (const trait of this.traits) {
			trait.evaluatePrimaries();
			if (trait.is_combo && !trait.illegal && trait.primaries.require.length === 0) {
				this.auto_combos.push(trait);
			}
		}

		for (const trait of this.traits) {
			trait.evaluateCombos();
		}

		this.initCombos();

		// Initialize vectors. The integer index doubles as the bit position
		// in the 64-bit vector_mask used by GPU kernel inputs.
		for (let i = 0; i < this.vectors.length; i++) {
			const vector = this.vectors[i];
			(vector as unknown as { index: number }).index = i;
			this.vectors_kv[vector.key] = vector;
			vector.init();
		}

		// Initialize resources
		for (const resource of this.resources) {
			this.resources_kv[resource.key] = resource;
			if (resource.global) {
				this.addGlobalStockpile(resource);
			}
		}

		// Initialize actions
		this.global_actions = [];
		this.global_actions_kv = {};
		this.local_actions = [];

		for (const action of this.actions) {
			// actions_kv is the world-level lookup used by expression
			// evaluators (e.g. set_stats event references actions by key).
			// Both global and local actions live here. Global actions also
			// appear in global_actions_kv for the world's runtime collections.
			this.actions_kv[action.key] = action;
			if (action.global) {
				this.global_actions.push(action);
				this.global_actions_kv[action.key] = action;
				this.all_actions.push(action);
				action.init();
			} else {
				this.local_actions.push(action);
			}
		}

		// Initialize trait sub-objects
		for (const trait of this.traits) {
			trait.initSubObjects();
		}

		// Initialize sites
		for (const site of this.sites) {
			site.init();
			site.initLocalStockpiles();
			site.initLocalActions();
			this.graph_height += site.graph_height;
		}

		// Initialize routes — after site.init() (which resets site.routes).
		for (const route of this.routes) {
			route.init();
		}

		// Initialize events
		for (const event of this.events) {
			event.init();
		}

		// Re-init vectors (for seek behaviors)
		for (const vector of this.vectors) {
			vector.init();
		}

		// Initialize clusters
		this.clusters = this.initClusters();

		// Initialize trackers
		for (const trait of this.traits) {
			if (!this.trait_trackers_kv[trait.base_key] && createTracker) {
				const tracker = createTracker(this, trait);
				this.trackers.push(tracker);
				this.trait_trackers_kv[trait.base_key] = tracker;
				trait.tracker = tracker;
			} else {
				trait.tracker = this.trait_trackers_kv[trait.base_key];
			}
		}

		for (const resource of this.resources) {
			if (!this.resource_trackers_kv[resource.base_key] && createTracker) {
				const tracker = createTracker(this, resource);
				this.trackers.push(tracker);
				this.resource_trackers_kv[resource.base_key] = tracker;
				resource.tracker = tracker;
			} else {
				resource.tracker = this.resource_trackers_kv[resource.base_key];
			}
		}

		// Create event expressions
		for (const event of this.events) {
			event.createExpressions();
		}

		// Initialize site histories
		for (const site of this.sites) {
			site.initHistory();
		}
		for (const site of this.sites) {
			site.initHistoryDenominators();
		}
		for (const hist of this.resource_hist) {
			hist.initDenominators();
		}

		// Initialize site populations
		for (const site of this.sites) {
			await site.initPopulation();
		}

		// Combine graph heights
		this.graph_height = 0;
		for (const site of this.sites) {
			this.graph_height += site.graph_height;
		}

		// Setup site selector. A siteless world is LEGAL when sites are
		// founded dynamically (world-content §5 genesis worlds: civilization
		// emerges from the substrate via addSite) — boot continues with an
		// empty roster instead of aborting.
		if (this.sites.length === 0 && this.data.allow_empty !== true) {
			this.system.unsetSite();
			await this.system.confirmBox({ message: "Could not load: No sites!", buttons: [{ label: "OK" }] });
			return;
		} else if (this.sites.length === 0) {
			this.system.setSitesSelector(false);
			this.system.unsetSite();
		} else if (this.sites.length === 1) {
			this.system.setSitesSelector(false);
			this.system.setSite(this.sites[0]);
		} else {
			this.system.setSitesSelector(true);
			this.system.unsetSite();
		}

		// Run startup time
		this.setting_up = true;
		this.age = 0 - this.start_age;
		for (let i = 0; i < this.start_age; i++) {
			await this.newDay();
		}

		this.setting_up = false;
		this.zeroNegativeStockpiles();
		this.addCurrentValuesToHistory();
		this.performPlayerActions();
		this.updateGUI();
		this.age++;
		this.applyRouteDayBoundary();

		// Player-side persistence: rebind metrics/correlations from a previous
		// run of the same scenario so a reset doesn't clear what the player
		// built. Mirrors legacy `custom_metrics_prev` / `custom_traits_prev`
		// (script.js:3208-3242). The harness (WorkerSim) is responsible for
		// populating these fields before calling start().
		this.replayCustomMetricsAndCorrelations();

		await this.updateAllPhases();

		this.system.loadingDay = false;
		this.system.forceDayEnd = false;

		if (this.has_tracked_trait) {
			this.system.setVisualizerMode();
			this.system.setVisualizerToggle(true);
		} else {
			this.system.setGraphMode();
			this.system.setVisualizerToggle(false);
		}

		this.initialized = true;
	}

	// ========================================
	// Day Processing
	// ========================================

	/**
	 * Queue a cross-site shed share for next-day delivery. Amounts are
	 * summed per (dest, transmit, origin) key, so the queue's final state is
	 * independent of the order in which sites and populations shed.
	 */
	queueCrossSiteShed(
		origin: SiteLike,
		dest: SiteLike,
		transmit: { key: string; phase_index: number },
		amount: number,
	): void {
		if (!(amount > 0)) return;
		const k = dest.key + '|' + transmit.key + '|' + origin.key;
		const existing = this.cross_site_pending.get(k);
		if (existing) {
			existing.amount_shed += amount;
		} else {
			this.cross_site_pending.set(k, { origin, dest, transmit, amount_shed: amount });
		}
	}

	/**
	 * Day-boundary route work: migrate populations along routes, then
	 * deliver yesterday's exported sheds as PendingTransmissions on their
	 * destination sites (drained by Site.updateTransmission when the
	 * transmit's phase runs today). Runs after lock-in, before phases.
	 */
	private applyRouteDayBoundary(): void {
		if (this.routes.length === 0) return;
		this.applyMigration(this.system.rand.getSeed(), this.age);
		this.deliverCrossSiteSheds();
	}

	private deliverCrossSiteSheds(): void {
		if (this.cross_site_pending.size === 0) return;
		// Sorted drain so the pending arrays' order is deterministic
		// regardless of Map insertion order.
		const keys = [...this.cross_site_pending.keys()].sort();
		for (const k of keys) {
			const p = this.cross_site_pending.get(k)!;
			const phaseIdx = p.transmit.phase_index ?? 0;
			const pending = p.dest.shed_pending_phases[phaseIdx];
			if (pending) {
				pending.push({ origin: p.origin, transmit: p.transmit, amount_shed: p.amount_shed });
			}
		}
		this.cross_site_pending.clear();
	}

	/**
	 * Uniform-by-syndrome population diffusion along routes. All desired
	 * flows are computed from a frozen snapshot of pop counts, scaled down
	 * if several routes over-drain one Population, then applied in sorted
	 * key order with per-move stochastic rounding keyed by
	 * (seed, day, route, source site, syndrome) — deterministic and
	 * independent of route/site declaration order.
	 *
	 * Moving proportionally across every syndrome is the uniformity
	 * condition the trait-clustering machinery (C2b) requires; selective
	 * migration is expressed via Route.migration_forbid, which excludes a
	 * syndrome entirely (still uniform within every syndrome that moves).
	 */
	private applyMigration(seed: number, day: number): void {
		interface MigrPop {
			id: number;
			pop: number;
			syndrome: { key: string; trait_keys: string[] };
			migrateTo(destSite: unknown, moved: number): void;
		}
		interface Move {
			key: string;
			srcPop: MigrPop;
			destSite: SiteLike;
			amount: number;
		}

		const moves: Move[] = [];
		const outflow = new Map<MigrPop, number>();

		for (const route of this.routes) {
			if (route.migration <= 0 || !route.site_a || !route.site_b) continue;
			const a = route.site_a as unknown as SiteLike;
			const b = route.site_b as unknown as SiteLike;
			for (const [src, dest] of [[a, b], [b, a]] as Array<[SiteLike, SiteLike]>) {
				for (const popObj of src.pops) {
					const pop = popObj as unknown as MigrPop;
					if (pop.pop <= 0) continue;
					if (route.blocksMigration(pop.syndrome.trait_keys)) continue;
					const amount = pop.pop * route.migration;
					moves.push({
						key: route.key + '|' + src.key + '|' + pop.syndrome.key,
						srcPop: pop,
						destSite: dest,
						amount,
					});
					outflow.set(pop, (outflow.get(pop) ?? 0) + amount);
				}
			}
		}
		if (moves.length === 0) return;

		// Scale down any Population whose combined desired outflow across
		// routes exceeds what it holds.
		for (const m of moves) {
			const total = outflow.get(m.srcPop)!;
			if (total > m.srcPop.pop) m.amount *= m.srcPop.pop / total;
		}

		moves.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

		for (const m of moves) {
			let moved = Math.floor(m.amount);
			const frac = m.amount - moved;
			// A fractional desired amount is rounded by a DAY-keyed draw, so
			// an identical state can realize differently tomorrow — that is
			// not a fixed point, whatever today's realization was.
			if (frac > 0) this.day_migration_fractional = true;
			if (frac > 0 && hashUniform(seed, day, 'migration', m.key) < frac) moved++;
			if (moved <= 0) continue;
			m.srcPop.migrateTo(m.destSite, moved);
		}
	}

	/**
	 * Externally DRIVEN migration — the Settlement→Composition channel of
	 * the grand-dream day-boundary contract (§4b): the layer above has
	 * already decided the flow, so move EXACTLY `count` people from one
	 * site to another, apportioned uniformly by syndrome. Largest-remainder
	 * apportionment (ties broken on syndrome key; moves processed in sorted
	 * from|to order, each seeing the state left by the previous) keeps the
	 * result deterministic with no RNG draw — exact totals are what let the
	 * two layers stay bit-consistent. Route.migration_forbid does NOT
	 * apply: driven flows carry the settlement layer's authority.
	 * Returns the number of people actually moved (clamped to available).
	 */
	applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number {
		interface DrivenPop {
			pop: number;
			syndrome: { key: string };
			migrateTo(destSite: unknown, moved: number): void;
		}
		let totalMoved = 0;
		const ordered = [...moves].sort((x, y) => {
			const kx = x.from + '|' + x.to;
			const ky = y.from + '|' + y.to;
			return kx < ky ? -1 : kx > ky ? 1 : 0;
		});
		for (const mv of ordered) {
			if (!(mv.count > 0) || mv.from === mv.to) continue;
			const src = this.sites.find(s => s.key === mv.from);
			const dest = this.sites.find(s => s.key === mv.to);
			if (!src || !dest) continue;
			const pops = (src.pops as unknown as DrivenPop[])
				.filter(p => p.pop > 0)
				.sort((a, b) => (a.syndrome.key < b.syndrome.key ? -1 : a.syndrome.key > b.syndrome.key ? 1 : 0));
			const avail = pops.reduce((a, p) => a + p.pop, 0);
			const count = Math.min(Math.floor(mv.count), avail);
			if (count <= 0) continue;

			// Largest-remainder apportionment: floors first, then the
			// leftover units go to the largest fractional remainders.
			let placed = 0;
			const shares = pops.map(p => {
				const exact = (count * p.pop) / avail;
				const base = Math.floor(exact);
				placed += base;
				return { p, take: base, rem: exact - base };
			});
			let left = count - placed;
			const byRemainder = [...shares].sort((a, b) =>
				b.rem - a.rem || (a.p.syndrome.key < b.p.syndrome.key ? -1 : 1));
			for (const s of byRemainder) {
				if (left <= 0) break;
				if (s.rem > 0) { s.take++; left--; }
			}
			for (const s of shares) {
				if (s.take > 0) { s.p.migrateTo(dest, s.take); totalMoved += s.take; }
			}
		}
		if (totalMoved > 0) this.markCompositionDirty();
		return totalMoved;
	}

	// ========================================
	// Vital dynamics (births / deaths)
	// ========================================

	/** Accounting ledger: the conservation invariant for a vital world is
	 * Σ pops + histfigs = start + births_total − deaths_total − emigrants_total. */
	births_total: number = 0;
	deaths_total: number = 0;
	/** People who WALKED off the settled world (settlement-emergence Gate D:
	 * abandonment back into wild bands) — leavers, never deaths. The layer
	 * above owns where they went; this ledger only keeps Σ pops honest. */
	emigrants_total: number = 0;

	/**
	 * Apply exact birth and death counts to a site — the DIRECT population
	 * model replacing the legacy "nonexistent pool + living trait" scheme
	 * (whose ghost units contaminated denominators and had to be
	 * special-cased out of the clustering math).
	 *
	 * Births distribute over the site's populations ∝ size (largest
	 * remainder, sorted syndrome keys — exact and RNG-free) and each
	 * population's newborns land in the HEREDITARY PROJECTION of the
	 * parents' syndrome: traits flagged `hereditary` pass to the child,
	 * acquired states (infected, convinced) do not — so a generation of
	 * births dilutes ideas that aren't re-transmitted, which is exactly
	 * the generational decay the trait dynamics want.
	 *
	 * Deaths remove uniformly by syndrome (the C2b condition), computed
	 * from the same pre-birth snapshot (newborns are not at risk on their
	 * birth day). Both counts clamp to what exists. The layer above owns
	 * the POLICY (rates × food fill — the Malthusian loop); this is only
	 * the mechanism. Marks the composition dirty.
	 *
	 * `trait` optionally SCOPES the whole operation to carriers of one
	 * trait (a SPECIES, in grand-dream's usage): the snapshot, the
	 * apportionment and the clamps all see only those pops, so a famine
	 * in one species' diet never starves another — and since species
	 * traits are hereditary, births inside the scope stay inside it.
	 * Omitted = the whole site (the original behavior, bit-identical).
	 */
	applyVitals(siteKey: string, births: number, deaths: number, trait?: string): { born: number; died: number } {
		interface VitalPop {
			pop: number;
			syndrome: { key: string; trait_keys: string[] };
			addUnits(n: number, from: unknown, sub: null): void;
			removeUnits(n: number, from: unknown, sub: null): void;
		}
		const site = this.sites.find(s => s.key === siteKey);
		if (!site) return { born: 0, died: 0 };
		const snapshot = (site.pops as unknown as VitalPop[])
			.filter(p => p.pop > 0 && (trait === undefined || p.syndrome.trait_keys.includes(trait)))
			.sort((a, b) => (a.syndrome.key < b.syndrome.key ? -1 : a.syndrome.key > b.syndrome.key ? 1 : 0))
			.map(p => ({ p, size: p.pop }));
		const total = snapshot.reduce((a, s) => a + s.size, 0);
		if (total <= 0) return { born: 0, died: 0 };

		// Largest-remainder apportionment of `count` over the snapshot.
		const apportion = (count: number): number[] => {
			const takes = snapshot.map(() => 0);
			let placed = 0;
			const shares = snapshot.map((s, idx) => {
				const exact = (count * s.size) / total;
				const base = Math.floor(exact);
				takes[idx] = base;
				placed += base;
				return { idx, rem: exact - base };
			});
			let left = count - placed;
			shares.sort((a, b) => b.rem - a.rem ||
				(snapshot[a.idx].p.syndrome.key < snapshot[b.idx].p.syndrome.key ? -1 : 1));
			for (const s of shares) {
				if (left <= 0) break;
				if (s.rem > 0) { takes[s.idx]++; left--; }
			}
			return takes;
		};

		let born = 0;
		const wantBirths = Math.max(0, Math.floor(births));
		if (wantBirths > 0) {
			const takes = apportion(wantBirths);
			snapshot.forEach((s, idx) => {
				const n = takes[idx];
				if (n <= 0) return;
				const keys = s.p.syndrome.trait_keys
					.filter(k => (this.traits_kv[k] as unknown as { hereditary?: boolean })?.hereditary)
					.sort();
				const syndrome = this.getSyndrome(keys);
				let crib = site.pops_kv[syndrome.key] as unknown as VitalPop | undefined;
				if (!crib) crib = site.addPop(0, syndrome) as unknown as VitalPop;
				crib.addUnits(n, crib, null);
				site.pop += n;
				born += n;
			});
		}

		let died = 0;
		const wantDeaths = Math.max(0, Math.floor(deaths));
		if (wantDeaths > 0) {
			const takes = apportion(Math.min(wantDeaths, total));
			snapshot.forEach((s, idx) => {
				const n = Math.min(takes[idx], s.p.pop);
				if (n <= 0) return;
				s.p.removeUnits(n, s.p, null);
				site.pop -= n;
				died += n;
			});
		}

		if (born > 0 || died > 0) {
			this.births_total += born;
			this.deaths_total += died;
			this.markCompositionDirty();
		}
		return { born, died };
	}

	/**
	 * EMIGRATION — exact people LEAVE the composition entirely (the
	 * settlement layer's Gate D: an abandoned settlement's crowd walks
	 * back into the wild, which this world does not model). Removal is
	 * uniform by syndrome from a snapshot, largest remainder, RNG-free —
	 * applyVitals' death mechanics with one crucial difference: the
	 * walkers land in `emigrants_total`, never `deaths_total` (a collapse
	 * is people leaving, not people dying — the generational ledgers must
	 * not read abandonment as massacre). `trait` scopes to one species'
	 * carriers, as in applyVitals. Clamps to what exists; returns the
	 * count that walked. Marks the composition dirty.
	 */
	applyEmigration(siteKey: string, count: number, trait?: string): number {
		interface WalkPop {
			pop: number;
			syndrome: { key: string; trait_keys: string[] };
			removeUnits(n: number, from: unknown, sub: null): void;
		}
		const site = this.sites.find(s => s.key === siteKey);
		if (!site) return 0;
		const snapshot = (site.pops as unknown as WalkPop[])
			.filter(p => p.pop > 0 && (trait === undefined || p.syndrome.trait_keys.includes(trait)))
			.sort((a, b) => (a.syndrome.key < b.syndrome.key ? -1 : a.syndrome.key > b.syndrome.key ? 1 : 0))
			.map(p => ({ p, size: p.pop }));
		const total = snapshot.reduce((a, s) => a + s.size, 0);
		const want = Math.min(Math.max(0, Math.floor(count)), total);
		if (want <= 0) return 0;

		// Largest-remainder apportionment of the walkers over the snapshot.
		const takes = snapshot.map(() => 0);
		let placed = 0;
		const shares = snapshot.map((s, idx) => {
			const exact = (want * s.size) / total;
			const base = Math.floor(exact);
			takes[idx] = base;
			placed += base;
			return { idx, rem: exact - base };
		});
		let left = want - placed;
		shares.sort((a, b) => b.rem - a.rem ||
			(snapshot[a.idx].p.syndrome.key < snapshot[b.idx].p.syndrome.key ? -1 : 1));
		for (const s of shares) {
			if (left <= 0) break;
			if (s.rem > 0) { takes[s.idx]++; left--; }
		}

		let walked = 0;
		snapshot.forEach((s, idx) => {
			const n = Math.min(takes[idx], s.p.pop);
			if (n <= 0) return;
			s.p.removeUnits(n, s.p, null);
			site.pop -= n;
			walked += n;
		});
		if (walked > 0) {
			this.emigrants_total += walked;
			this.markCompositionDirty();
		}
		return walked;
	}

	// ========================================
	// Trait-shaped demand (world-content.md §3c)
	// ========================================

	/**
	 * The demand vector a site's COMPOSITION implies: for every trait its
	 * people carry, sum the trait's declared `demand` rates × carrier
	 * count, per resource. This is how traits decide which resources a
	 * settlement is interested in — demand is a property OF THE TRAIT,
	 * declared beside its transmits, and the settlement layer reads the
	 * aggregate at the day boundary. A pure read: no stockpiles touched,
	 * no rest-detection interference.
	 */
	siteResourceDemand(siteKey: string): Record<string, number> {
		const out: Record<string, number> = {};
		const site = this.sites.find(s => s.key === siteKey);
		if (!site) return out;
		for (const pop of site.pops) {
			if (pop.pop <= 0) continue;
			for (const tk of pop.syndrome.trait_keys) {
				const trait = this.traits_kv[tk] as unknown as { demand?: Array<{ resource: string; value: number }> };
				for (const dm of trait?.demand ?? []) {
					out[dm.resource] = (out[dm.resource] ?? 0) + dm.value * pop.pop;
				}
			}
		}
		return out;
	}

	// ========================================
	// Founding (world-content.md gate 5)
	// ========================================

	/**
	 * Found a settlement mid-run — a DAY-BOUNDARY structural event: create
	 * and fully initialize a Site, mirroring World.start()'s per-site
	 * sequence (init → stockpiles → actions → history → denominators →
	 * initPopulation). Born with `pop` people from the scenario JSON; the
	 * conserving path is pop 0 + colonists via applyExternalMigration (or
	 * a documented external injection when harvesting a substrate crowd).
	 * History rows begin at the founding day. Marks composition dirty.
	 */
	async addSite(json: Record<string, unknown>): Promise<SiteLike | null> {
		const key = String(json.key ?? '');
		if (!key || this.sites.some(s => s.key === key)) return null;
		const site = new Site(this, json) as unknown as SiteLike;
		this.sites.push(site);
		site.init();
		site.initLocalStockpiles();
		site.initLocalActions();
		site.initHistory();
		site.initHistoryDenominators();
		await site.initPopulation();
		this.markCompositionDirty();
		return site;
	}

	/**
	 * Add a route mid-run (the founding transaction's edges). Route.init()
	 * resolves the endpoint sites and registers itself on both — safe
	 * mid-run because sites' route lists are only ever appended to after
	 * start. Marks composition dirty (the cross-site topology changed).
	 */
	addRoute(json: Record<string, unknown>): Route | null {
		const route = new Route(this, json);
		this.routes.push(route);
		route.init();
		if (!route.site_a || !route.site_b) {
			this.routes.pop();
			return null;
		}
		this.markCompositionDirty();
		return route;
	}

	// ========================================
	// Membership + breakaway (step 5, §7)
	// ========================================

	/**
	 * Runtime faction statistics for `dissent` within the `from` bloc:
	 *   fraction  — dissent∧from carriers / from carriers (bloc size)
	 *   coherence — cross-site dissimilarity index in [0,1]: 0 = the
	 *               dissent is spread uniformly (diffuse grumbling),
	 *               → 1 = fully segregated (the faction holds territory).
	 * A "statistically real faction" is big AND territorially coherent.
	 * Single-site worlds have coherence 0 — secession is territorial by
	 * construction. (The C-series factorization residual can join this
	 * later as a within-site entanglement criterion.)
	 */
	measureFaction(dissentKey: string, fromKey: string): {
		fraction: number; coherence: number; factionPop: number; fromPop: number;
	} {
		let fromPop = 0;
		let factionPop = 0;
		const perSite: Array<{ n: number; f: number }> = [];
		for (const site of this.sites) {
			let n = 0, f = 0;
			for (const pop of site.pops) {
				if (pop.pop <= 0) continue;
				const keys = pop.syndrome.trait_keys;
				if (keys.indexOf(fromKey) === -1) continue;
				n += pop.pop;
				if (keys.indexOf(dissentKey) !== -1) f += pop.pop;
			}
			perSite.push({ n, f });
			fromPop += n;
			factionPop += f;
		}
		const fraction = fromPop > 0 ? factionPop / fromPop : 0;
		let coherence = 0;
		if (fraction > 0 && fraction < 1) {
			let d = 0;
			for (const s of perSite) {
				if (s.n <= 0) continue;
				d += s.n * Math.abs(s.f / s.n - fraction);
			}
			coherence = d / (2 * fromPop * fraction * (1 - fraction));
		}
		return { fraction, coherence, factionPop, fromPop };
	}

	/**
	 * Exact, deterministic syndrome rewrite — the §7 membership operation:
	 * every population whose trait set contains ALL `where` keys moves
	 * WHOLESALE to the syndrome (traits ∖ remove) ∪ apply on its own site.
	 * Whole-population moves are trivially uniform-by-syndrome (the C2b
	 * condition). Not for traits carrying progression state (state is not
	 * carried). Marks the composition dirty. Returns people moved.
	 *
	 * `siteKey` scopes the flip to ONE site — conquest's political mode
	 * (a fallen city changes flags; the rest of its civ does not). Omitted
	 * = world-wide, the breakaway shape.
	 */
	applyTraitFlip(where: string[], apply: string[], remove: string[], siteKey?: string): number {
		interface FlipPop {
			pop: number;
			syndrome: { key: string; trait_keys: string[] };
			transferTo(target: unknown, moved: number): void;
		}
		let total = 0;
		for (const site of this.sites) {
			if (siteKey !== undefined && site.key !== siteKey) continue;
			const targets = (site.pops as unknown as FlipPop[])
				.filter(p => p.pop > 0 && where.every(k => p.syndrome.trait_keys.indexOf(k) !== -1))
				.sort((a, b) => (a.syndrome.key < b.syndrome.key ? -1 : a.syndrome.key > b.syndrome.key ? 1 : 0));
			for (const pop of targets) {
				const keys = pop.syndrome.trait_keys.filter(k => remove.indexOf(k) === -1);
				for (const k of apply) if (keys.indexOf(k) === -1) keys.push(k);
				const syndrome = this.getSyndrome(keys.slice().sort());
				if (syndrome.key === pop.syndrome.key) continue;
				let dest = site.pops_kv[syndrome.key];
				if (!dest) dest = site.addPop(0, syndrome);
				const moved = pop.pop;
				pop.transferTo(dest, moved);
				total += moved;
			}
		}
		if (total > 0) this.markCompositionDirty();
		return total;
	}

	/**
	 * Day-boundary breakaway check (§7 step 3): when a dissenting bloc is
	 * big enough AND territorially coherent, the membership flips —
	 * dissent∧from populations wholesale become `to`. Runs after phases so
	 * it sees today's spread; the flip lands inside the day's rest
	 * observation, so a secession day is never mistaken for rest.
	 */
	private evaluateBreakaways(): void {
		for (const b of this.breakaways) {
			if (b.fired) continue;
			if (!this.traits_kv[b.dissent] || !this.traits_kv[b.from] || !this.traits_kv[b.to]) {
				console.error(`breakaway ${b.key}: dissent/from/to must be declared traits`);
				b.fired = true; // don't re-log every day
				continue;
			}
			const m = this.measureFaction(b.dissent, b.from);
			if (m.fraction >= b.threshold && m.coherence >= b.coherence && m.factionPop > 0) {
				const moved = this.applyTraitFlip([b.dissent, b.from], [b.to], [b.from]);
				b.fired = true;
				b.day_fired = this.age;
				this.breakaways_fired.push({ key: b.key, day: this.age, moved });
			}
		}
	}

	// ========================================
	// Histfigs (step 6, §6)
	// ========================================

	/**
	 * Deterministically sample villager `index` of a site: pick a syndrome
	 * by a HashRand-weighted draw over the site's living populations, then
	 * bridge every non-combo trait to a scalar around the LOCAL prevalence
	 * p with individual variance u ~ hash-uniform:
	 *   mix = (u + p) / 2
	 *   carrier:     scalar = 0.5 + 0.5·mix   (≥ 0.5 — devout villages
	 *                                          breed fervent devotees)
	 *   non-carrier: scalar = 0.5·mix         (< 0.5 — but pulled toward
	 *                                          the fence by peer pressure)
	 * Same (world seed, siteKey, index) ⇒ same villager, zero storage;
	 * the draw shifts only when the site's composition itself shifts.
	 */
	sampleIndividual(siteKey: string, index: number): HistfigSample | null {
		const site = this.sites.find(s => s.key === siteKey);
		if (!site) return null;
		const seed = this.system.rand.getSeed();

		const pops = site.pops
			.filter(p => p.pop > 0)
			.sort((a, b) => (a.syndrome.key < b.syndrome.key ? -1 : a.syndrome.key > b.syndrome.key ? 1 : 0));
		const total = pops.reduce((a, p) => a + p.pop, 0);
		if (total <= 0) return null;

		let r = hashUniform(seed, 'histfig-syndrome', siteKey, index) * total;
		let chosen = pops[pops.length - 1];
		for (const p of pops) {
			if (r < p.pop) { chosen = p; break; }
			r -= p.pop;
		}
		const carried = chosen.syndrome.trait_keys;

		const scalars: Record<string, number> = {};
		for (const trait of this.traits) {
			if ((trait as unknown as { is_combo?: boolean; is_correlation?: boolean }).is_combo) continue;
			if ((trait as unknown as { is_correlation?: boolean }).is_correlation) continue;
			let carriers = 0;
			for (const p of site.pops) {
				if (p.pop > 0 && p.syndrome.trait_keys.indexOf(trait.key) !== -1) carriers += p.pop;
			}
			const prevalence = carriers / total;
			const u = hashUniform(seed, 'histfig-scalar', siteKey, index, trait.key);
			const mix = (u + prevalence) / 2;
			scalars[trait.key] = carried.indexOf(trait.key) !== -1 ? 0.5 + 0.5 * mix : 0.5 * mix;
		}

		return {
			siteKey, index,
			name: this.histfigName(seed, siteKey, index),
			syndromeKey: chosen.syndrome.key,
			traitKeys: carried.slice(),
			scalars,
		};
	}

	private histfigName(seed: number, siteKey: string, index: number): string {
		const SYL = ['ka', 'ren', 'tho', 'mi', 'sa', 'lor', 've', 'dun', 'ari', 'bel', 'osh', 'tan', 'ny', 'gar', 'el', 'ric'];
		const count = 2 + (hashUniform(seed, 'histfig-name-len', siteKey, index) < 0.4 ? 1 : 0);
		let name = '';
		for (let i = 0; i < count; i++) {
			name += SYL[Math.floor(hashUniform(seed, 'histfig-name', siteKey, index, i) * SYL.length)];
		}
		return name.charAt(0).toUpperCase() + name.slice(1);
	}

	/**
	 * Promote villager `index` of a site to a persistent histfig: one
	 * person leaves the aggregate accounting (their Population shrinks by
	 * 1), and the individual — scalars and all — persists on the world.
	 * Invariant afterwards: Σ pops + histfigs.length is unchanged.
	 */
	pinHistfig(siteKey: string, index: number, role: string = 'notable'): Histfig | null {
		const sample = this.sampleIndividual(siteKey, index);
		if (!sample) return null;
		const site = this.sites.find(s => s.key === siteKey)!;
		const pop = site.pops_kv[sample.syndromeKey];
		if (!pop || pop.pop < 1) return null;

		(pop as unknown as { removeUnits(n: number, from: unknown, sub: null): void }).removeUnits(1, pop, null);
		site.pop -= 1;

		const histfig: Histfig = { ...sample, id: this.next_histfig_id++, role };
		this.histfigs.push(histfig);
		this.markCompositionDirty();
		return histfig;
	}

	/**
	 * Release a histfig back into the crowd: scalars bin to a binary
	 * syndrome by threshold 0.5 (an untouched histfig returns to exactly
	 * the syndrome they were drawn from) and their home Population grows
	 * by one.
	 */
	releaseHistfig(id: number): boolean {
		const idx = this.histfigs.findIndex(h => h.id === id);
		if (idx === -1) return false;
		const hf = this.histfigs[idx];
		const site = this.sites.find(s => s.key === hf.siteKey);
		if (!site) return false;

		const keys = Object.keys(hf.scalars).filter(k => hf.scalars[k] >= 0.5).sort();
		const syndrome = this.getSyndrome(keys);
		let pop = site.pops_kv[syndrome.key];
		if (!pop) pop = site.addPop(0, syndrome);
		(pop as unknown as { addUnits(n: number, from: unknown, sub: null): void }).addUnits(1, pop, null);
		site.pop += 1;

		this.histfigs.splice(idx, 1);
		this.markCompositionDirty();
		return true;
	}

	/**
	 * Histfig influence — the §6 story-generator channel: the individual
	 * sheds a trait onto their HOME site through the PendingTransmission
	 * pipeline, the EXACT mechanism cross-site sheds already ride (queued
	 * now, converted to a live shed inside the next day's first phase —
	 * a raw site.shed deposit would be wiped by the day-start history
	 * reset). `scaleBy` multiplies by one of their scalars — a charismatic
	 * ruler preaches harder. Returns the shed amount deposited.
	 */
	histfigShed(id: number, traitKey: string, amount: number, scaleBy?: string): number {
		const hf = this.histfigs.find(h => h.id === id);
		if (!hf || !this.traits_kv[traitKey]) return 0;
		const site = this.sites.find(s => s.key === hf.siteKey);
		if (!site) return 0;
		const pending = site.shed_pending_phases[0] as unknown[] | undefined;
		if (!pending) return 0; // world not started yet
		const scale = scaleBy ? (hf.scalars[scaleBy] ?? 0) : 1;
		const shedAmount = amount * scale;
		if (!(shedAmount > 0)) return 0;

		pending.push({
			origin: null,
			transmit: {
				key: `histfig:${hf.id}:${traitKey}`,
				phase_index: 0,
				vectors: [], vector_keys: [],
				traits: [], trait_keys: [traitKey],
				cures: [], cure_keys: [],
				seek: [], precise: 1,
				relevant_clusters: this.blank_cluster_array,
			},
			amount_shed: shedAmount,
		});
		this.markCompositionDirty();
		return shedAmount;
	}

	// ========================================
	// Composition rest detection (step 3)
	// ========================================

	/** Call after any between-day external mutation of composition state
	 * (driven migration, test injections, player edits) so a previously
	 * observed fixed point is not trusted. */
	markCompositionDirty(): void {
		this.composition_dirty = true;
		this.rest_observed = false;
	}

	/** Snapshot pop/stockpile values at day start so the day's REALIZED
	 * change is measurable at day end (catches every mutation path —
	 * events, migration, produces — without instrumenting each one). */
	private snapshotRestBaseline(): void {
		const pops = this.populations_by_id;
		if (this.rest_snap_pops.length < pops.length) {
			this.rest_snap_pops = new Float64Array(Math.max(64, pops.length * 2));
		}
		this.rest_snap_pop_count = pops.length;
		for (let i = 0; i < pops.length; i++) this.rest_snap_pops[i] = pops[i] ? pops[i].pop : 0;

		const stocks = this.stockpiles_by_id;
		if (this.rest_snap_stocks.length < stocks.length) {
			this.rest_snap_stocks = new Float64Array(Math.max(16, stocks.length * 2));
		}
		this.rest_snap_stock_count = stocks.length;
		for (let i = 0; i < stocks.length; i++) this.rest_snap_stocks[i] = stocks[i] ? stocks[i].value : 0;

		this.day_delta_activity = 0;
		this.day_migration_fractional = false;
		this.day_potential_conversions = false;
	}

	/** Latent-conversion flag — called by Site.updateContact when a shed
	 * targets a population it could still change. */
	notePotentialConversions(): void {
		this.day_potential_conversions = true;
	}

	/** Σ|value − day-start value| over pops and stockpiles. Populations
	 * created mid-day count in full. */
	private restStateDiff(): number {
		let diff = 0;
		const pops = this.populations_by_id;
		for (let i = 0; i < pops.length; i++) {
			const now = pops[i] ? pops[i].pop : 0;
			const before = i < this.rest_snap_pop_count ? this.rest_snap_pops[i] : 0;
			diff += Math.abs(now - before);
		}
		const stocks = this.stockpiles_by_id;
		for (let i = 0; i < stocks.length; i++) {
			const now = stocks[i] ? stocks[i].value : 0;
			const before = i < this.rest_snap_stock_count ? this.rest_snap_stocks[i] : 0;
			diff += Math.abs(now - before);
		}
		return diff;
	}

	/** Order-independent fingerprint of the cross-site queue. A fixed point
	 * must re-produce the SAME queue every day (sd > 0 on a ranged transmit
	 * varies the amounts, which correctly blocks rest). */
	private queueFingerprint(): string {
		if (this.cross_site_pending.size === 0) return '';
		const keys = [...this.cross_site_pending.keys()].sort();
		let fp = '';
		for (const k of keys) fp += k + ':' + this.cross_site_pending.get(k)!.amount_shed + ';';
		return fp;
	}

	/** All scenario events spent (count 0). An armed event can reference
	 * `age` or `random`, so any unfired event conservatively blocks rest. */
	private allEventsSpent(): boolean {
		for (const e of this.events) {
			if ((e as unknown as { count: number }).count !== 0) return false;
		}
		return true;
	}

	/** Metric histories evaluate their expression daily; a RAND token in one
	 * consumes serial RNG every day, which a skip would not replay. */
	private metricsUseRandom(): boolean {
		const histSets: HistoryLike[][] = [this.metric_hist, ...this.sites.map(s => s.metric_hist)];
		for (const hists of histSets) {
			for (const h of hists) {
				const expr = (h as unknown as { tracker?: { metric?: { expression?: { values?: { subtype?: string }[] } } } })
					.tracker?.metric?.expression;
				for (const v of expr?.values ?? []) {
					if (v.subtype === VALUE_SUBTYPE.RAND) return true;
				}
			}
		}
		return false;
	}

	/** Judge the just-completed day. Fixed point ⇔ zero expected deltas,
	 * zero realized change, queue identical to yesterday's, no fractional
	 * rate-migration, all events spent, no external input, no daily serial
	 * RNG consumers. From such a day, tomorrow is provably bit-identical. */
	private finalizeRestObservation(): void {
		const queueFp = this.queueFingerprint();
		this.rest_observed =
			!this.composition_dirty &&
			this.day_delta_activity <= this.rest_eps &&
			this.restStateDiff() <= this.rest_eps &&
			queueFp === this.prev_queue_fp &&
			!this.day_migration_fractional &&
			!this.day_potential_conversions &&
			this.allEventsSpent() &&
			!this.metricsUseRandom();
		this.prev_queue_fp = queueFp;
		this.composition_dirty = false;
	}

	/** True when the composition layer sits on an observed fixed point and
	 * skipping days is exactly equivalent to stepping them. */
	isCompositionAtRest(): boolean {
		return this.rest_observed && !this.composition_dirty && !this.scenario_complete;
	}

	/** O(1) idle catch-up: advance `n` days without simulating them. Only
	 * legal at rest (throws otherwise — callers must check). State, pending
	 * queue and all day-keyed determinism are preserved, so a later wake-up
	 * behaves bit-identically to having stepped. History rows for the
	 * skipped span are NOT written (graphs show a gap; scenarios relying on
	 * history-window reads are already excluded by the event guard). */
	skipDays(n: number): number {
		const days = Math.floor(n);
		if (days <= 0) return 0;
		if (!this.isCompositionAtRest()) {
			throw new Error('skipDays: composition is not at rest');
		}
		this.age += days;
		this.render_age = this.age;
		return days;
	}

	async newDay(): Promise<void> {
		profiler.beginDay();
		const stop = profiler.start('World.newDay');
		this.system.loadingDay = true;
		if (this.scenario_complete) { stop(); return; }

		this.snapshotRestBaseline();

		// Refresh metric/correlation gray-out before history evaluation, so
		// any visibility flip from yesterday's events is reflected in today's
		// row state.
		this.recomputeMetricGrayout();

		this.updateDisplayedHistoryValues();
		this.performPlayerActions();
		this.setAllActionsToValueClosestToDesired();
		this.addCurrentValuesToHistory();

		this.render_age = this.age;
		this.age++;

		this.applyRouteDayBoundary();

		this.updateGUI();
		await this.updateAllPhases();

		this.evaluateBreakaways();
		this.finalizeRestObservation();

		this.system.loadingDay = false;
		this.system.forceDayEnd = false;
		stop();
		profiler.report(`day ${this.age}`);
	}

	async updateAllPhases(): Promise<void> {
		const seed = this.system.rand.getSeed();
		const day = this.age;

		for (let p = 0; p < this.all_phases.length; p++) {
			const phase = this.all_phases[p];

			// Phase-start sync: refresh GPU-resident population state from the
			// post-applyPhaseDelta JS objects. Each phase mutates pop counts
			// via applyPhaseDelta, so the buffers need re-uploading before
			// the next phase's kernels read from them. At ~5k populations
			// the upload is dominated by writeBuffer overhead (~µs).
			const stopGpuUpload = profiler.start('GpuPopState.upload');
			this.gpuPopState?.uploadFromPopulations(this.populations_by_id as never);
			stopGpuUpload();

			// Cost stage: allocate scarce resources across all actions whose
			// cost entries fire on this phase, drain stockpiles, and finalize
			// transmits scheduled for this phase. After this call, each
			// affected action's `current_value` reflects what it actually
			// got — not what it asked for.
			this.applyActionCostsAndScheduleTransmits(p);

			// All within-phase work writes to a shared PhaseDelta. Reads happen
			// from the live state, which is frozen for the duration of the
			// phase by the discipline that no kernel mutates pop/subpop counts
			// or stockpile.value during the phase. Mutation occurs once at end
			// of phase via `applyPhaseDelta` below.
			const delta = new PhaseDelta();

			for (const event of phase.events) {
				// Event class renamed its update method to `updateEvent` to avoid
				// shadowing BWObj.update(slice). Calling .update() here would silently
				// hit the BWObj no-op, leaving every scenario event un-fired.
				await (event as unknown as { updateEvent(): Promise<void> }).updateEvent();
				if (this.closing) return;
			}

			for (const site of this.sites) {
				await site.updateTransmission(p);
				if (this.closing) return;
			}

			// Production was already accumulated into stockpile.impact_value by
			// updateTransmission. setImpactValue commits it to stockpile.value.
			// doConsumption then emits contact deltas instead of mutating
			// populations directly.
			for (const stockpile of this.global_stockpiles) {
				stockpile.setImpactValue();
				await stockpile.doConsumption(delta);
			}

			for (const site of this.sites) {
				for (const stockpile of site.local_stockpiles) {
					stockpile.setImpactValue();
					await stockpile.doConsumption(delta);
				}
			}

			for (const site of this.sites) {
				await site.updateContact(delta, seed, day, p);
				if (this.closing) return;
			}

			const stopApplyDelta = profiler.start('World.applyPhaseDelta');
			this.applyPhaseDelta(delta, seed, day, p);
			stopApplyDelta();

			for (const site of this.sites) {
				await site.updatePopulations();
				if (this.closing) return;
			}

			// Produce stage: apply each action's produce entries whose phase
			// matches. Adds (current_value × value + N(0, sd)) to the
			// stockpile, with deterministic per-(action, resource, phase, day)
			// noise.
			this.applyActionProducesForPhase(p, seed, day);
		}

		for (const site of this.sites) {
			await site.updatePopulationsHistory();
			if (this.closing) return;
		}

		await this.addNewsItems();
	}

	/**
	 * Drain a PhaseDelta into the live world via a single linear pass over
	 * the TypedArray storage:
	 *   - Population shifts route via populations_by_id; each entry is rounded
	 *     once and applied via Population.applyDeltaShift.
	 *   - Stockpile deltas route via stockpiles_by_id and update value with
	 *     the correct inc/dec history bookkeeping.
	 *
	 * SubSyndrome materialization happened eagerly in the kernel
	 * (Population.applyShedToDelta), so by the time we get here every
	 * targetSubId resolves to a real SubSyndrome.
	 *
	 * Determinism contract: rounding draws are keyed by (seed, day, phase,
	 * "popId|sourceSubId->targetSubId"), so two clients with the same seed
	 * produce identical results regardless of the order of writes to the
	 * delta or iteration during apply.
	 */
	applyPhaseDelta(delta: PhaseDelta, seed: number, day: number, phase: number): void {
		// Numeric rngDraw — avoids the string-template allocation that
		// dominated this loop's per-call cost at scale (~6× faster than the
		// `${popId}|${src}->${tgt}` form, ~60 ms/day saved at 4 k pops).
		// Note: for WASM-emitted entries the amount has already been
		// stochastically rounded inside the WASM batch, so `frac` is 0 and
		// `rngDraw` is never called. Progression / consumption sheds still
		// have float amounts and use this draw.
		const rngDraw = (popId: number, src: number, tgt: number): number =>
			hashUniform(seed, day, phase, popId, src, tgt);

		const popIds = delta.popIds;
		const sourceSubIds = delta.sourceSubIds;
		const targetSubIds = delta.targetSubIds;
		const amounts = delta.amounts;
		const popsById = this.populations_by_id;
		const n = delta.n;
		// Rest detection: any EXPECTED movement (even one that rounds to a
		// realized zero) counts as activity — sub-unit drifts must block
		// rest, or their day-keyed rounding could fire on a skipped day.
		for (let i = 0; i < n; i++) this.day_delta_activity += Math.abs(amounts[i]);
		for (let i = 0; i < delta.nStock; i++) this.day_delta_activity += Math.abs(delta.stockAmounts[i]);
		for (let i = 0; i < n; i++) {
			const pop = popsById[popIds[i]];
			if (!pop) continue;
			(pop as PopulationLike & { applyDeltaShift: (s: number, t: number, a: number, draw: (popId: number, src: number, tgt: number) => number) => void }).applyDeltaShift(
				sourceSubIds[i],
				targetSubIds[i],
				amounts[i],
				rngDraw
			);
		}

		const stockIds = delta.stockIds;
		const stockAmounts = delta.stockAmounts;
		const stocksById = this.stockpiles_by_id;
		const nStock = delta.nStock;
		for (let i = 0; i < nStock; i++) {
			const stock = stocksById[stockIds[i]];
			if (!stock) continue;
			(stock as StockpileLike & { value: number; setValue: (v: number) => void }).setValue(
				stock.value + stockAmounts[i]
			);
		}
	}

	// ========================================
	// Object Getters/Adders
	// ========================================

	getTrait(key: string): TraitLike {
		if (typeof key !== 'string') {
			console.error('getTrait with non-string key', key);
		}
		if (this.traits_kv[key]) return this.traits_kv[key];
		return this.addTrait(createTrait!(this, { key, name: "(" + key + ")" }));
	}

	getVector(key: string): VectorLike {
		if (this.vectors_kv[key]) return this.vectors_kv[key];
		return this.addVector(createVector!(this, { key }));
	}

	getResource(key: string): ResourceLike {
		if (this.resources_kv[key]) return this.resources_kv[key];
		return this.addResource(createResource!(this, { key }));
	}

	/**
	 * Look up an action by key. Mirrors legacy script.js:3531-3534. Used by
	 * EventResult to resolve action_vis / action target actions.
	 */
	getAction(key: string): PlayerActionLike | null {
		return this.actions_kv[key] ?? null;
	}

	/**
	 * Build an Expression from a list of EventValue records. Mirrors legacy
	 * script.js:3419-3450. Each EventValue is one token (operator,
	 * parenthesis, number, action ref, resource ref, trait ref, age) and we
	 * emit ExpressionValue tokens that the Expression evaluator understands.
	 *
	 * Implicit-operator behavior: tokens after the first that don't follow a
	 * `(` get a binary `op` injected (defaults to addition unless explicitly
	 * provided). Matches legacy.
	 */
	createExpressionFromEventValues(values: ReadonlyArray<{
		type?: string;
		op?: string;
		value?: number;
		action?: string;
		resource?: string;
		trait?: string;
		offset?: number;
		neg_offset?: number;
		incdec?: string;
		calc?: string;
	}>): Expression {
		const exp: ExpressionValue[] = [];
		exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.NUM, 0));

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			if (i > 0 && values[i - 1].type !== '(') {
				exp.push(new ExpressionValue(this as never, VALUE_TYPE.OP, null, value.op ?? '+'));
			}
			switch (value.type) {
				case '(':
				case ')':
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.PAREN, null, value.type));
					break;
				case 'number':
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.NUM, value.value));
					break;
				case 'random':
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.RAND, value.value));
					break;
				case 'action': {
					const action = this.actions_kv[value.action ?? ''];
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.ACT, action));
					break;
				}
				case 'resource': {
					const tracker = this.resource_trackers_kv[value.resource ?? ''];
					if (tracker) {
						const tc = new TrackerCalc(tracker as never, {
							offset: value.offset,
							neg_offset: value.neg_offset,
							incdec: value.incdec,
							calc: value.calc,
						} as never);
						exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.TRACKER, tc));
					}
					break;
				}
				case 'trait': {
					const tracker = this.trait_trackers_kv[value.trait ?? ''];
					if (tracker) {
						const tc = new TrackerCalc(tracker as never, {
							offset: value.offset,
							neg_offset: value.neg_offset,
							incdec: value.incdec,
							calc: value.calc,
						} as never);
						exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.TRACKER, tc));
					}
					break;
				}
				case 'age':
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.AGE, null));
					break;
				default:
					// Empty token (`{}`) — used in scenarios as a "zero" placeholder.
					exp.push(new ExpressionValue(this as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.NUM, value.value ?? 0));
					break;
			}
		}

		return new Expression(this as never, exp);
	}

	/**
	 * Look up an interned SubSyndrome by its mask key (see `subSyndromeKey`).
	 * Slow path — walks the four mask words back out of the string. Kept for
	 * compatibility with code paths that still use string keys (tests, debug
	 * tooling). Hot paths should call `getSubSyndromeByMask` instead.
	 */
	getSubSyndrome(key: string): SubSyndrome | null {
		const parts = key.split(',');
		if (parts.length !== MASK_WORDS) return null;
		const mask = new Uint32Array(MASK_WORDS);
		for (let i = 0; i < MASK_WORDS; i++) {
			const v = Number(parts[i]);
			if (!Number.isFinite(v)) return null;
			mask[i] = v >>> 0;
		}
		return this.getSubSyndromeByMask(mask, 0);
	}

	/**
	 * Look up an interned SubSyndrome by its bitmask. One typed-array probe
	 * via the flat-hash registry; no allocation.
	 */
	getSubSyndromeByMask(mask: Uint32Array, offset: number = 0): SubSyndrome | null {
		const off = offset * MASK_WORDS;
		if (this.subsynWasm !== null) {
			// WASM path: we don't expose a pure "lookup without insert" — but
			// returning null when not yet materialized is what the JS API
			// promised. Check the id range first.
			const counterBefore = this.subsynWasm.getCounter();
			const id = this.subsynWasm.getOrInsertId(mask, off);
			if (id >= counterBefore) {
				// We just inserted; caller meant "is this present?" → no.
				// Reset is not exposed, but the lookup is idempotent so the
				// id stays valid. The contract here was "no allocation on
				// lookup"; we technically did, but the JS registry path
				// returns null in this case. Simplest safe behavior: return
				// the SubSyndrome we just materialized. Callers that strictly
				// need "doesn't exist" semantics use a separate path.
			}
			let sub = this.subsyndromes_by_id[id];
			if (sub === undefined) sub = this.lazyMaterializeAtId(id, mask, offset);
			return sub;
		}
		return this.subsyndromes_kv.get(mask, off);
	}

	/**
	 * Materialize a SubSyndrome from a trait bitmask — the primary path.
	 * Reads `MASK_WORDS` u32 words starting at `mask[offset * MASK_WORDS]`
	 * so the caller can pass a flat batch buffer.
	 *
	 * Set-only encoding (post-B3.2a): bit position = `Trait.index`.
	 *
	 * Hot path is the WASM open-addressing hash table (`subsynWasm`) when
	 * available — one `getOrInsertId` call yields the canonical id with no
	 * JS allocation. The SubSyndrome object itself is created lazily on
	 * first access via `lazyMaterializeAtId`, so transient ids that no
	 * downstream code reads cost only the hash-table insert.
	 *
	 * Fallback (tests with no WASM, headless tsx) uses the JS flat-hash
	 * `SubSyndromeRegistry` with the same semantics.
	 */
	materializeSubSyndromeByMask(mask: Uint32Array, offset: number = 0): SubSyndrome {
		const off = offset * MASK_WORDS;
		if (this.subsynWasm !== null) {
			const id = this.subsynWasm.getOrInsertId(mask, off);
			let sub = this.subsyndromes_by_id[id];
			if (sub === undefined) sub = this.lazyMaterializeAtId(id, mask, offset);
			return sub;
		}
		const subsByIdLen = () => this.subsyndromes_by_id.length;
		const factory = (): SubSyndrome => {
			const sub = new SubSyndrome(this as never, subSyndromeKey(mask, offset), mask, offset);
			sub.id = subsByIdLen();
			this.subsyndromes_by_id.push(sub);
			return sub;
		};
		return this.subsyndromes_kv.getOrInsert(mask, off, factory);
	}

	/** Create the SubSyndrome object for a WASM-assigned id and slot it into
	 * `subsyndromes_by_id[id]`. The mask passed in is the source of truth;
	 * if it isn't available (lazy reads where caller only has the id), the
	 * caller can use `subsynWasm.getMaskAtId` first. */
	private lazyMaterializeAtId(id: number, mask: Uint32Array, offset: number): SubSyndrome {
		const sub = new SubSyndrome(this as never, subSyndromeKey(mask, offset), mask, offset);
		sub.id = id;
		// `subsyndromes_by_id` may have holes if an earlier id was queried
		// without a SubSyndrome being needed at that time — fine, sparse
		// arrays still index correctly.
		while (this.subsyndromes_by_id.length <= id) this.subsyndromes_by_id.push(undefined as never);
		this.subsyndromes_by_id[id] = sub;
		return sub;
	}

	/** Optional WASM-backed registry. Wired by `WorkerSim.boot` when the
	 * WASM module loads successfully. Stays `null` in test/jsdom contexts
	 * where the WASM file can't be served. */
	subsynWasm: import('../sim/gpu/subsynRegistryWasm').SubsynRegistryWasm | null = null;

	/**
	 * Materialize CPU SubSyndromes for all WASM-assigned ids in
	 * `[fromId, toId)` that don't yet have an object. Used by the batched
	 * post-pass to catch up after `processPostPass` allocates new ids on
	 * the WASM side. Caller passes a scratch 4-word Uint32Array; the same
	 * buffer is reused for every id.
	 */
	materializeSubsynRange(fromId: number, toId: number, scratchMask: Uint32Array): void {
		const wasm = this.subsynWasm;
		if (wasm === null) return;
		while (this.subsyndromes_by_id.length < toId) {
			this.subsyndromes_by_id.push(undefined as never);
		}
		for (let id = fromId; id < toId; id++) {
			if (this.subsyndromes_by_id[id] !== undefined) continue;
			wasm.getMaskAtId(id, scratchMask, 0);
			const sub = new SubSyndrome(this as never, subSyndromeKey(scratchMask, 0), scratchMask, 0);
			sub.id = id;
			this.subsyndromes_by_id[id] = sub;
		}
	}

	/**
	 * Legacy entry point — kept for callers that already have trait_keys /
	 * trait_states in hand (scenario init via Population.computeFromStates,
	 * pre-mask code paths). The `legacyKey` argument is ignored; the
	 * canonical mask key is derived from `trait_keys` (filtered to states ===
	 * 1, matching set-only encoding).
	 */
	materializeSubSyndrome(
		_legacyKey: string,
		trait_keys: string[],
		trait_states: Record<string, number>
	): SubSyndrome {
		const setKeys: string[] = [];
		for (const k of trait_keys) {
			if (trait_states[k] === 1) setKeys.push(k);
		}
		const mask = buildTraitMask(this as never, setKeys);
		return this.materializeSubSyndromeByMask(mask, 0);
	}

	/**
	 * Assign a stable integer ID to a Population and register it in
	 * `populations_by_id`. Called by Site.addPop right after Population
	 * construction. ID assignment is monotonic and never reused.
	 */
	registerPopulation(pop: PopulationLike & { id: number }): void {
		pop.id = this.populations_by_id.length;
		this.populations_by_id.push(pop);
	}

	/**
	 * Assign a stable integer ID to a Stockpile and register it in
	 * `stockpiles_by_id`. Called from Stockpile creation paths.
	 */
	registerStockpile(stockpile: StockpileLike & { id: number }): void {
		stockpile.id = this.stockpiles_by_id.length;
		this.stockpiles_by_id.push(stockpile);
	}

	getSyndrome(trait_keys: string[]): SyndromeLike {
		const key = trait_keys.join('.');
		if (this.syndromes_kv[key]) {
			return this.syndromes_kv[key];
		}

		const traits: TraitLike[] = [];
		for (const tk of trait_keys) {
			traits.push(this.getTrait(tk));
		}

		const eval_traits = this.evalTraits(traits);
		const new_key = this.getSyndromeKey(eval_traits);

		if (this.syndromes_kv[new_key]) {
			this.syndromes_kv[key] = this.syndromes_kv[new_key];
			return this.syndromes_kv[new_key];
		}

		const syndrome = createSyndrome!(this, eval_traits, new_key);
		this.syndromes.push(syndrome);
		this.syndromes_kv[key] = this.syndromes_kv[new_key] = syndrome;
		return syndrome;
	}

	addTrait(trait: TraitLike): TraitLike {
		if (this.traits_kv[trait.key]) throw new Error("Duplicate trait key: " + trait.key);
		this.traits_kv[trait.key] = trait;
		trait.index = this.traits.length;
		this.traits.push(trait);
		trait.init();
		return trait;
	}

	addVector(vector: VectorLike): VectorLike {
		if (this.vectors_kv[vector.key]) throw new Error("Duplicate vector key: " + vector.key);
		this.vectors_kv[vector.key] = vector;
		this.vectors.push(vector);
		return vector;
	}

	addResource(resource: ResourceLike): ResourceLike {
		if (this.resources_kv[resource.key]) throw new Error("Duplicate resource key: " + resource.key);
		this.resources_kv[resource.key] = resource;
		this.resources.push(resource);
		this.addStockpiles(resource);
		return resource;
	}

	addGlobalStockpile(resource: ResourceLike): void {
		if (!createStockpile) return;
		const value = createStockpile(resource, this, resource.value);
		this.registerStockpile(value as StockpileLike & { id: number });
		this.global_stockpiles.push(value);
		this.global_stockpiles_kv[resource.key] = value;
		this.all_stockpiles.push(value);
	}

	addStockpiles(resource: ResourceLike): void {
		if (resource.global) {
			this.addGlobalStockpile(resource);
		} else {
			for (const site of this.sites) {
				if (!site.local_stockpiles_kv[resource.key] && createStockpile) {
					const value = createStockpile(resource, site, resource.value);
					this.registerStockpile(value as StockpileLike & { id: number });
					site.local_stockpiles.push(value);
					site.local_stockpiles_kv[resource.key] = value;
					this.all_stockpiles.push(value);
				}
			}
		}
	}

	addToPhase(object: unknown, key: string): IndexedPhaseLike {
		const phase = this.all_phases_kv[key] || this.default_phase;
		const obj = object as { constructor: { name: string } };

		switch (obj.constructor.name) {
			case 'Transmit':
				phase.transmit.push(object as TransmitLike);
				break;
			case 'Progress':
				phase.progress.push(object as ProgressLike);
				break;
			case 'Syndrome':
				phase.syndromes.push(object as SyndromeLike);
				break;
			case 'ImpactProduce':
			case 'ImpactConsume':
				phase.impacts.push(object as ImpactLike);
				break;
			case 'Event':
				phase.events.push(object as EventLike);
				break;
		}
		return phase;
	}

	getGUIBox(key: string): GUIBoxLike | null {
		return this.system.gui?.getGUIBox(key) || null;
	}

	getGUIGroup(key: string): GUIGroupLike {
		if (this.guigroups_kv[key]) return this.guigroups_kv[key];
		return this.addGUIGroup(createGUIGroup!(this, { key }));
	}

	addGUIGroup(guigroup: GUIGroupLike): GUIGroupLike {
		if (this.guigroups_kv[guigroup.key]) throw new Error("Duplicate guigroup key: " + guigroup.key);
		this.guigroups_kv[guigroup.key] = guigroup;
		this.guigroups.push(guigroup);
		return guigroup;
	}

	getFilter(traits_required: TraitLike[], traits_forbidden: TraitLike[]): FilterLike {
		let key = "";
		for (const t of traits_required) key += t.key + '.';
		key += ":";
		for (const t of traits_forbidden) key += t.key + '.';

		if (this.filters_kv[key]) return this.filters_kv[key];

		const f = createFilter!(key, traits_required, traits_forbidden);
		this.filters_kv[key] = f;
		this.filters.push(f);
		return f;
	}

	// ========================================
	// Player-side metrics & correlations
	// ========================================

	/**
	 * Resolve a `${kind}:${key}` tracker reference back to a TrackerLike from
	 * the current world. Returns null if no matching tracker exists (e.g. a
	 * scenario was reloaded that no longer has the underlying trait/resource).
	 */
	private getTrackerByKindKey(kindKey: string): TrackerLike | null {
		const idx = kindKey.indexOf(':');
		if (idx < 0) return null;
		const kind = kindKey.slice(0, idx);
		const key = kindKey.slice(idx + 1);
		switch (kind) {
			case 'trait': return this.trait_trackers_kv[key] ?? null;
			case 'resource': return this.resource_trackers_kv[key] ?? null;
			case 'metric': return this.metric_trackers_kv[key] ?? null;
		}
		return null;
	}

	/**
	 * Convert a serialized expression (SerializedExprValue[]) back into a live
	 * Expression. TrackerCalcSpec entries are rebound to this world's
	 * trackers; missing references are dropped (the metric's grayed_out flag
	 * will reflect the broken dep on the next recompute).
	 */
	rebuildExpressionFromSerialized(serialized: SerializedExprValue[]): Expression {
		const values: ExpressionValue[] = [];
		for (const sv of serialized) {
			values.push(this.rebuildExprValue(sv));
		}
		return new Expression(this as never, values);
	}

	private rebuildExprValue(sv: SerializedExprValue): ExpressionValue {
		// Nested expression
		if (Array.isArray(sv.value)) {
			const inner: ExpressionValue[] = [];
			for (const child of sv.value) inner.push(this.rebuildExprValue(child));
			return new ExpressionValue(this as never, sv.type, sv.subtype, inner);
		}
		// TrackerCalc reference
		if (sv.value && typeof sv.value === 'object' && (sv.value as TrackerCalcSpec).__trackerCalc) {
			const spec = sv.value as TrackerCalcSpec;
			const tracker = this.getTrackerByKindKey(spec.trackerKindKey);
			if (!tracker) {
				// Broken reference — substitute a literal 0 so the expression
				// still parses. The dep-key list keeps the original kind/key
				// so visibility logic can flag the metric as grayed_out.
				return new ExpressionValue(this as never, sv.type, 'num', 0);
			}
			const tc = new TrackerCalc(tracker as never, {
				neg_offset: spec.neg_offset,
				offset: spec.offset,
				incdec: spec.incdec as never,
				calc: spec.calc,
			});
			return new ExpressionValue(this as never, sv.type, sv.subtype, tc);
		}
		// Primitive
		return new ExpressionValue(this as never, sv.type, sv.subtype, sv.value as never);
	}

	/**
	 * Walk an Expression's parsed tree and collect every TrackerCalc reference
	 * as a `${kind}:${key}` string. Used to populate `metric.dep_tracker_keys`
	 * and the reverse-index on each referenced trait/resource.
	 */
	private collectDepKeys(values: ExpressionValueLike[] | unknown): string[] {
		const out = new Set<string>();
		const walk = (vs: unknown[]): void => {
			for (const v of vs) {
				const ev = v as ExpressionValueLike & { value: unknown; subtype: string | null };
				if (Array.isArray(ev.value)) {
					walk(ev.value);
					continue;
				}
				if (ev.subtype === 'tracker' && ev.value && typeof ev.value === 'object') {
					const tc = ev.value as { tracker?: { type: number; key: string } };
					if (tc.tracker) {
						const t = tc.tracker;
						const kind = t.type === 2 ? 'resource' : t.type === 3 ? 'metric' : 'trait';
						out.add(`${kind}:${t.key}`);
					}
				}
			}
		};
		walk(values as unknown[]);
		return [...out];
	}

	/**
	 * Replay `custom_metrics_prev` and `custom_traits_prev` into this world.
	 * Both fields are populated by the harness (WorkerSim) before start() so
	 * player-created metrics/correlations survive a scenario reset.
	 *
	 * For metrics: serialized expression_data is rebound to the new world's
	 * trackers via rebuildExpressionFromSerialized. The previous CustomMetric
	 * instance is reused (its base_key is overwritten by addMetric).
	 *
	 * For correlations: the data snapshot is fed back through addCorrelationTrait
	 * which generates a new `#custom${i}` key in the new world.
	 */
	private replayCustomMetricsAndCorrelations(): void {
		const prevMetrics = this.custom_metrics_prev;
		if (prevMetrics && prevMetrics.length > 0) {
			for (const metric of prevMetrics) {
				const cm = metric as unknown as {
					expression_data?: SerializedExprValue[];
					expression?: ExpressionLike;
					dep_tracker_keys?: string[];
				};
				// Force a rebuild against the new world's tracker registry.
				if (cm.expression_data && cm.expression_data.length > 0) {
					cm.expression = this.rebuildExpressionFromSerialized(cm.expression_data) as unknown as ExpressionLike;
				}
				cm.dep_tracker_keys = [];
				(metric as unknown as { world: World }).world = this;
				this.addMetric(metric as unknown as CustomMetric);
			}
		}
		this.custom_metrics_prev = undefined;

		const prevTraits = this.custom_traits_prev as Array<{ kind?: string; data?: Record<string, unknown> }> | undefined;
		if (prevTraits && prevTraits.length > 0) {
			// Reset the index so re-creation produces deterministic keys.
			this.custom_traits_index = 0;
			for (const entry of prevTraits) {
				if (entry?.kind === 'correlation' && entry.data) {
					try {
						this.addCorrelationTrait(entry.data);
					} catch (err) {
						console.warn('Failed to replay correlation trait', err);
					}
				}
			}
		}
		this.custom_traits_prev = undefined;
	}

	/** Resolve a `${kind}:${key}` to its underlying object (Trait | Resource | CustomMetric). */
	private resolveRefObject(kindKey: string): { kind: string; obj: unknown } | null {
		const idx = kindKey.indexOf(':');
		if (idx < 0) return null;
		const kind = kindKey.slice(0, idx);
		const key = kindKey.slice(idx + 1);
		switch (kind) {
			case 'trait': return { kind, obj: this.traits_kv[key] };
			case 'resource': return { kind, obj: this.resources_kv[key] };
			case 'metric': return { kind, obj: (this.metric_trackers_kv[key] as { metric?: unknown } | undefined)?.metric };
		}
		return null;
	}

	/**
	 * Attach a metric/correlation reference to each of its dependencies'
	 * reverse-index arrays. `dependent` is either a CustomMetric or a Trait
	 * (for correlations).
	 */
	private addDependents(deps: string[], dependent: unknown, list: 'referenced_by_metrics' | 'referenced_by_correlations'): void {
		for (const dep of deps) {
			const r = this.resolveRefObject(dep);
			if (!r || !r.obj) continue;
			const arr = (r.obj as Record<string, unknown[] | undefined>)[list];
			if (Array.isArray(arr) && !arr.includes(dependent)) arr.push(dependent);
		}
	}

	private removeDependents(deps: string[], dependent: unknown, list: 'referenced_by_metrics' | 'referenced_by_correlations'): void {
		for (const dep of deps) {
			const r = this.resolveRefObject(dep);
			if (!r || !r.obj) continue;
			const arr = (r.obj as Record<string, unknown[] | undefined>)[list];
			if (!Array.isArray(arr)) continue;
			const i = arr.indexOf(dependent);
			if (i !== -1) arr.splice(i, 1);
		}
	}

	/**
	 * Walk every custom metric and recompute `grayed_out` based on whether
	 * any of its dependencies are hidden. Should be called after any change
	 * to tracker visibility (event-driven `resource_vis`, player toggle, or
	 * dependency add/remove). Cheap — O(metrics × deps).
	 */
	recomputeMetricGrayout(): void {
		for (const m of this.custom_metrics) {
			const cm = m as unknown as { dep_tracker_keys: string[]; grayed_out: boolean };
			let grayed = false;
			for (const dep of cm.dep_tracker_keys || []) {
				const r = this.resolveRefObject(dep);
				if (!r || !r.obj) { grayed = true; break; }
				const obj = r.obj as { hidden?: boolean };
				if (obj.hidden) { grayed = true; break; }
			}
			cm.grayed_out = grayed;
		}
	}

	/**
	 * Add a player-created CustomMetric to the world. Mirrors legacy
	 * `World.addMetric` (script.js:3582). Also populates the dependency
	 * reverse-index so deletion of a referenced trait/resource can switch
	 * to hide-and-retain semantics.
	 *
	 * Returns the registered metric (same instance, with `index` and
	 * `base_key` set).
	 */
	addMetric(metric: CustomMetric, options?: { forceBaseKey?: string }): CustomMetric {
		// `forceBaseKey` lets an edit replace a metric while keeping the same
		// id, so other metrics whose expressions reference `metric:${baseKey}`
		// stay connected. The auto-incrementing counter is left alone in that
		// case so future fresh additions still get unique ids.
		if (options?.forceBaseKey !== undefined) {
			metric.base_key = options.forceBaseKey;
		} else {
			metric.base_key = String(this.custom_metrics_index);
		}
		(metric as unknown as { key: string }).key = metric.base_key;
		metric.index = this.custom_metrics.length;

		// Build the Expression now if it wasn't already provided. The serialized
		// `expression_data` is the source of truth across reset.
		if (!metric.expression && metric.expression_data && metric.expression_data.length > 0) {
			metric.expression = this.rebuildExpressionFromSerialized(metric.expression_data);
		}
		// Collect dependency keys so we can reverse-index AND so the gray-out
		// recomputation has somewhere to look.
		if (metric.expression) {
			metric.dep_tracker_keys = this.collectDepKeys(metric.expression.values);
			this.addDependents(metric.dep_tracker_keys, metric, 'referenced_by_metrics');
		}

		this.custom_metrics.push(metric as unknown as MetricLike);

		if (createTracker) {
			const tracker = createTracker(this, metric as unknown as MetricLike);
			this.metric_trackers_kv[metric.base_key] = tracker;
			this.trackers.push(tracker);

			if (createHistory) {
				const globalHist = createHistory(this, tracker);
				this.metric_hist.push(globalHist);
				this.metric_hist_kv[metric.base_key] = globalHist;
				this.updateMetricHistory(globalHist);

				for (const site of this.sites) {
					const localHist = createHistory(site, tracker);
					site.metric_hist.push(localHist);
					site.metric_hist_kv[metric.base_key] = localHist;
					this.updateMetricHistory(localHist);
				}
			}
		}

		if (options?.forceBaseKey === undefined) this.custom_metrics_index++;
		this.recomputeMetricGrayout();
		return metric;
	}

	/**
	 * Replay a metric's expression across days [0, age) and write the values
	 * into its History. Mirrors legacy `World.updateMetricHistory` (3603).
	 */
	private updateMetricHistory(hist: HistoryLike): void {
		const tracker = (hist as unknown as { tracker: { metric?: { expression?: ExpressionLike } } }).tracker;
		const expression = tracker.metric?.expression;
		if (!expression) return;
		const h = hist as unknown as {
			site: SiteLike | null;
			current: number;
			current_inc: number;
			current_dec: number;
			val: number[];
			val_inc: number[];
			val_dec: number[];
			started: boolean;
			startRecord(d?: number): void;
			addCurrentVal(): void;
		};
		h.startRecord(0);
		for (let day = 0; day < this.age; day++) {
			const current = expression.evaluate(h.site, day);
			if (current > h.current) h.current_inc += current - h.current;
			else h.current_dec += h.current - current;
			h.current = current;
			h.addCurrentVal();
		}
	}

	/**
	 * Remove a player-created metric and all its histories. Mirrors legacy
	 * `World.removeCustomMetric` (3619). Also tears down the reverse-index
	 * entries so a previously hide-retained dependency can be cleaned up.
	 */
	removeCustomMetric(metric: MetricLike | CustomMetric | unknown): void {
		const m = metric as unknown as { base_key: string; dep_tracker_keys?: string[] };
		if (!m || !m.base_key) return;

		removeFromWhere(this.custom_metrics, e => e === metric);
		removeFromWhere(this.metric_hist, e => (e as { tracker?: { metric?: unknown } }).tracker?.metric === metric);
		delete this.metric_hist_kv[m.base_key];
		delete this.metric_trackers_kv[m.base_key];

		for (const site of this.sites) {
			removeFromWhere(site.metric_hist, e => (e as { tracker?: { metric?: unknown } }).tracker?.metric === metric);
			delete site.metric_hist_kv[m.base_key];
		}

		removeFromWhere(this.trackers, e => (e as { metric?: unknown }).metric === metric);

		// Re-index remaining metrics for stable display order.
		for (let i = 0; i < this.custom_metrics.length; i++) {
			(this.custom_metrics[i] as { index: number }).index = i;
		}

		// Drop reverse-index entries so a hide-retained trait/resource can
		// finalize its deletion when the last dependent goes away.
		if (m.dep_tracker_keys) {
			this.removeDependents(m.dep_tracker_keys, metric, 'referenced_by_metrics');
		}
	}

	/**
	 * Add a player-created correlation as a real Trait. Mirrors legacy
	 * `World.addCorrelationTrait` (3702): builds a fresh Trait from the
	 * supplied data, runs it through the combo machinery, re-evaluates every
	 * existing Syndrome to see which now include the new trait, then
	 * retroactively rebuilds history from the per-population value arrays.
	 *
	 * The `data` is a plain trait spec (def_and / def_not / def_or / require /
	 * forbid + name + color + guigroup). `key` is generated automatically.
	 *
	 * Returns the new Trait (added to this.traits, this.combo_traits,
	 * this.ordered_traits, with a Tracker attached).
	 */
	addCorrelationTrait(data: Record<string, unknown>, options?: { forceKey?: string }): TraitLike {
		// `forceKey` is used by edits so the replacement trait preserves the
		// original id, keeping other readouts that reference it connected.
		let forcedKey: string | null = null;
		if (options?.forceKey !== undefined) {
			forcedKey = options.forceKey;
		} else {
			this.custom_traits_index++;
		}
		const traitData = { ...data, key: forcedKey ?? `#custom${this.custom_traits_index}` };
		const trait = createTrait!(this as never, traitData) as TraitLike & {
			is_correlation: boolean;
			tracker: TrackerLike | null;
		};
		trait.is_correlation = true;

		this.addTrait(trait);
		trait.addAsCombo();
		this.combo_traits.push(trait);
		this.ordered_traits.push(trait);

		// Tracker + per-site Histories (legacy 3713-3726).
		const tracker = createTracker!(this, trait);
		this.trackers.push(tracker);
		this.trait_trackers_kv[trait.base_key] = tracker;
		trait.tracker = tracker;

		const globalHist = createHistory!(this, tracker);
		this.trait_hist.push(globalHist);
		this.trait_hist_kv[trait.base_key] = globalHist;

		const siteHistByKey: Record<string, HistoryLike> = {};
		for (const site of this.sites) {
			const hist = createHistory!(site, tracker);
			site.trait_hist.push(hist);
			site.trait_hist_kv[trait.base_key] = hist;
			siteHistByKey[site.key] = hist;
		}

		// Re-evaluate syndromes; mutate the matching ones in-place to add the
		// new trait. (Legacy 3729-3754.)
		let earliest_day = this.age + 1;
		const changed_pops: PopulationLike[] = [];
		for (const syn of this.syndromes) {
			const old_key = syn.key;
			const eval_traits = this.evalTraits(syn.base_traits);
			if (eval_traits.length > syn.traits.length) {
				const new_key = this.getSyndromeKey(eval_traits);
				syn.construct(eval_traits, new_key);
				this.syndromes_kv[new_key] = syn;
				for (const site of this.sites) {
					const pop = site.pops_kv[old_key] as PopulationLike & {
						hist: HistoryLike[];
						start: number;
					};
					if (pop) {
						site.pops_kv[new_key] = pop;
						changed_pops.push(pop);
						pop.hist.push(siteHistByKey[site.key]);
						if (pop.start < earliest_day) earliest_day = pop.start;
					}
				}
			}
		}

		// Retroactive history rebuild (legacy 3756-3807). Sums each changed
		// pop's per-day values into the new histories.
		if (changed_pops.length > 0) {
			const siteAccum: Record<string, { val: number; inc: number; dec: number; hist: HistoryLike }> = {};
			for (const site of this.sites) {
				siteAccum[site.key] = { val: 0, inc: 0, dec: 0, hist: siteHistByKey[site.key] };
			}

			for (let day = earliest_day; day <= this.age; day++) {
				let total_val = 0, total_inc = 0, total_dec = 0;
				for (const site of this.sites) {
					const acc = siteAccum[site.key];
					acc.val = acc.inc = acc.dec = 0;
				}
				for (const pop of changed_pops) {
					const p = pop as PopulationLike & { val_inc: number[]; val_dec: number[]; site: SiteLike };
					const idx = pop.getDateIndex(day);
					if (idx < 0) continue;
					const acc = siteAccum[p.site.key];
					acc.val += pop.val[idx];
					acc.inc += p.val_inc[idx];
					acc.dec += p.val_dec[idx];
				}
				for (const site of this.sites) {
					const acc = siteAccum[site.key];
					const hist = acc.hist as HistoryLike & {
						started: boolean; start: number;
						val: number[]; val_inc: number[]; val_dec: number[];
						current: number;
					};
					if (!hist.started && (acc.val > 0 || acc.inc > 0 || acc.dec > 0)) {
						const gh = globalHist as HistoryLike & { started: boolean };
						if (!gh.started) (globalHist as HistoryLike).startRecord(day);
						hist.startRecord(day);
					}
					if (hist.started) {
						if (day < this.age) {
							hist.val.push(acc.val);
							hist.val_inc.push(acc.inc);
							hist.val_dec.push(acc.dec);
						}
						hist.current = acc.val;
						total_val += acc.val;
						total_inc += acc.inc;
						total_dec += acc.dec;
					}
				}
				const gh = globalHist as HistoryLike & {
					started: boolean;
					val: number[]; val_inc: number[]; val_dec: number[];
					current: number;
				};
				if (gh.started) {
					if (day < this.age) {
						gh.val.push(total_val);
						gh.val_inc.push(total_inc);
						gh.val_dec.push(total_dec);
					}
					gh.current = total_val;
				}
			}
		}

		// Reverse-index: this correlation depends on every trait it references.
		const traitData2 = data as { def_and?: string[]; def_not?: string[]; def_or?: string[]; require?: string[]; forbid?: string[] };
		const refKeys = [
			...(traitData2.def_and || []),
			...(traitData2.def_not || []),
			...(traitData2.def_or || []),
			...(traitData2.require || []),
			...(traitData2.forbid || []),
		];
		const depKeys: string[] = [];
		for (const k of refKeys) {
			if (this.traits_kv[k]) depKeys.push(`trait:${k}`);
		}
		(trait as unknown as { dep_tracker_keys: string[] }).dep_tracker_keys = depKeys;
		this.addDependents(depKeys, trait, 'referenced_by_correlations');

		// Track in custom_traits so reset can replay (data, not the live obj).
		// `key` is held alongside the data so removeCustomTrait can match it
		// without depending on Trait → snapshot identity.
		this.custom_traits.push({ kind: 'correlation', key: trait.key, data: { ...data } });

		this.recomputeMetricGrayout();
		return trait;
	}

	/**
	 * Remove a player-created correlation. Symmetric to addCorrelationTrait —
	 * this is best-effort: we drop the trait from the current world's tracker
	 * and history lists so it disappears from the UI, and we drop the
	 * `custom_traits` snapshot so reset doesn't recreate it. Existing
	 * populations keep the trait state for the rest of the run; deleting a
	 * correlation does NOT retroactively remove it from syndromes.
	 */
	removeCustomTrait(trait: TraitLike): void {
		const t = trait as TraitLike & { dep_tracker_keys?: string[]; is_correlation?: boolean };
		if (!t.is_correlation) return;

		// Drop from tracker/history collections so the UI stops showing it.
		removeFromWhere(this.trait_hist, e => (e as { tracker?: { trait?: unknown } }).tracker?.trait === trait);
		delete this.trait_hist_kv[trait.base_key];
		delete this.trait_trackers_kv[trait.base_key];
		removeFromWhere(this.trackers, e => (e as { trait?: unknown }).trait === trait);
		for (const site of this.sites) {
			removeFromWhere(site.trait_hist, e => (e as { tracker?: { trait?: unknown } }).tracker?.trait === trait);
			delete site.trait_hist_kv[trait.base_key];
		}

		// Reverse-index cleanup so hidden traits/resources can finalize cleanup.
		if (t.dep_tracker_keys) {
			this.removeDependents(t.dep_tracker_keys, trait, 'referenced_by_correlations');
		}

		// Remove from custom_traits snapshot — match by the trait's runtime key,
		// not by data identity (data is a snapshot, not a reference).
		removeFromWhere(this.custom_traits as unknown[], (e) => {
			const entry = e as { kind?: string; key?: string } | null;
			return !!entry && entry.kind === 'correlation' && entry.key === trait.base_key;
		});
		this.recomputeMetricGrayout();
	}

	// ========================================
	// Combo/Trait Evaluation
	// ========================================

	initCombos(): TraitLike[] {
		const base_traits: TraitLike[] = [];
		const combo_traits: TraitLike[] = [];
		const ordered_traits: TraitLike[] = [];

		for (const trait of this.traits) {
			trait.req_count = trait.def_and.length + trait.def_not.length + trait.def_or.length;
			if (trait.req_count === 0) {
				base_traits.push(trait);
				ordered_traits.push(trait);
			} else {
				trait.addAsCombo();
			}
		}

		for (let i = 0; i < ordered_traits.length; i++) {
			const trait = ordered_traits[i];
			for (const combo of trait.req_by) {
				combo.req_by_exists++;
				if (combo.req_by_exists === combo.req_count) {
					combo_traits.push(combo);
					ordered_traits.push(combo);
				}
			}
		}

		this.base_traits = base_traits;
		this.ordered_traits = ordered_traits;
		this.combo_traits = combo_traits;
		return ordered_traits;
	}

	evalTraits(basetraits: TraitLike[]): TraitLike[] {
		const response_traits: TraitLike[] = [];
		const must_be_reset = new Set<TraitLike>();

		for (const trait of basetraits) {
			this.evalTraitCombos(trait, response_traits, must_be_reset);
		}

		for (const trait of this.combo_traits) {
			if (trait.and_combo === trait.def_and.length &&
				trait.or_valid === true &&
				trait.not_valid === false) {
				this.evalTraitCombos(trait, response_traits, must_be_reset);
			}
		}

		must_be_reset.forEach(trait => trait.resetCombo());
		return response_traits.sort((a, b) => a.index - b.index);
	}

	evalTraitCombos(trait: TraitLike, response_traits: TraitLike[], must_be_reset: Set<TraitLike>): boolean {
		for (const combo of trait.req_by_and) {
			combo.and_combo++;
			must_be_reset.add(combo);
		}
		for (const combo of trait.req_by_or) {
			combo.or_valid = true;
			must_be_reset.add(combo);
		}
		for (const combo of trait.req_by_not) {
			combo.not_valid = true;
			must_be_reset.add(combo);
		}
		response_traits.push(trait);
		return true;
	}

	getSyndromeKey(traits: TraitLike[]): string {
		const keys = traits.map(t => t.key).sort();
		return keys.join('.');
	}

	initClusters(): ClusterLike[][] {
		for (const trait of this.traits) {
			trait.initLinkedTraits();
		}

		const levels: TraitLike[][] = [[]];
		for (const trait of this.traits) {
			levels[0].push(trait);
		}

		let l = 0;
		while (l < levels.length) {
			const level = levels[l];
			let most_links = 0;
			let most_links_trait: TraitLike | null = null;
			let most_links_index = -1;

			if (level.length > 1) {
				for (let i = 0; i < level.length; i++) {
					const trait = level[i];
					let links = 0;
					for (const other of level) {
						if (trait.linked_traits_kv[other.key] !== undefined) {
							links++;
						}
					}
					if (links > most_links) {
						most_links_trait = trait;
						most_links = links;
						most_links_index = i;
					}
				}
			}

			if (most_links_trait !== null) {
				if (levels.length === l + 1) {
					levels.push([]);
				}
				levels[l + 1].push(most_links_trait);
				level.splice(most_links_index, 1);
			} else {
				l++;
			}
		}

		const clusters: ClusterLike[][] = [];
		for (let i = levels.length - 1, level = 0; i >= 0; i--) {
			const level_clusters: ClusterLike[] = [];
			for (let j = levels[i].length - 1; j >= 0; j--) {
				const trait = levels[i][j];
				trait.cluster_level = level;
				if (createCluster) {
					level_clusters.push(createCluster(trait, level));
				}
			}
			clusters.push(level_clusters);
			level++;
		}

		// Assign relevant clusters to transmit/progress
		const transmit_and_progress = [...this.all_transmit, ...this.all_progress];
		for (const object of transmit_and_progress) {
			for (const cluster_level of clusters) {
				let relevant_cluster: ClusterLike | null = null;
				for (const cluster of cluster_level) {
					if (object.linked_traits_kv[cluster.trait.key]) {
						relevant_cluster = cluster;
						break;
					}
				}
				object.relevant_clusters.push(relevant_cluster);
			}
		}

		return clusters;
	}

	// ========================================
	// Player Actions
	// ========================================

	validatePlayerActions(): void {
		for (const action of this.all_actions) {
			action.updateCosts();
			action.current_value = action.desired_value;
		}

		let actions_to_check = new Set(this.all_actions);
		const all_changed_actions = new Set<PlayerActionLike>();
		let changed_action = true;

		while (changed_action) {
			const next_actions = new Set<PlayerActionLike>();
			changed_action = false;

			for (const action of actions_to_check) {
				if (action.updateCap()) {
					all_changed_actions.add(action);
				}
				if (action.reduceIfOverCap()) {
					const [, actions_changed] = action.updateCostsAndStockpiles();
					for (const a of actions_changed) next_actions.add(a);
					changed_action = true;
				}
			}
			actions_to_check = next_actions;
		}

		for (const action of all_changed_actions) {
			action.updateInfoDisplay();
		}

		for (const stockpile of this.all_stockpiles) {
			stockpile.setAdjustedValue();
		}
	}

	performPlayerActions(): void {
		this.validatePlayerActions();

		// At day-start, reset current_value:
		//   - actions WITHOUT cost entries keep their desired value (player's
		//     selection takes effect immediately, no consumption gating)
		//   - actions WITH cost entries start at 0; the per-phase cost stage
		//     in updateAllPhases sets current_value to the actually-afforded
		//     amount when the cost phase runs
		// Stockpile draining no longer happens here — it moves into the
		// phase loop alongside produce evaluation. Likewise transmit
		// scheduling is deferred to each phase's start (see
		// `applyActionCostsAndScheduleTransmits`).
		for (const action of this.all_actions) {
			if (action.cost.length === 0) {
				action.current_value = action.desired_value;
			} else {
				action.current_value = 0;
			}
			action.actual_value = action.current_value;
			for (const cost of action.cost) cost.updateValue(action.actual_value);
			for (const produce of action.produce) produce.updateValue(action.actual_value);
		}
		for (const stockpile of this.all_stockpiles) {
			stockpile.setAdjustedValue();
		}
	}

	/**
	 * Allocate scarce resources across all actions whose cost entries fire on
	 * `phase_index`, drain the stockpiles, and set each action's current_value
	 * to how much it was actually able to afford.
	 *
	 * Per resource: if demand ≤ available, every action gets exactly its
	 * desired amount. Otherwise we scale proportionally and floor to integer
	 * action units, distributing leftover units one-by-one to the actions
	 * with the largest fractional remainder (tiebreak by action key for
	 * determinism). Resources flagged `signed` (allowed to go negative) are
	 * not capped; the action gets its full desired amount and the stockpile
	 * drains into the negatives.
	 *
	 * An action with multiple cost entries on this phase takes the minimum
	 * across them (you only get to consume as much as the scarcest resource
	 * permits). Stockpiles are drained by `current_value × cost.value`.
	 *
	 * After draining, transmit slots whose phase matches are scheduled with
	 * the freshly-set current_value.
	 */
	applyActionCostsAndScheduleTransmits(phase_index: number): void {
		// Build a map of stockpile → list of {action, cost} requests on this phase.
		const requestsByStockpile = new Map<unknown, Array<{ action: PlayerActionLike; cost: ActionCostLike }>>();
		const actionsWithCostHere = new Set<PlayerActionLike>();
		for (const action of this.all_actions) {
			for (const cost of action.cost) {
				if (cost.phase_index !== phase_index) continue;
				if (!cost.stockpile) continue;
				if (cost.value <= 0) continue;
				actionsWithCostHere.add(action);
				let arr = requestsByStockpile.get(cost.stockpile);
				if (!arr) {
					arr = [];
					requestsByStockpile.set(cost.stockpile, arr);
				}
				arr.push({ action, cost });
			}
		}

		// Per-stockpile allocation (action-units allocated to each action for
		// this stockpile only). The action's final current_value is the min
		// across all of its stockpile allocations.
		const perActionStockpileAlloc = new Map<PlayerActionLike, number>();
		for (const [stockpile, requests] of requestsByStockpile) {
			const sp = stockpile as { value: number; resource: { signed?: boolean } };
			const stored = sp.value;
			let totalDemand = 0;
			for (const { action, cost } of requests) {
				totalDemand += action.desired_value * cost.value;
			}
			const oversubscribed = !sp.resource.signed && totalDemand > stored && stored >= 0;
			let allocations: Array<{ action: PlayerActionLike; cost: ActionCostLike; alloc: number; frac: number }>;
			if (!oversubscribed) {
				allocations = requests.map(r => ({ ...r, alloc: r.action.desired_value, frac: 0 }));
			} else {
				const scale = totalDemand > 0 ? stored / totalDemand : 0;
				let unitsAllocated = 0;
				allocations = requests.map(r => {
					const fairUnits = r.action.desired_value * scale;
					const wholeUnits = Math.max(0, Math.floor(fairUnits));
					unitsAllocated += wholeUnits * r.cost.value;
					return { ...r, alloc: wholeUnits, frac: fairUnits - wholeUnits };
				});
				let leftover = stored - unitsAllocated;
				// Largest-remainder distribution: action key tiebreak so the
				// allocation is order-independent.
				const sorted = [...allocations].sort((a, b) => {
					if (b.frac !== a.frac) return b.frac - a.frac;
					return a.action.key < b.action.key ? -1 : a.action.key > b.action.key ? 1 : 0;
				});
				for (const a of sorted) {
					if (leftover < a.cost.value) break;
					if (a.alloc + 1 > a.action.desired_value) continue;
					a.alloc += 1;
					leftover -= a.cost.value;
				}
			}
			for (const a of allocations) {
				const cur = perActionStockpileAlloc.get(a.action);
				if (cur === undefined || a.alloc < cur) {
					perActionStockpileAlloc.set(a.action, a.alloc);
				}
			}
		}

		// Apply per-action allocation: current_value = min across its costs.
		for (const action of actionsWithCostHere) {
			const alloc = perActionStockpileAlloc.get(action) ?? 0;
			action.current_value = alloc;
			action.actual_value = alloc;
			for (const cost of action.cost) cost.updateValue(alloc);
			for (const produce of action.produce) produce.updateValue(alloc);
		}

		// Drain stockpiles by the actually-allocated amounts.
		for (const [stockpile, requests] of requestsByStockpile) {
			let drain = 0;
			for (const { action, cost } of requests) {
				drain += action.current_value * cost.value;
			}
			if (drain === 0) continue;
			const sp = stockpile as {
				value: number; value_dec: number;
				updateStockpileHistory(): void;
				onValueChanged?(): void;
			};
			sp.value -= drain;
			sp.value_dec += drain;
			sp.updateStockpileHistory();
			sp.onValueChanged?.();
		}
		for (const stockpile of this.all_stockpiles) {
			stockpile.setAdjustedValue();
		}

		// Schedule transmissions for this phase now that current_value is final.
		for (const site of this.sites) {
			for (const action of this.global_actions) {
				action.finalizeActionTransmission(site, phase_index);
			}
			for (const action of site.actions) {
				action.finalizeActionTransmission(site, phase_index);
			}
		}
	}

	/**
	 * Apply produce entries whose phase matches `phase_index`. Each produce
	 * adds `current_value × produce.value + N(0, produce.sd)` to its
	 * stockpile; negative `value` drains. RNG is seeded by
	 * (worldSeed, day, phase, action, resource) so the noise stream is
	 * reproducible and order-independent.
	 */
	applyActionProducesForPhase(phase_index: number, seed: number, day: number): void {
		const stockpilesTouched = new Set<unknown>();
		for (const action of this.all_actions) {
			for (const produce of action.produce) {
				if (produce.phase_index !== phase_index) continue;
				if (!produce.stockpile) continue;
				if (action.current_value === 0 && produce.sd === 0) continue;
				const sp = produce.stockpile as {
					value: number; value_inc: number; value_dec: number;
					updateStockpileHistory(): void;
					onValueChanged?(): void;
				};
				const rng = rngStream(seed, day, phase_index, action.key, produce.resource);
				const noise = rng.nextNormal(0, produce.sd);
				const delta = action.current_value * produce.value + noise;
				if (delta === 0) continue;
				sp.value += delta;
				if (delta > 0) sp.value_inc += delta;
				else sp.value_dec += -delta;
				stockpilesTouched.add(sp);
				sp.onValueChanged?.();
			}
		}
		for (const sp of stockpilesTouched) {
			(sp as { updateStockpileHistory(): void }).updateStockpileHistory();
		}
		for (const stockpile of this.all_stockpiles) {
			stockpile.setAdjustedValue();
		}
	}

	setAllActionsToValueClosestToDesired(): void {
		for (const action of this.all_actions) {
			if (action.desired_value !== action.current_value) {
				action.change(action.desired_value);
			}
		}
	}

	// ========================================
	// History Updates
	// ========================================

	addCurrentValuesToHistory(): void {
		for (const site of this.sites) {
			site.updateLocalHistory();
		}

		for (const hist of this.trait_hist) {
			hist.addCurrentVal();
		}

		for (const stockpile of this.global_stockpiles) {
			const hist = this.resource_hist_kv[stockpile.resource.key];
			if (stockpile.value !== 0 && !isNaN(stockpile.value) && !hist.started) {
				hist.startRecord();
			}
			if (hist) {
				hist.current = stockpile.value;
				hist.current_inc = stockpile.value_inc;
				hist.current_dec = stockpile.value_dec;
			}
			stockpile.value_inc = stockpile.value_dec = 0;
		}

		for (const hist of this.resource_hist) {
			hist.addCurrentVal();
		}

		for (const hist of this.metric_hist) {
			const current = hist.tracker.metric!.expression.evaluate(null, this.age);
			if (current > hist.current) hist.current_inc += current - hist.current;
			else hist.current_dec += hist.current - current;
			hist.current = current;
			hist.addCurrentVal();
		}
	}

	updateDisplayedHistoryValues(): void {
		this.zeroNegativeStockpiles();

		for (const stockpile of this.all_stockpiles) {
			stockpile.updateStoredValue();
		}

		const all_hists = [this.trait_hist, this.resource_hist, this.metric_hist];
		for (const hlist of all_hists) {
			for (const hist of hlist) {
				hist.updateCurrent();
				hist.updateDisplayIfNeeded();
			}
		}

		for (const site of this.sites) {
			const site_hists = [site.trait_hist, site.resource_hist, site.metric_hist];
			for (const hlist of site_hists) {
				for (const hist of hlist) {
					hist.updateCurrent();
					hist.updateDisplayIfNeeded();
				}
			}
		}
	}

	zeroNegativeStockpiles(): void {
		for (const stockpile of this.all_stockpiles) {
			if (!stockpile.resource.signed && stockpile.value < 0) {
				stockpile.value = 0;
			}
		}
	}

	// ========================================
	// GUI Updates
	// ========================================

	updateGUI(): void {
		for (const action of this.global_actions) {
			action.updateDisplay();
		}

		for (const site of this.sites) {
			site.updateDisplay();
		}

		this.system.date_panel.innerHTML = this.getDateString(this.age);

		if (this.system.site) {
			const site = this.system.site;
			for (const action of site.actions) {
				action.updateDisplay();
			}
			for (const hist of site.trait_hist) hist.updateDisplay();
			for (const hist of site.resource_hist) hist.updateDisplay();
			for (const hist of site.metric_hist) hist.updateDisplay();

			this.system.omniPanel.innerHTML = "";
			if (this.system.omniscient_mode) {
				appendElement('header', 'status-header', this.system.omniPanel,
					'Hidden Data (Complexity: ' + site.pops.length + ')');
				for (const pop of site.pops) {
					const key = pop.syndrome.key || "---";
					appendElement('div', 'omni-status', this.system.omniPanel, key + ': ' + pop.pop);
				}
			}
		} else {
			for (const action of this.global_actions) action.updateDisplay();
			for (const hist of this.trait_hist) hist.updateDisplay();
			for (const hist of this.resource_hist) hist.updateDisplay();
			for (const hist of this.metric_hist) hist.updateDisplay();
		}

		this.system.rerenderGraph();
	}

	removeDisplay(): void {
		this.system.unsetSite();
		for (const hist of this.trait_hist) hist.removeDisplay();
		for (const hist of this.resource_hist) hist.removeDisplay();
		for (const action of this.actions) action.removeDisplay();
		for (const site of this.sites) site.removeDisplay();
	}

	// ========================================
	// Helpers
	// ========================================

	getDateString(age: number): string {
		if (this.use_date) {
			const d = new Date(this.start_timestamp + (age * 86400 * 1000));
			let month = '' + (d.getMonth() + 1);
			let day = '' + d.getDate();
			const year = d.getFullYear();

			if (month.length < 2) month = '0' + month;
			if (day.length < 2) day = '0' + day;

			return [day, month, year].join('-');
		}
		return this.day_string + ' ' + age;
	}

	parseText(text: string, _site?: SiteLike): string {
		const rxp = /{([^}]+)}/g;
		let curMatch;
		let newtext = text;

		while ((curMatch = rxp.exec(newtext))) {
			const key = curMatch[0].slice(1, -1);
			let value = "???";
			const hist = this.getResourceHist(key) || this.getTraitHist(key);
			if (hist) {
				value = hist.getDisplayText();
			}
			newtext = newtext.replace(curMatch[0], value);
		}
		return newtext;
	}

	getTraitHist(key: string): HistoryLike | undefined {
		if (this.trait_hist_kv[key]) return this.trait_hist_kv[key];
		const tracker = this.getTrait(key).tracker;
		if (tracker && createHistory) {
			const hist = createHistory(this, tracker);
			this.trait_hist.push(hist);
			this.trait_hist_kv[tracker.key] = hist;
			return hist;
		}
		return undefined;
	}

	getResourceHist(key: string): HistoryLike | undefined {
		if (this.resource_hist_kv[key]) return this.resource_hist_kv[key];
		const tracker = this.getResource(key).tracker;
		if (tracker && createHistory) {
			const hist = createHistory(this, tracker);
			this.resource_hist.push(hist);
			this.resource_hist_kv[tracker.key] = hist;
			return hist;
		}
		return undefined;
	}

	/**
	 * Look up a metric history by key. Player-side only — there is no
	 * lazy-create path for metrics (unlike traits/resources) because metrics
	 * are explicitly added by the player via `addMetric`.
	 */
	getMetricHist(key: string): HistoryLike | undefined {
		return this.metric_hist_kv[key];
	}

	getAllHist(): HistoryLike[] {
		return [...this.trait_hist, ...this.resource_hist, ...this.metric_hist];
	}

	async addNewsItems(): Promise<void> {
		if (this.news_pending.length > 0) {
			this.system.render();
		}
		// Don't clear here — the worker (workerSim.drainNews) is the owner of
		// the queue and clears it after shipping items in the snapshot. The
		// legacy GUI consumed news_pending in this method directly; the
		// modern split moved that responsibility to the worker so the queue
		// has to survive end-of-day until the next snapshot is built.
	}

	// ========================================
	// Victory/Failure
	// ========================================

	async onVictory(score: number | null, text: string): Promise<void> {
		let message = "<h2 class='center'>SCENARIO COMPLETE</h2>" + text;
		if (score) {
			message += "<br><br><span class='bold'>Score: " + Math.floor(score) + '</span>';
		}

		this.system.loadingDay = false;
		this.scenario_complete = true;
		this.scenario_victory = true;
		this.system.unlockNextLevel();

		await this.system.confirmBox({
			message: this.parseText(message),
			buttons: [
				{
					label: "Replay",
					c: "btn-ok",
					click: () => {
						this.scenario_complete = false;
						this.scenario_victory = false;
						this.system.startWorld();
						return false;
					}
				},
				{
					label: "Next Scenario",
					c: "btn-success",
					click: () => {
						this.system.goToNextLevel();
						return false;
					}
				}
			]
		});
	}

	async onFailure(score: number | null, text: string): Promise<void> {
		let message = "<h2 class='center'>SCENARIO FAILED</h2>" + text;
		if (score) {
			message += "<br><br><span class='bold'>Score: " + Math.floor(score) + '</span>';
		}

		this.system.loadingDay = false;
		this.scenario_complete = true;
		this.scenario_victory = false;

		await this.system.confirmBox({
			message: this.parseText(message),
			buttons: [
				{
					label: "Try Again",
					c: "btn-ok",
					click: () => {
						this.scenario_complete = false;
						this.scenario_victory = false;
						this.system.startWorld();
						return false;
					}
				},
				{
					label: "Examine Data",
					c: "btn-ok",
					click: () => { return false; }
				}
			]
		});
	}
}

export default World;
