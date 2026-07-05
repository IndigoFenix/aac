/**
 * End-to-end smoke test.
 *
 * The codebase has been refactored several times (Phase A correctness,
 * Phase B1 storage redesign) without ever being executed end-to-end.
 * This test boots the simulation against a minimal scenario and runs
 * a handful of days. Its purpose is not correctness verification — it's
 * to surface runtime bugs that type-checking and unit tests miss.
 *
 * Scenario:
 *   - 1 site, population 1000.
 *   - 1 trait "infected" with starting prob 0.05 and a transmit rule that
 *     spreads "infected" to other units via vector v1.
 *   - 1 vector "v1" with no seek constraints.
 *   - 1 phase "spread".
 *
 * Success criterion: 10 newDay() calls complete without throwing, and the
 * total population is conserved (no units lost).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../wireup';
import { System } from '../controller/System';
import { World } from '../controller/World';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function makeMinimalScenario(): Record<string, unknown> {
	// Child arrays in scenario JSON use the singular form
	// (`trait`/`vector`/`site`) — runtime property names are plural.
	return {
		name: 'Smoke',
		start_age: 0,
		use_date: false,
		phase: [
			{ key: 'spread', name: 'Spread' },
		],
		trait: [
			{
				key: 'infected',
				name: 'Infected',
				color: '255,0,0,1',
				prob: 0.05,
				transmit: [
					{
						vector: ['v1'],
						apply: ['infected'],
						value: 0.5,
						sd: 0,
						phase: 'spread',
					},
				],
			},
		],
		vector: [
			{ key: 'v1', name: 'V1' },
		],
		site: [
			{ key: 'site_a', name: 'Site A', pop: 1000 },
		],
	};
}

describe('smoke: end-to-end day loop', () => {
	it('runs 10 days without throwing', { timeout: 30000 }, async () => {
		const system = new System(null);
		system.rand.seed(12345);
		// renderIfNeeded sleeps 1ms whenever the 33ms render budget elapses.
		// In a headless test that adds latency for no benefit. Stub it out.
		(system as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => { };

		const world = new World(system as never, makeMinimalScenario());
		// Wire the system back to the world the way loadWorld would.
		(system as unknown as { world: World }).world = world;

		await world.start();

		const startingPop = world.sites.reduce((sum, s) => sum + (s as { pop: number }).pop, 0);
		expect(startingPop).toBeGreaterThan(0);

		for (let day = 0; day < 10; day++) {
			await world.newDay();
		}

		const endingPop = world.sites.reduce((sum, s) => {
			const site = s as { pops: { pop: number }[] };
			return sum + site.pops.reduce((acc, p) => acc + p.pop, 0);
		}, 0);

		expect(endingPop).toBe(startingPop);
	});
});
