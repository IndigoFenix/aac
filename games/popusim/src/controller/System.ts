/**
 * System - Main game controller
 * Manages UI, game state, rendering, and user input
 */

import { BWObj } from '../core/BWObj';
import { Random } from '../core/Random';
import { CookieManager } from '../core/CookieManager';
import { bindListener, removeListeners, appendElement, addClass, removeClass } from '../core/utils';
import type { HasEventListeners } from '../types/interfaces';
import type {
	SystemLike, WorldLike, SiteLike, GraphLike, VisualizerLike,
	ScreenLike, NewsBoxLike, PanelsGUILike, WorldBuilderLike,
	CalculatorLike, ConfirmBoxParams, ConfirmBoxButton
} from './interfaces';

// Factory functions for runtime-created objects
let createWorld: ((system: System, data: Record<string, unknown>) => WorldLike) | null = null;
let createPanelsGUI: ((world: WorldLike, container: HTMLElement, prevState: Record<string, unknown>) => PanelsGUILike) | null = null;

export function setSystemDependencies(deps: {
	createWorld?: typeof createWorld;
	createPanelsGUI?: typeof createPanelsGUI;
}): void {
	if (deps.createWorld) createWorld = deps.createWorld;
	if (deps.createPanelsGUI) createPanelsGUI = deps.createPanelsGUI;
}

/**
 * System class - Main game controller
 */
export class System extends BWObj implements HasEventListeners {
	// DOM Elements
	el: HTMLElement;
	menu_screen: HTMLElement;
	game_screen: HTMLElement;
	builderDiv: HTMLElement;
	menu: HTMLElement;
	section_right: HTMLElement;
	section_left: HTMLElement;
	section_display: HTMLElement;
	section_info: HTMLElement;
	control_panel_container: HTMLElement;
	date_panel_container: HTMLElement;
	current_site_panel_container: HTMLElement;
	sites_panel_container: HTMLElement;
	world_panel_container: HTMLElement;
	graph_panel_container: HTMLElement;
	graph_container_border: HTMLElement;
	graph_container: HTMLElement;
	calculator_container: HTMLElement;
	calculator_inner: HTMLElement;
	status_panel_container: HTMLElement;
	action_panel_container: HTMLElement;
	date_panel: HTMLElement;
	controlPanel: HTMLElement;
	statusPanel: HTMLElement;
	currentSitePanel: HTMLElement;
	sitesPanel: HTMLElement;
	sitesSelector: HTMLSelectElement;
	omniPanel: HTMLElement;
	scenarioSelector: HTMLSelectElement;
	tooltip: HTMLElement;
	tooltip_triangle: HTMLElement;

	// Buttons
	btn_pause: HTMLElement;
	btn_next: HTMLElement;
	btn_play_1: HTMLElement;
	btn_play_2: HTMLElement;
	btn_play_4: HTMLElement;
	btn_omni: HTMLElement;
	modeSwitch: HTMLElement;

	// Canvas elements
	graphCanvas: HTMLCanvasElement;
	visualizerCanvas: HTMLCanvasElement;
	zoomCanvas: HTMLCanvasElement;

	// Screens and rendering
	graphScreen: ScreenLike | null = null;
	visualizerScreen: ScreenLike | null = null;
	mainScreen: ScreenLike | null = null;
	graph: GraphLike | null = null;
	visualizer: VisualizerLike | null = null;
	vScrollbar: unknown = null;

	// Game state
	rand: Random;
	world: WorldLike | null = null;
	site: SiteLike | null = null;
	gui: PanelsGUILike | null = null;
	news_box!: NewsBoxLike;
	worldBuilder!: WorldBuilderLike;
	calculator: CalculatorLike | null = null;

	// UI state
	menu_open: boolean = true;
	graph_minimized: boolean = false;
	graph_mode_minimized: boolean = false;
	calculator_selected: boolean = false;
	calculator_getting_value: boolean = false;
	omniscient_mode: boolean = false;
	demo: boolean = false;

	// Game timing
	timer: number = 0;
	speed_level: number = 1;
	update_rate: number = 60;
	render_time: number = 1000 / 30;
	last_rendered: number = 0;
	loadingDay: boolean = false;
	forceDayEnd: boolean = false;
	cancellingDay: boolean = false;
	paused: boolean = true;

	// Modal state
	modaldata: { params: ConfirmBoxParams; modalbox: HTMLElement } | null = null;
	modalbox: HTMLElement | null = null;
	modalinner: HTMLElement | null = null;
	modalbuttons: ConfirmBoxButton[] = [];
	modalOpts: Record<string, unknown> = {};
	modalInputs: Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {};

	// Tooltip state
	tooltip_element: HTMLElement | null = null;
	tooltip_timeout: ReturnType<typeof setTimeout> | null = null;

	// Scenarios
	scenarios: Array<Record<string, unknown>> = [];
	scenarioData: Record<string, unknown> | null = null;
	highestLevelReached: number = 0;

	// Action selection
	applyAction: unknown = null;
	allSitesButton: HTMLElement | null = null;

	// Event listeners
	ev_listeners?: [EventTarget, string, EventListener][];

	constructor(parent: BWObj | null, data?: Record<string, unknown>) {
		super(parent, data);

		// Initialize random
		this.rand = new Random();

		// Get highest level from cookie
		this.highestLevelReached = parseFloat(CookieManager.getCookie({ name: "highestLevel" }) || "0");

		// Initialize DOM elements (placeholders - actual DOM setup done externally)
		this.el = document.getElementById('wrapper') || document.createElement('div');

		// Create placeholder elements (will be properly initialized by UI setup)
		this.menu_screen = document.createElement('div');
		this.game_screen = document.createElement('div');
		this.builderDiv = document.createElement('div');
		this.menu = document.createElement('div');
		this.section_right = document.createElement('div');
		this.section_left = document.createElement('div');
		this.section_display = document.createElement('div');
		this.section_info = document.createElement('div');
		this.control_panel_container = document.createElement('div');
		this.date_panel_container = document.createElement('div');
		this.current_site_panel_container = document.createElement('div');
		this.sites_panel_container = document.createElement('div');
		this.world_panel_container = document.createElement('div');
		this.graph_panel_container = document.createElement('div');
		this.graph_container_border = document.createElement('div');
		this.graph_container = document.createElement('div');
		this.calculator_container = document.createElement('div');
		this.calculator_inner = document.createElement('div');
		this.status_panel_container = document.createElement('div');
		this.action_panel_container = document.createElement('div');
		this.date_panel = document.createElement('div');
		this.controlPanel = document.createElement('div');
		this.statusPanel = document.createElement('div');
		this.currentSitePanel = document.createElement('div');
		this.sitesPanel = document.createElement('div');
		this.sitesSelector = document.createElement('select');
		this.omniPanel = document.createElement('div');
		this.scenarioSelector = document.createElement('select');
		this.tooltip = document.createElement('div');
		this.tooltip_triangle = document.createElement('div');

		// Buttons
		this.btn_pause = document.createElement('span');
		this.btn_next = document.createElement('span');
		this.btn_play_1 = document.createElement('span');
		this.btn_play_2 = document.createElement('span');
		this.btn_play_4 = document.createElement('span');
		this.btn_omni = document.createElement('span');
		this.modeSwitch = document.createElement('button');

		// Canvas
		this.graphCanvas = document.createElement('canvas');
		this.visualizerCanvas = document.createElement('canvas');
		this.zoomCanvas = document.createElement('canvas');
	}

	// ========================================
	// Scenario Management
	// ========================================

	setScenarioSelector(scenarios: Array<Record<string, unknown>>): void {
		this.scenarios = scenarios;
		for (let i = 0; i < scenarios.length; i++) {
			const scenario = scenarios[i];
			const opt = appendElement('option', '', this.scenarioSelector, String(scenario.name || 'Untitled'));
			opt.setAttribute("value", String(i));
		}
	}

	async setDefaultScenarios(): Promise<void> {
		this.scenarioSelector.innerHTML = "";
		const scenarios = await this.getDefaultScenarios();
		this.setScenarioSelector(scenarios);
	}

	async getDefaultScenarios(): Promise<Array<Record<string, unknown>>> {
		// Override in implementation to load scenarios
		return [];
	}

	// ========================================
	// World Management
	// ========================================

	loadWorld(data: Record<string, unknown> | string): void {
		if (this.world) this.closeWorld();

		let parsedData: Record<string, unknown>;
		if (typeof data === 'string') {
			try {
				parsedData = JSON.parse(data);
			} catch (error) {
				throw new Error("Could not load scenario - data is not a valid JSON.");
			}
		} else {
			parsedData = data;
		}

		try {
			if (!createWorld) {
				throw new Error("World factory not set");
			}
			this.world = createWorld(this, parsedData);
			this.resetGUI();
			this.onWorldLoaded();
			if (!this.worldBuilder?.active) {
				this.startWorld();
			}
		} catch (error) {
			this.world = null;
			console.error(error);
			alert("Could not load scenario. " + (error as Error).message);
		}
	}

	async startWorld(): Promise<void> {
		if (!this.world) {
			await this.confirmBox({ message: "No world selected!", buttons: [{ label: "OK" }] });
			return;
		}
		this.unloadWorld();
		this.world.closing = false;
		this.scenarioData = this.world.data;
		this.graph?.setWorld(this.world);
		this.visualizer?.setWorld(this.world);
		await this.world.start();
		this.resizeScreen();
	}

	unloadWorld(): void {
		if (!this.world || !this.world.initialized) return;
		this.world.closing = true;
		this.unsetSite();
		this.world.removeDisplay();
		this.world.resetValues();
		this.loadingDay = false;
		this.forceDayEnd = false;
		this.cancellingDay = false;
		this.control_pause();
		if (this.modalbox) {
			this.closeModal(this.modalbox);
		}
		this.resetPanels();
	}

	closeWorld(): void {
		if (this.world) {
			this.unloadWorld();
			this.graph?.setWorld(null);
			this.visualizer?.setWorld(null);
			this.world = null;
			this.onWorldUnloaded();
		}
	}

	onWorldLoaded(): void {
		// Override in implementation
	}

	onWorldUnloaded(): void {
		// Override in implementation
	}

	// ========================================
	// Site Management
	// ========================================

	setSite(site: SiteLike): void {
		if (site !== this.site) {
			this.unsetSite();
			this.site = site;
			this.currentSitePanel.innerHTML = site.getTitle();
			if (this.loadingDay) {
				this.forceDayEnd = true;
			}
			this.graph?.setSite(site);
			this.visualizer?.setSite(site);
			this.world?.updateGUI();
		}
	}

	unsetSite(): void {
		if (this.site) {
			this.site.unset();
			this.site = null;
			this.graph?.setSite(null);
			this.visualizer?.setSite(null);
			this.currentSitePanel.innerHTML = "";
			if (this.graph) this.graph.needs_render = true;
			if (this.visualizer) this.visualizer.needs_render = true;
			this.render();
		}
		this.resetGUI();
		this.rerenderGraph();
		if (this.allSitesButton) {
			addClass(this.allSitesButton, 'selected');
		}
	}

	setSitesSelector(on: boolean): void {
		if (on) {
			removeClass(this.sitesSelector, 'hide');
			addClass(this.current_site_panel_container, 'hide');
		} else {
			removeClass(this.current_site_panel_container, 'hide');
			addClass(this.sitesSelector, 'hide');
		}
	}

	// ========================================
	// Game Controls
	// ========================================

	control_toggle(): void {
		if (this.paused) this.control_play();
		else this.control_pause();
	}

	control_set_speed(speed: number): void {
		this.speed_level = speed;
		this.update_rate = 60 / speed;
	}

	control_reset_btns(): void {
		removeClass(this.btn_pause, 'active');
		removeClass(this.btn_play_1, 'active');
		removeClass(this.btn_play_2, 'active');
		removeClass(this.btn_play_4, 'active');
	}

	control_play(): void {
		if (!this.world) return;
		this.paused = false;
		this.control_reset_btns();
		let btn: HTMLElement;
		if (this.speed_level === 1) btn = this.btn_play_1;
		else if (this.speed_level === 2) btn = this.btn_play_2;
		else btn = this.btn_play_4;
		addClass(btn, 'active');
	}

	control_pause(): void {
		this.paused = true;
		this.control_reset_btns();
		addClass(this.btn_pause, 'active');
	}

	control_next(): void {
		this.control_pause();
		if (this.world?.scenario_complete) return;
		if (this.loadingDay) {
			this.forceDayEnd = true;
		} else {
			this.forceDayEnd = true;
			if (this.canRunNextDay()) {
				this.world?.newDay();
			}
		}
	}

	control_omni_on(): void {
		this.omniscient_mode = true;
		addClass(this.btn_omni, 'active');
		removeClass(this.omniPanel, 'hide');
		if (!this.loadingDay) {
			this.world?.updateGUI();
		}
	}

	control_omni_off(): void {
		this.omniscient_mode = false;
		removeClass(this.btn_omni, 'active');
		addClass(this.omniPanel, 'hide');
		if (!this.loadingDay) {
			this.world?.updateGUI();
		}
	}

	control_omni_toggle(): void {
		if (this.omniscient_mode) this.control_omni_off();
		else this.control_omni_on();
	}

	canRunNextDay(): boolean {
		return (
			!this.worldBuilder?.active &&
			!this.loadingDay &&
			!this.world?.scenario_complete &&
			this.modalbox === null
		);
	}

	// ========================================
	// Level Management
	// ========================================

	getNextLevel(): Record<string, unknown> | undefined {
		if (this.world) {
			const worldIndex = (this.world as unknown as { index?: number }).index;
			if (worldIndex !== undefined) {
				return this.scenarios.find(e => e.index === worldIndex + 1);
			}
		}
		return undefined;
	}

	unlockNextLevel(): void {
		const next = this.getNextLevel();
		if (next && (next.index as number) > this.highestLevelReached) {
			this.highestLevelReached = next.index as number;
			CookieManager.setCookie({ name: "highestLevel", value: String(this.highestLevelReached) });
		}
	}

	goToNextLevel(): void {
		const next = this.getNextLevel();
		if (next) {
			this.loadWorld(next);
		}
	}

	// ========================================
	// GUI Management
	// ========================================

	resetGUI(): void {
		let prev_gui: Record<string, unknown> = {};
		if (this.gui) {
			prev_gui = this.gui.copyState();
			this.gui.destroy();
		}
		if (this.world && createPanelsGUI) {
			this.gui = createPanelsGUI(this.world, this.statusPanel, prev_gui);
		}
		this.resizeScreen();
		this.rerenderGraph();
	}

	resetPanels(): void {
		this.currentSitePanel.innerHTML = "";
		this.sitesPanel.innerHTML = "";
		this.sitesSelector.innerHTML = "";
		this.statusPanel.innerHTML = "";
		this.setSitesSelector(false);
		this.news_box?.reload();
		this.closeCalculator();
	}

	// ========================================
	// Graph/Visualizer Mode
	// ========================================

	setGraphMode(): void {
		this.mainScreen = this.graphScreen;
		if (this.graph) this.graph.needs_render = true;
		if (this.visualizer) this.visualizer.needs_render = true;
		this.render();
	}

	setVisualizerMode(): void {
		this.mainScreen = this.visualizerScreen;
		if (this.graph) this.graph.needs_render = true;
		if (this.visualizer) this.visualizer.needs_render = true;
		this.render();
	}

	setVisualizerToggle(on: boolean): void {
		if (on) {
			addClass(this.graph_panel_container, 'has-mode-switch');
			removeClass(this.modeSwitch, 'hide');
		} else {
			addClass(this.modeSwitch, 'hide');
			removeClass(this.graph_panel_container, 'has-mode-switch');
		}
	}

	minimizeGraph(): void {
		addClass(this.world_panel_container, 'minimized');
		this.graph_minimized = true;
		this.resizeScreen();
		this.rerenderGraph();
	}

	maximizeGraph(): void {
		removeClass(this.world_panel_container, 'minimized');
		this.graph_minimized = false;
		this.news_box?.contract();
		this.resizeScreen();
		this.rerenderGraph();
	}

	// ========================================
	// Calculator
	// ========================================

	closeCalculator(): void {
		removeClass(this.el, 'calculator-open');
		removeClass(this.calculator_container, 'open');
		if (this.calculator) this.calculator.destroy();
		this.setGetValueForCalculator(false);
		this.calculator_inner.innerHTML = '';
		this.calculator = null;
		this.calculator_selected = false;
	}

	setGetValueForCalculator(on: boolean): void {
		this.calculator_getting_value = on;
		if (on) {
			addClass(this.el, 'calculator-getting-value');
		} else {
			removeClass(this.el, 'calculator-getting-value');
		}
	}

	// ========================================
	// Modal/Confirm Box
	// ========================================

	confirmBox(params: ConfirmBoxParams): Promise<void> {
		return new Promise(resolve => {
			const cl = params.cl || "";
			const modal = appendElement("div", "bw-modal show", this.el);
			const modalbox = this.modalbox = appendElement('div', 'bw-modal-box ' + cl, modal);
			this.modaldata = {
				params: params,
				modalbox: this.modalbox
			};

			const modaltext = appendElement('div', 'bw-modal-text', this.modalbox);
			this.modalinner = appendElement('div', 'bw-modal-inner', this.modalbox);
			this.modalbuttons = [];
			const modalbuttons = appendElement('div', 'bw-modal-buttons', this.modalbox);
			this.modalOpts = {};
			this.modalInputs = {};

			if (params.allow) {
				addClass(modal, 'allow-clicking');
			}

			if (params.message) {
				modaltext.innerHTML = params.message;
			}

			// Handle inputs
			if (params.inputs) {
				for (const inp of params.inputs) {
					const box = appendElement('div', 'bw-confirmbox-row', this.modalinner!);
					if (inp.label !== undefined) {
						const labElem = appendElement('label', 'bw-confirmbox-label', box, inp.label);
						labElem.setAttribute("for", inp.name);
					}

					let inpElem: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
					if (inp.type === 'select') {
						inpElem = appendElement('select', 'bw-confirmbox-input ' + (inp.c || ''), box) as HTMLSelectElement;
						if (inp.options) {
							for (const opt of inp.options) {
								const optel = appendElement('option', '', inpElem, opt.l);
								optel.setAttribute("value", opt.v);
							}
						}
					} else if (inp.type === 'textarea') {
						inpElem = appendElement('textarea', 'bw-confirmbox-input ' + (inp.c || ''), box) as HTMLTextAreaElement;
					} else {
						inpElem = appendElement('input', 'bw-confirmbox-input ' + (inp.c || ''), box) as HTMLInputElement;
						if (inp.type) {
							inpElem.setAttribute("type", inp.type);
						}
					}

					inpElem.setAttribute("name", inp.name);
					if (inp.default !== undefined) {
						inpElem.value = String(inp.default);
					}
					if (inp.type === 'number') {
						const numVal = parseFloat(inpElem.value);
						inpElem.value = String(isNaN(numVal) ? 0 : numVal);
					}

					this.modalOpts[inp.name] = inpElem.value;
					this.modalInputs[inp.name] = inpElem;

					bindListener(this, inpElem, 'change', (e: Event) => {
						const target = e.target as HTMLElement;
						const name = target.tagName === 'OPTION'
							? (target.parentNode as HTMLElement).getAttribute('name')
							: target.getAttribute('name');
						if (name) {
							this.modalOpts[name] = (target as HTMLInputElement).value;
						}
					});
				}
			}

			// Handle buttons
			if (params.buttons) {
				this.modalbuttons = params.buttons;
				for (let b = 0; b < params.buttons.length; b++) {
					const btn = params.buttons[b];
					const btnelem = appendElement('div', (btn.c || '') + ' btn', modalbuttons);
					btnelem.setAttribute("rel", String(b));
					btnelem.innerHTML = btn.label;

					bindListener(this, btnelem, 'click', () => {
						let shouldClose = true;
						if (btn.click) {
							const result = btn.click(new Event('click'));
							if (result === false) {
								shouldClose = true;
							}
						}
						if (shouldClose) {
							this.closeModal(modal);
							resolve();
						}
					});
				}
			}
		});
	}

	closeModal(modal: HTMLElement): void {
		if (modal.parentNode) {
			modal.parentNode.removeChild(modal);
		}
		this.modalbox = null;
		this.modaldata = null;
	}

	// ========================================
	// Tooltip
	// ========================================

	showTooltip(el: HTMLElement, text: string): void {
		const viewportOffset = el.getBoundingClientRect();
		const trianglesize = 10;
		this.tooltip.innerHTML = text;

		const window_width = window.innerWidth;
		const top = viewportOffset.top;
		const bottom = viewportOffset.bottom;
		const left = viewportOffset.left;
		const width = el.offsetWidth;
		const tipwidth = this.tooltip.offsetWidth;
		const tipheight = this.tooltip.offsetHeight;

		removeClass(this.tooltip_triangle, 'tooltip-top');
		removeClass(this.tooltip_triangle, 'tooltip-bottom');

		if (top - trianglesize - tipheight > 0) {
			this.tooltip.style.top = (top - trianglesize - tipheight) + 'px';
			this.tooltip_triangle.style.top = (top - trianglesize) + 'px';
			addClass(this.tooltip_triangle, 'tooltip-top');
		} else {
			this.tooltip.style.top = (bottom + trianglesize) + 'px';
			this.tooltip_triangle.style.top = bottom + 'px';
			addClass(this.tooltip_triangle, 'tooltip-bottom');
		}

		const centerX = left + (width / 2);
		if (centerX - (tipwidth / 2) > 10) {
			if (centerX + (tipwidth / 2) < window_width - 10) {
				this.tooltip.style.left = (centerX - (tipwidth / 2)) + 'px';
			} else {
				this.tooltip.style.left = (window_width - 10 - tipwidth) + 'px';
			}
		} else {
			this.tooltip.style.left = '10px';
		}

		this.tooltip_triangle.style.left = (centerX - (trianglesize / 2)) + 'px';
		this.tooltip_element = el;
		addClass(this.tooltip, 'active');
		addClass(this.tooltip_triangle, 'active');
	}

	hideTooltip(el?: HTMLElement): void {
		if (!el || this.tooltip_element === el) {
			if (this.tooltip_timeout) {
				clearTimeout(this.tooltip_timeout);
				this.tooltip_timeout = null;
			}
			removeClass(this.tooltip, 'active');
			removeClass(this.tooltip_triangle, 'active');
			this.tooltip.innerHTML = "";
			this.tooltip_element = null;
		}
	}

	// ========================================
	// Update/Render Loop
	// ========================================

	update(): void {
		this.timer++;
		if (!this.loadingDay) {
			this.renderIfNeeded();
		}
		if (this.timer > this.update_rate && !this.paused && this.canRunNextDay()) {
			this.world?.newDay();
			this.timer = 0;
		}
	}

	/**
	 * Yield to the UI/event loop if enough time has elapsed since the last
	 * yield, so long-running newDay()s don't lock out pause / slider /
	 * control input. Returns:
	 *   - a Promise the caller should `await` when a yield is due
	 *   - nothing (void) when no yield is needed — caller MUST NOT `await`
	 *     in that case, because `await undefined` still schedules a
	 *     microtask (~7 µs/call) and that overhead used to cost ~30 ms/day
	 *     at scale.
	 *
	 * Per-pop hot paths use the conditional-await pattern:
	 *   const yp = this.system.renderIfNeeded(this.world);
	 *   if (yp !== undefined) await yp;
	 *
	 * This preserves the original "yield to keep UI responsive" intent
	 * (slow days still let pause messages land within ~render_time ms)
	 * while not paying microtask overhead on every pop iteration.
	 */
	renderIfNeeded(): Promise<void> | void {
		if (this.forceDayEnd) return;
		const time = new Date().getTime();
		const time_since_last_rendered = time - this.last_rendered;
		if (time_since_last_rendered <= this.render_time) return;
		this.render();
		return new Promise(resolve => setTimeout(resolve, 1));
	}

	render(): void {
		const screen = this.mainScreen;
		if (!screen) return;

		screen.update(1);
		const rendered = screen.render();

		if (rendered) {
			const context = this.zoomCanvas.getContext("2d");
			if (context) {
				context.clearRect(0, 0, this.zoomCanvas.width, this.zoomCanvas.height);
				context.save();
				context.drawImage(
					screen.canvas,
					0, 0, screen.canvas.width, screen.canvas.height,
					0, 0, this.zoomCanvas.width, this.zoomCanvas.height
				);
				context.restore();
			}
		}
		this.last_rendered = new Date().getTime();
	}

	rerenderGraph(): void {
		if (this.graph) this.graph.needs_render = true;
		if (this.visualizer) this.visualizer.needs_render = true;
	}

	resizeScreen(): void {
		const width = this.graph_container.getBoundingClientRect().width - 2;
		const height = width / 1.6;
		this.zoomCanvas.width = width;
		this.zoomCanvas.height = height;
		this.rerenderGraph();
	}

	// ========================================
	// Keyboard Input
	// ========================================

	keydown(key: string): void {
		if (this.calculator_selected && this.calculator) {
			this.calculator.keydown(key);
		} else {
			if (key === ' ') {
				this.control_toggle();
			} else if (key === 'Enter') {
				// Modal confirm
			} else if (key === '.') {
				this.control_next();
			}
		}
	}

	keyup(_key: string): void {
		// Override in implementation
	}

	// ========================================
	// Pause State
	// ========================================

	setPaused(paused: boolean): void {
		this.paused = paused;
		if (paused) {
			this.control_pause();
		}
	}
}

export default System;
