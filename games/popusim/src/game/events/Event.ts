/**
 * Event - Triggered events with conditions and results
 * EventCondition - Condition that must be met for event to trigger
 */

import { BWObj } from '../../core/BWObj';
import { boolVal, intVal, numVal, parseChildren, selectVal, strVal } from '../../core/parse';
import { removeFrom } from '../../core/utils';
import type { Expression } from '../tracking/Expression';
import { EventResult } from './EventResult';

// Forward references
interface EventWorldLike {
	sites: EventSiteLike[];
	addToPhase(obj: unknown, phase: string): { index: number };
	createExpressionFromEventValues(values: EventValue[]): Expression;
}

interface EventSiteLike {
	key: string;
}

/**
 * Event - A triggered event with conditions and results
 */
export class Event extends BWObj {
	_eventWorld: EventWorldLike;

	// From attrs
	key: string = 'event';
	global: boolean = false;
	times: number = 1;
	phase: string = '';
	conditions: EventCondition[] = [];
	results: EventResult[] = [];

	// Runtime state
	count: number = 1;
	phase_index: number = 0;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		this._eventWorld = world as unknown as EventWorldLike;
		const d = this.data;
		this.key = strVal(d, 'key', 'event');
		this.global = boolVal(d, 'global');
		this.times = numVal(d, 'times', 1);
		this.phase = strVal(d, 'phase', '');
		this.conditions = parseChildren(this, d, 'condition', EventCondition);
		this.results = parseChildren(this, d, 'result', EventResult);
	}

	init(): void {
		this.count = this.times;
		for (const condition of this.conditions) {
			condition.init();
		}
		for (const result of this.results) {
			result.init();
		}
		this.phase_index = this._eventWorld.addToPhase(this, this.phase).index;
	}

	createExpressions(): void {
		for (const condition of this.conditions) {
			condition.createExpressions();
		}
		for (const result of this.results) {
			result.createExpressions();
		}
	}

	updateEvent(): Promise<void> {
		return this._updateAsync();
	}

	private async _updateAsync(): Promise<void> {
		if (this.global) {
			await this.updateFor(null);
		} else {
			for (const site of this._eventWorld.sites) {
				await this.updateFor(site);
			}
		}
	}

	async updateFor(site: EventSiteLike | null): Promise<void> {
		if (this.count === 0) return;

		let ok = true;

		if (this.conditions.length === 0) {
			ok = true;
		} else {
			ok = false;
			for (const condition of this.conditions) {
				if (ok && condition.or) continue;
				const istrue = condition.isTrue(site);
				if (!istrue && !condition.or) {
					ok = false;
					break;
				} else if (istrue) {
					ok = true;
				}
			}
		}

		if (ok) {
			if (this.count > 0) this.count -= 1;
			for (const result of this.results) {
				await result.trigger(site as unknown as Parameters<typeof result.trigger>[0]);
			}
		}
	}

	destroy(): void {
		super.destroy();
		const parent = this.parent as unknown as { events?: Event[] };
		if (parent.events) removeFrom(parent.events, this);
	}
}

/**
 * EventCondition - A condition that must be met for an event to trigger
 */
export class EventCondition extends BWObj {
	_eventWorld: EventWorldLike;
	evt: Event;

	// From attrs
	or: boolean = false;
	op: string = '==';
	exp: EventValue[] = [];
	exp2: EventValue[] = [];

	// Runtime
	expression1: Expression | null = null;
	expression2: Expression | null = null;

	constructor(evt: BWObj, data?: Record<string, unknown>) {
		super(evt, data);
		this.evt = evt as unknown as Event;
		this._eventWorld = (evt as unknown as Event)._eventWorld;
		const d = this.data;
		this.or = boolVal(d, 'or');
		this.op = selectVal(d, 'op', ['==', '<', '<=', '>', '>=', '!='] as const, '==');
		this.exp = parseChildren(this, d, 'exp', EventValue);
		this.exp2 = parseChildren(this, d, 'exp2', EventValue);
	}

	init(): void {
		for (const value of this.exp) {
			value.init();
		}
		for (const value of this.exp2) {
			value.init();
		}
	}

	createExpressions(): void {
		this.expression1 = this._eventWorld.createExpressionFromEventValues(this.exp);
		this.expression2 = this._eventWorld.createExpressionFromEventValues(this.exp2);
	}

	getName(): string {
		let string = '';
		for (const value of this.exp) {
			string += value.getName() + ' ';
		}
		string += this.op + ' ';
		for (const value of this.exp2) {
			string += value.getName() + ' ';
		}
		return string;
	}

	isTrue(site: EventSiteLike | null): boolean {
		if (!this.expression1 || !this.expression2) return false;

		const value_1 = this.expression1.evaluate(site as never);
		const value_2 = this.expression2.evaluate(site as never);

		switch (this.op) {
			case '==': return value_1 == value_2;
			case '!=': return value_1 != value_2;
			case '<': return value_1 < value_2;
			case '<=': return value_1 <= value_2;
			case '>': return value_1 > value_2;
			case '>=': return value_1 >= value_2;
			default: return false;
		}
	}

	destroy(): void {
		super.destroy();
		const parent = this.parent as unknown as { conditions?: EventCondition[] };
		if (parent.conditions) removeFrom(parent.conditions, this);
	}
}

// Forward declaration for EventResult and EventValue - will be in separate file
export class EventValue extends BWObj {
	_eventWorld: EventWorldLike | null = null;

	// From attrs
	op: string = '+';
	type: string = 'number';
	action: string = '';
	resource: string = '';
	trait: string = '';
	value: number = 0;
	neg_offset: number = 0;
	incdec: string = '';
	calc: string = '';

	// Runtime
	resource_obj: unknown = null;
	action_obj: unknown = null;
	trait_obj: unknown = null;
	track_obj: unknown = null;

	constructor(par: BWObj, data?: Record<string, unknown>) {
		super(par, data);
		this._eventWorld = (par as unknown as { _eventWorld?: EventWorldLike })._eventWorld ?? null;
		const d = this.data;
		this.op = selectVal(d, 'op', ['+', '-', '/', '*', '^'] as const, '+');
		this.type = selectVal(
			d, 'type',
			['(', ')', 'number', 'random', 'action', 'resource', 'trait', 'age'] as const,
			'number',
		);
		this.action = strVal(d, 'action', '');
		this.resource = strVal(d, 'resource', '');
		this.trait = strVal(d, 'trait', '');
		this.value = numVal(d, 'value', 0);
		this.neg_offset = intVal(d, 'neg_offset', 0);
		this.incdec = selectVal(d, 'incdec', ['', 'inc', 'dec'] as const, '');
		this.calc = selectVal(d, 'calc', ['', 'sum', 'avg'] as const, '');
	}

	init(): void {
		this.resource_obj = null;
		this.action_obj = null;
		this.trait_obj = null;
		this.track_obj = null;
		// Resource/action/trait would be resolved at init time
	}

	getName(): string {
		let string = this.op + ' ';
		switch (this.type) {
			case '(': string = '('; break;
			case ')': string = ')'; break;
			case 'number': string += String(this.value); break;
			case 'random': string += 'random(0 - ' + this.value + ')'; break;
			case 'resource': string += 'resource ' + this.resource; break;
			case 'action': string += 'action ' + this.action; break;
			case 'trait': string += 'trait ' + this.trait; break;
			case 'age': string += 'current day'; break;
		}
		return string;
	}

	destroy(): void {
		super.destroy();
		const parent = this.parent as unknown as { exp?: EventValue[]; exp2?: EventValue[] };
		if (parent.exp?.length) removeFrom(parent.exp, this);
		if (parent.exp2?.length) removeFrom(parent.exp2, this);
	}
}

export default Event;
