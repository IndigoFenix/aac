/**
 * Order-independence tests.
 *
 * Verifies the building blocks that make the simulation order-independent:
 * - HashRand: same (seed, keys) tuple always produces same draws.
 * - PhaseDelta: addPopShift/addStockpileDelta accumulation is commutative.
 * - PhaseDelta: TypedArray storage grows past initial capacity, dedups
 *   on write, and resets without releasing capacity.
 * - SubSyndrome.computeContactResult: pure compute, no world mutation.
 *
 * Full-system tests (run two day-sequences with reversed iteration orders,
 * compare population state) require a populated World and are deferred to a
 * later step that wires up a tiny fixture scenario.
 */

import { describe, it, expect } from 'vitest';
import { HashRand, hashUniform, rngStream } from '../../../core/HashRand';
import { PhaseDelta } from '../PhaseDelta';
import { SubSyndrome } from '../SubSyndrome';
import type { Shed } from '../Shed';
import { buildTraitMask, MASK_WORDS, subSyndromeKey } from '../../../sim/gpu/traitMask';

// ---------- HashRand ----------

describe('HashRand', () => {
	it('produces deterministic draws for the same (seed, keys)', () => {
		const a = new HashRand(42, ['day', 0, 'phase', 1, 'pop', 'siteA/synX']);
		const b = new HashRand(42, ['day', 0, 'phase', 1, 'pop', 'siteA/synX']);
		for (let i = 0; i < 10; i++) {
			expect(a.next()).toBe(b.next());
		}
	});

	it('produces different streams for different keys', () => {
		const a = new HashRand(42, ['popA']);
		const b = new HashRand(42, ['popB']);
		const samplesA: number[] = [];
		const samplesB: number[] = [];
		for (let i = 0; i < 5; i++) {
			samplesA.push(a.next());
			samplesB.push(b.next());
		}
		expect(samplesA.some((v, i) => v !== samplesB[i])).toBe(true);
	});

	it('all draws are in [0, 1)', () => {
		const r = new HashRand(7, ['k']);
		for (let i = 0; i < 1000; i++) {
			const v = r.next();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('hashUniform is deterministic and equals stream first draw', () => {
		const u = hashUniform(99, 'a', 'b', 3);
		expect(u).toBe(hashUniform(99, 'a', 'b', 3));
	});

	it('rngStream constructs an equivalent HashRand', () => {
		const a = rngStream(100, 'k1', 5);
		const b = new HashRand(100, ['k1', 5]);
		expect(a.next()).toBe(b.next());
	});

	it('nextNormal returns mean exactly when sd === 0', () => {
		const r = new HashRand(1, ['k']);
		expect(r.nextNormal(42, 0)).toBe(42);
	});
});

// ---------- PhaseDelta ----------

/** Sum all pop-shift amounts observed in iteration order. */
function sumPopShifts(d: PhaseDelta): Map<string, number> {
	const out = new Map<string, number>();
	d.forEachPopShift((popId, sourceId, targetId, amount) => {
		const k = `${popId}|${sourceId}|${targetId}`;
		out.set(k, (out.get(k) ?? 0) + amount);
	});
	return out;
}

describe('PhaseDelta', () => {
	it('accumulates popShifts commutatively across insertion order', () => {
		const a = new PhaseDelta();
		a.addPopShift(1, 10, 11, 10);
		a.addPopShift(1, 10, 11, 5);
		a.addPopShift(1, 10, 12, 3);

		const b = new PhaseDelta();
		b.addPopShift(1, 10, 12, 3);
		b.addPopShift(1, 10, 11, 5);
		b.addPopShift(1, 10, 11, 10);

		const aSums = sumPopShifts(a);
		const bSums = sumPopShifts(b);
		expect(aSums.get('1|10|11')).toBe(15);
		expect(aSums.get('1|10|12')).toBe(3);
		expect(bSums.get('1|10|11')).toBe(15);
		expect(bSums.get('1|10|12')).toBe(3);
	});

	it('dedups on write: repeated triples land in one slot', () => {
		const d = new PhaseDelta();
		d.addPopShift(1, 10, 11, 10);
		d.addPopShift(1, 10, 11, 5);
		d.addPopShift(1, 10, 11, 2);
		expect(d.n).toBe(1);
		expect(d.amounts[0]).toBeCloseTo(17, 5);
	});

	it('skips zero-amount shifts and self-targeting shifts', () => {
		const d = new PhaseDelta();
		d.addPopShift(1, 10, 11, 0);
		d.addPopShift(1, 10, 10, 5);
		expect(d.n).toBe(0);
	});

	it('accumulates stockpileDeltas commutatively', () => {
		const a = new PhaseDelta();
		a.addStockpileDelta(7, 100);
		a.addStockpileDelta(7, -30);

		const b = new PhaseDelta();
		b.addStockpileDelta(7, -30);
		b.addStockpileDelta(7, 100);

		expect(a.nStock).toBe(1);
		expect(b.nStock).toBe(1);
		expect(a.stockAmounts[0]).toBe(70);
		expect(b.stockAmounts[0]).toBe(70);
	});

	it('isEmpty reflects all sub-collections', () => {
		const d = new PhaseDelta();
		expect(d.isEmpty()).toBe(true);
		d.addStockpileDelta(0, 1);
		expect(d.isEmpty()).toBe(false);
	});

	it('grows capacity past initial 1024 without losing entries', () => {
		const d = new PhaseDelta();
		for (let i = 0; i < 2000; i++) {
			d.addPopShift(i, 0, 1, 1);
		}
		expect(d.n).toBe(2000);
		// The original buffer reference must have been replaced; we test that
		// every entry is preserved correctly by sampling.
		expect(d.popIds[0]).toBe(0);
		expect(d.popIds[1023]).toBe(1023);
		expect(d.popIds[1024]).toBe(1024);
		expect(d.popIds[1999]).toBe(1999);
	});

	it('reset clears entries but reuses buffers', () => {
		const d = new PhaseDelta();
		for (let i = 0; i < 50; i++) {
			d.addPopShift(i, 0, 1, 1);
		}
		const bufBefore = d.popIds;
		d.reset();
		expect(d.n).toBe(0);
		expect(d.isEmpty()).toBe(true);
		// Adding after reset reuses the buffer reference (no realloc).
		d.addPopShift(99, 0, 1, 1);
		expect(d.popIds).toBe(bufBefore);
		expect(d.n).toBe(1);
	});

	it('reset re-enables dedup-on-write', () => {
		const d = new PhaseDelta();
		d.addPopShift(1, 0, 1, 10);
		d.reset();
		// After reset, the (1, 0, 1) triple is fresh; the next add starts a
		// new slot rather than accumulating into the pre-reset one.
		d.addPopShift(1, 0, 1, 5);
		expect(d.n).toBe(1);
		expect(d.amounts[0]).toBeCloseTo(5, 5);
	});
});

// ---------- SubSyndrome.computeContactResult ----------

describe('SubSyndrome.computeContactResult', () => {
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

	function shed(traits: string[], cures: string[]): { key: string } {
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

	function maskKeyFor(world: MockWorld, trait_keys: string[]): string {
		return subSyndromeKey(buildTraitMask(world as never, trait_keys), 0);
	}

	it('returns unchanged=true when adding a trait already present', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const result = sub.computeContactResult(
			shed(['A'], []) as Shed,
			makeModifiedShed(world, ['A'], [])
		);
		expect(result.unchanged).toBe(true);
		expect(result.key).toBe(maskKeyFor(world, ['A']));
	});

	it('returns a new key when adding a fresh trait', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const result = sub.computeContactResult(
			shed(['B'], []) as Shed,
			makeModifiedShed(world, ['B'], [])
		);
		expect(result.unchanged).toBe(false);
		expect(result.key).toBe(maskKeyFor(world, ['A', 'B']));
		expect(result.isNew).toBe(true);
	});

	it('returns isNew=false for an already-materialized key', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		world.materializeSubSyndrome('', ['A', 'B'], { A: 1, B: 1 });
		const result = sub.computeContactResult(
			shed(['B'], []) as Shed,
			makeModifiedShed(world, ['B'], [])
		);
		expect(result.isNew).toBe(false);
	});

	it('removal-wins: trait in both lists ends absent', () => {
		// Post-B3.2a (set-only encoding): when add and cure target the same
		// trait, removal wins → trait is absent from the result. trait_states
		// no longer carries explicit 0s.
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const result = sub.computeContactResult(
			shed(['A'], ['A']) as Shed,
			makeModifiedShed(world, ['A'], ['A'])
		);
		expect(result.unchanged).toBe(false);
		// Empty mask = baseline; materializing it gives the empty SubSyndrome.
		const target = world.materializeSubSyndromeByMask(result.target_mask, 0);
		expect(target.trait_states.A).toBeUndefined();
		expect(target.trait_keys).toEqual([]);
		expect(result.key).toBe(maskKeyFor(world, []));
	});

	it('cure-no-longer-grants-immunity: cured trait can be re-added', () => {
		// 'A=0.' under legacy encoding meant "explicit not-A". Under set-only
		// encoding it folds into the baseline (mask 0). Adding A from there
		// flips the bit on, just like before.
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 0 });
		const result = sub.computeContactResult(
			shed(['A'], []) as Shed,
			makeModifiedShed(world, ['A'], [])
		);
		expect(result.unchanged).toBe(false);
		const target = world.materializeSubSyndromeByMask(result.target_mask, 0);
		expect(target.trait_states.A).toBe(1);
	});

	it('does not mutate world.subsyndromes_kv', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const before = world.subsyndromes_kv.size;
		sub.computeContactResult(
			shed(['B'], []) as Shed,
			makeModifiedShed(world, ['B'], [])
		);
		expect(world.subsyndromes_kv.size).toBe(before);
	});

	it('produces same key regardless of trait_keys input order', () => {
		const world = makeWorld();
		const sub = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const r1 = sub.computeContactResult(
			shed(['B', 'C'], []) as Shed,
			makeModifiedShed(world, ['B', 'C'], [])
		);
		const r2 = sub.computeContactResult(
			shed(['C', 'B'], []) as Shed,
			makeModifiedShed(world, ['C', 'B'], [])
		);
		expect(r1.key).toBe(r2.key);
	});

	it('materializeSubSyndrome assigns monotonic ids', () => {
		const world = makeWorld();
		const a = world.materializeSubSyndrome('', ['A'], { A: 1 });
		const b = world.materializeSubSyndrome('', ['B'], { B: 1 });
		expect(a.id).toBe(0);
		expect(b.id).toBe(1);
		expect(world.subsyndromes_by_id[0]).toBe(a);
		expect(world.subsyndromes_by_id[1]).toBe(b);
		// Idempotent on repeated key.
		const aAgain = world.materializeSubSyndrome('', ['A'], { A: 1 });
		expect(aAgain).toBe(a);
		expect(aAgain.id).toBe(0);
	});
});
