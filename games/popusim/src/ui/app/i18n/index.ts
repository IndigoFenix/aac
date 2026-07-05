/**
 * i18n loader with ICU MessageFormat compilation.
 *
 * Locale files live as sibling .ts files (en.ts, es.ts, ...). They share an
 * identical key shape — `npm run validate-i18n` enforces this.
 *
 * Lookup is a dotted path: `t('actions.cost.payout', { amount: 12 })`.
 * Missing keys log once and fall back to English; if English is missing too,
 * the key string itself is returned (so it's visible during dev).
 */

import IntlMessageFormat from 'intl-messageformat';
import { en } from './en';

/** Lazy-loaders for the non-English bundles. Static `import(...)` strings keep
 * Vite's dynamic-import-vars analyzer happy and let the bundler tree-shake
 * each locale into its own chunk. */
const LAZY: Record<Exclude<Locale, 'en'>, () => Promise<{ default?: Bundle } & Record<string, Bundle>>> = {
	es: () => import('./es') as never,
	fr: () => import('./fr') as never,
	de: () => import('./de') as never,
	pt: () => import('./pt') as never,
	ru: () => import('./ru') as never,
	ko: () => import('./ko') as never,
	zh: () => import('./zh') as never,
	yue: () => import('./yue') as never,
	he: () => import('./he') as never,
	ar: () => import('./ar') as never,
};

export const LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ru', 'ko', 'zh', 'yue', 'he', 'ar'] as const;
export type Locale = typeof LOCALES[number];
export type Direction = 'ltr' | 'rtl';

export const DEFAULT_LOCALE: Locale = 'en';
const RTL: ReadonlySet<Locale> = new Set<Locale>(['he', 'ar']);

export function dirForLocale(locale: Locale): Direction {
	return RTL.has(locale) ? 'rtl' : 'ltr';
}

export function localeDisplayName(locale: Locale): string {
	return LOCALE_DISPLAY[locale] ?? locale;
}

const LOCALE_DISPLAY: Record<Locale, string> = {
	en: 'English',
	es: 'Español',
	fr: 'Français',
	de: 'Deutsch',
	pt: 'Português',
	ru: 'Русский',
	ko: '한국어',
	zh: '中文',
	yue: '粵語',
	he: 'עברית',
	ar: 'العربية',
};

export type Bundle = Record<string, unknown>;

const loaded: Partial<Record<Locale, Bundle>> = { en: en as unknown as Bundle };
const compiledCache = new Map<string, IntlMessageFormat>();
const warned = new Set<string>();

export async function loadLocale(locale: Locale): Promise<void> {
	if (loaded[locale]) return;
	if (locale === 'en') return;
	const mod = await LAZY[locale]();
	loaded[locale] = (mod[locale] ?? mod.default) as Bundle;
}

function lookup(bundle: Bundle | undefined, dotted: string): string | undefined {
	if (!bundle) return undefined;
	const parts = dotted.split('.');
	let cur: unknown = bundle;
	for (const p of parts) {
		if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[p];
		} else {
			return undefined;
		}
	}
	return typeof cur === 'string' ? cur : undefined;
}

export function translate(
	locale: Locale,
	key: string,
	values?: Record<string, string | number>,
	pseudo: boolean = false,
): string {
	let raw = lookup(loaded[locale], key);
	let usedLocale = locale;
	if (raw === undefined && locale !== 'en') {
		raw = lookup(loaded.en, key);
		usedLocale = 'en';
	}
	if (raw === undefined) {
		if (!warned.has(key)) {
			warned.add(key);
			console.warn(`[i18n] missing key: ${key}`);
		}
		return key;
	}
	const cacheKey = `${usedLocale}::${key}::${raw}`;
	let compiled = compiledCache.get(cacheKey);
	if (!compiled) {
		try {
			compiled = new IntlMessageFormat(raw, usedLocale);
		} catch {
			return raw;
		}
		compiledCache.set(cacheKey, compiled);
	}
	let formatted: string;
	try {
		formatted = String(compiled.format(values));
	} catch {
		formatted = raw;
	}
	if (pseudo) formatted = `[!!${formatted}!!]`;
	return formatted;
}
