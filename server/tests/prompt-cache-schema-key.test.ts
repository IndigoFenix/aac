/**
 * Static prompt mode — the frozen memory render is keyed by the SCHEMA.
 *
 * Observed live (staging, 2026-09-11, "Patient Registration: Orren Levi Setup"):
 * a Guided Setup session opens with NO student on purpose, so its first render
 * — the one static mode freezes — had no Context_Reports / Context_Program
 * (buildMemoryFields adds those only once the session has a student). When
 * the model created the patient mid-session the schema grew, but the frozen
 * prompt did not, and for the rest of the session the model could not see a
 * medical record anywhere. It told the clinician to type the diagnosis into
 * the panel instead.
 *
 * The fix keys `_cachedPrompt` by `memorySchemaSignature`: same schema → the
 * cache holds byte-for-byte (prompt-cache reads); a changed schema → ONE
 * re-render and re-freeze. Data changes never touch the key.
 */

import { describe, it, expect } from "@jest/globals";
import { buildPromptAndTools } from "../services/chat/prompt-kit.js";
import { memorySchemaSignature } from "../services/chat/memory-system.js";
import { buildCrmAgent } from "../services/crmChat/agentTemplate.js";

const notesField = {
  id: "Student_Notes",
  type: "array",
  title: "Notes",
  description: "General notes",
  items: { id: "item", type: "string" },
};

/** The shape buildMemoryFields adds once the session has a student. */
const reportsField = (readonly = false) => ({
  id: "Context_Reports",
  type: "object",
  title: "Student Reports",
  description: "Reports for the student",
  opened: true,
  properties: {
    medicalRecord: {
      id: "medicalRecord",
      type: "object",
      title: "Medical Record" + (readonly ? " (read-only)" : ""),
      description: "Current medical record",
      properties: {
        primaryDiagnosis: { id: "primaryDiagnosis", type: "string", description: "Primary diagnosis" },
      },
    },
  },
});

function makeCtx(memoryFields: any[], memoryValues: any, memoryState: any) {
  return {
    agent: { ...buildCrmAgent({ systemPrompt: "be friendly" }), memoryFields },
    history: [],
    memoryValues,
    memoryState,
    openedTopics: [],
    conversationSummary: "",
    timezone: "Asia/Jerusalem",
  };
}

const prefix = (b: any) => (b.instructions as string) + (b.endInstructions ?? "");

describe("memorySchemaSignature", () => {
  it("is stable for the same schema and blind to data", () => {
    expect(memorySchemaSignature([notesField as any])).toBe(memorySchemaSignature([notesField as any]));
    expect(memorySchemaSignature([{ ...notesField, description: "different words" } as any])).toBe(
      memorySchemaSignature([notesField as any]),
    );
  });

  it("changes when a field appears, and when a title (where read-only lands) changes", () => {
    const before = memorySchemaSignature([notesField as any]);
    const bound = memorySchemaSignature([notesField, reportsField()] as any);
    const readonly = memorySchemaSignature([notesField, reportsField(true)] as any);
    expect(bound).not.toBe(before);
    expect(readonly).not.toBe(bound);
  });
});

describe("static prompt mode re-renders when the schema changes", () => {
  it("a student bound mid-session makes Context_Reports visible to the model", () => {
    const state: any = { visible: [], page: {}, staticPromptMode: true };

    // Turn 1: the kickoff, unbound. Freezes a render with no reports section.
    const turn1 = prefix(buildPromptAndTools(makeCtx([notesField], {}, state)));
    expect(turn1).not.toContain("Context_Reports");
    expect(state._cachedPrompt).toBeTruthy();
    expect(state._cachedPromptKey).toBe(memorySchemaSignature([notesField] as any));

    // Turn 2: same schema, data moved. The cache must HOLD (byte-identical).
    const turn2 = prefix(
      buildPromptAndTools(makeCtx([notesField], { Student_Notes: ["a note"] }, state)),
    );
    expect(turn2).toBe(turn1);

    // Turn 3: the model created the student; the session now has reports.
    const bound = [notesField, reportsField()];
    const turn3 = prefix(buildPromptAndTools(makeCtx(bound, { Student_Notes: ["a note"] }, state)));
    expect(turn3).toContain("Context_Reports");
    expect(turn3).toContain("medicalRecord");
    expect(state._cachedPromptKey).toBe(memorySchemaSignature(bound as any));

    // Turn 4: the new render is frozen in turn — one write, then reads.
    const turn4 = prefix(
      buildPromptAndTools(makeCtx(bound, { Student_Notes: ["a note", "another"] }, state)),
    );
    expect(turn4).toBe(turn3);
  });

  it("a row frozen before the key existed re-renders once instead of staying stale forever", () => {
    // Every session already in the database has _cachedPrompt and no key.
    const state: any = { visible: [], page: {}, staticPromptMode: true, _cachedPrompt: "STALE RENDER" };
    const bound = [notesField, reportsField()];
    const out = prefix(buildPromptAndTools(makeCtx(bound, {}, state)));
    expect(out).not.toContain("STALE RENDER");
    expect(out).toContain("Context_Reports");
    expect(state._cachedPromptKey).toBe(memorySchemaSignature(bound as any));

    const again = prefix(buildPromptAndTools(makeCtx(bound, {}, state)));
    expect(again).toBe(out);
  });

  it("survives the DB round-trip with its key", () => {
    const state1: any = { visible: [], page: {}, staticPromptMode: true };
    const bound = [notesField, reportsField()];
    const a = prefix(buildPromptAndTools(makeCtx(bound, {}, state1)));
    const state2 = JSON.parse(JSON.stringify(state1));
    const b = prefix(buildPromptAndTools(makeCtx(bound, { Student_Notes: ["x"] }, state2)));
    expect(b).toBe(a);
  });
});
