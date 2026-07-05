/**
 * GraphPanel — canvas-rendered series view with full pan/zoom/scroll behavior.
 *
 * Interaction (mirrors the legacy graph):
 *   - Click + drag horizontally to pan through history. Pointer Events power
 *     this so mouse, touch, and pen all work uniformly. Pinch-zoom on touch
 *     is intentionally not implemented yet — wheel zoom is the primary
 *     zoom path; touch users get the horizontal slider + range input.
 *   - When the user pans to the right edge, the view "sticks" — subsequent
 *     simulation days auto-scroll the view forward so the latest day stays
 *     visible. Panning backward unsticks.
 *   - Mouse wheel widens / narrows the visible day range (horizontal zoom),
 *     centered on the cursor's current day so the day under the pointer
 *     stays put.
 *   - The vertical slider next to the canvas zooms the y-axis logarithmically:
 *     0 = full data range, 1 = zoomed all the way down to the [0, 100] band
 *     so small details near the floor are readable.
 *   - The horizontal scrollbar lets touch / accessibility users pan without
 *     dragging.
 *
 * Math (lifted from the legacy `Graph` class):
 *   - Linear y when the data max is ≤ 100, otherwise log scaled (legacy
 *     `convertToLog` at script.js:4620). Vertical zoom slides the visible
 *     top between [100, max] geometrically.
 *
 * Render is signal-driven: reads `historyVersion`, `snap`, `ui` so that any
 * relevant change re-runs the effect that paints the canvas.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { computed } from '@preact/signals';
import {
	snap, ui, updateUi, trackersMeta, getSeries, isSeriesHidden,
	historyVersion, selectedSiteKey, toggleSeries, bootstrap, lookupSiteKey,
} from '../state';
import { useI18n } from '../useI18n';
import type { TrackerMeta } from '../../../sim/protocol';
import { formatDayShort } from '../dateFormat';

const bootstrapMetaSitesRef = computed(() => bootstrap.value?.sites ?? []);

const MIN_RANGE = 5;
const WHEEL_FACTOR = 1.15;

interface DragState {
	pointerId: number;
	originPanDay: number;
	originX: number;
	pixelsPerDay: number;
}

export function GraphPanel() {
	const { t } = useI18n();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	// Live graph view state — local because it's high-frequency and we don't
	// want it persisted across sessions or shared with other panels.
	const [panDay, setPanDay] = useState(0);
	const [range, setRange] = useState(ui.value.graphRangeDays);
	const [atEnd, setAtEnd] = useState(true);
	const [vScroll, setVScroll] = useState(0);
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<DragState | null>(null);

	// Subscribe to signals; the values themselves are read inside the render
	// effect.
	const age = snap.value?.age ?? 0;
	void historyVersion.value;
	const log = ui.value.graphLogScale;

	// Auto-follow when sticky. Run before paint so the canvas pulls the
	// up-to-date panDay.
	useEffect(() => {
		if (atEnd) {
			const target = Math.max(0, age - range);
			if (target !== panDay) setPanDay(target);
		}
	}, [atEnd, age, range, panDay]);

	// Pointer-driven pan. setPointerCapture means we keep getting events
	// even when the pointer leaves the canvas — important for fast drags.
	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		const c = canvasRef.current;
		if (!c) return;
		const rect = c.getBoundingClientRect();
		const pixelsPerDay = rect.width / Math.max(1, range);
		dragRef.current = {
			pointerId: e.pointerId,
			originPanDay: panDay,
			originX: e.clientX,
			pixelsPerDay,
		};
		c.setPointerCapture(e.pointerId);
		setIsDragging(true);
		// Drag immediately unsticks so the user can pan past today.
		setAtEnd(false);
	};

	const onPointerMove = (e: PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		const dx = e.clientX - drag.originX;
		// Drag-to-the-right scrolls history into view (panDay decreases).
		let next = drag.originPanDay - dx / drag.pixelsPerDay;
		const maxPan = Math.max(0, age - range);
		if (next < 0) next = 0;
		if (next > maxPan) next = maxPan;
		setPanDay(next);
	};

	const endDrag = (e: PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		const c = canvasRef.current;
		if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
		dragRef.current = null;
		setIsDragging(false);
		// Re-stick if we ended at the rightmost position.
		const maxPan = Math.max(0, age - range);
		if (panDay >= maxPan - 0.5) setAtEnd(true);
	};

	// Wheel zoom — non-passive so we can preventDefault and stop the page
	// from scrolling.
	useEffect(() => {
		const node = containerRef.current;
		if (!node) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const c = canvasRef.current;
			if (!c) return;
			const rect = c.getBoundingClientRect();
			const cursorX = e.clientX - rect.left;
			const cursorFrac = Math.max(0, Math.min(1, cursorX / rect.width));
			const factor = e.deltaY > 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
			const maxRange = Math.max(MIN_RANGE * 2, age * 4 || 1000);
			const newRange = Math.max(MIN_RANGE, Math.min(maxRange, range * factor));
			// Pivot zoom around the cursor so the day under the pointer stays
			// at the same screen x.
			const cursorDay = panDay + cursorFrac * range;
			let newPan = cursorDay - cursorFrac * newRange;
			const maxPan = Math.max(0, age - newRange);
			if (newPan < 0) newPan = 0;
			if (newPan > maxPan) newPan = maxPan;
			setRange(newRange);
			setPanDay(newPan);
			updateUi({ graphRangeDays: Math.round(newRange) });
			// Wheel inherently breaks stickiness unless we land exactly at end.
			setAtEnd(newPan >= maxPan - 0.5);
		};
		node.addEventListener('wheel', onWheel, { passive: false });
		return () => node.removeEventListener('wheel', onWheel);
	}, [age, panDay, range]);

	// React to external range changes (e.g. typing in the range input).
	useEffect(() => {
		if (ui.value.graphRangeDays !== range) {
			const next = Math.max(MIN_RANGE, ui.value.graphRangeDays);
			setRange(next);
			if (atEnd) setPanDay(Math.max(0, age - next));
		}
	}, [ui.value.graphRangeDays]);

	// Canvas paint — runs after every render.
	useEffect(() => {
		const cv = canvasRef.current;
		const wrap = canvasRef.current?.parentElement as HTMLElement | null;
		if (!cv || !wrap) return;
		const dpr = window.devicePixelRatio || 1;
		const w = wrap.offsetWidth;
		const h = wrap.offsetHeight;
		cv.width = Math.max(1, Math.floor(w * dpr));
		cv.height = Math.max(1, Math.floor(h * dpr));
		const ctx = cv.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		paint(ctx, w, h, panDay, range, vScroll, log);
	});

	const onSliderChange = useCallback((next: number) => {
		const maxPan = Math.max(0, age - range);
		const clamped = Math.max(0, Math.min(maxPan, next));
		setPanDay(clamped);
		setAtEnd(clamped >= maxPan - 0.5);
	}, [age, range]);

	const trackers = trackersMeta.value;
	const maxPan = Math.max(0, age - range);

	return (
		<div class="graph-panel" aria-label={t('controls.mode_graph')}>
			<div class="graph-controls">
				<button onClick={() => updateUi({ graphLogScale: !ui.value.graphLogScale })}>
					{ui.value.graphLogScale ? t('graph.linear') : t('graph.log')}
				</button>
				<label>
					{t('graph.range')}:{' '}
					<input
						type="number"
						min={MIN_RANGE}
						max={50000}
						step={5}
						value={Math.round(range)}
						onInput={(e) => {
							const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
							if (!Number.isNaN(v) && v >= MIN_RANGE) {
								setRange(v);
								updateUi({ graphRangeDays: v });
								if (atEnd) setPanDay(Math.max(0, age - v));
							}
						}}
					/>
				</label>
			</div>
			<div class="graph-main">
				<div
					class={`graph-canvas-container${isDragging ? ' dragging' : ''}`}
					ref={containerRef}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				>
					<canvas ref={canvasRef} />
					{age === 0 ? (
						<div class="graph-empty">{t('graph.no_data')}</div>
					) : null}
				</div>
				<div class="graph-vslider" title={t('graph.zoom_in')}>
					{/* Top = zoomed out (full population in view); bottom = zoomed in. */}
					<span class="label" aria-hidden="true">−</span>
					<input
						type="range"
						min={0}
						max={1}
						step={0.01}
						value={vScroll}
						onInput={(e) => setVScroll(parseFloat((e.currentTarget as HTMLInputElement).value))}
						aria-label={t('graph.log_toggle_label')}
					/>
					<span class="label" aria-hidden="true">+</span>
				</div>
			</div>
			<div class="graph-hscroll">
				<input
					type="range"
					min={0}
					max={Math.max(maxPan, 0)}
					step={1}
					value={Math.min(panDay, maxPan)}
					onInput={(e) => onSliderChange(parseFloat((e.currentTarget as HTMLInputElement).value))}
					aria-label={t('graph.range')}
					disabled={maxPan === 0}
				/>
				<span class="day-readout">
					{Math.round(panDay)}–{Math.round(panDay + range)} / {age}
				</span>
				<button
					class={`at-end${atEnd ? ' sticky' : ''}`}
					onClick={() => {
						const next = !atEnd;
						setAtEnd(next);
						if (next) setPanDay(Math.max(0, age - range));
					}}
					title={t('graph.follow')}
					aria-pressed={atEnd}
				>{atEnd ? '↘' : '↘?'}</button>
			</div>
			<div class="graph-legend" role="group" aria-label={t('graph.legend_title')}>
				{trackers.map(tr => <LegendChip tracker={tr} key={tr.id} />)}
			</div>
		</div>
	);
}

/* ----------------------------- canvas paint ----------------------------- */

function paint(
	ctx: CanvasRenderingContext2D,
	w: number, h: number,
	panDay: number, range: number, vScroll: number, log: boolean,
) {
	ctx.clearRect(0, 0, w, h);
	const age = snap.value?.age ?? 0;
	if (age === 0) return;

	const trackers = trackersMeta.value;
	const visibleStart = panDay;
	const visibleEnd = panDay + range;
	const dayWidth = w / Math.max(1, range);

	// Y-axis ceiling = the population of the focused scope. In site view that's
	// the selected site's current population; in world view it's the sum across
	// all sites. This keeps trackers comparable and prevents a small spike from
	// rescaling the whole graph. The vertical zoom slider lets the player
	// zoom in below this ceiling.
	const popCap = currentPopCap();

	// vScroll 0 = full population range visible; 1 = zoomed down to ~100 so
	// the floor band is readable. Geometric interpolation handles huge ranges.
	let viewTop = popCap;
	if (popCap > 100) {
		viewTop = popCap * Math.pow(100 / popCap, vScroll);
	}

	// Y-axis grid + labels — power-of-ten ruling (mirrors legacy drawRules).
	ctx.font = '10px ' + getCssVar('--font-mono', 'monospace');
	drawPowerOfTenGrid(ctx, w, h, viewTop, log);

	// X-axis day ticks (sparse so they don't overcrowd). Labels switch to
	// calendar dates when the scenario uses them.
	const tickEvery = niceStep(range);
	const firstTick = Math.ceil(visibleStart / tickEvery) * tickEvery;
	const boot = bootstrap.value;
	const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en';
	for (let day = firstTick; day < visibleEnd; day += tickEvery) {
		const x = (day - visibleStart) * dayWidth;
		ctx.strokeStyle = 'rgba(255,255,255,0.06)';
		ctx.beginPath();
		ctx.moveTo(x, 0); ctx.lineTo(x, h);
		ctx.stroke();
		ctx.fillStyle = 'rgba(216,224,236,0.55)';
		const label = boot?.useDate && boot.startDate
			? formatDayShort({ bootstrap: boot, day, locale })
			: String(day);
		ctx.fillText(label, x + 2, h - 2);
	}

	// "Today" line.
	if (age >= visibleStart && age <= visibleEnd) {
		const x = (age - visibleStart) * dayWidth;
		ctx.strokeStyle = 'rgba(108,184,255,0.4)';
		ctx.beginPath();
		ctx.moveTo(x, 0); ctx.lineTo(x, h);
		ctx.stroke();
	}

	// Lines.
	for (const tr of trackers) {
		const sk = lookupSiteKey(tr.global);
		if (isSeriesHidden(tr.id, sk)) continue;
		const series = getSeries(tr.id, sk);
		if (!series || series.values.length === 0) continue;
		ctx.strokeStyle = tr.color;
		ctx.lineWidth = 2;
		ctx.beginPath();
		let started = false;
		for (let i = 0; i < series.values.length; i++) {
			const day = series.startDay + i;
			if (day < visibleStart - 1) continue;
			if (day > visibleEnd + 1) break;
			const v = series.values[i];
			const x = (day - visibleStart) * dayWidth;
			const yNorm = log ? logToYNorm(v, viewTop) : Math.min(1, Math.max(0, v / viewTop));
			const y = h - yNorm * h;
			if (!started) { ctx.moveTo(x, y); started = true; }
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
}

function LegendChip({ tracker }: { tracker: TrackerMeta }) {
	const sk = lookupSiteKey(tracker.global);
	const hidden = isSeriesHidden(tracker.id, sk);
	return (
		<button
			class={`legend-chip${hidden ? ' hidden' : ''}`}
			onClick={() => toggleSeries(tracker.id, sk)}
			aria-pressed={!hidden}
		>
			<span class="swatch" style={`background: ${tracker.color}`} />
			<span>{tracker.name}</span>
		</button>
	);
}

/**
 * Y-axis grid in the legacy "powers-of-ten" style with smooth fade-in/out.
 *
 * The rule, per level of step S = 10^k:
 *   - viewTop ≤ 20·S        → lines at full opacity, with labels
 *   - 20·S < viewTop < 100·S → labels gone, lines fading from 1 → 0
 *   - viewTop ≥ 100·S        → level fully hidden
 *
 * Concretely:
 *   - viewTop=100: per-10 lines + labels (10 visible labels)
 *   - viewTop=200: per-10 lines + labels still, just barely (20 labels)
 *   - viewTop=500: per-10 lines fading, no labels; per-100 lines + labels
 *   - viewTop=1000: per-10 lines gone; per-100 lines + labels
 *   - viewTop=2000: per-100 lines + labels still (20 labels), per-1000 too
 *
 * Lines and labels at the *same* y-position are de-duped: each position is
 * drawn once at the coarsest level's alpha, and labeled only once. So
 * coarser decades visually dominate (high alpha) and finer levels fill the
 * gaps with their own (often lower) alpha.
 *
 * Log axis: same lineAlpha rule applied to (decades, 9×decades) for the
 * 2×–9× minor lines; major decade boundaries are always full opacity since
 * they're never crowded.
 */
function drawPowerOfTenGrid(
	ctx: CanvasRenderingContext2D,
	w: number, h: number,
	viewTop: number,
	log: boolean,
) {
	if (viewTop <= 0) return;

	// Per-line opacity ceiling. Even "full" gridlines stay subtle against
	// the bg; labels get a bit more contrast so numbers remain readable as
	// they fade toward the threshold.
	const LINE_OPACITY_CEILING = 0.18;
	const LABEL_OPACITY_CEILING = 0.6;

	const drawHLine = (yNorm: number, alpha: number, label?: string) => {
		if (yNorm < -0.001 || yNorm > 1.001) return;
		const y = h - yNorm * h;
		ctx.globalAlpha = alpha * LINE_OPACITY_CEILING;
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(w, y);
		ctx.stroke();
		if (label !== undefined) {
			ctx.globalAlpha = alpha * LABEL_OPACITY_CEILING;
			ctx.fillStyle = '#d8e0ec';
			ctx.fillText(label, 4, y - 2);
		}
	};

	if (log) {
		const topDecade = Math.floor(Math.log10(viewTop));
		const decadesVisible = topDecade + 1;

		// Major decade boundaries — always visible, always labeled.
		for (let p = 0; p <= topDecade; p++) {
			const v = Math.pow(10, p);
			drawHLine(logToYNorm(v, viewTop), 1, formatNum(v));
		}
		// And the (un-clean) viewTop itself, if it's not exactly a decade.
		if (Math.log10(viewTop) - topDecade > 0.001) {
			drawHLine(1, 1, formatNum(viewTop));
		}

		// 2×..9× minor lines per decade. Use the same line-count rule:
		// 9 × decades minor lines total → fade as decades climb past ~2.
		const minorAlpha = lineCountAlpha(9 * decadesVisible);
		if (minorAlpha > 0.001) {
			for (let p = 0; p <= topDecade; p++) {
				const decadeBase = Math.pow(10, p);
				for (let mult = 2; mult <= 9; mult++) {
					const v = mult * decadeBase;
					if (v > viewTop) break;
					drawHLine(logToYNorm(v, viewTop), minorAlpha);
				}
			}
		}
		ctx.globalAlpha = 1;
		return;
	}

	// Linear axis. Walk every power-of-ten level from coarsest (count = 1)
	// down to the finest still-visible one. De-dupe drawn positions so
	// coarser levels claim shared ones first (with their higher alpha).
	const log10vt = Math.log10(viewTop);
	const kMax = Math.floor(log10vt);
	// alpha > 0 requires count < 100, i.e. step > viewTop/100, i.e.
	// k > log10(viewTop) - 2.
	const kMin = Math.floor(log10vt - 2) + 1;

	const drawnAt = new Set<string>();

	for (let k = kMax; k >= kMin; k--) {
		const step = Math.pow(10, k);
		if (step <= 0 || !isFinite(step)) continue;
		const count = viewTop / step;
		const alpha = lineCountAlpha(count);
		if (alpha <= 0) continue;
		const showNumbers = count <= 20;
		const lineCount = Math.floor(viewTop / step + 1e-9) + 1;

		for (let i = 0; i < lineCount; i++) {
			const v = i * step;
			if (v > viewTop + step * 0.5) break;
			const key = v.toFixed(10);
			if (drawnAt.has(key)) continue;
			drawnAt.add(key);
			drawHLine(v / viewTop, alpha, showNumbers ? formatNum(v) : undefined);
		}
	}
	ctx.globalAlpha = 1;
}

/**
 * Line/label opacity as a function of how many lines a level would draw.
 *
 *   count ≤ 20   → 1   (fully visible, labels shown)
 *   count = 100  → 0   (fully hidden)
 *   in between   → linear fade, labels off
 *
 * Tuning here controls how quickly a level transitions out as the user
 * zooms out past its useful density. The 20/100 thresholds come straight
 * from the spec — at viewTop = 20·step the level is the primary, at
 * 100·step it's gone.
 */
export function lineCountAlpha(count: number): number {
	if (count <= 20) return 1;
	if (count >= 100) return 0;
	return (100 - count) / 80;
}

/** Population ceiling for the y-axis. Site view → selected site's current
 * pop; world view → sum across sites. Falls back to the bootstrap totals
 * when the live snapshot hasn't arrived yet, and finally to 100 so the
 * graph still draws a sensible empty grid. */
function currentPopCap(): number {
	const s = snap.value;
	const sites = s?.sites;
	if (sites && sites.length > 0) {
		if (ui.value.view === 'world' || sites.length === 1) {
			let total = 0;
			for (const site of sites) total += site.pop;
			if (total > 0) return total;
		} else {
			const sel = selectedSiteKey.value;
			const site = sel ? sites.find(x => x.key === sel) : sites[0];
			if (site && site.pop > 0) return site.pop;
		}
	}
	// Fallback to bootstrap totals.
	const meta = bootstrapSites();
	if (meta.length > 0) {
		if (ui.value.view === 'world' || meta.length === 1) {
			let total = 0;
			for (const m of meta) total += m.totalPop;
			if (total > 0) return total;
		} else {
			const sel = selectedSiteKey.value;
			const m = sel ? meta.find(x => x.key === sel) : meta[0];
			if (m && m.totalPop > 0) return m.totalPop;
		}
	}
	return 100;
}

function bootstrapSites() {
	return bootstrapMetaSitesRef.value;
}

/* ----------------------------- math helpers ---------------------------- */

function logToYNorm(v: number, top: number): number {
	if (top <= 0) return 0;
	if (v <= 0) return 0;
	if (top <= 100) return Math.min(1, v / top);
	const lnLo = Math.log(1), lnHi = Math.log(top);
	const lv = Math.log(Math.max(1, v));
	return Math.min(1, (lv - lnLo) / (lnHi - lnLo));
}

function formatNum(v: number): string {
	if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	return v.toFixed(0);
}

function niceStep(range: number): number {
	if (range <= 20) return 1;
	if (range <= 50) return 5;
	if (range <= 200) return 10;
	if (range <= 500) return 50;
	if (range <= 2000) return 100;
	if (range <= 10000) return 500;
	return Math.pow(10, Math.floor(Math.log10(range)) - 1) * 5;
}

function getCssVar(name: string, fallback: string): string {
	if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
	const v = getComputedStyle(document.documentElement).getPropertyValue(name);
	return v?.trim() || fallback;
}
