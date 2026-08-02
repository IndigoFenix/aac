// THE GRANARY FEEDBACK (FlowNetSpec.feed — settlement-emergence.md §6):
// a drift stockpile that FEEDS the shortfall it is drained by. Before this
// flag, a shortage drained the granary while `satisfied` still reported the
// bare proportional fill — the stock paid and the town starved anyway.
// Seasonality (a yield that dies every winter) is exactly the draw that
// exposes it, so step ② ships the fix as an opt-in flow-net semantic and
// pins the old behavior byte-stable when the flag is off.

import { describe, it, expect } from "@jest/globals";
import {
  createWorld, stepWorld, validateWorldSpec, type WorldSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/economy.js";
import { parseEconomyDoc } from "@shared/world-engine/kernel/modules/economy/json.js";

/** A one-commodity world: src → net → got, banked in stock. */
const world = (opts: { feed?: boolean; n?: number; edges?: [number, number][] }): WorldSpec => ({
  id: "granary-lab",
  entity: {
    id: "town",
    vars: [
      { name: "src", min: 0, max: 100, initial: 0 },
      { name: "dem", min: 0, max: 100, initial: 0 },
      { name: "got", min: 0, max: 100, initial: 0 },
      { name: "stock", min: 0, max: 100, initial: 0 },
    ],
    rules: [],
  },
  flownets: [{
    id: "food", source: "src", demand: "dem", satisfied: "got", drift: "stock",
    ...(opts.feed ? { feed: true } : {}),
  }],
});

describe("feed: the stock tops up the shortfall, and the eating IS the drain", () => {
  it("a fed town eats whole from its granary until the granary is dry", () => {
    const w = createWorld(world({ feed: true }), 1, []);
    w.scalars.dem[0] = 5;
    w.scalars.stock[0] = 12;
    // Steps 1–2: full demand met from stock (5 + 5), stock 12 → 7 → 2.
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(5);
    expect(w.scalars.stock[0]).toBe(7);
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(5);
    expect(w.scalars.stock[0]).toBe(2);
    // Step 3: only 2 left — partial meal, stock empties exactly.
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(2);
    expect(w.scalars.stock[0]).toBe(0);
    // Step 4: dry — the shortage is real now, and nothing drains below 0.
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(0);
    expect(w.scalars.stock[0]).toBe(0);
  });

  it("WITHOUT feed the old semantics hold byte-stable: the stock drains and the fill starves anyway", () => {
    const w = createWorld(world({}), 1, []);
    w.scalars.dem[0] = 5;
    w.scalars.stock[0] = 12;
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(0); // nobody ate what the granary paid
    expect(w.scalars.stock[0]).toBe(7);
    stepWorld(w);
    stepWorld(w);
    expect(w.scalars.stock[0]).toBe(0); // clamped at empty
    expect(w.scalars.got[0]).toBe(0);
  });

  it("surplus accumulation is unchanged in both modes", () => {
    for (const feed of [true, false]) {
      const w = createWorld(world({ feed }), 1, []);
      w.scalars.src[0] = 8;
      w.scalars.dem[0] = 5;
      stepWorld(w);
      expect(w.scalars.got[0]).toBe(5);
      expect(w.scalars.stock[0]).toBe(3); // the overproduction banks
    }
  });

  it("per-entity: the stocked town eats its own granary; its dry neighbour starves", () => {
    const w = createWorld(world({ feed: true, edges: [[0, 1]] }), 2, [[0, 1]]);
    w.scalars.dem[0] = 5;
    w.scalars.dem[1] = 5;
    w.scalars.stock[0] = 20;
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(5); // fed from its OWN stock
    expect(w.scalars.got[1]).toBe(0); // nothing to eat, nothing drained
    expect(w.scalars.stock[0]).toBe(15);
    expect(w.scalars.stock[1]).toBe(0);
  });

  it("a fed stockpile still rides through a SEASONAL draw: bank the summer, eat the winter", () => {
    const w = createWorld(world({ feed: true }), 1, []);
    w.scalars.dem[0] = 5;
    // Fat season: production 8/step for 10 steps → 30 banked.
    w.scalars.src[0] = 8;
    for (let i = 0; i < 10; i++) stepWorld(w);
    expect(w.scalars.stock[0]).toBe(30);
    // Winter: production dies; the town eats whole for 6 steps (30/5)...
    w.scalars.src[0] = 0;
    for (let i = 0; i < 6; i++) {
      stepWorld(w);
      expect(w.scalars.got[0]).toBe(5);
    }
    expect(w.scalars.stock[0]).toBe(0);
    // ...and starves on the 7th. The granary bought exactly 6 days of winter.
    stepWorld(w);
    expect(w.scalars.got[0]).toBe(0);
  });
});

describe("the gates", () => {
  it("the validator refuses feed with no drift, and accepts the granary shape", () => {
    const bad = world({ feed: true });
    delete (bad.flownets![0] as { drift?: string }).drift;
    const r = validateWorldSpec(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/feed requires a drift stockpile/);
    expect(validateWorldSpec(world({ feed: true })).ok).toBe(true);
  });

  it("the economy seam: transport.driftFeeds emits feed on the compiled net, construction-gated with its drift", () => {
    const doc = parseEconomyDoc({
      stockpiles: [{ key: "granary", max: 400, construction: true }],
      commodities: [{
        key: "food", scalarMax: 200,
        transport: { drift: "granary", driftFeeds: true, driftRequiresConstruction: true },
      }],
    }, "t");
    const withC = compileEconomy([doc], { construction: true });
    expect(withC.flownets[0]).toMatchObject({ id: "food", drift: "granary", feed: true });
    // No construction ⇒ no granary ⇒ no drift AND no feed.
    const withoutC = compileEconomy([doc]);
    expect(withoutC.flownets[0].drift).toBeUndefined();
    expect(withoutC.flownets[0].feed).toBeUndefined();
  });

  it("driftFeeds with no drift fails compile naming the commodity; the JSON gate types the flag", () => {
    expect(() =>
      compileEconomy([{ commodities: [{ key: "food", scalarMax: 10, transport: { driftFeeds: true } }] }]),
    ).toThrow(/commodity "food" declares driftFeeds with no drift/);
    expect(() =>
      parseEconomyDoc({ commodities: [{ key: "food", scalarMax: 10, transport: { driftFeeds: "yes" } }] }, "t"),
    ).toThrow(/"driftFeeds" must be a boolean/);
  });
});
