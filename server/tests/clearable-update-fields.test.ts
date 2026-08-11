/**
 * Guards the wire contract behind "I deleted the field and it came back".
 *
 * Every PATCH in this system merges by key: the server writes only the keys the
 * request actually carries. JSON.stringify drops keys whose value is undefined,
 * so a client that sends `x: form.x || undefined` for a cleared field sends
 * nothing at all — the stored value survives the merge and reappears when the
 * panel re-seeds from the refetched record. The clients therefore send an
 * explicit null (or '' where a schema types the field as a bare string).
 *
 * That only works if the validation layer ACCEPTS the explicit clear. These are
 * pure schema tests (no DB, no HTTP): each case is a field some form can blank,
 * paired with the value its client actually puts on the wire. A schema tightened
 * to non-nullable would turn a silent no-op into a 400 — this catches that.
 *
 * The matching write-side behaviour (null clears, absent key preserves) is
 * covered against a real database in tests/integration/student.test.ts.
 */

import { describe, it, expect } from "@jest/globals";
import {
  insertGoalSchema,
  insertObjectiveSchema,
  insertServiceSchema,
  insertStudentContactSchema,
  updateGoalSchema,
  updateObjectiveSchema,
  updateServiceSchema,
  updateStudentContactSchema,
} from "@shared/schema-private";
import { insertVoiceSchema, updateVoiceSchema } from "@shared/schema";

describe("clearable update fields accept an explicit clear", () => {
  describe("program schemas (drizzle-zod .partial())", () => {
    it("updateGoalSchema accepts null for every field the goal form can blank", () => {
      const parsed = updateGoalSchema.parse({
        criteria: null,
        methods: null,
        targetDate: null,
        familyInput: null,
        clientImportanceRating: null,
      });

      expect(parsed).toEqual({
        criteria: null,
        methods: null,
        targetDate: null,
        familyInput: null,
        clientImportanceRating: null,
      });
    });

    it("updateObjectiveSchema accepts null for the objective form's blankable fields", () => {
      const parsed = updateObjectiveSchema.parse({
        profileDomainId: null,
        criteria: null,
        methods: null,
        targetDate: null,
      });

      expect(parsed.criteria).toBeNull();
      expect(parsed.targetDate).toBeNull();
      expect(parsed.profileDomainId).toBeNull();
    });

    it("updateServiceSchema accepts null for description and providerName", () => {
      const parsed = updateServiceSchema.parse({
        description: null,
        providerName: null,
      });

      expect(parsed.description).toBeNull();
      expect(parsed.providerName).toBeNull();
    });
  });

  describe("contact + voice schemas", () => {
    it("updateStudentContactSchema accepts null for every optional contact field", () => {
      const parsed = updateStudentContactSchema.parse({
        relationship: null,
        role: null,
        customRole: null,
        organization: null,
        contactEmail: null,
        contactPhone: null,
        contextNotes: null,
      });

      expect(parsed.contactPhone).toBeNull();
      expect(parsed.role).toBeNull();
      expect(parsed.contextNotes).toBeNull();
    });

    it("updateVoiceSchema accepts null for description and sampleUrl", () => {
      const parsed = updateVoiceSchema.parse({ description: null, sampleUrl: null });

      expect(parsed.description).toBeNull();
      expect(parsed.sampleUrl).toBeNull();
    });
  });

  // These forms build ONE payload and route it to the POST or the PATCH
  // depending on whether the dialog is editing. The nulls the edit path needs
  // therefore also reach the create path, so the insert schemas must tolerate
  // them or adding a record without an optional field would 400.
  describe("the insert schemas tolerate the same nulls (shared create/edit payloads)", () => {
    it("insertGoalSchema accepts the goal form's nulls", () => {
      expect(() =>
        insertGoalSchema.parse({
          programId: "prog-1",
          goalStatement: "Requests a break using the board",
          criteria: null,
          methods: null,
          targetDate: null,
          familyInput: null,
          clientImportanceRating: null,
        }),
      ).not.toThrow();
    });

    it("insertObjectiveSchema accepts the objective form's nulls", () => {
      expect(() =>
        insertObjectiveSchema.parse({
          goalId: "goal-1",
          objectiveStatement: "Uses two-glyph phrases",
          profileDomainId: null,
          criteria: null,
          methods: null,
          targetDate: null,
        }),
      ).not.toThrow();
    });

    it("insertServiceSchema accepts the service form's nulls", () => {
      expect(() =>
        insertServiceSchema.parse({
          programId: "prog-1",
          serviceType: "speech_language_therapy",
          description: null,
          providerName: null,
        }),
      ).not.toThrow();
    });

    it("insertStudentContactSchema accepts the contact form's nulls", () => {
      expect(() =>
        insertStudentContactSchema.parse({
          studentId: "student-1",
          name: "Dana",
          relationship: null,
          role: null,
          customRole: null,
          organization: null,
          contactEmail: null,
          contactPhone: null,
          contextNotes: null,
        }),
      ).not.toThrow();
    });

    it("insertVoiceSchema accepts the voice form's nulls", () => {
      expect(() =>
        insertVoiceSchema.parse({
          name: "Noa",
          externalId: "voice-abc",
          source: "elevenlabs",
          description: null,
          sampleUrl: null,
        }),
      ).not.toThrow();
    });
  });

  describe("a clear is distinguishable from an untouched field", () => {
    it("omitting a key parses to an absent key, not to null", () => {
      const parsed = updateGoalSchema.parse({ criteria: "kept" });

      expect(parsed.criteria).toBe("kept");
      expect("methods" in parsed).toBe(false);
      // The whole point: absent means "don't touch", null means "clear". If
      // these ever collapse into the same parsed shape, the merge can no longer
      // tell a cleared field from an unsent one.
      expect(parsed.methods).toBeUndefined();
    });
  });
});
