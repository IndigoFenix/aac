/**
 * Custom metric & correlation end-to-end test.
 *
 * Constructs a minimal scenario, advances a few days so trait history
 * accumulates, then exercises the player-side mutation paths:
 *   - addMetric: builds a CustomMetric whose expression references a
 *     scenario-defined trait, runs it through the World, and verifies
 *     history was retroactively populated.
 *   - addCorrelationTrait: creates a correlation pseudo-trait against the
 *     same trait and verifies the new tracker exists.
 *   - reset persistence: serializes the metric's expression_data, builds a
 *     fresh world, replays via custom_metrics_prev, and verifies the
 *     expression rebinds.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../wireup';
import { System } from '../controller/System';
import { World } from '../controller/World';
import { CustomMetric, serializeExpression } from '../game/tracking/CustomMetric';
import { Expression, ExpressionValue } from '../game/tracking/Expression';
import { TrackerCalc } from '../game/tracking/Tracker';
import { VALUE_TYPE, VALUE_SUBTYPE, INCDEC } from '../types/constants';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function makeMinimalScenario(): Record<string, unknown> {
	return {
		name: 'MetricTest',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{
			key: 'infected', name: 'Infected', color: '255,0,0,1',
			prob: 0.05,
			transmit: [{
				vector: ['v1'], apply: ['infected'],
				value: 0.5, sd: 0, phase: 'spread',
			}],
		}],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [{ key: 'site_a', name: 'Site A', pop: 1000 }],
	};
}

async function bootWorld(): Promise<World> {
	const system = new System(null);
	system.rand.seed(12345);
	(system as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => { };
	const world = new World(system as never, makeMinimalScenario());
	(system as unknown as { world: World }).world = world;
	await world.start();
	return world;
}

/** Build a metric whose expression is just `trait:infected` (the trait count). */
function buildInfectedMetric(world: World): CustomMetric {
	const tracker = world.trait_trackers_kv['infected'];
	expect(tracker).toBeDefined();
	const tc = new TrackerCalc(tracker as never, { neg_offset: 0, offset: 0, incdec: INCDEC.CURRENT, calc: null });
	const exp = new Expression(world as never, [
		new ExpressionValue(world as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.NUM, 0),
		new ExpressionValue(world as never, VALUE_TYPE.OP, null, '+'),
		new ExpressionValue(world as never, VALUE_TYPE.VAL, VALUE_SUBTYPE.TRACKER, tc),
	]);
	const metric = new CustomMetric(world as never, {
		name: 'Infected count',
		color: '0,255,0,1',
		perc: 0,
		precision: 0,
	});
	metric.expression = exp;
	metric.expression_data = serializeExpression(exp.values);
	return metric;
}

describe('CustomMetric', () => {
	it('addMetric retroactively populates per-day history', { timeout: 30000 }, async () => {
		const world = await bootWorld();
		for (let i = 0; i < 5; i++) await world.newDay();

		const metric = buildInfectedMetric(world);
		world.addMetric(metric);

		expect(world.custom_metrics).toHaveLength(1);
		expect(world.metric_trackers_kv[metric.base_key]).toBeDefined();
		expect(world.metric_hist_kv[metric.base_key]).toBeDefined();

		// History should have been replayed across past days; the global metric
		// history's `started` flag is true and `val.length` reflects the days
		// processed so far.
		const hist = world.metric_hist_kv[metric.base_key] as unknown as { started: boolean; val: number[] };
		expect(hist.started).toBe(true);
		expect(hist.val.length).toBeGreaterThan(0);

		// Values should equal the trait's count for the same days. Sample a
		// recent day (last index) — both should equal the live infected count.
		const traitHist = world.trait_hist_kv['infected'] as unknown as { val: number[] };
		const last = hist.val[hist.val.length - 1];
		expect(last).toBeCloseTo(traitHist.val[traitHist.val.length - 1], 5);
	});

	it('removeCustomMetric tears down tracker and history', { timeout: 30000 }, async () => {
		const world = await bootWorld();
		const metric = buildInfectedMetric(world);
		world.addMetric(metric);
		const baseKey = metric.base_key;

		world.removeCustomMetric(metric);
		expect(world.custom_metrics).toHaveLength(0);
		expect(world.metric_trackers_kv[baseKey]).toBeUndefined();
		expect(world.metric_hist_kv[baseKey]).toBeUndefined();
	});

	it('serialized expression rebinds across reset via custom_metrics_prev', { timeout: 30000 }, async () => {
		const worldA = await bootWorld();
		for (let i = 0; i < 3; i++) await worldA.newDay();
		const metric = buildInfectedMetric(worldA);
		worldA.addMetric(metric);
		expect(worldA.custom_metrics).toHaveLength(1);
		const exprDataSnapshot = (metric as unknown as { expression_data: unknown[] }).expression_data;
		expect(exprDataSnapshot.length).toBeGreaterThan(0);

		// Boot a fresh world (with its own System) and hand the previous metric
		// in via custom_metrics_prev. Re-using a single System across two
		// world.start() calls trips its site-teardown path.
		const systemB = new System(null);
		systemB.rand.seed(99);
		(systemB as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => { };
		const worldB = new World(systemB as never, makeMinimalScenario());
		(systemB as unknown as { world: World }).world = worldB;
		(worldB as unknown as { custom_metrics_prev: unknown[] }).custom_metrics_prev = [metric];
		await worldB.start();

		expect(worldB.custom_metrics).toHaveLength(1);
		const reboundMetric = worldB.custom_metrics[0] as unknown as { expression: Expression };
		expect(reboundMetric.expression).toBeDefined();
		// The rebound expression must reference the new world's tracker, not
		// the old one. Walk the expression and find the TrackerCalc.
		const tc = reboundMetric.expression.values.find(
			v => v.subtype === VALUE_SUBTYPE.TRACKER,
		)?.value as { tracker: { key: string } } | undefined;
		expect(tc?.tracker.key).toBe('infected');
		// Most importantly: the rebound tracker must be the new world's, not the old.
		expect(tc?.tracker).toBe(worldB.trait_trackers_kv['infected']);
	});
});

describe('Correlation trait', () => {
	it('addCorrelationTrait creates a tracker and per-site histories', { timeout: 30000 }, async () => {
		const world = await bootWorld();
		for (let i = 0; i < 3; i++) await world.newDay();

		const data = {
			name: 'Has infection',
			color: '128,128,255,1',
			def_or: ['infected'],
		};
		const trait = world.addCorrelationTrait(data);

		expect((trait as unknown as { is_correlation: boolean }).is_correlation).toBe(true);
		expect(world.trait_trackers_kv[trait.base_key]).toBeDefined();
		// Per-site history exists too.
		for (const site of world.sites) {
			expect(site.trait_hist_kv[trait.base_key]).toBeDefined();
		}
		// Custom-traits snapshot has the entry.
		expect(world.custom_traits).toHaveLength(1);
	});
});
