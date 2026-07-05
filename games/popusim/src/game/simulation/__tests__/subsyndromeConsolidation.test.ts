/**
 * SubSyndrome consolidation tests (Phase B3.2a).
 *
 * Verifies the set-only encoding: cures targeting traits the source
 * doesn't have are no-ops on the resulting key/trait_states. Distinct
 * SubSyndromes that differ only in explicit 0-tracking now consolidate
 * to a single entry.
 */

import { describe, it, expect } from 'vitest';
import { SubSyndrome } from '../SubSyndrome';
import type { Shed } from '../Shed';
import { buildTraitMask, MASK_WORDS, subSyndromeKey } from '../../../sim/gpu/traitMask';

interface MockWorld {
	subsyndromes_kv: Map<string, SubSyndrome>;
	subsyndromes_by_id: SubSyndrome[];
	traits_kv: Record<string, { index: number }>;
	traits: { key: string; index: number }[];
	getSubSyndrome(key: string): SubSyndrome | null;
	getSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndrome | null;
	materializeSubSyndrome(key: string, trait_keys: string[], trait_states: Record<string, number>): SubSyndrome;
	materializeSubSyndromeByMask(mask: Uint32Array, offset?: number): SubSyndrome;
	getSyndrome(keys: string[]): { key: string };
}

function makeWorld(traitKeys: string[] = ['A', 'B', 'C']): MockWorld {
	const subsyndromes_kv = new Map<string, SubSyndrome>();
	const subsyndromes_by_id: SubSyndrome[] = [];
	const traits_kv: Record<string, { index: number }> = {};
	const traits: { key: string; index: number }[] = [];
	for (const k of traitKeys) {
		const trait = { key: k, index: traits.length };
		traits.push(trait);
		traits_kv[k] = trait;
	}
	const world: MockWorld = {
		subsyndromes_kv,
		subsyndromes_by_id,
		traits_kv,
		traits,
		getSubSyndrome(key: string): SubSyndrome | null {
			return subsyndromes_kv.get(key) ?? null;
		},
		getSubSyndromeByMask(mask: Uint32Array, offset = 0): SubSyndrome | null {
			return subsyndromes_kv.get(subSyndromeKey(mask, offset)) ?? null;
		},
		materializeSubSyndromeByMask(mask: Uint32Array, offset = 0): SubSyndrome {
			const key = subSyndromeKey(mask, offset);
			const existing = subsyndromes_kv.get(key);
			if (existing) return existing;
			const sub = new SubSyndrome(world as never, key, mask, offset);
			sub.id = subsyndromes_by_id.length;
			subsyndromes_by_id.push(sub);
			subsyndromes_kv.set(key, sub);
			return sub;
		},
		materializeSubSyndrome(_key: string, trait_keys: string[], trait_states: Record<string, number>): SubSyndrome {
			const setKeys: string[] = [];
			for (const k of trait_keys) {
				if (trait_states[k] === 1) setKeys.push(k);
			}
			const mask = buildTraitMask(world as never, setKeys);
			return world.materializeSubSyndromeByMask(mask, 0);
		},
		getSyndrome(_keys: string[]): { key: string } {
			return { key: 'syn' };
		},
	};
	return world;
}

function makeShed(traits: string[], cures: string[]): { key: string } {
	return { key: traits.join(',') + ':' + cures.join(',') };
}

function makeModifiedShed(world: MockWorld, trait_keys: string[], cure_keys: string[]) {
	return {
		multiplier: 1,
		trait_keys,
		cure_keys,
		apply_mask: buildTraitMask(world as never, trait_keys),
		remove_mask: buildTraitMask(world as never, cure_keys),
	};
}

/** Compute the canonical mask key for a set of trait keys in the given world. */
function maskKeyFor(world: MockWorld, trait_keys: string[]): string {
	return subSyndromeKey(buildTraitMask(world as never, trait_keys), 0);
}

describe('SubSyndrome consolidation (B3.2a, set-only encoding)', () => {
	it('curing a trait the source does not have is unchanged', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const before = world.subsyndromes_kv.size;

		const result = sub.computeContactResult(
			makeShed([], ['B']) as Shed,
			makeModifiedShed(world, [], ['B'])
		);

		expect(result.unchanged).toBe(true);
		expect(result.key).toBe(maskKeyFor(world, ['A']));
		// No new SubSyndrome materialized for the no-op cure.
		expect(world.subsyndromes_kv.size).toBe(before);
	});

	it('result key contains only set traits (=1)', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const result = sub.computeContactResult(
			makeShed(['B'], ['A']) as Shed,
			makeModifiedShed(world, ['B'], ['A'])
		);
		// A removed (was 1), B added.
		expect(result.key).toBe(maskKeyFor(world, ['B']));
		// Result is genuinely new before materialization, so trait_keys/trait_states
		// are deferred. After materializing the target via mask, they're populated.
		const target = world.materializeSubSyndromeByMask(result.target_mask, 0);
		expect(target.trait_keys).toEqual(['B']);
		expect(target.trait_states).toEqual({ B: 1 });
	});

	it('cures only flip 1 -> 0; undefined stays undefined', () => {
		const world = makeWorld();
		// Source has A and B. Cure C (not present). C must not appear in result.
		const sub = world.materializeSubSyndrome('', ['A', 'B'], { A: 1, B: 1 });
		const result = sub.computeContactResult(
			makeShed([], ['C']) as Shed,
			makeModifiedShed(world, [], ['C'])
		);
		expect(result.unchanged).toBe(true);
		expect(result.trait_states).toEqual({ A: 1, B: 1 });
		expect(result.key).toBe(maskKeyFor(world, ['A', 'B']));
	});

	it('cure that removes a held trait drops it from key and trait_states', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A', 'B'], { A: 1, B: 1 });
		const result = sub.computeContactResult(
			makeShed([], ['B']) as Shed,
			makeModifiedShed(world, [], ['B'])
		);
		expect(result.unchanged).toBe(false);
		expect(result.key).toBe(maskKeyFor(world, ['A']));
		const target = world.materializeSubSyndromeByMask(result.target_mask, 0);
		expect(target.trait_keys).toEqual(['A']);
		expect(target.trait_states).toEqual({ A: 1 });
	});
});
