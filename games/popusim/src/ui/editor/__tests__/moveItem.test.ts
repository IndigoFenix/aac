/**
 * State-level tests for moveItem. The drag-and-drop UI plumbing in
 * ObjectList is not tested here (DOM drag events in jsdom are not
 * faithful enough to be useful) — but the underlying mutation must
 * behave correctly for any source/target pair.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setDraft, draft, moveItem, getIn } from '../state';

describe('moveItem', () => {
	beforeEach(() => {
		setDraft({
			trait: [
				{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' },
			],
		});
	});

	it('moves an item earlier', () => {
		moveItem(['trait'], 2, 0);
		expect((draft.value!.trait as { key: string }[]).map(t => t.key)).toEqual(['c', 'a', 'b', 'd']);
	});

	it('moves an item later', () => {
		moveItem(['trait'], 0, 3);
		expect((draft.value!.trait as { key: string }[]).map(t => t.key)).toEqual(['b', 'c', 'd', 'a']);
	});

	it('is a no-op when source equals target', () => {
		const before = JSON.stringify(draft.value);
		moveItem(['trait'], 1, 1);
		expect(JSON.stringify(draft.value)).toBe(before);
	});

	it('clamps targets out of range to the list bounds', () => {
		moveItem(['trait'], 0, 99);
		expect((draft.value!.trait as { key: string }[]).map(t => t.key)).toEqual(['b', 'c', 'd', 'a']);
	});

	it('only mutates the targeted list, not siblings', () => {
		setDraft({
			trait: [{ key: 't1' }, { key: 't2' }],
			vector: [{ key: 'v1' }, { key: 'v2' }, { key: 'v3' }],
		});
		const before = JSON.stringify(draft.value!.vector);
		moveItem(['trait'], 0, 1);
		expect((draft.value!.trait as { key: string }[]).map(t => t.key)).toEqual(['t2', 't1']);
		expect(JSON.stringify(draft.value!.vector)).toBe(before);
	});

	it('mutates a nested list without disturbing the outer one', () => {
		setDraft({
			trait: [
				{ key: 'a', transmit: [{ apply: ['x'] }, { apply: ['y'] }, { apply: ['z'] }] },
				{ key: 'b' },
			],
		});
		moveItem(['trait', 0, 'transmit'], 2, 0);
		expect(getIn(draft.value, ['trait', 0, 'transmit'])).toEqual([
			{ apply: ['z'] }, { apply: ['x'] }, { apply: ['y'] },
		]);
		// Outer list intact.
		expect((draft.value!.trait as { key: string }[]).map(t => t.key)).toEqual(['a', 'b']);
	});
});
