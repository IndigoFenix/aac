/**
 * Schema registry. Look up an ObjectSchema by tag — used by ChildrenField
 * rendering to find the schema for items in a list, and by clipboard
 * paste-validation.
 */

import type { ObjectSchema, ListKey } from './types';
import {
	worldSchema,
	traitSchema,
	vectorSchema,
	seekSchema,
	transmitSchema,
	progressSchema,
	produceSchema,
	consumeSchema,
	transmitModSchema,
	progressModSchema,
	contactModSchema,
	produceModSchema,
	consumeModSchema,
	resourceSchema,
	actionSchema,
	actionCostSchema,
	actionProduceSchema,
	guigroupSchema,
	phaseSchema,
	siteSchema,
	popInitSchema,
	routeSchema,
	eventSchema,
	eventConditionSchema,
	eventResultSchema,
	eventValueSchema,
} from './schemas';

export * from './types';
export * from './schemas';

const all: ObjectSchema[] = [
	worldSchema,
	traitSchema,
	vectorSchema, seekSchema,
	transmitSchema, progressSchema,
	produceSchema, consumeSchema,
	transmitModSchema, progressModSchema, contactModSchema, produceModSchema, consumeModSchema,
	resourceSchema,
	actionSchema, actionCostSchema, actionProduceSchema,
	guigroupSchema, phaseSchema,
	siteSchema, popInitSchema, routeSchema,
	eventSchema, eventConditionSchema, eventResultSchema, eventValueSchema,
];

export const SCHEMAS: Record<string, ObjectSchema> = Object.fromEntries(
	all.map(s => [s.tag, s])
);

export function getSchema(tag: string): ObjectSchema | null {
	return SCHEMAS[tag] ?? null;
}

/** Resolve a ListKey to the JSON path holding that list. Always
 * `[listKey]` since the JSON shape uses singular-named top-level
 * arrays (e.g. `draft.trait`, `draft.vector`). */
export function listPathFor(list: ListKey): (string | number)[] {
	return [list];
}

/** Pretty label for an object referenced by key in `list`. Used by
 * ref/refList field renderers. Returns the looked-up object's name (if
 * any), falling back to the bare key. */
export function refLabel(
	scenario: Record<string, unknown> | null,
	list: ListKey,
	key: string,
): string {
	if (!scenario) return key;
	const arr = scenario[list];
	if (!Array.isArray(arr)) return key;
	for (const item of arr) {
		if (item && typeof item === 'object' && (item as Record<string, unknown>).key === key) {
			const name = (item as Record<string, unknown>).name;
			if (typeof name === 'string' && name.trim().length > 0) return `${name} (${key})`;
			return key;
		}
	}
	return `${key} (missing)`;
}
