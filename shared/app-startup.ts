// shared/app-startup.ts
//
// Contract for "app startup definitions": an optional, per-app spec that lets an
// app/game be opened with intelligently-chosen starting parameters. When an app
// that declares a spec is opened (by the AI's open_app tool OR by a student
// press), the server compiles a separate prompt — student context + this app's
// guidance + the conversation — and asks a fast LLM to fill `paramsSchema`. The
// resolved params are then handed to the app at launch.
//
// Kept in `shared/` (no server-only imports) so the registry, the resolver, the
// session-snapshot type, and tests can all reference it.

/** Minimal JSON-Schema subset — only what the Gemini structured provider's
 *  `cleanSchema` accepts (no $ref / additionalProperties; `type` is a string). */
export type JsonSchemaType =
  | "object"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array";

export interface JsonSchema {
  type: JsonSchemaType;
  description?: string;
  /** Allowed values for string/number leaves. */
  enum?: Array<string | number>;
  /** For type "object". */
  properties?: Record<string, JsonSchema>;
  /** For type "object" — property keys that must be present. */
  required?: string[];
  /** For type "array". */
  items?: JsonSchema;
  /** Inclusive bounds for number/integer leaves (used for clamping). */
  minimum?: number;
  maximum?: number;
}

/**
 * Optional startup definition attached to an app.
 *
 * `guidance` is fed ONLY to the resolver LLM — never to the live AAC agents — so
 * the core prompt stays free of per-app option lists.
 *
 * `defaults` MUST be a valid instance of `paramsSchema`; it is returned whenever
 * resolution is skipped, times out, errors, or yields nothing usable, so an app
 * with a spec always has a complete, sane parameter set.
 */
export interface AppStartupSpec {
  appId: string;
  guidance: string;
  /** Root must be `{ type: "object", properties: {...} }`. */
  paramsSchema: JsonSchema;
  defaults: Record<string, unknown>;
  /** Output-token cap for the resolver call (default 256). */
  maxTokens?: number;
}

export type StartupParams = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampNumber(n: number, schema: JsonSchema): number {
  let out = n;
  if (typeof schema.minimum === "number") out = Math.max(out, schema.minimum);
  if (typeof schema.maximum === "number") out = Math.min(out, schema.maximum);
  if (schema.type === "integer") out = Math.round(out);
  return out;
}

/** Validate a single leaf value against a (non-object) schema. Returns the
 *  coerced/clamped value, or `undefined` if it can't be salvaged. */
function coerceLeaf(value: unknown, schema: JsonSchema): unknown {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return undefined;
      if (schema.enum && !schema.enum.includes(value)) return undefined;
      return value;
    }
    case "integer":
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return undefined;
      const clamped = clampNumber(n, schema);
      if (schema.enum && !schema.enum.includes(clamped)) return undefined;
      return clamped;
    }
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "array": {
      if (!Array.isArray(value)) return undefined;
      if (!schema.items) return value;
      const items = value
        .map((el) => coerceLeaf(el, schema.items as JsonSchema))
        .filter((el) => el !== undefined);
      return items;
    }
    default:
      return undefined;
  }
}

/**
 * Merge an LLM's raw output over `defaults`, keeping only schema-valid values
 * (type-checked, enum-checked, clamped) and stripping unknown keys. The result
 * is always a complete object: every key present in `defaults` survives, falling
 * back to its default whenever the raw value is missing or invalid.
 *
 * Pure and side-effect-free so the resolver and unit tests share one path.
 */
export function validateAndMergeParams(
  schema: JsonSchema,
  raw: unknown,
  defaults: StartupParams,
): StartupParams {
  const out: StartupParams = { ...defaults };
  if (schema.type !== "object" || !schema.properties) return out;
  if (!isPlainObject(raw)) return out;

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in raw)) continue;
    const coerced =
      propSchema.type === "object" && propSchema.properties
        ? validateAndMergeParams(propSchema, raw[key], (defaults[key] as StartupParams) ?? {})
        : coerceLeaf(raw[key], propSchema);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}
