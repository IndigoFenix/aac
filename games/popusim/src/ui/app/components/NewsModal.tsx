import { activeModalNews, dismissModalNews, bootstrap } from '../state';
import { useI18n } from '../useI18n';
import { formatDay } from '../dateFormat';

export function NewsModal() {
	const { t, locale } = useI18n();
	const item = activeModalNews.value;
	if (!item) return null;
	const boot = bootstrap.value;
	const dayLabel = boot?.useDate && boot.startDate
		? formatDay({ bootstrap: boot, day: item.day, locale })
		: t('news.day_label', { day: item.day });
	return (
		<div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="news-modal-title">
			<div class="modal">
				<div class="modal-header" id="news-modal-title">{item.title}</div>
				<div class="modal-body">
					<div style="color: var(--fg-muted); font-size: 0.75rem; margin-bottom: 0.6rem">
						{dayLabel}
					</div>
					{item.body
						? <div style="white-space: pre-wrap; line-height: 1.5">{item.body}</div>
						: <div style="color: var(--fg-muted)">{t('news.no_body')}</div>}
				</div>
				<div class="modal-footer">
					<button class="primary" onClick={dismissModalNews}>{t('modal.ok')}</button>
				</div>
			</div>
		</div>
	);
}
