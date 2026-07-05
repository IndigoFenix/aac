/**
 * Reference field components: ref (single), refList (multi), numberOrRef.
 *
 * Options come live from the draft, keyed by `field.list`. Editing the
 * referenced list anywhere in the editor immediately updates these
 * dropdowns because both reads go through the same `version` signal.
 */

import { useMemo } from 'preact/hooks';
import { FieldShell, useDraftValue, applyEdit, genId, DecimalInput } from './common';
import { draft, version } from '../../state';
import type { RefField, RefListField, NumberOrRefField, ListKey } from '../../schema';
import type { Path } from '../../state';

function listOptions(list: ListKey): { key: string; label: string }[] {
	void version.value;
	const cur = draft.value;
	if (!cur) return [];
	const arr = cur[list];
	if (!Array.isArray(arr)) return [];
	const out: { key: string; label: string }[] = [];
	for (const item of arr) {
		if (!item || typeof item !== 'object') continue;
		const k = (item as Record<string, unknown>).key;
		if (typeof k !== 'string' || k.length === 0) continue;
		const name = (item as Record<string, unknown>).name;
		const label = typeof name === 'string' && name.trim() ? `${name} (${k})` : k;
		out.push({ key: k, label });
	}
	return out;
}

/* -------------------- ref (single) ------------------------------------ */

export function RefFieldRenderer({ field, path }: { field: RefField; path: Path }) {
	const id = useMemo(() => genId('ref'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : '';
	const options = listOptions(field.list);
	const currentMissing = value !== '' && !options.some(o => o.key === value);
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<select
				id={id}
				value={value}
				onChange={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLSelectElement).value)}
			>
				<option value="">— none —</option>
				{currentMissing && <option value={value}>{value} (missing)</option>}
				{options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
			</select>
		</FieldShell>
	);
}

/* -------------------- refList (multi) --------------------------------- */

export function RefListFieldRenderer({ field, path }: { field: RefListField; path: Path }) {
	const raw = useDraftValue([...path, field.key]);
	const selected = toStringArray(raw);
	const options = listOptions(field.list);
	const known = new Set(options.map(o => o.key));
	const orphans = selected.filter(s => !known.has(s));

	function toggle(k: string) {
		const idx = selected.indexOf(k);
		const next = selected.slice();
		if (idx >= 0) next.splice(idx, 1);
		else next.push(k);
		applyEdit([...path, field.key], next);
	}

	return (
		<FieldShell label={field.label} help={field.help}>
			<div class="editor-reflist">
				{options.length === 0 && orphans.length === 0
					? <span class="editor-empty-list">No items in {field.list} list.</span>
					: (
						<>
							{options.map(o => (
								<label key={o.key} class="editor-reflist-item">
									<input
										type="checkbox"
										checked={selected.includes(o.key)}
										onChange={() => toggle(o.key)}
									/>
									<span>{o.label}</span>
								</label>
							))}
							{orphans.map(k => (
								<label key={k} class="editor-reflist-item editor-reflist-orphan">
									<input
										type="checkbox"
										checked={true}
										onChange={() => toggle(k)}
									/>
									<span>{k} (missing)</span>
								</label>
							))}
						</>
					)}
			</div>
		</FieldShell>
	);
}

/* -------------------- numberOrRef ------------------------------------- */

export function NumberOrRefFieldRenderer({ field, path }: { field: NumberOrRefField; path: Path }) {
	const idNum = useMemo(() => genId('nor-num'), []);
	const idRef = useMemo(() => genId('nor-ref'), []);
	const raw = useDraftValue([...path, field.key]);

	// In legacy, this attribute is either a number or a resource key (string).
	const isString = typeof raw === 'string';
	const numValue = !isString && typeof raw === 'number' ? raw : (field.default ?? 0);
	const refValue = isString ? raw as string : '';
	const options = listOptions(field.list);
	const currentMissing = refValue !== '' && !options.some(o => o.key === refValue);

	return (
		<FieldShell label={field.label} help={field.help}>
			<div class="editor-numref">
				<div class="editor-numref-mode">
					<label>
						<input
							type="radio"
							name={`${idNum}-mode`}
							checked={!isString}
							onChange={() => applyEdit([...path, field.key], field.default ?? 0)}
						/>
						<span>Number</span>
					</label>
					<label>
						<input
							type="radio"
							name={`${idNum}-mode`}
							checked={isString}
							onChange={() => applyEdit([...path, field.key], '')}
						/>
						<span>Resource</span>
					</label>
				</div>
				{!isString
					? (
						<DecimalInput
							id={idNum}
							value={numValue}
							min={field.min}
							max={field.max}
							step={field.step ?? 'any'}
							onCommit={(n) => applyEdit([...path, field.key], n)}
							fallback={field.default ?? 0}
						/>
					)
					: (
						<select
							id={idRef}
							value={refValue}
							onChange={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLSelectElement).value)}
						>
							<option value="">— none —</option>
							{currentMissing && <option value={refValue}>{refValue} (missing)</option>}
							{options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
						</select>
					)}
			</div>
		</FieldShell>
	);
}

function toStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).filter(s => s.length > 0);
	if (typeof v === 'string' && v.length > 0) return v.split(',').map(s => s.trim()).filter(Boolean);
	return [];
}
