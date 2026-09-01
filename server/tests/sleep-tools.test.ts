/**
 * Tests for sleep-system tool declarations (Phase 3).
 *
 * Verifies the AI-callable sleep tools (sleep, end_session) are exposed with the
 * expected parameter schemas. Behavior is wired in live-relay.ts; the dispatch
 * path is exercised in integration runs.
 *
 * report_false_wake was DELIBERATELY withdrawn from the declaration list — it
 * gave the model an "I'll opt out" path, the same family as stay_silent. Its
 * builder and its live-relay dispatch case both survive, so the only thing
 * keeping it out of the model's hands is one commented-out push in
 * tool-declarations.ts. The last test below pins that, so re-enabling it has to
 * be a decision rather than an accident.
 */

import { describe, it, expect } from "@jest/globals";
import { buildToolDeclarations, type ToolDeclarationConfig } from "../services/dual-agent/tool-declarations.js";

const MINIMAL_CONFIG: ToolDeclarationConfig = {
  enabledApps: [],
  availableBoards: [],
  hasLoadedBoard: false,
  faceRecognitionActive: false,
};

function getDeclarations(config: ToolDeclarationConfig = MINIMAL_CONFIG) {
  const tools = buildToolDeclarations(config);
  return tools[0]?.functionDeclarations ?? [];
}

describe("Sleep system tools", () => {
  it("declares sleep and end_session", () => {
    const decls = getDeclarations();
    const names = decls.map((d) => d.name);
    expect(names).toContain("sleep");
    expect(names).toContain("end_session");
  });

  it("sleep takes no parameters", () => {
    const sleep = getDeclarations().find((d) => d.name === "sleep");
    expect(sleep).toBeDefined();
    expect(sleep?.parametersJsonSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("end_session takes no parameters", () => {
    const endSession = getDeclarations().find((d) => d.name === "end_session");
    expect(endSession).toBeDefined();
    expect(endSession?.parametersJsonSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("sleep tools are still declared in silent mode", () => {
    // Sleep system is independent of interaction mode — these should always be
    // available so the AI can manage engagement regardless of speak() being on.
    const decls = getDeclarations({ ...MINIMAL_CONFIG, isSilentMode: true });
    const names = decls.map((d) => d.name);
    expect(names).toContain("sleep");
    expect(names).toContain("end_session");
  });

  it("does NOT offer report_false_wake, in either mode", () => {
    // Withdrawn on purpose: it let the model talk itself out of answering.
    // Both modes, because the reason has nothing to do with speak() being on.
    for (const config of [MINIMAL_CONFIG, { ...MINIMAL_CONFIG, isSilentMode: true }]) {
      const names = getDeclarations(config).map((d) => d.name);
      expect(names).not.toContain("report_false_wake");
      expect(names).not.toContain("stay_silent");
    }
  });
});
