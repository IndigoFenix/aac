/**
 * Feature tests: routes — the cross-site channel (grand-dream step 1).
 *
 * Covers: ranged sheds spreading to a connected site with one day of
 * travel per hop; locality without routes / without range; the
 * home-weight share model; multi-hop delay along a chain; migration
 * diffusion + exact conservation; migration_forbid; reproducibility and
 * route-declaration-order independence.
 *
 * (Site-declaration order is NOT asserted bit-exact: popIds are assigned
 * in creation order and key the engine's rounding draws, so reversing
 * sites legally perturbs ±1-unit rounding. Route order, by contrast,
 * must not matter — the cross-site queue aggregates by key and drains
 * sorted, and migration moves are keyed by route/site/syndrome.)
 */

import { describe, it, expect } from 'vitest';
import {
	bootScenario,
	runDays,
	totalPop,
	popOnSiteWithTrait,
	popWithTrait,
} from './_helpers';

interface ScenarioOpts {
	ranged?: number;
	strength?: number;
	migration?: number;
	migrationForbid?: string[];
	/** Add site_c and route bc, forming the chain a—b—c. */
	chain?: boolean;
	/** Reverse the declaration order of the routes only. */
	reverseRoutes?: boolean;
	popA?: number;
	popB?: number;
}

/**
 * Two (or three) sites. Infection is seeded on site_a only, via a
 * site-level start transmit (Site.transmit fires once at world start on
 * that site alone). site_a natives all carry the inert marker trait
 * `native_a` so migration can be observed independently of infection.
 */
function routedScenario(opts: ScenarioOpts = {}): Record<string, unknown> {
	const {
		ranged = 0.5, strength = 1, migration = 0,
		migrationForbid = [], chain = false, reverseRoutes = false,
		popA = 100_000, popB = 100_000,
	} = opts;

	const sites: Record<string, unknown>[] = [
		{
			key: 'site_a', name: 'A', pop: popA,
			startpop: [{ size: 1, apply: ['native_a'] }],
			transmit: [{ vector: ['v1'], apply: ['infected'], value: 20, sd: 0, phase: 'spread' }],
		},
		{ key: 'site_b', name: 'B', pop: popB },
	];
	if (chain) sites.push({ key: 'site_c', name: 'C', pop: 100_000 });

	const routes: Record<string, unknown>[] = [
		{ key: 'ab', sites: ['site_a', 'site_b'], strength, migration, migration_forbid: migrationForbid },
	];
	if (chain) routes.push({ key: 'bc', sites: ['site_b', 'site_c'], strength, migration });

	return {
		name: 'Routed',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [
			{ key: 'native_a', name: 'Native A', color: '0,255,0,1' },
			{
				key: 'infected', name: 'Infected', color: '255,0,0,1',
				transmit: [{
					vector: ['v1'], apply: ['infected'],
					value: 0.8, sd: 0, phase: 'spread', ranged,
				}],
			},
		],
		vector: [{ key: 'v1', name: 'V1' }],
		site: sites,
		route: reverseRoutes ? [...routes].reverse() : routes,
	};
}

describe('routes: ranged sheds cross with one-day delay', () => {
	it('spreads to the connected site; origin leads', { timeout: 60000 }, async () => {
		const world = await bootScenario(routedScenario({ ranged: 0.5 }));
		await runDays(world, 15);

		const aInfected = popOnSiteWithTrait(world, 'site_a', 'infected');
		const bInfected = popOnSiteWithTrait(world, 'site_b', 'infected');
		expect(aInfected).toBeGreaterThan(0);
		expect(bInfected).toBeGreaterThan(0);
		// site_a was seeded and exports lag a day, so A leads B.
		expect(aInfected).toBeGreaterThan(bInfected);
	});

	it('stays fully local when ranged = 0 even with a route', { timeout: 60000 }, async () => {
		const world = await bootScenario(routedScenario({ ranged: 0 }));
		await runDays(world, 15);

		expect(popOnSiteWithTrait(world, 'site_a', 'infected')).toBeGreaterThan(0);
		expect(popOnSiteWithTrait(world, 'site_b', 'infected')).toBe(0);
	});

	it('stays fully local when ranged > 0 but no route exists', { timeout: 60000 }, async () => {
		const scenario = routedScenario({ ranged: 0.5 });
		scenario.route = [];
		const world = await bootScenario(scenario);
		await runDays(world, 15);

		expect(popOnSiteWithTrait(world, 'site_a', 'infected')).toBeGreaterThan(0);
		expect(popOnSiteWithTrait(world, 'site_b', 'infected')).toBe(0);
	});

	it('weaker routes export less (home weight 1 vs strength)', { timeout: 60000 }, async () => {
		// Hold the source saturated so its own epidemic can't confound the
		// share comparison: site_a starts fully infected, so it exports a
		// stable strength-proportional amount every day. A stronger route
		// then delivers more to B. (With a growing source, high strength
		// suppresses the source's local growth and can invert the result —
		// that's a real dynamic, just not what this test isolates.)
		function saturatedSource(strength: number): Record<string, unknown> {
			return {
				name: 'SaturatedSource',
				start_age: 0,
				use_date: false,
				phase: [{ key: 'spread', name: 'Spread' }],
				trait: [{
					key: 'infected', name: 'Infected', color: '255,0,0,1',
					transmit: [{
						vector: ['v1'], apply: ['infected'],
						value: 0.5, sd: 0, phase: 'spread', ranged: 1,
					}],
				}],
				vector: [{ key: 'v1', name: 'V1' }],
				site: [
					{ key: 'site_a', name: 'A', pop: 100_000, startpop: [{ size: 1, apply: ['infected'] }] },
					{ key: 'site_b', name: 'B', pop: 100_000 },
				],
				route: [{ key: 'ab', sites: ['site_a', 'site_b'], strength }],
			};
		}
		const strong = await bootScenario(saturatedSource(4));
		const weak = await bootScenario(saturatedSource(0.25));
		await runDays(strong, 6);
		await runDays(weak, 6);

		const strongB = popOnSiteWithTrait(strong, 'site_b', 'infected');
		const weakB = popOnSiteWithTrait(weak, 'site_b', 'infected');
		expect(strongB).toBeGreaterThan(weakB);
	});

	it('takes extra days to reach the far end of a chain', { timeout: 90000 }, async () => {
		const world = await bootScenario(routedScenario({ ranged: 0.6, chain: true }));
		let firstB = -1;
		let firstC = -1;
		for (let day = 1; day <= 25; day++) {
			await runDays(world, 1);
			if (firstB === -1 && popOnSiteWithTrait(world, 'site_b', 'infected') > 0) firstB = day;
			if (firstC === -1 && popOnSiteWithTrait(world, 'site_c', 'infected') > 0) firstC = day;
			if (firstB !== -1 && firstC !== -1) break;
		}
		expect(firstB).toBeGreaterThan(-1);
		expect(firstC).toBeGreaterThan(firstB);
	});
});

describe('routes: migration', () => {
	it('diffuses toward equal sizes and conserves the total exactly', { timeout: 60000 }, async () => {
		const world = await bootScenario(
			routedScenario({ ranged: 0, migration: 0.05, popA: 150_000, popB: 50_000 }),
		);
		expect(totalPop(world)).toBe(200_000);

		await runDays(world, 40);

		expect(totalPop(world)).toBe(200_000);

		const sites = (world as unknown as { sites: { key: string; pops: { pop: number }[] }[] }).sites;
		const sizeOf = (k: string) =>
			sites.find(s => s.key === k)!.pops.reduce((a, p) => a + p.pop, 0);
		// d(A−B)/dt = −2r(A−B): 100k × 0.9^40 ≈ 1.5k remaining gap.
		expect(Math.abs(sizeOf('site_a') - sizeOf('site_b'))).toBeLessThan(10_000);
	});

	it('carries traits with the migrants (uniform by syndrome)', { timeout: 60000 }, async () => {
		const world = await bootScenario(routedScenario({ ranged: 0, migration: 0.05 }));
		await runDays(world, 15);

		// Infection can't travel by shed (ranged 0) but infected people move.
		expect(popOnSiteWithTrait(world, 'site_b', 'infected')).toBeGreaterThan(0);
	});

	it('migration_forbid pins carriers in place', { timeout: 60000 }, async () => {
		const world = await bootScenario(
			routedScenario({ ranged: 0, migration: 0.05, migrationForbid: ['infected'] }),
		);
		await runDays(world, 15);

		// No infected person migrates and infection has no other path out.
		expect(popOnSiteWithTrait(world, 'site_b', 'infected')).toBe(0);
		// The native_a marker migrates freely, proving migration ran.
		expect(popOnSiteWithTrait(world, 'site_b', 'native_a')).toBeGreaterThan(0);
	});
});

describe('routes: determinism', () => {
	it('same seed ⇒ identical run, twice', { timeout: 90000 }, async () => {
		const run1 = await bootScenario(routedScenario({ ranged: 0.5, migration: 0.02, chain: true }), 777);
		const run2 = await bootScenario(routedScenario({ ranged: 0.5, migration: 0.02, chain: true }), 777);
		await runDays(run1, 12);
		await runDays(run2, 12);

		for (const siteKey of ['site_a', 'site_b', 'site_c']) {
			expect(popOnSiteWithTrait(run2, siteKey, 'infected'))
				.toBe(popOnSiteWithTrait(run1, siteKey, 'infected'));
		}
		expect(totalPop(run2)).toBe(totalPop(run1));
	});

	it('route declaration order does not change the outcome', { timeout: 90000 }, async () => {
		const forward = await bootScenario(routedScenario({ ranged: 0.5, migration: 0.02, chain: true }), 777);
		const reversed = await bootScenario(routedScenario({ ranged: 0.5, migration: 0.02, chain: true, reverseRoutes: true }), 777);
		await runDays(forward, 12);
		await runDays(reversed, 12);

		for (const siteKey of ['site_a', 'site_b', 'site_c']) {
			expect(popOnSiteWithTrait(reversed, siteKey, 'infected'))
				.toBe(popOnSiteWithTrait(forward, siteKey, 'infected'));
		}
		expect(totalPop(reversed)).toBe(totalPop(forward));
		expect(popWithTrait(reversed, 'infected')).toBe(popWithTrait(forward, 'infected'));
	});
});
