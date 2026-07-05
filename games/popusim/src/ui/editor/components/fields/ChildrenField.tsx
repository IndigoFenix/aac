/**
 * ChildrenField — renders a child list (`kind: 'children'`) by delegating
 * to ObjectList. The list lives at `[...path, field.key]` in the draft.
 */

import { ObjectList } from '../ObjectList';
import { applyEdit, draft, getIn, type Path } from '../../state';
import type { ChildrenField as ChildrenFieldType } from '../../schema';

export function ChildrenFieldRenderer({ field, path }: { field: ChildrenFieldType; path: Path }) {
	const here = [...path, field.key];

	// Auto-create empty arrays when missing so the user can immediately add
	// items without seeing a "Unknown" error.
	const cur = getIn(draft.value, here);
	if (cur === undefined || cur === null) {
		// Defer to a microtask to avoid mutating during render.
		queueMicrotask(() => {
			if (getIn(draft.value, here) === undefined) applyEdit(here, []);
		});
	}

	return (
		<div class="editor-field editor-field-children">
			<div class="editor-field-label">
				<span>{field.label}</span>
				{field.help && <span class="editor-field-help" title={field.help}>?</span>}
			</div>
			<ObjectList schemaTag={field.itemTag} listPath={here} />
		</div>
	);
}
