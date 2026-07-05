import { snap, sitesMeta, updateUi } from '../state';
import { useI18n } from '../useI18n';

export function WorldView() {
	const { t } = useI18n();
	const sites = sitesMeta.value;
	const live = snap.value?.sites ?? [];

	return (
		<div class="panel">
			<div class="panel-header">{t('sites.world_view')}</div>
			<div class="panel-body world-view-grid">
				{sites.map(meta => {
					const site = live.find(s => s.key === meta.key);
					const top = (site?.pops ?? [])
						.slice()
						.sort((a, b) => b.pop - a.pop)
						.slice(0, 3);
					return (
						<div
							class="site-card"
							key={meta.key}
							onClick={() => updateUi({ view: 'site', selectedSiteKey: meta.key })}
							role="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ')
									updateUi({ view: 'site', selectedSiteKey: meta.key });
							}}
						>
							<div class="site-name">{meta.name}</div>
							<div class="pop">{t('sites.total_pop')}: {formatNum(site?.pop ?? meta.totalPop)}</div>
							{top.length > 0 ? (
								<div class="top-pops">
									{top.map(p => (
										<div key={p.syndromeKey}>
											{(p.syndromeKey || 'baseline').slice(0, 36)}
											<span style="float: inline-end">{formatNum(p.pop)}</span>
										</div>
									))}
								</div>
							) : null}
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
	return v.toFixed(0);
}
