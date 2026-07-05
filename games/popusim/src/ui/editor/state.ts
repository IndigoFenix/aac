/**
 * Scenario editor state.
 *
 * The editor works on a plain JSON draft — the same shape `client.start(...)`
 * accepts. We deliberately do not instantiate Trait/Vector/etc. here; the
 * editor's source of truth for shape is `./schema/`, not the sim classes.
 *
 * The draft is auto-saved to localStorage on every change. Hitting "Start"
 * hands the draft to SimClient and switches `ui.mode` back to `'gameplay'`.
 */

import { signal } from '@preact/signals';

export type ScenarioJSON = Record<string, unknown>;

export type Path = (string | number)[];

const STORAGE_KEY = 'pathogenic.editor.draft.v1';

export const draft = signal<ScenarioJSON | null>(null);

/**
 * Selection is a stack of paths into the draft. The last entry is the
 * currently-edited object; earlier entries are its ancestors and let us
 * render breadcrumbs / "back" navigation.
 */
export const selection = signal<Path[]>([]);

/** Bumped by every applyEdit. Computed signals can depend on this without
 * cloning the whole tree. */
export const version = signal(0);

/** Module-level clipboard for Copy/Paste between lists. Holds raw JSON and
 * the schema tag of the source, so paste targets can validate compatibility. */
export interface Clipboard { tag: string; data: unknown }
export const clipboard = signal<Clipboard | null>(null);

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/* ---------------------------- Draft mutation ----------------------------- */

export function setDraft(next: ScenarioJSON | null): void {
	draft.value = next;
	selection.value = [];
	version.value++;
	schedulePersist();
}

/** Apply an immutable edit to the draft at `path`. */
export function applyEdit(path: Path, value: unknown): void {
	const cur = draft.value;
	if (cur === null) return;
	draft.value = setIn(cur, path, value) as ScenarioJSON;
	version.value++;
	schedulePersist();
}

/** Replace the draft wholesale with an already-prepared next state.
 * Used by transactional updates (rename + reference rewrite, delete +
 * reference clear) so multiple edits land in one render and one persist
 * cycle. Selection is preserved; callers must pass a draft that's still
 * valid for the current selection (e.g. don't use this to delete the
 * currently-selected object). */
export function mutateDraft(next: ScenarioJSON): void {
	draft.value = next;
	version.value++;
	schedulePersist();
}

/** Read a value out of the draft by path. Returns undefined if any segment
 * is missing. */
export function getIn(obj: unknown, path: Path): unknown {
	let cur: unknown = obj;
	for (const seg of path) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur)) cur = cur[seg as number];
		else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg as string];
		else return undefined;
	}
	return cur;
}

/** Pure immutable set. Creates intermediate objects/arrays as needed. */
export function setIn(obj: unknown, path: Path, value: unknown): unknown {
	if (path.length === 0) return value;
	const [head, ...rest] = path;
	if (typeof head === 'number') {
		const arr = Array.isArray(obj) ? (obj as unknown[]).slice() : [];
		arr[head] = setIn(arr[head], rest, value);
		return arr;
	}
	const o = (obj && typeof obj === 'object' && !Array.isArray(obj))
		? { ...(obj as Record<string, unknown>) }
		: {};
	o[head] = setIn(o[head], rest, value);
	return o;
}

/** Pure immutable delete-at-path. If the parent ends up empty (object has
 * no keys, array has length 0) we leave it as-is — callers that want
 * default-stripping should run that pass during export instead. */
export function deleteIn(obj: unknown, path: Path): unknown {
	if (path.length === 0) return undefined;
	const [head, ...rest] = path;
	if (rest.length === 0) {
		if (typeof head === 'number' && Array.isArray(obj)) {
			const arr = (obj as unknown[]).slice();
			arr.splice(head, 1);
			return arr;
		}
		if (typeof head === 'string' && obj && typeof obj === 'object') {
			const o = { ...(obj as Record<string, unknown>) };
			delete o[head];
			return o;
		}
		return obj;
	}
	if (typeof head === 'number') {
		const arr = Array.isArray(obj) ? (obj as unknown[]).slice() : [];
		arr[head] = deleteIn(arr[head], rest);
		return arr;
	}
	const o = (obj && typeof obj === 'object' && !Array.isArray(obj))
		? { ...(obj as Record<string, unknown>) }
		: {};
	o[head as string] = deleteIn(o[head as string], rest);
	return o;
}

export function deleteAt(path: Path): void {
	const cur = draft.value;
	if (cur === null) return;
	draft.value = deleteIn(cur, path) as ScenarioJSON;
	version.value++;
	schedulePersist();
}

/** Move an item inside an array referenced by `listPath` from index `from`
 * to index `to`. */
export function moveItem(listPath: Path, from: number, to: number): void {
	const cur = draft.value;
	if (cur === null) return;
	const list = getIn(cur, listPath);
	if (!Array.isArray(list)) return;
	if (from < 0 || from >= list.length) return;
	const clamped = Math.max(0, Math.min(to, list.length - 1));
	if (clamped === from) return;
	const next = (list as unknown[]).slice();
	const [item] = next.splice(from, 1);
	next.splice(clamped, 0, item);
	applyEdit(listPath, next);
}

/* ----------------------------- Persistence ------------------------------ */

function schedulePersist(): void {
	if (persistTimer !== null) clearTimeout(persistTimer);
	persistTimer = setTimeout(persistNow, 250);
}

function persistNow(): void {
	persistTimer = null;
	if (typeof localStorage === 'undefined') return;
	try {
		if (draft.value === null) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, JSON.stringify(draft.value));
	} catch {
		// Quota or disabled — silently drop.
	}
}

export function loadPersistedDraft(): ScenarioJSON | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return (typeof parsed === 'object' && parsed !== null) ? parsed as ScenarioJSON : null;
	} catch {
		return null;
	}
}

export function clearPersistedDraft(): void {
	if (typeof localStorage === 'undefined') return;
	try { localStorage.removeItem(STORAGE_KEY); } catch { /* drop */ }
}
