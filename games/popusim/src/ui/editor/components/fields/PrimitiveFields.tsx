/**
 * Primitive field components: bool, number, string, text, date, select.
 */

import { useMemo } from 'preact/hooks';
import { FieldShell, useDraftValue, applyEdit, genId, DecimalInput } from './common';
import type {
	BoolField, NumberField, StringField, TextField, DateField, SelectField,
} from '../../schema';
import type { Path } from '../../state';

export function BoolFieldRenderer({ field, path }: { field: BoolField; path: Path }) {
	const id = useMemo(() => genId('bool'), []);
	const raw = useDraftValue([...path, field.key]);
	// Legacy stores 0/1; modern accepts boolean too.
	const checked = raw === true || raw === 1 || raw === '1';
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<input
				id={id}
				type="checkbox"
				checked={checked}
				onChange={(e) => {
					const v = (e.currentTarget as HTMLInputElement).checked;
					applyEdit([...path, field.key], v ? 1 : 0);
				}}
			/>
		</FieldShell>
	);
}

export function NumberFieldRenderer({ field, path }: { field: NumberField; path: Path }) {
	const id = useMemo(() => genId('num'), []);
	const raw = useDraftValue([...path, field.key]);
	const stateValue = typeof raw === 'number' && Number.isFinite(raw)
		? raw
		: (Number(raw ?? field.default ?? 0) || 0);
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<DecimalInput
				id={id}
				value={stateValue}
				min={field.min}
				max={field.max}
				step={field.step}
				int={field.int}
				fallback={field.default ?? 0}
				onCommit={(n) => applyEdit([...path, field.key], n)}
			/>
		</FieldShell>
	);
}

export function StringFieldRenderer({ field, path }: { field: StringField; path: Path }) {
	const id = useMemo(() => genId('str'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<input
				id={id}
				type="text"
				value={value}
				onInput={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLInputElement).value)}
			/>
		</FieldShell>
	);
}

export function TextFieldRenderer({ field, path }: { field: TextField; path: Path }) {
	const id = useMemo(() => genId('text'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<textarea
				id={id}
				rows={4}
				value={value}
				onInput={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLTextAreaElement).value)}
			/>
		</FieldShell>
	);
}

export function DateFieldRenderer({ field, path }: { field: DateField; path: Path }) {
	const id = useMemo(() => genId('date'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = typeof raw === 'string' ? raw : '';
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<input
				id={id}
				type="date"
				value={value}
				onInput={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLInputElement).value)}
			/>
		</FieldShell>
	);
}

export function SelectFieldRenderer({ field, path }: { field: SelectField; path: Path }) {
	const id = useMemo(() => genId('sel'), []);
	const raw = useDraftValue([...path, field.key]);
	const value = (typeof raw === 'string' || typeof raw === 'number') ? String(raw) : (field.default ?? '');
	return (
		<FieldShell label={field.label} help={field.help} htmlFor={id}>
			<select
				id={id}
				value={value}
				onChange={(e) => applyEdit([...path, field.key], (e.currentTarget as HTMLSelectElement).value)}
			>
				{field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
			</select>
		</FieldShell>
	);
}
