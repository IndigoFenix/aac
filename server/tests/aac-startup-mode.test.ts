/**
 * Tests for the AAC session STARTUP behavior (CONTEXTUAL / MENU).
 *
 * Covers the pure decision helpers in startup-mode.ts plus the prompt-side
 * guarantees the orchestration relies on: the stronger first-frame Observer
 * prompt and the Speaker's stay-on-activity hardening. The full coordinator
 * wiring (first-frame prompt selection, [PEOPLE PRESENT] injection, greeting
 * sendUserTurn) lives in agent-coordinator.ts and is exercised in integration.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveStartupMode,
  decideStartupAction,
  buildStartupGreetingTurn,
} from "../services/dual-agent/startup-mode.js";
import { OBSERVER_STARTUP_PROMPT } from "../services/dual-agent/prompts/observer.js";
import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";

describe("resolveStartupMode", () => {
  it("defaults to CONTEXTUAL on a personal device", () => {
    expect(resolveStartupMode({ classroomId: null })).toBe("contextual");
  });

  it("selects MENU for a shared / classroom device", () => {
    expect(resolveStartupMode({ classroomId: "class-1" })).toBe("menu");
  });
});

describe("decideStartupAction", () => {
  it("greets in CONTEXTUAL mode when the active user is identified", () => {
    expect(decideStartupAction({ startupBehavior: "contextual", activeUserIdentified: true, socialPeerActive: false })).toBe("greet");
  });

  it("waits in CONTEXTUAL mode when no one has been identified (never greet the unseen)", () => {
    expect(decideStartupAction({ startupBehavior: "contextual", activeUserIdentified: false, socialPeerActive: false })).toBe("wait");
  });

  it("always waits in MENU mode, even with an identified user", () => {
    expect(decideStartupAction({ startupBehavior: "menu", activeUserIdentified: true, socialPeerActive: false })).toBe("wait");
  });

  it("waits when a social-training peer owns the session", () => {
    expect(decideStartupAction({ startupBehavior: "contextual", activeUserIdentified: true, socialPeerActive: true })).toBe("wait");
  });
});

describe("buildStartupGreetingTurn", () => {
  it("is a [SESSION START] turn naming the student and steering to the setting", () => {
    const turn = buildStartupGreetingTurn("Alex");
    expect(turn).toContain("[SESSION START]");
    expect(turn).toContain("Alex");
    expect(turn.toLowerCase()).toContain("greet");
    expect(turn.toLowerCase()).toContain("activity");
  });
});

describe("OBSERVER_STARTUP_PROMPT", () => {
  it("asks for a detailed first-frame read: setting, people, activity, and who the user is", () => {
    const p = OBSERVER_STARTUP_PROMPT.toLowerCase();
    expect(p).toContain("[session start]");
    expect(p).toContain("setting");
    expect(p).toContain("activity");
    // Must drive identity determination off the biometric block.
    expect(OBSERVER_STARTUP_PROMPT).toContain("[PEOPLE PRESENT]");
    expect(OBSERVER_STARTUP_PROMPT).toContain("[THE STUDENT]");
    expect(p).toContain("user");
  });
});

describe("Speaker stay-on-context hardening", () => {
  const prompt = buildSpeakerPrompt({ studentName: "Alex", persona: "", muteState: "unmuted" });

  it("includes a stay_on_context block anchored to the current activity", () => {
    expect(prompt).toContain("<stay_on_context>");
    expect(prompt.toLowerCase()).toContain("current activity");
  });

  it("forbids suggesting to leave or switch to an unrelated activity unprompted", () => {
    const block = prompt.slice(prompt.indexOf("<stay_on_context>"), prompt.indexOf("</stay_on_context>"));
    expect(block.toLowerCase()).toContain("never");
    expect(block.toLowerCase()).toMatch(/leav|go (somewhere|outside)|unrelated/);
  });
});
