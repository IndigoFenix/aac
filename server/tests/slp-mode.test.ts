/**
 * Unit tests for SLP MODE — the one AAC session behavior scoped to the
 * LOGGED-IN USER (`users.slp_mode`) rather than the student.
 *
 * Covers the pure decisions (resolution, auto-rest/auto-sleep suppression,
 * manual-request gating) and the shape of the model-facing prompt fragment.
 * The side-effectful wiring lives in AgentCoordinator; this only verifies
 * what the module DECIDES and what it EMITS.
 */

import { describe, it, expect } from "@jest/globals";
import {
  SLP,
  SLP_ROLE,
  resolveSlpMode,
  allowsIdleRest,
  allowsIdleSleep,
  isManualSleepRequest,
  buildSlpModeBlock,
} from "../services/dual-agent/slp-mode.js";

describe("resolveSlpMode", () => {
  it("is on only for an explicit true", () => {
    expect(resolveSlpMode({ slpMode: true })).toBe(true);
  });

  it("is off for false, null, undefined, a missing field, and a missing user", () => {
    expect(resolveSlpMode({ slpMode: false })).toBe(false);
    expect(resolveSlpMode({ slpMode: null })).toBe(false);
    expect(resolveSlpMode({ slpMode: undefined })).toBe(false);
    expect(resolveSlpMode({})).toBe(false);
    expect(resolveSlpMode(null)).toBe(false);
    expect(resolveSlpMode(undefined)).toBe(false);
  });

  it("never coerces a truthy non-boolean into on", () => {
    // A legacy row or a hand-rolled test double must not silently enable a
    // behavior that suppresses every cost-saving idle transition.
    expect(resolveSlpMode({ slpMode: 1 as unknown as boolean })).toBe(false);
    expect(resolveSlpMode({ slpMode: "true" as unknown as boolean })).toBe(false);
  });
});

describe("idle (MECHANICAL) transition gates", () => {
  it("allows both when SLP mode is off", () => {
    expect(allowsIdleRest(false)).toBe(true);
    expect(allowsIdleSleep(false)).toBe(true);
  });

  it("forbids both when SLP mode is on", () => {
    // These gate ONLY the mechanical paths — the idle timer and the "no face
    // visible" score. An SLP moves the device around the room, so losing the
    // student's face is not evidence the session ended.
    expect(allowsIdleRest(true)).toBe(false);
    expect(allowsIdleSleep(true)).toBe(false);
  });

  it("gate DELIBERATE transitions nowhere — that is the whole distinction", () => {
    // Guard against the gates creeping back onto the Observer's rest()/sleep()
    // in agent-coordinator. Judgment is allowed in SLP MODE; clocks and
    // face-detectors are not. If someone re-adds a gate there, this comment is
    // the reason not to. (Asserted structurally by the coordinator not
    // importing anything else from this module.)
    expect(typeof allowsIdleRest).toBe("function");
    expect(typeof allowsIdleSleep).toBe("function");
  });
});

describe("isManualSleepRequest", () => {
  it("accepts only a human-sourced request", () => {
    expect(isManualSleepRequest("user")).toBe(true);
  });

  it("ignores the client state machine and the AI", () => {
    // The client reports every automatic transition it makes as "system";
    // acting on those would let a quiet room tear the agents down behind the
    // server's own idle watchdog.
    expect(isManualSleepRequest("system")).toBe(false);
    expect(isManualSleepRequest("ai")).toBe(false);
    expect(isManualSleepRequest(undefined)).toBe(false);
  });
});

describe("buildSlpModeBlock", () => {
  it("emits nothing when SLP mode is off (normal prompts are unchanged)", () => {
    expect(buildSlpModeBlock({ studentName: "Maya", agent: "speaker", slpMode: false })).toBe("");
    expect(buildSlpModeBlock({ studentName: "Maya", agent: "observer", slpMode: false })).toBe("");
  });

  it("wraps the fragment in a single <slp_session> tag pair", () => {
    for (const agent of ["speaker", "observer"] as const) {
      const block = buildSlpModeBlock({ studentName: "Maya", agent });
      expect(block.match(/<slp_session>/g)).toHaveLength(1);
      expect(block.match(/<\/slp_session>/g)).toHaveLength(1);
      expect(block.trimEnd().endsWith("</slp_session>")).toBe(true);
    }
  });

  it("names the role in full once and uses the canonical short form after", () => {
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "speaker" });
    expect(block.match(new RegExp(SLP_ROLE, "g"))).toHaveLength(1);
    expect(block).toContain(`(${SLP})`);
  });

  it("addresses the student by name in brackets", () => {
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "speaker" });
    expect(block).toContain("[Maya]");
    expect(block).not.toContain("[studentName]");
  });

  it("tells the SPEAKER to follow the clinician's lead and wait through silences", () => {
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "speaker" }).toLowerCase();
    expect(block).toContain("follow their lead");
    expect(block).toContain("turn-taking");
    expect(block).toContain("compete");
    expect(block).toContain("silences are the therapy");
  });

  it("tells the OBSERVER not to read a therapy pause as the session ending", () => {
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "observer" });
    expect(block).toContain("rest()");
    expect(block).toContain("sleep()");
    expect(block.toLowerCase()).toContain("therapy pause");
  });

  it("leaves the OBSERVER free to rest(), and to sleep() on real evidence", () => {
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "observer" });
    // rest() is unconditional; sleep() is a judgment, not a prohibition.
    expect(block).toContain("MAY call rest()");
    expect(block).not.toMatch(/Do NOT call sleep\(\)/i);
    expect(block.toLowerCase()).toContain("session ended");
  });

  it("forbids the OBSERVER sleeping just because it cannot see anyone", () => {
    // The single most important line: the therapist carries the device, so an
    // empty frame is not an ended session. This is what SLP MODE exists for.
    const block = buildSlpModeBlock({ studentName: "Maya", agent: "observer" }).toLowerCase();
    expect(block).toContain("carries the device");
    expect(block).toContain("never sleep() merely because you can't see");
  });

  it("keeps every line short enough for a small model (PROMPT_WRITING: <130 chars)", () => {
    for (const agent of ["speaker", "observer"] as const) {
      const lines = buildSlpModeBlock({ studentName: "Maya", agent }).split("\n");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(130);
      }
    }
  });

  it("keeps the TOP-LEVEL bullet list within the 4-5 item guidance", () => {
    // PROMPT_WRITING: a list longer than 4-5 items should be broken into
    // nested sub-lists rather than run flat. So the cap applies per LEVEL —
    // the Observer's block nests its perception and its sleep rules.
    for (const agent of ["speaker", "observer"] as const) {
      const lines = buildSlpModeBlock({ studentName: "Maya", agent }).split("\n");
      const topLevel = lines.filter((l) => /^ {2}- /.test(l));
      expect(topLevel.length).toBeGreaterThan(0);
      expect(topLevel.length).toBeLessThanOrEqual(5);
    }
  });

  it("keeps every sub-list within the guidance too, and nests at most one deep", () => {
    for (const agent of ["speaker", "observer"] as const) {
      const lines = buildSlpModeBlock({ studentName: "Maya", agent }).split("\n");
      // No third level — nesting deeper than one is where small models start
      // losing track of which rule they are reading.
      expect(lines.some((l) => /^ {6}- /.test(l))).toBe(false);
      // Sub-bullets, grouped by the top-level bullet they hang under.
      let run = 0;
      for (const l of lines) {
        if (/^ {2}- /.test(l)) run = 0;
        else if (/^ {4}- /.test(l)) {
          run += 1;
          expect(run).toBeLessThanOrEqual(5);
        }
      }
    }
  });
});
