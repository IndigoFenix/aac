// Unit tests for the circle solver (shared/social-world/circle-solver.ts) — the
// pure, transport-agnostic core of "variable conversation circles". Proves the
// proximity rule's geometry/falloff, rule COMPOSITION (union of edges), and the
// asymmetric listen-in case the AudibleEdge shape exists to support.

import { describe, it, expect } from "@jest/globals";
import {
  proximityRule,
  solveAudibleFor,
  solveCircles,
  audibleRecvIds,
  type WorldParticipant,
  type ConversationRule,
} from "@shared/social-world/circle-solver.js";

const at = (personId: string, x: number, y: number, attrs?: WorldParticipant["attrs"]): WorldParticipant => ({ personId, x, y, attrs });

describe("proximityRule", () => {
  const rule = proximityRule({ radius: 8, falloffStart: 5 });

  it("includes a peer inside the radius and excludes one outside", () => {
    const self = at("me", 0, 0);
    const near = at("near", 3, 0); // d=3 ≤ falloffStart → full weight
    const far = at("far", 20, 0); // d=20 > radius → excluded
    const edges = rule(self, [near, far]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ personId: "near", weight: 1, recv: true, send: true });
  });

  it("ramps weight linearly between falloffStart and radius", () => {
    const self = at("me", 0, 0);
    // d=6.5 is halfway between start(5) and radius(8) → weight 0.5.
    const mid = at("mid", 6.5, 0);
    const [edge] = rule(self, [mid]);
    expect(edge.weight).toBeCloseTo(0.5, 5);
  });

  it("drops a peer exactly on the cutoff (weight 0)", () => {
    const self = at("me", 0, 0);
    const onEdge = at("edge", 8, 0); // d=8 == radius → weight 0 → dropped
    expect(rule(self, [onEdge])).toHaveLength(0);
  });

  it("is symmetric — equal distance gives equal weight both ways", () => {
    const a = at("a", 0, 0);
    const b = at("b", 6.5, 0);
    const ab = rule(a, [b])[0];
    const ba = rule(b, [a])[0];
    expect(ab.weight).toBeCloseTo(ba.weight, 5);
  });

  it("with no falloffStart is a hard on/off gate (weight 1 up to the radius)", () => {
    const hard = proximityRule({ radius: 8 });
    const self = at("me", 0, 0);
    const [edge] = hard(self, [at("x", 7.9, 0)]);
    expect(edge.weight).toBe(1);
  });

  it("never emits a self-edge", () => {
    const self = at("me", 0, 0);
    expect(rule(self, [at("me", 0, 0)])).toHaveLength(0);
  });
});

describe("solveAudibleFor — rule composition", () => {
  it("unions edges across rules: max weight, OR of recv/send", () => {
    const self = at("me", 0, 0);
    const other = at("you", 100, 0); // far away — proximity says nothing

    // A non-proximity rule (e.g. assigned pair) that always connects to "you".
    const pairRule: ConversationRule = (_s, others) =>
      others.filter((o) => o.personId === "you").map((o) => ({ personId: o.personId, weight: 0.4, recv: true, send: true }));

    const edges = solveAudibleFor(self, [other], [proximityRule(), pairRule]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ personId: "you", recv: true, send: true });
    expect(edges[0].weight).toBeCloseTo(0.4, 5);
  });

  it("merges two rules touching the same peer (weight = max)", () => {
    const self = at("me", 0, 0);
    const you = at("you", 1, 0); // proximity weight 1
    const weakRule: ConversationRule = (_s, others) =>
      others.map((o) => ({ personId: o.personId, weight: 0.2, recv: true, send: false }));
    const [edge] = solveAudibleFor(self, [you], [proximityRule(), weakRule]);
    expect(edge.weight).toBe(1); // max(1, 0.2)
    expect(edge.send).toBe(true); // OR(true, false)
  });
});

describe("audibleRecvIds + asymmetric listen-in", () => {
  it("returns only peers self can hear (recv && weight>0)", () => {
    const self = at("me", 0, 0);
    const edges = solveAudibleFor(self, [at("a", 1, 0), at("b", 50, 0)], [proximityRule()]);
    expect(audibleRecvIds(edges)).toEqual(new Set(["a"]));
  });

  it("a send-only edge (listen-in target) is excluded from the hearer's recv set", () => {
    // A facilitator-style rule: self can be HEARD by "spectator" but cannot hear them.
    const self = at("me", 0, 0);
    const listenIn: ConversationRule = (_s, others) =>
      others.filter((o) => o.personId === "spectator").map((o) => ({ personId: o.personId, weight: 1, recv: false, send: true }));
    const edges = solveAudibleFor(self, [at("spectator", 99, 0)], [proximityRule(), listenIn]);
    expect(audibleRecvIds(edges)).toEqual(new Set()); // self doesn't hear the spectator
    expect(edges[0]).toMatchObject({ personId: "spectator", recv: false, send: true });
  });
});

describe("solveCircles — whole-world view", () => {
  it("computes an audible set per participant and forms organic clusters", () => {
    // Two pairs far apart: {a,b} near origin, {c,d} near x=100.
    const people = [at("a", 0, 0), at("b", 2, 0), at("c", 100, 0), at("d", 102, 0)];
    const circles = solveCircles(people, [proximityRule()]);
    expect(audibleRecvIds(circles.get("a")!)).toEqual(new Set(["b"]));
    expect(audibleRecvIds(circles.get("b")!)).toEqual(new Set(["a"]));
    expect(audibleRecvIds(circles.get("c")!)).toEqual(new Set(["d"]));
    expect(audibleRecvIds(circles.get("d")!)).toEqual(new Set(["c"]));
  });
});
