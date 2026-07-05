/**
 * Feature tests: membership traits + breakaway (grand-dream step 5, §7).
 *
 * A civilization is a membership trait. Secession fires at the day
 * boundary when the dissenting bloc is big enough (threshold) AND
 * territorially coherent (cross-site dissimilarity) — a statistically
 * real faction, not diffuse grumbling. The flip is exact and wholesale
 * (the C2b uniformity condition), deterministic, and composes with rest
 * detection: a seceded world still reaches rest and skips.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World } from '../controller/World';

interface BreakawayWorld extends World {
	measureFaction(dissent: string, from: string): { fraction: number; coherence: number; factionPop: number; fromPop: number };
	applyTraitFlip(where: string[], apply: string[], remove: string[]): number;
	isCompositionAtRest(): boolean;
	skipDays(n: number): number;
}

const SITES = ['cap', 'mid', 'east', 'far'] as const;

/** Four towns of civ X. Dissent (sep_idea) spreads locally only; `seedIn`
 *  controls which towns seed it — one town = a coherent regional faction,
 *  all towns = diffuse grumbling at the same overall size. */
function civScenario(seedIn: ReadonlyArray<string>): Record<string, unknown> {
	return {
		name: 'Civ',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [
			{ key: 'member_x', name: 'Civ X', color: '90,120,220,1' },
			{ key: 'member_y', name: 'Civ Y', color: '190,90,220,1' },
			{
				key: 'sep_idea', name: 'Separatism', color: '230,60,60,1',
				transmit: [{ vector: ['word'], apply: ['sep_idea'], value: 1.5, sd: 0, phase: 'spread', ranged: 0 }],
			},
		],
		vector: [{ key: 'word', name: 'Word of mouth' }],
		site: SITES.map(key => ({
			key, name: key, pop: 10_000,
			startpop: [{ size: 1, apply: ['member_x'] }],
			...(seedIn.includes(key)
				? { transmit: [{ vector: ['word'], apply: ['sep_idea'], value: 20, sd: 0, phase: 'spread' }] }
				: {}),
		})),
		breakaway: [{
			key: 'secession', dissent: 'sep_idea', from: 'member_x', to: 'member_y',
			threshold: 0.15, coherence: 0.5,
		}],
	};
}

describe('breakaway: secession', () => {
	it('a coherent regional faction secedes deterministically', { timeout: 90000 }, async () => {
		const runSummary = async (): Promise<string> => {
			const world = await bootScenario(civScenario(['far']), 777) as unknown as BreakawayWorld;
			await runDays(world, 60);
			expect(world.breakaways_fired.length).toBe(1);
			const parts: unknown[] = [world.breakaways_fired[0].day, world.breakaways_fired[0].moved];
			for (const s of SITES) {
				parts.push(popOnSiteWithTrait(world, s, 'member_x'), popOnSiteWithTrait(world, s, 'member_y'));
			}
			parts.push(totalPop(world));
			return JSON.stringify(parts);
		};

		const a = await runSummary();
		expect(await runSummary()).toBe(a); // same seed ⇒ identical secession

		// Shape of the result: Y exists only where the dissent lived.
		const world = await bootScenario(civScenario(['far']), 777) as unknown as BreakawayWorld;
		await runDays(world, 60);
		expect(popOnSiteWithTrait(world, 'far', 'member_y')).toBeGreaterThan(0);
		for (const s of ['cap', 'mid', 'east']) {
			expect(popOnSiteWithTrait(world, s, 'member_y')).toBe(0);
		}
		// Every Y kept the idea that birthed it, and no one holds dual cards.
		const yPop = popOnSiteWithTrait(world, 'far', 'member_y');
		expect(popOnSiteWithTrait(world, 'far', 'sep_idea')).toBeGreaterThanOrEqual(yPop);
		expect(totalPop(world)).toBe(40_000);
	});

	it('the detector sees the faction before the event fires', { timeout: 90000 }, async () => {
		const world = await bootScenario(civScenario(['far']), 777) as unknown as BreakawayWorld;

		let coherentBeforeFire = false;
		for (let day = 1; day <= 60; day++) {
			await world.newDay();
			if (world.breakaways_fired.length > 0) break;
			const m = world.measureFaction('sep_idea', 'member_x');
			if (m.factionPop > 0 && m.coherence >= 0.5 && m.fraction < 0.15) coherentBeforeFire = true;
		}
		expect(world.breakaways_fired.length).toBe(1);
		// The faction was already statistically real (coherent) while still
		// below the size threshold — detection precedes the event.
		expect(coherentBeforeFire).toBe(true);
	});

	it('diffuse dissent of the same size never secedes', { timeout: 90000 }, async () => {
		// Seed the idea EVERYWHERE: the bloc grows far past the size
		// threshold but is spread uniformly — coherence ≈ 0, no faction.
		const world = await bootScenario(civScenario([...SITES]), 777) as unknown as BreakawayWorld;
		await runDays(world, 60);

		const m = world.measureFaction('sep_idea', 'member_x');
		expect(m.fraction).toBeGreaterThan(0.15);
		expect(m.coherence).toBeLessThan(0.2);
		expect(world.breakaways_fired.length).toBe(0);
	});

	it('a seceded world still reaches rest and skips exactly', { timeout: 90000 }, async () => {
		const world = await bootScenario(civScenario(['far']), 777) as unknown as BreakawayWorld;
		let restDay = -1;
		for (let day = 1; day <= 200; day++) {
			await world.newDay();
			if (world.isCompositionAtRest()) { restDay = day; break; }
		}
		expect(world.breakaways_fired.length).toBe(1);
		expect(restDay).toBeGreaterThan(world.breakaways_fired[0].day);
		expect(world.skipDays(10_000)).toBe(10_000);
		expect(totalPop(world)).toBe(40_000);
	});
});

describe('breakaway: applyTraitFlip', () => {
	it('rewrites syndromes exactly and conserves population', { timeout: 60000 }, async () => {
		const world = await bootScenario(civScenario(['far']), 777) as unknown as BreakawayWorld;
		await runDays(world, 5); // some of far carries sep_idea∧member_x

		const before = popOnSiteWithTrait(world, 'far', 'sep_idea');
		expect(before).toBeGreaterThan(0);

		const moved = world.applyTraitFlip(['sep_idea', 'member_x'], ['member_y'], ['member_x']);

		expect(moved).toBe(before);
		expect(popOnSiteWithTrait(world, 'far', 'member_y')).toBe(before);
		// Flipped people lost X, kept the idea.
		expect(popOnSiteWithTrait(world, 'far', 'member_x')).toBe(10_000 - before);
		expect(totalPop(world)).toBe(40_000);
		// External mutation dirties the rest observation.
		expect(world.isCompositionAtRest()).toBe(false);
	});
});
