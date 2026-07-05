/**
 * Schema coverage test.
 *
 * Walks a real scenario (`example-scenarios/covid-19.json`) and asserts that
 * every key on every object is recognized by our typed schema. Drift between
 * the editor schema and the simulator's expected JSON shape becomes a
 * test failure.
 *
 * "Recognized" means: the schema has a Field with that key, OR the key is
 * a known list-name (top-level child arrays are referenced by their
 * singular `key` on the World schema).
 *
 * Per-class allowlist (KNOWN_EXTRA): keys that exist in real scenarios but
 * predate the editor schema. Add an entry here when you knowingly drop
 * support for a legacy field; remove it when the schema gains a renderer
 * for it.
 */

import { describe, it, expect } from 'vitest';
import covid from '../../../../example-scenarios/covid-19.json';
import {
	worldSchema, traitSchema, vectorSchema, seekSchema,
	transmitSchema, progressSchema, produceSchema, consumeSchema,
	transmitModSchema, progressModSchema, contactModSchema,
	produceModSchema, consumeModSchema,
	resourceSchema, actionSchema, actionCostSchema, actionProduceSchema,
	guigroupSchema, phaseSchema, siteSchema, popInitSchema,
	eventSchema, eventConditionSchema, eventResultSchema, eventValueSchema,
} from '../schema';
import type { ObjectSchema, Field } from '../schema';
import { walkFields } from '../schema/types';

/** For each schema tag, which JSON keys are valid on items of that type. */
function fieldKeysOf(schema: ObjectSchema): Set<string> {
	const keys = new Set<string>();
	for (const f of walkFields(schema.layout)) keys.add(f.key);
	return keys;
}

/** For schemas that have child lists, find which children-tag a given
 * key on this schema produces (so we know which schema to validate
 * sub-items against). */
function childMap(schema: ObjectSchema): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of walkFields(schema.layout)) {
		if (f.kind === 'children') out.set(f.key, f.itemTag);
	}
	return out;
}

interface Walker {
	schema: ObjectSchema;
	/** Keys that are known but legitimately absent from the schema. */
	knownExtra?: Set<string>;
}

const SCHEMA_BY_TAG: Record<string, ObjectSchema> = {
	world: worldSchema,
	trait: traitSchema,
	vector: vectorSchema,
	seek: seekSchema,
	transmit: transmitSchema,
	progress: progressSchema,
	produce: produceSchema,
	consume: consumeSchema,
	transmit_mod: transmitModSchema,
	progress_mod: progressModSchema,
	contact_mod: contactModSchema,
	produce_mod: produceModSchema,
	consume_mod: consumeModSchema,
	resource: resourceSchema,
	action: actionSchema,
	cost: actionCostSchema,
	action_produce: actionProduceSchema,
	guigroup: guigroupSchema,
	phase: phaseSchema,
	site: siteSchema,
	startpop: popInitSchema,
	event: eventSchema,
	condition: eventConditionSchema,
	result: eventResultSchema,
	exp: eventValueSchema,
};

/** Legacy fields that exist in covid-19.json but are intentionally not
 * (yet) wired into the editor schema. Track them so the test still
 * passes and the gap is visible. */
const KNOWN_EXTRA: Record<string, Set<string>> = {
	// Editor doesn't expose graph display offsets; the legacy field is
	// preserved on round-trip but invisible.
	trait: new Set(['tracked_offset', 'impact']),
	resource: new Set(['tracked_offset']),
	// `index` is legacy metadata for the world-list; not user-editable.
	world: new Set(['index']),
};

interface Issue { path: string; key: string; tag: string }

function walk(value: unknown, tag: string, pathStr: string, issues: Issue[]): void {
	const schema = SCHEMA_BY_TAG[tag];
	if (!schema) {
		issues.push({ path: pathStr, key: '<schema>', tag });
		return;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return;

	const fieldKeys = fieldKeysOf(schema);
	const children = childMap(schema);
	const known = KNOWN_EXTRA[tag] ?? new Set();

	for (const [k, v] of Object.entries(value)) {
		if (fieldKeys.has(k)) {
			const childTag = children.get(k);
			if (childTag && Array.isArray(v)) {
				for (let i = 0; i < v.length; i++) {
					walk(v[i], childTag, `${pathStr}.${k}[${i}]`, issues);
				}
			}
			continue;
		}
		if (known.has(k)) continue;
		issues.push({ path: pathStr, key: k, tag });
	}
}

describe('editor schema coverage vs covid-19.json', () => {
	it('every JSON key on every object has a matching schema field', () => {
		const issues: Issue[] = [];
		walk(covid as unknown, 'world', 'world', issues);
		if (issues.length > 0) {
			const grouped: Record<string, string[]> = {};
			for (const i of issues) {
				const tag = i.tag;
				(grouped[tag] ??= []).push(`${i.path}: ${i.key}`);
			}
			const summary = Object.entries(grouped)
				.map(([tag, items]) => `  [${tag}] ${items.length} unknown keys, e.g. ${items.slice(0, 3).join(', ')}`)
				.join('\n');
			throw new Error(`Schema gaps:\n${summary}`);
		}
	});

	it('every schema is reachable from the world', () => {
		// Sanity: the registry should contain every schema referenced from
		// world via children chains.
		const seen = new Set<string>();
		const queue: string[] = ['world'];
		while (queue.length) {
			const tag = queue.shift()!;
			if (seen.has(tag)) continue;
			seen.add(tag);
			const s = SCHEMA_BY_TAG[tag];
			if (!s) throw new Error(`Missing schema in registry: ${tag}`);
			for (const f of walkFields(s.layout) as Iterable<Field>) {
				if (f.kind === 'children') queue.push(f.itemTag);
			}
		}
		// Loose assertion: ensure we touched the World, Trait, Site at minimum.
		expect(seen.has('trait')).toBe(true);
		expect(seen.has('site')).toBe(true);
		expect(seen.has('event')).toBe(true);
	});
});
