/**
 * CorrelationModal — popup for creating a player-side correlation trait.
 *
 * Mirrors legacy `Calculator` in correlation mode (script.js:4942). Lets the
 * player pick visible traits across five buckets:
 *   - def_and  / "Has all of"
 *   - def_not  / "Has none of"
 *   - def_or   / "Has at least one of"
 *   - require  / "Must have"
 *   - forbid   / "May not have"
 *
 * Only visible (non-hidden) traits can be picked. The output ships via
 * `client.addCorrelation()` and the worker reshapes the trait/syndrome
 * machinery to retroactively populate the new pseudo-trait's history.
 */

import { useEffect, useState } from 'preact/hooks';
import { useI18n } from '../useI18n';
import { trackersMeta, hiddenTrackerSet } from '../state';
import type { SimClient } from '../../../sim/SimClient';
import type { CustomCorrelationSpec } from '../../../sim/protocol';

interface Props {
	open: boolean;
	onClose: () => void;
	client: SimClient;
	/** When provided, the modal opens in edit mode with the spec pre-populated;
	 * saving sends `editCorrelation` so the trait keeps its key. */
	editing?: { baseKey: string; spec: CustomCorrelationSpec } | null;
}

type BucketKey = 'def_and' | 'def_not' | 'def_or' | 'require' | 'forbid';

const BUCKETS: Array<{ key: BucketKey; labelKey: string; helpKey: string }> = [
	{ key: 'def_and', labelKey: 'correlation.def_and', helpKey: 'correlation.def_and_help' },
	{ key: 'def_not', labelKey: 'correlation.def_not', helpKey: 'correlation.def_not_help' },
	{ key: 'def_or', labelKey: 'correlation.def_or', helpKey: 'correlation.def_or_help' },
	{ key: 'require', labelKey: 'correlation.require', helpKey: 'correlation.require_help' },
	{ key: 'forbid', labelKey: 'correlation.forbid', helpKey: 'correlation.forbid_help' },
];

export function CorrelationModal({ open, onClose, client, editing = null }: Props) {
	const { t } = useI18n();
	const [name, setName] = useState<string>('');
	const [color, setColor] = useState<string>('#cc66cc');
	const [guigroup, setGuigroup] = useState<string>('');
	const [buckets, setBuckets] = useState<Record<BucketKey, string[]>>({
		def_and: [], def_not: [], def_or: [], require: [], forbid: [],
	});

	useEffect(() => {
		if (!open) return;
		if (editing) {
			setName(editing.spec.name);
			setColor(csvToHex(editing.spec.color));
			setGuigroup(editing.spec.guigroup);
			setBuckets({
				def_and: [...editing.spec.def_and],
				def_not: [...editing.spec.def_not],
				def_or: [...editing.spec.def_or],
				require: [...editing.spec.require],
				forbid: [...editing.spec.forbid],
			});
		} else {
			setName('');
			setColor('#cc66cc');
			setGuigroup('');
			setBuckets({ def_and: [], def_not: [], def_or: [], require: [], forbid: [] });
		}
	}, [open, editing]);

	if (!open) return null;

	const hidden = hiddenTrackerSet.value;
	const traits = trackersMeta.value
		.filter(tr => tr.type === 'trait' && !hidden.has(tr.id))
		.map(tr => ({ key: tr.id.slice('trait:'.length), name: tr.name, color: tr.color }));

	function toggle(bucket: BucketKey, traitKey: string): void {
		setBuckets(prev => {
			const cur = new Set(prev[bucket]);
			if (cur.has(traitKey)) cur.delete(traitKey);
			else cur.add(traitKey);
			return { ...prev, [bucket]: [...cur] };
		});
	}

	function submit(): void {
		// At least one non-empty bucket — otherwise the trait is degenerate.
		const totalKeys =
			buckets.def_and.length + buckets.def_not.length + buckets.def_or.length +
			buckets.require.length + buckets.forbid.length;
		if (totalKeys === 0) return;
		// Empty name is valid — the row label falls back to the formula text.
		const spec: CustomCorrelationSpec = {
			name: name.trim(),
			color: cssToRgbaCsv(color),
			guigroup,
			def_and: buckets.def_and,
			def_not: buckets.def_not,
			def_or: buckets.def_or,
			require: buckets.require,
			forbid: buckets.forbid,
		};
		if (editing) {
			client.editCorrelation(editing.baseKey, spec);
		} else {
			client.addCorrelation(spec);
		}
		setBuckets({ def_and: [], def_not: [], def_or: [], require: [], forbid: [] });
		setName('');
		onClose();
	}

	return (
		<div class="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
			<div class="modal correlation-modal" onClick={(e) => e.stopPropagation()}>
				<div class="modal-header">{editing ? t('correlation.edit_title') : t('correlation.create_title')}</div>
				<div class="modal-body">
					<div class="field">
						<label for="corr-name">{t('correlation.name_label')}</label>
						<input
							id="corr-name"
							type="text"
							value={name}
							onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
							placeholder={t('correlation.name_placeholder')}
						/>
					</div>
					<div class="field calc-row">
						<label for="corr-color">{t('correlation.color_label')}</label>
						<input
							id="corr-color"
							type="color"
							value={color}
							onInput={(e) => setColor((e.currentTarget as HTMLInputElement).value)}
						/>
						<label class="calc-inline">
							{t('correlation.guigroup_label')}
							<input
								type="text"
								value={guigroup}
								onInput={(e) => setGuigroup((e.currentTarget as HTMLInputElement).value)}
								placeholder={t('correlation.guigroup_placeholder')}
							/>
						</label>
					</div>
					{traits.length === 0 && (
						<p class="correlation-empty">{t('correlation.no_traits')}</p>
					)}
					{BUCKETS.map(({ key, labelKey, helpKey }) => (
						<div class="correlation-bucket" key={key}>
							<div class="correlation-bucket-label">{t(labelKey)}</div>
							<div class="correlation-bucket-help">{t(helpKey)}</div>
							<div class="correlation-bucket-chips">
								{traits.map(tr => {
									const on = buckets[key].includes(tr.key);
									return (
										<button
											key={tr.key}
											class={`correlation-chip${on ? ' on' : ''}`}
											onClick={() => toggle(key, tr.key)}
											aria-pressed={on}
										>
											<span class="dot" style={`background:${tr.color}`} />
											<span>{tr.name}</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
				<div class="modal-footer">
					<button class="btn" onClick={onClose}>{t('common.cancel')}</button>
					<button
						class="btn primary"
						onClick={submit}
						disabled={
							buckets.def_and.length + buckets.def_not.length + buckets.def_or.length +
							buckets.require.length + buckets.forbid.length === 0
						}
					>{editing ? t('correlation.save_button') : t('correlation.create_button')}</button>
				</div>
			</div>
		</div>
	);
}

function cssToRgbaCsv(hex: string): string {
	const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
	if (!m) return '0,0,0,1';
	const r = parseInt(m[1].slice(0, 2), 16);
	const g = parseInt(m[1].slice(2, 4), 16);
	const b = parseInt(m[1].slice(4, 6), 16);
	return `${r},${g},${b},1`;
}

function csvToHex(csv: string): string {
	const parts = csv.split(',').map(s => parseInt(s.trim(), 10) || 0);
	const [r, g, b] = parts;
	const hex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export default CorrelationModal;
