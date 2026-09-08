// server/tests/location-context.test.ts
//
// Unit coverage for MonitorAgent's GPS → location-context logic
// (checkLocationContext), with the repositories/calendar service mocked. No
// LLM, no DB. Verifies that a GPS reading near a registered location produces
// the right context-injection string, that a concurrent event upgrades it to
// an "at this event" signal, and that re-checks dedupe.

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { MonitorAgent } from "../services/dual-agent/monitor-agent";
import { locationRepository, instituteRepository } from "../repositories";
import { calendarService } from "../services/calendarService";
import { calendarRepository } from "../repositories/calendarRepository";
import { areaLookupService } from "../services/areaLookupService";

const STUDENT_ID = "stu-1";
const INSTITUTE_ID = "inst-1";
const BASE = { lat: 32.0853, lng: 34.7818 };

function near(metres: number) {
  return { latitude: BASE.lat + metres / 111_320, longitude: BASE.lng };
}

function makeAgent(): MonitorAgent {
  return new MonitorAgent(STUDENT_ID, {} as any, "user-1", "sess-1");
}

/** Wire the institute + location lookups; events default to none. */
function mockGeo(opts: {
  locations: Array<{ id: string; title: string; address?: string | null; latitude: number; longitude: number }>;
  events?: Array<{ id: string; title: string; startTime: Date; endTime: Date; locationIds: string[] }>;
}) {
  jest.spyOn(instituteRepository, "getInstitutesByStudentId").mockResolvedValue([
    { institute: { id: INSTITUTE_ID } as any, enrollment: {} as any },
  ]);
  jest.spyOn(locationRepository, "listByInstitutes").mockResolvedValue(
    opts.locations.map((l) => ({ ...l, instituteId: INSTITUTE_ID, isActive: true } as any)),
  );

  const events = opts.events ?? [];
  jest.spyOn(calendarService, "getEventsForStudent").mockResolvedValue(
    events.map((e) => ({ id: e.id, title: e.title, startTime: e.startTime, endTime: e.endTime } as any)),
  );
  // No recurrence expansion needed — return each event as a single occurrence.
  jest.spyOn(calendarRepository, "expandRecurringEvents").mockReturnValue(
    events.map((e) => ({ event: e as any, date: e.startTime })),
  );
  const locsByEvent = new Map<string, any[]>();
  for (const e of events) {
    locsByEvent.set(
      e.id,
      e.locationIds.map((id) => opts.locations.find((l) => l.id === id)).filter(Boolean) as any[],
    );
  }
  jest.spyOn(locationRepository, "getLocationsForEvents").mockResolvedValue(locsByEvent);
}

describe("MonitorAgent.checkLocationContext", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns null when no GPS has been set", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Clinic", ...near(10) }] });
    const agent = makeAgent();
    expect(await agent.checkLocationContext()).toBeNull();
  });

  it("reports a nearby location with no concurrent event", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", address: "1 Health St", ...near(30) }] });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    const msg = await agent.checkLocationContext();
    expect(msg).toContain("[LOCATION]");
    expect(msg).toContain("Main Clinic");
    expect(msg).not.toContain("scheduled");
  });

  it("upgrades to an at-event signal when a linked event is happening now", async () => {
    const now = new Date("2026-06-17T10:00:00Z");
    mockGeo({
      locations: [{ id: "l1", title: "Therapy Room", ...near(20) }],
      events: [
        {
          id: "e1",
          title: "Music Therapy",
          startTime: new Date(now.getTime() + 15 * 60_000),
          endTime: new Date(now.getTime() + 75 * 60_000),
          locationIds: ["l1"],
        },
      ],
    });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    const msg = await agent.checkLocationContext(now);
    expect(msg).toContain("Music Therapy");
    expect(msg).toContain("likely at this event");
  });

  it("will not claim attendance on a coarse fix, but still reports the event", async () => {
    // A desktop WiFi fix (±240m) is wider than the 150m match radius, so it
    // cannot tell this room from its neighbours. The old flat-radius behaviour
    // said "likely at this event" anyway.
    const now = new Date("2026-06-17T10:00:00Z");
    mockGeo({
      locations: [{ id: "l1", title: "Therapy Room", ...near(20) }],
      events: [
        {
          id: "e1",
          title: "Music Therapy",
          startTime: new Date(now.getTime() + 15 * 60_000),
          endTime: new Date(now.getTime() + 75 * 60_000),
          locationIds: ["l1"],
        },
      ],
    });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng, accuracy: 240 });

    const msg = await agent.checkLocationContext(now);
    // The event is real and must not be dropped...
    expect(msg).toContain("Music Therapy");
    // ...but the certainty is gone, and the imprecision is stated outright.
    expect(msg).not.toContain("likely at this event");
    expect(msg).toContain("too imprecise");
  });

  it("says nothing at all when the fix is too vague to place anyone", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Clinic", ...near(30) }] });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng, accuracy: 5000 });

    // A 5km error circle covers half a city. First report from a fresh agent
    // with no prior key is suppressed, so this is null either way — the point
    // is that it never names the Clinic.
    expect(await agent.checkLocationContext()).toBeNull();
  });

  it("dedupes: a second check at the same place returns null", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Clinic", ...near(25) }] });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    const first = await agent.checkLocationContext();
    expect(first).toContain("Clinic");
    const second = await agent.checkLocationContext();
    expect(second).toBeNull();
  });

  it("returns no signal when the student is far from every registered location", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Clinic", ...near(5000) }] });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    // First report from a fresh agent with no prior key is suppressed (null).
    expect(await agent.checkLocationContext()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The COARSE scale: which city/country the device is in, and whether that is
// the area the student's registered places sit in.
//
// This exists because an empty match list is not "nowhere". A student on
// holiday, or in a hospital in another city, matches no registered place — and
// before this the prompt said nothing whatsoever about where they were.

describe("MonitorAgent location area context", () => {
  afterEach(() => jest.restoreAllMocks());

  /** Stub the reverse-geocode so no test touches the network (setup.ts also kills it). */
  function mockArea(area: { city?: string; region?: string; country?: string } | null) {
    jest
      .spyOn(areaLookupService, "lookup")
      .mockResolvedValue(area ? { ...area, provider: "nominatim" as const } : null);
  }

  /** ~300km north of BASE: another city entirely, by any measure. */
  const FAR = { latitude: BASE.lat + 2.7, longitude: BASE.lng };

  it("names the area and flags the trip when far from every registered place", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    mockArea({ city: "Eilat", country: "Israel" });
    const agent = makeAgent();
    agent.setGps(FAR);

    const msg = await agent.checkLocationContext();
    expect(msg).toContain("Eilat, Israel");
    expect(msg).toContain("not their usual area");
    // The bearing matters as much as the name: how far from what.
    expect(msg).toContain("Main Clinic");
  });

  it("stays quiet about the area on an ordinary day near a registered place", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", ...near(30) }] });
    mockArea({ city: "Tel Aviv-Yafo", country: "Israel" });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    const msg = await agent.checkLocationContext();
    expect(msg).toContain("Main Clinic");
    // Naming the home city on every ordinary update is noise, not signal.
    expect(msg).not.toContain("Tel Aviv-Yafo");
    expect(msg).not.toContain("usual area");
  });

  it("announces coming home again after a trip", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    const agent = makeAgent();

    mockArea({ city: "Eilat", country: "Israel" });
    agent.setGps(FAR);
    expect(await agent.checkLocationContext()).toContain("not their usual area");

    jest.restoreAllMocks();
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    mockArea({ city: "Tel Aviv-Yafo", country: "Israel" });
    agent.setGps({ latitude: BASE.lat + 0.005, longitude: BASE.lng }); // ~550m: home area, no match
    const msg = await agent.checkLocationContext();
    expect(msg).toContain("back in Tel Aviv-Yafo, Israel");
  });

  it("says where they are, and concludes nothing, when no places are registered", async () => {
    mockGeo({ locations: [] });
    mockArea({ city: "Lisbon", country: "Portugal" });
    const agent = makeAgent();
    agent.setGps({ latitude: 38.72, longitude: -9.14 });

    const section: string = await (agent as any).buildLocationContextSection(new Date());
    expect(section).toContain("Lisbon, Portugal");
    expect(section).toContain("nothing to compare");
    expect(section).not.toContain("usual area");
  });

  it("builds a location section from the area alone when nothing matched", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    mockArea({ city: "Eilat", region: "South District", country: "Israel" });
    const agent = makeAgent();
    agent.setGps(FAR);

    const section: string = await (agent as any).buildLocationContextSection(new Date());
    expect(section).toContain("## Current Location");
    expect(section).toContain("Eilat, Israel");
    expect(section).toContain("NOT their usual area");
  });

  it("says nothing when the area cannot be resolved", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    mockArea(null); // provider down, or mid-ocean
    const agent = makeAgent();
    agent.setGps(FAR);

    const section: string = await (agent as any).buildLocationContextSection(new Date());
    expect(section).toBe("");
    // A failed lookup is not evidence of an ordinary day either.
    expect(await agent.checkLocationContext()).toBeNull();
  });

  it("keeps the plan cache key untouched for an ordinary session", async () => {
    // locationKey feeds goalsHash (session-plan.ts). Adding the area to it for
    // every session would invalidate that cache system-wide for no gain, so the
    // area only enters the key when it says something new.
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", ...near(30) }] });
    mockArea({ city: "Tel Aviv-Yafo", country: "Israel" });
    const agent = makeAgent();
    agent.setGps({ latitude: BASE.lat, longitude: BASE.lng });

    await (agent as any).buildLocationContextSection(new Date());
    expect((agent as any).lastReportedLocationKey).toBe("l1:near");
  });

  it("gives a trip its own plan cache key", async () => {
    mockGeo({ locations: [{ id: "l1", title: "Main Clinic", latitude: BASE.lat, longitude: BASE.lng }] });
    mockArea({ city: "Eilat", country: "Israel" });
    const agent = makeAgent();
    agent.setGps(FAR);

    await (agent as any).buildLocationContextSection(new Date());
    expect((agent as any).lastReportedLocationKey).toBe("none|away:Eilat, Israel");
  });
});
