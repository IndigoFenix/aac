/**
 * Render a player-created metric or correlation as a short formula string.
 *
 * Used as the row label when the player left the name field blank, so the
 * tracker is still identifiable. The output is plain text; no markdown or
 * HTML — the row renders it inside a span.
 *
 * Trait references inside specs are stored by key (`trait_x`); the renderer
 * resolves them against the tracker registry so the display reads `Vaccinated`
 * rather than `vaccinated_T`.
 */

import type {
	CustomMetricSpec, CustomCorrelationSpec, TrackerMeta,
} from '../../../sim/protocol';

interface SerializedExprValue {
	type: string;
	subtype: string | null;
	value: unknown;
}

interface TrackerCalcSpec {
	trackerKindKey: string;
	neg_offset: number;
	offset: number;
	incdec: string;
	calc: string | null;
}

export function metricFormulaText(
	spec: CustomMetricSpec,
	trackerByKey: (kindKey: string) => TrackerMeta | undefined,
): string {
	const data = spec.expressionData as SerializedExprValue[];
	const parts: string[] = [];
	// The encoder wraps the user expression with a leading `0 + ...` sentinel
	// so `+ 5` parses cleanly. Skip it for display.
	const start = (data.length > 0 && isLiteral(data[0], 0)) ? 1 : 0;
	for (let i = start; i < data.length; i++) {
		const v = data[i];
		// Implicit `+` between atoms — skip when both neighbors are atoms.
		if (v.type === 'op' && v.value === '+') {
			const prev = data[i - 1];
			const next = data[i + 1];
			if (isAtomOrOpen(prev) && isAtomOrClose(next)) continue;
		}
		parts.push(renderValue(v, trackerByKey));
	}
	return parts.join(' ').trim() || '∅';
}

export function correlationFormulaText(
	spec: CustomCorrelationSpec,
	trackerByKey: (kindKey: string) => TrackerMeta | undefined,
): string {
	const traitName = (k: string): string => trackerByKey(`trait:${k}`)?.name ?? k;
	const parts: string[] = [];
	if (spec.def_and.length) parts.push(spec.def_and.map(traitName).join(' ∧ '));
	if (spec.def_or.length) parts.push('(' + spec.def_or.map(traitName).join(' ∨ ') + ')');
	if (spec.def_not.length) parts.push('¬(' + spec.def_not.map(traitName).join(' ∨ ') + ')');
	if (spec.require.length) parts.push('require[' + spec.require.map(traitName).join(', ') + ']');
	if (spec.forbid.length) parts.push('forbid[' + spec.forbid.map(traitName).join(', ') + ']');
	return parts.join(' ∧ ').trim() || '∅';
}

function isLiteral(v: SerializedExprValue, n: number): boolean {
	return v.type === 'val' && v.subtype === 'num' && v.value === n;
}

function isAtomOrOpen(v: SerializedExprValue | undefined): boolean {
	if (!v) return false;
	if (v.type === 'op') return false;
	if (v.type === 'paren' && v.value === ')') return true;
	if (v.type === 'paren' && v.value === '(') return false;
	return true;
}

function isAtomOrClose(v: SerializedExprValue | undefined): boolean {
	if (!v) return false;
	if (v.type === 'op') return false;
	if (v.type === 'paren' && v.value === '(') return true;
	if (v.type === 'paren' && v.value === ')') return false;
	return true;
}

function renderValue(
	v: SerializedExprValue,
	trackerByKey: (kindKey: string) => TrackerMeta | undefined,
): string {
	if (v.type === 'val' && v.subtype === 'num') return String(v.value);
	if (v.type === 'op') return String(v.value);
	if (v.type === 'paren') return String(v.value);
	if (v.type === 'val' && v.subtype === 'tracker') {
		const tc = v.value as TrackerCalcSpec;
		const meta = trackerByKey(tc.trackerKindKey);
		const name = meta?.name && meta.name !== '' ? meta.name : tc.trackerKindKey;
		const calc = tc.calc ? `${tc.calc}(` : '';
		const close = tc.calc ? ')' : '';
		const incdec = tc.incdec === 'inc' ? '↑' : tc.incdec === 'dec' ? '↓' : '';
		const offset = tc.neg_offset && tc.neg_offset !== 0 ? ` -${tc.neg_offset}d` : '';
		return `${calc}${name}${incdec}${offset}${close}`;
	}
	return '';
}
