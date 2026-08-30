// server/tests/location-matching.test.ts
//
// Unit coverage for the pure geo helpers in shared/location-matching.ts:
// Haversine distance, the NEAR_RADIUS_M boundary, the ±2h event window, the
// at_event/near/none distinction, and multi-candidate ranking.

import {
  haversineMeters,
  matchStudentLocation,
  NEAR_RADIUS_M,
  EVENT_WINDOW_MS,
  MAX_USABLE_ACCURACY_M,
  PRECISE_FIX_ACCURACY_M,
  type LocationCandidate,
  type EventOccurrence,
} from "@shared/location-matching";

// A reference point (roughly central Tel Aviv) and helpers to offset from it.
const BASE = { latitude: 32.0853, longitude: 34.7818 };

/** Offset a point north by `metres` (1 deg lat ≈ 111_320 m). */
function north(metres: number) {
  return { latitude: BASE.latitude + metres / 111_320, longitude: BASE.longitude };
}

const NOW = new Date("2026-06-17T10:00:00.000Z");

function loc(id: string, point: { latitude: number; longitude: number }, title = id): LocationCandidate {
  return { id, title, latitude: point.latitude, longitude: point.longitude };
}

function event(id: string, locationIds: string[], startOffsetMin: number, durationMin = 60): EventOccurrence {
  const startTime = new Date(NOW.getTime() + startOffsetMin * 60 * 1000);
  return {
    id,
    title: id,
    startTime,
    endTime: new Date(startTime.getTime() + durationMin * 60 * 1000),
    locationIds,
  };
}

describe("haversineMeters", () => {
  it("returns ~0 for identical points", () => {
    expect(haversineMeters(BASE, BASE)).toBeCloseTo(0, 5);
  });

  it("measures a known north offset accurately", () => {
    // 100m north should read ~100m (within a metre).
    expect(haversineMeters(BASE, north(100))).toBeGreaterThan(99);
    expect(haversineMeters(BASE, north(100))).toBeLessThan(101);
  });

  it("is symmetric", () => {
    expect(haversineMeters(BASE, north(250))).toBeCloseTo(haversineMeters(north(250), BASE), 6);
  });
});

describe("matchStudentLocation — radius boundary", () => {
  const candidates = [loc("inside", north(100)), loc("outside", north(300))];

  it("includes locations within NEAR_RADIUS_M and excludes those beyond", () => {
    const matches = matchStudentLocation({ gps: BASE, candidateLocations: candidates, events: [], now: NOW });
    expect(matches.map((m) => m.location.id)).toEqual(["inside"]);
    expect(matches[0].confidence).toBe("near");
  });

  it("treats just-inside the radius as a match and just-outside as not", () => {
    const justIn = loc("justIn", north(NEAR_RADIUS_M - 5));
    const justOut = loc("justOut", north(NEAR_RADIUS_M + 5));
    const matches = matchStudentLocation({
      gps: BASE,
      candidateLocations: [justIn, justOut],
      events: [],
      now: NOW,
    });
    expect(matches.map((m) => m.location.id)).toEqual(["justIn"]);
  });
});

describe("matchStudentLocation — event window", () => {
  const near = loc("clinic", north(50));

  it("flags at_event when a linked event overlaps now ±2h", () => {
    const matches = matchStudentLocation({
      gps: BASE,
      candidateLocations: [near],
      events: [event("therapy", ["clinic"], 30)], // starts 30 min from now
      now: NOW,
    });
    expect(matches[0].confidence).toBe("at_event");
    expect(matches[0].nearbyEvents.map((e) => e.id)).toEqual(["therapy"]);
  });

  it("ignores events outside the ±2h window", () => {
    const farFuture = Math.floor(EVENT_WINDOW_MS / 60000) + 60; // 3h out, in minutes
    const matches = matchStudentLocation({
      gps: BASE,
      candidateLocations: [near],
      events: [event("later", ["clinic"], farFuture)],
      now: NOW,
    });
    expect(matches[0].confidence).toBe("near");
    expect(matches[0].nearbyEvents).toHaveLength(0);
  });

  it("does not attribute an event to a location it isn't linked to", () => {
    const matches = matchStudentLocation({
      gps: BASE,
      candidateLocations: [near],
      events: [event("elsewhere", ["other-location"], 0)],
      now: NOW,
    });
    expect(matches[0].confidence).toBe("near");
  });
});

describe("matchStudentLocation — ranking", () => {
  it("sorts at_event before near, then by ascending distance", () => {
    const a = loc("a-near-far", north(140)); // near, no event, far
    const b = loc("b-near-close", north(20)); // near, no event, close
    const c = loc("c-event-far", north(120)); // at_event, far
    const matches = matchStudentLocation({
      gps: BASE,
      candidateLocations: [a, b, c],
      events: [event("ev", ["c-event-far"], 10)],
      now: NOW,
    });
    expect(matches.map((m) => m.location.id)).toEqual(["c-event-far", "b-near-close", "a-near-far"]);
  });

  it("returns an empty array when nothing is nearby", () => {
    expect(
      matchStudentLocation({ gps: BASE, candidateLocations: [loc("far", north(5000))], events: [], now: NOW }),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE READING'S ACCURACY IS PART OF THE ANSWER
//
// The desktop (Electron) build resolves position from WiFi and measured
// ±85-241m — the upper half of that is WIDER than NEAR_RADIUS_M itself. Under a
// flat radius such a fix would confidently assert a place it cannot tell from
// its neighbour, and the prompt turns 'at_event' into "very likely attending it
// right now". See project memory: device location / GPS.
describe("matchStudentLocation — fix accuracy", () => {
  const candidates = [loc("school", north(100))];
  const events = [event("assembly", ["school"], 0)];

  it("still asserts at_event when the fix is precise", () => {
    const [top] = matchStudentLocation({
      gps: { ...BASE, accuracy: 20 },
      candidateLocations: candidates,
      events,
      now: NOW,
    });
    expect(top.confidence).toBe("at_event");
    expect(top.coarse).toBe(false);
    expect(top.accuracyM).toBe(20);
  });

  it("refuses at_event when the fix is coarser than the match radius", () => {
    // A ±240m desktop fix. The event is real and must still be reported — what
    // it may NOT do is claim the student is attending it.
    const [top] = matchStudentLocation({
      gps: { ...BASE, accuracy: 240 },
      candidateLocations: candidates,
      events,
      now: NOW,
    });
    expect(top.confidence).toBe("near");
    expect(top.coarse).toBe(true);
    // The events survive the downgrade: a caller that read `near` as "nothing
    // is scheduled here" would be stating a falsehood into the system prompt.
    expect(top.nearbyEvents.map((e) => e.id)).toEqual(["assembly"]);
  });

  it("treats the precision threshold as inclusive", () => {
    const at = matchStudentLocation({
      gps: { ...BASE, accuracy: PRECISE_FIX_ACCURACY_M },
      candidateLocations: candidates,
      events,
      now: NOW,
    });
    expect(at[0].coarse).toBe(false);
    const past = matchStudentLocation({
      gps: { ...BASE, accuracy: PRECISE_FIX_ACCURACY_M + 1 },
      candidateLocations: candidates,
      events,
      now: NOW,
    });
    expect(past[0].coarse).toBe(true);
  });

  it("widens the search by the accuracy, so a reachable place is not dropped", () => {
    // 250m away is outside the flat 150m radius, but a ±150m fix genuinely
    // cannot rule it out — the old behaviour silently lost it.
    const far = [loc("clinic", north(250))];
    expect(
      matchStudentLocation({ gps: BASE, candidateLocations: far, events: [], now: NOW }),
    ).toHaveLength(0);
    const widened = matchStudentLocation({
      gps: { ...BASE, accuracy: 150 },
      candidateLocations: far,
      events: [],
      now: NOW,
    });
    expect(widened).toHaveLength(1);
    // The distance reported back is the RAW centre-to-centre one, not the
    // widened radius — callers print this number to the model.
    expect(widened[0].distanceM).toBeGreaterThan(240);
    expect(widened[0].distanceM).toBeLessThan(260);
  });

  it("discards a fix too vague to mean anything", () => {
    // A half-kilometre error circle "matches" every place in a neighbourhood.
    // Saying nothing beats placing a child somewhere they are not.
    expect(
      matchStudentLocation({
        gps: { ...BASE, accuracy: MAX_USABLE_ACCURACY_M + 1 },
        candidateLocations: candidates,
        events,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("ignores junk accuracy rather than reading it as a perfect fix", () => {
    // 0 / negative / NaN mean "not reported", NOT "accurate to zero metres".
    for (const accuracy of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const [top] = matchStudentLocation({
        gps: { ...BASE, accuracy },
        candidateLocations: candidates,
        events,
        now: NOW,
      });
      expect(top.confidence).toBe("at_event");
      expect(top.coarse).toBe(false);
      expect(top.accuracyM).toBeUndefined();
    }
  });

  it("behaves exactly as before when the device reports no accuracy", () => {
    const [top] = matchStudentLocation({
      gps: BASE,
      candidateLocations: candidates,
      events,
      now: NOW,
    });
    expect(top.confidence).toBe("at_event");
    expect(top.coarse).toBe(false);
    expect(top.accuracyM).toBeUndefined();
  });
});
