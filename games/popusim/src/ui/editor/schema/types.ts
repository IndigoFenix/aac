/**
 * Typed schema for the scenario editor.
 *
 * The editor's source of truth for "what fields exist on object X". A
 * discriminated union of strongly-typed field descriptors plus a separate
 * `Section` tree for layout.
 *
 * Conventions:
 *  - Top-level scenario JSON keys for child arrays are SINGULAR (`trait`,
 *    `vector`, `event`, ...). Every `ChildrenField.key` here uses the
 *    singular form for that reason.
 *  - "ref" / "refList" / "numberOrRef" point at one of the top-level lists
 *    via `list: ListKey`. The editor reads the live draft so option lists
 *    update on every edit.
 */

/** The top-level lists that fields can reference. Indexes into the
 * scenario JSON's singular-named child arrays. */
export type ListKey =
	| 'trait'
	| 'vector'
	| 'resource'
	| 'action'
	| 'guigroup'
	| 'phase'
	| 'site'
	| 'event';

export interface BaseField {
	/** JSON key on the parent object. */
	key: string;
	/** Label shown in the editor. */
	label: string;
	/** Tooltip / inline help. */
	help?: string;
	/** Hide from non-advanced editor mode. */
	advanced?: boolean;
	/** True if this attribute should also be hidden from the editor when
	 * empty/falsy on the parent. (For now treat all as visible.) */
	hidden?: boolean;
}

export interface StringField extends BaseField { kind: 'string'; default?: string }
export interface TextField extends BaseField { kind: 'text'; default?: string }
export interface NumberField extends BaseField {
	kind: 'number';
	default?: number;
	min?: number;
	max?: number;
	step?: number;
	int?: boolean;
}
export interface BoolField extends BaseField { kind: 'bool'; default?: boolean }
export interface DateField extends BaseField { kind: 'date'; default?: string }
export interface SelectField extends BaseField {
	kind: 'select';
	default?: string;
	options: { value: string; label: string }[];
}
export interface ColorField extends BaseField { kind: 'color'; default?: string }
export interface PointField extends BaseField { kind: 'point'; default?: [number, number] }
export interface RefField extends BaseField { kind: 'ref'; list: ListKey; default?: string }
export interface RefListField extends BaseField { kind: 'refList'; list: ListKey }
export interface NumberOrRefField extends BaseField {
	kind: 'numberOrRef';
	list: ListKey;
	default?: number;
	min?: number;
	max?: number;
	step?: number;
}
export interface ExpressionField extends BaseField { kind: 'expression' }
export interface ImageField extends BaseField { kind: 'image' }
export interface SoundField extends BaseField { kind: 'sound' }
export interface ChildrenField extends BaseField {
	kind: 'children';
	/** Schema tag of items inside this list. Looked up in SCHEMAS at render
	 * time, so we don't carry an ObjectSchema reference (avoids cycles). */
	itemTag: string;
}

export type Field =
	| StringField | TextField | NumberField | BoolField | DateField
	| SelectField | ColorField | PointField
	| RefField | RefListField | NumberOrRefField
	| ExpressionField | ImageField | SoundField
	| ChildrenField;

/** Section tree — separates UI layout from the data fields themselves.
 * `Section` either holds a flat list of fields or contains nested sections
 * (a labeled, optionally collapsible group). */
export type Section =
	| { kind: 'fields'; fields: Field[] }
	| { kind: 'group'; label: string; openByDefault?: boolean; sections: Section[] };

export interface ObjectSchema {
	/** Unique tag, matched by `ChildrenField.itemTag` and also used as the
	 * Clipboard.tag so paste targets can validate compatibility. */
	tag: string;
	/** Display label used in "Add new {label}" buttons and breadcrumbs. */
	label: string;
	/** A new, empty JSON instance. The editor calls this when the user
	 * clicks "New" in an ObjectList. */
	blank: () => Record<string, unknown>;
	/** Best-effort row label for a list item. Falls back to "(unnamed)". */
	rowLabel: (item: Record<string, unknown>) => string;
	/** Layout root — a section tree describing how this object's fields
	 * group visually. */
	layout: Section;
}

/* --------------------------- Helpers ---------------------------------- */

export function fields(...fs: Field[]): Section {
	return { kind: 'fields', fields: fs };
}

export function group(label: string, sections: Section[], openByDefault = true): Section {
	return { kind: 'group', label, sections, openByDefault };
}

/** Walk a Section tree and yield every Field. Used by the editor to find
 * fields by key (rename/delete reference scans, validation, etc.). */
export function* walkFields(section: Section): Generator<Field> {
	if (section.kind === 'fields') {
		for (const f of section.fields) yield f;
		return;
	}
	for (const s of section.sections) yield* walkFields(s);
}

export function findField(schema: ObjectSchema, key: string): Field | null {
	for (const f of walkFields(schema.layout)) {
		if (f.key === key) return f;
	}
	return null;
}
