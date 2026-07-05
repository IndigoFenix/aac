/**
 * History - Tracks historical values for traits, resources, and metrics
 * Each site has one History per local resource, world has global histories
 */

import { HIST_TYPE, INCDEC } from '../../types/constants';
import type { IncDecMode } from '../../types/constants';
import { removeFrom, removeListeners } from '../../core/utils';
import type { Tracker } from './Tracker';

// Forward references
interface WorldLike {
	age: number;
	gui_elements: unknown[];
	traits: unknown[];
	resources: unknown[];
	custom_metrics: unknown[];
	getTraitHist(key: string): History | undefined;
	getResourceHist(key: string): History | undefined;
	getMetricHist(key: string): History | undefined;
	getResource(key: string): ResourceLike;
	getGUIBox(key: string): GUIBoxLike | null;
	removeCustomMetric(metric: unknown): void;
	updateGUI(): void;
}

interface SiteLike {
	key: string;
	world: WorldLike;
	resource_hist_kv: Record<string, History>;
}

interface SystemLike {
	rerenderGraph(): void;
	resetGUI(): void;
	calculator_getting_value: boolean;
	onGetTrackerForCalculator(tracker: Tracker): void;
	gui: GUILike | null;
}

interface GUILike {
	guiboxes: GUIBoxLike[];
}

interface GUIBoxLike {
	el_inner_stats: HTMLElement;
	hists: HistoryReadout[];
	state: { bullet_checked: boolean };
	onElementAddedOrRemoved(): void;
}

interface ResourceLike {
	key: string;
	precision: number;
	display: string;
	denominator: string;
	getStockpile(site: SiteLike | null): StockpileLike | null;
}

interface StockpileLike {
	stored_value: number;
	adjust: number;
	value: number;
	value_inc: number;
	value_dec: number;
	setHistory(hist: History): void;
	setDenominatorHistory(hist: History): void;
}

interface MetricLike {
	perc: boolean;
	precision: number;
}

/**
 * History class - Stores and manages historical values for a tracker
 */
export class History {
	type: number;
	site: SiteLike | null;
	world: WorldLike;
	system: SystemLike;
	globalhist: History | null = null;
	tracker: Tracker;

	// Resource-specific
	resource: ResourceLike | null = null;
	stockpile: StockpileLike | null = null;
	denominator_resource: ResourceLike | null = null;
	denominator_stockpile: StockpileLike | null = null;
	denominator_history: History | null = null;

	// Sub-histories (for combined global histories)
	sub_hists: History[] = [];
	is_combined_hist: boolean;

	// State
	start: number = 0;
	started: boolean = false;
	enabled: boolean = true;

	// Current values
	current: number = 0;
	current_adjust: number = 0;
	current_displayed: number = 0;
	current_inc: number = 0;
	current_dec: number = 0;

	// Denominator values
	denominator: number = 1;
	denominator_adjust: number = 0;
	denominator_displayed: number = 1;
	denominator_inc: number = 0;
	denominator_dec: number = 0;

	// Historical arrays
	val: number[] = [];
	val_inc: number[] = [];
	val_dec: number[] = [];
	adjust: number = 0;

	// UI readouts
	readouts: HistoryReadout[] = [];

	constructor(site: WorldLike | SiteLike, tracker: Tracker) {
		this.type = tracker.type;
		this.tracker = tracker;

		// Determine if `site` is actually a Site or the World. Both have
		// resource_hist_kv and a `world` reference (World's points at itself
		// via BWObj). Distinguish by `sites` (the array of child sites): only
		// the World owns one.
		const isWorld = 'sites' in site && Array.isArray((site as { sites: unknown }).sites);
		if (!isWorld) {
			// It's a Site
			this.site = site as SiteLike;
			this.world = this.site!.world;

			switch (this.type) {
				case HIST_TYPE.TRAIT:
					this.globalhist = this.world.getTraitHist(tracker.key) || null;
					break;
				case HIST_TYPE.RESOURCE:
					this.globalhist = this.world.getResourceHist(tracker.key) || null;
					break;
				case HIST_TYPE.METRIC:
					this.globalhist = this.world.getMetricHist(tracker.key) || null;
					break;
			}
			tracker.site_hists[(site as SiteLike).key] = this;
		} else {
			// It's the World
			this.site = null;
			this.world = site as WorldLike;
			this.globalhist = null;
			tracker.global_hist = this;
		}

		if (this.globalhist) {
			this.globalhist.sub_hists.push(this);
		}

		this.is_combined_hist = !tracker.global && !this.site;
		this.system = (this.world as unknown as { system: SystemLike }).system;

		// Setup resource-specific tracking
		if (this.type === HIST_TYPE.RESOURCE && tracker.resource) {
			this.resource = tracker.resource as unknown as ResourceLike;
			this.stockpile = this.resource.getStockpile(this.site);
			if (this.stockpile) {
				this.stockpile.setHistory(this);
				this.current = this.stockpile.stored_value;
				this.current_adjust = this.stockpile.adjust;
				this.current_inc = this.current;
			}
		}

		// Setup denominator tracking
		if (this.type === HIST_TYPE.RESOURCE && tracker.resource) {
			const resource = tracker.resource as unknown as ResourceLike;
			if (resource.denominator && resource.denominator !== '') {
				this.denominator_resource = this.world.getResource(resource.denominator);
				this.denominator_stockpile = this.denominator_resource.getStockpile(this.site);
				if (this.denominator_stockpile) {
					this.denominator_stockpile.setDenominatorHistory(this);
					this.denominator = this.denominator_stockpile.stored_value;
					this.denominator_adjust = this.denominator_stockpile.adjust;
				}
			}
		}
	}

	initDenominators(): void {
		if (this.denominator_resource && !this.denominator_history) {
			if (this.site && !(this.denominator_resource as unknown as { global: boolean }).global) {
				this.denominator_history = this.site.resource_hist_kv[this.denominator_resource.key];
			} else {
				this.denominator_history = (this.world as unknown as { resource_hist_kv: Record<string, History> }).resource_hist_kv[this.denominator_resource.key];
			}
			if (!this.denominator_history) {
				console.error('No denominator history could be found', this);
			}
		}
	}

	getDayVal(day: number, incdec: IncDecMode = INCDEC.CURRENT): number {
		if (this.started) {
			const dayindex = day - this.start;
			switch (incdec) {
				case INCDEC.CURRENT:
					return this.val[dayindex] || 0;
				case INCDEC.INC:
					return this.val_inc[dayindex] || 0;
				case INCDEC.DEC:
					return this.val_dec[dayindex] || 0;
			}
		}
		return 0;
	}

	addCurrentVal(): void {
		if (!this.started) return;

		if (this.is_combined_hist) {
			let current = 0;
			let denominator = 0;
			let current_inc = 0;
			let current_dec = 0;
			let denominator_inc = 0;
			let denominator_dec = 0;

			for (const sub of this.sub_hists) {
				current += sub.current;
				current_inc += sub.current_inc;
				current_dec += sub.current_dec;
				denominator += sub.denominator;
				denominator_inc += sub.denominator_inc;
				denominator_dec += sub.denominator_dec;
			}

			this.current = current;
			this.current_inc = current_inc;
			this.current_dec = current_dec;
			this.denominator = denominator;
			this.denominator_inc = denominator_inc;
			this.denominator_dec = denominator_dec;
		}

		this.val.push(this.current);
		this.val_inc.push(this.current_inc);
		this.val_dec.push(this.current_dec);
		this.current_inc = 0;
		this.current_dec = 0;
		this.updateCurrent();
	}

	startRecord(age?: number): void {
		if (this.world.age < 0) return;
		this.start = age === undefined ? this.world.age : age;
		this.started = true;
		this.enabled = true;
		if (this.globalhist && !this.globalhist.started) {
			this.globalhist.startRecord(this.start);
		}
	}

	getDisplayText(): string {
		if (this.type === HIST_TYPE.TRAIT) {
			return String(this.current_displayed + this.adjust);
		} else if (this.type === HIST_TYPE.RESOURCE && this.resource) {
			const numerator = this.current_displayed;
			const denominator = this.denominator_displayed;

			if (this.resource.display === '') {
				if (this.denominator_resource) {
					return numerator.toFixed(this.resource.precision) + '/' + 
						denominator.toFixed(this.denominator_resource.precision);
				} else {
					return numerator.toFixed(this.resource.precision);
				}
			} else if (this.resource.display === 'perc') {
				return ((numerator / denominator) * 100).toFixed(this.resource.precision) + '%';
			}
		} else if (this.type === HIST_TYPE.METRIC && this.tracker.metric) {
			const metric = this.tracker.metric as unknown as MetricLike;
			if (metric.perc) {
				return (this.current_displayed * 100).toFixed(metric.precision) + '%';
			} else {
				return this.current_displayed.toFixed(metric.precision);
			}
		}
		return String(this.current_displayed);
	}

	isVisible(): boolean {
		return this.enabled && (this.type !== HIST_TYPE.RESOURCE || 
			!this.resource || this.resource.display !== 'none');
	}

	updateCurrent(): void {
		this.current_displayed = this.current;
		this.denominator_displayed = this.denominator;
	}

	updateDisplay(): void {
		if (this.isVisible()) {
			if (this.readouts.length === 0) {
				this.addToPanel();
			}
			for (const readout of this.readouts) {
				readout.updateDisplay();
			}
		} else {
			this.removeDisplay();
		}
	}

	onUpdatedStockpile(stockpile: StockpileLike): void {
		this.current = stockpile.value;
		this.current_inc = stockpile.value_inc;
		this.current_dec = stockpile.value_dec;
		this.current_adjust = stockpile.adjust;
	}

	onUpdatedDenominatorStockpile(stockpile: StockpileLike): void {
		this.denominator = stockpile.value;
		this.denominator_inc = stockpile.value_inc;
		this.denominator_dec = stockpile.value_dec;
		this.denominator_adjust = stockpile.adjust;
	}

	updateDisplayIfNeeded(): void {
		if (this.readouts.length > 0) {
			this.updateDisplay();
		}
	}

	getGUIBox(): GUIBoxLike | null {
		return this.tracker.guigroup 
			? this.world.getGUIBox(this.tracker.guigroup)
			: this.world.getGUIBox('');
	}

	addToPanel(): void {
		if (!this.started) return;
		if (this.tracker.hidden) return;
		// In headless contexts (worker, tests) there is no GUIBox tree to
		// attach to — skip silently. Letting `new HistoryReadout` run here
		// would fire its "No GUIBox found" console.error every tick.
		if (!this.getGUIBox()) return;
		const readout = new HistoryReadout(this);
		this.readouts.push(readout);
		this.world.gui_elements.push(readout);
	}

	getColor(): string {
		return this.tracker.obj?.color?.getColor() || '#000';
	}

	getTitle(): string {
		return this.tracker.getName();
	}

	setHidden(value: boolean): void {
		this.tracker.graph_hidden = value;
		this.system.rerenderGraph();
		for (const readout of this.readouts) {
			readout.updateBullet();
		}
	}

	destroyObject(): void {
		if (this.type === HIST_TYPE.METRIC) {
			this.world.removeCustomMetric(this.tracker.metric);
			this.removeDisplay();
			this.system.resetGUI();
			this.world.updateGUI();
		}
	}

	removeDisplay(): void {
		for (let i = this.readouts.length - 1; i >= 0; i--) {
			removeFrom(this.world.gui_elements, this.readouts[i]);
			this.readouts[i].destroy();
		}
		this.readouts = [];
	}
}

/**
 * HistoryReadout - UI element displaying a History value
 */
export class HistoryReadout {
	hist: History;
	world: WorldLike;
	system: SystemLike;
	tracker: Tracker;
	guibox: GUIBoxLike | null;
	new_guibox: GUIBoxLike | null = null;

	// DOM elements
	el: HTMLElement | null = null;
	inner_el: HTMLElement | null = null;
	bullet: HTMLElement | null = null;
	value_field: HTMLElement | null = null;
	grabpad: HTMLElement | null = null;
	placeholder_el: HTMLElement | null = null;

	// Drag state
	isDragged: boolean = false;
	grabbedAt: [number, number] = [0, 0];
	placeholder_index: number = -1;
	placeholder_guibox: GUIBoxLike | null = null;

	// Event listener tracking
	ev_listeners?: [EventTarget, string, EventListener][];

	constructor(hist: History) {
		this.hist = hist;
		this.world = hist.world;
		this.system = hist.system;
		this.tracker = hist.tracker;

		this.guibox = this.getGUIBox();
		if (!this.guibox) {
			console.error('No GUIBox found for history', this);
			return;
		}

		// Note: Full DOM setup would be done here in browser environment
		// This is simplified for the TypeScript conversion
	}

	updateBullet(): void {
		if (!this.bullet) return;
		if (this.tracker.graph_hidden) {
			this.bullet.classList.add('crossed-out');
		} else {
			this.bullet.classList.remove('crossed-out');
		}
	}

	onClick(): void {
		if (this.system.calculator_getting_value) {
			this.system.onGetTrackerForCalculator(this.tracker);
		} else {
			this.hist.setHidden(!this.tracker.graph_hidden);
		}
	}

	updateDisplay(): void {
		if (this.value_field) {
			this.value_field.innerHTML = this.hist.getDisplayText();
		}
	}

	getGUIBox(): GUIBoxLike | null {
		return this.tracker.guigroup 
			? this.world.getGUIBox(this.tracker.guigroup)
			: this.world.getGUIBox('');
	}

	destroy(): void {
		const guibox = this.getGUIBox();
		if (guibox) {
			const i = guibox.hists.indexOf(this);
			if (i !== -1) {
				guibox.hists.splice(i, 1);
				guibox.onElementAddedOrRemoved();
			}
		}
		if (this.el && this.el.parentNode) {
			this.el.parentNode.removeChild(this.el);
		}
		removeListeners(this);
		this.el = this.inner_el = this.value_field = this.bullet = null;
		this.guibox = null;
	}
}

export default History;
