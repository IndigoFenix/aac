/**
 * EMIGRATION (settlement-emergence.md Gate D): exact people LEAVE the
 * composition — the abandoned settlement's crowd walking back into the
 * wild the world above models as bands. Removal is uniform by syndrome
 * (the applyVitals death mechanics), but the walkers land in
 * `emigrants_total`, never `deaths_total`: a collapse is people leaving,
 * not people dying, and the generational ledgers must agree.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World } from '../controller/World';

interface WalkWorld extends World {
	applyEmigration(siteKey: string, count: number, trait?: string): number;
	emigrants_total: number;
	deaths_total: number;
}

function scenario(): Record<string, unknown> {
	return {
		name: 'Emigration',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{ key: 'marked', name: 'Marked', color: '255,0,0,1', transmit: [] }],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [
			{
				key: 'town', name: 'Town', pop: 10_000,
				// Two syndromes so uniformity is observable: 30% marked.
				startpop: [{ size: 3, apply: ['marked'] }, { size: 7, apply: [] }],
			},
			{ key: 'other', name: 'Other', pop: 5_000 },
		],
		route: [{ key: 'to', sites: ['town', 'other'], strength: 1, migration: 0 }],
	};
}

describe('applyEmigration — walkers, never deaths', () => {
	it('removes exactly, uniformly by syndrome, into the emigrants ledger', { timeout: 90000 }, async () => {
		const world = await bootScenario(scenario(), 55) as unknown as WalkWorld;
		await runDays(world, 2);
		const pop0 = totalPop(world);
		const marked0 = popOnSiteWithTrait(world, 'town', 'marked');
		const deaths0 = world.deaths_total;

		const walked = world.applyEmigration('town', 4_000);
		expect(walked).toBe(4_000);
		expect(totalPop(world)).toBe(pop0 - 4_000);
		// Uniform by syndrome: the marked share of town walked in proportion.
		const marked1 = popOnSiteWithTrait(world, 'town', 'marked');
		expect(marked0 - marked1).toBe(Math.round(4_000 * 0.3));
		// The ledgers: walkers are emigrants, and NOT deaths.
		expect(world.emigrants_total).toBe(4_000);
		expect(world.deaths_total).toBe(deaths0);
	});

	it('clamps to what exists and refuses unknown sites', { timeout: 90000 }, async () => {
		const world = await bootScenario(scenario(), 55) as unknown as WalkWorld;
		await runDays(world, 2);
		const townPop = totalPop(world) - 5_000;
		expect(world.applyEmigration('nowhere', 100)).toBe(0);
		expect(world.applyEmigration('town', 999_999)).toBe(townPop); // everyone walks
		expect(world.applyEmigration('town', 10)).toBe(0); // nobody left
		expect(world.emigrants_total).toBe(townPop);
	});
});
