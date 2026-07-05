/**
 * CustomMetric — player-defined metric.
 *
 * A CustomMetric owns an Expression that is evaluated each day for the world
 * (plus per-site if the metric tracks site-local readouts). It is created at
 * runtime by the player via the calculator popup, never as part of the
 * scenario JSON. Persistence across scenario reset is handled by World via
 * `custom_metrics_prev` rebinding in `start()`.
 *
 * Shape mirrors legacy `CustomMetric` (script.js:7687) plus a `dep_tracker_keys`
 * field that lets the World reverse-index which trackers a metric depends on,
 * so deletion of a referenced trait/resource hides instead of destroys.
 */

import { BWObj } from '../../core/BWObj';
import { BColor } from '../../core/BColor';
import { boolVal, intVal, parseColor, strVal } from '../../core/parse';
import type { Expression, ExpressionValue } from './Expression';

/** Serialized form of an ExpressionValue — what we round-trip through reset. */
export interface SerializedExprValue {
	type: string;
	subtype: string | null;
	/** Number, paren type, op string, or a TrackerCalcSpec. */
	value: SerializedExprValue[] | TrackerCalcSpec | string | number | null;
}

export interface TrackerCalcSpec {
	__trackerCalc: true;
	/** `${'trait'|'resource'|'metric'}:${key}` so we can rebind across reset. */
	trackerKindKey: string;
	neg_offset: number;
	offset: number;
	incdec: string;
	calc: string | null;
}

/**
 * Player-defined metric. Lives in `world.custom_metrics`.
 */
export class CustomMetric extends BWObj {
	declare world: BWObj & {
		custom_metrics_index: number;
		evaluateMetricKeyTrackers?: (keys: string[]) => unknown[];
	};

	// Display attrs (mirror legacy lines 7696-7702)
	name: string = '';
	color: BColor = new BColor(null, { value: '0,0,0,1' });
	perc: boolean = false;
	precision: number = 0;

	// Runtime
	base_key: string = '';
	index: number = 0;
	hidden: boolean = false;

	/** The compiled Expression. Built by World.addMetric from `expression_data`
	 * (or copied directly when handed in from the calculator UI). */
	expression!: Expression;

	/** Serialized expression values — kept for reset persistence so we can
	 * rebuild the Expression against the new World's tracker registry. */
	expression_data: SerializedExprValue[] = [];

	/** Tracker base_keys this metric reads, namespaced as `kind:key`. Populated
	 * by World.addMetric. The reverse index `tracker.referenced_by_metrics`
	 * mirrors this so we can iterate quickly when a tracker is hidden. */
	dep_tracker_keys: string[] = [];

	/** True when at least one referenced tracker is hidden. The history row
	 * renders grayed-out and the expression is short-circuited to 0 — the
	 * value is meaningless until the dependency is visible again. */
	grayed_out: boolean = false;

	constructor(world: BWObj, data?: Record<string, unknown>) {
		super(world, data);
		const d = this.data;
		this.key = strVal(d, 'key', '');
		this.name = strVal(d, 'name', '');
		this.color = parseColor(this, d, 'color', '0,0,0,1');
		this.perc = boolVal(d, 'perc');
		this.precision = intVal(d, 'precision', 0);

		// Stash the serialized expression for reset rebinding. The data object
		// holds it under `expression_data` for legacy parity (`expression` is
		// the live object, never serialized).
		const exprData = (data && (data.expression_data as SerializedExprValue[])) || [];
		this.expression_data = exprData.slice();
		if (!this.base_key) this.base_key = '';
	}

	getName(): string {
		return this.name && this.name !== '' ? this.name : `Metric ${this.index + 1}`;
	}

	/**
	 * Evaluate against a (site|null, day|undefined) pair. Short-circuits to 0
	 * when grayed-out so a partially-broken metric does not display garbage.
	 */
	evaluate(site: unknown, day?: number): number {
		if (this.grayed_out) return 0;
		if (!this.expression) return 0;
		return this.expression.evaluate(site as never, day as never);
	}

	destroy(): void {
		super.destroy();
	}
}

/**
 * Serialize an ExpressionValue tree into a JSON-friendly shape that survives
 * scenario reset. TrackerCalc references are reduced to `{kind:key}` so they
 * can rebind to the new World's trackers.
 */
export function serializeExpression(values: ExpressionValue[]): SerializedExprValue[] {
	const out: SerializedExprValue[] = [];
	for (const v of values) out.push(serializeExprValue(v));
	return out;
}

function serializeExprValue(v: ExpressionValue): SerializedExprValue {
	const subtype = v.subtype ?? null;
	const val = v.value;

	// Nested expression
	if (Array.isArray(val)) {
		return { type: v.type, subtype, value: serializeExpression(val as ExpressionValue[]) };
	}

	// TrackerCalc reference — collapse to {kind, key, ...calc opts}
	if (val && typeof val === 'object' && (val as { tracker?: unknown }).tracker) {
		const tc = val as {
			tracker: { type: number; key: string };
			neg_offset: number;
			offset: number;
			incdec: string;
			calc: string | null;
		};
		const kind = tc.tracker.type === 2 ? 'resource' : tc.tracker.type === 3 ? 'metric' : 'trait';
		const spec: TrackerCalcSpec = {
			__trackerCalc: true,
			trackerKindKey: `${kind}:${tc.tracker.key}`,
			neg_offset: tc.neg_offset,
			offset: tc.offset,
			incdec: tc.incdec,
			calc: tc.calc,
		};
		return { type: v.type, subtype, value: spec };
	}

	// Number / op string / paren / null
	const primitive =
		typeof val === 'number' || typeof val === 'string' || val === null
			? (val as number | string | null)
			: null;
	return { type: v.type, subtype, value: primitive };
}

export default CustomMetric;
