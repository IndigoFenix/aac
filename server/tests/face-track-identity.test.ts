// Unit tests for the per-track face identity hysteresis
// (shared/aac/face-track-identity.ts). One track holds ONE person: a
// challenger has to be clearly closer than the incumbent, three batches in a
// row, before a face changes hands. See planning-docs/aac-presence-ledger.md §7
// — without this, a single face in a single chair became two people (the
// student and her sister) inside one minute.
import {
  TRACK_IDENTITY_DEFAULTS,
  TrackIdentityResolver,
  type TrackMatchInput,
} from "@shared/aac/face-track-identity";

const STUDENT = "student:s1";
const SISTER = "contact:c1";
const BROTHER = "contact:c2";

function batch(at: number, best?: [string, number], runnerUp?: [string, number]): TrackMatchInput {
  return {
    trackId: "cam:user",
    at,
    ...(best ? { best: { entityKey: best[0], distance: best[1] } } : {}),
    ...(runnerUp ? { runnerUp: { entityKey: runnerUp[0], distance: runnerUp[1] } } : {}),
  };
}

describe("TrackIdentityResolver — adoption", () => {
  it("adopts the first best it sees", () => {
    const r = new TrackIdentityResolver();
    const t = r.observe(batch(1000, [STUDENT, 0.41]));
    expect(t.entityKey).toBe(STUDENT);
    expect(t.batches).toBe(1);
    expect(t.since).toBe(1000);
    expect(t.challenger).toBeUndefined();
  });

  it("counts supporting batches for the incumbent", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.41]));
    r.observe(batch(1000, [STUDENT, 0.4]));
    expect(r.observe(batch(2000, [STUDENT, 0.39])).batches).toBe(3);
  });

  it("a batch with no match keeps the incumbent and counts toward nothing", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.41]));
    const t = r.observe(batch(1000));
    expect(t.entityKey).toBe(STUDENT);
    expect(t.batches).toBe(1);
    expect(t.challenger).toBeUndefined();
  });

  it("a track with nothing but empty batches stays unowned", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0));
    expect(r.observe(batch(1000)).entityKey).toBeUndefined();
  });
});

describe("TrackIdentityResolver — hysteresis", () => {
  it("does not switch on a challenger that wins by less than the margin", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.5]));
    // 0.506 vs 0.559: the real fixture's contested batch. Gap 0.053 < 0.08.
    for (let i = 1; i <= 6; i++) {
      const t = r.observe(batch(i * 1000, [SISTER, 0.506], [STUDENT, 0.559]));
      expect(t.entityKey).toBe(STUDENT);
      expect(t.challenger).toBeUndefined();
    }
  });

  it("switches after exactly switchBatches winning batches, not before", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.5]));
    const a = r.observe(batch(1000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(a.entityKey).toBe(STUDENT);
    expect(a.challenger).toEqual({ entityKey: SISTER, count: 1, distance: 0.3 });
    const b = r.observe(batch(2000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(b.entityKey).toBe(STUDENT);
    expect(b.challenger?.count).toBe(2);
    const c = r.observe(batch(3000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(c.entityKey).toBe(SISTER);
    expect(c.batches).toBe(1);
    expect(c.since).toBe(3000);
    expect(c.challenger).toBeUndefined();
  });

  it("an intervening incumbent win resets the challenger count", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.5]));
    r.observe(batch(1000, [SISTER, 0.3], [STUDENT, 0.5]));
    r.observe(batch(2000, [SISTER, 0.3], [STUDENT, 0.5]));
    const back = r.observe(batch(3000, [STUDENT, 0.45]));
    expect(back.challenger).toBeUndefined();
    // Two more challenger wins are now not enough.
    r.observe(batch(4000, [SISTER, 0.3], [STUDENT, 0.5]));
    const t = r.observe(batch(5000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(t.entityKey).toBe(STUDENT);
    expect(t.challenger?.count).toBe(2);
  });

  it("a non-winning batch breaks the run (batches must be consecutive)", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.5]));
    r.observe(batch(1000, [SISTER, 0.3], [STUDENT, 0.5]));
    r.observe(batch(2000, [SISTER, 0.3], [STUDENT, 0.5]));
    // Same challenger, but only 0.02 better this time.
    const stall = r.observe(batch(3000, [SISTER, 0.48], [STUDENT, 0.5]));
    expect(stall.challenger).toBeUndefined();
    const t = r.observe(batch(4000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(t.entityKey).toBe(STUDENT);
    expect(t.challenger?.count).toBe(1);
  });

  it("a different challenger starts its own count", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.5]));
    r.observe(batch(1000, [SISTER, 0.3], [STUDENT, 0.5]));
    r.observe(batch(2000, [SISTER, 0.3], [STUDENT, 0.5]));
    const other = r.observe(batch(3000, [BROTHER, 0.3], [STUDENT, 0.5]));
    expect(other.challenger).toEqual({ entityKey: BROTHER, count: 1, distance: 0.3 });
    expect(other.entityKey).toBe(STUDENT);
  });

  it("falls back to the incumbent's last seen distance when it is absent from the batch", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.4]));
    // Sister alone in the batch at 0.39 — better, but not by the margin
    // against the student's last known 0.40.
    for (let i = 1; i <= 4; i++) {
      expect(r.observe(batch(i * 1000, [SISTER, 0.39])).entityKey).toBe(STUDENT);
    }
    // Clearly better, three in a row, and it takes the track.
    r.observe(batch(5000, [SISTER, 0.2]));
    r.observe(batch(6000, [SISTER, 0.2]));
    expect(r.observe(batch(7000, [SISTER, 0.2])).entityKey).toBe(SISTER);
  });

  it("uses the batch's own runner-up distance for the incumbent when present", () => {
    const r = new TrackIdentityResolver();
    r.observe(batch(0, [STUDENT, 0.2])); // incumbent historically very close
    // …but in these batches the student scores 0.5 and the sister 0.3.
    r.observe(batch(1000, [SISTER, 0.3], [STUDENT, 0.5]));
    r.observe(batch(2000, [SISTER, 0.3], [STUDENT, 0.5]));
    expect(r.observe(batch(3000, [SISTER, 0.3], [STUDENT, 0.5])).entityKey).toBe(SISTER);
  });

  it("honours a custom switchBatches / margin", () => {
    const r = new TrackIdentityResolver({ switchBatches: 1, margin: 0.5 });
    r.observe(batch(0, [STUDENT, 0.6]));
    expect(r.observe(batch(1000, [SISTER, 0.2], [STUDENT, 0.6])).entityKey).toBe(STUDENT);
    expect(r.observe(batch(2000, [SISTER, 0.05], [STUDENT, 0.6])).entityKey).toBe(SISTER);
  });
});

describe("TrackIdentityResolver — bookkeeping", () => {
  it("expires tracks unseen past the ttl and reports them", () => {
    const r = new TrackIdentityResolver();
    r.observe({ trackId: "a", at: 0, best: { entityKey: STUDENT, distance: 0.3 } });
    r.observe({ trackId: "b", at: 20_000, best: { entityKey: SISTER, distance: 0.3 } });
    expect(r.expire(35_000)).toEqual(["a"]);
    expect(r.get("a")).toBeUndefined();
    expect(r.get("b")?.entityKey).toBe(SISTER);
    expect(r.tracks().map((t) => t.trackId)).toEqual(["b"]);
    expect(r.expire(60_000)).toEqual(["b"]);
    expect(r.tracks()).toEqual([]);
  });

  it("keeps tracks independent of each other", () => {
    const r = new TrackIdentityResolver();
    r.observe({ trackId: "cam:user", at: 0, best: { entityKey: STUDENT, distance: 0.3 } });
    r.observe({ trackId: "cam:world", at: 0, best: { entityKey: SISTER, distance: 0.3 } });
    expect(r.get("cam:user")?.entityKey).toBe(STUDENT);
    expect(r.get("cam:world")?.entityKey).toBe(SISTER);
  });

  it("hands out copies, so a caller cannot mutate the resolver's state", () => {
    const r = new TrackIdentityResolver();
    const t = r.observe(batch(0, [STUDENT, 0.3]));
    t.entityKey = SISTER;
    expect(r.get("cam:user")?.entityKey).toBe(STUDENT);
  });

  it("ships the documented defaults", () => {
    expect(TRACK_IDENTITY_DEFAULTS).toEqual({ switchBatches: 3, margin: 0.08, trackTtlMs: 30_000 });
  });
});
