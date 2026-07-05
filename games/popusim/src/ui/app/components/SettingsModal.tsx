import { ui, updateUi } from '../state';
import { useI18n } from '../useI18n';
import { LOCALES, localeDisplayName, dirForLocale, type Locale } from '../i18n';
import type { SimClient } from '../../../sim/SimClient';

interface Props {
	open: boolean;
	onClose: () => void;
	client: SimClient;
}

export function SettingsModal({ open, onClose, client }: Props) {
	const { t } = useI18n();
	if (!open) return null;
	const setLocale = (locale: Locale) => updateUi({ language: locale, dir: dirForLocale(locale) });

	return (
		<div class="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
			<div class="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<div class="modal-header">{t('settings.panel_title')}</div>
				<div class="modal-body">
					<div class="field">
						<label for="settings-language">{t('settings.language')}</label>
						<select
							id="settings-language"
							value={ui.value.language}
							onChange={(e) => setLocale((e.currentTarget as HTMLSelectElement).value as Locale)}
						>
							{LOCALES.map(l => (
								<option key={l} value={l}>{localeDisplayName(l)}</option>
							))}
						</select>
					</div>
					<div class="field">
						<label for="settings-direction">{t('settings.direction')}</label>
						<select
							id="settings-direction"
							value={ui.value.dir}
							onChange={(e) => updateUi({ dir: (e.currentTarget as HTMLSelectElement).value as 'ltr' | 'rtl' })}
						>
							<option value="ltr">{t('settings.ltr')}</option>
							<option value="rtl">{t('settings.rtl')}</option>
						</select>
					</div>
					<div class="field">
						<label for="settings-gpu">{t('settings.gpu')}</label>
						<select
							id="settings-gpu"
							value={ui.value.gpuPreference}
							onChange={(e) => {
								const v = (e.currentTarget as HTMLSelectElement).value as 'auto' | 'cpu';
								updateUi({ gpuPreference: v });
								client.setUseGpu(v === 'auto');
							}}
						>
							<option value="auto">{t('settings.gpu_auto')}</option>
							<option value="cpu">{t('settings.gpu_cpu')}</option>
						</select>
					</div>
					<div class="field">
						<label for="settings-reduce-motion">{t('settings.reduce_motion')}</label>
						<input
							id="settings-reduce-motion"
							type="checkbox"
							checked={ui.value.reduceMotion}
							onChange={(e) => updateUi({ reduceMotion: (e.currentTarget as HTMLInputElement).checked })}
						/>
					</div>
					<div class="field">
						<label for="settings-pseudo">{t('settings.pseudo_locale')}</label>
						<input
							id="settings-pseudo"
							type="checkbox"
							checked={ui.value.pseudoLocale}
							onChange={(e) => updateUi({ pseudoLocale: (e.currentTarget as HTMLInputElement).checked })}
						/>
					</div>
				</div>
				<div class="modal-footer">
					<button class="primary" onClick={onClose}>{t('modal.close')}</button>
				</div>
			</div>
		</div>
	);
}
