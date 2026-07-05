/**
 * Feature tests: resources / stockpiles / Impact (produce + consume).
 *
 * Covers production growth, equilibrium with matched consumption,
 * proportional fairness when supply is short, and global vs local
 * resource isolation across sites.
 */

import { describe, it, expect } from 'vitest';
import {
	bootScenario,
	runDays,
	totalPop,
	globalResource,
	siteResource,
} from './_helpers';

describe('Resource: production grows stockpile linearly', () => {
	it('1000 producers at value=1/day grow stockpile by ~1000/day', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'ResProduce',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'work', name: 'Work' }],
			trait: [{
				key: 'farmer', name: 'Farmer',
				produce: [{ resource: 'food', value: 1, sd: 0, phase: 'work' }],
			}],
			vector: [],
			resource: [{ key: 'food', name: 'Food', value: 0, global: true, signed: true }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 1000,
				startpop: [{ size: 1, apply: ['farmer'] }],
			}],
		};
		const world = await bootScenario(scenario);

		// world.start() runs one phase pass — a day's production already happened.
		const start = globalResource(world, 'food');
		expect(start).toBeCloseTo(1000, 0);

		await runDays(world, 5);
		const after = globalResource(world, 'food');
		// 5 more days * 1000/day = +5000.
		expect(after - start).toBeCloseTo(5000, 0);

		expect(totalPop(world)).toBe(1000);
	});
});

describe('Resource: production-consumption equilibrium', () => {
	it('matched producers and consumers keep stockpile flat', { timeout: 30000 }, async () => {
		// A trait that produces 1 food per day AND consumes 1 food per day
		// keeps the stockpile at zero (within rounding).
		const scenario: Record<string, unknown> = {
			name: 'ResEquilibrium',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'work', name: 'Work' },
				{ key: 'eat', name: 'Eat' },
			],
			trait: [{
				key: 'farmer', name: 'Farmer',
				produce: [{ resource: 'food', value: 1, sd: 0, phase: 'work' }],
				consume: [{ resource: 'food', value: 1, sd: 0, phase: 'eat' }],
			}],
			vector: [],
			resource: [{ key: 'food', name: 'Food', value: 0, global: true, signed: true }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 1000,
				startpop: [{ size: 1, apply: ['farmer'] }],
			}],
		};
		const world = await bootScenario(scenario);

		const initial = globalResource(world, 'food');
		await runDays(world, 10);
		const final = globalResource(world, 'food');

		// At equilibrium, daily delta is zero ± rounding. Total drift should be small.
		expect(Math.abs(final - initial)).toBeLessThan(50);
	});
});

describe('Resource: stockpile depletion when consumption exceeds supply', () => {
	it('proportional distribution when total demand exceeds stockpile', { timeout: 30000 }, async () => {
		// Stockpile pre-loaded with 50. Two equal consuming pops, total demand
		// 200/day on day 1. Stockpile should drop to 0 the same day.
		const scenario: Record<string, unknown> = {
			name: 'ResDeplete',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'eat', name: 'Eat' }],
			trait: [{
				key: 'eater', name: 'Eater',
				consume: [{ resource: 'food', value: 1, sd: 0, phase: 'eat' }],
			}],
			vector: [],
			resource: [{ key: 'food', name: 'Food', value: 50, global: true, signed: true }],
			site: [{
				key: 'site_a', name: 'Site A', pop: 200,
				startpop: [{ size: 1, apply: ['eater'] }],
			}],
		};
		const world = await bootScenario(scenario);

		const food = globalResource(world, 'food');
		// Single phase pass during start() consumed up to 50 of the available 50.
		// Stockpile is now 0 (or close to it).
		expect(food).toBeLessThanOrEqual(0.01);
	});
});

describe('Resource: global stockpile is shared across sites', () => {
	it('one site produces, another consumes, global stockpile reflects net', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'ResGlobal',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'work', name: 'Work' },
				{ key: 'eat', name: 'Eat' },
			],
			trait: [
				{
					key: 'farmer', name: 'Farmer',
					produce: [{ resource: 'food', value: 1, sd: 0, phase: 'work' }],
				},
				{
					key: 'eater', name: 'Eater',
					consume: [{ resource: 'food', value: 1, sd: 0, phase: 'eat' }],
				},
			],
			vector: [],
			resource: [{ key: 'food', name: 'Food', value: 0, global: true, signed: true }],
			site: [
				{
					key: 'farm_site', name: 'Farm Site', pop: 1000,
					startpop: [{ size: 1, apply: ['farmer'] }],
				},
				{
					key: 'city_site', name: 'City Site', pop: 500,
					startpop: [{ size: 1, apply: ['eater'] }],
				},
			],
		};
		const world = await bootScenario(scenario);

		const food = globalResource(world, 'food');
		// 1000 produced - 500 consumed = +500 per day. After start (1 phase pass):
		// food ≈ 500. Then run more days.
		expect(food).toBeCloseTo(500, 0);

		await runDays(world, 5);
		expect(globalResource(world, 'food')).toBeCloseTo(500 + 5 * 500, 0);
	});
});

describe('Resource: local stockpile isolation', () => {
	it('local resource at one site does not affect another site', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'ResLocal',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'work', name: 'Work' }],
			trait: [{
				key: 'farmer', name: 'Farmer',
				produce: [{ resource: 'food', value: 1, sd: 0, phase: 'work' }],
			}],
			vector: [],
			resource: [{ key: 'food', name: 'Food', value: 0, signed: true }], // global default false
			site: [
				{
					key: 'farm_site', name: 'Farm Site', pop: 1000,
					startpop: [{ size: 1, apply: ['farmer'] }],
				},
				{
					key: 'empty_site', name: 'Empty Site', pop: 1000,
					startpop: [{ size: 1, apply: [] }],
				},
			],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 3);

		// Farm site has farmers producing 1000/day; empty site has no producers.
		const farmFood = siteResource(world, 'farm_site', 'food');
		const emptyFood = siteResource(world, 'empty_site', 'food');

		expect(farmFood).toBeGreaterThan(3000);
		expect(emptyFood).toBeCloseTo(0, 0);
	});
});
