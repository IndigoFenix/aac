/**
 * Verifies the alpha curve for the power-of-ten Y-axis grid matches the
 * spec:
 *   - lines at step S are fully visible (with labels) up to viewTop = 20·S
 *   - they fade linearly to 0 between viewTop = 20·S and 100·S
 *   - they're fully hidden beyond 100·S
 */

import { describe, it, expect } from 'vitest';
import { lineCountAlpha } from '../components/GraphPanel';

describe('lineCountAlpha (power-of-ten grid)', () => {
	// viewTop / step = "count". The cases below name the step so the
	// expectation matches the user-facing spec without doing math.
	it('keeps per-10 lines + numbers up to viewTop = 200', () => {
		// step=10, viewTop ≤ 200 → count ≤ 20 → alpha 1
		expect(lineCountAlpha(100 / 10)).toBe(1);  // viewTop=100
		expect(lineCountAlpha(200 / 10)).toBe(1);  // viewTop=200
	});

	it('fades per-10 lines from alpha 1 down to 0 between viewTop 200 and 1000', () => {
		expect(lineCountAlpha(300 / 10)).toBeCloseTo((100 - 30) / 80, 5);
		expect(lineCountAlpha(600 / 10)).toBeCloseTo((100 - 60) / 80, 5);
		expect(lineCountAlpha(1000 / 10)).toBe(0);
	});

	it('keeps per-100 lines + numbers up to viewTop = 2000', () => {
		expect(lineCountAlpha(1000 / 100)).toBe(1);
		expect(lineCountAlpha(2000 / 100)).toBe(1);
	});

	it('fades per-100 lines completely by viewTop = 10000', () => {
		expect(lineCountAlpha(3000 / 100)).toBeCloseTo((100 - 30) / 80, 5);
		expect(lineCountAlpha(10000 / 100)).toBe(0);
	});

	it('mirrors the same shape one decade up (per-1000 numbers up to 20000, hidden by 100000)', () => {
		expect(lineCountAlpha(20000 / 1000)).toBe(1);
		expect(lineCountAlpha(100000 / 1000)).toBe(0);
	});
});
