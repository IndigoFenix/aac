/**
 * Stress test against the COVID-19 fixture scenario.
 *
 * 47 traits, 28 vectors, 17 actions, 36 resources, ~26 events, 11 phases,
 * 1 site at 10M population. Exercises modifier composition, seek-weighted
 * shed allocation, syndrome combinatorial growth, event-driven transmits,
 * resource production/consumption, and conditional events at scale.
 *
 * Asserts the simulation runs N days without throwing, tracks population
 * conservation, and reports per-day timing as the perf baseline.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../wireup';
import { System } from '../controller/System';
import { World } from '../controller/World';
import covidScenario from '../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

describe('covid scenario', () => {
	it('runs end-to-end without throwing', { timeout: 120000 }, async () => {
		const system = new System(null);
		system.rand.seed(12345);
		(system as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => { };

		const scenarioCopy = JSON.parse(JSON.stringify(covidScenario));
		const world = new World(system as never, scenarioCopy);
		(system as unknown as { world: World }).world = world;

		const subById = (world as unknown as { subsyndromes_by_id: { key: string }[] }).subsyndromes_by_id;
		const popsById = (world as unknown as { populations_by_id: unknown[] }).populations_by_id;

		const t0 = performance.now();
		await world.start();
		const startMs = performance.now() - t0;

		const DAYS = 365;
		const checkpoints = new Set([1, 10, 30, 90, 180, 365]);
		const tStep = performance.now();
		for (let i = 0; i < DAYS; i++) {
			await world.newDay();
			if (checkpoints.has(i + 1)) {
				const elapsed = performance.now() - tStep;
				console.log(`[covid] day ${(i + 1).toString().padStart(3)}: ` +
					`${subById.length.toString().padStart(4)} subsyndromes, ` +
					`${popsById.length.toString().padStart(4)} populations, ` +
					`${elapsed.toFixed(0).padStart(5)} ms cumulative ` +
					`(${(elapsed / (i + 1)).toFixed(2)} ms/day avg)`);
			}
		}
		const stepMs = performance.now() - tStep;

		const sites = (world as unknown as { sites: { pop: number; pops: { pop: number }[] }[] }).sites;
		const totalPop = sites.reduce((a, s) => a + s.pops.reduce((b, p) => b + p.pop, 0), 0);

		console.log(`[covid] start: ${startMs.toFixed(0)} ms`);
		console.log(`[covid] ${DAYS} days: ${stepMs.toFixed(0)} ms total (${(stepMs / DAYS).toFixed(2)} ms/day avg)`);
		console.log(`[covid] final subsyndromes: ${subById.length}, final populations: ${popsById.length}`);
		console.log(`[covid] population conserved: ${totalPop.toFixed(0)} (target 10000000)`);

		expect(totalPop).toBe(10_000_000);
	});
});
