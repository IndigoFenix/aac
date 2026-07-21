// TRANSFER-LEDGER PERSISTENCE (nations arc P0): standing trade routes and
// in-flight hauls serialize WITH the town deltas (the one restore envelope)
// and resume on reload — the ② ledger and the ⑤ abstract-partner shelves
// ride SerializedTownDeltas exactly as founded buildings do. Pure kernel +
// town-play; no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction.js";
import {
  runDueTransfers,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";
import { foundSite, siteTownConfig } from "@shared/world-engine/interaction/town/founding.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";

const endpoint = (id: string, stack: Record<string, number>): StockEndpoint => ({
  id,
  kind: "test",
  stack,
});

describe("the ledger + partner shelves ride SerializedTownDeltas", () => {
  it("round-trips agreements (haul mid-carry, standing, barter) and partner stock", () => {
    const d = createTownDeltas();
    // A one-shot haul, claimed and mid-carry.
    const haul = d.transfers.post({
      from: "a", to: "b", goods: { wood: 2 }, issuer: "player", mode: "haul", now: 10,
    });
    d.transfers.begin(haul.id, "npc_7");
    d.transfers.load(haul.id, { wood: 2 });
    // A standing scheduled route.
    d.transfers.post({
      from: "town:us", to: "town:them", goods: { food: 1 }, issuer: "player",
      mode: "scheduled", now: 10, every: 240, dueAt: 500,
    });
    // A barter row (⑤) — serialized verbatim, executed only by runDueBarters.
    d.transfers.post({
      from: "town:us", to: "town:away:9", goods: { wood: 3 }, issuer: "player",
      mode: "scheduled", now: 10, every: 240, dueAt: 300,
      barter: {
        take: { food: 2 }, giveGood: "wood", takeGood: "food",
        quote: { give: 3, take: 2 }, partnerKey: "away:9",
      },
    });
    d.partnerStock["away:9"] = { food: 5 };

    const revived = createTownDeltas(JSON.parse(JSON.stringify(d.toJSON())));
    expect(revived.toJSON()).toEqual(d.toJSON());
    expect(revived.partnerStock["away:9"]).toEqual({ food: 5 });
    // The revived ledger's serial continues — no id collision with old rows.
    const next = revived.transfers.post({
      from: "x", to: "y", goods: { stone: 1 }, issuer: "player", mode: "haul", now: 0,
    });
    expect(revived.transfers.get(next.id)).toBe(next);
    expect(d.transfers.get(next.id)).toBeUndefined();
    expect(next.id).not.toBe(haul.id);
  });

  it("deep-copies on load — mutating the revived store never touches the JSON", () => {
    const d = createTownDeltas();
    d.transfers.post({ from: "a", to: "b", goods: { wood: 1 }, issuer: "p", mode: "haul", now: 0 });
    d.partnerStock.k = { food: 1 };
    const json = d.toJSON();
    const revived = createTownDeltas(json);
    revived.partnerStock.k!.food = 99;
    revived.transfers.complete(revived.transfers.active()[0]!.id);
    expect(json.partnerStock?.k?.food).toBe(1);
    expect(json.transfers?.agreements[0]?.status).toBe("pending");
  });
});

describe("reload resumes the routes (town-play restore normalization)", () => {
  const restoredPlay = () => {
    const site = foundSite({ seed: 41, at: { x: 50, y: 50 }, key: "ledgerton" });
    // A mid-haul row whose executor body will not exist after reload…
    const haul = site.deltas.transfers.post({
      from: "a", to: "b", goods: { wood: 2 }, issuer: "player", mode: "haul", now: 33,
    });
    site.deltas.transfers.begin(haul.id, "npc_gone");
    site.deltas.transfers.load(haul.id, { wood: 2 });
    // …a standing route due far into the DEAD session's clock…
    site.deltas.transfers.post({
      from: "town:us", to: "town:away:41", goods: { food: 1 }, issuer: "player",
      mode: "scheduled", now: 33, every: 240, dueAt: 5000,
    });
    // …a finished row (untouched by normalization)…
    const done = site.deltas.transfers.post({
      from: "a", to: "b", goods: { stone: 1 }, issuer: "player", mode: "haul", now: 33,
    });
    site.deltas.transfers.begin(done.id, "npc_x");
    site.deltas.transfers.complete(done.id);
    // …and a partner shelf.
    site.deltas.partnerStock["away:41"] = { food: 4 };
    return buildTownPlay(siteTownConfig(site));
  };

  it("mid-haul rows lose the dead executor but KEEP the load; standing legs come due now", () => {
    const play = restoredPlay();
    const rows = play.deltas.transfers.active();
    const haul = rows.find((a) => a.mode === "haul")!;
    expect(haul.status).toBe("pending");
    expect(haul.executor).toBeUndefined();
    expect(haul.carried).toEqual({ wood: 2 }); // a reload never loses a load
    const standing = rows.find((a) => a.mode === "scheduled")!;
    expect(standing.nextDueAt).toBe(0);
    expect(play.deltas.transfers.get(
      play.deltas.transfers.toJSON().agreements.find((a) => a.status === "done")!.id,
    )?.status).toBe("done");
    expect(play.deltas.partnerStock["away:41"]).toEqual({ food: 4 });
  });

  it("the standing leg actually RUNS on the new clock's first sweep", () => {
    const play = restoredPlay();
    const us = endpoint("town:us", { food: 3 });
    const them = endpoint("town:away:41", {});
    const reports = runDueTransfers(
      play.deltas.transfers,
      (id) => (id === "town:us" ? us : id === "town:away:41" ? them : null),
      0, // the reborn session's clock starts at zero — the route resumes NOW
    );
    expect(reports.some((r) => r.moved.food === 1)).toBe(true);
    expect(them.stack.food).toBe(1);
  });

  it("restore is stable — rebuilding from the restored session's own JSON changes nothing", () => {
    const play = restoredPlay();
    const again = buildTownPlay({ ...play.config, deltas: play.deltas.toJSON() });
    expect(again.deltas.toJSON()).toEqual(play.deltas.toJSON());
  });
});
