// Deterministic kernels of the multiplayer NPC system. The transport + React
// conversation layer are integration-tested by hand, but the two pure pieces that
// MUST be right — owner election (every peer converges on the same host) and the
// mood→body bias — are unit-tested here.

import { describe, it, expect } from "@jest/globals";
import { electNpcOwner, resolveWorldOwner, modeToPull } from "@shared/social-world/npc-conversation-logic.js";

describe("electNpcOwner", () => {
  it("is solo (null) before the call is ready", () => {
    expect(electNpcOwner(null, [])).toBeNull();
  });

  it("self owns when alone", () => {
    expect(electNpcOwner("p5", [])).toBe("p5");
  });

  it("picks the lexicographically-smallest participant id", () => {
    expect(electNpcOwner("p5", ["p2", "p9"])).toBe("p2");
    expect(electNpcOwner("p1", ["p2", "p9"])).toBe("p1");
  });

  it("every peer converges on the SAME owner regardless of who computes it", () => {
    const all = ["pc", "pa", "pb"];
    const owners = all.map((self) => electNpcOwner(self, all.filter((x) => x !== self)));
    expect(new Set(owners).size).toBe(1);
    expect(owners[0]).toBe("pa");
  });
});

describe("resolveWorldOwner (nominated host, then election)", () => {
  it("is solo (null) before the call is ready", () => {
    expect(resolveWorldOwner(null, [], "pz")).toBeNull();
  });

  it("the nominated host owns the world even when it isn't the smallest id", () => {
    // The clinician ("pz") started the game room, so their machine hosts the sim
    // rather than the AAC tablet that happens to sort first.
    expect(resolveWorldOwner("pa", ["pz"], "pz")).toBe("pz");
    expect(resolveWorldOwner("pz", ["pa"], "pz")).toBe("pz");
  });

  it("every peer converges on the SAME owner", () => {
    const all = ["pc", "pa", "pz"];
    const owners = all.map((self) => resolveWorldOwner(self, all.filter((x) => x !== self), "pz"));
    expect(new Set(owners)).toEqual(new Set(["pz"]));
  });

  it("falls back to the election when no host is named", () => {
    expect(resolveWorldOwner("pc", ["pa", "pz"])).toBe("pa");
    expect(resolveWorldOwner("pc", ["pa", "pz"], null)).toBe("pa");
  });

  it("falls back to the election when the named host is not in the call", () => {
    // The host hung up; the remaining peers must still agree on one owner.
    const rest = ["pc", "pa"];
    const owners = rest.map((self) => resolveWorldOwner(self, rest.filter((x) => x !== self), "pz"));
    expect(new Set(owners)).toEqual(new Set(["pa"]));
  });
});

describe("modeToPull (mood → body bias)", () => {
  it("withdrawn pulls away, open/playful pull in", () => {
    expect(modeToPull("WITHDRAWN", 0)).toBeLessThan(0);
    expect(modeToPull("NEUTRAL", 0)).toBeCloseTo(0);
    expect(modeToPull("OPEN", 0)).toBeGreaterThan(0);
    expect(modeToPull("PLAYFUL", 0)).toBeGreaterThan(modeToPull("OPEN", 0));
  });

  it("is monotonic in rapport and clamped to [-1, 1]", () => {
    expect(modeToPull("PLAYFUL", 1)).toBeLessThanOrEqual(1);
    expect(modeToPull("WITHDRAWN", -1)).toBeGreaterThanOrEqual(-1);
    expect(modeToPull("NEUTRAL", 1)).toBeGreaterThan(modeToPull("NEUTRAL", -1));
  });
});
