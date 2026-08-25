/**
 * sensitive-fields.ts
 *
 * Last line of defence against clinical data being smuggled into the AI
 * memory system under a FREE-FORM key — e.g. a clinician (or the AI) writing
 * `Student_AbuseHistory` or `custody_notes` straight into `students.chat_memory`
 * JSONB. Such keys have no schema, no consent gate and no read toggle, so the
 * filter drops them before they reach a prompt.
 *
 * Registered memory-schema fields are deliberately EXEMPT. A field like
 * `Student_Incidents` or `Context_MedicalInfo` is governed by its own schema:
 * `allowReadReports`, `canWriteObject`, `requireConsentForMemoryWrite`. Letting
 * a substring regex second-guess those gates is how this filter came to be
 * hard-disabled in the first place — `/incident/i` silently stripped the
 * Monitor's own incident channel, and the whole check was turned off rather
 * than scoped. `server/tests/sensitive-fields.test.ts` pins the exemption set
 * against every field id declared under `server/services/memory-schema/`, so a
 * new registered field that happens to match a pattern fails the build with a
 * message instead of vanishing from prompts at runtime.
 *
 * Pure module: no DB, no env — importable from unit tests.
 */

/** Substrings that mark a free-form memory key as clinical/sensitive. */
export const SENSITIVE_FIELD_PATTERNS: readonly RegExp[] = [
  /diagnosis/i,
  /medication/i,
  /allergy/i,
  /medical/i,
  /disability/i,
  /classification/i,
  /behavioral.*history/i,
  /psychiatric/i,
  /psychological/i,
  /health.*condition/i,
  /insurance/i,
  /ssn/i,
  /social.*security/i,
  /custody/i,
  /abuse/i,
  /neglect/i,
  /restraint/i,
  /incident/i,
  /hospitalization/i,
];

/**
 * Registered memory-schema field ids that a pattern above would otherwise
 * match. Each one is gated by its own schema, so the filter must stand aside.
 * Add to this set ONLY for a field declared under services/memory-schema/ —
 * the test enforces that direction, not the reverse.
 */
export const SENSITIVE_FILTER_EXEMPT_FIELDS: ReadonlySet<string> = new Set([
  "Student_Incidents",   // incident-memory-schema.ts — incidents table, consent + canWriteObject gated
  "Context_MedicalInfo", // aac-memory-schema.ts — read-only, gated by aacSettings.allowReadReports
]);

/** Normalise a key or memory path ("/Student_Incidents/abc") to its field id. */
function fieldIdOf(key: string): string {
  const trimmed = key.startsWith("/") ? key.slice(1) : key;
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

/**
 * True when a memory key looks clinical/sensitive AND is not a registered,
 * separately-gated schema field.
 */
export function isSensitiveFieldId(fieldId: string): boolean {
  if (SENSITIVE_FILTER_EXEMPT_FIELDS.has(fieldIdOf(fieldId))) return false;
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldId));
}
