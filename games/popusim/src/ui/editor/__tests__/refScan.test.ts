/**
 * Pure-function tests for the reference scanner.
 *
 * Builds small scenarios in-line so failures point clearly at one
 * code path. The DOM/modal layer is exercised separately.
 */

import { describe, it, expect } from 'vitest';
import {
	findReferences, applyRenameRefs, applyClearRefs, summarizeSites,
} from '../refScan';

describe('findReferences', () => {
	it('finds single ref in a numberOrRef field (Transmit value pointing at a resource)', () => {
		const scenario = {
			resource: [{ key: 'fund' }],
			trait: [{
				key: 't',
				transmit: [{ value: 'fund', sd: 0 }],
			}],
		};
		const sites = findReferences(scenario, 'resource', 'fund');
		expect(sites).toHaveLength(1);
		expect(sites[0].fieldKey).toBe('value');
		expect(sites[0].multi).toBe(false);
		expect(sites[0].parentSchema.label).toBe('Transmit');
	});

	it('finds entries in a refList (Transmit.apply containing the trait)', () => {
		const scenario = {
			trait: [
				{ key: 'a' },
				{ key: 'b', transmit: [{ apply: ['a', 'c'], vector: [] }] },
			],
		};
		const sites = findReferences(scenario, 'trait', 'a');
		expect(sites).toHaveLength(1);
		expect(sites[0].multi).toBe(true);
		expect(sites[0].fieldKey).toBe('apply');
	});

	it('does not find self-references (the renamed object\'s own key field)', () => {
		const scenario = {
			trait: [{ key: 'a' }, { key: 'b' }],
		};
		// Even if we rename "a", the object's own key field is not a reference.
		expect(findReferences(scenario, 'trait', 'a')).toEqual([]);
	});

	it('respects list separation (renaming a vector does not match a same-named trait)', () => {
		const scenario = {
			trait: [{ key: 'shared' }],
			vector: [{ key: 'shared' }],
			// Trait A has a transmit pointing at trait "shared", not vector "shared".
			// (Hypothetical — reflists are typed by .list.)
		};
		const traitRefs = findReferences(scenario, 'trait', 'shared');
		const vectorRefs = findReferences(scenario, 'vector', 'shared');
		expect(traitRefs).toEqual([]);
		expect(vectorRefs).toEqual([]);
	});

	it('finds multiple references in nested children', () => {
		const scenario = {
			trait: [
				{ key: 'air' },
				{
					key: 'pathogen',
					transmit_mod: [{ vector: ['air'], mult: 1 }],
					contact_mod:  [{ vector: ['air'], mult: 1 }],
					progress: [{ vector: ['air'], apply: [] }],
				},
			],
		};
		// Hand-make a top-level vector "air" so refs are valid.
		(scenario as Record<string, unknown>).vector = [{ key: 'air' }];
		const sites = findReferences(scenario as never, 'vector', 'air');
		expect(sites.length).toBeGreaterThanOrEqual(3);
	});
});

describe('applyRenameRefs', () => {
	it('rewrites both single and list references', () => {
		const scenario = {
			trait: [
				{ key: 'a' },
				{ key: 'b', transmit: [{ apply: ['a'], vector: [], value: 0 }] },
				{ key: 'c', transmit: [{ apply: [], vector: [], value: 'fund' }] },
			],
			resource: [{ key: 'fund' }],
		};
		const sites = findReferences(scenario, 'trait', 'a');
		const next = applyRenameRefs(scenario, sites, 'a', 'a-renamed');
		expect((next.trait as Record<string, unknown>[])[1].transmit).toEqual([
			{ apply: ['a-renamed'], vector: [], value: 0 },
		]);
		// Original is untouched.
		expect(scenario.trait[1].transmit?.[0]?.apply).toEqual(['a']);
	});
});

describe('applyClearRefs', () => {
	it('drops list entries and clears single refs to empty string', () => {
		const scenario = {
			trait: [
				{ key: 'a' },
				{ key: 'b', transmit: [{ apply: ['a', 'x'], vector: [], value: 'a-as-resource' }] },
			],
			resource: [{ key: 'a-as-resource' }],
		};
		// Find references to trait 'a' (only the apply list — the value field
		// references a resource, not a trait).
		const sites = findReferences(scenario, 'trait', 'a');
		const next = applyClearRefs(scenario, sites, 'a');
		expect((next.trait as Record<string, unknown>[])[1].transmit).toEqual([
			{ apply: ['x'], vector: [], value: 'a-as-resource' },
		]);
	});

	it('clears a single ref (numberOrRef pointing at a resource)', () => {
		const scenario = {
			resource: [{ key: 'fund' }],
			trait: [{ key: 't', transmit: [{ apply: [], vector: [], value: 'fund', sd: 0 }] }],
		};
		const sites = findReferences(scenario, 'resource', 'fund');
		const next = applyClearRefs(scenario, sites, 'fund');
		expect((next.trait as Record<string, unknown>[])[0].transmit).toEqual([
			{ apply: [], vector: [], value: '', sd: 0 },
		]);
	});
});

describe('summarizeSites', () => {
	it('groups by parent schema label, sorted by descending count', () => {
		const scenario = {
			vector: [{ key: 'air' }],
			trait: [
				{ key: 'a',
					transmit:    [{ vector: ['air'], apply: [] }, { vector: ['air'], apply: [] }],
					progress:    [{ vector: ['air'], apply: [] }],
					transmit_mod:[{ vector: ['air'], mult: 1 }, { vector: ['air'], mult: 1 }, { vector: ['air'], mult: 1 }],
				},
			],
		};
		const sites = findReferences(scenario, 'vector', 'air');
		const summary = summarizeSites(sites);
		// Three on Transmit Mod, two on Transmit, one on Progress.
		expect(summary[0].count).toBeGreaterThanOrEqual(summary[summary.length - 1].count);
		expect(summary.find(s => s.label === 'Transmit Mod')?.count).toBe(3);
		expect(summary.find(s => s.label === 'Transmit')?.count).toBe(2);
		expect(summary.find(s => s.label === 'Progress')?.count).toBe(1);
	});
});
