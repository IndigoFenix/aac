/**
 * StatusPanel — trackers grouped by GUIGroup.
 *
 * Each group is collapsible; each tracker row has a colored bullet that
 * toggles the legend's hide/show state (so the panel and the graph share
 * one source of truth for visibility).
 *
 * `TrackerRow` is exported so the unified `GroupedPanel` can reuse it.
 */

import { useState } from 'preact/hooks';
import {
	trackersByGroup, groupsMeta, ui, toggleGroupCollapsed, snap,
	isSeriesHidden, toggleSeries, getSeries, historyVersion, lookupSiteKey,
	grayedOutTrackerSet, trackerByIdLookup,
} from '../state';
import { useI18n } from '../useI18n';
import type { TrackerMeta } from '../../../sim/protocol';
import { CalculatorModal } from './CalculatorModal';
import { CorrelationModal } from './CorrelationModal';
import type { SimClient } from '../../../sim/SimClient';
import { metricFormulaText, correlationFormulaText } from './formulaText';

interface Props {
	client: SimClient;
}

export function StatusPanel({ client }: Props) {
	const { t } = useI18n();
	const [metricOpen, setMetricOpen] = useState<boolean>(false);
	const [correlationOpen, setCorrelationOpen] = useState<boolean>(false);
	const grouped = trackersByGroup.value;
	const groups = groupsMeta.value;
	const trackerCount = Array.from(grouped.values()).reduce((a, arr) => a + arr.length, 0);

	const ordered = [
		...groups,
		...(grouped.has(null) ? [{ key: '', name: t('groups.ungrouped'), parentKey: null, order: 9999 }] : []),
	];

	return (
		<div class="panel">
			<div class="panel-header">
				{t('status.panel_title')}
				<span class="status-panel-actions">
					<button class="status-panel-btn" onClick={() => setMetricOpen(true)} title={t('metrics.create_button')}>
						{t('metrics.create_button')}
					</button>
					<button class="status-panel-btn" onClick={() => setCorrelationOpen(true)} title={t('correlation.create_button')}>
						{t('correlation.create_button')}
					</button>
				</span>
			</div>
			<div class="panel-body">
				{trackerCount === 0
					? <div style="color: var(--fg-muted)">{t('status.no_data')}</div>
					: ordered.map(g => {
						const arr = grouped.get(g.key === '' ? null : g.key) ?? [];
						if (arr.length === 0) return null;
						return <Group key={g.key} groupKey={g.key} groupName={g.name} trackers={arr} client={client} />;
					})
				}
			</div>
			<CalculatorModal open={metricOpen} onClose={() => setMetricOpen(false)} client={client} />
			<CorrelationModal open={correlationOpen} onClose={() => setCorrelationOpen(false)} client={client} />
		</div>
	);
}

function Group({ groupKey, groupName, trackers, client }: { groupKey: string; groupName: string; trackers: TrackerMeta[]; client: SimClient }) {
	const { t } = useI18n();
	const collapsed = !!ui.value.collapsedGroups[groupKey];
	return (
		<div class={`gui-group${collapsed ? ' collapsed' : ''}`}>
			<div
				class="gui-group-header"
				onClick={() => toggleGroupCollapsed(groupKey)}
				role="button"
				aria-expanded={!collapsed}
				tabIndex={0}
				onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleGroupCollapsed(groupKey); }}
				title={collapsed ? t('status.group_expand') : t('status.group_collapse')}
			>
				<span class="chev" aria-hidden="true" />
				<span>{groupName}</span>
			</div>
			{!collapsed && trackers.map(tr => <TrackerRow key={tr.id} tracker={tr} client={client} />)}
		</div>
	);
}

interface TrackerRowProps {
	tracker: TrackerMeta;
	client: SimClient;
	/** When set, player-created rows show a pencil that calls back with the
	 * tracker. The host (GroupedPanel) opens the matching edit modal. */
	onEdit?: (tracker: TrackerMeta) => void;
}

export function TrackerRow({ tracker, client, onEdit }: TrackerRowProps) {
	const { t } = useI18n();
	const sk = lookupSiteKey(tracker.global);
	const hidden = isSeriesHidden(tracker.id, sk);
	const grayed = grayedOutTrackerSet.value.has(tracker.id);
	const value = computeLatestValue(tracker, sk);
	const label = displayLabelFor(tracker);

	function onDelete(e: MouseEvent): void {
		e.stopPropagation();
		if (tracker.type === 'metric') {
			client.removeCustomMetric(tracker.id.slice('metric:'.length));
		} else if (tracker.type === 'trait') {
			client.removeCustomTrait(tracker.id.slice('trait:'.length));
		}
	}

	function onEditClick(e: MouseEvent): void {
		e.stopPropagation();
		onEdit?.(tracker);
	}

	const canEdit = !!onEdit && tracker.playerCreated && (
		(tracker.type === 'metric' && !!tracker.metricSpec) ||
		(tracker.type === 'trait' && !!tracker.correlationSpec)
	);

	return (
		<div class={`tracker-row${grayed ? ' grayed-out' : ''}`} title={grayed ? t('metrics.grayed_out_tip') : undefined}>
			<span
				class={`tracker-bullet${hidden ? ' hidden' : ''}`}
				style={`--swatch: ${tracker.color}`}
				onClick={() => toggleSeries(tracker.id, sk)}
				role="checkbox"
				aria-checked={!hidden}
				tabIndex={0}
				onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSeries(tracker.id, sk); }}
			/>
			<span class="label">{label}</span>
			<span class="value">{formatNum(value, tracker.precision)}</span>
			{canEdit && (
				<button class="tracker-edit" onClick={onEditClick} aria-label={t('metrics.edit')} title={t('metrics.edit')}>✎</button>
			)}
			{tracker.playerCreated && (
				<button class="tracker-delete" onClick={onDelete} aria-label={t('metrics.delete')} title={t('metrics.delete')}>×</button>
			)}
		</div>
	);
}

function displayLabelFor(tracker: TrackerMeta): string {
	if (tracker.name && tracker.name !== '') return tracker.name;
	if (tracker.metricSpec) return metricFormulaText(tracker.metricSpec, trackerByIdLookup);
	if (tracker.correlationSpec) return correlationFormulaText(tracker.correlationSpec, trackerByIdLookup);
	return tracker.id;
}

function computeLatestValue(tracker: TrackerMeta, siteKey?: string): number {
	void historyVersion.value; // subscribe so the row re-renders on new days
	void snap.value;
	const s = getSeries(tracker.id, siteKey);
	if (!s || s.values.length === 0) return 0;
	return s.values[s.values.length - 1];
}

export function formatNum(v: number, precision?: number): string {
	if (typeof precision === 'number') return v.toFixed(precision);
	if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	if (Number.isInteger(v)) return v.toFixed(0);
	return v.toFixed(2);
}
