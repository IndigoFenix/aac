/**
 * EditorApp — root of the scenario-editor UI.
 *
 * Mounted by App.tsx when `ui.mode === 'editor'`. The editor works on a
 * plain JSON draft (`./state.draft`) and never instantiates sim classes.
 * Hitting "Start" pushes the draft into the SimClient and switches mode
 * back to gameplay.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { updateUi } from '../app/state';
import {
	draft, setDraft, loadPersistedDraft, clearPersistedDraft,
} from './state';
import {
	parseScenarioText, readFileAsText, downloadScenario, blankScenario,
} from './ScenarioIO';
import { ObjectEditor } from './components/ObjectEditor';
import { worldSchema } from './schema';
import { validateScenario, type Issue } from './validate';
import type { SimClient } from '../../sim/SimClient';

interface Props {
	client: SimClient;
	seed: number;
	/** Called with the scenario JSON when the user clicks Start, so the
	 * parent can remember it as the new "live scenario". */
	onStarted: (scenario: Record<string, unknown>) => void;
}

export function EditorApp({ client, seed, onStarted }: Props) {
	// Force a re-render on draft signal updates without subscribing the whole tree.
	const [, force] = useState(0);
	useEffect(() => {
		return draft.subscribe(() => force(n => n + 1));
	}, []);

	const fileRef = useRef<HTMLInputElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [issues, setIssues] = useState<Issue[] | null>(null);

	function onValidate() {
		setIssues(validateScenario(draft.value));
	}

	function exitToGameplay() {
		updateUi({ mode: 'gameplay' });
	}

	async function startWithDraft() {
		if (!draft.value) return;
		try {
			// Two clones: one for the worker (which may mutate during load)
			// and one we hand to the parent as the canonical "live scenario".
			const forWorker = JSON.parse(JSON.stringify(draft.value)) as Record<string, unknown>;
			const forParent = JSON.parse(JSON.stringify(draft.value)) as Record<string, unknown>;
			await client.reset(forWorker, seed);
			onStarted(forParent);
			updateUi({ mode: 'gameplay' });
		} catch (err) {
			setError(`Failed to start: ${(err as Error).message}`);
		}
	}

	async function onUpload(ev: Event) {
		const input = ev.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const text = await readFileAsText(file);
		const result = parseScenarioText(text);
		if (!result.ok) { setError(result.message); return; }
		setDraft(result.draft);
		setError(null);
		input.value = '';
	}

	function onDownload() {
		if (!draft.value) return;
		downloadScenario(draft.value);
	}

	function onNewBlank() {
		setDraft(blankScenario());
		setError(null);
	}

	function onDiscardDraft() {
		clearPersistedDraft();
		setDraft(null);
	}

	const hasDraft = draft.value !== null;

	return (
		<div class="editor-root">
			<header class="editor-bar">
				<button onClick={exitToGameplay} title="Discard editor and return to gameplay">← Back</button>
				<span class="editor-title">
					Scenario Editor{hasDraft && draft.value && typeof draft.value.name === 'string'
						? ` — ${draft.value.name}`
						: ''}
				</span>
				<div class="editor-bar-spacer" />
				<button onClick={onNewBlank}>New</button>
				<button onClick={() => fileRef.current?.click()}>Upload…</button>
				<input
					ref={fileRef}
					type="file"
					accept="application/json,.json"
					style="display:none"
					onChange={onUpload}
				/>
				<button onClick={onDownload} disabled={!hasDraft}>Download</button>
				<button onClick={onValidate} disabled={!hasDraft}>Validate</button>
				<button onClick={onDiscardDraft} disabled={!hasDraft}>Discard</button>
				<button class="primary" onClick={startWithDraft} disabled={!hasDraft}>Start</button>
			</header>

			{error && (
				<div class="editor-error" role="alert">
					{error}
					<button class="editor-error-dismiss" onClick={() => setError(null)}>×</button>
				</div>
			)}

			<main class="editor-main">
				{!hasDraft
					? <EmptyState onNew={onNewBlank} onUpload={() => fileRef.current?.click()} />
					: <ObjectEditor schema={worldSchema} path={[]} />}
			</main>

			{issues !== null && (
				<ValidationModal issues={issues} onClose={() => setIssues(null)} />
			)}
		</div>
	);
}

function ValidationModal({ issues, onClose }: { issues: Issue[]; onClose: () => void }) {
	const errors = issues.filter(i => i.severity === 'error');
	const warnings = issues.filter(i => i.severity === 'warning');
	return (
		<div class="modal-backdrop" onClick={onClose}>
			<div class="modal" onClick={(e) => e.stopPropagation()}>
				<div class="modal-header">
					Validation — {errors.length} error{errors.length === 1 ? '' : 's'},{' '}
					{warnings.length} warning{warnings.length === 1 ? '' : 's'}
				</div>
				<div class="modal-body" style="max-height: 60vh; overflow: auto">
					{issues.length === 0 ? (
						<p>No issues found.</p>
					) : (
						<ul class="editor-issue-list">
							{issues.map((i, idx) => (
								<li key={idx} class={`editor-issue editor-issue-${i.severity}`}>
									<div class="editor-issue-row1">
										<span class="editor-issue-sev">{i.severity}</span>
										{i.crumbs.length === 0
											? <span class="editor-issue-where">Scenario</span>
											: (
												<span class="editor-issue-where">
													{i.crumbs.map((c, ci) => (
														<>
															{ci > 0 && <span class="editor-issue-sep">›</span>}
															<span class="editor-issue-crumb">
																<span class="editor-issue-crumb-label">{c.label}</span>
																{' '}
																<span class="editor-issue-crumb-id">"{c.identifier}"</span>
															</span>
														</>
													))}
												</span>
											)}
									</div>
									<div class="editor-issue-row2">
										{i.field && <code class="editor-issue-field">{i.field}</code>}
										<span class="editor-issue-msg">{i.message}</span>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
				<div class="modal-footer">
					<button class="primary" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}

function EmptyState({ onNew, onUpload }: { onNew: () => void; onUpload: () => void }) {
	return (
		<div class="editor-empty">
			<h2>No scenario loaded</h2>
			<p>Start a new blank scenario, or upload an existing JSON file.</p>
			<div class="editor-empty-actions">
				<button onClick={onNew}>New blank scenario</button>
				<button onClick={onUpload}>Upload JSON…</button>
			</div>
		</div>
	);
}

/* ----------------------------- Helpers ----------------------------- */

/** Called by App on first mount when entering editor mode. Loads the
 * persisted draft if any; otherwise leaves draft null (the EmptyState
 * lets the user choose). */
export function ensureDraftLoaded(): void {
	if (draft.value !== null) return;
	const persisted = loadPersistedDraft();
	if (persisted) draft.value = persisted;
}
