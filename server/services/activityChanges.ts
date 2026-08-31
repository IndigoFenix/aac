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
import {
  students,
  aacSettings,
  medicalRecords,
  functionalReports,
  educationalReports,
  studentContacts,
  programs,
  goals,
  objectives,
  progressReports,
} from "@shared/schema";
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
  // Drag-to-reorder rewrites these across a whole list; the noise would bury
  // the one clinical field a clinician actually edited. Reordering is not
  // audit signal.
  "sortOrder",
  "sequenceOrder",
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

  // Care-plan tables (AKIM appendix §5.8, Track C). Only closed enums, dates
  // and FK ids appear here. Drizzle reports `date`/`timestamp` columns as
  // dataType "date" and pgEnum columns as "string", so both would fall back to
  // presence without an explicit listing — and "the due date moved from
  // 2026-11-15 to 2027-01-30" is exactly what an audit of a care plan needs.
  // Every narrative column (titles, statements, criteria, notes, jsonb) is
  // deliberately absent: it stays presence-only.
  programs: new Set([
    "framework",
    "status",
    "startDate",
    "endDate",
    "dueDate",
    "approvalDate",
    "instituteId",
  ]),
  goals: new Set([
    "status",
    "interventionLevel",
    "targetDate",
    "achievedDate",
    "gasVaryingVariable",
    "gasBaselineLevel",
    "programId",
  ]),
  objectives: new Set([
    "status",
    "targetDate",
    "achievedDate",
    "gasTargetLevel",
    "goalId",
    "profileDomainId",
  ]),
  progress_reports: new Set([
    "reportDate",
    "sharedDate",
    "programId",
    // `reportingPeriod` is NOT here: the column is open text ("Q1" by
    // convention, but nothing enforces it), so a clinician can type a child's
    // name or a clinical remark into it. Presence-only.
  ]),
};

/**
 * Drizzle tables we can introspect column types for, by DB table name.
 *
 * A table absent from here still diffs, but every column falls back to
 * presence/shape because the data type is unknown — safe, just less useful.
 * Registering a table is what lets its booleans and numbers report real values.
 *
 * The clinical record tables were added for AKIM appendix §5.8, which asks the
 * audit log to carry "the value that changed". Note that NONE of them
 * contribute entries to VALUE_SAFE: their text columns are diagnoses, notes and
 * clinical narrative, so they stay redacted to presence. What the log gains is
 * an accurate list of WHICH fields a clinician changed, plus literal values for
 * the flags — which is the part that is safe to keep and usually the part being
 * traced.
 *
 * The care-plan tables (programs / goals / objectives / progress_reports) went
 * in for the same clause. They DO contribute to VALUE_SAFE, but only their
 * lifecycle enums, dates and FK ids — the workflow skeleton. Every statement,
 * criterion, note and jsonb blob on them stays presence-only.
 */
const TABLE_COLUMNS: Record<string, Record<string, { dataType: string }>> = {
  students: getTableColumns(students) as any,
  aac_settings: getTableColumns(aacSettings) as any,
  medical_records: getTableColumns(medicalRecords) as any,
  functional_reports: getTableColumns(functionalReports) as any,
  educational_reports: getTableColumns(educationalReports) as any,
  student_contacts: getTableColumns(studentContacts) as any,
  programs: getTableColumns(programs) as any,
  goals: getTableColumns(goals) as any,
  objectives: getTableColumns(objectives) as any,
  progress_reports: getTableColumns(progressReports) as any,
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
