/**
 * GroupedPanel — unified status + actions panel.
 *
 * Renders one panel where each GUIGroup contains both its trackers
 * (traits/resources/metrics) and its player actions, mirroring the
 * legacy GUIBox structure. A group with only trackers, only actions,
 * or both renders the same way; the empty state hides the group entirely.
 *
 * The Create Metric / Create Correlation buttons live in this panel's
 * header so the player has a single place to read state and act on it.
 */

import { useState } from 'preact/hooks';
import {
	trackersByGroup, actionsByGroup, groupsMeta, ui, toggleGroupCollapsed,
} from '../state';
import { useI18n } from '../useI18n';
import type {
	TrackerMeta, ActionMeta, CustomMetricSpec, CustomCorrelationSpec,
} from '../../../sim/protocol';
import type { SimClient } from '../../../sim/SimClient';
import { CalculatorModal } from './CalculatorModal';
import { CorrelationModal } from './CorrelationModal';
import { TrackerRow } from './StatusPanel';
import { ActionRow, isVisibleForCurrentSite, isHidden, showHiddenActions } from './ActionsPanel';

interface Props { client: SimClient }

interface MetricEdit { baseKey: string; spec: CustomMetricSpec }
interface CorrelationEdit { baseKey: string; spec: CustomCorrelationSpec }

export function GroupedPanel({ client }: Props) {
	const { t } = useI18n();
	const [metricOpen, setMetricOpen] = useState<boolean>(false);
	const [correlationOpen, setCorrelationOpen] = useState<boolean>(false);
	const [metricEdit, setMetricEdit] = useState<MetricEdit | null>(null);
	const [correlationEdit, setCorrelationEdit] = useState<CorrelationEdit | null>(null);

	function onEditTracker(tracker: TrackerMeta): void {
		if (tracker.type === 'metric' && tracker.metricSpec) {
			setMetricEdit({
				baseKey: tracker.id.slice('metric:'.length),
				spec: tracker.metricSpec,
			});
			setMetricOpen(true);
		} else if (tracker.type === 'trait' && tracker.correlationSpec) {
			setCorrelationEdit({
				baseKey: tracker.id.slice('trait:'.length),
				spec: tracker.correlationSpec,
			});
			setCorrelationOpen(true);
		}
	}

	function closeMetric(): void {
		setMetricOpen(false);
		setMetricEdit(null);
	}
	function closeCorrelation(): void {
		setCorrelationOpen(false);
		setCorrelationEdit(null);
	}

	const trackerGroups = trackersByGroup.value;
	const actionGroups = actionsByGroup.value;
	const groups = groupsMeta.value;

	// Collect every group key that holds either a tracker or an action so
	// scenarios that only declare actions in a group still see it surface.
	const seen = new Set<string | null>();
	const ordered: { key: string; name: string }[] = [];
	for (const g of groups) {
		seen.add(g.key);
		ordered.push({ key: g.key, name: g.name });
	}
	if ((trackerGroups.has(null) || actionGroups.has(null)) && !seen.has(null)) {
		ordered.push({ key: '', name: t('groups.ungrouped') });
	}

	const totalTrackers = Array.from(trackerGroups.values()).reduce((a, arr) => a + arr.length, 0);
	const totalActions = Array.from(actionGroups.values()).reduce((a, arr) => a + arr.length, 0);
	const empty = totalTrackers === 0 && totalActions === 0;

	return (
		<div class="panel grouped-panel">
			<div class="panel-header">
				{t('status.panel_title')}
				<span class="status-panel-actions">
					<button class="status-panel-btn" onClick={() => { setMetricEdit(null); setMetricOpen(true); }} title={t('metrics.create_button')}>
						{t('metrics.create_button')}
					</button>
					<button class="status-panel-btn" onClick={() => { setCorrelationEdit(null); setCorrelationOpen(true); }} title={t('correlation.create_button')}>
						{t('correlation.create_button')}
					</button>
				</span>
			</div>
			<div class="panel-body">
				{empty
					? <div style="color: var(--fg-muted)">{t('status.no_data')}</div>
					: ordered.map(g => {
						const lookupKey: string | null = g.key === '' ? null : g.key;
						const trackers = trackerGroups.get(lookupKey) ?? [];
						const actionsAll = actionGroups.get(lookupKey) ?? [];
						const actions = actionsAll
							.filter(a => isVisibleForCurrentSite(a))
							.filter(a => showHiddenActions || !isHidden(a));
						if (trackers.length === 0 && actions.length === 0) return null;
						return (
							<Group
								key={g.key}
								groupKey={g.key}
								groupName={g.name}
								trackers={trackers}
								actions={actions}
								client={client}
								onEditTracker={onEditTracker}
							/>
						);
					})
				}
			</div>
			<CalculatorModal open={metricOpen} onClose={closeMetric} client={client} editing={metricEdit} />
			<CorrelationModal open={correlationOpen} onClose={closeCorrelation} client={client} editing={correlationEdit} />
		</div>
	);
}

function Group(
	{ groupKey, groupName, trackers, actions, client, onEditTracker }:
		{ groupKey: string; groupName: string; trackers: TrackerMeta[]; actions: ActionMeta[]; client: SimClient; onEditTracker: (tracker: TrackerMeta) => void },
) {
	const { t } = useI18n();
	const collapsed = !!ui.value.collapsedGroups[groupKey];
	const toggle = () => toggleGroupCollapsed(groupKey);
	return (
		<div class={`gui-group${collapsed ? ' collapsed' : ''}`}>
			<div
				class="gui-group-header"
				onClick={toggle}
				role="button"
				aria-expanded={!collapsed}
				tabIndex={0}
				onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
				title={collapsed ? t('status.group_expand') : t('status.group_collapse')}
			>
				<span class="chev" aria-hidden="true" />
				<span>{groupName}</span>
			</div>
			{!collapsed && (
				<>
					{trackers.length > 0 && (
						<div class="gui-group-trackers">
							{trackers.map(tr => <TrackerRow key={tr.id} tracker={tr} client={client} onEdit={onEditTracker} />)}
						</div>
					)}
					{actions.length > 0 && (
						<div class="gui-group-actions">
							{actions.map(a => <ActionRow key={`${a.id}|${a.siteKey ?? ''}`} action={a} client={client} />)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
