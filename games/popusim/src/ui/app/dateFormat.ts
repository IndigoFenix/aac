/**
 * Format the current simulated day as either "Day N" / "Tick N" / etc., or
 * a calendar date when the scenario opted into `use_date`.
 *
 * Day 1 maps to `startDate`; day 2 = startDate + 1 day, etc. When the
 * scenario didn't ship a startDate, we fall back to the day counter so the
 * label still reads sensibly.
 */

import type { Bootstrap } from '../../sim/protocol';

export interface FormatDateOpts {
	bootstrap: Bootstrap | null;
	day: number;
	locale: string;
	style?: 'long' | 'short';
}

/** "Mar 4, 2020" / "March 4, 2020" / "Day 7". Always returns a non-empty string. */
export function formatDay(opts: FormatDateOpts): string {
	const { bootstrap, day, locale, style = 'long' } = opts;
	if (!bootstrap) return `Day ${day}`;
	if (bootstrap.useDate && bootstrap.startDate) {
		const date = dayToDate(bootstrap.startDate, day);
		if (date) {
			try {
				return new Intl.DateTimeFormat(locale, {
					year: 'numeric',
					month: style === 'long' ? 'long' : 'short',
					day: 'numeric',
				}).format(date);
			} catch {
				return date.toISOString().slice(0, 10);
			}
		}
	}
	return `${bootstrap.dayString || 'Day'} ${day}`;
}

/** Compact form used on the graph x-axis. */
export function formatDayShort(opts: FormatDateOpts): string {
	const { bootstrap, day, locale } = opts;
	if (!bootstrap) return String(day);
	if (bootstrap.useDate && bootstrap.startDate) {
		const date = dayToDate(bootstrap.startDate, day);
		if (date) {
			try {
				return new Intl.DateTimeFormat(locale, {
					month: 'short',
					day: 'numeric',
				}).format(date);
			} catch {
				return date.toISOString().slice(5, 10);
			}
		}
	}
	return String(day);
}

/** Day 1 is the start date; day N adds N-1 days. Returns null on parse failure. */
export function dayToDate(startDate: string, day: number): Date | null {
	const m = startDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (!m) return null;
	const y = parseInt(m[1], 10);
	const mo = parseInt(m[2], 10) - 1;
	const d = parseInt(m[3], 10);
	const date = new Date(y, mo, d);
	date.setDate(date.getDate() + Math.max(0, day - 1));
	return date;
}
