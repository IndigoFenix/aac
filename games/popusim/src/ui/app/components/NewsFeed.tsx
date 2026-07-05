import { newsBuffer, activeModalNews, bootstrap } from '../state';
import { useI18n } from '../useI18n';
import { formatDayShort } from '../dateFormat';
import type { NewsSnapshot } from '../../../sim/protocol';

export function NewsFeed() {
	const { t } = useI18n();
	const items = [...newsBuffer.value].reverse();
	if (items.length === 0) {
		return (
			<div class="panel">
				<div class="panel-header">{t('news.feed_title')}</div>
				<div class="panel-body" style="color: var(--fg-muted)">{t('news.ticker_empty')}</div>
			</div>
		);
	}
	return (
		<div class="panel">
			<div class="panel-header">{t('news.feed_title')}</div>
			<div class="panel-body news-feed-list">
				{items.map(n => <NewsRow key={n.id} item={n} />)}
			</div>
		</div>
	);
}

function NewsRow({ item }: { item: NewsSnapshot }) {
	const { t, locale } = useI18n();
	const boot = bootstrap.value;
	const dayLabel = boot?.useDate && boot.startDate
		? formatDayShort({ bootstrap: boot, day: item.day, locale })
		: t('news.day_label', { day: item.day });
	const openable = item.body !== '';
	return (
		<div
			class={`news-feed-item${openable ? ' openable' : ''}`}
			onClick={openable ? () => { activeModalNews.value = item; } : undefined}
			role={openable ? 'button' : undefined}
			tabIndex={openable ? 0 : undefined}
		>
			<span class="day-tag">{dayLabel}</span>
			<span>{item.title}</span>
		</div>
	);
}
