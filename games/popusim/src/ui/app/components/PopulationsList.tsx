/**
 * Debug view: every population (a syndrome × site combination) and its
 * count, sorted descending by count. Replaces the news feed when
 * `ui.debugView` is on. Useful for sanity-checking the simulation while
 * the math is still settling.
 */

import { snap, sitesMeta, ui } from '../state';
import { useI18n } from '../useI18n';

export function PopulationsList() {
	const { t } = useI18n();
	const s = snap.value;
	const sites = sitesMeta.value;
	if (!s) {
		return (
			<div class="panel">
				<div class="panel-header">Populations (debug)</div>
				<div class="panel-body" style="color: var(--fg-muted)">{t('common.loading')}</div>
			</div>
		);
	}

	// In gameplay we generally focus a single site; in world view, show all.
	const showAllSites = ui.value.view === 'world' || sites.length === 1;
	const focusKey = showAllSites ? null : (ui.value.selectedSiteKey ?? sites[0]?.key ?? null);

	const visible = showAllSites
		? s.sites
		: s.sites.filter(site => site.key === focusKey);

	return (
		<div class="panel">
			<div class="panel-header">Populations (debug)</div>
			<div class="panel-body">
				{visible.map(site => {
					const sorted = site.pops.slice().sort((a, b) => b.pop - a.pop);
					const total = sorted.reduce((acc, p) => acc + p.pop, 0);
					const meta = sites.find(m => m.key === site.key);
					return (
						<div key={site.key}>
							{showAllSites ? (
								<div class="site-divider">
									{meta?.name ?? site.key} — {formatNum(total)} / {formatNum(site.pop)} ({sorted.length} pops)
								</div>
							) : (
								<div class="site-divider">
									{formatNum(total)} / {formatNum(site.pop)} total — {sorted.length} populations
								</div>
							)}
							<div class="populations-list">
								{sorted.map(p => (
									<div class="pop-row" key={p.syndromeKey}>
										<span class="key" title={p.syndromeKey || '(baseline)'}>
											{p.syndromeKey || '(baseline)'}
										</span>
										<span class="pop">{formatNum(p.pop)}</span>
									</div>
								))}
								{sorted.length === 0 && (
									<div style="color: var(--fg-muted); font-style: italic">No populations.</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function formatNum(v: number): string {
	if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	if (Number.isInteger(v)) return v.toFixed(0);
	return v.toFixed(2);
}
