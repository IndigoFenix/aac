import { snap, bootstrap } from '../state';
import { useI18n } from '../useI18n';
import { formatDay } from '../dateFormat';

export function DatePanel() {
	const { t, locale } = useI18n();
	const age = snap.value?.age ?? 0;
	const boot = bootstrap.value;
	const name = boot?.scenarioName ?? '';

	// When the scenario uses calendar dates, show the formatted date as the
	// primary label. Otherwise fall back to the i18n "Day {age}" string.
	const label = boot?.useDate && boot.startDate
		? formatDay({ bootstrap: boot, day: age, locale })
		: t('date.day_label', { age });

	return (
		<div class="date-panel">
			<div>{label}</div>
			{name ? <div class="scenario-name">{name}</div> : null}
		</div>
	);
}
