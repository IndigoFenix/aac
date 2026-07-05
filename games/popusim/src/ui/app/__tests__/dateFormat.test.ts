/**
 * Day-N → calendar-date formatting. Day 1 maps to startDate; subsequent
 * days advance one calendar day each. Falls back to the day counter when
 * the scenario isn't using dates.
 */

import { describe, it, expect } from 'vitest';
import { formatDay, formatDayShort, dayToDate } from '../dateFormat';
import type { Bootstrap } from '../../../sim/protocol';

const bootDate: Bootstrap = {
	scenarioKey: 'k', scenarioName: 'k',
	sites: [], guiGroups: [], trackers: [], actions: [], stockpiles: [], phases: [],
	useDate: true, startDate: '2020-01-01', dayString: 'Day',
};
const bootNoDate: Bootstrap = { ...bootDate, useDate: false, startDate: '' };

describe('dayToDate', () => {
	it('maps day 1 to the startDate exactly', () => {
		const d = dayToDate('2020-01-01', 1);
		expect(d?.getFullYear()).toBe(2020);
		expect(d?.getMonth()).toBe(0);
		expect(d?.getDate()).toBe(1);
	});

	it('advances by N-1 days for day N', () => {
		const d = dayToDate('2020-01-01', 5);
		expect(d?.getDate()).toBe(5);
	});

	it('returns null on a malformed date', () => {
		expect(dayToDate('not-a-date', 1)).toBeNull();
	});
});

describe('formatDay', () => {
	it('formats with the calendar when useDate is true', () => {
		const out = formatDay({ bootstrap: bootDate, day: 31, locale: 'en-US' });
		// Should mention 2020 and January / Jan.
		expect(out).toMatch(/2020/);
		expect(out).toMatch(/Jan/);
	});

	it('falls back to the day-counter format when useDate is false', () => {
		const out = formatDay({ bootstrap: bootNoDate, day: 7, locale: 'en-US' });
		expect(out).toBe('Day 7');
	});

	it('uses a custom dayString when provided', () => {
		const customBoot = { ...bootNoDate, dayString: 'Tick' };
		expect(formatDay({ bootstrap: customBoot, day: 3, locale: 'en-US' })).toBe('Tick 3');
	});
});

describe('formatDayShort', () => {
	it('returns just month + day for the graph axis', () => {
		const out = formatDayShort({ bootstrap: bootDate, day: 60, locale: 'en-US' });
		// Day 60 = Feb 29, 2020 (leap year).
		expect(out).toMatch(/Feb/);
	});

	it('falls back to the day number for short labels', () => {
		expect(formatDayShort({ bootstrap: bootNoDate, day: 5, locale: 'en-US' })).toBe('5');
	});
});
