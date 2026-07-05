/**
 * Feature tests: vital dynamics — births and deaths (the direct model).
 *
 * Replaces the legacy "nonexistent pool + living trait" scheme: births
 * add units apportioned over the site's populations (largest remainder,
 * RNG-free), each landing in the HEREDITARY PROJECTION of the parents'
 * syndrome (hereditary traits pass, acquired states don't — a generation
 * of births dilutes untransmitted ideas); deaths remove uniformly by
 * syndrome (the C2b condition). The ledger keeps the invariant:
 * Σ pops = start + births − deaths.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World } from '../controller/World';

interface VitalWorld extends World {
	applyVitals(siteKey: string, births: number, deaths: number): { born: number; died: number };
	isCompositionAtRest(): boolean;
}

/** One town: everyone is devout (hereditary culture); 40% are ALSO
 *  convinced (an acquired opinion, no transmit — only vitals move it). */
function scenario(): Record<string, unknown> {
	return {
		name: 'Vitals',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [
			{ key: 'devout', name: 'Devout', color: '200,170,60,1', hereditary: true },
			{ key: 'convinced', name: 'Convinced', color: '230,60,60,1' },
		],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [{
			key: 'town', name: 'Town', pop: 10_000,
			startpop: [{ size: 2, apply: ['devout', 'convinced'] }, { size: 3, apply: ['devout'] }],
		}],
	};
}

describe('vitals: births inherit, deaths are uniform', () => {
	it('newborns carry hereditary traits only; the ledger balances', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as VitalWorld;
		expect(popOnSiteWithTrait(world, 'town', 'convinced')).toBe(4_000);

		const { born, died } = world.applyVitals('town', 1_000, 0);
		expect(born).toBe(1_000);
		expect(died).toBe(0);
		expect(totalPop(world)).toBe(11_000);
		expect(world.births_total).toBe(1_000);

		// Every newborn is devout (hereditary), NONE are convinced (acquired):
		// a birth cohort dilutes the opinion without touching the culture.
		expect(popOnSiteWithTrait(world, 'town', 'devout')).toBe(11_000);
		expect(popOnSiteWithTrait(world, 'town', 'convinced')).toBe(4_000);
	});

	it('deaths remove uniformly by syndrome and clamp to the living', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as VitalWorld;

		const { died } = world.applyVitals('town', 0, 1_000);
		expect(died).toBe(1_000);
		expect(totalPop(world)).toBe(9_000);
		// Uniform: the 40% convinced share is preserved (±1 for remainders).
		expect(Math.abs(popOnSiteWithTrait(world, 'town', 'convinced') - 3_600)).toBeLessThanOrEqual(1);

		// A plague beyond the population clamps at extinction, no negatives.
		const wipe = world.applyVitals('town', 0, 1_000_000);
		expect(wipe.died).toBe(9_000);
		expect(totalPop(world)).toBe(0);
	});

	it('vitals are deterministic and mark the composition dirty', { timeout: 60000 }, async () => {
		const run = async (): Promise<string> => {
			const world = await bootScenario(scenario(), 99) as unknown as VitalWorld;
			await runDays(world, 3);
			world.applyVitals('town', 137, 61);
			await runDays(world, 3);
			return JSON.stringify([
				totalPop(world),
				popOnSiteWithTrait(world, 'town', 'devout'),
				popOnSiteWithTrait(world, 'town', 'convinced'),
				world.births_total, world.deaths_total,
			]);
		};
		expect(await run()).toBe(await run());

		const world = await bootScenario(scenario(), 99) as unknown as VitalWorld;
		await runDays(world, 3);
		expect(world.isCompositionAtRest()).toBe(true); // no transmits: quiet
		world.applyVitals('town', 10, 10);
		expect(world.isCompositionAtRest()).toBe(false); // external mutation
	});
});
