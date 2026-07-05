/**
 * CalculatorModal — popup for building a custom metric expression.
 *
 * Mirrors legacy `Calculator` (script.js:4981). Lets the player tap a digit
 * pad / operator pad to build an expression, or hit "Var" to pick any visible
 * tracker (with an optional moving-average / since-start window).
 *
 * The output is a serialized expression (SerializedExprValue[]) submitted via
 * `client.addCustomMetric()`. The worker rebuilds it as a live Expression.
 */

import { useEffect, useState } from 'preact/hooks';
import { useI18n } from '../useI18n';
import { trackersMeta, hiddenTrackerSet, trackerByIdLookup } from '../state';
import type { SimClient } from '../../../sim/SimClient';
import type { CustomMetricSpec } from '../../../sim/protocol';
import type { TrackerMeta } from '../../../sim/protocol';

interface Props {
	open: boolean;
	onClose: () => void;
	client: SimClient;
	/** When provided, the modal opens in edit mode: state is pre-populated
	 * from the spec, and saving sends `editCustomMetric` so the underlying
	 * metric keeps its base_key (and any other readouts that reference it
	 * stay connected). */
	editing?: { baseKey: string; spec: CustomMetricSpec } | null;
}

/** A token in the in-progress expression, mirroring `SerializedExprValue`. */
type Token =
	| { kind: 'num'; value: number }
	| { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' }
	| { kind: 'paren'; value: '(' | ')' }
	| { kind: 'tracker'; trackerId: string; trackerName: string; neg_offset: number; calc: '' | 'avg' | 'sum'; incdec: '' | 'inc' | 'dec' };

export function CalculatorModal({ open, onClose, client, editing = null }: Props) {
	const { t } = useI18n();
	const [tokens, setTokens] = useState<Token[]>([]);
	// Numeric draft — the digit pad accumulates here, "confirmed" into a num
	// token on operator/var/paren/equals.
	const [draft, setDraft] = useState<string>('');
	const [name, setName] = useState<string>('');
	const [color, setColor] = useState<string>('#3399ff');
	const [perc, setPerc] = useState<boolean>(false);
	const [precision, setPrecision] = useState<number>(0);
	const [varPickerOpen, setVarPickerOpen] = useState<boolean>(false);

	// Re-seed state whenever the modal opens — fresh on a create open, or
	// pre-populated on an edit open. Closing it preserves the last input,
	// which is fine because the next open will overwrite again.
	useEffect(() => {
		if (!open) return;
		if (editing) {
			setName(editing.spec.name);
			setColor(csvToHex(editing.spec.color));
			setPerc(editing.spec.perc);
			setPrecision(editing.spec.precision);
			setTokens(decodeExpressionData(editing.spec.expressionData));
			setDraft('');
		} else {
			setName('');
			setColor('#3399ff');
			setPerc(false);
			setPrecision(0);
			setTokens([]);
			setDraft('');
		}
	}, [open, editing]);

	if (!open) return null;

	function pushDraftIfAny(localTokens: Token[] = tokens): Token[] {
		if (draft === '' || draft === '-' || draft === '.') return localTokens;
		const v = parseFloat(draft);
		if (Number.isFinite(v)) {
			localTokens = [...localTokens, { kind: 'num', value: v }];
		}
		setDraft('');
		return localTokens;
	}

	function pressDigit(d: string): void {
		// Disallow two leading zeros; allow exactly one decimal point.
		if (d === '.' && draft.includes('.')) return;
		setDraft(draft + d);
	}

	function pressOp(op: '+' | '-' | '*' | '/' | '^'): void {
		// Allow "-" at start or after another op as a sign on the next number.
		if (op === '-' && (draft === '' && (tokens.length === 0 || tokens[tokens.length - 1].kind === 'op' || (tokens[tokens.length - 1].kind === 'paren' && (tokens[tokens.length - 1] as Token & { value: string }).value === '(')))) {
			setDraft('-');
			return;
		}
		const next = pushDraftIfAny();
		setTokens([...next, { kind: 'op', value: op }]);
	}

	function pressParen(p: '(' | ')'): void {
		const next = pushDraftIfAny();
		setTokens([...next, { kind: 'paren', value: p }]);
	}

	function pressBackspace(): void {
		if (draft.length > 0) {
			setDraft(draft.slice(0, -1));
			return;
		}
		if (tokens.length > 0) setTokens(tokens.slice(0, -1));
	}

	function pressClear(): void {
		setTokens([]);
		setDraft('');
	}

	function addTrackerToken(tok: Token): void {
		const next = pushDraftIfAny();
		setTokens([...next, tok]);
	}

	function submit(): void {
		const finalTokens = pushDraftIfAny();
		if (finalTokens.length === 0) return;
		// Empty name is valid — the row label falls back to the formula text.
		const spec: CustomMetricSpec = {
			name: name.trim(),
			color: cssToRgbaCsv(color),
			perc,
			precision,
			expressionData: tokensToExpressionData(finalTokens),
		};
		if (editing) {
			client.editCustomMetric(editing.baseKey, spec);
		} else {
			client.addCustomMetric(spec);
		}
		setTokens([]);
		setDraft('');
		setName('');
		onClose();
	}

	// Visible trackers — exclude hidden ones AND don't list the metric we're
	// (presumably) about to create. Player-side metrics are themselves valid
	// variables.
	const hidden = hiddenTrackerSet.value;
	const allTrackers = trackersMeta.value.filter(tr => !hidden.has(tr.id));

	return (
		<div class="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
			<div class="modal calculator-modal" onClick={(e) => e.stopPropagation()}>
				<div class="modal-header">{editing ? t('metrics.edit_title') : t('metrics.create_title')}</div>
				<div class="modal-body">
					<div class="field">
						<label for="metric-name">{t('metrics.name_label')}</label>
						<input
							id="metric-name"
							type="text"
							value={name}
							onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
							placeholder={t('metrics.name_placeholder')}
						/>
					</div>
					<div class="field calc-row">
						<label for="metric-color">{t('metrics.color_label')}</label>
						<input
							id="metric-color"
							type="color"
							value={color}
							onInput={(e) => setColor((e.currentTarget as HTMLInputElement).value)}
						/>
						<label class="calc-inline">
							<input
								type="checkbox"
								checked={perc}
								onChange={(e) => setPerc((e.currentTarget as HTMLInputElement).checked)}
							/>
							{t('metrics.percent_label')}
						</label>
						<label class="calc-inline">
							{t('metrics.precision_label')}
							<input
								type="number"
								min={0}
								max={6}
								value={precision}
								onInput={(e) => setPrecision(parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0)}
							/>
						</label>
					</div>

					<div class="calc-display" aria-live="polite">
						{tokens.length === 0 && draft === '' && (
							<span class="calc-display-placeholder">{t('metrics.display_placeholder')}</span>
						)}
						{renderTokens(tokens)}
						<span class="calc-draft">{draft}</span>
					</div>

					<div class="calc-pad">
						{['7', '8', '9', '/'].map(c => (
							<button class="calc-key" onClick={() => keyAction(c, pressDigit, pressOp)}>{c}</button>
						))}
						{['4', '5', '6', '*'].map(c => (
							<button class="calc-key" onClick={() => keyAction(c, pressDigit, pressOp)}>{c}</button>
						))}
						{['1', '2', '3', '-'].map(c => (
							<button class="calc-key" onClick={() => keyAction(c, pressDigit, pressOp)}>{c}</button>
						))}
						{['0', '.', '+', '^'].map(c => (
							<button class="calc-key" onClick={() => keyAction(c, pressDigit, pressOp)}>{c}</button>
						))}
						<button class="calc-key" onClick={() => pressParen('(')}>(</button>
						<button class="calc-key" onClick={() => pressParen(')')}>)</button>
						<button class="calc-key" onClick={pressBackspace}>{'<-'}</button>
						<button class="calc-key" onClick={pressClear}>{t('metrics.clear')}</button>
						<button class="calc-key calc-var" onClick={() => setVarPickerOpen(true)}>{t('metrics.var')}</button>
					</div>

					{varPickerOpen && (
						<VarPicker
							trackers={allTrackers}
							onClose={() => setVarPickerOpen(false)}
							onPick={(tok) => { addTrackerToken(tok); setVarPickerOpen(false); }}
						/>
					)}
				</div>
				<div class="modal-footer">
					<button class="btn" onClick={onClose}>{t('common.cancel')}</button>
					<button
						class="btn primary"
						onClick={submit}
						disabled={tokens.length === 0 && draft === ''}
					>{editing ? t('metrics.save_button') : t('metrics.create_button')}</button>
				</div>
			</div>
		</div>
	);
}

function keyAction(
	c: string,
	digit: (d: string) => void,
	op: (op: '+' | '-' | '*' | '/' | '^') => void,
): void {
	if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') op(c);
	else digit(c);
}

function renderTokens(tokens: Token[]) {
	return tokens.map((tok, i) => {
		if (tok.kind === 'num') return <span key={i} class="tok tok-num">{tok.value}</span>;
		if (tok.kind === 'op') return <span key={i} class="tok tok-op"> {tok.value} </span>;
		if (tok.kind === 'paren') return <span key={i} class="tok tok-paren">{tok.value}</span>;
		// Tracker
		const calc = tok.calc ? `${tok.calc}(` : '';
		const close = tok.calc ? ')' : '';
		const incdec = tok.incdec === 'inc' ? '↑' : tok.incdec === 'dec' ? '↓' : '';
		const offset = tok.neg_offset !== 0 ? ` -${tok.neg_offset}d` : '';
		return <span key={i} class="tok tok-tracker">{`${calc}${tok.trackerName}${incdec}${offset}${close}`}</span>;
	});
}

interface VarPickerProps {
	trackers: TrackerMeta[];
	onClose: () => void;
	onPick: (tok: Token) => void;
}

function VarPicker({ trackers, onClose, onPick }: VarPickerProps) {
	const { t } = useI18n();
	const [filter, setFilter] = useState<string>('');
	const [selected, setSelected] = useState<TrackerMeta | null>(null);
	const [calc, setCalc] = useState<'' | 'avg' | 'sum'>('');
	const [incdec, setIncdec] = useState<'' | 'inc' | 'dec'>('');
	const [days, setDays] = useState<number>(0);

	const lowerFilter = filter.toLowerCase();
	const matching = lowerFilter
		? trackers.filter(tr => tr.name.toLowerCase().includes(lowerFilter))
		: trackers;

	function confirm(): void {
		if (!selected) return;
		onPick({
			kind: 'tracker',
			trackerId: selected.id,
			trackerName: selected.name,
			neg_offset: days,
			calc,
			incdec,
		});
	}

	return (
		<div class="varpicker-overlay" onClick={onClose}>
			<div class="varpicker" onClick={(e) => e.stopPropagation()}>
				<div class="varpicker-header">{t('metrics.pick_variable')}</div>
				<input
					class="varpicker-filter"
					type="text"
					placeholder={t('metrics.filter_placeholder')}
					value={filter}
					onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
					autoFocus
				/>
				<div class="varpicker-list" role="listbox">
					{matching.map(tr => (
						<button
							key={tr.id}
							class={`varpicker-item${selected?.id === tr.id ? ' selected' : ''}`}
							role="option"
							aria-selected={selected?.id === tr.id}
							onClick={() => setSelected(tr)}
						>
							<span class="dot" style={`background:${tr.color}`} />
							<span>{tr.name}</span>
							<span class="kind">{tr.type}</span>
						</button>
					))}
					{matching.length === 0 && (
						<div class="varpicker-empty">{t('metrics.no_variables')}</div>
					)}
				</div>
				{selected && (
					<div class="varpicker-options">
						<label class="calc-inline">
							{t('metrics.window_days')}
							<input
								type="number"
								min={0}
								value={days}
								onInput={(e) => setDays(parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0)}
							/>
						</label>
						<label class="calc-inline">
							{t('metrics.aggregate')}
							<select value={calc} onChange={(e) => setCalc((e.currentTarget as HTMLSelectElement).value as '' | 'avg' | 'sum')}>
								<option value="">{t('metrics.aggregate_value')}</option>
								<option value="avg">{t('metrics.aggregate_avg')}</option>
								<option value="sum">{t('metrics.aggregate_sum')}</option>
							</select>
						</label>
						<label class="calc-inline">
							{t('metrics.mode')}
							<select value={incdec} onChange={(e) => setIncdec((e.currentTarget as HTMLSelectElement).value as '' | 'inc' | 'dec')}>
								<option value="">{t('metrics.mode_current')}</option>
								<option value="inc">{t('metrics.mode_inc')}</option>
								<option value="dec">{t('metrics.mode_dec')}</option>
							</select>
						</label>
					</div>
				)}
				<div class="modal-footer">
					<button class="btn" onClick={onClose}>{t('common.cancel')}</button>
					<button class="btn primary" disabled={!selected} onClick={confirm}>{t('metrics.add_variable')}</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Convert the in-progress Token[] into the wire-shape SerializedExprValue[].
 * Mirrors the legacy `createExpressionFromEventValues` token layout: an
 * implicit leading 0 + `+ <token>` for each subsequent atom so the parser
 * reads it as a binary chain.
 */
function tokensToExpressionData(tokens: Token[]): unknown[] {
	const out: unknown[] = [];
	out.push({ type: 'val', subtype: 'num', value: 0 });
	let prev: Token | null = null;
	for (const tok of tokens) {
		// Inject "+" before each atom unless prev is an open-paren or an op.
		const needsBinary = !!prev && prev.kind !== 'op' && !(prev.kind === 'paren' && prev.value === '(');
		if (needsBinary && tok.kind !== 'op' && !(tok.kind === 'paren' && tok.value === ')')) {
			out.push({ type: 'op', subtype: null, value: '+' });
		}
		switch (tok.kind) {
			case 'num':
				out.push({ type: 'val', subtype: 'num', value: tok.value });
				break;
			case 'op':
				out.push({ type: 'op', subtype: null, value: tok.value });
				break;
			case 'paren':
				out.push({ type: 'paren', subtype: null, value: tok.value });
				break;
			case 'tracker': {
				// Decode `${kind}:${key}` from trackerId.
				const idx = tok.trackerId.indexOf(':');
				const kindKey = tok.trackerId; // already in `kind:key` shape
				out.push({
					type: 'val',
					subtype: 'tracker',
					value: {
						__trackerCalc: true,
						trackerKindKey: kindKey,
						neg_offset: tok.neg_offset,
						offset: 0,
						incdec: tok.incdec,
						calc: tok.calc === '' ? null : tok.calc,
					},
				});
				void idx;
				break;
			}
		}
		prev = tok;
	}
	return out;
}

/** Convert "#rrggbb" to "r,g,b,1" (the BColor data shape). */
function cssToRgbaCsv(hex: string): string {
	const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
	if (!m) return '0,0,0,1';
	const r = parseInt(m[1].slice(0, 2), 16);
	const g = parseInt(m[1].slice(2, 4), 16);
	const b = parseInt(m[1].slice(4, 6), 16);
	return `${r},${g},${b},1`;
}

/** Convert "r,g,b,a" CSV (the spec shape) back to "#rrggbb" for a `<input type="color">`. */
function csvToHex(csv: string): string {
	const parts = csv.split(',').map(s => parseInt(s.trim(), 10) || 0);
	const [r, g, b] = parts;
	const hex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Reverse of `tokensToExpressionData`. Strips the leading `0` sentinel and
 * the binary-`+` operators that the encoder injects between adjacent atoms,
 * leaving the user's original Token[] reconstructable for display + edit.
 */
function decodeExpressionData(data: unknown[]): Token[] {
	if (!Array.isArray(data) || data.length === 0) return [];
	const arr = data as Array<{ type: string; subtype: string | null; value: unknown }>;
	let start = 0;
	if (arr[0] && arr[0].type === 'val' && arr[0].subtype === 'num' && arr[0].value === 0) start = 1;

	const isAtomOrOpen = (v: typeof arr[number] | undefined): boolean => {
		if (!v) return false;
		if (v.type === 'op') return false;
		if (v.type === 'paren' && v.value === '(') return false;
		return true;
	};
	const isAtomOrClose = (v: typeof arr[number] | undefined): boolean => {
		if (!v) return false;
		if (v.type === 'op') return false;
		if (v.type === 'paren' && v.value === ')') return false;
		return true;
	};

	const tokens: Token[] = [];
	for (let i = start; i < arr.length; i++) {
		const v = arr[i];
		if (v.type === 'op' && v.value === '+'
			&& isAtomOrOpen(arr[i - 1]) && isAtomOrClose(arr[i + 1])
		) {
			// Implicit `+` injected by the encoder — skip.
			continue;
		}
		if (v.type === 'val' && v.subtype === 'num') {
			tokens.push({ kind: 'num', value: Number(v.value) });
		} else if (v.type === 'op') {
			tokens.push({ kind: 'op', value: v.value as '+' | '-' | '*' | '/' | '^' });
		} else if (v.type === 'paren') {
			tokens.push({ kind: 'paren', value: v.value as '(' | ')' });
		} else if (v.type === 'val' && v.subtype === 'tracker') {
			const tc = v.value as { trackerKindKey: string; neg_offset: number; calc: string | null; incdec: string };
			const meta = trackerByIdLookup(tc.trackerKindKey);
			tokens.push({
				kind: 'tracker',
				trackerId: tc.trackerKindKey,
				trackerName: meta?.name && meta.name !== '' ? meta.name : tc.trackerKindKey,
				neg_offset: tc.neg_offset || 0,
				calc: (tc.calc as 'avg' | 'sum' | null) ?? '',
				incdec: (tc.incdec as 'inc' | 'dec' | '') ?? '',
			});
		}
	}
	return tokens;
}

export default CalculatorModal;
