// Unit tests for the proximity media gate (shared/social-world/media-gate.ts).
// Proves the connect/disconnect decisions and — the part that can't be eyeballed
// — the two-radius HYSTERESIS band that stops boundary thrash.

import { describe, it, expect } from "@jest/globals";
import { planMedia, audibleGains, DEFAULT_MEDIA_GATE, type MediaGateConfig } from "@shared/social-world/media-gate.js";
import type { WorldParticipant } from "@shared/social-world/circle-solver.js";

const at = (personId: string, x: number, y: number): WorldParticipant => ({ personId, x, y });
// connectRadius 8, dropRadius 11, falloffStart 8.
const CFG: MediaGateConfig = DEFAULT_MEDIA_GATE;

describe("planMedia", () => {
  it("opens a connection to an in-range peer that isn't connected", () => {
    const people = [at("me", 0, 0), at("near", 4, 0)];
    const plan = planMedia("me", people, [], CFG);
    expect(plan.connect).toEqual(["near"]);
    expect(plan.disconnect).toEqual([]);
    expect(plan.gains.get("near")).toBe(1); // d=4 ≤ falloffStart → full volume
  });

  it("ignores an out-of-range peer that isn't connected", () => {
    const people = [at("me", 0, 0), at("far", 20, 0)];
    const plan = planMedia("me", people, [], CFG);
    expect(plan.connect).toEqual([]);
    expect(plan.disconnect).toEqual([]);
    expect(plan.gains.size).toBe(0);
  });

  it("drops a connected peer once it passes the drop radius", () => {
    const people = [at("me", 0, 0), at("gone", 12, 0)]; // d=12 > dropRadius(11)
    const plan = planMedia("me", people, ["gone"], CFG);
    expect(plan.disconnect).toEqual(["gone"]);
    expect(plan.gains.has("gone")).toBe(false);
  });

  it("keeps a connected peer inside the connect radius at full volume", () => {
    const people = [at("me", 0, 0), at("close", 5, 0)];
    const plan = planMedia("me", people, ["close"], CFG);
    expect(plan.connect).toEqual([]);
    expect(plan.disconnect).toEqual([]);
    expect(plan.gains.get("close")).toBe(1);
  });

  it("fades (but keeps) a connected peer in the hysteresis band", () => {
    const people = [at("me", 0, 0), at("edge", 9.5, 0)]; // between 8 and 11
    const plan = planMedia("me", people, ["edge"], CFG);
    expect(plan.disconnect).toEqual([]);
    // weight = 1 - (9.5 - 8)/(11 - 8) = 0.5
    expect(plan.gains.get("edge")).toBeCloseTo(0.5, 5);
  });

  describe("hysteresis at a boundary distance (d=9, between connect and drop)", () => {
    const people = [at("me", 0, 0), at("p", 9, 0)];
    it("does NOT open if currently disconnected (past connect radius)", () => {
      const plan = planMedia("me", people, [], CFG);
      expect(plan.connect).toEqual([]);
    });
    it("does NOT drop if currently connected (within drop radius)", () => {
      const plan = planMedia("me", people, ["p"], CFG);
      expect(plan.disconnect).toEqual([]);
      expect(plan.gains.has("p")).toBe(true);
    });
  });

  it("holds connections (no drops) when our own position is unknown", () => {
    const people = [at("a", 1, 1), at("b", 2, 2)]; // no "me" entry
    const plan = planMedia("me", people, ["a", "b"], CFG);
    expect(plan.connect).toEqual([]);
    expect(plan.disconnect).toEqual([]);
    expect(plan.gains.get("a")).toBe(1);
    expect(plan.gains.get("b")).toBe(1);
  });

  it("audibleGains: in-circle peers fade with distance, far peers are absent", () => {
    const people = [
      at("me", 0, 0),
      at("near", 4, 0),  // ≤ falloffStart → 1
      at("edge", 9.5, 0), // in the 8–11 band → fades
      at("far", 20, 0),   // beyond dropRadius → absent (out of circle)
    ];
    const gains = audibleGains("me", people, CFG);
    expect(gains.get("near")).toBe(1);
    expect(gains.get("edge")).toBeCloseTo(0.5, 5);
    expect(gains.has("far")).toBe(false);
  });

  it("audibleGains: empty when our own position is unknown", () => {
    expect(audibleGains("me", [at("a", 1, 0)], CFG).size).toBe(0);
  });

  it("handles a mixed crowd in one pass", () => {
    const people = [
      at("me", 0, 0),
      at("inNew", 3, 0),   // in range, not connected → connect
      at("inOld", 6, 0),   // in range, connected → keep
      at("buffer", 10, 0), // hysteresis, connected → keep + fade
      at("left", 30, 0),   // far, connected → disconnect
      at("stranger", 40, 0), // far, not connected → ignored
    ];
    const plan = planMedia("me", people, ["inOld", "buffer", "left"], CFG);
    expect(plan.connect).toEqual(["inNew"]);
    expect(plan.disconnect).toEqual(["left"]);
    expect(new Set(plan.gains.keys())).toEqual(new Set(["inNew", "inOld", "buffer"]));
  });
});
