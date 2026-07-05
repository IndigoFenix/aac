import { ui, updateUi, activeModalNews, SPEED_TABLE, type SpeedKey } from '../state';
import { useI18n } from '../useI18n';
import type { SimClient } from '../../../sim/SimClient';

interface Props {
	client: SimClient;
}

/** Buttons in the order we want them displayed. `paused` lives implicitly
 * in the gap between Step and the play speeds; the user clicks paused by
 * picking the first speed button while it's already active. */
const PLAY_KEYS: ReadonlyArray<SpeedKey> = ['1x', '2x', '4x', 'max'];

export function SpeedControls({ client }: Props) {
	const { t } = useI18n();
	const speed = ui.value.speed;
	const blocked = !!activeModalNews.value;

	const setSpeed = (next: SpeedKey) => {
		if (blocked) return;
		// Click the active speed = pause. Anything else swaps speed.
		const target: SpeedKey = next === speed ? 'paused' : next;
		updateUi({ speed: target });
		if (target === 'paused') {
			void client.pause();
		} else {
			const cfg = SPEED_TABLE[target];
			client.run(cfg.msPerDay, cfg.snapshotEveryDays);
		}
	};

	const stepOne = async () => {
		if (blocked) return;
		if (speed !== 'paused') {
			await client.pause();
			updateUi({ speed: 'paused' });
		}
		await client.step(1);
	};

	const togglePause = () => setSpeed(speed === 'paused' ? '1x' : speed);

	return (
		<div class="speed-controls" role="group" aria-label={t('controls.pause')}>
			<button
				class={`speed-btn${speed === 'paused' ? ' active' : ''}`}
				onClick={togglePause}
				title={t('controls.pause')}
				disabled={blocked}
				aria-pressed={speed === 'paused'}
			>{SPEED_TABLE.paused.label}</button>
			<button
				class="speed-btn"
				onClick={stepOne}
				title={t('controls.next')}
				disabled={blocked}
				aria-label={t('controls.next')}
			>⏭</button>
			{PLAY_KEYS.map(k => (
				<button
					key={k}
					class={`speed-btn${speed === k ? ' active' : ''}`}
					onClick={() => setSpeed(k)}
					title={t('controls.speed_label', { speed: k === 'max' ? '∞' : k.replace('x', '') })}
					disabled={blocked}
					aria-pressed={speed === k}
				>{SPEED_TABLE[k].label}</button>
			))}
		</div>
	);
}
