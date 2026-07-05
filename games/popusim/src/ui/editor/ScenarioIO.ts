/**
 * Scenario JSON import/export helpers.
 *
 * Import: parse text, validate top-level shape, return a draft. Errors carry
 * a human-readable message that the editor surfaces in a modal.
 *
 * Export: serialize the draft to a downloadable file. Default-stripping is
 * intentionally NOT applied here — the draft is already in JSON shape and
 * keeping every set field as-is makes round-trips deterministic.
 */

import type { ScenarioJSON } from './state';

export interface ImportResult {
	ok: true;
	draft: ScenarioJSON;
}
export interface ImportError {
	ok: false;
	message: string;
}

export function parseScenarioText(text: string): ImportResult | ImportError {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, message: `Invalid JSON: ${(err as Error).message}` };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, message: 'Scenario must be a JSON object at the top level.' };
	}
	return { ok: true, draft: parsed as ScenarioJSON };
}

export async function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
		reader.readAsText(file);
	});
}

export function downloadScenario(draft: ScenarioJSON, filename?: string): void {
	const text = JSON.stringify(draft, null, '\t');
	const blob = new Blob([text], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const name = filename
		?? `${typeof draft.name === 'string' && draft.name ? sanitize(draft.name) : 'scenario'}.json`;
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function sanitize(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'scenario';
}

/** A new, empty scenario. Just enough scaffolding to be openable in the
 * editor without crashing. The simulator won't run this until the user
 * adds a phase, a site, and at least one trait. */
export function blankScenario(): ScenarioJSON {
	return {
		name: 'New Scenario',
		start_date: new Date().toISOString().slice(0, 10),
		trait: [],
		vector: [],
		action: [],
		resource: [],
		guigroup: [],
		phase: [],
		site: [],
		event: [],
	};
}
