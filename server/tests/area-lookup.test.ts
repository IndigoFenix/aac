// server/tests/area-lookup.test.ts
//
// Coverage for areaLookupService — coordinates → city/region/country, the
// Nominatim → Google fallback chain, the coarse-cell cache, and the kill
// switch. Mocked global fetch: no network, no DB.
//
// Note the environment: server/tests/setup.ts sets AREA_LOOKUP=off for every
// worker so no OTHER suite can reach the network through this service. These
// tests therefore turn it back on explicitly and restore it afterwards.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { areaLookupService, formatArea, AREA_GRID_M } from "../services/areaLookupService";

const NOMINATIM_HOST = "nominatim.openstreetmap.org";
const GOOGLE_HOST = "maps.googleapis.com";

const TEL_AVIV = { latitude: 32.0853, longitude: 34.7818 };

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function nominatimBody(address: Record<string, string>) {
  return { address };
}

describe("areaLookupService.lookup", () => {
  const realFetch = global.fetch;
  const realSwitch = process.env.AREA_LOOKUP;
  const realKey = process.env.GOOGLE_GEOCODING_API_KEY;

  beforeEach(() => {
    process.env.AREA_LOOKUP = "on";
    areaLookupService.clearCache();
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (realSwitch === undefined) delete process.env.AREA_LOOKUP;
    else process.env.AREA_LOOKUP = realSwitch;
    if (realKey === undefined) delete process.env.GOOGLE_GEOCODING_API_KEY;
    else process.env.GOOGLE_GEOCODING_API_KEY = realKey;
    jest.restoreAllMocks();
  });

  it("resolves a city and country from Nominatim", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", state: "Tel Aviv District", country: "Israel", country_code: "IL" })),
    ) as unknown as typeof fetch;

    const area = await areaLookupService.lookup(TEL_AVIV);
    expect(area?.city).toBe("Tel Aviv-Yafo");
    expect(area?.country).toBe("Israel");
    expect(area?.countryCode).toBe("il");
    expect(area?.provider).toBe("nominatim");
  });

  it("never sends a sharper point than the area grid", async () => {
    const seen: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      seen.push(urlOf(input));
      return jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" }));
    }) as unknown as typeof fetch;

    await areaLookupService.lookup({ latitude: 32.08531234, longitude: 34.78189876 });

    const url = new URL(seen[0]);
    const lat = parseFloat(url.searchParams.get("lat")!);
    const lon = parseFloat(url.searchParams.get("lon")!);
    // The request must not carry the raw fix — it is snapped to the grid, so it
    // differs from the input by up to half a cell, and never by ~nothing.
    expect(lat).not.toBe(32.08531234);
    expect(lon).not.toBe(34.78189876);
    const latStep = AREA_GRID_M / 111_320;
    expect(Math.abs(lat - 32.08531234)).toBeLessThanOrEqual(latStep);
  });

  it("carries no identifier beyond the OSM-required User-Agent", async () => {
    let headers: Record<string, string> = {};
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" }));
    }) as unknown as typeof fetch;

    await areaLookupService.lookup(TEL_AVIV);
    expect(Object.keys(headers).sort()).toEqual(["Accept-Language", "User-Agent"]);
  });

  it("serves a second nearby fix from cache without a second request", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await areaLookupService.lookup(TEL_AVIV);
    // ~200m away: a different street, the same city, the same grid cell.
    await areaLookupService.lookup({ latitude: TEL_AVIV.latitude + 0.0018, longitude: TEL_AVIV.longitude });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent lookups of the same cell into one request", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const [a, b] = await Promise.all([areaLookupService.lookup(TEL_AVIV), areaLookupService.lookup(TEL_AVIV)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("falls back to Google when Nominatim fails", async () => {
    process.env.GOOGLE_GEOCODING_API_KEY = "test-key";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes(NOMINATIM_HOST)) return jsonResponse({}, false, 503);
      if (url.includes(GOOGLE_HOST)) {
        return jsonResponse({
          status: "OK",
          results: [
            {
              address_components: [
                { long_name: "Eilat", short_name: "Eilat", types: ["locality"] },
                { long_name: "South District", short_name: "South", types: ["administrative_area_level_1"] },
                { long_name: "Israel", short_name: "IL", types: ["country"] },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected host: ${url}`);
    }) as unknown as typeof fetch;

    const area = await areaLookupService.lookup(TEL_AVIV);
    expect(area?.city).toBe("Eilat");
    expect(area?.provider).toBe("google");
  });

  it("returns null — not a guess — when every provider fails", async () => {
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    global.fetch = jest.fn(async () => jsonResponse({}, false, 500)) as unknown as typeof fetch;

    expect(await areaLookupService.lookup(TEL_AVIV)).toBeNull();
  });

  it("does not cache a failure for long enough to outlive the outage", async () => {
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    let failing = true;
    const fetchMock = jest.fn(async () =>
      failing
        ? jsonResponse({}, false, 500)
        : jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await areaLookupService.lookup(TEL_AVIV)).toBeNull();
    // The negative entry has a short TTL; simulate its expiry rather than
    // waiting ten minutes, and confirm the service asks again afterwards.
    areaLookupService.clearCache();
    failing = false;
    expect((await areaLookupService.lookup(TEL_AVIV))?.city).toBe("Tel Aviv-Yafo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than making a caller wait out a long rate-limit queue", async () => {
    // Session startup awaits this. Five cities queued at one request per second
    // must not become a five-second startup for the last one.
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    const fetchMock = jest.fn(async () =>
      jsonResponse(nominatimBody({ city: "Somewhere", country: "Israel" })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cities = Array.from({ length: 6 }, (_, i) => ({
      latitude: TEL_AVIV.latitude + i * 0.5, // distinct cells, so no cache sharing
      longitude: TEL_AVIV.longitude,
    }));
    const started = Date.now();
    const results = await Promise.all(cities.map((c) => areaLookupService.lookup(c)));
    const elapsed = Date.now() - started;

    // The queue is capped, so the ones past the cap come back unresolved...
    expect(results.filter((r) => r === null).length).toBeGreaterThan(0);
    // ...and nobody waited the full six seconds it would otherwise have taken.
    expect(elapsed).toBeLessThan(5000);
    expect(fetchMock.mock.calls.length).toBeLessThan(6);
  });

  it("re-asks after a queue skip instead of remembering the silence", async () => {
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    const fetchMock = jest.fn(async () =>
      jsonResponse(nominatimBody({ city: "Tel Aviv-Yafo", country: "Israel" })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    // Fill the queue so this cell's lookup is skipped without being sent.
    const others = Array.from({ length: 6 }, (_, i) => ({
      latitude: TEL_AVIV.latitude + 1 + i * 0.5,
      longitude: TEL_AVIV.longitude,
    }));
    await Promise.all([...others.map((c) => areaLookupService.lookup(c)), areaLookupService.lookup(TEL_AVIV)]);

    const callsBefore = fetchMock.mock.calls.length;
    // A skip must leave no cache entry behind: asking again really asks again.
    await areaLookupService.lookup(TEL_AVIV);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  }, 20000);

  it("makes no request at all when AREA_LOOKUP=off", async () => {
    process.env.AREA_LOOKUP = "off";
    const fetchMock = jest.fn(async () => jsonResponse(nominatimBody({ city: "X" })));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await areaLookupService.lookup(TEL_AVIV)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an answer that names nothing as no answer", async () => {
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    global.fetch = jest.fn(async () => jsonResponse({ error: "Unable to geocode" })) as unknown as typeof fetch;
    expect(await areaLookupService.lookup(TEL_AVIV)).toBeNull();
  });
});

describe("formatArea", () => {
  it("reads as a place, not a postal address", () => {
    expect(
      formatArea({ city: "Eilat", region: "South District", country: "Israel", provider: "nominatim" }),
    ).toBe("Eilat, Israel");
  });

  it("uses whatever levels the provider actually gave", () => {
    expect(formatArea({ country: "Israel", provider: "nominatim" })).toBe("Israel");
    expect(formatArea({ city: "Eilat", provider: "nominatim" })).toBe("Eilat");
    expect(formatArea(null)).toBe("");
  });

  it("does not repeat a level that is its own parent", () => {
    expect(formatArea({ city: "Singapore", country: "Singapore", provider: "nominatim" })).toBe("Singapore");
  });
});
