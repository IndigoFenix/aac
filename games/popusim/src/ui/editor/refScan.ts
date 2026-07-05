/**
 * Reference scanner — finds and rewrites cross-object references in a draft.
 *
 * Used by the rename and delete-with-references flows. The walk is driven
 * by the schema registry so any field declared with `kind: 'ref' |
 * 'refList' | 'numberOrRef'` is automatically discovered (no hand-coded
 * field list to keep in sync).
 *
 * All mutators are pure: they take a scenario and return a new one, never
 * mutating the input. Callers swap in the result via `mutateDraft`.
 */

import { worldSchema, getSchema } from './schema';
import type { ObjectSchema, Field, ListKey } from './schema';
import { walkFields } from './schema/types';
import type { ScenarioJSON, Path } from './state';
import { setIn, getIn } from './state';

export interface RefSite {
	/** Path to the parent object that holds this reference. */
	parentPath: Path;
	/** Schema of the parent object — used to label the site for the user
	 * ("3 references on Transmit objects, 2 on Modifier objects"). */
	parentSchema: ObjectSchema;
	/** Field key on the parent that holds the reference. */
	fieldKey: string;
	/** True for refList (an array); false for ref / numberOrRef (single value). */
	multi: boolean;
}

/* ------------------------------ scan ---------------------------------- */

/** Find every site in `scenario` that references `(list, targetKey)`. */
export function findReferences(
	scenario: ScenarioJSON | null,
	list: ListKey,
	targetKey: string,
): RefSite[] {
	if (!scenario) return [];
	const sites: RefSite[] = [];
	walk(scenario, worldSchema, [], (field, value, parentPath, parentSchema) => {
		if (matchesField(field, value, list, targetKey)) {
			sites.push({
				parentPath,
				parentSchema,
				fieldKey: field.key,
				multi: field.kind === 'refList',
			});
		}
	});
	return sites;
}

function matchesField(field: Field, value: unknown, list: ListKey, targetKey: string): boolean {
	switch (field.kind) {
		case 'ref':
		case 'numberOrRef':
			return field.list === list && value === targetKey;
		case 'refList':
			return field.list === list && toStringList(value).includes(targetKey);
		default:
			return false;
	}
}

function walk(
	obj: Record<string, unknown> | null | undefined,
	schema: ObjectSchema,
	path: Path,
	visit: (field: Field, value: unknown, parentPath: Path, parentSchema: ObjectSchema) => void,
): void {
	if (!obj) return;
	for (const f of walkFields(schema.layout) as Iterable<Field>) {
		const value = obj[f.key];
		visit(f, value, path, schema);
		if (f.kind === 'children' && Array.isArray(value)) {
			const childSchema = getSchema(f.itemTag);
			if (!childSchema) continue;
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (item && typeof item === 'object') {
					walk(
						item as Record<string, unknown>,
						childSchema,
						[...path, f.key, i],
						visit,
					);
				}
			}
		}
	}
}

/* ----------------------------- mutators ------------------------------- */

/** Rewrite each site's reference value from `oldKey` to `newKey`. The
 * scenario passed in is not mutated; a new one is returned. */
export function applyRenameRefs(
	scenario: ScenarioJSON,
	sites: RefSite[],
	oldKey: string,
	newKey: string,
): ScenarioJSON {
	let next: unknown = scenario;
	for (const site of sites) {
		const fieldPath = [...site.parentPath, site.fieldKey];
		const cur = getIn(next, fieldPath);
		if (site.multi) {
			const arr = toStringList(cur).map(v => v === oldKey ? newKey : v);
			next = setIn(next, fieldPath, arr);
		} else {
			next = setIn(next, fieldPath, newKey);
		}
	}
	return next as ScenarioJSON;
}

/** Remove `targetKey` from every site. For refList fields, the entry is
 * filtered out; for ref / numberOrRef fields, the value is set to ''. */
export function applyClearRefs(
	scenario: ScenarioJSON,
	sites: RefSite[],
	targetKey: string,
): ScenarioJSON {
	let next: unknown = scenario;
	for (const site of sites) {
		const fieldPath = [...site.parentPath, site.fieldKey];
		const cur = getIn(next, fieldPath);
		if (site.multi) {
			const arr = toStringList(cur).filter(v => v !== targetKey);
			next = setIn(next, fieldPath, arr);
		} else {
			next = setIn(next, fieldPath, '');
		}
	}
	return next as ScenarioJSON;
}

/* ------------------------------ helpers ------------------------------- */

/** Group sites by their parent schema's label, returning {label, count}
 * pairs sorted by descending count. Used by RefImpactModal for the
 * "5 Transmit, 3 Modifier, …" summary. */
export function summarizeSites(sites: RefSite[]): { label: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const s of sites) {
		counts.set(s.parentSchema.label, (counts.get(s.parentSchema.label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count);
}

function toStringList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).filter(s => s.length > 0);
	if (typeof v === 'string' && v.length > 0) return v.split(',').map(s => s.trim()).filter(Boolean);
	return [];
}
