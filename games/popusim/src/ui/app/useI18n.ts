/**
 * useI18n — read locale + provide a `t()` function bound to it.
 *
 * Tracks the `ui.language` signal so any component reading `t()` re-renders
 * when the locale changes.
 */

import { useEffect, useState } from 'preact/hooks';
import { translate, loadLocale, type Locale } from './i18n';
import { ui } from './state';

export interface I18n {
	t: (key: string, values?: Record<string, string | number>) => string;
	locale: Locale;
}

export function useI18n(): I18n {
	// Read both signals so the hook re-runs on either change. The pseudo flag
	// flips bracketing on/off without changing the locale itself.
	const locale = ui.value.language;
	const pseudo = ui.value.pseudoLocale;
	const [, setReady] = useState(0);

	useEffect(() => {
		let cancelled = false;
		loadLocale(locale).then(() => {
			if (!cancelled) setReady(n => n + 1);
		});
		return () => { cancelled = true; };
	}, [locale]);

	const t = (key: string, values?: Record<string, string | number>) =>
		translate(locale, key, values, pseudo);

	return { t, locale };
}
