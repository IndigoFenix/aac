/**
 * ObjectEditor — renders one object's schema against a path into the draft.
 *
 * Recursive: ChildrenField renders an ObjectList, whose selected item is
 * rendered by another ObjectEditor.
 */

import { Section } from './Section';
import { renderField } from './fields';
import type { ObjectSchema, Section as SchemaSection } from '../schema';
import type { Path } from '../state';

interface Props {
	schema: ObjectSchema;
	path: Path;
}

export function ObjectEditor({ schema, path }: Props) {
	return <div class="editor-object">{renderSection(schema.layout, path)}</div>;
}

function renderSection(section: SchemaSection, path: Path) {
	if (section.kind === 'fields') {
		return (
			<div class="editor-fields">
				{section.fields.map(f => renderField(f, path))}
			</div>
		);
	}
	return (
		<Section label={section.label} openByDefault={section.openByDefault !== false}>
			{section.sections.map(s => renderSection(s, path))}
		</Section>
	);
}
