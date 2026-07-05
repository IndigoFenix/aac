/**
 * Shared test helpers for feature tests.
 *
 * Each helper is intentionally narrow — boot a scenario, advance days,
 * read totals back out by trait / resource. Tests should remain readable
 * without consulting these helpers' source.
 */

import '../wireup';
import { System } from '../controller/System';
import { World } from '../controller/World';

export async function bootScenario(scenario: Record<string, unknown>, seed = 12345): Promise<World> {
	if (typeof document !== 'undefined' && !document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
	const system = new System(null);
	system.rand.seed(seed);
	// Headless tests don't need yielding — return void so the conditional-await
	// pattern in Population skips the microtask completely.
	(system as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => { /* no yield */ };
	const world = new World(system as never, JSON.parse(JSON.stringify(scenario)));
	(system as unknown as { world: World }).world = world;
	await world.start();
	return world;
}

export async function runDays(world: World, n: number): Promise<void> {
	for (let i = 0; i < n; i++) await world.newDay();
}

interface SiteLike {
	key: string;
	pop: number;
	pops: { pop: number; syndrome: { trait_keys: string[] } }[];
	local_stockpiles_kv: Record<string, { value: number }>;
}

function sites(world: World): SiteLike[] {
	return (world as unknown as { sites: SiteLike[] }).sites;
}

export function totalPop(world: World): number {
	return sites(world).reduce(
		(sum, s) => sum + s.pops.reduce((a, p) => a + p.pop, 0),
		0,
	);
}

export function popWithTrait(world: World, traitKey: string): number {
	let sum = 0;
	for (const site of sites(world)) {
		for (const pop of site.pops) {
			if (pop.syndrome.trait_keys.indexOf(traitKey) !== -1) sum += pop.pop;
		}
	}
	return sum;
}

export function popWithoutTrait(world: World, traitKey: string): number {
	return totalPop(world) - popWithTrait(world, traitKey);
}

/** Sum the populations whose syndrome trait_keys exactly match `traits` (sorted compare). */
export function popExactTraits(world: World, traits: string[]): number {
	const wanted = traits.slice().sort().join(',');
	let sum = 0;
	for (const site of sites(world)) {
		for (const pop of site.pops) {
			const got = pop.syndrome.trait_keys.slice().sort().join(',');
			if (got === wanted) sum += pop.pop;
		}
	}
	return sum;
}

/** Sum populations on a specific site that have ALL of the given trait keys. */
export function popOnSiteWithAllTraits(world: World, siteKey: string, traits: string[]): number {
	const site = sites(world).find(s => s.key === siteKey);
	if (!site) return 0;
	let sum = 0;
	for (const pop of site.pops) {
		if (traits.every(t => pop.syndrome.trait_keys.indexOf(t) !== -1)) sum += pop.pop;
	}
	return sum;
}

export function popOnSiteWithTrait(world: World, siteKey: string, traitKey: string): number {
	return popOnSiteWithAllTraits(world, siteKey, [traitKey]);
}

export function globalResource(world: World, resourceKey: string): number {
	const sp = (world as unknown as { global_stockpiles_kv: Record<string, { value: number }> })
		.global_stockpiles_kv[resourceKey];
	return sp?.value ?? 0;
}

export function siteResource(world: World, siteKey: string, resourceKey: string): number {
	const site = sites(world).find(s => s.key === siteKey);
	if (!site) return 0;
	return site.local_stockpiles_kv[resourceKey]?.value ?? 0;
}
