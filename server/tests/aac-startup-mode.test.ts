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
  buildStartupBoardDirective,
} from "../services/dual-agent/startup-mode.js";
import { OBSERVER_STARTUP_PROMPT } from "../services/dual-agent/prompts/observer.js";
import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";
import {
  buildBoardManagerPrompt,
  buildForceRebuildHint,
} from "../services/dual-agent/prompts/board-manager.js";

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

describe("buildStartupBoardDirective", () => {
  const directive = buildStartupBoardDirective();

  it("states its own SITUATION first — buildForceRebuildHint is situation-neutral", () => {
    // The hint no longer claims a home press, so a directive that never says
    // what happened would reach the model as a palette with no occasion.
    expect(directive.slice(0, 80).toLowerCase()).toContain("session has just started");
    const hint = buildForceRebuildHint(directive);
    expect(hint).toContain(directive);
    expect(hint).not.toMatch(/pressed a home-board navigation button/i);
    expect(hint).toMatch(/Do NOT call no_change/i);
  });

  it("REQUIRES exactly one here-and-now button grounded in the observations", () => {
    expect(directive).toMatch(/REQUIRED: exactly ONE/);
    expect(directive).toContain("HERE-AND-NOW");
    // Read off the Observer's scene lines, not invented.
    expect(directive).toContain("[CONTEXT]");
    expect(directive.toLowerCase()).toContain("actually observed");
    expect(directive.toLowerCase()).toMatch(/rather than inventing/);
  });

  it("hands the press behavior off to the system prompt's <here_and_now> block", () => {
    // The directive is one-shot (cleared once BM honors it), so the press
    // itself lands on a turn that only has the system prompt to go on.
    expect(directive).toContain("<here_and_now>");
  });
});

describe("Board Manager <here_and_now> block", () => {
  const { base } = buildBoardManagerPrompt({
    studentName: "Alex",
    language: "en",
    muteState: "unmuted",
  });
  const block = base.slice(base.indexOf("<here_and_now>"), base.indexOf("</here_and_now>"));

  it("is present in the BASE prompt, not a mode block", () => {
    // The press arrives long after the startup directive was cleared — if the
    // rule only lived in a suffix block it would not be loaded on that turn.
    expect(block).toContain("<here_and_now>");
  });

  it("turns a press on the here-and-now button into that place's vocabulary", () => {
    expect(block.toLowerCase()).toContain("press");
    expect(block).toContain("VOCABULARY");
    expect(block.toLowerCase()).toContain("observed");
    // A place always overflows one board.
    expect(block).toContain('button_type: "more"');
  });

  it("keeps it a NORMAL button — the meta button_types render fixed art", () => {
    expect(block.toLowerCase()).toContain("no `button_type`");
  });
});
