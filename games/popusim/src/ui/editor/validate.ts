/**
 * Scenario validation. Walks the draft against the schemas and produces a
 * list of issues. Issues carry breadcrumbs (object-identity per level)
 * rather than raw JSON paths, so the modal can render
 *   `Trait "infected" › Transmit "+immune by recovery"`
 * instead of `world.trait[5].transmit[0]`.
 *
 * Surfaced in the editor's "Validate" modal — non-blocking; the user can
 * still Start a scenario with warnings (the simulator will fail loudly if
 * anything is actually broken at load time).
 */

import { worldSchema, getSchema } from './schema';
import type { ObjectSchema, Field } from './schema';
import { walkFields } from './schema/types';
import type { ScenarioJSON } from './state';

export type Severity = 'error' | 'warning';

/** One step in the path to an issue. `label` is the schema's display name
 * (e.g. "Trait", "Transmit"). `identifier` names this specific instance —
 * its `key` if it has one, else a fallback derived from the schema's
 * `rowLabel`, else the row number. */
export interface Crumb {
	label: string;
	identifier: string;
}

export interface Issue {
	severity: Severity;
	/** Breadcrumbs from root → leaf object. Empty for top-level issues. */
	crumbs: Crumb[];
	/** Field on the leaf object that's bad, if applicable. */
	field?: string;
	/** Plain-text problem description. */
	message: string;
}

/** Top-level entry point. */
export function validateScenario(scenario: ScenarioJSON | null): Issue[] {
	const issues: Issue[] = [];
	if (!scenario) return issues;

	// Sim-level required scaffolding — no breadcrumb (these belong to the
	// scenario itself).
	if (!Array.isArray(scenario.phase) || (scenario.phase as unknown[]).length === 0) {
		issues.push({ severity: 'error', crumbs: [], field: 'phase',
			message: 'Scenario must declare at least one phase.' });
	}
	if (!Array.isArray(scenario.site) || (scenario.site as unknown[]).length === 0) {
		issues.push({ severity: 'error', crumbs: [], field: 'site',
			message: 'Scenario must declare at least one site.' });
	}

	// Route endpoint arity — the one route rule the generic field walk
	// can't express.
	if (Array.isArray(scenario.route)) {
		const routeSchema = getSchema('route');
		for (let i = 0; i < (scenario.route as unknown[]).length; i++) {
			const r = (scenario.route as Record<string, unknown>[])[i];
			if (!r || typeof r !== 'object') continue;
			const sites = Array.isArray(r.sites) ? r.sites : [];
			if (sites.length !== 2 || sites[0] === sites[1]) {
				issues.push({
					severity: 'error',
					crumbs: routeSchema ? [crumbFor(r, routeSchema, i)] : [],
					field: 'sites',
					message: 'A route must connect exactly two different sites.',
				});
			}
		}
	}

	validateObject(scenario, worldSchema, [], scenario, issues);
	return issues;
}

/* ------------------------- per-object pass ---------------------------- */

function crumbFor(item: Record<string, unknown>, schema: ObjectSchema, idx: number): Crumb {
	// Prefer the explicit `key` field — it's stable and user-recognized.
	const k = item.key;
	if (typeof k === 'string' && k.length > 0) {
		return { label: schema.label, identifier: k };
	}
	// Otherwise use the schema's row label, which combines salient fields
	// (e.g. "+immune by recovery" for a Transmit). Trim if very long so
	// breadcrumbs stay readable.
	let rl: string;
	try {
		rl = schema.rowLabel(item);
	} catch {
		rl = '';
	}
	if (rl && rl !== '(unnamed)' && rl !== '(empty)') {
		const trimmed = rl.length > 40 ? rl.slice(0, 37) + '…' : rl;
		return { label: schema.label, identifier: trimmed };
	}
	return { label: schema.label, identifier: `row ${idx + 1}` };
}

function validateObject(
	obj: Record<string, unknown> | null | undefined,
	schema: ObjectSchema,
	crumbs: Crumb[],
	root: ScenarioJSON,
	issues: Issue[],
): void {
	if (!obj) return;

	for (const f of walkFields(schema.layout) as Iterable<Field>) {
		const value = obj[f.key];
		validateField(f, value, crumbs, root, issues);

		if (f.kind === 'children' && Array.isArray(value)) {
			const childSchema = getSchema(f.itemTag);
			if (!childSchema) continue;

			// Duplicate-key detection on this list (only for child types
			// that use IDs).
			const childHasKeyField = [...walkFields(childSchema.layout)].some(cf => cf.key === 'key');
			const keyFirstSeen = new Map<string, number>();

			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (!item || typeof item !== 'object') continue;
				const childCrumbs = [...crumbs, crumbFor(item as Record<string, unknown>, childSchema, i)];

				if (childHasKeyField) {
					const k = (item as Record<string, unknown>).key;
					if (typeof k === 'string' && k.length > 0) {
						const first = keyFirstSeen.get(k);
						if (first === undefined) {
							keyFirstSeen.set(k, i);
						} else {
							issues.push({
								severity: 'error',
								crumbs: childCrumbs,
								field: 'key',
								message: `Duplicate ${childSchema.label} ID "${k}" (first seen at row ${first + 1}).`,
							});
						}
					}
				}

				validateObject(item as Record<string, unknown>, childSchema, childCrumbs, root, issues);
			}
		}
	}
}

/* ------------------------- per-field pass ----------------------------- */

function validateField(
	field: Field,
	value: unknown,
	crumbs: Crumb[],
	root: ScenarioJSON,
	issues: Issue[],
): void {
	switch (field.kind) {
		case 'string':
			if (field.key === 'key' && (typeof value !== 'string' || value.length === 0)) {
				issues.push({
					severity: 'error', crumbs, field: 'key',
					message: 'ID must be a non-empty string.',
				});
			}
			break;
		case 'ref':
			if (typeof value === 'string' && value.length > 0 && !refExists(root, field.list, value)) {
				issues.push({
					severity: 'warning', crumbs, field: field.key,
					message: `Reference "${value}" not found in ${field.list} list.`,
				});
			}
			break;
		case 'refList': {
			const list = toStringList(value);
			for (const v of list) {
				if (!refExists(root, field.list, v)) {
					issues.push({
						severity: 'warning', crumbs, field: field.key,
						message: `Reference "${v}" not found in ${field.list} list.`,
					});
				}
			}
			break;
		}
		case 'numberOrRef':
			if (typeof value === 'string' && value.length > 0 && !refExists(root, field.list, value)) {
				issues.push({
					severity: 'warning', crumbs, field: field.key,
					message: `Reference "${value}" not found in ${field.list} list.`,
				});
			}
			break;
	}
}

function refExists(root: ScenarioJSON, list: string, key: string): boolean {
	const arr = root[list];
	if (!Array.isArray(arr)) return false;
	for (const item of arr) {
		if (item && typeof item === 'object' && (item as Record<string, unknown>).key === key) {
			return true;
		}
	}
	return false;
}

function toStringList(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).filter(s => s.length > 0);
	if (typeof v === 'string' && v.length > 0) return v.split(',').map(s => s.trim()).filter(Boolean);
	return [];
}
