/**
 * Tests for sleep-system tool declarations (Phase 3).
 *
 * Verifies the AI-callable tools (sleep, end_session, report_false_wake) are
 * exposed with the expected parameter schemas. Behavior is wired in
 * live-relay.ts; the dispatch path is exercised in integration runs.
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
  it("declares sleep, end_session, and report_false_wake", () => {
    const decls = getDeclarations();
    const names = decls.map((d) => d.name);
    expect(names).toContain("sleep");
    expect(names).toContain("end_session");
    expect(names).toContain("report_false_wake");
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

  it("report_false_wake requires a reason string", () => {
    const tool = getDeclarations().find((d) => d.name === "report_false_wake");
    expect(tool).toBeDefined();
    const schema = tool?.parametersJsonSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["reason"]);
    const props = schema.properties as Record<string, { type: string }>;
    expect(props.reason.type).toBe("string");
  });

  it("sleep tools are still declared in silent mode", () => {
    // Sleep system is independent of interaction mode — these should always be
    // available so the AI can manage engagement regardless of speak() being on.
    const decls = getDeclarations({ ...MINIMAL_CONFIG, isSilentMode: true });
    const names = decls.map((d) => d.name);
    expect(names).toContain("sleep");
    expect(names).toContain("end_session");
    expect(names).toContain("report_false_wake");
  });
});
