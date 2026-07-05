/**
 * Wire protocol between the main thread (SimClient) and the simulation
 * worker. Both sides import these types so message-shape mismatches are
 * caught at compile time.
 *
 * The worker owns the World; the main thread is a thin client that sends
 * commands and observes snapshots. Payloads are JSON-clonable — no
 * transferable buffers in this protocol. SharedArrayBuffer is a B3 concern.
 *
 * The simulation runs **client-side** in a Worker. The split is for
 * organizational clarity, not security — the GUI and the worker share a
 * trust domain.
 *
 * Wire-size strategy
 * ------------------
 * `Bootstrap` is sent once on `started` and carries every static fact the
 * GUI needs (tracker metadata, GUI groups, action metadata, etc.) so it
 * doesn't have to repeat in every snapshot.
 *
 * `Snapshot` carries only what changes per-day plus history *deltas* — the
 * GUI keeps the accumulated history client-side. `news` carries only new
 * items since the last snapshot; the GUI accumulates them.
 */

/* ------------------------- Bootstrap (one-shot) ------------------------ */

export interface Bootstrap {
	scenarioKey: string;
	scenarioName: string;
	sites: SiteMeta[];
	guiGroups: GuiGroupMeta[];
	trackers: TrackerMeta[];
	actions: ActionMeta[];
	stockpiles: StockpileMeta[];
	phases: string[];
	/** True when the scenario uses calendar dates instead of "Day N". The
	 * GUI formats the date label and graph x-axis accordingly. */
	useDate: boolean;
	/** ISO `YYYY-MM-DD` of day 1. Empty if `useDate` is false. */
	startDate: string;
	/** Localized name for "Day" — e.g. scenarios can override this with
	 * "Tick", "Turn", "Cycle" etc. Used for the day-counter label when
	 * `useDate` is false. */
	dayString: string;
}

export interface SiteMeta {
	key: string;
	name: string;
	totalPop: number;
}

export interface GuiGroupMeta {
	key: string;
	name: string;
	parentKey: string | null;
	order: number;
}

/** A trackable thing whose value over time we graph or read. */
export interface TrackerMeta {
	id: string;
	name: string;
	color: string;
	groupKey: string | null;
	type: 'trait' | 'resource' | 'metric';
	/** Global trackers have no per-site history; the value applies world-wide. */
	global: boolean;
	/** True if the scenario hides this tracker from the GUI by default. */
	hiddenDefault: boolean;
	/** Resource trackers may opt to render as a percentage with a denominator. */
	displayMode?: 'absolute' | 'perc' | 'none';
	/** True for player-created custom metrics and correlation traits. The UI
	 * shows a delete affordance on these rows; scenario-defined trackers are
	 * read-only. */
	playerCreated?: boolean;
	/** Decimal places for metric display. */
	precision?: number;
	/** For player-created metrics: the original spec used to create them.
	 * The status row uses this to render the formula when the player left
	 * the name blank, and the calculator modal uses it to pre-populate when
	 * editing. Always present when `playerCreated && type === 'metric'`. */
	metricSpec?: CustomMetricSpec;
	/** For player-created correlation traits: the original spec. Same role
	 * as `metricSpec`. Always present when `playerCreated && type === 'trait'`. */
	correlationSpec?: CustomCorrelationSpec;
}

export interface ActionMeta {
	id: string;
	name: string;
	groupKey: string | null;
	/** Local actions apply per-site; null = global. */
	siteKey: string | null;
	type: 'toggle' | 'slider' | 'number';
	min: number;
	max: number;
	step: number;
	/** Comma-joined "<-amount> <resource>" pairs, one per cost entry. Empty
	 * for actions with no cost. */
	costSummary: string;
	/** Comma-joined "<+/-amount> <resource>" pairs for produce entries.
	 * Empty when the action produces nothing. */
	produceSummary: string;
	/** Per-cost detail. The client uses this plus snapshot stockpile values
	 * and other actions' desired values to compute the affordability cap
	 * and proportional allocation live as sliders move — see
	 * `state.actionAllocations`. */
	costs: ActionCostMeta[];
	produces: ActionProduceMeta[];
}

export interface ActionCostMeta {
	resource: string;
	value: number;
	phaseIndex: number;
	/** Pre-resolved StockpileMeta.id for the action's site, so the client
	 * can index `Snapshot.stockpiles` directly without redoing the
	 * global/local lookup. */
	stockpileId: string;
}

export interface ActionProduceMeta {
	resource: string;
	value: number;
	sd: number;
	phaseIndex: number;
	stockpileId: string;
}

export interface StockpileMeta {
	id: string;
	name: string;
	color: string;
	global: boolean;
	/** True when the underlying resource is allowed to go negative
	 * (`Resource.signed`). Costs against signed resources don't gate the
	 * action — the slider has no red zone for them. */
	signed: boolean;
}

/* --------------------------- Snapshot (per-day) ------------------------ */

export interface Snapshot {
	age: number;
	sites: SiteSnapshot[];
	/** Empty after the first snapshot if no tracker advanced. */
	historyDelta: HistoryDeltaSnapshot[];
	/** News items new since the last snapshot. The GUI accumulates and pages. */
	news: NewsSnapshot[];
	/** Current action state (every action, every snapshot — small payload). */
	actions: ActionSnapshot[];
	/** Current stockpile values. */
	stockpiles: StockpileValueSnapshot[];
	/** Tracker IDs (`${type}:${key}`) currently hidden from the UI — both
	 * scenario-declared and dynamically toggled by events. The GUI hides
	 * matching rows in the status panel, legend chips, and graph lines. */
	hiddenTrackerIds: string[];
	/** Tracker IDs (`metric:KEY` or `trait:KEY`) whose row should render
	 * grayed-out because at least one of their dependencies is hidden. */
	grayedOutTrackerIds: string[];
	/** True after a `auto: true` modal-bearing news item is queued. The
	 * client should pause; ticker-only news doesn't set this. */
	pauseRequested: boolean;
	/** Sent when the worker added/removed a player-side metric/correlation in
	 * response to an `addCustomMetric` / `removeCustomMetric` /
	 * `addCorrelation` / `removeCustomTrait` message. The UI uses this to
	 * patch its tracker registry without waiting for a fresh Bootstrap. */
	trackerPatch?: TrackerPatch;
}

export interface TrackerPatch {
	added: TrackerMeta[];
	removedIds: string[];
}

export interface SiteSnapshot {
	key: string;
	pop: number;
	pops: PopSnapshot[];
}

export interface PopSnapshot {
	syndromeKey: string;
	pop: number;
}

export interface HistoryDeltaSnapshot {
	trackerId: string;
	/** Optional — global trackers omit it. */
	siteKey?: string;
	/** First day in `values`; the values array grows from there. */
	startDay: number;
	values: number[];
	/** For percent-mode trackers, the denominator series for the same days. */
	denominator?: number[];
}

export interface NewsSnapshot {
	id: string;
	day: number;
	title: string;
	/** Markdown-light body; shown in modal. Empty = ticker-only news. */
	body: string;
	siteKey: string | null;
	/** True = scenario flagged `auto: true`; combined with non-empty body, the
	 * GUI auto-opens a modal AND pauses. */
	auto: boolean;
}

export interface ActionSnapshot {
	id: string;
	siteKey: string | null;
	desiredValue: number;
	currentValue: number;
	/** Cap applied because the player can't afford the desired value. */
	costCappedValue: number | null;
	hidden: boolean;
	disabled: boolean;
	disabledReason: string | null;
	/** Pending scheduled changes, ordered by day. */
	schedule: ScheduledChange[];
}

export interface ScheduledChange {
	day: number;
	value: number;
}

export interface StockpileValueSnapshot {
	id: string;
	siteKey: string | null;
	value: number;
}

/* ---------------------------- Client ↔ Worker -------------------------- */

/* ------------------------- Player-side custom artifacts ------------------------- */

/** Spec for a player-created custom metric, sent from main to worker. */
export interface CustomMetricSpec {
	name: string;
	color: string;
	perc: boolean;
	precision: number;
	/** Serialized expression — the worker rebinds tracker references on
	 * receipt and on every reset. See game/tracking/CustomMetric.ts. */
	expressionData: unknown[];
}

/** Spec for a player-created correlation trait. */
export interface CustomCorrelationSpec {
	name: string;
	color: string;
	guigroup: string;
	def_and: string[];
	def_not: string[];
	def_or: string[];
	require: string[];
	forbid: string[];
}

/** main → worker. */
export type ClientMsg =
	| { type: 'start'; scenario: Record<string, unknown>; seed: number }
	| { type: 'step'; count: number }
	/**
	 * Run continuously. `msPerDay` throttles each `newDay`; 0 means "as fast
	 * as possible" (still yields to the macrotask queue so pause/step can
	 * land). `snapshotEveryDays` lets the GUI throttle redraws at high
	 * speeds; the worker still runs every day, it just batches the snapshot.
	 */
	| { type: 'run'; msPerDay: number; snapshotEveryDays: number }
	| { type: 'pause' }
	| { type: 'reset'; scenario: Record<string, unknown>; seed: number }
	/**
	 * Tear down the running world. The worker stops any active run loop
	 * and drops its World/System references. Subsequent step/run calls
	 * are errors until the next `start` or `reset`. Used by the editor:
	 * while the user is editing, no simulation should be in flight.
	 */
	| { type: 'shutdown' }
	| { type: 'setUseGpu'; enabled: boolean }
	| { type: 'setProfiler'; enabled: boolean }
	/** Toggle the (experimental) trait-clustering system. Phase C0 is
	 * diagnostics-only: enabling it runs the static cluster detector after the
	 * next boot (and immediately if a world is loaded) and emits a
	 * `clusterReport`. Behavioral phases (C1+) will hang off the same flag. */
	| { type: 'setClustering'; enabled: boolean }
	/** Player adjusted a slider — store in desired_value. The worker copies
	 * desired → current at top of next newDay. */
	| { type: 'setActionDesired'; actionId: string; siteKey: string | null; value: number }
	/** Player scheduled an action change for a future day. */
	| { type: 'scheduleAction'; actionId: string; siteKey: string | null; day: number; value: number }
	| { type: 'cancelScheduled'; actionId: string; siteKey: string | null; day: number }
	| { type: 'addCustomMetric'; spec: CustomMetricSpec }
	| { type: 'removeCustomMetric'; metricBaseKey: string }
	| { type: 'addCorrelation'; spec: CustomCorrelationSpec }
	| { type: 'removeCustomTrait'; traitBaseKey: string }
	/** Replace an existing player metric, keeping its `base_key` so other
	 * readouts that reference it stay connected. The worker removes the old
	 * metric and creates a new one with the same key. */
	| { type: 'editCustomMetric'; metricBaseKey: string; spec: CustomMetricSpec }
	/** Replace an existing player correlation, keeping its trait key. Note:
	 * existing populations/syndromes that already include the old correlation
	 * keep it embedded for the rest of the run; only future evaluations see
	 * the new definition. */
	| { type: 'editCorrelation'; traitBaseKey: string; spec: CustomCorrelationSpec };

/** worker → main. */
export type WorkerMsg =
	| { type: 'started'; snapshot: Snapshot; bootstrap: Bootstrap; gpuAvailable: boolean; gpuActive: boolean }
	| { type: 'snapshot'; snapshot: Snapshot }
	| { type: 'shutdown_done' }
	| { type: 'paused'; snapshot: Snapshot }
	/** Diagnostics from the trait-clustering detector (Phase C0). Emitted on
	 * boot when clustering is enabled and whenever it is toggled on. */
	| { type: 'clusterReport'; report: ClusterReportMsg }
	| { type: 'error'; message: string; stack?: string };

/** Wire-friendly subset of ClusterReport (plain data, structured-clonable). */
export interface ClusterReportMsg {
	clusters: string[][];
	membership: string[];
	terminal: string[];
	exitTraits: string[];
	gateEdges: { owner: string; rateOwner: string; kind: string; resource: string }[];
	traitCount: number;
	/** Phase C1 shadow verification of the current world state, if computed.
	 * `maxResidual` ~0 confirms the live joint factors along the partition;
	 * `costRatio` = factoredStates/jointPops (< 1 means factoring saves). */
	verification?: {
		maxResidual: number;
		jointPops: number;
		factoredStates: number;
		costRatio: number;
		livingN: number;
		absorbedN: number;
	};
}
