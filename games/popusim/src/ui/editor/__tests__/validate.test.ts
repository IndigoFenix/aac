import { describe, it, expect } from 'vitest';
import { validateScenario } from '../validate';
import covid from '../../../../example-scenarios/covid-19.json';

describe('validateScenario', () => {
	it('flags missing phase and missing site on a blank scenario', () => {
		const issues = validateScenario({ name: 'X' });
		const errors = issues.filter(i => i.severity === 'error');
		expect(errors.some(i => i.field === 'phase' && i.crumbs.length === 0)).toBe(true);
		expect(errors.some(i => i.field === 'site' && i.crumbs.length === 0)).toBe(true);
	});

	it('flags duplicate trait IDs and includes the offender in breadcrumbs', () => {
		const scenario = {
			name: 'X',
			phase: [{ key: 'p' }],
			site: [{ key: 's' }],
			trait: [{ key: 'a' }, { key: 'a' }],
		};
		const issues = validateScenario(scenario);
		const dup = issues.find(i => i.severity === 'error' && i.message.includes('Duplicate'));
		expect(dup).toBeDefined();
		// The breadcrumb identifies the duplicate trait by its ID.
		const last = dup!.crumbs[dup!.crumbs.length - 1];
		expect(last.identifier).toBe('a');
		expect(last.label).toBe('Trait');
	});

	it('flags dangling refList references with a useful breadcrumb', () => {
		const scenario = {
			name: 'X',
			phase: [{ key: 'p' }],
			site: [{ key: 's' }],
			trait: [{
				key: 'a',
				transmit: [{ apply: ['nonexistent'], vector: ['gone'], phase: 'p' }],
			}],
		};
		const issues = validateScenario(scenario);
		const warnings = issues.filter(i => i.severity === 'warning');
		const w1 = warnings.find(w => w.message.includes('"nonexistent"'));
		const w2 = warnings.find(w => w.message.includes('"gone"'));
		expect(w1).toBeDefined();
		expect(w2).toBeDefined();
		// Breadcrumb chain: Trait "a" › Transmit "<rowLabel>"
		expect(w1!.crumbs.length).toBe(2);
		expect(w1!.crumbs[0]).toMatchObject({ label: 'Trait', identifier: 'a' });
		expect(w1!.crumbs[1].label).toBe('Transmit');
		expect(w1!.field).toBe('apply');
	});

	it('treats covid-19.json as clean (no errors, may have warnings for legacy data)', () => {
		const scenario = JSON.parse(JSON.stringify(covid));
		const issues = validateScenario(scenario);
		const errors = issues.filter(i => i.severity === 'error');
		expect(errors).toEqual([]);
	});
});
