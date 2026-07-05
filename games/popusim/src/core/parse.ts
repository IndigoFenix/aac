/**
 * Typed JSON parsing helpers used by sim classes to read fields out of
 * scenario data in their constructors.
 *
 * Replaces the legacy `BWObj.getAttrs()` / `loadAttrs()` machinery, which
 * walked a runtime metadata array and assigned typed values via dynamic
 * property access. Each helper here is a small, explicit, statically-typed
 * conversion — sim classes call them directly so the resulting code reads
 * like ordinary TypeScript instead of stringly-typed reflection.
 *
 * Conventions:
 *  - All helpers take the raw `data` record and a `key` to read.
 *  - Missing / null / empty-string values fall back to the supplied default.
 *  - Where the JSON shape is per-class, the calling class controls the
 *    default; helpers do not invent magic values.
 *  - `parseChildren` keys child arrays by their *singular* JSON name (the
 *    legacy `one` field on AttrDef). Top-level scenario JSON keys for child
 *    arrays are singular by convention (`trait`, `vector`, `site`, ...).
 */

import type { BWObj } from './BWObj';
import { BColor } from './BColor';
import { BGateRef } from './BGateRef';
import { Rect } from './Rect';
import { BSoundEvt } from './BSoundEvt';
import { degToRad, makeArray, toRGBA } from './utils';

type Data = Record<string, unknown>;

/* --------------------------- primitives ------------------------------ */

export function strVal(data: Data, key: string, def: string = ''): string {
	const v = data[key];
	if (v === undefined || v === null) return def;
	return String(v);
}

export function intVal(data: Data, key: string, def: number = 0): number {
	const v = data[key];
	if (v === undefined || v === null || v === '') return def;
	const n = parseInt(v as string);
	return isNaN(n) ? def : n;
}

export function numVal(data: Data, key: string, def: number = 0): number {
	const v = data[key];
	if (v === undefined || v === null || v === '') return def;
	const n = Number(v);
	return isNaN(n) ? def : n;
}

export function boolVal(data: Data, key: string, def: boolean = false): boolean {
	const v = data[key];
	if (v === undefined) return def;
	if (v === '' || v === 0 || v === '0' || v === false || v === null) return false;
	return true;
}

/** Number stored as degrees in JSON, returned in radians. */
export function degVal(data: Data, key: string, def: number = 0): number {
	const v = data[key];
	if (v === undefined || v === null || v === '') return def;
	const n = Number(v);
	if (isNaN(n)) return def;
	return degToRad(n);
}

/**
 * Field that can be either a number or a selector string (e.g. a resource
 * key used as a multiplier). Numeric strings are coerced to numbers; other
 * strings are kept verbatim for runtime resolution.
 */
export function numOrSelectorVal(data: Data, key: string, def: number | string = 0): number | string {
	const v = data[key];
	if (v === undefined || v === null || v === '') return def;
	if (typeof v === 'number') return v;
	const n = Number(v);
	return isNaN(n) ? String(v) : n;
}

/**
 * Select-from-options field. Returns the default if the stored value is
 * not one of the valid options.
 */
export function selectVal<T extends string>(
	data: Data,
	key: string,
	options: readonly T[],
	def: T,
): T {
	const v = data[key];
	if (v === undefined || v === null) return def;
	const s = String(v);
	return (options as readonly string[]).includes(s) ? (s as T) : def;
}

/* ------------------------------ arrays ------------------------------- */

/** Comma-separated string or array of strings → string[]. */
export function arrayVal(data: Data, key: string): string[] {
	const v = data[key];
	const arr = makeArray(v);
	const out: string[] = [];
	for (let i = 0; i < arr.length; i++) out.push(String(arr[i]));
	return out;
}

/** Comma-separated string or array → number[] (NaN entries become 0). */
export function intArrayVal(data: Data, key: string): number[] {
	return makeArray(data[key], true) as number[];
}

export function pointVal(data: Data, key: string): [number, number] {
	const arr = makeArray(data[key], true) as number[];
	return [arr[0] ?? 0, arr[1] ?? 0];
}

/* --------------------------- structured ------------------------------ */

/**
 * Construct a BColor from a JSON value that may be a comma-separated string,
 * an `rgba(...)` literal, a hex code, or already a BColor instance. When
 * `allowNull` is true, an empty string yields an inheriting color.
 */
export function parseColor(
	parent: BWObj | null,
	data: Data,
	key: string,
	def: string = '0,0,0,1',
	allowNull: boolean = false,
): BColor {
	const v = data[key];
	if (v instanceof BColor) return v;
	if (v === '' && allowNull) return new BColor(parent, { inh: 1 });
	const rgba = toRGBA(v) ?? toRGBA(def);
	if (!rgba) return new BColor(parent, { r: 0, g: 0, b: 0, a: 1 });
	return new BColor(parent, { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] });
}

export function parseGate(data: Data, key: string): BGateRef {
	return new BGateRef(data[key]);
}

export function parseRect(data: Data, key: string): Rect {
	const arr = makeArray(data[key], true) as number[];
	if (arr.length === 0) return new Rect(0, 0, 0, 0);
	return new Rect(arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0);
}

export function parseSound(data: Data, key: string): BSoundEvt | null {
	const v = data[key];
	if (typeof v === 'string' && v !== '') return new BSoundEvt({ src: v });
	return null;
}

/**
 * Instantiate child objects from a singular-named JSON array.
 *
 * Top-level scenario JSON keys for child arrays are singular by convention
 * (`trait`, `vector`, `site`, `transmit`, `progress`, `cost`, ...). The
 * runtime property holding the resulting array is plural by the calling
 * class's convention. This helper takes the singular `jsonKey` and returns
 * a fresh array; the caller assigns it to whichever property they like.
 *
 * Children are constructed in order, tagged with `parent_array` and
 * `index` so legacy index-based lookups continue to work.
 */
export function parseChildren<T extends BWObj>(
	parent: BWObj,
	data: Data,
	jsonKey: string,
	Ctor: new (parent: BWObj, data: Record<string, unknown>) => T,
): T[] {
	const raw = data[jsonKey];
	if (!Array.isArray(raw)) return [];
	const out: T[] = [];
	for (let i = 0; i < raw.length; i++) {
		const childData = raw[i] as Record<string, unknown>;
		const child = new Ctor(parent, childData);
		child.parent_array = out as unknown as BWObj[];
		child.index = i;
		out.push(child);
	}
	return out;
}
