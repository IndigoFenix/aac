import { sitesMeta, ui, updateUi, selectedSiteKey } from '../state';
import { useI18n } from '../useI18n';

export function SiteSelector() {
	const { t } = useI18n();
	const sites = sitesMeta.value;
	const selected = selectedSiteKey.value;
	const view = ui.value.view;

	if (sites.length === 0) return null;

	return (
		<div class="site-selector">
			<label class="sr-only" for="site-selector">{t('sites.selector_label')}</label>
			<select
				id="site-selector"
				value={view === 'world' ? '__world__' : (selected ?? '')}
				onChange={(e) => {
					const v = (e.currentTarget as HTMLSelectElement).value;
					if (v === '__world__') {
						updateUi({ view: 'world' });
					} else {
						updateUi({ view: 'site', selectedSiteKey: v });
					}
				}}
			>
				{sites.length > 1 && <option value="__world__">{t('sites.world_view')}</option>}
				{sites.map(s => (
					<option key={s.key} value={s.key}>{s.name}</option>
				))}
			</select>
		</div>
	);
}
