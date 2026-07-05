/**
 * EventResult - Result that occurs when an event triggers
 */

import { BWObj } from '../../core/BWObj';
import { arrayVal, boolVal, parseChildren, selectVal, strVal } from '../../core/parse';
import { removeFrom, addClass, removeClass } from '../../core/utils';
import type { Expression } from '../tracking/Expression';
import type { Event } from './Event';
import { EventValue } from './Event';
import { Transmit } from '../transmission/Transmit';
import { SynTransmit } from '../simulation/SynTransmit';

// Forward references
interface WorldLike extends BWObj {
	sites: SiteLike[];
	news_pending: NewsItemLike[];
	graph_height: number;
	actions_kv: Record<string, ActionInstanceLike>;
	global_stockpiles_kv: Record<string, StockpileLike>;
	resource_hist_kv: Record<string, HistoryLike>;
	getAction(key: string): ActionLike | null;
	getResource(key: string): ResourceLike | null;
	addNewsItems(): Promise<void>;
	updateGUI(): void;
	onFailure(value: number, text: string): Promise<void>;
	onVictory(value: number, text: string): Promise<void>;
	createExpressionFromEventValues(values: EventValue[]): Expression;
}

interface SiteLike {
	key: string;
	pop: number;
	graph_height: number;
	actions_kv: Record<string, ActionInstanceLike>;
	local_stockpiles_kv: Record<string, StockpileLike>;
	resource_hist_kv: Record<string, HistoryLike>;
	shed_pending_phases: PendingTransmission[][];
}

interface ActionLike {
	key: string;
	global: boolean;
}

interface ActionInstanceLike {
	enabled: boolean;
	setValue(value: number): void;
}

interface ResourceLike {
	key: string;
	global: boolean;
}

interface StockpileLike {
	setValue(value: number): void;
}

interface HistoryLike {
	tracker: { hidden: boolean };
}

interface NewsItemLike {
	evt_result: EventResult;
	auto?: boolean;
	title?: string;
	text?: string;
	siteKey?: string | null;
	day?: number;
}

interface TransmitLike {
	phase_index: number;
	popmult: boolean;
	init?(): void;
}

interface SynTransmitLike extends TransmitLike {}

/**
 * PendingTransmission - Represents a transmission waiting to be processed
 */
export class PendingTransmission {
	origin: EventResult;
	transmit: SynTransmitLike;
	amount_shed: number;

	constructor(origin: EventResult, syn_transmit: SynTransmitLike, amount_shed: number) {
		this.origin = origin;
		this.transmit = syn_transmit;
		this.amount_shed = amount_shed;
	}
}

/**
 * EventResult - A result that occurs when an event triggers
 */
export class EventResult extends BWObj {
	_resultWorld: WorldLike;
	evt: Event;

	// From attrs
	type: string = 'display';
	title: string = '';
	text: string = '';
	auto: boolean = false;
	update_ui: boolean = false;
	action: string = '';
	resource: string = '';
	hide: string = '0';
	apply: string[] = [];
	remove: string[] = [];
	vector: string[] = [];
	popmult: boolean = false;
	precise: boolean = false;
	phase: string = '';
	exp: EventValue[] = [];

	// Runtime
	expression: Expression | null = null;
	transmit: TransmitLike | null = null;
	syn_transmit: SynTransmitLike | null = null;

	constructor(evt: BWObj, data?: Record<string, unknown>) {
		super(evt, data);
		this.evt = evt as unknown as Event;
		this._resultWorld = (evt as unknown as { world: unknown }).world as WorldLike;
		const d = this.data;
		this.type = selectVal(
			d, 'type',
			[
				'display', 'action', 'action_vis', 'resource', 'resource_vis',
				'height', 'transmit', 'failure', 'victory',
			] as const,
			'display',
		);
		this.title = strVal(d, 'title', '');
		this.text = strVal(d, 'text', '');
		this.auto = boolVal(d, 'auto');
		this.update_ui = boolVal(d, 'update_ui');
		this.action = strVal(d, 'action', '');
		this.resource = strVal(d, 'resource', '');
		this.hide = selectVal(d, 'hide', ['0', '1'] as const, '0');
		this.apply = arrayVal(d, 'apply');
		this.remove = arrayVal(d, 'remove');
		this.vector = arrayVal(d, 'vector');
		this.popmult = boolVal(d, 'popmult');
		this.precise = boolVal(d, 'precise');
		this.phase = strVal(d, 'phase', '');
		this.exp = parseChildren(this, d, 'exp', EventValue);
	}

	init(): void {
		for (const value of this.exp) {
			value.init();
		}
		// Build a Transmit + SynTransmit for transmit-typed results so
		// `trigger()` has something to push as a PendingTransmission. Without
		// this, every event with `type: "transmit"` is a silent no-op — its
		// scripted vector release would never fire.
		// Mirrors legacy script.js:7780-7795.
		if (this.type === 'transmit') {
			const data: Record<string, unknown> = {
				apply: this.apply,
				remove: this.remove,
				vector: this.vector,
				popmult: this.popmult,
				precise: this.precise,
				phase: this.phase,
			};
			const t = new Transmit(this._resultWorld as unknown as BWObj, data);
			t.init();
			this.transmit = t as unknown as TransmitLike;
			this.syn_transmit = new SynTransmit(null, t as never) as unknown as SynTransmitLike;
		} else {
			this.transmit = null;
			this.syn_transmit = null;
		}
	}

	createExpressions(): void {
		this.expression = this._resultWorld.createExpressionFromEventValues(this.exp);
	}

	getName(): string {
		let string = '';
		switch (this.type) {
			case 'display': string += 'Display Text'; break;
			case 'action_vis': string += (parseInt(this.hide) ? 'Disable ' : 'Enable ') + this.action; break;
			case 'resource_vis': string += (parseInt(this.hide) ? 'Disable ' : 'Enable ') + this.resource; break;
			case 'action':
				string += 'Set action ' + this.action + ' to ';
				for (const value of this.exp) string += value.getName() + ' ';
				break;
			case 'resource':
				string += 'Set resource ' + (this.resource ?? '???') + ' to ';
				for (const value of this.exp) string += value.getName() + ' ';
				break;
			case 'height':
				string += 'Set graph height to ';
				for (const value of this.exp) string += value.getName() + ' ';
				break;
			case 'transmit':
				string += 'Transmit ';
				if (this.apply.length > 0) string += '+' + this.apply.join('+');
				if (this.remove.length > 0) string += '-' + this.remove.join('-');
				if (this.vector.length > 0) string += 'by ' + this.vector.join(',');
				break;
			case 'failure': string += 'Scenario Failure'; break;
			case 'victory': string += 'Scenario Victory'; break;
		}
		return string;
	}

	async trigger(site: SiteLike | null): Promise<void> {
		if (!this.expression) return;
		const value = this.expression.evaluate(site as never);

		switch (this.type) {
			case 'display': {
				if (this.title || this.text) {
					this._resultWorld.news_pending.push({
						evt_result: this,
						auto: this.auto,
						title: this.title,
						text: this.text,
						siteKey: site ? site.key : null,
						day: (this._resultWorld as unknown as { age: number }).age,
					});
				}
				break;
			}
			case 'action_vis': {
				const action = this._resultWorld.getAction(this.action);
				if (action) {
					if (action.global) {
						this._resultWorld.actions_kv[action.key].enabled = !parseInt(this.hide);
					} else if (site) {
						site.actions_kv[action.key].enabled = !parseInt(this.hide);
					} else {
						for (const s of this._resultWorld.sites) {
							s.actions_kv[action.key].enabled = !parseInt(this.hide);
						}
					}
				}
				break;
			}
			case 'resource_vis': {
				const resource = this._resultWorld.getResource(this.resource);
				const hists: HistoryLike[] = [];
				if (resource) {
					if (resource.global) {
						const hist = this._resultWorld.resource_hist_kv[resource.key];
						if (hist) hists.push(hist);
					} else if (site) {
						const hist = site.resource_hist_kv[resource.key];
						if (hist) hists.push(hist);
					} else {
						for (const s of this._resultWorld.sites) {
							const hist = s.resource_hist_kv[resource.key];
							if (hist) hists.push(hist);
						}
					}
				}
				for (const hist of hists) {
					hist.tracker.hidden = !!parseInt(this.hide);
				}
				break;
			}
			case 'action': {
				const action = this._resultWorld.getAction(this.action);
				if (action) {
					if (action.global) {
						this._resultWorld.actions_kv[action.key].setValue(value);
					} else if (site) {
						site.actions_kv[action.key].setValue(value);
					} else {
						for (const s of this._resultWorld.sites) {
							s.actions_kv[action.key].setValue(value);
						}
					}
				}
				break;
			}
			case 'resource': {
				const resource = this._resultWorld.getResource(this.resource);
				if (resource) {
					if (resource.global) {
						this._resultWorld.global_stockpiles_kv[resource.key].setValue(value);
					} else if (site) {
						site.local_stockpiles_kv[resource.key].setValue(value);
					} else {
						for (const s of this._resultWorld.sites) {
							s.local_stockpiles_kv[resource.key].setValue(value);
						}
					}
				}
				break;
			}
			case 'height': {
				if (site) {
					this._resultWorld.graph_height += value - site.graph_height;
					site.graph_height = value;
				} else {
					this._resultWorld.graph_height = value;
				}
				break;
			}
			case 'transmit': {
				if (this.syn_transmit) {
					const transmit = this.syn_transmit;
					if (isNaN(value)) {
						console.error('EventResult.trigger: NaN amount_shed', this.evt.key, this.expression);
						break;
					}
					if (site) {
						let amount_shed = value;
						if (transmit.popmult) amount_shed *= site.pop;
						const d = new PendingTransmission(this, transmit, amount_shed);
						site.shed_pending_phases[transmit.phase_index].push(d);
					} else {
						// Global event: fan out to every site. Mirrors legacy
						// script.js:7991-7993. popmult is applied per-site.
						for (const s of this._resultWorld.sites) {
							let amount_shed = value;
							if (transmit.popmult) amount_shed *= s.pop;
							const d = new PendingTransmission(this, transmit, amount_shed);
							s.shed_pending_phases[transmit.phase_index].push(d);
						}
					}
				}
				break;
			}
			case 'failure': {
				this._resultWorld.updateGUI();
				await this._resultWorld.onFailure(value, this.text);
				break;
			}
			case 'victory': {
				this._resultWorld.updateGUI();
				await this._resultWorld.onVictory(value, this.text);
				break;
			}
		}
	}

	destroy(): void {
		super.destroy();
		const parent = this.parent as unknown as { results?: EventResult[] };
		if (parent.results) removeFrom(parent.results, this);
	}
}

export default EventResult;
