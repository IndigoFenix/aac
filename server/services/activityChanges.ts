/**
 * Field-level change summaries for the activity log.
 *
 * `activity_logs.details` was null on ~92% of `update` rows, so the log could
 * say WHO touched a student and WHEN but never WHAT. Tracing a bad value meant
 * reconstructing it from AAC session prompt snapshots. This builds the missing
 * half: the list of fields a write actually changed, ready to drop into
 * `details`.
 *
 * VALUES ARE DENY-BY-DEFAULT. The log is readable by institute admins and is
 * NOT covered by the external-storage tiering in `external-storage/registry.ts`,
 * so anything written here escapes that boundary permanently. The rules:
 *
 *   - field listed in SENSITIVE_FIELDS for its table  → presence only
 *   - boolean / numeric column                        → literal value (cannot carry PII)
 *   - text column listed in VALUE_SAFE below          → literal value (closed enums)
 *   - everything else (free text, jsonb, dates)       → presence or shape
 *
 * "Presence" is `"empty"` / `"set"`; shape is `"[n items]"` / `"{n fields}"`.
 * That is enough in practice — `aiName: empty → set` is the whole diagnosis —
 * and it means a new PII column added to `students` later is redacted by
 * default rather than silently leaking into the audit trail.
 */

import { getTableColumns } from "drizzle-orm";
import { students, aacSettings } from "@shared/schema";
import { SENSITIVE_FIELDS } from "../external-storage/registry";

/** One field's before/after. `redacted` means from/to are descriptors, not values. */
export interface FieldChange {
  from: unknown;
  to: unknown;
  redacted?: true;
}

export type ChangeMap = Record<string, FieldChange>;

/** Bookkeeping columns — a change here is never interesting on its own. */
const SKIP_FIELDS = new Set([
  "id",
  "studentId",
  "createdAt",
  "updatedAt",
  "deletedAt",
]);

/**
 * Text columns whose values are safe to record verbatim: closed enums and
 * model/provider identifiers, none of which can carry personal data. Anything
 * not listed is reduced to presence. Keep it that way — the cost of a wrong
 * entry here is PII in an audit table that outlives the record it describes.
 */
const VALUE_SAFE: Record<string, Set<string>> = {
  students: new Set([
    "framework",
    "country",
    "primaryLanguage",
    "consentAuthority",
    "guardianshipBasis",
  ]),
  aac_settings: new Set([
    "demoScenario",
    "modelOverride",
    "voiceType",
    "studentVoiceType",
    "geminiAiVoice",
    "geminiStudentVoice",
    "budgetTier",
    "boardManagerLiveModel",
    "signLanguage",
    "eyegazeProvider",
    "eyegazeSmoothing",
    "selectionMethod",
    "restSpace",
  ]),
};

/** Drizzle tables we can introspect column types for, by DB table name. */
const TABLE_COLUMNS: Record<string, Record<string, { dataType: string }>> = {
  students: getTableColumns(students) as any,
  aac_settings: getTableColumns(aacSettings) as any,
};

/** A runaway write shouldn't turn one log row into a megabyte of jsonb. */
const MAX_FIELDS = 40;
const MAX_STRING = 80;

function isSensitive(table: string, field: string): boolean {
  const tiers = SENSITIVE_FIELDS[table];
  if (!tiers) return false;
  return Boolean(tiers.core?.includes(field) || tiers.log?.includes(field));
}

/** `"empty"` / `"set"` — never the value itself. */
function presence(value: unknown): "empty" | "set" {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") return value.trim() ? "set" : "empty";
  if (Array.isArray(value)) return value.length ? "set" : "empty";
  if (value instanceof Date) return "set";
  if (typeof value === "object") return Object.keys(value).length ? "set" : "empty";
  if (typeof value === "boolean") return value ? "set" : "empty";
  if (typeof value === "number") return "set";
  return "set";
}

/** Non-revealing shape for containers; presence for everything else. */
function shape(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value).length} fields}`;
  }
  return presence(value);
}

function literal(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  return value;
}

/** Value-equality that survives jsonb round-trips and Date instances. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
  try {
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  } catch {
    return false;
  }
}

/**
 * Diff one table's before-row against the values a write is applying.
 *
 * `after` is the update payload — only the keys it carries are examined, so a
 * partial PATCH reports only what it touched. Returns `{}` when nothing
 * actually changed (a save that re-submits identical values logs no fields).
 */
export function summarizeChanges(
  table: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): ChangeMap {
  if (!after) return {};
  const columns = TABLE_COLUMNS[table] ?? {};
  const valueSafe = VALUE_SAFE[table] ?? new Set<string>();
  const changes: ChangeMap = {};
  let count = 0;

  for (const [field, next] of Object.entries(after)) {
    if (next === undefined) continue;
    if (SKIP_FIELDS.has(field)) continue;
    // Update bodies reach us straight off the wire, so they can carry keys that
    // aren't columns at all (`age`, stray client state). Reporting those as
    // changed fields would be a lie; drop them when we know the real column set.
    if (Object.keys(columns).length > 0 && !(field in columns)) continue;

    const prev = before ? before[field] : undefined;
    if (sameValue(prev, next)) continue;

    if (count >= MAX_FIELDS) {
      changes["…"] = { from: null, to: `${Object.keys(after).length - count} more fields`, redacted: true };
      break;
    }
    count++;

    const dataType = columns[field]?.dataType;
    const plain =
      !isSensitive(table, field) &&
      (dataType === "boolean" || dataType === "number" || valueSafe.has(field));

    changes[field] = plain
      ? { from: literal(prev), to: literal(next) }
      : { from: shape(prev), to: shape(next), redacted: true };
  }

  return changes;
}

/** Merge per-table summaries into the flat `details.changes` map the log stores. */
export function mergeChanges(...maps: ChangeMap[]): ChangeMap {
  return Object.assign({}, ...maps);
}

/** `details` for a log entry, or `null` when the write was a no-op. */
export function changeDetails(
  changes: ChangeMap,
  extra?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (Object.keys(changes).length === 0) return null;
  return { ...extra, changes };
}
