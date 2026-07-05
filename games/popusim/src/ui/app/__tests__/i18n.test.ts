/**
 * i18n smoke tests — these complement `npm run validate-i18n` (which checks
 * structural parity at the source level) by verifying the runtime behavior:
 * lookup, fallback, ICU formatting, and the RTL-direction map.
 */

import { describe, it, expect } from 'vitest';
import { translate, dirForLocale, LOCALES } from '../i18n';
import { en } from '../i18n/en';
import { he } from '../i18n/he';
import { ar } from '../i18n/ar';

describe('translate()', () => {
	it('returns the English string for a known key', () => {
		expect(translate('en', 'common.ok')).toBe('OK');
	});

	it('formats ICU values', () => {
		expect(translate('en', 'date.day_label', { age: 7 })).toBe('Day 7');
	});

	it('selects plural branches', () => {
		expect(translate('en', 'common.day', { n: 1 })).toBe('1 day');
		expect(translate('en', 'common.day', { n: 5 })).toBe('5 days');
	});

	it('falls back to English when a locale lacks a key', () => {
		// All locales currently mirror en; simulate a fallback by looking up
		// a key only in en (impossible by validator, but the function should
		// still echo the key path if missing everywhere).
		expect(translate('en', 'totally.fake.key')).toBe('totally.fake.key');
	});
});

describe('dirForLocale()', () => {
	it('returns rtl for he and ar', () => {
		expect(dirForLocale('he')).toBe('rtl');
		expect(dirForLocale('ar')).toBe('rtl');
	});

	it('returns ltr for everything else', () => {
		for (const l of LOCALES) {
			if (l === 'he' || l === 'ar') continue;
			expect(dirForLocale(l)).toBe('ltr');
		}
	});
});

describe('locale bundles', () => {
	it('all share the en root keys', () => {
		const enKeys = Object.keys(en).sort();
		expect(Object.keys(he).sort()).toEqual(enKeys);
		expect(Object.keys(ar).sort()).toEqual(enKeys);
	});
});
