/**
 * Tests for SENTENCE BUTTON press routing (press-target.ts).
 *
 * The decision answers "should the Speaker reply to this press?" — true only
 * when the press is addressed to the AI (DEVICE). The regression these guard
 * against: in facilitator mode a target-less board defaulted to DEVICE, so
 * every press routed as "[USER to YOU]" and the Speaker replied even though it
 * was supposed to stay quiet ("the board does the talking").
 */

import { describe, it, expect } from "@jest/globals";
import { resolvePressRouting } from "../services/dual-agent/press-target.js";

const AI = ["Aivi"];

describe("resolvePressRouting — companion mode", () => {
  it("target-less press defaults to the DEVICE → Speaker responds", () => {
    const r = resolvePressRouting({ boardTarget: "DEVICE", mode: "companion", socialPeer: false, aiNames: AI });
    expect(r.toDevice).toBe(true);
    expect(r.targetLabel).toBe("YOU");
    expect(r.facilitatorAside).toBe(false);
  });

  it("a board targeted at another person stays quiet", () => {
    const r = resolvePressRouting({ boardTarget: "Mom", mode: "companion", socialPeer: false, aiNames: AI });
    expect(r.toDevice).toBe(false);
    expect(r.targetLabel).toBe("Mom");
  });

  it("the AI's own name resolves to the device", () => {
    const r = resolvePressRouting({ boardTarget: "Aivi", mode: "companion", socialPeer: false, aiNames: AI });
    expect(r.toDevice).toBe(true);
    expect(r.targetLabel).toBe("YOU");
  });
});

describe("resolvePressRouting — facilitator mode (the bug)", () => {
  it("target-less press is an aside to the person nearby → Speaker stays quiet", () => {
    const r = resolvePressRouting({ boardTarget: "DEVICE", mode: "facilitator", socialPeer: false, aiNames: AI });
    expect(r.toDevice).toBe(false);
    expect(r.facilitatorAside).toBe(true);
    expect(r.targetLabel).toBe("someone nearby");
  });

  it("an explicit non-device board target still takes the quiet path", () => {
    const r = resolvePressRouting({ boardTarget: "Dad", mode: "facilitator", socialPeer: false, aiNames: AI });
    expect(r.toDevice).toBe(false);
    expect(r.facilitatorAside).toBe(false);
    expect(r.targetLabel).toBe("Dad");
  });

  it("an EXPLICIT device target on the event reaches the Speaker (deliberate turn to AI)", () => {
    const r = resolvePressRouting({ eventTarget: "DEVICE", boardTarget: "DEVICE", mode: "facilitator", socialPeer: false, aiNames: AI });
    expect(r.facilitatorAside).toBe(false);
    expect(r.toDevice).toBe(true);
    expect(r.targetLabel).toBe("YOU");
  });

  it("social-training sessions keep the device path (peer drives the turn)", () => {
    const r = resolvePressRouting({ boardTarget: "DEVICE", mode: "facilitator", socialPeer: true, aiNames: AI });
    expect(r.facilitatorAside).toBe(false);
    expect(r.toDevice).toBe(true);
  });
});
