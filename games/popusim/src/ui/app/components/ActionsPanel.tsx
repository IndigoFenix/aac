/**
 * ActionsPanel — player actions, grouped.
 *
 * Each row shows:
 *   - the action name + state badges (HIDDEN / DISABLED if applicable)
 *   - the current (locked-in) value and the desired (unsubmitted) value,
 *     where the desired value reflects the on-screen slider live
 *   - a slider/toggle/number input bound to `desired_value`. Sliders render
 *     the cost-capped portion in red so the player can see at a glance
 *     where their resources run out (they can still drag past it because
 *     resources may be available next day).
 *   - cost summary, with a warning when the desired value exceeds budget
 *
 * Hidden actions render only when `?showHidden` is set in the URL — useful
 * for scenario authors. By default hidden actions don't appear, supporting
 * the "secret action" pattern.
 *
 * `ActionRow` is exported so the unified `GroupedPanel` can reuse it.
 */

import {
	actionsByGroup, groupsMeta, snap, selectedSiteKey, ui, toggleGroupCollapsed,
	getEffectiveDesired, setLocalActionDesired, actionAllocations, actionMapKey,
	type ActionSliderGeometry,
} from '../state';
import { useI18n } from '../useI18n';
import type { ActionMeta, ActionSnapshot } from '../../../sim/protocol';
import type { SimClient } from '../../../sim/SimClient';

interface Props { client: SimClient }

export const showHiddenActions = typeof location !== 'undefined' && /[?&]showHidden\b/.test(location.search);

export function ActionsPanel({ client }: Props) {
	const { t } = useI18n();
	const grouped = actionsByGroup.value;
	const groups = groupsMeta.value;
	const totalActions = Array.from(grouped.values()).reduce((a, arr) => a + arr.length, 0);
	const ordered = [
		...groups,
		...(grouped.has(null) ? [{ key: '', name: t('groups.ungrouped'), parentKey: null, order: 9999 }] : []),
	];

	if (totalActions === 0) {
		return (
			<div class="panel">
				<div class="panel-header">{t('actions.panel_title')}</div>
				<div class="panel-body" style="color: var(--fg-muted)">{t('actions.none_yet')}</div>
			</div>
		);
	}
	return (
		<div class="panel">
			<div class="panel-header">{t('actions.panel_title')}</div>
			<div class="panel-body">
				{ordered.map(g => {
					const arr = (grouped.get(g.key === '' ? null : g.key) ?? [])
						.filter(a => isVisibleForCurrentSite(a))
						.filter(a => showHiddenActions || !isHidden(a));
					if (arr.length === 0) return null;
					return <Group key={g.key} groupKey={g.key} groupName={g.name} actions={arr} client={client} />;
				})}
			</div>
		</div>
	);
}

export function isVisibleForCurrentSite(action: ActionMeta): boolean {
	if (action.siteKey === null) return true;
	if (ui.value.view === 'world') return false;
	return action.siteKey === selectedSiteKey.value;
}

export function isHidden(action: ActionMeta): boolean {
	const sn = snapshotForAction(action);
	return sn?.hidden === true;
}

export function snapshotForAction(action: ActionMeta): ActionSnapshot | undefined {
	const arr = snap.value?.actions ?? [];
	return arr.find(a => a.id === action.id && a.siteKey === action.siteKey);
}

function Group(
	{ groupKey, groupName, actions, client }:
		{ groupKey: string; groupName: string; actions: ActionMeta[]; client: SimClient },
) {
	const { t } = useI18n();
	const collapsed = !!ui.value.collapsedGroups[`actions-${groupKey}`];
	const toggle = () => toggleGroupCollapsed(`actions-${groupKey}`);
	return (
		<div class={`gui-group${collapsed ? ' collapsed' : ''}`}>
			<div
				class="gui-group-header"
				onClick={toggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
				title={collapsed ? t('status.group_expand') : t('status.group_collapse')}
			>
				<span class="chev" aria-hidden="true" />
				<span>{groupName}</span>
			</div>
			{!collapsed && actions.map(a => <ActionRow key={`${a.id}|${a.siteKey ?? ''}`} action={a} client={client} />)}
		</div>
	);
}

export function ActionRow({ action, client }: { action: ActionMeta; client: SimClient }) {
	const { t } = useI18n();
	const sn = snapshotForAction(action);
	const current = sn?.currentValue ?? 0;
	const hidden = !!sn?.hidden;
	const disabled = !!sn?.disabled;

	// `desired` reads from the global localActionDesired signal (or the
	// snapshot fallback when the player hasn't touched the slider yet).
	// Reading `getEffectiveDesired` subscribes the row to slider changes on
	// _any_ action, so when a peer slider moves the cap recomputation
	// triggers our re-render too.
	const desired = getEffectiveDesired(action);
	const allocations = actionAllocations.value;
	const geom = allocations.get(actionMapKey(action.id, action.siteKey));

	const onChange = (v: number) => {
		setLocalActionDesired(action.id, action.siteKey, v);
		client.setActionDesired(action.id, action.siteKey, v);
	};

	return (
		<div class={`action-row${disabled ? ' disabled' : ''}${hidden && !showHiddenActions ? ' hidden' : ''}`}>
			<div class="action-header">
				<span>{action.name}</span>
				{hidden && <span class="badge">{t('actions.hidden_label')}</span>}
				{disabled && <span class="badge warn">{t('actions.disabled_label')}</span>}
			</div>
			{disabled && sn?.disabledReason
				? <div class="action-cost warn">{t('actions.disabled_reason', { reason: sn.disabledReason })}</div>
				: null}
			<div class="action-values">
				<span class="current">{t('actions.current_value', { value: formatVal(current) })}</span>
				<span class="desired">{t('actions.desired_value', { value: formatVal(desired) })}</span>
			</div>
			<ActionControl
				action={action}
				value={desired}
				disabled={disabled}
				geom={geom}
				onChange={onChange}
			/>
			<ActionCost action={action} />
			<ActionProduce action={action} />
		</div>
	);
}

function ActionProduce({ action }: { action: ActionMeta }) {
	const { t } = useI18n();
	if (!action.produceSummary) return null;
	return <div class="action-cost">{t('actions.produce.payout', { summary: action.produceSummary })}</div>;
}

function ActionControl(
	{ action, value, disabled, geom, onChange }:
		{ action: ActionMeta; value: number; disabled: boolean; geom: ActionSliderGeometry | undefined; onChange: (v: number) => void },
) {
	const { t } = useI18n();
	if (action.type === 'toggle') {
		const isOn = value > 0;
		return (
			<div class="action-control">
				<button
					class={isOn ? 'primary' : ''}
					disabled={disabled}
					onClick={() => onChange(isOn ? 0 : 1)}
				>{isOn ? t('actions.toggle_on') : t('actions.toggle_off')}</button>
			</div>
		);
	}
	if (action.type === 'number') {
		return (
			<div class="action-control">
				<input
					type="number"
					min={action.min}
					max={action.max}
					step={action.step}
					value={value}
					disabled={disabled}
					onInput={(e) => {
						const v = parseFloat((e.currentTarget as HTMLInputElement).value);
						if (!Number.isNaN(v)) onChange(v);
					}}
				/>
			</div>
		);
	}
	// Four-band slider, modelled on the legacy CustomScrollbar (script.js
	// 5553+) — the track is composed from absolutely-positioned underlays
	// so each segment has its own color rather than relying on a gradient
	// on the native track:
	//   * gray underlay (0 → 100): always present, lowest layer
	//   * red zone (cap → 100): where the player can't fully afford
	//   * blue filled (0 → min(value, cap)): the affordable selection
	//   * shortfall (cap → alloc): only when the knob is past the cap, shows
	//     how much of the over-asked amount the proportional split would
	//     actually deliver
	// The native <input type="range"> sits on top with a transparent track,
	// so the thumb stays draggable and accessible.
	const capPct = geom?.capPct ?? 100;
	const valPct = geom?.valPct ?? 0;
	const allocPct = geom?.allocPct ?? valPct;
	const blueWidth = Math.min(valPct, capPct);
	const overCap = valPct > capPct;
	const shortfallLeft = capPct;
	const shortfallWidth = overCap ? Math.max(0, Math.min(allocPct, valPct) - capPct) : 0;
	return (
		<div class="action-control">
			<div class="action-slider-track">
				<div class="action-slider-band action-slider-gray" />
				<div class="action-slider-band action-slider-red" style={`left: ${capPct}%; width: ${100 - capPct}%`} />
				{shortfallWidth > 0 && (
					<div class="action-slider-band action-slider-shortfall" style={`left: ${shortfallLeft}%; width: ${shortfallWidth}%`} />
				)}
				<div class="action-slider-band action-slider-blue" style={`width: ${blueWidth}%`} />
				<input
					type="range"
					class="action-slider"
					min={action.min}
					max={action.max}
					step={action.step}
					value={value}
					disabled={disabled}
					onInput={(e) => onChange(parseFloat((e.currentTarget as HTMLInputElement).value))}
				/>
			</div>
			<input
				type="number"
				min={action.min}
				max={action.max}
				step={action.step}
				value={value}
				disabled={disabled}
				style="width: 5rem"
				onInput={(e) => {
					const v = parseFloat((e.currentTarget as HTMLInputElement).value);
					if (!Number.isNaN(v)) onChange(v);
				}}
			/>
		</div>
	);
}

function ActionCost({ action }: { action: ActionMeta }) {
	const { t } = useI18n();
	if (!action.costSummary) {
		return <div class="action-cost">{t('actions.cost.none')}</div>;
	}
	// Note: we used to flip this row into a "can't afford" warning when the
	// player's slider exceeded the cost cap. In the phase-aware cost model
	// that's misleading — the action still runs, just at a reduced
	// current_value. The slider's red band already conveys the same idea
	// visually, so this row stays as a plain summary.
	return <div class="action-cost">{t('actions.cost.payout', { summary: action.costSummary })}</div>;
}

export function formatVal(v: number): string {
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(2);
}
