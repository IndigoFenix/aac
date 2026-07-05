/**
 * Field renderer dispatcher. Maps a Field's `kind` to the correct
 * component and returns a JSX element. Centralizing the switch here means
 * ObjectEditor doesn't have to know about every field kind.
 *
 * Special case: when a `string` field with key === 'key' renders for a
 * top-level renameable object (path of the form `[<listKey>, <idx>]`),
 * we route to KeyFieldRenderer instead — which defers commit until blur
 * and prompts to update cross-references on rename.
 */

import {
	BoolFieldRenderer, NumberFieldRenderer, StringFieldRenderer,
	TextFieldRenderer, DateFieldRenderer, SelectFieldRenderer,
} from './PrimitiveFields';
import {
	RefFieldRenderer, RefListFieldRenderer, NumberOrRefFieldRenderer,
} from './RefFields';
import {
	ColorFieldRenderer, PointFieldRenderer,
	ImageFieldRenderer, SoundFieldRenderer, ExpressionFieldRenderer,
} from './SpecialFields';
import { ChildrenFieldRenderer } from './ChildrenField';
import { KeyFieldRenderer } from './KeyField';
import type { Field, ListKey } from '../../schema';
import type { Path } from '../../state';

const RENAMEABLE_LISTS: ReadonlySet<string> = new Set([
	'trait', 'vector', 'resource', 'action', 'guigroup', 'phase', 'site', 'event',
] satisfies ListKey[]);

function renameableListAt(path: Path): ListKey | null {
	if (path.length !== 2) return null;
	const list = path[0];
	if (typeof list !== 'string' || !RENAMEABLE_LISTS.has(list)) return null;
	if (typeof path[1] !== 'number') return null;
	return list as ListKey;
}

export function renderField(field: Field, path: Path) {
	switch (field.kind) {
		case 'bool':        return <BoolFieldRenderer        key={field.key} field={field} path={path} />;
		case 'number':      return <NumberFieldRenderer      key={field.key} field={field} path={path} />;
		case 'string': {
			if (field.key === 'key') {
				const list = renameableListAt(path);
				if (list !== null) {
					return <KeyFieldRenderer key={field.key} field={field} path={path} list={list} />;
				}
			}
			return <StringFieldRenderer key={field.key} field={field} path={path} />;
		}
		case 'text':        return <TextFieldRenderer        key={field.key} field={field} path={path} />;
		case 'date':        return <DateFieldRenderer        key={field.key} field={field} path={path} />;
		case 'select':      return <SelectFieldRenderer      key={field.key} field={field} path={path} />;
		case 'color':       return <ColorFieldRenderer       key={field.key} field={field} path={path} />;
		case 'point':       return <PointFieldRenderer       key={field.key} field={field} path={path} />;
		case 'ref':         return <RefFieldRenderer         key={field.key} field={field} path={path} />;
		case 'refList':     return <RefListFieldRenderer     key={field.key} field={field} path={path} />;
		case 'numberOrRef': return <NumberOrRefFieldRenderer key={field.key} field={field} path={path} />;
		case 'image':       return <ImageFieldRenderer       key={field.key} field={field} path={path} />;
		case 'sound':       return <SoundFieldRenderer       key={field.key} field={field} path={path} />;
		case 'expression':  return <ExpressionFieldRenderer  key={field.key} field={field} path={path} />;
		case 'children':    return <ChildrenFieldRenderer    key={field.key} field={field} path={path} />;
	}
}
