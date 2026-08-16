/**
 * spec-schema.ts — the DECLARATIVE FIELD DESCRIPTOR + its generic gate.
 *
 * Every scope's `world` object (and the game-settings scalars) is described by
 * a flat list of `FieldSpec`s: one machine-readable record per field carrying
 * its type, range, enum options, default, and human label/description. ONE
 * source of truth serves three consumers that used to drift apart:
 *
 *   • VALIDATION — `validateFields` gates an unknown JSON object against the
 *     descriptor, path-exact and reject-unknown, replacing the per-scope
 *     hand-written num()/oneOf()/allowed-list boilerplate. It reproduces the
 *     legacy error-string formats verbatim (`<path>: <msg>`, `unknown field
 *     (allowed: …)`, `out of range (min..max)`, `must be an integer`,
 *     `must be one of: …`, `must be true or false`) so the parser contracts
 *     the test-suite pins stay byte-identical.
 *   • UI — a form builder (the world-lab) renders a control per field from the
 *     same descriptor: number inputs with min/max, dropdowns from `options`,
 *     checkboxes for booleans, sub-forms for nested `object`s.
 *   • DOCS — the descriptor IS the parameter reference for a scope.
 *
 * Genuinely idiosyncratic validation (a colour band that is a hex string OR an
 * [r,g,b] tuple; a dynamic-key map of scalar grants) stays hand-written behind
 * a `custom` field — still DECLARED here (so the field-set and the UI know it)
 * but deep-validated by its own function. The descriptor owns the field set;
 * the custom hook owns that one field's shape.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every validation failure is emitted as `"<path>: <msg>"` — the format the
 *  whole engine's structural gates share. */
export function specFail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

/** A dropdown option: the stored `value` and the label the form shows. */
export interface FieldOption {
  value: string;
  label: string;
}

/** The kinds of field the generic gate knows how to validate + render. */
export type FieldKind =
  | "number" // finite number in [min,max]
  | "int" // number in [min,max], rejected unless Number.isInteger
  | "floor" // number in [min,max], silently Math.floor'd (never rejected for fractionality)
  | "boolean" // true | false
  | "enum" // one of `options[].value`
  | "string" // non-empty string (allowEmpty to relax)
  | "literal" // must === `constant`
  | "object" // nested { fields }
  | "list" // array of `item`-shaped elements
  | "custom"; // deep-validated by `validate`; declared here for the field-set + UI

/**
 * One field of a spec. `key` names it in the JSON; the rest drives validation,
 * the form control, and the docs. Optional fields default when absent (or, with
 * no `default`, stay absent — "omitted" ≠ "defaulted", a distinction the older
 * byte-exact parsers relied on).
 */
export interface FieldSpec<T = unknown> {
  key: string;
  /** Human label for the form (falls back to `key`). */
  label?: string;
  /** One-line help shown under the control / in the docs. */
  description?: string;
  kind: FieldKind;
  /** Missing → throw. Message is `requiredMessage ?? "required"`. */
  required?: boolean;
  requiredMessage?: string;
  /** Applied when the key is absent and the field is optional. `undefined`
   *  (the absence of this property) = stay absent. */
  default?: T;

  // number | int | floor
  min?: number;
  max?: number;

  // enum
  options?: readonly FieldOption[];

  // string
  allowEmpty?: boolean;

  // literal
  constant?: unknown;

  // list
  /** The element spec for a `list` field (its `key` is ignored; only its
   *  validation shape is used). Absent = an untyped array (elements pass
   *  through). */
  item?: FieldSpec;
  /** Max elements for a `list` field. */
  maxItems?: number;

  // object
  fields?: readonly FieldSpec[];
  /** Non-object value message for `object` fields (default "expected an
   *  object"). Lets a scope keep "expected an object (the town definition)". */
  objectMessage?: string;

  // custom
  validate?: (raw: unknown, path: string) => unknown;

  /** Override the generic invalid-value message (e.g. a string field that
   *  wants "must be a BCP-47 locale string" instead of the default). */
  invalidMessage?: string;
  /** A UI hint the form may honour without affecting validation (e.g. "seed"
   *  → a randomize button; "color" → a swatch). */
  ui?: string;
  /** The GENERATOR's private split (author-invisible — the form/LLM ignore it):
   *  "boundary" = the object's edge with its surroundings (a river's up/
   *  downstream, a house's district lot, a planet's orbit slot) — SELECTED/
   *  inherited from the parent context, or vacuum-synthesized at root;
   *  "interior" = self-contained content freely generated/replaced. Absent =
   *  unclassified (treated as interior until a kind declares otherwise). See
   *  project_scope_object_vacuum_law. */
  facet?: "boundary" | "interior";
}

/** A named group of fields — a scope's `world` schema, or a nested object. */
export interface GroupSpec {
  /** Non-object root message (default "expected an object"). */
  objectMessage?: string;
  fields: readonly FieldSpec[];
}

function checkNumber(v: unknown, path: string, f: FieldSpec): number {
  const min = f.min ?? -Infinity;
  const max = f.max ?? Infinity;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    specFail(path, f.invalidMessage ?? `must be a number (${min}..${max})`);
  }
  if (v < min || v > max) specFail(path, `out of range (${min}..${max})`);
  return v;
}

/** Validate ONE field's value (the key is known to be present). Returns the
 *  value to store (coerced for `floor`, recursed for `object`/`custom`). */
function validateField(v: unknown, path: string, f: FieldSpec): unknown {
  switch (f.kind) {
    case "number":
      return checkNumber(v, path, f);
    case "int": {
      const n = checkNumber(v, path, f);
      if (!Number.isInteger(n)) specFail(path, f.invalidMessage ?? "must be an integer");
      return n;
    }
    case "floor":
      return Math.floor(checkNumber(v, path, f));
    case "boolean":
      if (typeof v !== "boolean") specFail(path, f.invalidMessage ?? "must be true or false");
      return v;
    case "enum": {
      const opts = f.options ?? [];
      if (typeof v !== "string" || !opts.some((o) => o.value === v)) {
        specFail(path, f.invalidMessage ?? `must be one of: ${opts.map((o) => o.value).join(", ")}`);
      }
      return v;
    }
    case "string":
      if (typeof v !== "string" || (!f.allowEmpty && !v.length)) {
        specFail(path, f.invalidMessage ?? "must be a non-empty string");
      }
      return v;
    case "literal":
      if (v !== f.constant) specFail(path, f.invalidMessage ?? `expected ${JSON.stringify(f.constant)}`);
      return v;
    case "object": {
      if (!isObj(v)) specFail(path, f.objectMessage ?? "expected an object");
      return validateFields(v, { fields: f.fields ?? [] }, path);
    }
    case "list": {
      if (!Array.isArray(v)) specFail(path, f.invalidMessage ?? "expected an array");
      if (f.maxItems !== undefined && v.length > f.maxItems) {
        specFail(path, `too many entries (max ${f.maxItems})`);
      }
      return f.item ? v.map((e, i) => validateField(e, `${path}[${i}]`, f.item!)) : v;
    }
    case "custom":
      if (!f.validate) specFail(path, "no validator for custom field");
      return f.validate(v, path);
  }
}

/**
 * Gate an unknown JSON value against a `GroupSpec`: reject non-objects and
 * unknown keys (path-exact), validate/default each declared field IN DECLARED
 * ORDER, and return a fresh object holding only the keys that were present or
 * defaulted. The unknown-key sweep runs BEFORE field validation — the legacy
 * parsers all reject a stray key before complaining about a value.
 */
export function validateFields(
  raw: unknown,
  group: GroupSpec,
  path: string,
): Record<string, unknown> {
  if (!isObj(raw)) specFail(path, group.objectMessage ?? "expected an object");
  const allowed = group.fields.map((f) => f.key);
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) {
      specFail(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const f of group.fields) {
    const at = `${path}.${f.key}`;
    if (f.key in raw) {
      out[f.key] = validateField(raw[f.key], at, f);
    } else if (f.required) {
      specFail(at, f.requiredMessage ?? "required");
    } else if (f.default !== undefined) {
      // Clone object/array defaults so each parse yields a fresh, independently
      // mutable value (the legacy parsers built these anew every call).
      out[f.key] =
        typeof f.default === "object" && f.default !== null
          ? structuredClone(f.default)
          : f.default;
    }
  }
  return out;
}
