/**
 * Helpers shared by every field component.
 *
 * The editor reads/writes the draft via path-based getters and setters in
 * `../../state`. Field components are dumb: they receive a path, look up
 * the value, and write changes back through `applyEdit`.
 */

import { applyEdit, draft, getIn, version } from '../../state';
import type { Path } from '../../state';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function useDraftValue(path: Path): unknown {
	// Touch `version` and `draft` so Preact + signals know we depend on them.
	void version.value;
	return getIn(draft.value, path);
}

interface FieldShellProps {
	label: string;
	help?: string;
	htmlFor?: string;
	children: ComponentChildren;
}

export function FieldShell({ label, help, htmlFor, children }: FieldShellProps) {
	return (
		<div class="editor-field">
			<div class="editor-field-label">
				{htmlFor
					? <label for={htmlFor}>{label}</label>
					: <span>{label}</span>}
				{help && <span class="editor-field-help" title={help}>?</span>}
			</div>
			<div class="editor-field-input">{children}</div>
		</div>
	);
}

let _idCounter = 0;
export function genId(prefix: string): string {
	return `${prefix}-${++_idCounter}`;
}

/**
 * `<input type=number>` controlled by a parsed value rounds-trips through
 * parseFloat on every keystroke, which strips the trailing `.` while the
 * user is mid-typing a decimal — so "0." gets snapped back to "0" and the
 * next keystroke replaces the dot. This wrapper holds the user's raw text
 * locally while focused and only re-syncs with the prop value on blur or
 * when the value changes externally. Valid parses are committed live so
 * other panels still react in real time.
 */
interface DecimalInputProps {
	id?: string;
	value: number;
	min?: number;
	max?: number;
	step?: number | string;
	int?: boolean;
	fallback?: number;
	onCommit: (n: number) => void;
}
export function DecimalInput(props: DecimalInputProps) {
	const { value, int = false, fallback = 0 } = props;
	const [text, setText] = useState<string>(() => String(value));
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (!focused) setText(String(value));
	}, [value, focused]);

	const isPartial = (t: string) =>
		t === '' || t === '-' || t === '.' || t === '-.' || t.endsWith('.');

	return (
		<input
			id={props.id}
			type="number"
			value={text}
			min={props.min}
			max={props.max}
			step={props.step ?? (int ? 1 : 'any')}
			inputMode={int ? 'numeric' : 'decimal'}
			onFocus={() => setFocused(true)}
			onInput={(e) => {
				const t = (e.currentTarget as HTMLInputElement).value;
				setText(t);
				if (isPartial(t)) return;
				const n = int ? parseInt(t, 10) : parseFloat(t);
				if (Number.isFinite(n)) props.onCommit(n);
			}}
			onBlur={(e) => {
				setFocused(false);
				const t = (e.currentTarget as HTMLInputElement).value;
				const n = t === '' ? fallback : (int ? parseInt(t, 10) : parseFloat(t));
				const final = Number.isFinite(n) ? n : fallback;
				setText(String(final));
				props.onCommit(final);
			}}
		/>
	);
}

export { applyEdit };
export type { Path };
