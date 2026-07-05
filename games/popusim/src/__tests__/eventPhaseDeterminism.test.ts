/**
 * Feature tests: events, phase ordering, and determinism.
 *
 * - Events: count limit, condition firing, resource-modifying result,
 *   transmit-typed result, win/lose result.
 * - Phases: cross-phase ordering matters; same configuration with phases
 *   reordered yields different results.
 * - Determinism: identical seeds give identical traces; different seeds
 *   diverge under sd > 0.
 */

import { describe, it, expect } from 'vitest';
import {
	bootScenario,
	runDays,
	totalPop,
	popWithTrait,
	globalResource,
} from './_helpers';

describe('Event: count limit', () => {
	it('event with times=3 fires exactly 3 times', { timeout: 30000 }, async () => {
		// Each firing adds 100 to the "score" resource. Condition: always-true
		// (use age >= 0). After many days, score = 300.
		const scenario: Record<string, unknown> = {
			name: 'EventCount',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'p', name: 'P' }],
			trait: [],
			vector: [],
			resource: [{ key: 'score', name: 'Score', value: 0, global: true, signed: true }],
			site: [{ key: 'site_a', name: 'Site A', pop: 1 }],
			event: [{
				key: 'pulse', global: true, times: 3, phase: 'p',
				condition: [{
					op: '>=',
					exp: [{ type: 'age' }],
					exp2: [{ type: 'number', value: 0 }],
				}],
				result: [{
					type: 'resource', resource: 'score',
					exp: [
						{ type: 'resource', resource: 'score' },
						{ op: '+', type: 'number', value: 100 },
					],
				}],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 10);
		// times=3: should fire on day 0 (start updateAllPhases) + days 1, 2.
		// After that, count is 0, so no more firings.
		expect(globalResource(world, 'score')).toBe(300);
	});
});

describe('Event: unlimited count', () => {
	it('times=-1 fires every day forever', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'EventUnlim',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'p', name: 'P' }],
			trait: [],
			vector: [],
			resource: [{ key: 'tick', name: 'Tick', value: 0, global: true, signed: true }],
			site: [{ key: 'site_a', name: 'Site A', pop: 1 }],
			event: [{
				key: 'every_day', global: true, times: -1, phase: 'p',
				condition: [{
					op: '>=', exp: [{ type: 'age' }], exp2: [{ type: 'number', value: 0 }],
				}],
				result: [{
					type: 'resource', resource: 'tick',
					exp: [
						{ type: 'resource', resource: 'tick' },
						{ op: '+', type: 'number', value: 1 },
					],
				}],
			}],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 20);
		// 1 (start phase pass) + 20 day-loop iterations = 21 firings.
		expect(globalResource(world, 'tick')).toBe(21);
	});
});

describe('Event: triggers transmission', () => {
	it('event with type=transmit produces a precise shed at firing', { timeout: 30000 }, async () => {
		// Event fires on day 5 and transmits 1000 vectors that add the "alarm" trait.
		// Before day 5: 0 alarmed. Day 5 onward: ~1000 alarmed.
		const scenario: Record<string, unknown> = {
			name: 'EventTransmit',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'p', name: 'P' }],
			trait: [{ key: 'alarm', name: 'Alarm' }],
			vector: [{ key: 'v_alarm', name: 'Alarm vec' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 1_000_000 }],
			event: [{
				key: 'panic', global: true, times: 1, phase: 'p',
				condition: [{
					op: '==', exp: [{ type: 'age' }],
					exp2: [{ type: 'number', value: 5 }],
				}],
				result: [{
					type: 'transmit',
					vector: ['v_alarm'], apply: ['alarm'],
					precise: true, phase: 'p',
					exp: [{ type: 'number', value: 1000 }],
				}],
			}],
		};
		const world = await bootScenario(scenario);

		// world.start() ran one phase pass at age=1. Event condition: age==5.
		// Day 1, 2, 3, 4 should not fire.
		await runDays(world, 3); // age now 4
		expect(popWithTrait(world, 'alarm')).toBe(0);

		await runDays(world, 1); // age = 5, event fires
		expect(popWithTrait(world, 'alarm')).toBe(1000);

		// Subsequent days: count is 0, no further firings. Alarmed count stays.
		await runDays(world, 3);
		expect(popWithTrait(world, 'alarm')).toBe(1000);
		expect(totalPop(world)).toBe(1_000_000);
	});
});

describe('Phase ordering: across phases is meaningful', () => {
	function makeScenario(phaseOrder: ['cure', 'spread'] | ['spread', 'cure']): Record<string, unknown> {
		return {
			name: 'PhaseOrder_' + phaseOrder.join('_'),
			start_age: 0,
			use_date: false,
			phase: phaseOrder.map(k => ({ key: k, name: k })),
			trait: [{
				key: 'infected', name: 'Infected',
				prob: 0.05,
				transmit: [{ vector: ['v1'], apply: ['infected'], value: 1.5, sd: 0, phase: 'spread' }],
				progress: [{ vector: ['v_rec'], remove: ['infected'], value: 0.5, sd: 0, phase: 'cure' }],
			}],
			vector: [
				{ key: 'v1', name: 'V1' },
				{ key: 'v_rec', name: 'Rec' },
			],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};
	}

	it('cure→spread vs spread→cure produce different infected counts', { timeout: 30000 }, async () => {
		const worldA = await bootScenario(makeScenario(['cure', 'spread']));
		const worldB = await bootScenario(makeScenario(['spread', 'cure']));

		await runDays(worldA, 20);
		await runDays(worldB, 20);

		const aInf = popWithTrait(worldA, 'infected');
		const bInf = popWithTrait(worldB, 'infected');

		// Both should still have positive infected counts.
		expect(aInf).toBeGreaterThan(0);
		expect(bInf).toBeGreaterThan(0);

		// Cure-then-spread has same-day re-spread by survivors before next cure;
		// spread-then-cure cures fresh infections on the same day. The two
		// orderings produce measurably different totals.
		expect(Math.abs(aInf - bInf)).toBeGreaterThan(100);
		expect(totalPop(worldA)).toBe(100_000);
		expect(totalPop(worldB)).toBe(100_000);
	});
});

describe('Determinism: same seed → same trace', () => {
	it('two boots with identical seed give identical state', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'Determinism',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'infected', name: 'Infected',
				prob: 0.01,
				transmit: [{ vector: ['v1'], apply: ['infected'], value: 0.3, sd: 0.5, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};

		const a = await bootScenario(scenario, 42);
		const b = await bootScenario(scenario, 42);

		for (let i = 0; i < 20; i++) {
			await a.newDay();
			await b.newDay();
			expect(popWithTrait(a, 'infected')).toBe(popWithTrait(b, 'infected'));
		}
	});
});

describe('Determinism: different seeds diverge', () => {
	it('different seeds give different state when sd > 0', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'Divergence',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'infected', name: 'Infected',
				prob: 0.01,
				transmit: [{ vector: ['v1'], apply: ['infected'], value: 0.3, sd: 0.5, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};

		const a = await bootScenario(scenario, 11);
		const b = await bootScenario(scenario, 99);

		await runDays(a, 10);
		await runDays(b, 10);

		const aInf = popWithTrait(a, 'infected');
		const bInf = popWithTrait(b, 'infected');

		// Both should be positive and DIFFER somewhere (bytewise equal would
		// indicate something's making them deterministic across seeds).
		expect(aInf).toBeGreaterThan(0);
		expect(bInf).toBeGreaterThan(0);
		expect(aInf).not.toBe(bInf);
	});
});

describe('Determinism: sd=0 deterministic per seed but not across seeds', () => {
	it('sd=0 + same seed → bit-identical trace; sd=0 + different seeds → small rounding-driven differences', { timeout: 30000 }, async () => {
		// With sd=0, the shed-amount draw collapses to the mean (no LCG draw).
		// The fractional-rounding step still uses HashRand, which is keyed by
		// the world seed, so different seeds yield slightly different rounding
		// outcomes even though the bulk numbers are deterministic.
		const scenario: Record<string, unknown> = {
			name: 'SDZero',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'infected', name: 'Infected',
				prob: 0.001,
				transmit: [{ vector: ['v1'], apply: ['infected'], value: 0.5, sd: 0, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};

		const a = await bootScenario(scenario, 7);
		const b = await bootScenario(scenario, 7);
		await runDays(a, 10);
		await runDays(b, 10);
		// Same seed: identical.
		expect(popWithTrait(a, 'infected')).toBe(popWithTrait(b, 'infected'));

		const c = await bootScenario(scenario, 7);
		const d = await bootScenario(scenario, 99);
		await runDays(c, 10);
		await runDays(d, 10);
		// Different seeds: numbers are CLOSE (since the bulk of the math is
		// deterministic when sd=0), but not identical due to per-(source→
		// target) rounding draws being seed-keyed.
		const cInf = popWithTrait(c, 'infected');
		const dInf = popWithTrait(d, 'infected');
		expect(cInf).toBeGreaterThan(0);
		expect(dInf).toBeGreaterThan(0);
		// Within ~1% of each other (rounding-only divergence).
		expect(Math.abs(cInf - dInf) / cInf).toBeLessThan(0.01);
	});
});

describe('Population conservation under multi-trait transitions', () => {
	it('total pop is preserved across infections, deaths, and immunity transitions', { timeout: 60000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'PopConserve',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'infect', name: 'Infect' },
				{ key: 'recover', name: 'Recover' },
				{ key: 'die', name: 'Die' },
			],
			trait: [
				{
					key: 'infected', name: 'Infected',
					prob: 0.01,
					transmit: [{ vector: ['v_inf'], apply: ['infected'], value: 0.3, sd: 0.1, phase: 'infect' }],
					progress: [
						{ vector: ['v_rec'], apply: ['immune'], remove: ['infected'], value: 0.1, sd: 0.05, phase: 'recover' },
						{ vector: ['v_die'], apply: ['dead'], remove: ['infected'], value: 0.02, sd: 0.01, phase: 'die' },
					],
				},
				{ key: 'immune', name: 'Immune', infect_mod: [{ vector: ['v_inf'], mult: 0 }] },
				{ key: 'dead', name: 'Dead', infect_mod: [
					{ vector: ['v_inf'], mult: 0 },
					{ vector: ['v_rec'], mult: 0 },
					{ vector: ['v_die'], mult: 0 },
				]},
			],
			vector: [
				{ key: 'v_inf', name: 'Inf' },
				{ key: 'v_rec', name: 'Rec' },
				{ key: 'v_die', name: 'Die' },
			],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};
		const world = await bootScenario(scenario);

		// Conserve population at every checkpoint.
		expect(totalPop(world)).toBe(100_000);
		await runDays(world, 30);
		expect(totalPop(world)).toBe(100_000);
		await runDays(world, 70);
		expect(totalPop(world)).toBe(100_000);
	});
});
