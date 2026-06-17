// server/tests/location-geocode.test.ts
//
// Coverage for locationService.geocodeAddress — the Nominatim → Google fallback
// chain — with a mocked global fetch. No network, no DB writes.

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { locationService } from "../services/locationService";

const NOMINATIM_HOST = "nominatim.openstreetmap.org";
const GOOGLE_HOST = "maps.googleapis.com";

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("locationService.geocodeAddress", () => {
  const realFetch = global.fetch;
  const realKey = process.env.GOOGLE_GEOCODING_API_KEY;

  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GEOCODING_API_KEY;
    else process.env.GOOGLE_GEOCODING_API_KEY = realKey;
    jest.restoreAllMocks();
  });

  it("returns the Nominatim result when it succeeds (no Google call)", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      expect(urlOf(input)).toContain(NOMINATIM_HOST);
      return jsonResponse([{ lat: "32.0853", lon: "34.7818", display_name: "Tel Aviv, Israel" }]);
    });
    global.fetch = fetchMock as any;

    const result = await locationService.geocodeAddress("Tel Aviv");
    expect(result).toEqual({ lat: 32.0853, lng: 34.7818, displayName: "Tel Aviv, Israel", provider: "nominatim" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Google when Nominatim returns no results", async () => {
    process.env.GOOGLE_GEOCODING_API_KEY = "test-key";
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes(NOMINATIM_HOST)) return jsonResponse([]); // empty → fall back
      expect(url).toContain(GOOGLE_HOST);
      return jsonResponse({
        status: "OK",
        results: [{ formatted_address: "1 Main St", geometry: { location: { lat: 1.5, lng: 2.5 } } }],
      });
    });
    global.fetch = fetchMock as any;

    const result = await locationService.geocodeAddress("1 Main St");
    expect(result).toEqual({ lat: 1.5, lng: 2.5, displayName: "1 Main St", provider: "google" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to Google when Nominatim throws", async () => {
    process.env.GOOGLE_GEOCODING_API_KEY = "test-key";
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes(NOMINATIM_HOST)) throw new Error("network down");
      return jsonResponse({
        status: "OK",
        results: [{ formatted_address: "Fallback Pl", geometry: { location: { lat: 9, lng: 8 } } }],
      });
    });
    global.fetch = fetchMock as any;

    const result = await locationService.geocodeAddress("somewhere");
    expect(result?.provider).toBe("google");
  });

  it("returns null when both providers fail", async () => {
    process.env.GOOGLE_GEOCODING_API_KEY = "test-key";
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes(NOMINATIM_HOST)) return jsonResponse([]);
      return jsonResponse({ status: "ZERO_RESULTS", results: [] });
    });
    global.fetch = fetchMock as any;

    expect(await locationService.geocodeAddress("nowhere at all")).toBeNull();
  });

  it("skips the Google fallback silently when no API key is configured", async () => {
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    const fetchMock = jest.fn(async () => jsonResponse([])); // Nominatim: no result
    global.fetch = fetchMock as any;

    expect(await locationService.geocodeAddress("unfindable")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only Nominatim, never Google
  });
});
