/**
 * Feature tests: mid-run founding (world-content.md gate 5).
 *
 * addSite creates and fully initializes a Site at the day boundary
 * (mirroring World.start's per-site sequence); addRoute wires it into the
 * graph; the CONSERVING population path is an empty site colonized by
 * driven migration. The colony must be a full citizen: it receives
 * migrants (with their traits), receives ranged sheds along its new
 * route, counts in conservation, and the world still rests and skips.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World } from '../controller/World';

interface FoundingWorld extends World {
	applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number;
	isCompositionAtRest(): boolean;
	skipDays(n: number): number;
}

function scenario(): Record<string, unknown> {
	return {
		name: 'Founding',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{
			key: 'convinced', name: 'Convinced', color: '255,0,0,1',
			transmit: [{ vector: ['v1'], apply: ['convinced'], value: 1.5, sd: 0, phase: 'spread', ranged: 0.5 }],
		}],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [
			{
				key: 'cap', name: 'Capital', pop: 20_000,
				startpop: [{ size: 1, apply: ['convinced'] }, { size: 9, apply: [] }],
			},
			{ key: 'far', name: 'Farhold', pop: 10_000 },
		],
		route: [{ key: 'cf', sites: ['cap', 'far'], strength: 1, migration: 0 }],
	};
}

async function foundColony(world: FoundingWorld): Promise<void> {
	await world.addSite({ key: 'colony', name: 'Colony', pop: 0 });
	expect(world.addRoute({ key: 'fc', sites: ['far', 'colony'], strength: 1, migration: 0 })).toBeTruthy();
	world.applyExternalMigration([{ from: 'far', to: 'colony', count: 3_000 }]);
}

describe('founding: addSite + addRoute', () => {
	it('a colony joins mid-run: colonists, sheds, conservation', { timeout: 90000 }, async () => {
		const world = await bootScenario(scenario(), 55) as unknown as FoundingWorld;
		await runDays(world, 10);
		expect(totalPop(world)).toBe(30_000);

		await foundColony(world);
		expect(totalPop(world)).toBe(30_000); // colonists moved, not minted
		const colonyPop = () => (world.sites.find(s => s.key === 'colony')!.pops as Array<{ pop: number }>)
			.reduce((a, p) => a + p.pop, 0);
		expect(colonyPop()).toBe(3_000);

		await runDays(world, 20);
		// The idea reached the colony — carried by migrants and shed along
		// the founded route.
		expect(popOnSiteWithTrait(world, 'colony', 'convinced')).toBeGreaterThan(0);
		expect(totalPop(world)).toBe(30_000);
	});

	it('duplicate keys and unknown endpoints are rejected', { timeout: 60000 }, async () => {
		const world = await bootScenario(scenario(), 55) as unknown as FoundingWorld;
		await runDays(world, 2);
		expect(await world.addSite({ key: 'cap', name: 'Dup', pop: 0 })).toBeNull();
		expect(world.addRoute({ key: 'bad', sites: ['cap', 'nowhere'], strength: 1 })).toBeNull();
	});

	it('founding is deterministic, and the grown world still rests and skips', { timeout: 120000 }, async () => {
		const capture = async (): Promise<string> => {
			const world = await bootScenario(scenario(), 55) as unknown as FoundingWorld;
			await runDays(world, 10);
			await foundColony(world);
			let restDay = -1;
			for (let day = 1; day <= 400; day++) {
				await world.newDay();
				if (world.isCompositionAtRest()) { restDay = day; break; }
			}
			expect(restDay).toBeGreaterThan(0);
			expect(world.skipDays(5_000)).toBe(5_000);
			const parts: unknown[] = [restDay, totalPop(world)];
			for (const s of ['cap', 'far', 'colony']) parts.push(popOnSiteWithTrait(world, s, 'convinced'));
			return JSON.stringify(parts);
		};
		const a = await capture();
		expect(await capture()).toBe(a);
	});
});
