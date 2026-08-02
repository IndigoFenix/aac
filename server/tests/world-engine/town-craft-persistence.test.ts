// CRAFT-JOB + SHELL-PILE PERSISTENCE (construction rewrite 1b), at the pure
// layer — the standing make-orders and the `bfurn:` furniture-delivery piles
// ride TownDeltas now, so a reload RESUMES the work instead of orphaning its
// haul agreements and craftspot reservations (the rescue machinery those
// session-lived maps made necessary is reduced to a legacy-save janitor).
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  type CraftJob,
} from "@shared/world-engine/kernel/town/construction.js";

const job = (over: Partial<CraftJob> = {}): CraftJob => ({
  produces: "furn.chair",
  consumes: { wood: 2 },
  at: "workbench",
  label: "chair",
  spotId: "furn_3_woodstore",
  agreements: ["agr_7"],
  laborS: 0,
  ...over,
});

describe("craft-job persistence (rewrite 1b)", () => {
  it("starts empty and absent-tolerant (every pre-1b save)", () => {
    const d = createTownDeltas();
    expect(d.craftJobs.size).toBe(0);
    expect(d.shellFurnPiles.size).toBe(0);
    // A serialized pre-1b payload simply lacks the fields.
    const legacy = createTownDeltas({ version: 3, buildings: {} });
    expect(legacy.craftJobs.size).toBe(0);
    expect(legacy.shellFurnPiles.size).toBe(0);
  });

  it("round-trips a mid-gather job byte-equal, keyed by house", () => {
    const d = createTownDeltas();
    d.craftJobs.set(3, job({ waitingSince: 120 }));
    const back = createTownDeltas(JSON.parse(JSON.stringify(d.toJSON())));
    expect(back.craftJobs.size).toBe(1);
    expect(back.craftJobs.get(3)).toEqual(job({ waitingSince: 120 }));
    // Numeric keys survive the Record<string, …> wire shape.
    expect([...back.craftJobs.keys()]).toEqual([3]);
  });

  it("round-trips a mid-LABOR job — the finish line survives reload", () => {
    const d = createTownDeltas();
    d.craftJobs.set(0, job({ laborStart: 500, laborS: 90, lastWorkedAt: 560 }));
    const back = createTownDeltas(d.toJSON());
    const j = back.craftJobs.get(0)!;
    expect(j.laborStart).toBe(500);
    expect(j.laborS).toBe(90);
    expect(j.lastWorkedAt).toBe(560);
    // The agreements list rides along — reservations keep their owner.
    expect(j.agreements).toEqual(["agr_7"]);
  });

  it("round-trips shell furniture piles and clones on load (no aliasing)", () => {
    const d = createTownDeltas();
    d.shellFurnPiles.set("w_20", { "furn.bed": 1, "furn.chair": 2 });
    const json = d.toJSON();
    const back = createTownDeltas(json);
    expect(back.shellFurnPiles.get("w_20")).toEqual({ "furn.bed": 1, "furn.chair": 2 });
    // The store owns its state: mutating the loaded copy never reaches the
    // JSON (the deep-clone-on-load law every other collection follows).
    back.shellFurnPiles.get("w_20")!["furn.bed"] = 9;
    back.craftJobs.set(1, job());
    expect(json.shellFurnPiles?.["w_20"]?.["furn.bed"]).toBe(1);
    expect(json.craftJobs?.["1"]).toBeUndefined();
  });

  it("serializes beside the other town-wide collections without disturbing them", () => {
    const d = createTownDeltas();
    d.stock.wood = 5;
    d.craftJobs.set(2, job());
    const back = createTownDeltas(d.toJSON());
    expect(back.stock).toEqual({ wood: 5 });
    expect(back.craftJobs.get(2)?.produces).toBe("furn.chair");
  });
});
