/**
 * Feature tests: composition rest detection + day-skip (grand-dream step 3).
 *
 * The contract: isCompositionAtRest() may only be true when the world sits
 * on a PROVEN fixed point — zero expected deltas, zero realized change, a
 * cross-site queue identical to yesterday's, no shed aimed at anyone it
 * could still change (latent sub-unit drift), no fractional rate-migration,
 * all events spent. From such a day, skipDays(n) must be bit-equivalent to
 * stepping n days (minus history rows), including behavior after a wake-up.
 */

import { describe, it, expect } from 'vitest';
import { bootScenario, runDays, totalPop, popOnSiteWithTrait } from './_helpers';
import type { World } from '../controller/World';

interface RestWorld extends World {
	isCompositionAtRest(): boolean;
	skipDays(n: number): number;
	applyExternalMigration(moves: Array<{ from: string; to: string; count: number }>): number;
}

/** Epidemic that fully saturates two routed sites, then genuinely rests:
 *  carriers keep shedding (locally and along the route), but once everyone
 *  is converted no shed can change anyone. */
function saturatingScenario(): Record<string, unknown> {
	return {
		name: 'Saturating',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [{
			key: 'convinced', name: 'Convinced', color: '255,0,0,1',
			transmit: [{ vector: ['v1'], apply: ['convinced'], value: 2, sd: 0, phase: 'spread', ranged: 0.5 }],
		}],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [
			{ key: 'site_a', name: 'A', pop: 5_000, startpop: [{ size: 1, apply: ['convinced'] }, { size: 9, apply: [] }] },
			{ key: 'site_b', name: 'B', pop: 3_000 },
			// Isolated susceptible reservoir for wake-up tests.
			{ key: 'site_c', name: 'C', pop: 2_000 },
		],
		route: [{ key: 'ab', sites: ['site_a', 'site_b'], strength: 1, migration: 0 }],
	};
}

async function stepToRest(world: RestWorld, cap: number): Promise<number> {
	for (let day = 1; day <= cap; day++) {
		await world.newDay();
		if (world.isCompositionAtRest()) return day;
	}
	return -1;
}

function compositionState(world: World): string {
	const sites = (world as unknown as {
		sites: Array<{ key: string; pops: Array<{ pop: number; syndrome: { key: string } }> }>;
	}).sites;
	const parts: string[] = [];
	for (const s of sites) {
		const rows = s.pops
			.map(p => `${p.syndrome.key}=${p.pop}`)
			.sort();
		parts.push(`${s.key}[${rows.join(',')}]`);
	}
	return parts.join('|');
}

describe('rest detection: reaching rest', () => {
	it('a saturating epidemic reaches exact rest once no one can change', { timeout: 90000 }, async () => {
		const world = await bootScenario(saturatingScenario()) as unknown as RestWorld;
		const restDay = await stepToRest(world, 400);

		expect(restDay).toBeGreaterThan(0);
		// Rest implies real saturation on the routed sites.
		expect(popOnSiteWithTrait(world, 'site_a', 'convinced')).toBe(5_000);
		expect(popOnSiteWithTrait(world, 'site_b', 'convinced')).toBe(3_000);
		// The isolated reservoir never converts.
		expect(popOnSiteWithTrait(world, 'site_c', 'convinced')).toBe(0);
	});

	it('latent sub-unit drift blocks rest while susceptibles remain', { timeout: 60000 }, async () => {
		// One carrier shedding a whisper (expected conversions ≪ 1/day):
		// most days realize zero conversions, but rest must NOT be declared
		// while anyone convertible remains — tomorrow's day-keyed rounding
		// could convert them.
		const world = await bootScenario({
			name: 'Whisper',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{
				key: 'convinced', name: 'Convinced', color: '255,0,0,1',
				transmit: [{ vector: ['v1'], apply: ['convinced'], value: 0.02, sd: 0, phase: 'spread' }],
			}],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'A', pop: 50, startpop: [{ size: 1, apply: ['convinced'] }, { size: 9, apply: [] }] }],
		}) as unknown as RestWorld;

		for (let day = 1; day <= 40; day++) {
			await world.newDay();
			const susceptibles = 50 - popOnSiteWithTrait(world, 'site_a', 'convinced');
			if (susceptibles > 0) {
				expect(world.isCompositionAtRest()).toBe(false);
			}
		}
	});
});

describe('rest detection: skip equals stepping', () => {
	it('skipDays(n) matches stepping n days from rest, and wake-up behavior is identical', { timeout: 120000 }, async () => {
		const stepped = await bootScenario(saturatingScenario(), 999) as unknown as RestWorld;
		const skipped = await bootScenario(saturatingScenario(), 999) as unknown as RestWorld;

		const restA = await stepToRest(stepped, 400);
		const restB = await stepToRest(skipped, 400);
		expect(restB).toBe(restA); // deterministic twins rest on the same day

		await runDays(stepped, 120);
		expect(skipped.skipDays(120)).toBe(120);

		expect(skipped.age).toBe(stepped.age);
		expect(compositionState(skipped)).toBe(compositionState(stepped));
		expect(skipped.isCompositionAtRest()).toBe(true);

		// Wake both identically: susceptibles from the isolated reservoir
		// migrate into the saturated site — the epidemic reignites. The
		// skipped world must track the stepped one bit-for-bit (all
		// stochastic draws are day-keyed, and ages agree).
		stepped.applyExternalMigration([{ from: 'site_c', to: 'site_a', count: 1_000 }]);
		skipped.applyExternalMigration([{ from: 'site_c', to: 'site_a', count: 1_000 }]);
		expect(skipped.isCompositionAtRest()).toBe(false); // driven moves dirty the observation

		await runDays(stepped, 15);
		await runDays(skipped, 15);

		expect(compositionState(skipped)).toBe(compositionState(stepped));
		expect(totalPop(skipped)).toBe(totalPop(stepped));
		// The reignited epidemic actually converted newcomers (the wake was real).
		expect(popOnSiteWithTrait(stepped, 'site_a', 'convinced')).toBeGreaterThan(5_000);
	});

	it('a million skipped days is O(1) and preserves rest', { timeout: 90000 }, async () => {
		const world = await bootScenario(saturatingScenario()) as unknown as RestWorld;
		expect(await stepToRest(world, 400)).toBeGreaterThan(0);

		const before = compositionState(world);
		const t0 = performance.now();
		expect(world.skipDays(1_000_000)).toBe(1_000_000);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(50); // no per-day work
		expect(compositionState(world)).toBe(before);
		expect(world.isCompositionAtRest()).toBe(true);
	});

	it('skipDays throws when not at rest', { timeout: 60000 }, async () => {
		const world = await bootScenario(saturatingScenario()) as unknown as RestWorld;
		await runDays(world, 2); // epidemic mid-flight
		expect(world.isCompositionAtRest()).toBe(false);
		expect(() => world.skipDays(10)).toThrow(/not at rest/);
	});
});

describe('rest detection: guards', () => {
	it('an unfired event blocks rest; a spent one does not', { timeout: 60000 }, async () => {
		const base = {
			name: 'Evented',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{ key: 'quiet', name: 'Quiet', color: '0,0,255,1' }],
			vector: [{ key: 'v1', name: 'V1' }],
			site: [{ key: 'site_a', name: 'A', pop: 1_000, startpop: [{ size: 1, apply: ['quiet'] }] }],
		};

		// Impossible condition: the event stays armed forever.
		const armed = await bootScenario({
			...base,
			event: [{
				key: 'never', times: 1, phase: 'spread', global: true,
				condition: [{ op: '==', exp: [{ type: 'number', value: 1 }], exp2: [{ type: 'number', value: 2 }] }],
				result: [],
			}],
		}) as unknown as RestWorld;
		await runDays(armed, 6);
		expect(armed.isCompositionAtRest()).toBe(false);

		// Trivial condition: fires on day 1, count hits 0, rest allowed.
		const spent = await bootScenario({
			...base,
			event: [{
				key: 'once', times: 1, phase: 'spread', global: true,
				condition: [{ op: '==', exp: [{ type: 'number', value: 1 }], exp2: [{ type: 'number', value: 1 }] }],
				result: [],
			}],
		}) as unknown as RestWorld;
		await runDays(spent, 6);
		expect(spent.isCompositionAtRest()).toBe(true);
	});

	it('fractional rate-migration blocks rest; exact swaps may rest', { timeout: 60000 }, async () => {
		const migScenario = (pop: number): Record<string, unknown> => ({
			name: 'Swap',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'spread', name: 'Spread' }],
			trait: [{ key: 'settled', name: 'Settled', color: '0,255,0,1' }],
			vector: [{ key: 'v1', name: 'V1' }],
			// Both sites identical, fully 'settled': migration swaps people
			// with no visible effect.
			site: [
				{ key: 'site_a', name: 'A', pop, startpop: [{ size: 1, apply: ['settled'] }] },
				{ key: 'site_b', name: 'B', pop, startpop: [{ size: 1, apply: ['settled'] }] },
			],
			route: [{ key: 'ab', sites: ['site_a', 'site_b'], strength: 0, migration: 0.1 }],
		});

		// pop 1000 × 0.1 = 100.0 — exact symmetric swap, a genuine fixed point.
		const exact = await bootScenario(migScenario(1_000)) as unknown as RestWorld;
		await runDays(exact, 6);
		expect(exact.isCompositionAtRest()).toBe(true);

		// pop 1005 × 0.1 = 100.5 — day-keyed rounding could realize
		// differently tomorrow; never a provable fixed point.
		const frac = await bootScenario(migScenario(1_005)) as unknown as RestWorld;
		await runDays(frac, 6);
		expect(frac.isCompositionAtRest()).toBe(false);
	});
});
