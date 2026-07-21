// The household DUTY ROSTER (kernel/town/roster.ts): the ONE member↔duty allocator.
// The default shopping assignment must reproduce the historical member==slot rule
// (byte-stable streaming), including the exclusion-handover semantics runnerId had.
import { describe, expect, it } from "@jest/globals";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/goods.js";
import {
  ATTENDANCE_FLOOR,
  SHIFT_LEN,
  STAFF_PER_WORK,
  assignTownJobs,
  attendanceFactor,
  noteAbsence,
  inShiftWindow,
  jobDutyOf,
  rosterOf,
  shopDutyOf,
  shopMemberOf,
} from "@shared/world-engine/kernel/town/roster.js";

const GOODS = [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }];

describe("rosterOf — the default shopping assignment", () => {
  it("good of slot r lands on member r (the historical identity), homebodies get none", () => {
    const roster = rosterOf(GOODS);
    expect(roster).toHaveLength(HOUSEHOLD);
    expect(shopDutyOf(roster[0])).toEqual({ good: "food", role: 0 });
    expect(shopDutyOf(roster[1])).toEqual({ good: "cloth", role: 1 });
    for (let m = 2; m < HOUSEHOLD; m++) expect(shopDutyOf(roster[m])).toBeUndefined();
  });

  it("exclusions hand the role down — the (r+1)-th NON-excluded member (runnerId's rule)", () => {
    const roster = rosterOf(GOODS, new Set([0]));
    expect(shopDutyOf(roster[0])).toBeUndefined(); // excluded holds nothing
    expect(shopDutyOf(roster[1])).toEqual({ good: "food", role: 0 });
    expect(shopDutyOf(roster[2])).toEqual({ good: "cloth", role: 1 });
  });

  it("a house with fewer souls than roles drops the later runs (still eats)", () => {
    const all = new Set(Array.from({ length: HOUSEHOLD - 1 }, (_, m) => m + 1)); // one soul left
    const roster = rosterOf(GOODS, all);
    expect(shopDutyOf(roster[0])).toEqual({ good: "food", role: 0 });
    expect(shopMemberOf(roster, "cloth")).toBeNull();
  });

  it("shopMemberOf inverts the assignment; deterministic across calls", () => {
    expect(shopMemberOf(rosterOf(GOODS), "food")).toBe(0);
    expect(shopMemberOf(rosterOf(GOODS), "cloth")).toBe(1);
    expect(rosterOf(GOODS)).toEqual(rosterOf(GOODS));
  });
});

describe("assignTownJobs — every workplace staffed from the nearest duty-free members", () => {
  const houses = [
    { index: 0, door: { x: 0, y: 0 } },
    { index: 1, door: { x: 10, y: 0 } },
    { index: 2, door: { x: 40, y: 0 } },
  ];
  const works = [{ door: { x: 2, y: 0 } }, { door: { x: 38, y: 0 } }];

  it("hires STAFF_PER_WORK nearest-first, spreading one per house before seconds", () => {
    const jobs = assignTownJobs(houses, works, 2, 7);
    // Work 0 (near houses 0,1): one member from each; work 1 (near house 2): its members.
    const flat = [...jobs.entries()].flatMap(([h, js]) => js.map((j) => ({ h, ...j })));
    expect(flat.filter((j) => j.work === 0)).toHaveLength(STAFF_PER_WORK);
    expect(flat.filter((j) => j.work === 1)).toHaveLength(STAFF_PER_WORK);
    const w0Houses = flat.filter((j) => j.work === 0).map((j) => j.h).sort();
    expect(w0Houses).toEqual([0, 1]); // spread, not two from house 0
  });

  it("only duty-free members work, and one soul always stays home", () => {
    const jobs = assignTownJobs(houses, works, 2, 7);
    for (const [h, js] of jobs) {
      for (const j of js) {
        expect(j.member).toBeGreaterThanOrEqual(2); // members 0..1 shop
        expect(j.member).toBeLessThan(HOUSEHOLD - 1); // the last soul keeps the house
      }
      expect(js.length).toBeLessThanOrEqual(HOUSEHOLD - 2 - 1 + 1); // ≤ free pool
      expect(h).toBeGreaterThanOrEqual(0);
    }
  });

  it("deterministic; shift windows stagger per work and fit the day", () => {
    expect(assignTownJobs(houses, works, 2, 7)).toEqual(assignTownJobs(houses, works, 2, 7));
    const jobs = assignTownJobs(houses, works, 2, 7);
    const windows = [...jobs.values()].flat().map((j) => j.window);
    for (const w of windows) {
      expect(w.start).toBeGreaterThanOrEqual(0.22);
      expect(w.start).toBeLessThan(0.35);
      expect(w.len).toBe(SHIFT_LEN);
    }
  });

  it("roster folds jobs in; jobDutyOf/inShiftWindow read them back", () => {
    const jobs = assignTownJobs(houses, works, 2, 7).get(0) ?? [];
    expect(jobs.length).toBeGreaterThan(0);
    const roster = rosterOf(GOODS, undefined, jobs);
    const jd = jobDutyOf(roster[jobs[0]!.member]);
    expect(jd?.work).toBe(jobs[0]!.work);
    // Inside the window at its middle; outside half a day later.
    const day = 240;
    const mid = (jd!.window.start + jd!.window.len / 2) * day;
    expect(inShiftWindow(jd!.window, mid, day)).toBe(true);
    expect(inShiftWindow(jd!.window, mid + day / 2, day)).toBe(false);
    // Shop duties are untouched by the job rows.
    expect(shopDutyOf(roster[0])).toEqual({ good: "food", role: 0 });
  });
});

describe("attendance — absence during shifts thins tomorrow's shelf (jobs -> economy)", () => {
  const day = 240;

  it("noteAbsence accumulates within a day and banks the finished day on rollover", () => {
    let rec = noteAbsence(undefined, 10, 5, day);
    rec = noteAbsence(rec, 20, 5, day);
    expect(rec).toEqual({ day: 0, seconds: 10, prevSeconds: 0 });
    rec = noteAbsence(rec, day + 1, 2, day); // next day: bank day 0
    expect(rec).toEqual({ day: 1, seconds: 2, prevSeconds: 10 });
    // A gap of more than one day expires the old tally.
    rec = noteAbsence(rec, day * 5, 1, day);
    expect(rec.prevSeconds).toBe(0);
  });

  it("attendanceFactor: full presence = 1; absence scales down; floored; expires", () => {
    const scheduled = 2 * 0.38 * day; // two staff, one shift
    expect(attendanceFactor(undefined, 3, scheduled)).toBe(1);
    const half = noteAbsence(undefined, day + 1, scheduled / 2, day); // day 1: half the crew-time lost
    expect(attendanceFactor(half, 2, scheduled)).toBeCloseTo(0.5, 5); // read on day 2 via `seconds`
    const banked = noteAbsence(half, 2 * day + 1, 0.0001, day); // day 2 opens: banked into prevSeconds
    expect(attendanceFactor(banked, 2, scheduled)).toBeCloseTo(0.5, 3);
    const total = noteAbsence(undefined, day + 1, scheduled * 3, day); // more absent than scheduled
    expect(attendanceFactor(total, 2, scheduled)).toBe(ATTENDANCE_FLOOR);
    expect(attendanceFactor(half, 9, scheduled)).toBe(1); // ancient absence is forgotten
  });
});
