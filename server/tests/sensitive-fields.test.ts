/**
 * Pins server/services/sensitive-fields.ts — the free-form-key filter that
 * keeps clinical data out of AI memory when someone writes it under an
 * unregistered key.
 *
 * Two invariants, in opposite directions:
 *
 *   1. Every REGISTERED memory-schema field id must pass the filter. A
 *      registered field is governed by its own schema (consent gate, read
 *      toggle, canWriteObject); if a substring pattern silently stripped it,
 *      the Monitor would lose that channel with no error — which is exactly
 *      how the filter came to be hard-disabled (`return false`) before.
 *      Registered ids are collected by scanning the memory-schema sources, so
 *      a new field that collides with a pattern fails here with an actionable
 *      message instead of vanishing from prompts at runtime.
 *
 *   2. Every id in the EXEMPT set must actually be declared under
 *      memory-schema/ — the set cannot be padded with names nobody registered.
 *
 * Plus the positive cases: unregistered keys that look clinical are filtered.
 */

import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSensitiveFieldId,
  SENSITIVE_FIELD_PATTERNS,
  SENSITIVE_FILTER_EXEMPT_FIELDS,
} from "../services/sensitive-fields.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(here, "..", "services", "memory-schema");

/** Quoted field ids / paths declared anywhere under memory-schema/. */
function registeredFieldIds(): Set<string> {
  const ids = new Set<string>();
  const token = /["']\/?((?:Student|User|Context|Relationship|Institute)_[A-Za-z]+)["'/]/g;
  for (const file of readdirSync(schemaDir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(path.join(schemaDir, file), "utf8");
    for (const m of src.matchAll(token)) ids.add(m[1]);
  }
  return ids;
}

describe("isSensitiveFieldId — free-form clinical keys are filtered", () => {
  it.each([
    "Student_AbuseHistory",
    "Student_Diagnosis",
    "custody_arrangement",
    "User_SSN",
    "Relationship_MedicationNotes",
    "Student_PsychiatricEval",
    "behavioral_history_2026",
    "hospitalization_dates",
  ])("filters %s", (key) => {
    expect(isSensitiveFieldId(key)).toBe(true);
  });

  it("is actually enabled (the previous 'return false' regression)", () => {
    expect(SENSITIVE_FIELD_PATTERNS.length).toBeGreaterThan(0);
    expect(isSensitiveFieldId("Student_Diagnosis")).toBe(true);
  });
});

describe("isSensitiveFieldId — registered schema fields pass through", () => {
  it.each([
    "Student_Notes",
    "Student_People",
    "Student_Interests",
    "User_Profile",
    "Relationship_Notes",
    "Student_Incidents",          // would match /incident/i — exempt, own gates
    "/Student_Incidents/abc-123", // path form resolves to the exempt id
    "Context_MedicalInfo",        // would match /medical/i — exempt, allowReadReports-gated
  ])("passes %s", (key) => {
    expect(isSensitiveFieldId(key)).toBe(false);
  });

  it("every registered memory-schema field id passes the filter", () => {
    const ids = registeredFieldIds();
    expect(ids.size).toBeGreaterThan(20); // sanity: the scan found the schema
    const stripped = [...ids].filter((id) => isSensitiveFieldId(id)).sort();
    if (stripped.length > 0) {
      throw new Error(
        `Registered memory-schema fields match a SENSITIVE_FIELD_PATTERN and would be ` +
          `silently dropped from prompts: ${stripped.join(", ")}. Either the field is ` +
          `genuinely governed by its own schema gates — add it to ` +
          `SENSITIVE_FILTER_EXEMPT_FIELDS in server/services/sensitive-fields.ts — ` +
          `or the pattern is too broad.`,
      );
    }
    expect(stripped).toEqual([]);
  });

  it("every exempt id is a field actually declared under memory-schema/", () => {
    const ids = registeredFieldIds();
    const unregistered = [...SENSITIVE_FILTER_EXEMPT_FIELDS].filter((id) => !ids.has(id));
    if (unregistered.length > 0) {
      throw new Error(
        `SENSITIVE_FILTER_EXEMPT_FIELDS names ids with no declaration under ` +
          `server/services/memory-schema/: ${unregistered.join(", ")}. The exemption ` +
          `exists only for registered, separately-gated fields.`,
      );
    }
    expect(unregistered).toEqual([]);
  });
});
