// ANNEXES RENDER RIGHT AFTER COMPLETION (dollhouse + every level).
//
// A room annexed onto a house is built FLUSH past the base footprint. Three
// visual defects all trace to the SAME facts this file pins:
//   1. the connecting doorway is registered on BOTH the annex room and its host
//      (so the wall renderer cuts an opening in each — no "solid wall / no door"),
//   2. the completed annex leaves NO lingering construction designation (the
//      pending-annex site is retired the moment it commits — no leftover box),
//   3. a flush annex counts as part of the focused house for the dollhouse
//      cutaway (inFocusFrame), so its roof lifts + near walls cut like the house.
//
// Pure kernel + one pure render-membership helper. No DB, no GL.

import { describe, it, expect } from "@jest/globals";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { buildingStructures } from "@shared/world-engine/engine.js";
import { inFocusFrame } from "@shared/world-engine/render3d.js";
import {
  annexOptions,
  createTownDeltas,
  requestAnnex,
} from "@shared/world-engine/kernel/town/construction.js";

const center = { x: 100, y: 100 };
/** A partitioned house with a door on the south wall — big enough to grow. */
const house = { index: 2, dx: -6, dy: -6, w: 12, h: 12, door: "south" as const };

/** Order the first feasible annex of `want` onto `house` and return the live
 *  delta + resulting plan. */
function annexed(want: Parameters<typeof annexOptions>[5]) {
  const base = houseRoomPlan(center, house);
  const deltas = createTownDeltas();
  const cands = annexOptions(center, house, base, [], deltas.get("h_2"), want);
  expect(cands.length).toBeGreaterThan(0);
  const c = cands[0]!;
  expect(requestAnnex(deltas, "h_2", c).ok).toBe(true);
  return { deltas, plan: houseRoomPlan(center, house, deltas.get("h_2")), candidate: c };
}

const specOf = (r: { id: string; rect: { x: number; y: number; w: number; h: number }; doorways: unknown[] }) => ({
  id: r.id,
  footprint: r.rect,
  floors: 1,
  stairs: false,
  wallThickness: 0.4,
  doorways: r.doorways as never,
  color: "#888",
});

describe("annex doorway is registered on both rooms (defect 2)", () => {
  it("the annex room AND its host both carry the connecting doorway", () => {
    const { plan } = annexed("sleep");
    const annex = plan.rooms.find((r) => /_a\d+$/.test(r.id))!;
    expect(annex).toBeTruthy();
    expect(annex.doorways.length).toBeGreaterThan(0);

    // The door sits at a single world point shared with exactly one host room.
    const doorPt = (r: typeof annex, d: (typeof annex.doorways)[number]) =>
      d.edge === "north" ? { x: r.rect.x + d.offset, y: r.rect.y }
      : d.edge === "south" ? { x: r.rect.x + d.offset, y: r.rect.y + r.rect.h }
      : d.edge === "west" ? { x: r.rect.x, y: r.rect.y + d.offset }
      : { x: r.rect.x + r.rect.w, y: r.rect.y + d.offset };
    const at = doorPt(annex, annex.doorways[0]!);
    const hosts = plan.rooms.filter(
      (r) => r !== annex && r.doorways.some((d) => {
        const p = doorPt(r as typeof annex, d);
        return Math.abs(p.x - at.x) < 1e-6 && Math.abs(p.y - at.y) < 1e-6;
      }),
    );
    expect(hosts.length).toBe(1); // exactly one house room shares the doorway
  });

  it("the annex's lowered walls include a door LEAF the renderer opens", () => {
    for (const want of ["sleep", "wet"] as const) {
      const { plan } = annexed(want);
      const annex = plan.rooms.find((r) => /_a\d+$/.test(r.id))!;
      const structs = buildingStructures(specOf(annex));
      const doors = structs.filter((s) => s.kind === "door");
      expect(doors.length).toBe(1); // the near wall is cut, not solid
    }
  });
});

describe("a committed annex leaves no lingering construction site (defect 1)", () => {
  it("requestAnnex + removeAnnexSite clears the pending row and bumps the rev", () => {
    const base = houseRoomPlan(center, house);
    const deltas = createTownDeltas();
    const p = deltas.postAnnexSite({
      buildingKey: "h_2",
      cluster: "sleep",
      candidate: annexOptions(center, house, base, [], deltas.get("h_2"), "sleep")[0]!,
      costs: { wood: 2 },
      pile: {},
      startedDay: 1,
      buildDays: 0.125,
    });
    expect(deltas.annexSites()).toHaveLength(1);
    const revBefore = deltas.get("h_2")?.rev ?? 0;

    // COMMIT — the room rises, the pending designation is retired.
    expect(requestAnnex(deltas, "h_2", p.candidate).ok).toBe(true);
    deltas.removeAnnexSite(p.ord);

    // No pending site survives (nothing for the stage to keep painting as a
    // flat construction marking), and the building's rev bumped so the stage
    // re-plans + retires the scaffold.
    expect(deltas.annexSites()).toHaveLength(0);
    expect(deltas.get("h_2")!.annexes).toHaveLength(1);
    expect((deltas.get("h_2")?.rev ?? 0)).toBeGreaterThan(revBefore);
  });
});

describe("a flush annex belongs to the dollhouse focus (defect 3)", () => {
  it("inFocusFrame includes an annex flush past the base but excludes a cleared neighbour", () => {
    const { plan } = annexed("sleep");
    const sf = { // the base house footprint = the dollhouse frame (quest-host)
      x: center.x + house.dx,
      y: center.y + house.dy,
      w: house.w,
      h: house.h,
    };
    const annex = plan.rooms.find((r) => /_a\d+$/.test(r.id))!;

    // Every base room is inside the frame; the annex lies wholly OUTSIDE it
    // (flush) yet still counts as part of the focus.
    for (const r of plan.rooms) expect(inFocusFrame(r.rect, sf)).toBe(true);
    const strictOverlap =
      annex.rect.x < sf.x + sf.w && annex.rect.x + annex.rect.w > sf.x &&
      annex.rect.y < sf.y + sf.h && annex.rect.y + annex.rect.h > sf.y;
    expect(strictOverlap).toBe(false); // proves the old strict test dropped it

    // A neighbour house kept a clearance gap (≥1 m) — never swept into focus.
    const neighbourWest = { x: sf.x - 4 - 1.5, y: sf.y, w: 4, h: house.h };
    expect(inFocusFrame(neighbourWest, sf)).toBe(false);
    const neighbourSouth = { x: sf.x, y: sf.y + sf.h + 1.5, w: house.w, h: 4 };
    expect(inFocusFrame(neighbourSouth, sf)).toBe(false);
  });
});
