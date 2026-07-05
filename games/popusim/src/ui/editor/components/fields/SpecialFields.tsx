/**
 * Specialized fields: color, point, image, sound, expression.
 *
 * v1 versions: ColorField uses the native color picker plus a numeric alpha
 * slider, serialized "r,g,b,a" to match the legacy format. Point is two
 * number inputs. Image/Sound are plain string paths. Expression is a
 * scrollable JSON view + token-list mini-editor (delegates to ObjectList
 * via the ChildrenField path; this component is only the leaf).
 */

import { useMemo } from 'preact/hooks';
import { FieldShell, useDraftValue, applyEdit, genId } from './common';
import type { ColorField, PointField, ImageField, SoundField, ExpressionField } from '../../schema';
import type { Path } from '../../state';

/* ------------------------------ color --------------------------------- */

function parseColor(v: unknown): { r: number; g: number; b: number; a: number } {
	if (typeof v !== 'string' || v.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
	const parts = v.split(',').map(s => Number(s.trim()));
	const [r, g, b, a] = parts;
	return {
		r: Number.isFinite(r) ? clamp(r, 0, 255) : 0,
		g: Number.isFinite(g) ? clamp(g, 0, 255) : 0,
		b: Number.isFinite(b) ? clamp(b, 0, 255) : 0,
		a: Number.isFinite(a) ? clamp(a, 0, 1) : 1,
	};
}

function colorToHex(r: number, g: number, b: number): string {
	return '#' + [r, g, b].map(n => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
	if (!m) return { r: 0, g: 0, b: 0 };
	return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

export function ColorFieldRenderer({ field, path }: { field: ColorField; path: Path }) {
	const idHex = useMemo(() => genId('color-hex'), []);
	const raw = useDraftValue([...path, field.key]);
	const c = parseColor(raw);
	const hex = colorToHex(c.r, c.g, c.b);
	function commit(next: { r: number; g: number; b: number; a: number }) {
		applyEdit([...path, field.key], `${Math.round(next.r)},${Math.round(next.g)},${Math.round(next.b)},${next.a}`);
	}
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={idHex}>
			<div class="editor-color">
				<input
					id={idHex}
					type="color"
					value={hex}
					onInput={(e) => {
						const rgb = hexToRgb((e.currentTarget as HTMLInputElement).value);
						commit({ ...rgb, a: c.a });
					}}
				/>
				<label class="editor-color-alpha">
					<span>α</span>
					<input
						type="range"
						min={0} max={1} step={0.01}
						value={c.a}
						onInput={(e) => {
							const a = parseFloat((e.currentTarget as HTMLInputElement).value);
							commit({ r: c.r, g: c.g, b: c.b, a: Number.isFinite(a) ? a : 1 });
						}}
					/>
					<span class="editor-color-alpha-value">{c.a.toFixed(2)}</span>
				</label>
			</div>
		</FieldShell>
	);
}

/* ------------------------------ point --------------------------------- */

function parsePoint(v: unknown): [number, number] {
	if (Array.isArray(v) && v.length >= 2) return [Number(v[0]) || 0, Number(v[1]) || 0];
	if (typeof v === 'string') {
		const [a, b] = v.split(',').map(s => Number(s.trim()));
		return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
	}
	return [0, 0];
}

export function PointFieldRenderer({ field, path }: { field: PointField; path: Path }) {
	const idX = useMemo(() => genId('pt-x'), []);
	const idY = useMemo(() => genId('pt-y'), []);
	const raw = useDraftValue([...path, field.key]);
	const [x, y] = parsePoint(raw);
	function commit(nx: number, ny: number) {
		// Legacy on-disk format is "x,y" string; we keep the same.
		applyEdit([...path, field.key], `${nx},${ny}`);
	}
	return (
		<FieldShell label={field.label} help={field.help}>
			<div class="editor-point">
				<label for={idX}>x</label>
				<input id={idX} type="number" value={x}
					onInput={(e) => commit(Number((e.currentTarget as HTMLInputElement).value) || 0, y)} />
				<label for={idY}>y</label>
				<input id={idY} type="number" value={y}
					onInput={(e) => commit(x, Number((e.currentTarget as HTMLInputElement).value) || 0)} />
			</div>
		</FieldShell>
	);
}

/* ------------------------------ image / sound (stub) ------------------ */

export function ImageFieldRenderer({ field, path }: { field: ImageField; path: Path }) {
	const id = useMemo(() => genId('img'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : '';
	return (
		<FieldShell label={field.label} help={field.help ?? 'Asset path (preview not yet supported in editor).'} htmlFor={id}>
			<input
				id={id}
				type="text"
				placeholder="path/to/image.png"
				value={value}
				onInput={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLInputElement).value)}
			/>
		</FieldShell>
	);
}

export function SoundFieldRenderer({ field, path }: { field: SoundField; path: Path }) {
	const id = useMemo(() => genId('snd'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : '';
	return (
		<FieldShell label={field.label} help={field.help ?? 'Asset path (preview not yet supported in editor).'} htmlFor={id}>
			<input
				id={id}
				type="text"
				placeholder="path/to/sound.mp3"
				value={value}
				onInput={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLInputElement).value)}
			/>
		</FieldShell>
	);
}

/* ------------------------------ expression (leaf) --------------------- */

/** Most expressions are stored as a child list of EventValue tokens via
 * ChildrenField. This leaf renderer is only the fallback for any place
 * that declared `expression` as a non-children field (none today). */
export function ExpressionFieldRenderer({ field }: { field: ExpressionField; path: Path }) {
	return (
		<FieldShell label={field.label} help={field.help}>
			<em class="editor-empty-list">Expression editor: see token list above.</em>
		</FieldShell>
	);
}
