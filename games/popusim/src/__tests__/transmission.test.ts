/**
 * Feature tests: transmission basics.
 *
 * Covers basic exponential growth, saturation, self-transmission no-op,
 * infection + immunity + death pipeline, reinfection after cure,
 * the removal-wins rule for shed trait/cure conflicts, and cross-day
 * shed persistence (creation phase later than infection phase).
 */

import { describe, it, expect } from 'vitest';
import {
	bootScenario,
	runDays,
	totalPop,
	popWithTrait,
	popExactTraits,
} from './_helpers';

function basicInfectionScenario(prob = 0.00001): Record<string, unknown> {
	// 1M pop. 0.00001 * 1M = 10 starting infected.
	return {
		name: 'BasicInfection',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{
			key: 'infected', name: 'Infected', color: '255,0,0,1',
			prob,
			transmit: [{
				vector: ['v1'], apply: ['infected'],
				value: 0.5, sd: 0, phase: 'spread',
			}],
		}],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [{ key: 'site_a', name: 'Site A', pop: 1_000_000 }],
	};
}

describe('transmission: basic growth', () => {
	it('grows by ~50% per day while infected fraction is small', { timeout: 30000 }, async () => {
		const world = await bootScenario(basicInfectionScenario());
		// world.start() runs one full updateAllPhases pass before returning,
		// so the post-boot snapshot already reflects one day of spreading.
		const startInfected = popWithTrait(world, 'infected');
		expect(startInfected).toBeGreaterThan(0);
		expect(startInfected).toBeLessThan(50);

		await runDays(world, 10);
		const after10 = popWithTrait(world, 'infected');

		// Expected ≈ startInfected × 1.5^10 ≈ 57.6×. ±50% tolerance covers
		// rounding-step noise at small counts.
		const expectedRatio = Math.pow(1.5, 10);
		expect(after10 / startInfected).toBeGreaterThan(expectedRatio * 0.5);
		expect(after10 / startInfected).toBeLessThan(expectedRatio * 1.5);

		expect(totalPop(world)).toBe(1_000_000);
	});
});

describe('transmission: saturation', () => {
	it('plateaus at total population and goes no further', { timeout: 30000 }, async () => {
		// Small pop, aggressive transmit value. Should saturate quickly.
		const scenario: Record<string, unknown> = {
			name: 'Saturation',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'infected', name: 'Infected', color: '255,0,0,1',
				prob: 0.1,
				transmit: [{ vector: ['v1'], apply: ['infected'], value: 5, sd: 0, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 100 }],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 50);
		const infected = popWithTrait(world, 'infected');
		expect(infected).toBeLessThanOrEqual(100);
		expect(infected).toBeGreaterThanOrEqual(95);
		expect(totalPop(world)).toBe(100);
	});
});

describe('transmission: self-transmission no-op', () => {
	it('keeps trait counts stable when entire population already has the trait', { timeout: 30000 }, async () => {
		const scenario: Record<string, unknown> = {
			name: 'AllMarked',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'marked', name: 'Marked', color: '0,0,255,1',
				prob: 1.0,
				transmit: [{ vector: ['v1'], apply: ['marked'], value: 1, sd: 0, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 10_000 }],
		};
		const world = await bootScenario(scenario);
		expect(popWithTrait(world, 'marked')).toBe(10_000);
		await runDays(world, 5);
		expect(popWithTrait(world, 'marked')).toBe(10_000);
		expect(totalPop(world)).toBe(10_000);
	});
});

describe('transmission: infection + immunity + death pipeline', () => {
	it('eventually moves majority to immune-or-dead, with no overlap', { timeout: 60000 }, async () => {
		// Phases run in declaration order: infect → recover → die.
		const scenario: Record<string, unknown> = {
			name: 'IID',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'infect', name: 'Infect' },
				{ key: 'recover', name: 'Recover' },
				{ key: 'die', name: 'Die' },
			],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					prob: 0.001,
					transmit: [{ vector: ['v_inf'], apply: ['infected'], value: 0.5, sd: 0, phase: 'infect' }],
					progress: [
						{ vector: ['v_rec'], apply: ['immune'], remove: ['infected'], value: 0.1, sd: 0, phase: 'recover' },
						{ vector: ['v_die'], apply: ['dead'], remove: ['infected'], value: 0.02, sd: 0, phase: 'die' },
					],
				},
				{
					key: 'immune', name: 'Immune', color: '0,255,0,1',
					infect_mod: [{ vector: ['v_inf'], mult: 0 }],
				},
				{
					key: 'dead', name: 'Dead', color: '64,64,64,1',
					infect_mod: [
						{ vector: ['v_inf'], mult: 0 },
						{ vector: ['v_rec'], mult: 0 },
						{ vector: ['v_die'], mult: 0 },
					],
				},
			],
			vector: [
				{ key: 'v_inf', name: 'Infect vec' },
				{ key: 'v_rec', name: 'Recovery vec' },
				{ key: 'v_die', name: 'Death vec' },
			],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 200);

		const total = totalPop(world);
		expect(total).toBe(100_000);

		const immune = popWithTrait(world, 'immune');
		const dead = popWithTrait(world, 'dead');
		const stillInfected = popWithTrait(world, 'infected');

		expect(immune + dead).toBeGreaterThan(total * 0.5);

		// No overlap: removal-wins ensures infected is removed when
		// immune or dead is added, so no population should have all three.
		expect(popExactTraits(world, ['immune', 'infected'])).toBe(0);
		expect(popExactTraits(world, ['dead', 'infected'])).toBe(0);
		// And the cured states themselves are mutually exclusive when both
		// transitions remove `infected` first.
		expect(popExactTraits(world, ['dead', 'immune'])).toBe(0);

		// Final infected should be small relative to recovered+dead.
		expect(stillInfected).toBeLessThan(immune + dead);
	});
});

describe('transmission: reinfection after cure', () => {
	it('cured units can be re-infected (no permanent immunity)', { timeout: 30000 }, async () => {
		// Infected progresses to "clean" (no immune modifier). Once "clean"
		// is the state, the same vector can re-add "infected". Spread rate
		// chosen to outrun cure rate so a non-trivial steady state forms.
		const scenario: Record<string, unknown> = {
			name: 'Reinfect',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'cure', name: 'Cure' },
				{ key: 'spread', name: 'Spread' },
			],
			trait: [
				{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					prob: 0.05,
					transmit: [{ vector: ['v_inf'], apply: ['infected'], value: 2.0, sd: 0, phase: 'spread' }],
					progress: [{ vector: ['v_rec'], remove: ['infected'], value: 0.05, sd: 0, phase: 'cure' }],
				},
			],
			vector: [
				{ key: 'v_inf', name: 'Infect vec' },
				{ key: 'v_rec', name: 'Recovery vec' },
			],
			site: [{ key: 'site_a', name: 'Site A', pop: 100_000 }],
		};
		const world = await bootScenario(scenario);

		await runDays(world, 50);
		const infected = popWithTrait(world, 'infected');
		// With ongoing reinfection, the count should NOT decay to zero.
		expect(infected).toBeGreaterThan(100);
		expect(infected).toBeLessThan(100_000);
		expect(totalPop(world)).toBe(100_000);
	});
});

describe('transmission: removal-wins rule', () => {
	it('shed that adds and removes the same trait results in removal', { timeout: 30000 }, async () => {
		// "marked" trait whose Transmit lists both apply: marked, remove: marked.
		// All currently-marked units producing such sheds should leave others
		// unmarked (no net add) and unmark themselves through the cycle.
		const scenario: Record<string, unknown> = {
			name: 'RemovalWins',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'marked', name: 'Marked', color: '128,0,128,1',
				prob: 0.5,
				transmit: [{
					vector: ['v1'],
					apply: ['marked'],
					remove: ['marked'],
					value: 2, sd: 0, phase: 'spread',
				}],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 10_000 }],
		};
		const world = await bootScenario(scenario);
		const before = popWithTrait(world, 'marked');
		// Initial setup applies a Shed of size value*pop_marked = 2*5000 = 10000
		// vectors with apply: marked, remove: marked. Removal-wins makes every
		// hit on a marked unit unmark it; hits on unmarked produce a no-op.
		// So `marked` strictly drops from 5000 — never grows above it.
		expect(before).toBeLessThan(5_000);

		await runDays(world, 5);

		const after = popWithTrait(world, 'marked');
		// Marked count should monotonically decrease (sheds always remove,
		// never net-add the trait, since add+remove on the same trait → remove).
		expect(after).toBeLessThanOrEqual(before);
		expect(totalPop(world)).toBe(10_000);
	});
});

describe('transmission: cross-day shed persistence', () => {
	it('shed produced on a late phase persists into the next day’s earlier phase', { timeout: 30000 }, async () => {
		// Two phases: "infect" (early) and "shed" (late).
		// A trait shedding on "shed" with vectors that infect on "infect"
		// means the shed sits on the site overnight and infects on day N+1.
		const scenario: Record<string, unknown> = {
			name: 'CrossDay',
			start_age: 0,
			use_date: false,
			phase: [
				{ key: 'infect', name: 'Infect' },
				{ key: 'shed', name: 'Shed' },
			],
			trait: [{
				key: 'infected', name: 'Infected', color: '255,0,0,1',
				prob: 0.001,
				transmit: [{
					vector: ['v1'], apply: ['infected'],
					value: 0.3, sd: 0, phase: 'shed',
				}],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'Site A', pop: 1_000_000 }],
		};
		const world = await bootScenario(scenario);
		const startInfected = popWithTrait(world, 'infected');
		// world.start() ran one updateAllPhases pass; "shed" phase fired
		// after "infect" so the day-0 infections shed but those vectors
		// will only land on day 1's "infect" phase.
		expect(startInfected).toBeGreaterThan(0);

		await runDays(world, 1);
		const day1 = popWithTrait(world, 'infected');
		// Day 1's "infect" phase MUST consume the shed left over from
		// the start() phase pass. Infection grows.
		expect(day1).toBeGreaterThan(startInfected);

		await runDays(world, 1);
		const day2 = popWithTrait(world, 'infected');
		expect(day2).toBeGreaterThan(day1);
		expect(totalPop(world)).toBe(1_000_000);
	});
});
