/**
 * KeyField — special string-field renderer for the `key` field on a
 * top-level object (Trait, Vector, Resource, etc).
 *
 * Differs from StringFieldRenderer in two ways:
 *  1. Commit is deferred to blur / Enter, not every keystroke. While the
 *     user is typing "infectious" we don't want every intermediate
 *     "infe" / "infec" / "infect" to count as a rename.
 *  2. On commit, if the key actually changed and other objects reference
 *     this key, prompt the user to update those references atomically.
 *
 * Used only when ObjectEditor renders the `key` field on a top-level
 * renameable; nested objects without rename impact (Seek, ActionCost,
 * etc.) keep using StringFieldRenderer.
 */

import { useEffect, useState } from 'preact/hooks';
import { FieldShell, useDraftValue, applyEdit, genId } from './common';
import { useMemo } from 'preact/hooks';
import { findReferences, applyRenameRefs, type RefSite } from '../../refScan';
import { RefImpactModal } from '../RefImpactModal';
import { draft, mutateDraft, setIn } from '../../state';
import type { Path } from '../../state';
import type { StringField, ListKey } from '../../schema';

interface Props { field: StringField; path: Path; list: ListKey }

export function KeyFieldRenderer({ field, path, list }: Props) {
	const id = useMemo(() => genId('key'), []);
	const committed = useDraftValue([...path, field.key]);
	const committedStr = typeof committed === 'string' ? committed : '';

	// Local state for the input while the user types. Resyncs whenever the
	// draft's committed value changes (e.g. after applying a rename).
	const [pending, setPending] = useState(committedStr);
	useEffect(() => { setPending(committedStr); }, [committedStr]);

	const [modal, setModal] = useState<null | { newKey: string; sites: RefSite[] }>(null);

	function tryCommit(next: string) {
		if (next === committedStr) return;
		if (next.length === 0) {
			// Empty key isn't allowed — revert silently.
			setPending(committedStr);
			return;
		}
		const sites = findReferences(draft.value, list, committedStr);
		if (sites.length === 0) {
			// No references; just write the change.
			applyEdit([...path, field.key], next);
			return;
		}
		// Stage the rename behind a confirm.
		setModal({ newKey: next, sites });
	}

	function applyRenameNow() {
		if (!modal || !draft.value) return;
		const { newKey, sites } = modal;
		// One transactional write: change this object's key + rewrite refs.
		let scenario = setIn(draft.value, [...path, field.key], newKey) as Record<string, unknown>;
		scenario = applyRenameRefs(scenario, sites, committedStr, newKey);
		mutateDraft(scenario);
		setModal(null);
	}

	function applyRenameKeyOnly() {
		if (!modal) return;
		applyEdit([...path, field.key], modal.newKey);
		setModal(null);
	}

	function cancelRename() {
		setPending(committedStr);
		setModal(null);
	}

	return (
		<>
			<FieldShell label={field.label} help={field.help} htmlFor={id}>
				<input
					id={id}
					type="text"
					value={pending}
					onInput={(e) => setPending((e.currentTarget as HTMLInputElement).value)}
					onBlur={() => tryCommit(pending)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							(e.currentTarget as HTMLInputElement).blur();
						} else if (e.key === 'Escape') {
							setPending(committedStr);
							(e.currentTarget as HTMLInputElement).blur();
						}
					}}
				/>
			</FieldShell>
			{modal && (
				<RefImpactModal
					title={`Rename "${committedStr}" → "${modal.newKey}"?`}
					body={`Other objects refer to "${committedStr}".`}
					sites={modal.sites}
					impactVerb="update"
					primaryLabel="Rename + update references"
					secondaryLabel="Rename only (leave dangling)"
					onPrimary={applyRenameNow}
					onSecondary={applyRenameKeyOnly}
					onCancel={cancelRename}
				/>
			)}
		</>
	);
}
