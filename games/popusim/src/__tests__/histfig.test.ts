/**
 * Feature tests: histfigs (grand-dream step 6, §6).
 *
 * Individuals are DERIVED, not stored: villager k of a site is a
 * deterministic function of (world seed, site, index) — a syndrome drawn
 * from the site's distribution plus scalar traits bridged from local
 * prevalences (carriers ≥ 0.5, non-carriers < 0.5, both pulled toward the
 * prevalence). Pinning moves one person OUT of the aggregate accounting
 * (Σ pops + histfigs = const); releasing bins scalars back to a binary
 * syndrome; influence rides the ordinary shed pipeline, scaled by a
 * scalar.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World, Histfig, HistfigSample } from '../controller/World';

interface HistfigWorld extends World {
	sampleIndividual(siteKey: string, index: number): HistfigSample | null;
	pinHistfig(siteKey: string, index: number, role?: string): Histfig | null;
	releaseHistfig(id: number): boolean;
	histfigShed(id: number, traitKey: string, amount: number, scaleBy?: string): number;
	isCompositionAtRest(): boolean;
}

/** A devout village (80/20) and a plain town. `devout` has no transmit —
 *  only histfig sheds can spread it. */
function scenario(): Record<string, unknown> {
	return {
		name: 'Histfig',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{ key: 'devout', name: 'Devout', color: '200,170,60,1' }],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [
			{
				key: 'village', name: 'Village', pop: 10_000,
				startpop: [{ size: 4, apply: ['devout'] }, { size: 1, apply: [] }],
			},
			{ key: 'town', name: 'Town', pop: 5_000 },
		],
	};
}

describe('histfigs: deterministic sampling + the scalar bridge', () => {
	it('the same villager exists every time, with no storage', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as HistfigWorld;

		const first = world.sampleIndividual('village', 7)!;
		const again = world.sampleIndividual('village', 7)!;
		expect(again).toEqual(first);
		expect(first.name.length).toBeGreaterThan(2);
	});

	it('scalars bridge the local prevalence with individual variance', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as HistfigWorld;

		let carriers = 0;
		const carrierScalars = new Set<number>();
		for (let i = 0; i < 200; i++) {
			const v = world.sampleIndividual('village', i)!;
			const s = v.scalars.devout;
			if (v.traitKeys.includes('devout')) {
				carriers++;
				expect(s).toBeGreaterThanOrEqual(0.5); // fervor, not lukewarm
				carrierScalars.add(s);
			} else {
				expect(s).toBeLessThan(0.5);
			}
		}
		// The sample tracks the village's 80% prevalence...
		expect(carriers / 200).toBeGreaterThan(0.7);
		expect(carriers / 200).toBeLessThan(0.9);
		// ...and individuals genuinely vary around it.
		expect(carrierScalars.size).toBeGreaterThan(50);
	});
});

describe('histfigs: pinning and release', () => {
	it('pinning subtracts from the crowd; release re-bins to the origin syndrome', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as HistfigWorld;
		const startTotal = totalPop(world);
		const devoutBefore = popOnSiteWithTrait(world, 'village', 'devout');

		const pins = [1, 2, 3].map(i => world.pinHistfig('village', i, 'elder')!);
		expect(pins.every(Boolean)).toBe(true);

		// One person each left the aggregate accounting.
		expect(totalPop(world)).toBe(startTotal - 3);
		expect(world.histfigs.length).toBe(3);

		// Untouched scalars bin straight back to where they came from.
		for (const hf of pins) expect(world.releaseHistfig(hf.id)).toBe(true);
		expect(totalPop(world)).toBe(startTotal);
		expect(world.histfigs.length).toBe(0);
		expect(popOnSiteWithTrait(world, 'village', 'devout')).toBe(devoutBefore);
	});
});

describe('histfigs: influence via the shed pipeline', () => {
	it('a devout preacher converts the village; charisma scales the shed', { timeout: 90000 }, async () => {
		// Find a devout villager index (deterministic, same in both worlds).
		const probe = await bootScenario(scenario()) as unknown as HistfigWorld;
		let devoutIdx = -1;
		for (let i = 0; i < 50; i++) {
			if (probe.sampleIndividual('village', i)!.traitKeys.includes('devout')) { devoutIdx = i; break; }
		}
		expect(devoutIdx).toBeGreaterThanOrEqual(0);

		const preacherWorld = await bootScenario(scenario()) as unknown as HistfigWorld;
		const quietWorld = await bootScenario(scenario()) as unknown as HistfigWorld;

		const preacher = preacherWorld.pinHistfig('village', devoutIdx, 'preacher')!;
		quietWorld.pinHistfig('village', devoutIdx, 'preacher');

		// Shed scaled by the preacher's own devotion scalar ∈ [0.5, 1).
		const deposited = preacherWorld.histfigShed(preacher.id, 'devout', 800, 'devout');
		expect(deposited).toBeGreaterThanOrEqual(400);
		expect(deposited).toBeLessThan(800);

		const before = popOnSiteWithTrait(preacherWorld, 'village', 'devout');
		await runDays(preacherWorld, 1);
		await runDays(quietWorld, 1);

		// The sermon converted people; the quiet twin drifted nowhere.
		expect(popOnSiteWithTrait(preacherWorld, 'village', 'devout')).toBeGreaterThan(before);
		expect(popOnSiteWithTrait(quietWorld, 'village', 'devout')).toBe(before);
	});

	it('histfigs are rest-compatible: inert while idle, waking on a shed', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario()) as unknown as HistfigWorld;
		const hf = world.pinHistfig('village', 0, 'hermit')!;

		// devout has no transmit: with a pinned histfig the world still
		// reaches exact rest within a few days.
		await runDays(world, 4);
		expect(world.isCompositionAtRest()).toBe(true);

		// Influence is an external input: it dirties the observation.
		world.histfigShed(hf.id, 'devout', 100);
		expect(world.isCompositionAtRest()).toBe(false);
	});
});
