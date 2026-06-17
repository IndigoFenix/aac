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
