/**
 * Round-trip test: a draft loaded from covid-19.json and exported
 * unchanged should be deeply equal to the source JSON.
 *
 * The editor never mutates the underlying objects directly; it goes
 * through `applyEdit` which is immutable. So a no-op load → export should
 * be identity. This test guards against future accidental normalization
 * (default-stripping, key reordering, type coercion) sneaking in.
 */

import { describe, it, expect } from 'vitest';
import covid from '../../../../example-scenarios/covid-19.json';
import { setDraft, draft } from '../state';

describe('scenario round-trip', () => {
	it('covid-19.json survives load → export untouched', () => {
		// Deep clone so we don't mutate the imported JSON during the test.
		const source = JSON.parse(JSON.stringify(covid)) as Record<string, unknown>;
		setDraft(source);
		// Mimic ScenarioIO export: stringify and re-parse, deep-equal compare.
		const exported = JSON.parse(JSON.stringify(draft.value));
		expect(exported).toEqual(JSON.parse(JSON.stringify(covid)));
	});
});
