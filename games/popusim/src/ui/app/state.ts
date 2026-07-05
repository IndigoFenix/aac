/**
 * Global UI state, expressed as @preact/signals.
 *
 * Three signal trees:
 *   1. `snap` / `bootstrap` — what the worker last told us.
 *   2. `ui` — the player's UI choices (selected site, panel collapse, language,
 *      direction, graph zoom). Persisted to localStorage.
 *   3. `history` — accumulated per-tracker series rebuilt from snapshot deltas.
 *      A regular Map (not a signal-keyed map) wrapped behind a version signal,
 *      because the canvas reads it imperatively per render.
 *
 * Everything else is derived via `computed` from these.
 */

import { signal, computed, batch } from '@preact/signals';
import type { Snapshot, Bootstrap, NewsSnapshot, HistoryDeltaSnapshot, TrackerMeta } from '../../sim/protocol';
import type { Locale, Direction } from './i18n';
import { DEFAULT_LOCALE, dirForLocale } from './i18n';

/** Named speeds; numbers are wall-clock ms per simulated day. `max` runs
 * the worker as fast as it can. The mapping lives in `SPEED_TABLE`. */
export type SpeedKey = 'paused' | '1x' | '2x' | '4x' | 'max';

export const SPEED_TABLE: Record<SpeedKey, { msPerDay: number; snapshotEveryDays: number; label: string }> = {
	paused: { msPerDay: -1, snapshotEveryDays: 1, label: '⏸' },
	'1x':   { msPerDay: 1000, snapshotEveryDays: 1, label: '▶' },
	'2x':   { msPerDay: 500, snapshotEveryDays: 1, label: '▶▶' },
	'4x':   { msPerDay: 250, snapshotEveryDays: 1, label: '▶▶▶' },
	max:    { msPerDay: 0, snapshotEveryDays: 5, label: '⏩' },
};

/* ---------------------------------- Signals --------------------------------- */

export const bootstrap = signal<Bootstrap | null>(null);
export const snap = signal<Snapshot | null>(null);

export interface UiState {
	mode: 'gameplay' | 'editor';
	view: 'site' | 'world';
	selectedSiteKey: string | null;
	collapsedGroups: Record<string, boolean>;
	hiddenSeries: Record<string, boolean>;
	graphLogScale: boolean;
	graphRangeDays: number;
	language: Locale;
	dir: Direction;
	speed: SpeedKey;
	debugView: boolean;
	gpuPreference: 'auto' | 'cpu';
	reduceMotion: boolean;
	pseudoLocale: boolean;
}

const DEFAULT_UI: UiState = {
	mode: 'gameplay',
	view: 'site',
	selectedSiteKey: null,
	collapsedGroups: {},
	hiddenSeries: {},
	graphLogScale: false,
	graphRangeDays: 50,
	language: DEFAULT_LOCALE,
	dir: dirForLocale(DEFAULT_LOCALE),
	speed: 'paused',
	debugView: false,
	gpuPreference: 'auto',
	reduceMotion: false,
	pseudoLocale: false,
};

export const ui = signal<UiState>({ ...DEFAULT_UI, ...loadUi() });

/** Series-by-(trackerId, siteKey?) accumulator. Read imperatively from the
 * graph canvas. `historyVersion` ticks every time we mutate it so any
 * computed signal that depends on history can re-derive. */
export interface SeriesKey { trackerId: string; siteKey?: string }
export interface SeriesData { startDay: number; values: number[] }

const seriesMap = new Map<string, SeriesData>();
export const historyVersion = signal(0);

export function getSeries(trackerId: string, siteKey?: string): SeriesData | undefined {
	return seriesMap.get(seriesKeyFor(trackerId, siteKey));
}

export function clearSeries(): void {
	seriesMap.clear();
	historyVersion.value++;
}

function seriesKeyFor(trackerId: string, siteKey?: string): string {
	return `${trackerId}|${siteKey ?? ''}`;
}

/**
 * Pick the right siteKey for a tracker lookup based on the current view.
 *
 * - World view → use no siteKey, which hits the world-level history. For
 *   non-global trackers (traits, per-site resources/metrics) that history
 *   is the combined sum across sites; for global trackers it's the only
 *   history that exists.
 * - Site view → for non-global trackers, use the selected site (the
 *   per-site history). For global trackers there's no per-site history,
 *   so fall back to the world-level one.
 */
export function lookupSiteKey(trackerGlobal: boolean): string | undefined {
	if (ui.value.view === 'world') return undefined;
	if (trackerGlobal) return undefined;
	return selectedSiteKey.value ?? undefined;
}

/** Apply a HistoryDeltaSnapshot[] from a snapshot, growing the local series. */
export function applyHistoryDeltas(deltas: HistoryDeltaSnapshot[]): void {
	if (deltas.length === 0) return;
	for (const d of deltas) {
		const k = seriesKeyFor(d.trackerId, d.siteKey);
		const cur = seriesMap.get(k);
		if (!cur) {
			seriesMap.set(k, { startDay: d.startDay, values: d.values.slice() });
			continue;
		}
		const curEnd = cur.startDay + cur.values.length;
		if (d.startDay >= curEnd) {
			// Append; pad with zeros if there's a gap (shouldn't happen but cheap to handle).
			const gap = d.startDay - curEnd;
			for (let i = 0; i < gap; i++) cur.values.push(0);
			for (const v of d.values) cur.values.push(v);
		} else {
			// Overlap or rewind — replace from d.startDay onward.
			const overlapIdx = d.startDay - cur.startDay;
			cur.values = cur.values.slice(0, overlapIdx).concat(d.values);
		}
	}
	historyVersion.value++;
}

/* ----------------------------------- News ---------------------------------- */

export const newsBuffer = signal<NewsSnapshot[]>([]);
/** A news item the player must dismiss; null otherwise. */
export const activeModalNews = signal<NewsSnapshot | null>(null);

export function pushNews(items: NewsSnapshot[]): void {
	if (items.length === 0) return;
	const next = [...newsBuffer.value, ...items];
	const trimmed = next.length > 200 ? next.slice(next.length - 200) : next;
	newsBuffer.value = trimmed;
	if (!activeModalNews.value) {
		const auto = items.find(n => n.auto && n.body !== '');
		if (auto) activeModalNews.value = auto;
	}
}

export function dismissModalNews(): void {
	activeModalNews.value = null;
}

/* -------------------------------- Computed --------------------------------- */

export const sitesMeta = computed(() => bootstrap.value?.sites ?? []);
export const groupsMeta = computed(() => bootstrap.value?.guiGroups ?? []);
export const actionsMeta = computed(() => bootstrap.value?.actions ?? []);

/** Live set of tracker IDs currently hidden from the UI. Updated each
 * snapshot — both scenario-declared and event-toggled hides land here. */
export const hiddenTrackerSet = computed(() => {
	const ids = snap.value?.hiddenTrackerIds ?? [];
	return new Set(ids);
});

/** Live set of tracker IDs that should render grayed-out because at least one
 * of their dependencies is hidden. Player-side metrics/correlations only. */
export const grayedOutTrackerSet = computed(() => {
	const ids = snap.value?.grayedOutTrackerIds ?? [];
	return new Set(ids);
});

/** All trackers, with hidden ones filtered out. The graph, legend, and
 * status panel all read from this. */
export const trackersMeta = computed(() => {
	const all = bootstrap.value?.trackers ?? [];
	const hidden = hiddenTrackerSet.value;
	if (hidden.size === 0) return all;
	return all.filter(t => !hidden.has(t.id));
});

/** Map of tracker `id` (`${kind}:${key}`) to TrackerMeta. Includes hidden
 * trackers so callers like the formula renderer can resolve a referenced
 * trait/resource even when the user hid it from the legend. */
/* ----------------------- Local action desireds ----------------------- */

/**
 * Player-driven slider positions, indexed by `${actionId}|${siteKey ?? ''}`.
 * Lifted into a signal so `actionAllocations` (a computed) reacts to a
 * slider on action A changing the cap of action B that competes for the
 * same resource.
 *
 * The map is the sole source of truth for the slider's visible value.
 * `getEffectiveDesired` falls back to the snapshot's `desiredValue` when
 * the player hasn't touched the slider this session — so freshly-loaded
 * scenarios show the value that was persisted in the world.
 *
 * On a fresh `start` / `reset`, `resetSimState` clears the map.
 */
export const localActionDesired = signal<Map<string, number>>(new Map());

export function actionMapKey(actionId: string, siteKey: string | null): string {
	return `${actionId}|${siteKey ?? ''}`;
}

export function getEffectiveDesired(action: { id: string; siteKey: string | null }): number {
	const k = actionMapKey(action.id, action.siteKey);
	const local = localActionDesired.value.get(k);
	if (local !== undefined) return local;
	const arr = snap.value?.actions ?? [];
	const sn = arr.find(a => a.id === action.id && a.siteKey === action.siteKey);
	return sn?.desiredValue ?? 0;
}

export function setLocalActionDesired(actionId: string, siteKey: string | null, value: number): void {
	const k = actionMapKey(actionId, siteKey);
	const cur = localActionDesired.value.get(k);
	if (cur === value) return;
	const next = new Map(localActionDesired.value);
	next.set(k, value);
	localActionDesired.value = next;
}

/**
 * Per-action display geometry for the four-band slider, computed live from
 * (a) snapshot stockpile values at start-of-day, (b) every action's
 * effective desired value (incl. sliders the player is dragging), and
 * (c) the worker's per-cost metadata. All values are 0–100 percentages of
 * the slider's range.
 *
 *   capPct: where the red line sits — the highest integer count this
 *           action could afford if every other action took its full
 *           desired share. Below it the slider is fully affordable.
 *   valPct: the slider's knob position (clamped to the action's range).
 *   allocPct: when the knob is past the cap, this is what the simulation
 *           would actually award via the proportional split. Sits between
 *           capPct and valPct and is rendered as a fourth band so the
 *           player can see the shortfall.
 *
 * Resources flagged `signed` (allowed to go negative) impose no cap; the
 * action keeps its full requested amount and the slider has no red zone.
 */
export interface ActionSliderGeometry {
	capPct: number;
	valPct: number;
	allocPct: number;
}

export const stockpilesMeta = computed(() => bootstrap.value?.stockpiles ?? []);

export const actionAllocations = computed(() => {
	const out = new Map<string, ActionSliderGeometry>();
	const allActions = bootstrap.value?.actions ?? [];
	const sn = snap.value;
	if (!sn) return out;

	const stockpileValueById = new Map<string, number>();
	for (const sp of sn.stockpiles) stockpileValueById.set(sp.id, sp.value);

	const signedById = new Map<string, boolean>();
	for (const sp of stockpilesMeta.value) signedById.set(sp.id, !!sp.signed);

	// Group cost requests by (phaseIndex, stockpileId). Each entry carries
	// the action and its per-action demand on that stockpile so we can compute
	// total demand and proportional allocations.
	interface Req { actionKey: string; desired: number; cost: number }
	const groups = new Map<string, Map<string, Req[]>>();
	for (const action of allActions) {
		const desired = getEffectiveDesired(action);
		for (const c of action.costs) {
			if (c.value <= 0) continue;
			let perPhase = groups.get(String(c.phaseIndex));
			if (!perPhase) { perPhase = new Map(); groups.set(String(c.phaseIndex), perPhase); }
			let arr = perPhase.get(c.stockpileId);
			if (!arr) { arr = []; perPhase.set(c.stockpileId, arr); }
			arr.push({ actionKey: actionMapKey(action.id, action.siteKey), desired, cost: c.value });
		}
	}

	for (const action of allActions) {
		const desired = getEffectiveDesired(action);
		const range = action.max - action.min;
		const k = actionMapKey(action.id, action.siteKey);

		let cap = action.max;
		let alloc = desired;
		for (const c of action.costs) {
			if (c.value <= 0) continue;
			if (signedById.get(c.stockpileId)) continue;
			const stored = stockpileValueById.get(c.stockpileId) ?? 0;
			const perPhase = groups.get(String(c.phaseIndex));
			const peers = perPhase?.get(c.stockpileId) ?? [];
			let myDemand = 0;
			let totalDemand = 0;
			for (const r of peers) {
				totalDemand += r.desired * r.cost;
				if (r.actionKey === k) myDemand += r.desired * r.cost;
			}
			const otherDemand = totalDemand - myDemand;
			const availableToMe = Math.max(0, stored - otherDemand);
			const myCap = Math.floor(availableToMe / c.value);
			if (myCap < cap) cap = myCap;
			if (totalDemand > stored && totalDemand > 0) {
				const scale = stored / totalDemand;
				const myAlloc = Math.floor(desired * scale);
				if (myAlloc < alloc) alloc = myAlloc;
			}
		}
		const capPct = range > 0
			? Math.max(0, Math.min(100, (cap - action.min) / range * 100))
			: 100;
		const valPct = range > 0
			? Math.max(0, Math.min(100, (desired - action.min) / range * 100))
			: 0;
		const allocPct = range > 0
			? Math.max(0, Math.min(100, (alloc - action.min) / range * 100))
			: 0;
		out.set(k, { capPct, valPct, allocPct });
	}

	return out;
});

export const trackerById = computed(() => {
	const all = bootstrap.value?.trackers ?? [];
	const out = new Map<string, TrackerMeta>();
	for (const t of all) out.set(t.id, t);
	return out;
});

export function trackerByIdLookup(id: string): TrackerMeta | undefined {
	return trackerById.value.get(id);
}

export const selectedSiteKey = computed(() => {
	const s = ui.value.selectedSiteKey;
	if (s !== null) return s;
	return sitesMeta.value[0]?.key ?? null;
});

export const trackersByGroup = computed(() => {
	const out = new Map<string | null, typeof trackersMeta.value>();
	for (const t of trackersMeta.value) {
		const arr = out.get(t.groupKey) ?? [];
		arr.push(t);
		out.set(t.groupKey, arr);
	}
	return out;
});

export const actionsByGroup = computed(() => {
	const out = new Map<string | null, typeof actionsMeta.value>();
	for (const a of actionsMeta.value) {
		const arr = out.get(a.groupKey) ?? [];
		arr.push(a);
		out.set(a.groupKey, arr);
	}
	return out;
});

/* ------------------------------- Mutations --------------------------------- */

export function setSnapshot(s: Snapshot): void {
	batch(() => {
		applyHistoryDeltas(s.historyDelta);
		pushNews(s.news);
		// Apply tracker registry patches before storing snap so any subscribers
		// triggered by `snap.value = s` see the updated bootstrap.trackers.
		if (s.trackerPatch) applyTrackerPatch(s.trackerPatch);
		snap.value = s;
	});
}

function applyTrackerPatch(patch: { added: TrackerMeta[]; removedIds: string[] }): void {
	const cur = bootstrap.value;
	if (!cur) return;
	const removed = new Set(patch.removedIds);
	const filtered = cur.trackers.filter(t => !removed.has(t.id));
	// Drop any series for removed trackers so the graph forgets them.
	for (const id of patch.removedIds) {
		for (const k of Array.from(seriesMap.keys())) {
			if (k === id || k.startsWith(id + '|')) seriesMap.delete(k);
		}
	}
	historyVersion.value++;
	bootstrap.value = { ...cur, trackers: [...filtered, ...patch.added] };
}

export function setBootstrap(b: Bootstrap): void {
	// Don't clear series here — that races with the snapshot's history
	// deltas if the App subscribes after the worker has already posted
	// `started` (subscribe replays `latest`, then onBootstrap replays
	// here, and a clear at this point would wipe the just-applied
	// initial deltas). Wholesale resets clear via `resetSimState`
	// instead, which is the only place that needs to drop history.
	bootstrap.value = b;
	updateUi({
		selectedSiteKey: ui.value.selectedSiteKey ?? b.sites[0]?.key ?? null,
	});
}

export function updateUi(patch: Partial<UiState>): void {
	const next = { ...ui.value, ...patch };
	if (patch.language && !patch.dir) next.dir = dirForLocale(patch.language);
	ui.value = next;
	persistUi(next);
}

export function toggleSeries(trackerId: string, siteKey?: string): void {
	const key = seriesKeyFor(trackerId, siteKey);
	const cur = ui.value.hiddenSeries;
	updateUi({ hiddenSeries: { ...cur, [key]: !cur[key] } });
}

export function isSeriesHidden(trackerId: string, siteKey?: string): boolean {
	return !!ui.value.hiddenSeries[seriesKeyFor(trackerId, siteKey)];
}

export function toggleGroupCollapsed(groupKey: string): void {
	const cur = ui.value.collapsedGroups;
	updateUi({ collapsedGroups: { ...cur, [groupKey]: !cur[groupKey] } });
}

/* ----------------------------- Persistence -------------------------------- */

const STORAGE_KEY = 'pathogenic.ui.v1';

function loadUi(): Partial<UiState> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function persistUi(state: UiState): void {
	if (typeof localStorage === 'undefined') return;
	try {
		// Don't persist transient UI state — always boot paused, in
		// gameplay mode, with the news feed (not debug) showing.
		const { speed: _s, mode: _m, debugView: _d, ...rest } = state;
		void _s; void _m; void _d;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
	} catch {
		// Quota or disabled — silently drop.
	}
}

/** Reset for the Reset button — keep persisted prefs (language, dir, log,
 * collapsed groups) but drop everything tied to the running scenario. */
export function resetSimState(): void {
	bootstrap.value = null;
	snap.value = null;
	clearSeries();
	newsBuffer.value = [];
	activeModalNews.value = null;
	localActionDesired.value = new Map();
	updateUi({ speed: 'paused', selectedSiteKey: null });
}
