// THE WALKING WINDOW, IN SHARED — `buildClusterWindow` (town-cluster.ts).
//
// The hamlet ring used to live inside world-lab's `bootLivingTown`, which made
// a `cluster: N` world BROWSER-ONLY: `headless/text-quest.ts` played
// `built.play` as-is, so `npm run world:text` / `npm run arc:run` could not
// boot one at all (trade-topology-round.md, S0 FINDING / deviation D-1). The
// ring is now ONE definition with two callers, and this file pins what that
// definition does — including the per-hamlet `hamlets` knob (user call U-1),
// which is the SAME TownPlayConfig the primary takes, applied per ring seat.
//
// Pure logic — plays are BUILT, no quest host, no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildClusterWindow,
  type ClusterWindowInput,
} from "@shared/world-engine/interaction/town/town-cluster.js";
import { buildTownPlay, type TownPlayConfig } from "@shared/world-engine/interaction/town/town-play.js";
import { parseTownWorld } from "@shared/world-engine/interaction/town/town-play-game.js";

const SEED = 12;
/** The ring's own geometry, DERIVED here exactly as the builder derives it —
 *  a literal would pin the number instead of the formula. */
const WINDOW = 4000;
const PRIMARY_AT = { x: WINDOW * 0.35, y: WINDOW * 0.35 };
const ringR = (i: number) => 1100 + 300 * i;
const ringAng = (i: number, n: number) => (i / n) * Math.PI * 1.4 + 0.4;

/** A primary town play + the built `spec.config` the ring reads. `days: 120` is
 *  the acceptance fixture's primary (trade-topology-round S0). */
function built(config: Partial<TownPlayConfig>): ClusterWindowInput {
  const full: TownPlayConfig = { seed: SEED, days: 120, questCount: 0, ...config };
  return { spec: { config: full }, play: buildTownPlay(full) };
}

describe("buildClusterWindow — the walking window, shared", () => {
  it("cluster 0 (and absent) hands the primary play straight back, unshifted", () => {
    const b = built({});
    const out = buildClusterWindow(b);
    expect(out.play).toBe(b.play);
    expect(out.windowShift).toEqual({ x: 0, y: 0 });

    const zero = built({ cluster: 0 });
    const outZero = buildClusterWindow(zero);
    expect(outZero.play).toBe(zero.play);
    expect(outZero.windowShift).toEqual({ x: 0, y: 0 });
  });

  it("cluster 2 rings two hamlets at the ring's own radii, UNBOUND, with the depot lifted", () => {
    const b = built({ cluster: 2 });
    const depot0 = b.play.stage.trade
      ? { ...b.play.stage.trade.depot }
      : null;
    const out = buildClusterWindow(b);

    // The shift is primary-town coords → window coords.
    expect(out.windowShift).toEqual({
      x: PRIMARY_AT.x - b.play.stage.center.x,
      y: PRIMARY_AT.y - b.play.stage.center.y,
    });
    expect(out.play.stage.center).toEqual(PRIMARY_AT);

    const partners = out.play.stage.cluster?.partners?.() ?? [];
    expect(partners.map((p) => p.key)).toEqual(["hamlet-1", "hamlet-2"]);
    for (const p of partners) expect(p.books).not.toBeNull();

    partners.forEach((p, i) => {
      const ang = ringAng(i, 2);
      const r = ringR(i);
      expect(p.at.x).toBeCloseTo(PRIMARY_AT.x + Math.cos(ang) * r, 6);
      expect(p.at.y).toBeCloseTo(PRIMARY_AT.y + Math.sin(ang) * r, 6);
      // …which is r metres from the primary: 1100 for the near one, 1400 for
      // the far one. The nearest-bind below is why that ordering matters.
      expect(Math.hypot(p.at.x - PRIMARY_AT.x, p.at.y - PRIMARY_AT.y)).toBeCloseTo(r, 6);
    });

    // 🔒 S2b — COMPOSING A WINDOW DOES NOT CHOOSE A PARTNER (was: "S2a —
    // nearest-bind verbatim"). The same assertion, inverted by the round it
    // was written for: the ring used to bind the CLOSEST hamlet here, at boot,
    // by `Math.hypot`, with no price and no books read. WHO is the engine's
    // decision now (`chooseTradePartner`, at the first caravan bucket, by
    // landed cost — `trade-topology.arc.test.ts` owns that half), so a freshly
    // composed window comes back on the honest abstract line.
    const trade = out.play.stage.trade;
    expect(trade).not.toBeNull();
    expect(trade!.route.partnerAt).toBeUndefined();
    expect(trade!.route.partnerKey).toMatch(/^away:/);

    // The DEPOT anchor — the one thing the host reads directly for the crates —
    // is lifted into window coordinates; the route geometry stays primary-frame.
    expect(depot0).not.toBeNull();
    expect(trade!.depot.x).toBeCloseTo(depot0!.x + out.windowShift.x, 6);
    expect(trade!.depot.y).toBeCloseTo(depot0!.y + out.windowShift.y, 6);
  });

  it("the composite line translates a WINDOW-frame bind into the primary's frame", () => {
    // The seat the ring's `− windowShift` was. The engine enumerates partners
    // in the composite's own coordinates (that is what `partners()` reports),
    // so a bind must land in the primary's frame or the caravan would walk to
    // a point 1400 m off its own map.
    const b = built({ cluster: 2 });
    const out = buildClusterWindow(b);
    const partners = out.play.stage.cluster!.partners!();
    const far = partners[1]!;
    out.play.stage.trade!.bindPartner({ key: far.key, at: { ...far.at }, distanceM: 1400 });

    const route = out.play.stage.trade!.route;
    expect(route.partnerKey).toBe("hamlet-2");
    expect(route.partnerAt!.x).toBeCloseTo(far.at.x - out.windowShift.x, 6);
    expect(route.partnerAt!.y).toBeCloseTo(far.at.y - out.windowShift.y, 6);
    // …and the wrapper delegates by REFERENCE: the host reads `tr.route` right
    // back after the bind, so a copied route would silently discard it.
    expect(out.play.stage.trade!.route).toBe(b.play.stage.trade!.route);
  });

  it("is deterministic — the same spec twice rings structurally equal partners", () => {
    const a = buildClusterWindow(built({ cluster: 2 }));
    const c = buildClusterWindow(built({ cluster: 2 }));
    const shape = (w: typeof a) =>
      (w.play.stage.cluster?.partners?.() ?? []).map((p) => ({
        key: p.key,
        at: p.at,
        pop: Math.round(p.books!.town.scalar("population")),
      }));
    expect(shape(a)).toEqual(shape(c));
    expect(a.windowShift).toEqual(c.windowShift);
  });

  describe("the `hamlets` knob (U-1) — the same town config, per ring seat", () => {
    it("gives each hamlet its own startPop, and the bigger one licenses a tailor", () => {
      const out = buildClusterWindow(
        built({ cluster: 2, hamlets: [{ startPop: 60 }, { startPop: 200 }] }),
      );
      const near = out.play.stage.cluster!.resolveHouse!(1001);
      const far = out.play.stage.cluster!.resolveHouse!(2001);
      expect(near).not.toBeNull();
      expect(far).not.toBeNull();
      // The member PLAYS carry the override…
      const cfgs = [1000, 2000].map((base) => {
        const ctx = out.play.stage.cluster!.resolveHouse!(base + 1)!;
        return ctx;
      });
      expect(Math.round(cfgs[0]!.town.scalar("population")))
        .toBeLessThan(Math.round(cfgs[1]!.town.scalar("population")));
      // …and the profile SPLIT is what makes the fixture complementary: the
      // 60-settler hamlet has no tailor (it wants clothing), the 200-settler
      // one licenses one (it can spare clothing).
      const works = (ctx: typeof cfgs[number]) => ctx.plan.works.map((w) => w.type);
      expect(works(cfgs[0]!)).not.toContain("tailor");
      expect(works(cfgs[1]!)).toContain("tailor");
    });

    it("ignores entries beyond `cluster`, and an absent knob rings the shipped default", () => {
      const withExtra = buildClusterWindow(
        built({ cluster: 2, hamlets: [{ startPop: 60 }, { startPop: 60 }, { startPop: 900 }] }),
      );
      const plain = buildClusterWindow(built({ cluster: 2 }));
      const pops = (w: typeof plain) =>
        (w.play.stage.cluster?.partners?.() ?? []).map((p) => Math.round(p.books!.town.scalar("population")));
      // 60 is the ring's own default startPop, so the two agree — the third
      // entry never reached a seat.
      expect(pops(withExtra)).toEqual(pops(plain));
      expect(pops(withExtra)).toHaveLength(2);
    });

    it("passes the document gate, and rejects a bad entry with its path", () => {
      const ok = parseTownWorld(
        { seed: SEED, days: 120, cluster: 2, hamlets: [{ population: 60 }, { population: 200, days: 200 }] },
        "game.world",
      );
      // `population` is the author's word; `startPop` is the config's, remapped
      // at the gate exactly as the primary's is.
      expect(ok.config.hamlets).toEqual([{ startPop: 60 }, { startPop: 200, days: 200 }]);

      const bad = (hamlets: unknown, path: string) =>
        expect(() => parseTownWorld({ seed: SEED, cluster: 2, hamlets }, "game.world"))
          .toThrow(new RegExp(path.replace(/[.[\]]/g, "\\$&")));

      bad([{ population: 0 }], "game.world.hamlets[0].population");
      bad([{ population: "many" }], "game.world.hamlets[0].population");
      bad([{ days: 1 }, { seed: -1 }], "game.world.hamlets[1].seed");
      bad([{ nope: 1 }], "game.world.hamlets[0].nope");
      bad([{}, {}, {}, {}, {}], "game.world.hamlets");
      bad({ population: 60 }, "game.world.hamlets");
      bad([{ charter: { farmland: 40 } }], "game.world.hamlets[0].charter.ore_access");
    });
  });
});
