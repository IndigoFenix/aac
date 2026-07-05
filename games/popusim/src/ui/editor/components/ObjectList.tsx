/**
 * ObjectList — editable list of child objects within the draft.
 *
 * Capabilities:
 *  - Add (uses `schema.blank()`).
 *  - Paste (only when clipboard.tag matches schema.tag).
 *  - Copy / Delete per row.
 *  - Reorder via ↑/↓ buttons or by dragging the handle.
 *  - Click a row to expand/collapse its inline editor below the list.
 *
 * The list works on a Path into the draft, so it can be reused at any
 * nesting depth.
 */

import { useMemo, useState } from 'preact/hooks';
import { ObjectEditor } from './ObjectEditor';
import {
	applyEdit, deleteAt, deleteIn, moveItem, draft, getIn, mutateDraft,
	clipboard, type Path,
} from '../state';
import type { ObjectSchema, ListKey } from '../schema';
import { getSchema } from '../schema';
import { findReferences, applyClearRefs, type RefSite } from '../refScan';
import { RefImpactModal } from './RefImpactModal';

/** Lists whose items are reference targets — deleting one of these may
 * cascade through the draft. Mirrors the set in fields/index.tsx. */
const RENAMEABLE_LISTS: ReadonlySet<string> = new Set([
	'trait', 'vector', 'resource', 'action', 'guigroup', 'phase', 'site', 'event',
] satisfies ListKey[]);

function listKeyForTopLevelDelete(listPath: Path): ListKey | null {
	if (listPath.length !== 1) return null;
	const k = listPath[0];
	return typeof k === 'string' && RENAMEABLE_LISTS.has(k) ? k as ListKey : null;
}

/** Custom MIME type so drops are scoped to editor lists and won't be
 * accepted by random drop targets on the page (or vice versa). The drop
 * payload is the listId; the row index is encoded in the same string so
 * we can validate same-list before moving anything. */
const DRAG_MIME = 'application/x-pathogenic-listrow';
function encodeDrag(listId: string, fromIdx: number): string {
	return `${listId}::${fromIdx}`;
}
function decodeDrag(raw: string): { listId: string; fromIdx: number } | null {
	const sep = raw.indexOf('::');
	if (sep < 0) return null;
	const listId = raw.slice(0, sep);
	const fromIdx = parseInt(raw.slice(sep + 2), 10);
	if (!Number.isFinite(fromIdx)) return null;
	return { listId, fromIdx };
}

interface Props {
	schemaTag: string;
	listPath: Path;
}

export function ObjectList({ schemaTag, listPath }: Props) {
	const schema = getSchema(schemaTag);
	if (!schema) {
		return <div class="editor-error-inline">Unknown schema: {schemaTag}</div>;
	}
	// Reading draft.value subscribes this component to draft changes via
	// @preact/preset-vite signal tracking.
	const list = getIn(draft.value, listPath);
	const items: Record<string, unknown>[] = Array.isArray(list)
		? list as Record<string, unknown>[]
		: [];

	const [openIdx, setOpenIdx] = useState<number | null>(null);

	// Pending delete-with-references confirmation. Populated when the user
	// clicks delete on a top-level renameable that has any inbound refs.
	const [pendingDelete, setPendingDelete] = useState<null | {
		idx: number;
		key: string;
		list: ListKey;
		sites: RefSite[];
	}>(null);

	// Stable per-list identity for drag scoping. JSON.stringify(listPath) is
	// stable across re-renders (path arrays are recreated each render but
	// their contents are stable) and uniquely identifies this ObjectList
	// inside a draft, including nested lists with the same schema tag.
	const listId = useMemo(() => JSON.stringify(listPath), [JSON.stringify(listPath)]);

	function addNew() {
		const next = items.slice();
		next.push(schema!.blank());
		applyEdit(listPath, next);
		setOpenIdx(next.length - 1);
	}

	function pasteFromClipboard() {
		const c = clipboard.value;
		if (!c || c.tag !== schema!.tag) return;
		const cloned = JSON.parse(JSON.stringify(c.data)) as Record<string, unknown>;
		const next = items.slice();
		next.push(cloned);
		applyEdit(listPath, next);
		setOpenIdx(next.length - 1);
	}

	function copyRow(idx: number) {
		clipboard.value = { tag: schema!.tag, data: JSON.parse(JSON.stringify(items[idx])) };
	}

	function deleteRow(idx: number) {
		// Top-level renameables (Trait, Vector, etc) get the reference-aware
		// delete flow. Everything else uses the simple confirm.
		const list = listKeyForTopLevelDelete(listPath);
		if (list !== null) {
			const item = items[idx];
			const key = typeof item?.key === 'string' ? item.key : '';
			if (key.length > 0) {
				const sites = findReferences(draft.value, list, key);
				if (sites.length > 0) {
					setPendingDelete({ idx, key, list, sites });
					return;
				}
			}
		}
		if (!confirm(`Delete this ${schema!.label}?`)) return;
		performSimpleDelete(idx);
	}

	function performSimpleDelete(idx: number) {
		deleteAt([...listPath, idx]);
		setOpenIdx(prev => (prev === null ? null : prev === idx ? null : prev > idx ? prev - 1 : prev));
	}

	function performDeleteAndClear() {
		if (!pendingDelete || !draft.value) return;
		const { idx, key, list, sites } = pendingDelete;
		// Atomic: clear all refs to `key`, then drop the object itself.
		// Order matters — the references' parent paths are computed against
		// the pre-deletion draft, so we apply the ref-clears first and then
		// remove the object. (Indices in those parent paths are unaffected
		// because none of them point inside the soon-to-be-deleted object.)
		let next = applyClearRefs(draft.value, sites, key);
		next = deleteIn(next, [...listPath, idx]) as Record<string, unknown>;
		mutateDraft(next);
		setOpenIdx(prev => (prev === null ? null : prev === idx ? null : prev > idx ? prev - 1 : prev));
		setPendingDelete(null);
	}

	function performDeleteOnly() {
		if (!pendingDelete) return;
		performSimpleDelete(pendingDelete.idx);
		setPendingDelete(null);
	}

	function moveByDelta(idx: number, delta: number) {
		const to = idx + delta;
		moveItem(listPath, idx, to);
		setOpenIdx(prev => (prev === null ? null : prev === idx ? Math.max(0, Math.min(items.length - 1, to)) : prev));
	}

	function reorder(from: number, to: number) {
		if (from === to) return;
		moveItem(listPath, from, to);
		setOpenIdx(prev => {
			if (prev === null) return null;
			if (prev === from) return to;
			// Adjust open index if the moved item passed it.
			if (from < prev && to >= prev) return prev - 1;
			if (from > prev && to <= prev) return prev + 1;
			return prev;
		});
	}

	const canPaste = clipboard.value?.tag === schema.tag;

	return (
		<div class="editor-list">
			<div class="editor-list-header">
				<span class="editor-list-count">{items.length} {schema.label}{items.length === 1 ? '' : 's'}</span>
				<div class="editor-list-actions">
					<button type="button" onClick={addNew}>+ New</button>
					<button type="button" onClick={pasteFromClipboard} disabled={!canPaste} title={canPaste ? 'Paste from clipboard' : 'Clipboard is empty or has a different type'}>Paste</button>
				</div>
			</div>
			{items.length === 0 && <div class="editor-empty-list">No items.</div>}
			<ul class="editor-list-rows">
				{items.map((item, idx) => (
					<ListRow
						key={`row-${idx}`}
						idx={idx}
						count={items.length}
						item={item}
						schema={schema!}
						listId={listId}
						isOpen={openIdx === idx}
						onToggle={() => setOpenIdx(p => p === idx ? null : idx)}
						onMoveUp={() => moveByDelta(idx, -1)}
						onMoveDown={() => moveByDelta(idx, +1)}
						onReorder={reorder}
						onCopy={() => copyRow(idx)}
						onDelete={() => deleteRow(idx)}
						listPath={listPath}
					/>
				))}
			</ul>
			{pendingDelete && (
				<RefImpactModal
					title={`Delete ${schema.label} "${pendingDelete.key}"?`}
					body={`Other objects refer to "${pendingDelete.key}".`}
					sites={pendingDelete.sites}
					impactVerb="clear"
					primaryLabel="Delete + clear references"
					primaryDestructive
					secondaryLabel="Delete only (leave dangling)"
					onPrimary={performDeleteAndClear}
					onSecondary={performDeleteOnly}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
		</div>
	);
}

/* --------------------------- one row ---------------------------------- */

interface RowProps {
	idx: number;
	count: number;
	item: Record<string, unknown>;
	schema: ObjectSchema;
	listId: string;
	isOpen: boolean;
	onToggle: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	/** Move source `from` to target `to`, both indices in this list. */
	onReorder: (from: number, to: number) => void;
	onCopy: () => void;
	onDelete: () => void;
	listPath: Path;
}

function ListRow({
	idx, count, item, schema, listId, isOpen,
	onToggle, onMoveUp, onMoveDown, onReorder, onCopy, onDelete, listPath,
}: RowProps) {
	const [dragging, setDragging] = useState(false);
	const [dropZone, setDropZone] = useState<null | 'above' | 'below'>(null);

	function onDragStart(e: DragEvent) {
		if (!e.dataTransfer) return;
		setDragging(true);
		e.dataTransfer.setData(DRAG_MIME, encodeDrag(listId, idx));
		// Some browsers require a text/plain fallback for drag to start at all.
		e.dataTransfer.setData('text/plain', String(idx));
		e.dataTransfer.effectAllowed = 'move';
	}
	function onDragEnd() {
		setDragging(false);
		setDropZone(null);
	}

	/** True iff the drag in flight originated in OUR list. We can only
	 * peek at types during dragOver — getData returns '' until drop. */
	function isOurDrag(e: DragEvent): boolean {
		if (!e.dataTransfer) return false;
		// dataTransfer.types is a DOMStringList in some browsers and
		// string[] in others; Array.from handles both.
		const types = Array.from(e.dataTransfer.types ?? []);
		return types.includes(DRAG_MIME);
	}

	function onDragOver(e: DragEvent) {
		if (!isOurDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const tgt = e.currentTarget as HTMLElement;
		const rect = tgt.getBoundingClientRect();
		setDropZone((e.clientY - rect.top) > rect.height / 2 ? 'below' : 'above');
	}
	function onDragLeave() {
		setDropZone(null);
	}
	function onDrop(e: DragEvent) {
		setDropZone(null);
		if (!e.dataTransfer) return;
		const raw = e.dataTransfer.getData(DRAG_MIME);
		const decoded = raw ? decodeDrag(raw) : null;
		// Only handle drops from our own list. If the source is a different
		// list (or no list at all), leave the event alone — without
		// preventDefault the browser will treat it as a no-op and
		// stopPropagation will keep nested lists from interpreting it.
		if (!decoded || decoded.listId !== listId) return;
		e.preventDefault();
		e.stopPropagation();
		const { fromIdx } = decoded;
		if (fromIdx === idx) return;
		// Compute target index. Drop on upper half of row N → land at N
		// (push N down). Lower half → land at N + 1. Adjust for the
		// removal of the source element when source is above target.
		const tgt = e.currentTarget as HTMLElement;
		const rect = tgt.getBoundingClientRect();
		const inLowerHalf = (e.clientY - rect.top) > rect.height / 2;
		let to = idx + (inLowerHalf ? 1 : 0);
		if (fromIdx < to) to -= 1;
		onReorder(fromIdx, to);
	}

	const label = schema.rowLabel(item);
	const cls = [
		'editor-list-row',
		dragging ? 'dragging' : '',
		isOpen ? 'open' : '',
		dropZone === 'above' ? 'drop-above' : '',
		dropZone === 'below' ? 'drop-below' : '',
	].filter(Boolean).join(' ');

	return (
		<li
			class={cls}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<div class="editor-list-row-bar">
				<span
					class="editor-list-handle"
					draggable
					onDragStart={onDragStart}
					onDragEnd={onDragEnd}
					title="Drag to reorder"
				>⋮⋮</span>
				<button type="button" class="editor-list-row-label" onClick={onToggle}>
					<span class="editor-list-row-chev">{isOpen ? '▾' : '▸'}</span>
					<span class="editor-list-row-text">{label}</span>
				</button>
				<div class="editor-list-row-actions">
					<button type="button" onClick={onMoveUp}   disabled={idx === 0}            title="Move up">↑</button>
					<button type="button" onClick={onMoveDown} disabled={idx === count - 1}    title="Move down">↓</button>
					<button type="button" onClick={onCopy}                                     title="Copy to clipboard">⧉</button>
					<button type="button" onClick={onDelete}                                   title="Delete">×</button>
				</div>
			</div>
			{isOpen && (
				<div class="editor-list-row-body">
					<ObjectEditor schema={schema} path={[...listPath, idx]} />
				</div>
			)}
		</li>
	);
}
