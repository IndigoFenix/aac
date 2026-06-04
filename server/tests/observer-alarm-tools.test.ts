/**
 * Tests for the Observer agent's caretaker-alarm tools (three-agent path).
 *
 * Verifies the two AI-callable alarm tools (alert, emergency_alarm) are
 * exposed with the expected parameter schemas. The Observer is the only
 * agent with live camera/mic context, so it owns raising alarms. Behaviour
 * (event → coordinator → client `alarm` message) is wired in
 * observer-agent.ts / agent-coordinator.ts and exercised in integration.
 */

import { describe, it, expect } from "@jest/globals";
import { buildObserverToolDeclarations } from "../services/dual-agent/tool-declarations-observer.js";

function getDeclarations() {
  const tools = buildObserverToolDeclarations();
  return tools[0]?.functionDeclarations ?? [];
}

describe("Observer alarm tools", () => {
  it("declares both alert and emergency_alarm as two distinct tools", () => {
    const names = getDeclarations().map((d) => d.name);
    expect(names).toContain("alert");
    expect(names).toContain("emergency_alarm");
  });

  it("alert requires a reason string", () => {
    const tool = getDeclarations().find((d) => d.name === "alert");
    expect(tool).toBeDefined();
    const schema = tool?.parametersJsonSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["reason"]);
    const props = schema.properties as Record<string, { type: string }>;
    expect(props.reason.type).toBe("string");
  });

  it("emergency_alarm requires a reason string", () => {
    const tool = getDeclarations().find((d) => d.name === "emergency_alarm");
    expect(tool).toBeDefined();
    const schema = tool?.parametersJsonSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["reason"]);
    const props = schema.properties as Record<string, { type: string }>;
    expect(props.reason.type).toBe("string");
  });

  it("keeps alert and emergency_alarm separate (distinct tools, not one leveled tool)", () => {
    // Two tools rather than a single raise_alarm(level) is deliberate: it
    // forces the model into a clear binary choice and cuts down on a minor
    // situation being escalated to an emergency.
    const alert = getDeclarations().find((d) => d.name === "alert");
    const emergency = getDeclarations().find((d) => d.name === "emergency_alarm");
    expect(alert).toBeDefined();
    expect(emergency).toBeDefined();
    // Neither tool carries a "level" parameter — the tool identity IS the level.
    const alertProps = (alert?.parametersJsonSchema as any)?.properties ?? {};
    const emergencyProps = (emergency?.parametersJsonSchema as any)?.properties ?? {};
    expect(alertProps.level).toBeUndefined();
    expect(emergencyProps.level).toBeUndefined();
  });
});
