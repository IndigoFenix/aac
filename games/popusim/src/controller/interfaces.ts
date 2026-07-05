/**
 * Controller interfaces - Abstract UI and runtime dependencies
 */

import type { BWObj } from '../core/BWObj';

// ========================================
// UI Element Interfaces
// ========================================

export interface ScreenLike {
	canvas: HTMLCanvasElement;
	update(delta: number): void;
	render(): boolean;
	setRoom(room: unknown): void;
	destroyEventListeners(): void;
}

export interface GraphLike {
	needs_render: boolean;
	setWorld(world: WorldLike | null): void;
	setSite(site: SiteLike | null): void;
}

export interface VisualizerLike {
	needs_render: boolean;
	setWorld(world: WorldLike | null): void;
	setSite(site: SiteLike | null): void;
}

export interface NewsBoxLike {
	expander: HTMLElement;
	reload(): void;
	contract(): void;
}

export interface PanelsGUILike {
	getGUIBox(name: string): GUIBoxLike | null;
	copyState(): Record<string, unknown>;
	destroy(): void;
}

export interface GUIBoxLike {
	actions: PlayerActionLike[];
	el_inner_actions: HTMLElement | null;
	onElementAddedOrRemoved(): void;
}

export interface WorldBuilderLike {
	active: boolean;
	init(): void;
	start(world: WorldLike): Promise<void>;
	exit(): void;
}

export interface ScrollbarLike {
	setCap(value: number): void;
	setScrollbarPosition(value: number): void;
	destroy(): void;
}

export interface CalculatorLike {
	el: HTMLElement;
	expression_el: HTMLElement;
	number_el: HTMLElement;
	obj: unknown;
	keydown(key: string): void;
	selectTracker(tracker: TrackerLike): void;
	destroy(): void;
}

// ========================================
// Game Object Interfaces  
// ========================================

export interface SiteLike extends BWObj {
	world: WorldLike;
	pop: number;
	graph_height: number;
	pops: PopulationLike[];
	pops_kv: Record<string, PopulationLike>;
	actions: PlayerActionLike[];
	actions_kv: Record<string, PlayerActionLike>;
	local_stockpiles: StockpileLike[];
	local_stockpiles_kv: Record<string, StockpileLike>;
	trait_hist: HistoryLike[];
	trait_hist_kv: Record<string, HistoryLike>;
	resource_hist: HistoryLike[];
	resource_hist_kv: Record<string, HistoryLike>;
	metric_hist: HistoryLike[];
	metric_hist_kv: Record<string, HistoryLike>;
	shed_pending_phases: unknown[][];

	init(): void;
	initLocalStockpiles(): void;
	initLocalActions(): void;
	initHistory(): void;
	initHistoryDenominators(): void;
	initPopulation(): Promise<void>;
	updateDisplay(): void;
	updateLocalHistory(): void;
	updateTransmission(phase: number): Promise<void>;
	updateContact(delta: import('../game/simulation/PhaseDelta').PhaseDelta, seed: number, day: number, phase: number): Promise<void>;
	applyPhaseDelta(delta: import('../game/simulation/PhaseDelta').PhaseDelta, rngDraw: (popId: number, sourceSubId: number, targetSubId: number) => number): void;
	updatePopulations(): Promise<void>;
	updatePopulationsHistory(): Promise<void>;
	getTitle(): string;
	unset(): void;
	removeDisplay(): void;
	addPop(size: number, syndrome: unknown): PopulationLike;
}

export interface WorldLike extends BWObj {
	system: SystemLike;
	data: Record<string, unknown>;
	closing: boolean;
	initialized: boolean;
	setting_up: boolean;
	scenario_complete: boolean;
	scenario_victory: boolean;
	age: number;
	render_age: number;
	graph_height: number;
	start_timestamp: number;
	has_tracked_trait: boolean;

	// Collections
	sites: SiteLike[];
	traits: TraitLike[];
	traits_kv: Record<string, TraitLike>;
	vectors: VectorLike[];
	vectors_kv: Record<string, VectorLike>;
	resources: ResourceLike[];
	resources_kv: Record<string, ResourceLike>;
	actions: PlayerActionLike[];
	actions_kv: Record<string, PlayerActionLike>;
	global_actions: PlayerActionLike[];
	local_actions: PlayerActionLike[];
	all_actions: PlayerActionLike[];
	syndromes: SyndromeLike[];
	syndromes_kv: Record<string, SyndromeLike>;
	trackers: TrackerLike[];
	all_phases: IndexedPhaseLike[];
	all_phases_kv: Record<string, IndexedPhaseLike>;
	global_stockpiles: StockpileLike[];
	global_stockpiles_kv: Record<string, StockpileLike>;
	all_stockpiles: StockpileLike[];
	all_transmit: TransmitLike[];
	all_progress: ProgressLike[];
	guigroups: GUIGroupLike[];
	guigroups_kv: Record<string, GUIGroupLike>;
	clusters: unknown[][];
	blank_cluster_array: unknown[];

	// History
	trait_hist: HistoryLike[];
	trait_hist_kv: Record<string, HistoryLike>;
	resource_hist: HistoryLike[];
	resource_hist_kv: Record<string, HistoryLike>;
	metric_hist: HistoryLike[];
	metric_hist_kv: Record<string, HistoryLike>;
	trait_trackers_kv: Record<string, TrackerLike>;
	resource_trackers_kv: Record<string, TrackerLike>;
	metric_trackers_kv: Record<string, TrackerLike>;

	// Configuration
	use_date: boolean;
	day_string: string;
	news_string: string;
	start_age: number;
	color_primary: ColorLike;
	color_secondary: ColorLike;
	color_light: ColorLike;
	color_dark: ColorLike;

	// Methods
	start(): Promise<void>;
	newDay(): Promise<void>;
	resetValues(): void;
	updateGUI(): void;
	removeDisplay(): void;
	getTrait(key: string): TraitLike;
	getVector(key: string): VectorLike;
	getResource(key: string): ResourceLike;
	getSyndrome(traitKeys: string[]): SyndromeLike;
	getGUIBox(key: string): GUIBoxLike | null;
	addToPhase(obj: unknown, phase: string): IndexedPhaseLike;
	validatePlayerActions(): void;
	getDateString(age: number): string;
	parseText(text: string, site?: SiteLike): string;
}

export interface SystemLike extends BWObj {
	rand: RandomLike;
	world: WorldLike | null;
	site: SiteLike | null;
	gui: PanelsGUILike | null;
	news_box: NewsBoxLike;
	date_panel: HTMLElement;
	omniPanel: HTMLElement;
	loadingDay: boolean;
	forceDayEnd: boolean;
	paused: boolean;
	omniscient_mode: boolean;
	modalbox: HTMLElement | null;

	// Methods
	setSite(site: SiteLike): void;
	unsetSite(): void;
	setSitesSelector(on: boolean): void;
	confirmBox(params: ConfirmBoxParams): Promise<void>;
	render(): void;
	rerenderGraph(): void;
	resizeScreen(): void;
	control_pause(): void;
	startWorld(): Promise<void>;
	goToNextLevel(): void;
	unlockNextLevel(): void;
	setVisualizerMode(): void;
	setGraphMode(): void;
	setVisualizerToggle(on: boolean): void;
}

export interface ConfirmBoxParams {
	message?: string;
	cl?: string;
	allow?: boolean;
	inputs?: ConfirmBoxInput[];
	buttons?: ConfirmBoxButton[];
	newsitem?: unknown;
}

export interface ConfirmBoxInput {
	name: string;
	label?: string;
	type?: string;
	c?: string;
	default?: string | number;
	options?: Array<{ v: string; l: string }>;
	search?: boolean;
}

export interface ConfirmBoxButton {
	label: string;
	c?: string;
	click?: (e: Event) => boolean | void;
}

// ========================================
// Supporting Type Interfaces
// ========================================

export interface RandomLike {
	get(): number;
	getSeed(): number;
}

export interface ColorLike {
	getColor(): string;
}

export interface TraitLike {
	key: string;
	base_key: string;
	index: number;
	tracker: TrackerLike | null;
	is_combo: boolean;
	illegal: boolean;
	prob: number;
	hidden: boolean;
	tracked?: boolean;
	primaries: { require: TraitLike[]; forbid: TraitLike[] };
	combos: { require: TraitLike[]; forbid: TraitLike[] };
	def_and: string[];
	def_not: string[];
	def_or: string[];
	req_by: TraitLike[];
	req_by_and: TraitLike[];
	req_by_not: TraitLike[];
	req_by_or: TraitLike[];
	linked_traits: TraitLike[];
	linked_traits_kv: Record<string, TraitLike>;
	cluster_level: number;
	and_combo: number;
	or_valid: boolean;
	not_valid: boolean;
	req_count: number;
	req_by_exists: number;
	transmit: TransmitLike[];
	progress: ProgressLike[];
	produce: ImpactLike[];
	consume: ImpactLike[];

	init(): void;
	initSubObjects(): void;
	initLinkedTraits(): void;
	evaluatePrimaries(): void;
	evaluateCombos(): void;
	addAsCombo(): void;
	resetCombo(): void;
}

export interface VectorLike {
	key: string;
	seek: SeekLike[];
	init(): void;
}

export interface SeekLike {
	trait_has: TraitLike[];
	trait_not: TraitLike[];
	mult: number;
}

export interface ResourceLike {
	key: string;
	base_key: string;
	value: number;
	global: boolean;
	signed: boolean;
	tracker: TrackerLike | null;
}

export interface StockpileLike {
	resource: ResourceLike;
	value: number;
	value_inc: number;
	value_dec: number;
	adjusted_value: number;
	setImpactValue(): void;
	doConsumption(delta: import('../game/simulation/PhaseDelta').PhaseDelta): Promise<void>;
	doAdjustment(): void;
	setAdjustedValue(): void;
	updateStoredValue(): void;
	updateStockpileHistory(): void;
}

export interface PlayerActionLike {
	key: string;
	name: string;
	data: Record<string, unknown>;
	site: SiteLike | null;
	global: boolean;
	hidden: boolean;
	enabled: boolean;
	current_value: number;
	desired_value: number;
	actual_value: number;
	cost_capped_value: number;
	cost: ActionCostLike[];
	produce: ActionProduceLike[];

	init(): void;
	change(value: number): void;
	updateCap(): boolean;
	reduceIfOverCap(): boolean;
	updateCosts(): void;
	updateCostsAndStockpiles(): [Set<StockpileLike>, Set<PlayerActionLike>];
	updateDisplay(): void;
	updateInfoDisplay(value?: number): void;
	/** Schedule transmits for the given phase. Sheds use the action's
	 * current_value at call time, so the cost stage for that phase must
	 * have run already. */
	finalizeActionTransmission(site: SiteLike, phase_index: number): void;
	removeDisplay(): void;
}

export interface ActionCostLike {
	resource: string;
	value: number;
	phase_index: number;
	current_value: number;
	stockpile: StockpileLike | null;
	resource_obj?: ResourceLike | null;
	updateValue(actionValue: number): void;
}

export interface ActionProduceLike {
	resource: string;
	value: number;
	sd: number;
	phase_index: number;
	current_value: number;
	stockpile: StockpileLike | null;
	updateValue(actionValue: number): void;
}

export interface SyndromeLike {
	key: string;
	traits: TraitLike[];
	base_traits: TraitLike[];
	/** Resolved trait keys — read by rest detection and faction measures. */
	trait_keys: string[];
	relevant_phases: number[];
	construct(traits: TraitLike[], key: string): void;
}

export interface PopulationLike {
	site: SiteLike;
	syndrome: SyndromeLike;
	pop: number;
	start: number;
	hist: HistoryLike[];
	val: number[];
	val_inc: number[];
	val_dec: number[];
	getDateIndex(day: number): number;
	createPrimarySubpop(): void;
	updateTransmission(phase: number): Promise<void>;
}

export interface TrackerLike {
	key: string;
	type: number;
	trait?: TraitLike;
	resource?: ResourceLike;
	metric?: MetricLike;
}

export interface MetricLike {
	base_key: string;
	index: number;
	expression: ExpressionLike;
	name?: string;
	color?: ColorLike;
	perc?: boolean;
	precision?: number;
	hidden?: boolean;
	grayed_out?: boolean;
	dep_tracker_keys?: string[];
	expression_data?: unknown[];
	getName?(): string;
	evaluate?(site: SiteLike | null, day?: number): number;
}

export interface ExpressionLike {
	evaluate(site: SiteLike | null, day: number): number;
	values: ExpressionValueLike[];
}

export interface ExpressionValueLike {
	world: WorldLike;
	type: string;
	subtype: string | null;
	value: unknown;
}

export interface HistoryLike {
	site: SiteLike | null;
	tracker: TrackerLike;
	type: number;
	started: boolean;
	current: number;
	current_inc: number;
	current_dec: number;
	val: number[];
	val_inc: number[];
	val_dec: number[];

	startRecord(day?: number): void;
	addCurrentVal(): void;
	updateCurrent(): void;
	updateDisplay(): void;
	updateDisplayIfNeeded(): void;
	removeDisplay(): void;
	initDenominators(): void;
	getDisplayText(): string;
}

export interface TransmitLike {
	key: string;
	phase_index: number;
	linked_traits: TraitLike[];
	linked_traits_kv: Record<string, TraitLike>;
	relevant_clusters: unknown[];
	init(): void;
}

export interface ProgressLike {
	key: string;
	phase_index: number;
	linked_traits: TraitLike[];
	linked_traits_kv: Record<string, TraitLike>;
	relevant_clusters: unknown[];
	init(): void;
}

export interface ImpactLike {
	init(): void;
}

export interface IndexedPhaseLike {
	key: string;
	index: number;
	transmit: TransmitLike[];
	progress: ProgressLike[];
	syndromes: SyndromeLike[];
	impacts: ImpactLike[];
	events: EventLike[];
}

export interface GUIGroupLike {
	key: string;
	getName(): string;
}

export interface EventLike {
	init(): void;
	createExpressions(): void;
	update(): Promise<void>;
}

export interface FilterLike {
	key: string;
	syndromeIncluded(syndrome: SyndromeLike): boolean;
}

export interface ClusterLike {
	trait: TraitLike;
	level: number;
}
