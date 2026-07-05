/**
 * Feature tests: applyExternalMigration — the DRIVEN cross-site move
 * (grand-dream step 2, Settlement→Composition channel §4b).
 *
 * Unlike route migration (a rate with stochastic rounding), driven moves
 * carry an exact integer count decided by the layer above. Covers: exact
 * totals, uniform-by-syndrome apportionment (largest remainder), clamping
 * to what exists, no-op edge cases, and determinism with no RNG draw
 * (identical results regardless of seed).
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, totalPop, popOnSiteWithTrait } from './_helpers';

interface DrivenWorld {
	applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number;
	sites: Array<{ key: string; pop: number; pops: Array<{ pop: number; syndrome: { trait_keys: string[] } }> }>;
}

function scenario(): Record<string, unknown> {
	return {
		name: 'Driven',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [
			{ key: 'red', name: 'Red', color: '255,0,0,1' },
			{ key: 'blue', name: 'Blue', color: '0,0,255,1' },
		],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [
			{
				key: 'site_a', name: 'A', pop: 100_000,
				// Relative integer weights (PopInit.size is intVal-parsed):
				// 30% red, 20% blue, 50% plain — three syndromes to apportion over.
				startpop: [
					{ size: 3, apply: ['red'] },
					{ size: 2, apply: ['blue'] },
					{ size: 5, apply: [] },
				],
			},
			{ key: 'site_b', name: 'B', pop: 50_000 },
		],
	};
}

function sitePop(world: DrivenWorld, key: string): number {
	const site = world.sites.find(s => s.key === key)!;
	return site.pops.reduce((a, p) => a + p.pop, 0);
}

describe('applyExternalMigration', () => {
	it('moves the exact count and conserves the total', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as DrivenWorld;
		const before = totalPop(world as never);

		const moved = world.applyExternalMigration([{ from: 'site_a', to: 'site_b', count: 12_345 }]);

		expect(moved).toBe(12_345);
		expect(sitePop(world, 'site_a')).toBe(100_000 - 12_345);
		expect(sitePop(world, 'site_b')).toBe(50_000 + 12_345);
		expect(totalPop(world as never)).toBe(before);
	});

	it('apportions uniformly by syndrome (largest remainder)', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as DrivenWorld;

		world.applyExternalMigration([{ from: 'site_a', to: 'site_b', count: 10_000 }]);

		// Source is 30% red / 20% blue, so the arrivals should be too, to
		// within the ±1 unit largest-remainder can shift.
		const redB = popOnSiteWithTrait(world as never, 'site_b', 'red');
		const blueB = popOnSiteWithTrait(world as never, 'site_b', 'blue');
		expect(Math.abs(redB - 3_000)).toBeLessThanOrEqual(1);
		expect(Math.abs(blueB - 2_000)).toBeLessThanOrEqual(1);
	});

	it('clamps to what the source holds and skips bad moves', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as DrivenWorld;

		const moved = world.applyExternalMigration([
			{ from: 'site_a', to: 'site_b', count: 999_999_999 }, // clamp to 100k
			{ from: 'site_a', to: 'site_a', count: 50 },          // self-move: skip
			{ from: 'nowhere', to: 'site_b', count: 50 },         // unknown site: skip
			{ from: 'site_b', to: 'site_a', count: 0 },           // zero: skip
		]);

		expect(moved).toBe(100_000);
		expect(sitePop(world, 'site_a')).toBe(0);
		expect(sitePop(world, 'site_b')).toBe(150_000);
	});

	it('is deterministic and seed-independent (no RNG draw)', { timeout: 60000 }, async () => {
		const runs: number[][] = [];
		for (const seed of [111, 999]) {
			const world = await bootScenario(scenario(), seed) as unknown as DrivenWorld;
			world.applyExternalMigration([
				{ from: 'site_a', to: 'site_b', count: 7_777 },
				{ from: 'site_b', to: 'site_a', count: 1_111 },
			]);
			runs.push([
				sitePop(world, 'site_a'),
				sitePop(world, 'site_b'),
				popOnSiteWithTrait(world as never, 'site_b', 'red'),
				popOnSiteWithTrait(world as never, 'site_b', 'blue'),
			]);
		}
		expect(runs[1]).toEqual(runs[0]);
	});
});
