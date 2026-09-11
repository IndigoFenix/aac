/**
 * AAC settings — ONE definition at two addresses.
 *
 * `Context_AACSettings` (the selected student) and
 * `Context_Students/<id>/aacSettings` (any student the clinician can reach)
 * are the same `aac_settings` row. Until 2026-09-11 they were two hand-kept
 * property lists that drifted for seven months: the student-record door never
 * learned `aiName`, `languageLevel`, `selectionMethod` or `restSpace`, the
 * selected-student door never showed `enabled`, and one declared every
 * boolean and number as a string. A model that opened the door it could see
 * got "aiName not allowed" and wrote "Your name is Lumi." as a prompt rule.
 *
 * These tests pin the invariant that stops that recurring: the student-record
 * door's properties ARE the shared table (plus the two prompt lists it serves
 * itself), the student-facing copy is the same table minus the clinician-only
 * knobs, and the flat scalars carry real types.
 */

import { describe, it, expect } from "@jest/globals";
import {
  AAC_SETTINGS_CLINICIAN_ONLY,
  AAC_SETTINGS_FIELD,
  AAC_SETTINGS_PROPERTIES,
  aacSettingsPropertiesFor,
  getAACSettingsMemoryFields,
} from "../services/memory-schema/aac-settings-memory-schema.js";
import { INSTITUTE_STUDENTS_FIELD } from "../services/memory-schema/institute-memory-schema.js";

const studentDoor = (): Record<string, any> => {
  // A map field keeps its item schema under `values`.
  const item = (INSTITUTE_STUDENTS_FIELD as any).values;
  const sub = item?.properties?.aacSettings;
  if (!sub) throw new Error("Context_Students item has no aacSettings sub-object");
  return sub.properties as Record<string, any>;
};

describe("Context_Students/<id>/aacSettings is Context_AACSettings at another address", () => {
  it("exposes the SAME property objects as the shared table, plus only the two prompt lists", () => {
    const sub = studentDoor();
    for (const [key, prop] of Object.entries(AAC_SETTINGS_PROPERTIES)) {
      // Identity, not equality: a copy is how the two drifted last time.
      expect(sub[key]).toBe(prop);
    }
    const extras = Object.keys(sub).filter((k) => !(k in AAC_SETTINGS_PROPERTIES)).sort();
    expect(extras).toEqual(["autoAacPrompt", "chatAgentPrompt"]);
  });

  it("the settings the setup flow asks for exist at BOTH addresses", () => {
    const sub = studentDoor();
    for (const key of ["aiName", "languageLevel", "voiceType", "studentVoiceType", "eyegazeEnabled", "eyegazeProvider", "restSpace", "selectionMethod", "enabled"]) {
      expect(AAC_SETTINGS_PROPERTIES[key]).toBeDefined();
      expect(sub[key]).toBeDefined();
    }
  });

  it("the shared table IS the selected-student field's property object", () => {
    expect(AAC_SETTINGS_FIELD.properties).toBe(AAC_SETTINGS_PROPERTIES);
  });
});

describe("the student-facing (AAC mode) copy", () => {
  it("is the same table minus the clinician-only knobs", () => {
    const [studentView] = getAACSettingsMemoryFields({ includePrompts: false });
    expect(studentView.id).toBe("Context_AACSettings");
    const keys = Object.keys((studentView as any).properties).sort();
    const expected = Object.keys(AAC_SETTINGS_PROPERTIES)
      .filter((k) => !AAC_SETTINGS_CLINICIAN_ONLY.has(k))
      .sort();
    expect(keys).toEqual(expected);
    expect(keys).not.toContain("enabled");
    expect(aacSettingsPropertiesFor("student")).not.toHaveProperty("enabled");
  });

  it("the clinician copy keeps them", () => {
    for (const k of AAC_SETTINGS_CLINICIAN_ONLY) {
      expect(aacSettingsPropertiesFor("clinician")[k]).toBeDefined();
    }
  });
});

describe("the flat scalars carry real types", () => {
  it("booleans are booleans, levels are bounded integers, choices are enums", () => {
    const p = AAC_SETTINGS_PROPERTIES;
    expect(p.enabled.type).toBe("boolean");
    expect(p.eyegazeEnabled.type).toBe("boolean");
    expect(p.useLocalTts.type).toBe("boolean");
    expect(p.languageLevel.type).toBe("integer");
    expect((p.languageLevel as any).minimum).toBe(1);
    expect((p.languageLevel as any).maximum).toBe(5);
    expect((p.voiceType as any).enum).toEqual(["auto", "man", "woman", "boy", "girl"]);
    expect((p.studentVoiceType as any).enum).toEqual(["man", "woman", "boy", "girl"]);
    expect((p.eyegazeProvider as any).enum).toContain("tobii");
    expect((p.selectionMethod as any).enum).toEqual(["whole_button", "selection_area", "intent"]);
    expect((p.restSpace as any).enum).toEqual(["large", "small", "none"]);
  });

  it("declares no boolean or numeric column as a bare string any more", () => {
    // Every "(true/false)" description must sit on a boolean property.
    for (const [key, prop] of Object.entries(AAC_SETTINGS_PROPERTIES)) {
      const desc = String((prop as any).description ?? "");
      if (desc.includes("(true/false)") && (prop as any).type === "string") {
        throw new Error(`${key} is described as true/false but typed as string`);
      }
    }
  });
});
