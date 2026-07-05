import { newsBuffer, activeModalNews } from '../state';
import { useI18n } from '../useI18n';

interface Props {
	onExpandClick: () => void;
}

export function NewsTicker({ onExpandClick }: Props) {
	const { t } = useI18n();
	const items = newsBuffer.value;
	const latest = items[items.length - 1];
	const text = latest?.title || t('news.ticker_empty');
	const paused = !!activeModalNews.value;

	return (
		<div
			class="news-ticker"
			onClick={onExpandClick}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onExpandClick(); }}
		>
			<span class="label">{t('news.label')}</span>
			<div class="marquee" aria-live="polite">
				<div class="marquee-inner">{paused ? t('news.paused_for_news') : text}</div>
			</div>
		</div>
	);
}
